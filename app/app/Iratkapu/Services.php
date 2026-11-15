<?php

namespace App\Iratkapu;

use App\Http\Controllers\AppController;
use Carbon\Carbon;
use Illuminate\Contracts\Mail\Mailer;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;

/** Az iroda saját SMTP-kiszolgálója. A jelszó titkosítva van az iroda beállításai között, és soha nem megy ki a felületre. */
class OfficeMail
{
    public static function settings(int $officeId): array
    {
        return json_decode(DB::table('offices')->where('id', $officeId)->value('settings') ?? '{}', true) ?: [];
    }

    public static function put(int $officeId, array $patch): void
    {
        $s = array_filter(array_merge(self::settings($officeId), $patch), fn ($v) => $v !== null);
        DB::table('offices')->where('id', $officeId)->update(['settings' => json_encode($s)]);
    }

    /** Amit a felület láthat: minden, a jelszó kivételével. */
    public static function summary(int $officeId): array
    {
        $m = self::settings($officeId)['smtp'] ?? null;
        if (! $m) {
            return ['configured' => false, 'fallback' => config('mail.default')];
        }

        return ['configured' => true, 'host' => $m['host'], 'port' => $m['port'], 'enc' => $m['enc'], 'username' => $m['username'] ?? '', 'hasPassword' => ! empty($m['password']), 'from' => $m['from'], 'fromName' => $m['from_name'] ?? ''];
    }

    /** Az iroda levelezője; ha nincs beállítva, a szerver alapértelmezettje. */
    public static function mailer(int $officeId): Mailer
    {
        $m = self::settings($officeId)['smtp'] ?? null;
        $office = (string) DB::table('offices')->where('id', $officeId)->value('name');
        $replyTo = self::office($officeId)['replyTo'];
        if (! $m) { // a megosztott levelezőn minden híváskor felülírjuk, hogy egy másik iroda értéke ne maradjon rajta
            $mailer = Mail::mailer();
            $mailer->alwaysFrom(config('mail.from.address'), $office ?: null);
            $mailer->alwaysReplyTo($replyTo);

            return $mailer;
        }
        $ssl = $m['enc'] === 'ssl';
        $mailer = Mail::build(['transport' => 'smtp', 'scheme' => $ssl ? 'smtps' : 'smtp', 'host' => $m['host'], 'port' => (int) $m['port'],
            'username' => ($m['username'] ?? '') ?: null, 'password' => ! empty($m['password']) ? Crypt::decryptString($m['password']) : null,
            'require_tls' => ! $ssl, 'timeout' => 15]); // STARTTLS kötelező: titkosítatlan csatornán nem megy ki a jelszó
        $mailer->alwaysFrom($m['from'], ($m['from_name'] ?? '') ?: ($office ?: null));
        if ($replyTo) {
            $mailer->alwaysReplyTo($replyTo);
        }

        return $mailer;
    }

    /** Adózónak menő levél csak akkor mehet, ha az irodának van saját SMTP-je, vagy a szerver alapértelmezett levelezője engedélyezett. */
    public static function ready(int $officeId): bool
    {
        return ! empty(self::settings($officeId)['smtp']) || (bool) config('iratkapu.default_mailer_ok');
    }

    /** Az iroda levelezési és értesítési beállításai, alapértékekkel kitöltve. */
    public static function office(int $officeId): array
    {
        $s = self::settings($officeId);
        $a = $s['default_active'] ?? [];

        return ['replyTo' => ($s['reply_to'] ?? '') ?: null, 'defaultActive' => ['mail' => (bool) ($a['mail'] ?? true), 'nav' => (bool) ($a['nav'] ?? true), 'cegkapu' => (bool) ($a['cegkapu'] ?? true)],
            'digestDays' => (int) ($s['digest_days'] ?? 0), 'arrearsDays' => (int) ($s['arrears_days'] ?? 0), 'paymentDays' => array_map('intval', $s['payment_days'] ?? [])];
    }

    public static function label(int $officeId): string
    {
        $m = self::settings($officeId)['smtp'] ?? null;

        return $m ? "smtp ({$m['host']})" : (string) config('mail.default');
    }
}

class RuleEngine
{
    public static function matches(object $rule, object|array $m): bool
    {
        $m = (object) $m;
        $x = json_decode($rule->matcher, true);
        if (! empty($x['unknown'])) {
            return (bool) ($m->unknown ?? $m->type_id === 'ismeretlen');
        }
        if (! empty($x['receipt'])) {
            return (bool) ($m->receipt ?? false);
        }
        if (! empty($x['senders']) && ! in_array($m->sender, $x['senders'], true)) {
            return false;
        }
        if (! empty($x['type']) && ! preg_match('/'.$x['type'].'/iu', ($m->type_label ?? '').' '.($m->subject ?? ''))) {
            return false;
        }

        return ! empty($x['senders']) || ! empty($x['type']);
    }

    public static function matchedRule(object $message): ?object
    {
        if (($message->folder ?? null) === 'ELKULDOTT') {
            return null;
        }
        $rules = DB::table('rules')->where('office_id', $message->office_id)->orderBy('position')->get();
        foreach ($rules as $r) {
            if (self::matches($r, $message)) {
                return $r;
            }
        }

        return null;
    }

