<?php
namespace App\Iratkapu;

use Illuminate\Support\Facades\DB;

/**
 * Automatikus ügyfél-felderítés az élő postafiók-listából.
 * A program nem talál ki ügyfelet: csak akkor vesz fel vagy köt össze, ha a postafiók nevéből
 * pontosan egy 8 jegyű adószám-törzs olvasható ki. Minden más a „Besorolásra vár” listába kerül.
 */
final class ClientDiscovery
{
    public const BASIS = 'Cégkapu-ügykezelő (felderítve)';
    /** A belépőn ki-be kapcsolható állami rendszerek. */
    public const SYSTEMS = ['tarhely_cegkapu', 'tarhely_personal', 'tarhely_hivatali', 'upo'];
    private const KIND_OF_TYPE = ['CK' => 'cegkapu', 'ÜK' => 'personal', 'HK' => 'hivatali'];
    /** A tárhely saját típuskódjai (élő próba, 2026-11-12). A Hivatali kapu kódját élőben még nem láttuk: ismeretlen kódnál nem találgatunk. */
    private const KIND_OF_CODE = ['AP' => 'personal', 'CKP' => 'cegkapu'];

    /** A belépőn engedélyezett rendszerek; üres beállítás = mind. */
    public static function systemsOf(?object $portal): array
    {
        $set = $portal && $portal->enabled_systems ? json_decode($portal->enabled_systems, true) : null;
        return is_array($set) ? array_values(array_intersect(self::SYSTEMS, $set)) : self::SYSTEMS;
    }

    /**
     * Az élő postafiók fajtája: ha már tárhelyhez van rendelve, a tárhely típusa dönt; különben az érvényes
     * adószámos név Cégkapu. Minden más ismeretlen – a program nem találgat a névből.
     *
     * @return 'cegkapu'|'personal'|'hivatali'|'unknown'
     */
    public static function kindOf(int $office, string $liveRef, ?string $typeCode = null): string
    {
        $type = DB::table('mailboxes')->where('office_id', $office)->where('live_ref', $liveRef)->value('type');
        if ($type !== null) {
            return self::KIND_OF_TYPE[$type] ?? 'unknown';
        }
        if ($typeCode !== null) { // a tárhely megmondta a típust: azt követjük, ismeretlen kódnál nem találgatunk a névből
            return self::KIND_OF_CODE[$typeCode] ?? 'unknown';
        }
        return self::parseMailboxName($liveRef)['valid'] ? 'cegkapu' : 'unknown';
    }

    /** Átmehet-e az adott fajtájú postafiók (vagy az `upo`) ezen a belépőn. Ismeretlen fajta csak akkor, ha mindhárom tárhely-rendszer engedélyezett. */
    public static function allows(?object $portal, string $kind): bool
    {
        $on = self::systemsOf($portal);
        if ($kind === 'upo') {
            return in_array('upo', $on, true);
        }
        if ($kind === 'unknown') {
            return count(array_intersect(['tarhely_cegkapu', 'tarhely_personal', 'tarhely_hivatali'], $on)) === 3;
        }
        return in_array("tarhely_$kind", $on, true);
    }

    /** Idegen eredetű szöveg tisztítása: címkék és vezérlőkarakterek nélkül, legfeljebb 120 karakter. */
    public static function clean(string $s, int $max = 120): string
    {
        $s = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', strip_tags($s)) ?? '';
        return mb_substr(trim(preg_replace('/\s+/u', ' ', $s) ?? ''), 0, $max);
    }

    /**
     * Postafióknév értelmezése.
     *
     * A `valid` azt jelzi, hogy a kiolvasott szám érvényes adószám-e (ellenőrző jegy, áfakód). Érvénytelen számból
     * (telefonszám, dátum) a program nem vesz fel ügyfelet; meglévő ügyfélhez az egyezés ettől még elég.
     *
     * @return array{tax8: ?string, tax: ?string, name: ?string, valid: bool}
     */
    public static function parseMailboxName(string $name): array
    {
        $raw = self::clean($name, 400); // a számot a teljes névben keressük, a nevet a végén vágjuk 120-ra
        $stems = [];
        // Teljes adószám (12345678-2-41 vagy 12345678241), majd a magában álló 8 jegyű törzs.
        $rest = preg_replace_callback('/(?<!\d)(\d{8})-?(\d)-?(\d{2})(?!\d)/', function ($m) use (&$stems) {
            $stems[$m[1]] = "{$m[1]}-{$m[2]}-{$m[3]}";
            return ' ';
        }, $raw);
        $rest = preg_replace_callback('/(?<!\d)(\d{8})(?!\d)/', function ($m) use (&$stems) {
            $stems[$m[1]] ??= $m[1];
            return ' ';
        }, $rest);
        if (count($stems) !== 1) {
            return ['tax8' => null, 'tax' => null, 'name' => $raw !== '' ? mb_substr($raw, 0, 120) : null, 'valid' => false];
        }
        $label = trim(preg_replace('/\s+/u', ' ', preg_replace('/\(\s*\)/u', ' ', $rest)), " \t-–,;:");
        if (preg_match('/^\((.*)\)$/u', $label, $m)) {
            $label = trim($m[1]);
        }
        $tax8 = (string) array_key_first($stems);
        return ['tax8' => $tax8, 'tax' => $stems[$tax8], 'name' => mb_substr($label, 0, 120) ?: null, 'valid' => self::validTax($stems[$tax8])];
    }

