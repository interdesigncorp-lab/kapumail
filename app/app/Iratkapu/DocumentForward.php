<?php

namespace App\Iratkapu;

use Carbon\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Irat továbbítása emailben az irattípus irodai beállítása szerint (emailTo: none|client|assignee|both).
 * `arrival`: értesítés melléklet nélkül (az irat még nincs letöltve); `downloaded`: a letöltött dokumentumokkal.
 * Soha nem indít letöltést; rejtett iratnál és „none” beállításnál nem csinál semmit. Nyitott adatbázis-tranzakción belül nem hívható.
 * Régi (MAX_AGE_DAYS napnál korábban érkezett) és tartós tári iratról beérkezéskor nem megy levél, hogy egy első listázás ne zúdítson
 * az ügyfélre évekre visszamenő értesítéseket; automatikus letöltésnél ugyanez a korhatár, kézi letöltésnél nincs.
 */
final class DocumentForward
{
    /** Ennél régebben érkezett iratról nem megy automatikus levél. */
    private const MAX_AGE_DAYS = 3;

    /** HTTP-kérésből: a küldés a válasz után fut, hogy egy nagy lista ne futtassa ki a kérést az időből. */
    public static function afterResponse(int $messageId, string $stage, bool $automatic = false): void
    {
        $done = false; // a tesztekben egy alkalmazáspéldány több kérést is lezár: egy hívás csak egyszer fusson
        app()->terminating(function () use (&$done, $messageId, $stage, $automatic) {
            if ($done) {
                return;
            }
            $done = true;
            try {
                self::run($messageId, $stage, $automatic);
            } catch (\Throwable $e) {
                report($e);
            }
        });
    }

    public static function run(int $messageId, string $stage, bool $automatic = false): void
    {
        $m = DB::table('messages')->find($messageId);
        if (! $m || $m->hidden || ($m->folder ?? null) === 'ELKULDOTT') {
            return;
        }
        $to = TypeSettings::for((int) $m->office_id, $m->type_id)['emailTo'];
        if ($to === 'none') {
            return;
        }
        $officeId = (int) $m->office_id;
        $old = $m->arrived_at && Carbon::parse($m->arrived_at)->lt(now()->subDays(self::MAX_AGE_DAYS));
        $skip = fn (string $why) => Audit::log($officeId, null, "Irat továbbítása kihagyva ($why): {$m->type_label}", ['client_id' => $m->client_id, 'message_id' => $m->id]);
        if ($stage === 'arrival' && (($m->folder ?? null) === 'TARTOS_TAR' || ! empty($m->durable))) {
            $skip('tartós tári irat');

            return;
        }
        if (($stage === 'arrival' || $automatic) && $old) {
            $skip('az irat '.self::MAX_AGE_DAYS.' napnál régebben érkezett');

            return;
        }
        $client = DB::table('clients')->where('id', $m->client_id)->value('name');
        $at = $m->arrived_at ? Carbon::parse($m->arrived_at)->format('Y. m. d. H:i') : 'ismeretlen';
        $facts = "Feladó: {$m->sender_full}\nIrat: {$m->type_label}\nÉrkezés: $at";
        $docs = [];
        if ($stage === 'downloaded') {
            $roots = DB::table('documents')->where('message_id', $m->id)->whereNull('parent_id')->orderBy('id')->get(['id', 'name']);
            if ($roots->isEmpty()) {
                return;
            }
            // Az .es3 tároló önmagában nem olvasható: a benne lévő iratok is mennek.
            foreach ($roots as $d) {
                $docs[] = $d->id;
                if (str_ends_with(mb_strtolower($d->name), '.es3')) {
                    array_push($docs, ...DB::table('documents')->where('parent_id', $d->id)->orderBy('id')->pluck('id')->all());
                }
            }
            $subject = "Irat: {$m->type_label}";
            $key = "fwd:{$m->id}:doc";
            $clientBody = "Tisztelt Ügyfelünk!\n\nMellékelten küldjük a hivatalos tárhelyére érkezett iratot.\n\n$facts";
            $userBody = "Ügyfél: $client\n$facts\n\nAz irat a mellékletben található.";
        } else {
            $subject = "Új irat érkezett: {$m->type_label}";
            $key = "fwd:{$m->id}:notice";
            $clientBody = "Tisztelt Ügyfelünk!\n\nÚj hivatalos irat érkezett a tárhelyére.\n\n$facts\n\nAz irat tartalmát könyvelője juttatja el Önnek, illetve a hivatalos tárhelyen érhető el.";
            $userBody = "Ügyfél: $client\n$facts\n\nAz iratot a KapuMail még nem töltötte le; a tartalmát a könyvelő küldi el, vagy a hivatalos tárhelyen érhető el.";
        }
        if (in_array($to, ['client', 'both'], true)) {
            ClientMail::toClient($officeId, (int) $m->client_id, 'fwd', $key, $subject, $clientBody, $docs, (int) $m->id);
        }
        if (in_array($to, ['assignee', 'both'], true) && $m->assignee_id) {
            $nk = "$key:user:{$m->assignee_id}";
            // A toUser-nek nincs ismétlésvédelme: a foglalás a notifications táblán megy (mint a Notify::once), sikertelen küldésnél visszavesszük.
            if (Notify::once($officeId, (int) $m->assignee_id, (int) $m->id, 'tovabbitas', "Irat emailben továbbítva: $subject", $nk)
                && ! ClientMail::toUser($officeId, (int) $m->assignee_id, $subject, $userBody, $docs)) {
                DB::table('notifications')->where('dedupe_key', $nk)->delete();
            }
        }
    }
}