    /** Csak ÚJ iratra fut. Belső jelölést és irodán belüli értesítést állít; tárhelyműveletet soha. */
    public static function apply(object $message): void
    {
        if (($message->folder ?? null) === 'ELKULDOTT') {
            return;
        }
        $rules = DB::table('rules')->where('office_id', $message->office_id)->orderBy('position')->get();
        foreach ($rules as $r) {
            if (! self::matches($r, $message)) {
                continue;
            }
            $upd = [];
            if (! $r->locked) {
                if ($r->priority === 'Sürgős') {
                    $upd['urgent'] = true;
                }
                if ($r->assignee_id && in_array($message->client_id, Scope::clientIds(DB::table('users')->find($r->assignee_id)))) {
                    $upd['assignee_id'] = $r->assignee_id;
                    $upd['internal'] = 'kiosztott';
                }
                if ($r->priority === 'Alacsony' && $message->official === 'na') {
                    $upd['internal'] = 'kesz';
                }
            }
            if ($upd) {
                DB::table('messages')->where('id', $message->id)->update($upd);
            }
            $to = match ($r->notify) {
                'Vezetőnek azonnal' => DB::table('users')->where('office_id', $message->office_id)->where('role', 'vezeto')->pluck('id')->all(),
                'Felelősnek azonnal' => array_filter([$upd['assignee_id'] ?? $message->assignee_id]),
                'Reggeli összesítő' => array_filter([$upd['assignee_id'] ?? $message->assignee_id]) ?: DB::table('users')->where('office_id', $message->office_id)->where('role', 'vezeto')->pluck('id')->all(),
                default => [],
            };
            $to = array_filter($to, fn ($uid) => Scope::userSeesClient((int) $uid, (int) $message->client_id)); // a saját tárhely levele nem megy másnak
            foreach ($to as $uid) {
                $r->notify === 'Reggeli összesítő'
                    ? Notify::once($message->office_id, $uid, $message->id, 'osszesito', "Új irat: {$message->subject}", "digest-rule-{$r->id}-{$message->id}-$uid") // csendben gyűjtődik az összesítőnek; a harang és a számláló kiszűri az osszesito fajtát
                    : Notify::once($message->office_id, $uid, $message->id, 'szabaly', "Új irat: {$message->subject}", "rule-{$r->id}-{$message->id}-$uid");
            }
            Audit::log($message->office_id, null, "Szabály alkalmazva: {$r->name} ({$r->version}. verzió)", ['client_id' => $message->client_id, 'message_id' => $message->id, 'policy' => "szabály #{$r->id} v{$r->version}"]);

            return; // az első illeszkedő szabály dönt – determinisztikus sorrend
        }
    }
}

class Notify
{
    public static function once(int $officeId, int $userId, ?int $messageId, string $kind, string $body, string $key): bool
    {
        return (bool) DB::table('notifications')->insertOrIgnore(['office_id' => $officeId, 'user_id' => $userId, 'message_id' => $messageId, 'kind' => $kind, 'body' => $body, 'dedupe_key' => $key, 'created_at' => now(), 'updated_at' => now()]);
    }

    /** Akik az ügyfelet látják: az iroda vezetői és adminjai, valamint a ráosztott munkatársak. */
    public static function audience(int $officeId, int $clientId): array
    {
        $ids = DB::table('users')->where('office_id', $officeId)->where(fn ($q) => $q->whereIn('role', ['vezeto', 'admin'])
            ->orWhereIn('id', DB::table('client_user')->where('client_id', $clientId)->pluck('user_id')))->pluck('id')->all();

        return array_values(array_filter($ids, fn ($uid) => Scope::userSeesClient((int) $uid, $clientId)));
    }

    /** Leállt szinkron: tárhelyenként és naponta legfeljebb egy értesítés címzettenként. */
    public static function syncStopped(object $mailbox, string $why): int
    {
        $c = DB::table('clients')->find($mailbox->client_id);
        $n = 0;
        if ($c->auth_until && $c->auth_until < now()->toDateString()) {
            return self::authorizations($mailbox->office_id, $c->id);
        } // ennek saját fajtája van
        foreach (self::audience($mailbox->office_id, $c->id) as $uid) {
            $n += (int) self::once($mailbox->office_id, $uid, null, 'szinkron', "Leállt a szinkron: {$c->name} ({$mailbox->type}) – $why", "sync-{$mailbox->id}-".now()->toDateString()."-$uid");
        }

        return $n;
    }

    /** Meghatalmazás: figyelmeztetés 14 és 3 nappal a lejárat előtt, és egyszer a lejárat után. */
    public static function authorizations(?int $officeId = null, ?int $clientId = null): int
    {
        $n = 0;
        $q = DB::table('clients')->whereNotNull('auth_until');
        if ($officeId) {
            $q->where('office_id', $officeId);
        }
        if ($clientId) {
            $q->where('id', $clientId);
        }
        foreach ($q->get() as $c) {
            $days = (int) now()->startOfDay()->diffInDays($c->auth_until, false);
            if ($days >= 0 && ! in_array($days, [14, 3], true)) {
                continue;
            }
            $body = $days < 0 ? "Lejárt a meghatalmazás: {$c->name} – tárhelyművelet nem indítható" : "$days nap múlva lejár a meghatalmazás: {$c->name}";
            foreach (self::audience($c->office_id, $c->id) as $uid) {
                $n += (int) self::once($c->office_id, $uid, null, 'meghatalmazas', $body, "auth-{$c->id}-{$c->auth_until}-".($days < 0 ? 'lejart' : $days)."-$uid");
            }
        }

        return $n;
    }

