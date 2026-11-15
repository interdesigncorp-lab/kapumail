<?php
namespace App\Iratkapu;

use Illuminate\Support\Facades\DB;

class GateException extends \RuntimeException
{
    public function __construct(string $m, public string $kind = 'gate') { parent::__construct($m); }
}

/** Csak bővíthető auditnapló. */
class Audit
{
    public static function log(int $officeId, ?object $actor, string $action, array $x = []): void
    {
        DB::table('audit_events')->insert([
            'office_id' => $officeId, 'at_utc' => now('UTC'),
            'actor_id' => $actor->id ?? null, 'actor_label' => $actor->name ?? 'Rendszer', 'action' => $action,
            'client_id' => $x['client_id'] ?? null, 'message_id' => $x['message_id'] ?? null,
            'before' => $x['before'] ?? null, 'after' => $x['after'] ?? null,
            'evidence' => $x['evidence'] ?? null, 'policy' => $x['policy'] ?? null,
        ]);
    }
}

/** Ki mit láthat: irodahatár + ügyfélszintű hozzáférés. Minden lekérdezés ezen megy át. */
class Scope
{
    public static function seesAll(object $u): bool { return in_array($u->role, ['admin', 'vezeto'], true); }

    public static function clientIds(object $u): array
    {
        $q = DB::table('clients')->where('office_id', $u->office_id);
        if (!self::seesAll($u)) $q->whereIn('id', DB::table('client_user')->where('user_id', $u->id)->pluck('client_id'));
        return $q->whereNotIn('id', self::foreignOwnClientIds($u))->pluck('id')->all();
    }

    /** Más belépőjének „Saját tárhely” gyűjtői: ott a gazda magánlevelei is megjelenhetnek, ezért csak ő látja – admin és vezető sem. */
    public static function foreignOwnClientIds(object $u): array
    {
        // A gazda magán a gyűjtőn van rögzítve (owner_user_id), így sem a belépő törlése, sem a kezelők szerkesztése
        // nem viheti át másra. Gazda nélküli (régi) gyűjtőnél a belépő gazdája számít; ha az sincs, senki nem látja.
        return DB::table('clients')->where('clients.office_id', $u->office_id)->where('discovered_via', 'own')
            ->leftJoin('portal_connections', 'portal_connections.id', '=', 'clients.portal_connection_id')
            ->get(['clients.id as id', 'clients.owner_user_id as owner', 'portal_connections.owner_user_id as portal_owner'])
            ->reject(fn ($c) => (int) ($c->owner ?: $c->portal_owner) === (int) $u->id)
            ->pluck('id')->all();
    }

    /** Láthatja-e az adott felhasználó az ügyfelet (értesítések címzettjeinek szűréséhez). */
    public static function userSeesClient(int $userId, int $clientId): bool
    {
        $u = DB::table('users')->find($userId);
        return $u && in_array($clientId, self::clientIds($u));
    }

    public static function message(object $u, int $id): object
    {
        $m = DB::table('messages')->where('office_id', $u->office_id)->where('id', $id)->whereIn('client_id', self::clientIds($u))->first();
        abort_if(!$m, 404);
        return $m;
    }

    public static function client(object $u, int $id): object
    {
        $c = DB::table('clients')->where('office_id', $u->office_id)->where('id', $id)->whereIn('id', self::clientIds($u))->first();
        abort_if(!$c, 404);
        return $c;
    }
}

/**
 * Őrfüggvény: minden tárhelyművelet előtt lefut. Nem a hívók jóindulatán múlik.
 * $actor === null → rendszer (ütemező, újrapróbálkozás).
 */
class ConnectorGuard
{
    public static function policy(string $op): array
    {
        $p = config("iratkapu.operations.$op");
        if (!$p) throw new GateException("Ismeretlen művelet: $op");
        return $p;
    }