    /** Érvényes-e az adószám: a törzs 8. jegye ellenőrző jegy (9,7,3,1,9,7,3 súlyokkal), a teljes alakban az áfakód 1–5. */
    public static function validTax(string $tax): bool
    {
        if (!preg_match('/^(\d{8})(?:-(\d)-(\d{2}))?$/', $tax, $m)) {
            return false;
        }
        $sum = 0;
        foreach ([9, 7, 3, 1, 9, 7, 3] as $i => $w) {
            $sum += $w * (int) $m[1][$i];
        }
        if ((10 - $sum % 10) % 10 !== (int) $m[1][7]) {
            return false;
        }
        return !isset($m[2]) || ((int) $m[2] >= 1 && (int) $m[2] <= 5);
    }

    /** Vezető és admin bármelyik belépővel felderíthet; más csak a saját belépőjével. */
    public static function canDiscover(object $user, ?object $portal): bool
    {
        return Scope::seesAll($user) || ($portal && (int) $portal->owner_user_id === (int) $user->id);
    }

    /**
     * @param  array<string, int>  $names  postafióknév => levélszám
     * @param  array<string, array{display: ?string, type: ?string, default: bool}>  $meta  a tárhely postafiók-listájából: megjelenített név, típuskód, a belépő saját (alapértelmezett) postafiókja-e
     * @return array{created: int, attached: int, pending: int, own: int}
     */
    public static function discover(object $user, ?object $portal, array $names, array $meta = []): array
    {
        if (!self::canDiscover($user, $portal)) {
            return ['created' => 0, 'attached' => 0, 'pending' => 0, 'own' => 0];
        }
        // Egy tranzakcióban: ha egy párhuzamos szinkron ugyanazt a postafiókot közben felvette (egyedi index), semmi nem marad félkészen.
        try {
            return DB::transaction(fn () => self::discoverNow($user, $portal, $names, $meta));
        } catch (\Illuminate\Database\UniqueConstraintViolationException) {
            return DB::transaction(fn () => self::discoverNow($user, $portal, $names, $meta)); // a másik szinkron nyert; újrafuttatva már ismertnek látjuk
        }
    }

    private static function discoverNow(object $user, ?object $portal, array $names, array $meta): array
    {
        $out = ['created' => 0, 'attached' => 0, 'pending' => 0, 'own' => 0];
        $office = (int) $user->office_id;
        $visible = array_flip(Scope::clientIds($user));
        // Az egész irodában keresünk; az adóazonosító jellel felvett magánszemély és a saját gyűjtő kimarad.
        $byTax8 = DB::table('clients')->where('office_id', $office)->get()
            ->reject(fn ($c) => preg_match('/^8\d{9}$/', (string) $c->tax) || $c->discovered_via === 'own')
            ->keyBy(fn ($c) => substr(preg_replace('/\D/', '', (string) $c->tax), 0, 8));

        foreach ($names as $liveRef => $count) {
            $liveRef = (string) $liveRef;
            if (DB::table('mailboxes')->where('office_id', $office)->where('live_ref', $liveRef)->exists()) {
                self::settle($office, $liveRef); // más szinkronja vagy kézi hozzárendelés közben gazdát adott neki
                continue;
            }
            $p = self::parseMailboxName($liveRef);
            $m = $meta[$liveRef] ?? ['display' => null, 'type' => null, 'default' => false];
            // A valódi tárhelyen a Cégkapu neve csak az adószám-törzs; a cég neve külön mezőben jön.
            // Ha a tárhely megjelenített nevet is adott, az a beszédesebb, amikor a kulcsból nem olvasható ki név.
            if ($m['display'] && ($p['name'] === null || $p['tax8'] === null)) $p['name'] = self::clean($m['display']);
            // A tárhely saját Cégkapu-jelölése hitelesebb, mint az ellenőrző jegy: ha a típus Cégkapu és a név nyolc számjegy, elfogadjuk.
            if ($m['type'] === 'CKP' && preg_match('/^\d{8}$/', $liveRef)) $p['valid'] = true;
            // A belépő saját értesítési tárhelye: magától gyűjtőt kap, amelyet csak a belépő gazdája lát.
            if ($m['type'] === 'AP') {
                if ($m['default'] && $portal && $portal->owner_user_id) {
                    self::newMailbox(self::ownCollector($user, $portal), $portal, $liveRef, 'ÜK');
                    self::settle($office, $liveRef);
                    $out['own']++;
                } elseif (self::remember($office, $portal, $liveRef, $p, (int) $count, $m['type'])) {
                    $out['pending']++; // más személyes tárhelye, vagy a belépőnek nincs gazdája: ember dönt
                }
                continue;
            }
            $client = $p['tax8'] !== null ? ($byTax8[$p['tax8']] ?? null) : null;

            if ($client && isset($visible[$client->id])) {
                self::attach($user, $portal, $client, $liveRef);
                self::settle($office, $liveRef);
                $out['attached']++;
                continue;
            }
            if (!$client && $p['valid'] && $portal && $portal->auto_create_clients) {
                $byTax8[$p['tax8']] = self::create($user, $portal, $p, $liveRef);
                $visible[$byTax8[$p['tax8']]->id] = true;
                self::settle($office, $liveRef);
                $out['created']++;
                continue;
            }
            if (self::remember($office, $portal, $liveRef, $p, (int) $count, $m['type'])) {
                $out['pending']++;
            }
        }
        return $out;
    }