    /** Az emlékeztető e-mailben is, ha az iroda bekapcsolta és van saját SMTP-je. Hiba nem állítja meg az emlékeztetőket. */
    private static function reminderMail(object $m, int $days): void
    {
        $s = OfficeMail::settings($m->office_id);
        if (empty($s['reminder_email']) || empty($s['smtp'])) {
            return;
        }
        $to = DB::table('users')->find($m->assignee_id);
        $client = DB::table('clients')->where('id', $m->client_id)->value('name');
        if (! $to) {
            return;
        }
        if (! $to->email || $to->email === AppController::LOCAL_EMAIL) {
            Audit::log($m->office_id, null, "Határidő-emlékeztető e-mail kihagyva (nincs e-mail-cím megadva): {$to->name}", ['client_id' => $m->client_id, 'message_id' => $m->id]);

            return;
        }
        try {
            OfficeMail::mailer($m->office_id)->raw("Kedves {$to->name}!\n\n$days nap múlva lejár egy rád osztott irat határideje.\n\nÜgyfél: $client\nIrat: {$m->subject}\nHatáridő: {$m->deadline_date}\n\nA részleteket a KapuMailben találod.",
                fn ($mail) => $mail->to($to->email, $to->name)->subject("Határidő $days nap múlva: {$m->subject}"));
            Audit::log($m->office_id, null, "Határidő-emlékeztető e-mailben elküldve: {$to->name}", ['client_id' => $m->client_id, 'message_id' => $m->id]);
        } catch (\Throwable $e) {
            Audit::log($m->office_id, null, "Határidő-emlékeztető e-mail küldése sikertelen: {$to->name}", ['client_id' => $m->client_id, 'message_id' => $m->id]);
        }
    }

    /** Emlékeztető kizárólag MEGERŐSÍTETT határidőre. */
    public static function reminders(?int $officeId = null): int
    {
        $n = 0;
        $q = DB::table('messages')->whereNotNull('deadline_date')->where('deadline_sure', true)->where('internal', '!=', 'kesz')->where('archived', false)
            ->where(fn ($w) => $w->whereNull('folder')->orWhere('folder', '!=', 'ELKULDOTT'));
        if ($officeId) {
            $q->where('office_id', $officeId);
        }
        foreach ($q->get() as $m) {
            $days = (int) now()->startOfDay()->diffInDays($m->deadline_date, false);
            $set = OfficeMail::settings($m->office_id)['reminders'] ?? [5, 2, 1];
            if (! in_array($days, $set, true) || ! $m->assignee_id) {
                continue;
            }
            if (! self::once($m->office_id, $m->assignee_id, $m->id, 'hatarido', "$days nap múlva lejár: {$m->subject}", "rem-{$m->id}-{$m->deadline_date}-$days")) {
                continue;
            }
            $n++;
            self::reminderMail($m, $days);
        }

        return $n;
    }
}