    /** Élő listázás kapuja: csak kifejezett beállítással, csak embertől, érvényes meghatalmazással. */
    public static function authorizeLiveListing(object $mailbox, ?object $actor): void
    {
        $deny = function (string $why) use ($mailbox, $actor) {
            Audit::log($mailbox->office_id, $actor, "Elutasított élő listázás – $why", ['client_id' => $mailbox->client_id, 'policy' => config('iratkapu.policy_version')]);
            throw new GateException($why, 'blocked');
        };
        if (!config('iratkapu.live_listing')) $deny('Az élő listázás nincs bekapcsolva (IRATKAPU_LIVE_LISTING).');
        if ($actor === null) $deny('Élő listázást rendszer (ütemező, újrapróbálkozás) nem indíthat.');
        if (($au = DB::table('clients')->where('id', $mailbox->client_id)->value('auth_until')) && $au < now()->toDateString()) $deny('A meghatalmazás lejárt ennél az ügyfélnél.');
    }

    /**
     * Élő küldeményletöltés kapuja (ADR-009). A típus letöltési szabálya dönt:
     *  - `csak_lista` típust a program nem tölt le, kézi parancsra sem;
     *  - automatikus letöltés (`$auto` vagy `$rule`) csak akkor megy, ha a DownloadPolicy szerint is automatikus;
     *  - kézi gombnyomásra a `kezi` és az `auto` típus letölthető.
     */
    public static function authorizeLiveDownload(object $mailbox, ?object $actor, object $message, ?object $rule = null, bool $auto = false): void
    {
        $deny = function (string $why) use ($mailbox, $actor, $message) {
            Audit::log($mailbox->office_id, $actor, "Elutasított élő letöltés – $why", ['client_id' => $mailbox->client_id, 'message_id' => $message->id, 'policy' => config('iratkapu.policy_version')]);
            throw new GateException($why, 'blocked');
        };
        if (!config('iratkapu.live_download')) $deny('Az élő letöltés nincs engedélyezve (IRATKAPU_LIVE_DOWNLOAD).');
        if ($actor === null) $deny('Élő letöltést csak bejelentkezett felhasználó vagy az általa indított szinkron végezhet.');
        if (($au = DB::table('clients')->where('id', $mailbox->client_id)->value('auth_until')) && $au < now()->toDateString()) $deny('A meghatalmazás lejárt ennél az ügyfélnél.');
        if (DownloadPolicy::forMessage($message, $mailbox) === DownloadPolicy::CSAK_LISTA) $deny('Ezt az irattípust a program nem tölti le; a hivatalos tárhelyen vehető át.');
        if ($auto || $rule !== null) {
            // A listázás óta megváltozott beállítás a letöltés pillanatában is számít, nem csak a sorba állításkor.
            if ($mailbox->client_id && ($act = DB::table('clients')->where('id', $mailbox->client_id)->value('active')) !== null && !$act) $deny('Az ügyfél inaktív; automatikus letöltés nincs.');
            if ($mailbox->portal_connection_id) {
                $portal = DB::table('portal_connections')->find($mailbox->portal_connection_id);
                if ($portal && !$portal->download_active) $deny('Ennél az Ügyfélkapunál az automatikus letöltés ki van kapcsolva.');
                if ($portal && $mailbox->live_ref && !ClientDiscovery::allows($portal, ClientDiscovery::kindOf((int) $mailbox->office_id, (string) $mailbox->live_ref))) $deny('Ez a rendszer ki van kapcsolva ennél a belépőnél; automatikus letöltés nincs.');
            }
            $decision = DownloadPolicy::autoDecision($message, $mailbox);
            if (!$decision) $deny('Ez az irat nem tölthető le automatikusan: a típusa szerint csak kézi letöltés engedett, vagy már le van töltve.');
            if ($decision['via'] === 'rule' && (!$rule || $rule->id !== $decision['rule']->id)) $deny('Az automatikus letöltés nem a rá érvényes felülíró szabállyal érkezett.');
        }
    }