    /** Meglévő ügyfél: a szabad postafiókjához köti (Cégkapu előnyben), ha nincs szabad, újat hoz létre. */
    public static function attach(object $user, ?object $portal, object $client, string $liveRef, string $type = 'CK'): int
    {
        $free = DB::table('mailboxes')->where('client_id', $client->id)->whereNull('live_ref')->orderByRaw("CASE WHEN type='CK' THEN 0 ELSE 1 END")->first();
        if ($free) {
            DB::table('mailboxes')->where('id', $free->id)->update(['live_ref' => $liveRef, 'portal_connection_id' => $portal->id ?? $free->portal_connection_id, 'updated_at' => now()]);
            $id = $free->id;
        } else {
            $id = self::newMailbox($client, $portal, $liveRef, $type);
        }
        Audit::log($client->office_id, $user, 'Élő postafiók automatikusan hozzárendelve adószám alapján: ' . self::clean($liveRef), ['client_id' => $client->id]);
        return (int) $id;
    }

    /** A belépő „Saját tárhely” gyűjtője: csak a belépő gazdája látja (Scope::clientIds). */
    /** Cégformára utaló szavak a névben: ezekből tudjuk, hogy vállalkozás (és nem egyéni vállalkozó) áll az adószám mögött. */
    private const LEGAL_FORM = '/(?<![\\pL])([\\pL]*társaság|kft|bt|zrt|nyrt|kkt|rt|kht|nonprofit|egyesület|alapítvány|szövetkezet|önkormányzat|társasház|iroda|egyesülés|szövetség|egyház|plébánia|intézet|hivatal|kkv|ltd|gmbh|inc)(?![\\pL])/iu';

    /**
     * A NAV tárgysorának eleje: „azonosító - NÉV - tárgy”. Visszaadja az azonosítót (adóazonosító jel vagy adószám-törzs),
     * a nevet és a becsült fajtát. Csak a tárgy ELEJÉN álló azonosítót fogadjuk el, hogy egy szövegben szereplő szám ne
     * váljon ajánlattá. A fajta becslés: adóazonosító jel → magánszemély; adószám cégformával a névben → vállalkozás;
     * adószám cégforma nélkül → egyéni vállalkozó.
     *
     * @return ?array{identifier: string, name: string, kind: 'business'|'sole'|'person'}
     */
    public static function parseSubjectParty(string $subject): ?array
    {
        if (!preg_match('/^\s*(8\d{9}|\d{8})(?:-\d-\d{2})?\s+-\s+(.+)$/u', $subject, $m)) return null;
        $name = trim(preg_split('/\s+-\s+/u', $m[2])[0]);
        if (!preg_match('/^[\pL][\pL\pN .,&\'"-]{2,119}$/u', $name) || preg_match_all('/\pL/u', $name) < 3) return null;
        // Csupa nagybetűs szavak (ahogy a NAV írja a neveket) olvasható alakra; a vegyes írásmódú szavakhoz nem nyúlunk.
        $name = preg_replace_callback('/[\pL]{2,}/u', fn ($w) => mb_strtoupper($w[0]) === $w[0] ? mb_convert_case($w[0], MB_CASE_TITLE, 'UTF-8') : $w[0], $name);
        $kind = strlen($m[1]) === 10 ? 'person' : (preg_match(self::LEGAL_FORM, $name) ? 'business' : 'sole');
        return ['identifier' => $m[1], 'name' => self::clean($name), 'kind' => $kind];
    }