class SyncService
{
    /** Listázó szinkron. Idempotens: ugyanaz a küldemény nem hoz létre új ügyiratot. */
    public static function run(object $mailbox, ?object $actor, bool $advance = true): array
    {
        $run = ['office_id' => $mailbox->office_id, 'mailbox_id' => $mailbox->id, 'actor' => $actor->name ?? 'Rendszer', 'created_at' => now(), 'updated_at' => now()];
        if ($mailbox->sync_state === 'need') {
            DB::table('sync_runs')->insert($run + ['state' => 'need', 'note' => $mailbox->sync_note]);

            return ['state' => 'need', 'created' => 0, 'listed' => 0];
        }
        try {
            ConnectorGuard::authorize('listMessages', $mailbox, $actor);
        } catch (GateException $e) {
            DB::table('sync_runs')->insert($run + ['state' => 'need', 'note' => $e->getMessage()]);
            DB::table('mailboxes')->where('id', $mailbox->id)->update(['sync_state' => 'need', 'sync_note' => $e->getMessage()]);
            Notify::syncStopped($mailbox, $e->getMessage());

            return ['state' => 'need', 'created' => 0, 'listed' => 0, 'error' => $e->getMessage()];
        }
        $items = (new DemoConnector)->listMessages($mailbox, $advance);
        FormCatalog::syncIfNeeded(false, $actor);
        $created = 0;
        foreach ($items as $it) {
            $exists = DB::table('messages')->where('mailbox_id', $mailbox->id)->where('source_id', $it['source_id'])->exists();
            if ($exists) {
                continue;
            } // meglévő: nincs új ügyirat, nincs új értesítés, nincs tárhelyművelet
            $tax = null;
            if (empty($it['type_id'])) {
                $tax = Taxonomy::classify($it['subject'], $it['sender'], (int) $mailbox->office_id);
                $it['type_id'] = $tax->type_id ?? 'ismeretlen';
                $it['type_label'] = $tax->label ?? 'Ismeretlen típus';
            }
            $id = DB::table('messages')->insertGetId(['type_ai' => (bool) $tax, 'type_group' => $tax->group ?? null, 'type_risk' => $tax->risk ?? null,
                'office_id' => $mailbox->office_id, 'client_id' => $mailbox->client_id, 'mailbox_id' => $mailbox->id, 'source_id' => $it['source_id'],
                'sender' => $it['sender'], 'sender_full' => $it['sender_full'], 'subject' => $it['subject'], 'type_id' => $it['type_id'], 'type_label' => $it['type_label'],
                'unknown' => $it['type_id'] === 'ismeretlen', 'receipt' => str_contains($it['type_id'], 'nyugta'), 'arrived_at' => $it['arrived_at'],
                'official' => $it['official'], 'internal' => $it['type_id'] === 'ismeretlen' ? 'oszt' : 'uj', 'es3' => $it['es3'], 'created_at' => now(), 'updated_at' => now(),
            ]);
            DB::table('delivery_events')->insert(['office_id' => $mailbox->office_id, 'message_id' => $id, 'type' => 'listazva', 'at' => now(), 'evidence_ref' => 'demó-lista', 'created_at' => now(), 'updated_at' => now()]);
            Audit::log($mailbox->office_id, null, 'Új küldemény listázva – joghatás nélkül', ['client_id' => $mailbox->client_id, 'message_id' => $id, 'evidence' => 'demó-lista']);
            $rules = TypeActions::onArrival($id);
            if ($rules) {
                RuleEngine::apply(DB::table('messages')->find($id));
            } $created++;
            if ($rules && $tax && str_starts_with($tax->priority, 'P1') && ! DB::table('messages')->where('id', $id)->value('urgent')) {
                DB::table('messages')->where('id', $id)->update(['urgent' => true]);
                Audit::log($mailbox->office_id, null, "Sürgős jelölés a taxonómia alapján ({$tax->type_id}, {$tax->version}) – gépi becslés", ['client_id' => $mailbox->client_id, 'message_id' => $id]);
            }
            TypeActions::autoArchive($id);
            DocumentForward::run($id, 'arrival');
        }
        DB::table('mailboxes')->where('id', $mailbox->id)->update(['sync_state' => 'ok', 'sync_note' => $created ? "$created új küldemény listázva" : 'Nincs új küldemény', 'last_ok_at' => now()]);
        DB::table('sync_runs')->insert($run + ['state' => 'ok', 'listed' => count($items), 'created' => $created, 'note' => $created ? "$created új" : 'nincs új']);

        return ['state' => 'ok', 'created' => $created, 'listed' => count($items)];
    }
}

class Receiving
{
    /** Jóváhagyott átvétel végrehajtása. Élő módban az őr zárolja; demó módban a minta-csatlakozó fut. */
    public static function execute(object $approval, object $actor): string
    {
        $m = DB::table('messages')->find($approval->message_id);
        $mb = DB::table('mailboxes')->find($m->mailbox_id);
        try {
            ConnectorGuard::authorize('download', $mb, $actor, $approval->id, $m->id);
        } catch (GateException $e) {
            DB::table('approvals')->where('id', $approval->id)->update(['status' => 'blocked', 'result_note' => $e->getMessage(), 'updated_at' => now()]);

            return $e->getMessage();
        }
        if ($m->official !== 'wait') {
            DB::table('approvals')->where('id', $approval->id)->update(['status' => 'executed', 'result_note' => 'Az irat már át volt véve.']);

            return 'Az irat már át volt véve.';
        }
        $file = (new DemoConnector)->download($m);
        $doc = Documents::store($m->office_id, $m->id, $file['name'], $file['bytes'], $actor->id);
        DB::transaction(function () use ($m, $approval, $actor, $doc) {
            DB::table('delivery_events')->insert(['office_id' => $m->office_id, 'message_id' => $m->id, 'type' => 'atvett', 'at' => now(), 'actor_id' => $actor->id, 'evidence_ref' => "demó letöltési igazolás, dokumentum #{$doc}", 'evidence_sha256' => DB::table('documents')->where('id', $doc)->value('sha256'), 'created_at' => now(), 'updated_at' => now()]);
            $upd = ['official' => 'ok', 'official_at' => now(), 'official_by' => $approval->requested_by, 'updated_at' => now()];
            if ($d = config('iratkapu.demo_deadline_days')[$m->type_id] ?? null) {
                $upd += ['deadline_date' => now()->addDays($d)->toDateString(), 'deadline_sure' => false, 'deadline_source' => "Mintaszabály: átvétel + $d nap (nem hiteles)"];
            }
            DB::table('messages')->where('id', $m->id)->update($upd);
            DB::table('approvals')->where('id', $approval->id)->update(['status' => 'executed', 'result_note' => 'Átvéve a demó-csatlakozóval.', 'updated_at' => now()]);
            Audit::log($m->office_id, $actor, 'Hivatalos átvétel (demó-csatlakozó)', ['client_id' => $m->client_id, 'message_id' => $m->id, 'before' => 'wait', 'after' => 'ok', 'evidence' => "jóváhagyás #{$approval->id}, dokumentum #{$doc}", 'policy' => config('iratkapu.policy_version')]);
        });
        LegalDeadline::apply($m->id);
        DocumentForward::run($m->id, 'downloaded');

        return 'Átvéve a demó-csatlakozóval.';
    }
}