    public static function authorize(string $op, object $mailbox, ?object $actor, ?int $approvalId = null, ?int $messageId = null): array
    {
        $p = self::policy($op);
        $deny = function (string $why, string $kind = 'gate') use ($op, $mailbox, $actor, $messageId, $p) {
            Audit::log($mailbox->office_id, $actor, "Elutasított tárhelyművelet: $op – $why", ['client_id' => $mailbox->client_id, 'message_id' => $messageId, 'policy' => config('iratkapu.policy_version'), 'evidence' => $p['evidence']]);
            throw new GateException($why, $kind);
        };
        if ($p['live'] === 'TILTOTT') $deny('Ez a művelet a termékben nem érhető el.', 'forbidden');
        if (!$p['auto'] && $actor === null) $deny('Joghatású lehet: rendszer (ütemező, újrapróbálkozás) nem indíthatja.');
        $client = DB::table('clients')->find($mailbox->client_id);
        if ($client->auth_until && $client->auth_until < now()->toDateString()) $deny('A meghatalmazás lejárt ennél az ügyfélnél.');
        if ($p['approval']) {
            $a = $approvalId ? DB::table('approvals')->find($approvalId) : null;
            if (!$a || $a->status !== 'approved' || $a->operation !== $op || $a->message_id !== $messageId || $a->office_id !== $mailbox->office_id)
                $deny('Érvényes, erre az iratra és műveletre szóló jóváhagyás nélkül nem indítható.');
            if ($a->requested_by === $a->decided_by) $deny('A kérelmező nem hagyhatja jóvá a saját kérését.');
        }
        if (config('iratkapu.mode') !== 'demo') $deny("Élő tárhelyen ez a művelet zárolt ({$p['live']}): {$p['evidence']}", 'blocked');
        Audit::log($mailbox->office_id, $actor, "Tárhelyművelet indul: $op (demó-csatlakozó)", ['client_id' => $mailbox->client_id, 'message_id' => $messageId, 'policy' => config('iratkapu.policy_version'), 'evidence' => $approvalId ? "jóváhagyás #$approvalId" : null]);
        return $p;
    }
}

/** Beépített minta-csatlakozó. Valódi tárhelyet nem ér el; determinisztikus mintaküldeményeket ad. */
class DemoConnector
{
    const POOL = [
        ['NAV', 'Nemzeti Adó- és Vámhivatal', 'Elfogadó nyugta – 2665 bevallás', 'nav.nyugta.elfogado', 'NAV elfogadó nyugta', 'na', 0],
        ['NAV', 'Nemzeti Adó- és Vámhivatal', 'Felszólítás hiánypótlásra – adóigazolás', 'nav-hianypotlas', 'NAV hiánypótlási felhívás', 'wait', 1],
        ['ÖNK', 'Önkormányzati Adóhatóság', 'Helyi iparűzési adó – egyenlegközlő', 'onk-egyenlegkozlo', 'HIPA egyenlegközlő', 'wait', 0],
        ['CÉGB', 'Törvényszék Cégbírósága', 'Végzés hiánypótlásra', 'cegbirosag-vegzes', 'Cégbíróság végzés', 'wait', 1],
        ['ISM', 'Ismeretlen feladó (EKEIDR)', 'Tájékoztatás ügyirat érkezéséről', 'ismeretlen', 'Ismeretlen típus', 'wait', 1],
        ['KSH', 'Központi Statisztikai Hivatal', 'Értesítés adatszolgáltatási kötelezettségről', 'ksh-ertesites', 'KSH értesítés', 'na', 0],
        // típus nélkül érkező tételek: a taxonómia ismeri fel a tárgy alapján (gépi becslés)
        ['NAV', 'Nemzeti Adó- és Vámhivatal', 'NAV - Átvezetés végzés', null, null, 'wait', 1],
        ['MVM', 'MVM Next Energiakereskedelmi Zrt.', 'MVM Next - Fizetési felszólító', null, null, 'wait', 0],
        ['NAV', 'Nemzeti Adó- és Vámhivatal', 'NAV adóalany - I. fokú határozat', null, null, 'wait', 1],
    ];