    /** A belépő beállítása szerint feldolgozható-e az adott fajta: 'business' = csak vállalkozások, 'all' = egyéni vállalkozók és magánszemélyek is. */
    public static function scopeAllows(?object $portal, string $kind): bool
    {
        return $kind === 'business' || ($portal->subject_scope ?? 'all') !== 'business';
    }

    public static function ownCollector(object $user, object $portal): object
    {
        $tax = "sajat-{$portal->id}";
        $c = DB::table('clients')->where('office_id', $portal->office_id)->where('tax', $tax)->first();
        if (!$c) {
            $id = DB::table('clients')->insertGetId([
                'office_id' => $portal->office_id, 'name' => self::clean("Saját tárhely – {$portal->name}"), 'tax' => $tax, 'auth_until' => null,
                'auth_basis' => 'Saját értesítési tárhely', 'active' => true, 'discovered_via' => 'own', 'portal_connection_id' => $portal->id,
                'owner_user_id' => $portal->owner_user_id ?: $user->id,
                'created_at' => now(), 'updated_at' => now(),
            ]);
            DB::table('client_user')->insertOrIgnore(['client_id' => $id, 'user_id' => $portal->owner_user_id ?: $user->id]);
            $c = DB::table('clients')->find($id);
        }
        return $c;
    }

    public static function newMailbox(object $client, ?object $portal, string $liveRef, string $type): int
    {
        return (int) DB::table('mailboxes')->insertGetId([
            'office_id' => $client->office_id, 'client_id' => $client->id, 'type' => $type, 'credential_ref' => 'os-vault://iratkapu/mailbox-pending',
            'live_ref' => $liveRef, 'portal_connection_id' => $portal->id ?? null, 'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    /** Új ügyfél a belépő mögött talált Cégkapuból. A meghatalmazást a program nem ellenőrizte. */
    private static function create(object $user, object $portal, array $p, string $liveRef): object
    {
        $id = DB::table('clients')->insertGetId([
            'office_id' => $user->office_id, 'name' => $p['name'] ?: "Felderített ügyfél {$p['tax8']}", 'tax' => $p['tax'],
            'auth_until' => null, 'auth_basis' => self::BASIS, 'active' => OfficeMail::office((int) $user->office_id)['defaultActive']['cegkapu'], 'discovered_via' => 'cegkapu',
            'portal_connection_id' => $portal->id, 'created_at' => now(), 'updated_at' => now(),
        ]);
        $client = DB::table('clients')->find($id);
        self::newMailbox($client, $portal, $liveRef, 'CK');
        // A belépő gazdája lássa, amit a saját belépője talált.
        foreach (array_unique(array_filter([$portal->owner_user_id, Scope::seesAll($user) ? null : $user->id])) as $uid) {
            DB::table('client_user')->insertOrIgnore(['client_id' => $id, 'user_id' => $uid]);
        }
        Audit::log($user->office_id, $user, "Ügyfél automatikusan felvéve élő Cégkapu alapján: {$client->name} ({$p['tax8']})", [
            'client_id' => $id, 'evidence' => 'postafiók: ' . self::clean($liveRef) . ', belépő: ' . self::clean((string) $portal->name), 'policy' => 'a meghatalmazást a program nem ellenőrizte',
        ]);
        return $client;
    }

    /** A postafióknak már van tárhelye: a hozzá tartozó függő sor lezárul. */
    public static function settle(int $office, string $liveRef): void
    {
        DB::table('discovered_mailboxes')->where('office_id', $office)->where('live_ref', $liveRef)->where('state', 'pending')->update(['state' => 'assigned', 'updated_at' => now()]);
    }

    /** „Besorolásra vár” sor létrehozása vagy frissítése. A kihagyott sor nem nyílik újra. Igaz, ha a sor függőben van. */
    private static function remember(int $office, ?object $portal, string $liveRef, array $p, int $count, ?string $typeCode = null): bool
    {
        $row = DB::table('discovered_mailboxes')->where('office_id', $office)->where('live_ref', $liveRef)->first();
        if ($row && $row->state === 'ignored') {
            return false;
        }
        $data = ['portal_connection_id' => $portal->id ?? ($row->portal_connection_id ?? null), 'tax8' => $p['tax8'], 'parsed_name' => $p['name'], 'type_code' => $typeCode ?? ($row->type_code ?? null),
            'state' => 'pending', 'letters' => $count, 'last_seen_at' => now(), 'updated_at' => now()];
        if ($row) {
            DB::table('discovered_mailboxes')->where('id', $row->id)->update($data);
        } else {
            DB::table('discovered_mailboxes')->insert($data + ['office_id' => $office, 'live_ref' => $liveRef, 'created_at' => now()]);
        }
        return true;
    }
}