class Documents
{
    /** Egyszerű szövegkinyerés a kereséshez: szöveges fájlok és tömörítetlen PDF-szöveg. Beolvasott (szkennelt) PDF-hez OCR kellene. */
    public static function extractText(?string $mime, string $bytes): ?string
    {
        if (strlen($bytes) > 5 * 1024 * 1024) {
            return null;
        }
        if (XlsxReader::isXlsx($mime, $bytes)) {
            $t = XlsxReader::text($bytes);

            return $t === null ? null : mb_substr($t, 0, 200000);
        } // táblázat: sorok és tabulátorok megmaradnak
        if (str_starts_with($bytes, "PK\x03\x04")) {
            return null;
        } // más ZIP-alapú fájl (docx stb.): a MIME-ban szereplő „xml” miatt se kezeljük szövegként
        if ($mime === 'application/pdf') {
            preg_match_all('/\((.*?)(?<!\\\\)\)\s*Tj/s', $bytes, $m);
            $t = implode(' ', $m[1]);
        } elseif ($mime && (str_starts_with($mime, 'text/') || str_contains($mime, 'xml')) && ! str_contains($bytes, 'e-szigno30#')) {
            $t = strip_tags($bytes);
        } else {
            return null;
        }
        $t = trim(preg_replace('/\s+/u', ' ', mb_convert_encoding($t, 'UTF-8', 'UTF-8')));

        return $t === '' ? null : mb_substr($t, 0, 20000);
    }

    /** Eredeti bájtok változatlan mentése + SHA-256; es3 esetén kibontás külön eredménnyel. */
    /** Egy feltöltésből (és a benne lévő, egymásba ágyazott csomagokból) összesen kibontott fájlok száma. */
    private static int $treeDocs = 0;

    public static function store(int $officeId, ?int $messageId, string $name, string $bytes, ?int $userId, ?int $parent = null, int $depth = 1): int
    {
        if ($parent === null) {
            self::$treeDocs = 0;
            Ocr::resetBudget();
        }
        $sha = hash('sha256', $bytes);
        $path = "eredeti/$officeId/$sha";
        if (! Storage::disk('local')->exists($path)) {
            Storage::disk('local')->put($path, $bytes);
        }
        @chmod(Storage::disk('local')->path($path), 0440);
        $name = Es3Reader::safeName($name);
        $isEs3 = str_ends_with(strtolower($name), '.es3');
        $isKrx = str_ends_with(strtolower($name), '.krx');
        $row = ['office_id' => $officeId, 'message_id' => $messageId, 'parent_id' => $parent, 'name' => $name, 'mime' => (new \finfo(FILEINFO_MIME_TYPE))->buffer($bytes),
            'size' => strlen($bytes), 'sha256' => $sha, 'path' => $path, 'uploaded_by' => $userId, 'created_at' => now(), 'updated_at' => now(),
            'validity' => 'nem_ellenorizheto', 'validity_note' => $parent ? 'Az aktából kibontott másolat; a hitelességet az akta hordozza.' : 'Nincs érvényesítő komponens bekötve (ADR-005).'];
        $parsed = null;
        if ($isEs3) {
            try {
                $parsed = (new Es3Reader)->read($bytes, $depth);
                $row['parse_state'] = 'kibontva';
                $row['meta'] = json_encode(['title' => $parsed['title'], 'signatures' => $parsed['signatures'], 'timestamps' => $parsed['timestamps']]);
                $row['validity_note'] = $parsed['signatures'] ? "{$parsed['signatures']} aláírás található, de nincs érvényesítő komponens bekötve (ADR-005)." : 'Az aktában nincs aláírás; érvényesítő komponens sincs bekötve (ADR-005).';
            } catch (Es3Exception $e) {
                $row['parse_state'] = 'nem_bonthato';
                $row['meta'] = json_encode(['error' => $e->getMessage()]);
            }
        }
        if ($isEs3 && $parsed) {
            $sig = SignatureCheck::check($bytes);
            $row['validity'] = $sig['validity'];
            $row['validity_note'] = $sig['note'];
            $row['signatures'] = json_encode($sig['signatures']);
            $row['validated_at'] = now();
        }
        if ($isKrx) { // KRX-boríték: ZIP-tárolóként bontjuk ki, a belső szerkezetet nem értelmezzük (KrxReader)
            try {
                if ($depth > config('iratkapu.es3.max_depth')) {
                    throw new KrxException('Túl mélyen egymásba ágyazott csomag.');
                }
                $parsed = (new KrxReader)->read($bytes);
                $row['parse_state'] = 'kibontva';
                $row['meta'] = json_encode(['skipped' => $parsed['skipped']]);
                $row['validity_note'] = 'KRX-boríték kibontva. A boríték szerkezetét a program nem értelmezi és nem ellenőrzi; hitelességet nem vizsgál.'.($parsed['skipped'] ? " {$parsed['skipped']} titkosított fájl kimaradt." : '');
            } catch (KrxException $e) {
                $parsed = null;
                $row['parse_state'] = 'nem_bonthato';
                $row['meta'] = json_encode(['error' => $e->getMessage()]);
            }
        }
        // A fájlszám-korlát az egész feltöltésre együtt érvényes, nem csomagonként: különben az egymásba ágyazás megkerülné.
        $kids = array_filter($parsed['documents'] ?? [], fn ($d) => $d['bytes'] !== null && $d['bytes'] !== '');
        if ($kids && self::$treeDocs + count($kids) > config('iratkapu.es3.max_docs')) {
            $parsed = null;
            $kids = [];
            $row['parse_state'] = 'nem_bonthato';
            $row['meta'] = json_encode(['error' => 'A csomagok együtt túl sok fájlt tartalmaznak, a kibontás itt megáll.']);
        }
        self::$treeDocs += count($kids);
        $row['text'] = self::extractText($row['mime'], $bytes);
        if ($row['text'] === null && $row['mime'] === 'application/pdf') {
            $row['text'] = Ocr::pdfText($bytes);
        } // tömörített szövegrétegű PDF
        $row['text_source'] = $row['text'] !== null ? 'text' : null;
        if ($row['text'] === null && ($ocr = Ocr::text($bytes, $row['mime'])) !== null) {
            $row['text'] = $ocr;
            $row['text_source'] = 'ocr';
        }
        $id = DB::table('documents')->insertGetId($row);
        foreach ($kids as $d) {
            self::store($officeId, $messageId, $d['name'], $d['bytes'], $userId, $id, $depth + 1);
        }

        return $id;
    }
}

