<?php

namespace App\Iratkapu;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;

/** Az ügyfélnek és a felhasználónak menő automatikus levelek közös küldője: SMTP-ellenőrzés, ismétlésvédelem, napló, audit. */
class ClientMail
{
    /** @return array{sent: int, skipped: string|null} */
    public static function toClient(int $officeId, int $clientId, string $kind, string $key, string $subject, string $body, array $documentIds = [], ?int $messageId = null): array
    {
        $c = DB::table('clients')->where('office_id', $officeId)->find($clientId);
        $skip = function (string $why, string $text) use ($officeId, $clientId, $messageId) { Audit::log($officeId, null, $text, ['client_id' => $clientId, 'message_id' => $messageId]); return ['sent' => 0, 'skipped' => $why]; };
        if (!$c) return $skip('nincs_ugyfel', "Ügyfélnek szánt levél kihagyva (az ügyfél nem található): #$clientId, $subject");
        if (!OfficeMail::ready($officeId)) return $skip('smtp', "Ügyfélnek szánt levél kihagyva (nincs beállított levelezés): {$c->name}, $subject");
        if (!$c->active) return $skip('inaktiv', "Ügyfélnek szánt levél kihagyva (inaktív ügyfél): {$c->name}, $subject");
        $contacts = DB::table('client_contacts')->where('office_id', $officeId)->where('client_id', $clientId)->orderBy('id')->get();
        if ($contacts->isEmpty()) return $skip('nincs_kapcsolattarto', "Ügyfélnek szánt levél kihagyva (nincs kapcsolattartó): {$c->name}, $subject");
        $contacts = $contacts->each(fn ($k) => $k->email = trim((string) $k->email))->unique(fn ($k) => mb_strtolower($k->email)); // egy címre egy levél
        [$files, $missing] = self::files($officeId, $documentIds); $sent = 0;
        foreach ($contacts as $k) {
            $nk = "$key:{$k->id}";
            $row = ['office_id' => $officeId, 'client_id' => $clientId, 'message_id' => $messageId, 'to_email' => $k->email, 'to_name' => $k->name, 'subject' => $subject, 'body' => $body, 'kind' => $kind, 'updated_at' => now()];
            // Atomikus foglalás: csak a nyertes küld. Új sor beszúrása, vagy egy korábban sikertelen sor visszavétele; sent/draft sort más futás birtokol.
            try { $nid = DB::table('client_notices')->insertGetId($row + ['idempotency_key' => $nk, 'status' => 'draft', 'created_at' => now()]); }
            catch (\Illuminate\Database\UniqueConstraintViolationException $e) {
                $nid = DB::table('client_notices')->where('idempotency_key', $nk)->where('status', 'failed')->value('id');
                if (!$nid || DB::table('client_notices')->where('id', $nid)->where('status', 'failed')->update($row + ['status' => 'draft', 'skip_reason' => null]) !== 1) continue;
            }
            if ($missing) {
                DB::table('client_notices')->where('id', $nid)->update(['status' => 'failed', 'skip_reason' => mb_substr('A csatolandó fájl nem található: ' . implode(', ', $missing), 0, 200)]);
                Audit::log($officeId, null, "Automatikus levél nem ment ki, a csatolandó fájl hiányzik: {$k->name}, $subject", ['client_id' => $clientId, 'message_id' => $messageId]);
                continue;
            }
            try { OfficeMail::mailer($officeId)->raw($body, fn ($m) => self::build($m, $k->email, $k->name, $subject, $files)); }
            catch (\Throwable $e) {
                DB::table('client_notices')->where('id', $nid)->update(['status' => 'failed', 'skip_reason' => mb_substr($e->getMessage(), 0, 200)]);
                Audit::log($officeId, null, "Automatikus levél küldése sikertelen: {$k->name}, $subject", ['client_id' => $clientId, 'message_id' => $messageId]);
                continue;
            }
            DB::table('client_notices')->where('id', $nid)->update(['status' => 'sent', 'sent_at' => now()]); // a levél kiment: innen nincs visszaút, az audit hibája nem küldet újra
            $sent++;
            Audit::log($officeId, null, "Automatikus levél elküldve az ügyfélnek: {$k->name} ({$k->email}), $subject" . ($files ? ', ' . count($files) . ' csatolmánnyal' : ''), ['client_id' => $clientId, 'message_id' => $messageId, 'evidence' => "értesítés #$nid, fajta: $kind, levelező: " . OfficeMail::label($officeId)]);
        }
        return ['sent' => $sent, 'skipped' => null];
    }

    /** A felhasználónak menő levél: napló nélkül, csak audittal. */
    public static function toUser(int $officeId, int $userId, string $subject, string $body, array $documentIds = []): bool
    {
        $u = DB::table('users')->where('office_id', $officeId)->find($userId);
        if (!$u) return false;
        if (!$u->email || $u->email === \App\Http\Controllers\AppController::LOCAL_EMAIL) { Audit::log($officeId, null, "Felhasználónak szánt levél kihagyva (nincs e-mail-cím megadva): {$u->name}, $subject"); return false; }
        if (!OfficeMail::ready($officeId)) { Audit::log($officeId, null, "Felhasználónak szánt levél kihagyva (nincs beállított levelezés): {$u->name}, $subject"); return false; }
        [$files, $missing] = self::files($officeId, $documentIds);
        if ($missing) { Audit::log($officeId, null, "Felhasználónak szánt levél nem ment ki, a csatolandó fájl hiányzik: {$u->name}, $subject"); return false; }
        try {
            OfficeMail::mailer($officeId)->raw($body, fn ($m) => self::build($m, $u->email, $u->name, $subject, $files));
            Audit::log($officeId, null, "Automatikus levél elküldve: {$u->name} ({$u->email}), $subject" . ($files ? ', ' . count($files) . ' csatolmánnyal' : ''));
            return true;
        } catch (\Throwable $e) {
            Audit::log($officeId, null, "Automatikus levél küldése sikertelen: {$u->name}, $subject");
            return false;
        }
    }

    private static function build($mail, string $email, string $name, string $subject, array $files): void
    {
        $mail->to($email, $name)->subject($subject);
        foreach ($files as $f) $mail->attachData($f[1], $f[0], ['mime' => $f[2]]);
    }

    /** A dokumentumok tárolt fájljai és a hiányzók nevei: ha bármi hiányzik, a levél nem mehet ki hiányosan. @return array{0: array, 1: array} */
    private static function files(int $officeId, array $ids): array
    {
        if (!$ids) return [[], []];
        $files = []; $missing = [];
        $docs = DB::table('documents')->where('office_id', $officeId)->whereIn('id', $ids)->orderBy('id')->get()->keyBy('id');
        foreach ($ids as $id) {
            $d = $docs[$id] ?? null;
            if (!$d) { $missing[] = "#$id"; continue; }
            if (!$d->path || !Storage::disk('local')->exists($d->path)) { $missing[] = $d->name; continue; }
            $files[] = [$d->name, Storage::disk('local')->get($d->path), $d->mime ?: 'application/octet-stream'];
        }
        return [$files, $missing];
    }
}