    /** A tárhely teljes aktuális listája: a már ismert tételek + legfeljebb egy új. */
    public function listMessages(object $mailbox, bool $advance = true): array
    {
        $known = DB::table('messages')->where('mailbox_id', $mailbox->id)->get()->map(fn ($m) => [
            'source_id' => $m->source_id, 'sender' => $m->sender, 'sender_full' => $m->sender_full, 'subject' => $m->subject,
            'type_id' => $m->type_id, 'type_label' => $m->type_label, 'official' => $m->official, 'es3' => (bool) $m->es3, 'arrived_at' => $m->arrived_at,
        ])->all();
        // Nem minden listázás hoz új küldeményt: kb. minden negyedik futás, tárhelyenként eltolva.
        if ($advance) DB::table('mailboxes')->where('id', $mailbox->id)->increment('demo_cursor');
        if ($advance && ($mailbox->id + $mailbox->demo_cursor) % 4 === 0) {
            $i = $mailbox->demo_cursor; $p = self::POOL[($mailbox->id + $i) % count(self::POOL)];
            $known[] = ['source_id' => "demo-{$mailbox->id}-$i", 'sender' => $p[0], 'sender_full' => $p[1], 'subject' => $p[2],
                'type_id' => $p[3], 'type_label' => $p[4], 'official' => $p[5], 'es3' => (bool) $p[6], 'arrived_at' => now()->format('Y-m-d H:i:s')];
        }
        return $known;
    }

    /** Mintairat: szintetikus es3 vagy PDF. Valódi hatósági tartalom nincs benne. */
    public function download(object $message): array
    {
        $pdf = Samples::pdf("{$message->sender_full}\n{$message->subject}\nMintairat a demó-csatlakozóból.");
        if ($message->es3) return ['name' => "irat-{$message->id}.es3", 'bytes' => SignatureCheck::signSample(Samples::es3($message->subject, ['irat.pdf' => $pdf, 'kisero.xml' => '<?xml version="1.0"?><kisero><targy>minta</targy></kisero>']))];
        return ['name' => "irat-{$message->id}.pdf", 'bytes' => $pdf];
    }
}

class Samples
{
    public static function pdf(string $text): string
    {
        $lines = array_map(fn ($l) => '(' . strtr(\Illuminate\Support\Str::ascii($l), ['(' => '\(', ')' => '\)', '\\' => '']) . ') Tj 0 -22 Td', explode("\n", $text));
        $stream = "BT /F1 14 Tf 60 760 Td " . implode(' ', $lines) . " ET";
        $objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            "<< /Length " . strlen($stream) . " >>\nstream\n$stream\nendstream", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
        $out = "%PDF-1.4\n"; $off = [];
        foreach ($objs as $i => $o) { $off[] = strlen($out); $out .= ($i + 1) . " 0 obj\n$o\nendobj\n"; }
        $x = strlen($out); $out .= "xref\n0 6\n0000000000 65535 f \n";
        foreach ($off as $o) $out .= sprintf("%010d 00000 n \n", $o);
        return $out . "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n$x\n%%EOF\n";
    }

    /** Szintetikus e-akta a nyilvános specifikáció szerkezete alapján (research/R04). Aláírás nincs benne. */
    public static function es3(string $title, array $docs, string $ns = 'https://www.microsec.hu/ds/e-szigno30#'): string
    {
        $x = '<?xml version="1.0" encoding="UTF-8"?>' . "\n" . '<es:Dossier xmlns:es="' . $ns . '" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">'
            . '<es:DossierProfile><es:Title>' . htmlspecialchars($title, ENT_XML1) . '</es:Title><es:CreationDate>' . now()->toIso8601String() . '</es:CreationDate></es:DossierProfile><es:Documents>';
        foreach ($docs as $name => $bytes)
            $x .= '<es:Document><es:DocumentProfile><es:Title>' . htmlspecialchars($name, ENT_XML1) . '</es:Title><es:BaseTransform><es:Transform Algorithm="base64"/></es:BaseTransform></es:DocumentProfile><ds:Object>' . base64_encode($bytes) . '</ds:Object></es:Document>';
        return $x . '</es:Documents></es:Dossier>';
    }
}