/**
 * Kinyeri a letöltött iratokból (XML mezők, kibontott PDF/szöveg és tárgy) a nyomtatványkódot,
 * vonalkódot, bevallási időszakot és a fizetési/pótlási határidőt (mindig nem megerősítettként:
 * `deadline_sure = false`), továbbá összepárosítja a NAV nyugtákat a NAV adónaptár tételeivel.
 */
class DeadlineExtractor
{
    /** A találat körüli szövegrész (legfeljebb ~300 karakter), szóhatáron vágva; magába a találatba soha nem vág bele. */
    public static function excerpt(string $text, int $byteOffset, int $byteLength): string
    {
        $start = mb_strlen(substr($text, 0, $byteOffset));
        $len = mb_strlen(substr($text, $byteOffset, $byteLength));
        $from = max(0, $start - 120);
        $to = min(mb_strlen($text), $start + $len + 140);
        $lead = mb_substr($text, $from, $start - $from);
        $hit = mb_substr($text, $start, $len);
        $tail = mb_substr($text, $start + $len, $to - $start - $len);
        if ($from > 0) {
            $lead = preg_match('/^\S*\s(.*)$/us', $lead, $x) ? '…'.$x[1] : '…';
        }      // csonka első szó le; ha nincs szóköz, az előzmény elmarad
        if ($to < mb_strlen($text)) {
            $tail = preg_match('/^(.*)\s\S*$/us', $tail, $y) ? $y[1].'…' : '…';
        }

        return trim(preg_replace('/\s+/u', ' ', $lead.$hit.$tail));
    }

    public static function normalizeDate(?string $raw): ?string
    {
        if (! $raw) {
            return null;
        }
        $s = trim($raw);
        if (preg_match('/^(\d{4})[.\-\/](\d{2})[.\-\/](\d{2})/', $s, $m)) {
            if (checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
                return "{$m[1]}-{$m[2]}-{$m[3]}";
            }
        }

        return null;
    }

    public static function extractFormCode(string $haystack, ?string $liveType = null): ?string
    {
        if ($fromCatalog = FormCatalog::extractFormCode($haystack, $liveType)) {
            return $fromCatalog;
        }
        if (preg_match('/\b(2[4-9](?:08|29|53|58|65|A60|K58|T1041)|[0-9]{2}(?:08|65|58|29)|HIPA)\b/iu', $haystack, $m)) {
            return mb_strtoupper($m[1]);
        }

        return null;
    }

    /** Hivatkozott érkeztetési szám kinyerése szövegből vagy tárgyból (feladási / letöltési / érkeztetési igazolásokból). */
    public static function extractReferencedEid(?string $text): ?string
    {
        if ($text === null || $text === '') {
            return null;
        }
        if (preg_match('/<(?:HivatkozottErkeztetesiSzam|EredetiErkeztetesiSzam|HivatkozasiSzam|hivatkozottErkeztetesiSzam)>([A-Za-z0-9\-]{6,64})<\//iu', $text, $xm)) {
            return trim($xm[1]);
        }
        if (preg_match('/(?:hivatkozott\s+[eé]rkeztet[eé]si\s+sz[aá]m|eredeti\s+[eé]rkeztet[eé]si\s+sz[aá]m|hivatkoz[aá]si\s+sz[aá]m|[eé]rkeztet[eé]si\s+sz[aá]m)\s*:?\s*([0-9][0-9A-Za-z\-]{5,63})\b/iu', $text, $m)) {
            return trim($m[1]);
        }

        return null;
    }

    public static function enrich(int $messageId): array
    {
        $m = DB::table('messages')->find($messageId);
        if (! $m) {
            return [];
        }
        $docs = DB::table('documents')->where('message_id', $messageId)->orderBy('id')->get();
        $xmlTexts = [];
        $plainTexts = [$m->subject];

        $ocrUsed = false; // ha a szöveg szövegfelismerésből jön, a belőle kinyert dátum bizonytalanabb
        foreach ($docs as $d) {
            if ($d->text) {
                $plainTexts[] = $d->text;
                $ocrUsed = $ocrUsed || ($d->text_source ?? null) === 'ocr';
            }
            if ($d->size <= 2 * 1024 * 1024 && ($d->mime && (str_contains($d->mime, 'xml') || str_starts_with($d->mime, 'text/'))) && Storage::disk('local')->exists($d->path)) {
                $raw = Storage::disk('local')->get($d->path);
                if (! str_contains($raw, 'e-szigno30#')) {
                    $xmlTexts[] = $raw;
                }
            }
        }

        $xmlBlob = implode("\n", $xmlTexts);
        $textBlob = implode("\n", $plainTexts);

        $formCode = $m->form_code;
        if (! $formCode && preg_match('/<(?:NyomtatvanyAzonosito|NyomtatvanyKod|BevallasKod|nyomtatvanyKod)>([^<]{2,24})<\//iu', $xmlBlob, $xm)) {
            $formCode = mb_strtoupper(trim($xm[1]));
        }
        if (! $formCode) {
            $formCode = self::extractFormCode($textBlob, $m->live_type ?? null);
        }

        $barcode = $m->barcode;
        if (! $barcode && preg_match('/<(?:Vonalkod|Iktatoszam|ErkeztetesiSzam|vonalkod)>([A-Za-z0-9\-]{6,40})<\//iu', $xmlBlob, $bm)) {
            $barcode = trim($bm[1]);
        }
        if (! $barcode && preg_match('/(?:vonalk[oó]d|iktat[oó]sz[aá]m)\s*:?\s*([0-9]{8,16})\b/iu', $textBlob, $bm2)) {
            $barcode = trim($bm2[1]);
        }

        $periodFrom = $m->period_from;
        $periodTo = $m->period_to;
        if (! $periodFrom && preg_match('/<(?:IdoszakTol|IdoszakKezdete|idoszakTol)>([^<]+)<\//iu', $xmlBlob, $pm1)) {
            $periodFrom = self::normalizeDate($pm1[1]);
        }
        if (! $periodTo && preg_match('/<(?:IdoszakIg|IdoszakVege|idoszakIg)>([^<]+)<\//iu', $xmlBlob, $pm2)) {
            $periodTo = self::normalizeDate($pm2[1]);
        }

        $refEid = ($m->ref_eid ?? null) ?: (self::extractReferencedEid($xmlBlob) ?: self::extractReferencedEid($textBlob));
        $isSent = ($m->folder ?? null) === 'ELKULDOTT';

        $dlDate = null;
        $dlSource = null;
        $dlExcerpt = null; // az a szövegrész, amelyből a dátum származik – hogy ember ellenőrizhesse
        if (! $isSent && preg_match('/<(FizetesiHatarido|PotlasiHatarido|BenyujtasiHatarido|Hatarido|Esedekesseg)>([^<]+)<\//iu', $xmlBlob, $dm)) {
            $dlDate = self::normalizeDate($dm[2]);
            if ($dlDate) {
                $dlSource = 'Kinyerve az XML mellékletből (ellenőrizendő)';
                $dlExcerpt = "XML mező: {$dm[1]} = ".trim($dm[2]);
            }
        }
        if (! $isSent && ! $dlDate && preg_match('/(?:fizet[eé]si\s+|p[oó]tl[aá]si\s+|beny[uú]jt[aá]si\s+|teljes[ií]t[eé]si\s+)?(?:hat[aá]rid[oő]|esed[eé]kess[eé]g(?:e)?)\s*:?\s*(\d{4}[.\-\/]\d{2}[.\-\/]\d{2})/iu', $textBlob, $dm2, PREG_OFFSET_CAPTURE)) {
            $dlDate = self::normalizeDate($dm2[1][0]);
            if ($dlDate) {
                $dlSource = 'Kinyerve az irat szövegéből (ellenőrizendő)';
                $dlExcerpt = self::excerpt($textBlob, $dm2[0][1], strlen($dm2[0][0]));
            }
        }
        if (! $isSent && ! $dlDate && preg_match_all('/(?<!\d)(\d{1,2})\s*(munkanapon|napon)\s*bel[uü]l/iu', $textBlob, $all, PREG_SET_ORDER | PREG_OFFSET_CAPTURE)) {
            $base = $m->official_at ? Carbon::parse($m->official_at) : now();
            $best = null;
            $distinct = [];
            foreach ($all as $hit) {
                $days = (int) $hit[1][0];
                if ($days < 1 || $days > 90) {
                    continue;
                }
                // „munkanapon belül”: hétvége és munkaszüneti nap nélkül számolva; az áthelyezett munkanapokat nem ismerjük.
                $workdays = mb_strtolower($hit[2][0]) === 'munkanapon';
                $date = ($workdays ? WorkCalendar::addWorkdays($base, $days) : $base->copy()->addDays($days))->toDateString();
                $distinct[$date] = true;
                if ($best === null || $date < $best['date']) {
                    $best = ['date' => $date, 'days' => $days, 'workdays' => $workdays, 'hit' => $hit[0]];
                }
            }
            if ($best) {
                // Több kifejezésnél (például fellebbezési és teljesítési határidő) a legkorábbit vesszük: a tévedés így a „korábban szól” irányba esik.
                $dlDate = $best['date'];
                $dlSource = 'Az irat szövegéből számolva: +'.$best['days'].($best['workdays'] ? ' munkanap az átvételtől' : ' nap')
                    .(count($distinct) > 1 ? '; több határidő-kifejezés van az iratban, a legkorábbit vettük' : '').' (ellenőrizendő)';
                $dlExcerpt = self::excerpt($textBlob, $best['hit'][1], strlen($best['hit'][0]));
            }
        }
        if (! $isSent && ! $dlDate && ($fallbackDays = config('iratkapu.demo_deadline_days')[$m->type_id] ?? null)) {
            $base = $m->official_at ? Carbon::parse($m->official_at) : now();
            $dlDate = $base->copy()->addDays($fallbackDays)->toDateString();
            $dlSource = "Mintaszabály: átvétel + $fallbackDays nap (nem hiteles)";
        }

        $upd = [];
        if ($formCode && ! $m->form_code) {
            $upd['form_code'] = mb_substr($formCode, 0, 32);
        }
        if ($barcode && ! $m->barcode) {
            $upd['barcode'] = mb_substr($barcode, 0, 64);
        }
        if ($periodFrom && ! $m->period_from) {
            $upd['period_from'] = $periodFrom;
        }
        if ($periodTo && ! $m->period_to) {
            $upd['period_to'] = $periodTo;
        }
        if ($refEid && empty($m->ref_eid)) {
            $upd['ref_eid'] = mb_substr($refEid, 0, 64);
        }
        if (! $isSent && $dlDate && ! $m->deadline_sure && ! $m->deadline_date) {
            $upd['deadline_date'] = $dlDate;
            $upd['deadline_sure'] = false;
            $upd['deadline_source'] = $dlSource.($ocrUsed && ! str_contains((string) $dlSource, 'XML') && ! str_contains((string) $dlSource, 'Mintaszabály') ? ' – szövegfelismerésből, az eredeti iraton ellenőrizd' : '');
            $upd['deadline_excerpt'] = $dlExcerpt;
            // Az érkezésnél korábbi dátum jó eséllyel egy korábbi irat hivatkozása, nem új határidő.
            $upd['past_deadline_warn'] = $m->arrived_at && $dlDate < substr((string) $m->arrived_at, 0, 10);
        }
        if ($upd) {
            DB::table('messages')->where('id', $messageId)->update($upd + ['updated_at' => now()]);
        }

        $paired = $isSent ? null : self::pairObligation(DB::table('messages')->find($messageId));

        return ['updated' => $upd, 'deadline' => $upd['deadline_date'] ?? null, 'pairedObligationId' => $paired];
    }

    /** Összekapcsolja a beérkezett NAV elfogadó/elutasító nyugtát a megfelelő adónaptár-kötelezettséggel. */
    public static function pairObligation(?object $m): ?int
    {
        if (! $m || ($m->folder ?? null) === 'ELKULDOTT') {
            return null;
        }
        $isReceipt = (bool) $m->receipt
            || in_array($m->type_id, ['nav.nyugta.elfogado', 'nav.nyugta.elutasito'], true)
            || (bool) preg_match('/(elfogad[oó]|elutas[ií]t[oó]|hib[aá]s)\s+nyugta/iu', $m->subject);
        if (! $isReceipt) {
            return null;
        }

        $rejected = $m->type_id === 'nav.nyugta.elutasito' || (bool) preg_match('/elutas[ií]t|hib[aá]s/iu', $m->subject);
        $formCode = ($m->form_code ?? null) ?: self::extractFormCode($m->subject, $m->live_type ?? null);
        $barcode = $m->barcode;
        if (! $formCode && ! $barcode) {
            return null;
        }

        $q = DB::table('tax_obligations')->where('client_id', $m->client_id);
        $ob = null;
        if ($barcode) {
            $ob = (clone $q)->where('barcode', $barcode)->first();
        }
        if (! $ob && $formCode) {
            $ob = (clone $q)
                ->whereRaw('UPPER(form_code) = ?', [mb_strtoupper($formCode)])
                ->when($m->period_to, fn ($qq) => $qq->where('period_end', $m->period_to))
                ->orderByRaw("CASE WHEN status IN ('missing','submittable','conditional') THEN 0 ELSE 1 END")
                ->orderByDesc('due_date')
                ->first();
        }
        if (! $ob) {
            return null;
        }

        $arrDate = substr((string) $m->arrived_at, 0, 10) ?: now()->toDateString();
        DB::table('tax_obligations')->where('id', $ob->id)->update([
            'status' => $rejected ? 'rejected' : 'submitted',
            'receipt_message_id' => $m->id,
            'barcode' => $barcode ?: $ob->barcode,
            'submitted_at' => $ob->submitted_at ?: $arrDate,
            'error_at' => $rejected ? ($ob->error_at ?: $arrDate) : $ob->error_at,
            'updated_at' => now(),
        ]);

        return (int) $ob->id;
    }
}
