<?php
namespace Database\Seeders;

use App\Iratkapu\{Audit, DemoConnector, Documents, Notify};
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\{DB, Hash};

/** Kitalált mintaadatok a demóhoz. Egyetlen valós személy, cég vagy irat sincs benne. */
class DatabaseSeeder extends Seeder
{
    // Demó-jelszó minden mintafelhasználóhoz. Csak helyi kipróbálásra.
    const DEMO_PASSWORD = 'iratkapu-demo';

    public function run(): void
    {
        $ts = ['created_at' => now(), 'updated_at' => now()];
        // Irattípus-taxonómia. Az átvételi kockázat és a prioritás becslés, nem hiteles szabály.
        // A `mintak` oszlop saját megfogalmazású, pontosvesszővel tagolt illesztési kulcsszavakat tartalmaz.
        $types = [];
        $fh = fopen(database_path('data/dokumentumtipus-taxonomia-v0.csv'), 'r'); $head = fgetcsv($fh);
        while (($row = fgetcsv($fh)) !== false) { $x = array_combine($head, $row); $ld = trim($x['joghataly_nap'] ?? '') !== '' ? (int) $x['joghataly_nap'] : null;
            $types[$x['type_id']] = ['type_id' => $x['type_id'], 'label' => $x['type_cimke'], 'group' => $x['csoport'], 'priority' => $x['javasolt_alap_prioritas'], 'risk' => $x['atveteli_kockazat_becsles'], 'version' => $x['taxonomia_verzio'], 'download_policy' => $x['letoltesi_szabaly'],
                'default_legal_days' => $ld, 'patterns' => array_values(array_filter(array_map('trim', explode(';', $x['mintak'])))), 'legal_marked' => $ld !== null]; }
        fclose($fh);
        foreach ($types as $t) DB::table('document_types')->insert(['patterns' => json_encode($t['patterns'], JSON_UNESCAPED_UNICODE)] + $t);
        \App\Iratkapu\Taxonomy::flush();
        \App\Iratkapu\DownloadPolicy::flush();
        \App\Iratkapu\TypeSettings::flush();
        $o = DB::table('offices')->insertGetId(['name' => 'Lakatos és Társa Könyvelőiroda', 'settings' => json_encode(['reminders' => [5, 2, 1]])] + $ts);
        $o2 = DB::table('offices')->insertGetId(['name' => 'Másik Iroda Kft. (elszigetelés-próba)', 'settings' => '{}'] + $ts);
        $U = [];
        foreach ([['SN', 'Szalai Nóra', 'vezeto'], ['LG', 'Lakatos Gergő', 'konyvelo'], ['BT', 'Bodnár Tímea', 'konyvelo'], ['VA', 'Varró Ádám', 'konyvelo'], ['IA', 'Iroda Admin', 'admin']] as [$k, $n, $r])
            $U[$k] = DB::table('users')->insertGetId(['name' => $n, 'email' => strtolower($k) . '@iratkapu.test', 'password' => Hash::make(self::DEMO_PASSWORD), 'office_id' => $o, 'role' => $r, 'initials' => $k] + $ts);
        $other = DB::table('users')->insertGetId(['name' => 'Külső Kata', 'email' => 'kk@masik.test', 'password' => Hash::make(self::DEMO_PASSWORD), 'office_id' => $o2, 'role' => 'admin', 'initials' => 'KK'] + $ts);

        $clients = [
            1 => ['Borostyán Pékség Kft.', '24817365-2-13', ['CK', 'ÜK'], 140, ['LG']],
            2 => ['Tiszavirág Dental Bt.', '21094478-1-06', ['CK'], 65, ['BT']],
            3 => ['Hegyalja Gépész Kft.', '13566802-2-05', ['CK', 'ÜK'], 50, ['LG']],
            4 => ['Kovácsné Sipos Anna e.v.', '68412209-1-33', ['ÜK'], 230, ['LG', 'BT']],
            5 => ['Délibáb Logisztika Zrt.', '11873340-2-09', ['CK', 'HK'], 109, ['LG', 'VA']],
            6 => ['Ökörszem Stúdió Kft.', '27730915-2-41', ['CK'], 200, ['BT']],
            7 => ['Rétköz Agrár Szövetkezet', '10455721-2-15', ['CK'], 19, ['VA']],
            8 => ['Fazekas Márton e.v.', '55120876-1-27', ['ÜK'], 170, ['LG']],
            9 => ['Zöldkapu Ingatlan Kft.', '26019934-2-42', ['CK'], 290, ['VA']],
            10 => ['Napfonat Textil Kft.', '14302258-2-02', ['CK', 'ÜK'], 140, ['LG']],
        ];
        $C = []; $B = [];
        foreach ($clients as $i => [$n, $tax, $boxes, $days, $users]) {
            $C[$i] = DB::table('clients')->insertGetId(['office_id' => $o, 'name' => $n, 'tax' => $tax, 'auth_until' => now()->addDays($days)->toDateString()] + $ts);
            foreach ($users as $k) DB::table('client_user')->insert(['client_id' => $C[$i], 'user_id' => $U[$k]]);
            if ($i !== 8) DB::table('client_contacts')->insert(['office_id' => $o, 'client_id' => $C[$i], 'name' => 'Minta Ügyvezető ' . $i, 'email' => "ugyvezeto$i@pelda.test", 'role' => 'ügyvezető']); // a 8. ügyfélnek szándékosan nincs címe
            foreach ($boxes as $b) $B["$i$b"] = DB::table('mailboxes')->insertGetId(['office_id' => $o, 'client_id' => $C[$i], 'type' => $b, 'credential_ref' => "os-vault://iratkapu/mailbox-$i-$b",
                'sync_state' => $i === 3 ? 'need' : ($i === 7 ? 'part' : 'ok'), 'sync_note' => $i === 3 ? 'Lejárt a hitelesítés' : ($i === 7 ? '2 küldemény adatai nem jöttek le' : 'Nincs új küldemény'),
                'last_ok_at' => $i === 3 ? now()->subDays(2)->setTime(17, 20) : now()->subMinutes(20), 'demo_cursor' => 0] + $ts);
        }
        $c2 = DB::table('clients')->insertGetId(['office_id' => $o2, 'name' => 'Idegen Ügyfél Bt.', 'tax' => '99999999-1-01', 'auth_until' => now()->addYear()->toDateString()] + $ts);
        $b2 = DB::table('mailboxes')->insertGetId(['office_id' => $o2, 'client_id' => $c2, 'type' => 'CK', 'sync_state' => 'ok'] + $ts);
        DB::table('messages')->insert(['office_id' => $o2, 'client_id' => $c2, 'mailbox_id' => $b2, 'source_id' => 'x-1', 'sender' => 'NAV', 'sender_full' => 'Nemzeti Adó- és Vámhivatal', 'subject' => 'Másik iroda titkos irata', 'type_label' => 'NAV határozat', 'arrived_at' => now()] + $ts);

        $at = fn (int $d, string $t) => now()->subDays($d)->setTimeFromTimeString($t);
        $dl = fn (?int $d) => $d === null ? null : now()->addDays($d)->toDateString();
        $NAV = 'Nemzeti Adó- és Vámhivatal';
        // [ügyfél, tárhely, feladó, feladó teljes, tárgy, type_id, típus, nap, idő, hivatalos, belső, felelős, sürgős, határidő nap, biztos, es3, extra]
        $M = [
            [1, 'CK', 'NAV', $NAV, 'Fizetési felszólítás – általános forgalmi adó', 'nav-felszolitas', 'NAV fizetési felszólítás', 0, '08:14', 'wait', 'uj', null, 1, null, 0, 1, []],
            [5, 'CK', 'NAV', $NAV, 'Végzés hiánypótlásra – 2665 bevallás', 'nav-hianypotlas', 'NAV hiánypótlási felhívás', 0, '07:52', 'ok', 'kiosztott', 'LG', 1, 8, 1, 1, ['by' => 'SN']],
            [2, 'CK', 'CÉGB', 'Szegedi Törvényszék Cégbírósága', 'Végzés változásbejegyzési kérelem tárgyában', 'cegbirosag-vegzes', 'Cégbíróság végzés', 0, '07:20', 'wait', 'uj', null, 0, null, 0, 1, []],
            [4, 'ÜK', 'NAV', $NAV, 'Elfogadó nyugta – 2658 bevallás', 'nav.nyugta.elfogado', 'NAV elfogadó nyugta', 0, '06:58', 'na', 'kesz', null, 0, null, 0, 0, ['receipt' => 1, 'read' => 1]],
            [6, 'CK', 'ÖNK', 'Budapest Főváros XI. kerület Önkormányzata', 'Helyi iparűzési adó – egyenlegközlő', 'onk-egyenlegkozlo', 'HIPA egyenlegközlő', 0, '06:31', 'ok', 'folyamatban', 'BT', 0, 0, 1, 0, ['by' => 'BT', 'read' => 1]],
            [9, 'CK', 'ISM', 'Ismeretlen feladó (EKEIDR-4471)', 'Tájékoztatás ügyirat érkezéséről', 'ismeretlen', 'Ismeretlen típus', 0, '05:47', 'wait', 'oszt', null, 0, null, 0, 1, ['unknown' => 1]],
            [7, 'CK', 'NAV', $NAV, 'Értesítés adóellenőrzés megkezdéséről', 'nav-ellenorzes', 'NAV ellenőrzési értesítés', 1, '15:22', 'ok', 'ell', 'VA', 1, 7, 0, 1, ['by' => 'SN', 'ai' => 1, 'read' => 1]],
            [10, 'CK', 'MÁK', 'Magyar Államkincstár', 'Tájékoztatás támogatási kérelem befogadásáról', 'mak-kuldemeny', 'MÁK elektronikus küldemény', 1, '13:40', 'ok', 'kiosztott', 'LG', 0, null, 0, 0, ['by' => 'LG', 'read' => 1]],
            [3, 'CK', 'NAV', $NAV, 'Határozat késedelmi pótlék megállapításáról', 'nav-hatarozat', 'NAV határozat', 2, '16:48', 'wait', 'uj', null, 1, null, 0, 1, []],
            [8, 'ÜK', 'NAV', $NAV, 'Felszólítás bevallás benyújtására – 2558', 'nav-felszolitas', 'Felszólítás bevallásra', 1, '11:05', 'fic', 'kiosztott', 'LG', 1, 6, 0, 1, ['read' => 1]],
            [1, 'ÜK', 'KH', 'Pest Vármegyei Kormányhivatal', 'Nyugta beadvány érkeztetéséről', 'kormanyhivatal-nyugta', 'Kormányhivatal – nyugta', 1, '10:12', 'na', 'kesz', null, 0, null, 0, 0, ['receipt' => 1, 'read' => 1]],
            [5, 'HK', 'BÍR', 'Kecskeméti Törvényszék', 'Idézés tárgyalásra – G.40.118', 'birosag', 'Bíróság (OBH)', 1, '09:30', 'ok', 'folyamatban', 'VA', 0, 21, 1, 1, ['by' => 'SN', 'read' => 1]],
            [6, 'CK', 'NAV', $NAV, 'Elfogadó nyugta – 2665 bevallás', 'nav.nyugta.elfogado', 'NAV elfogadó nyugta', 1, '08:02', 'na', 'kesz', null, 0, null, 0, 0, ['receipt' => 1, 'read' => 1]],
            [2, 'CK', 'NAV', $NAV, 'Elutasító nyugta – 2608 bevallás, hibás adószám', 'nav.nyugta.elutasito', 'NAV elutasító nyugta', 2, '14:37', 'na', 'kiosztott', 'BT', 1, null, 0, 0, ['read' => 1]],
            [10, 'ÜK', 'KSH', 'Központi Statisztikai Hivatal', 'Felszólítás adatszolgáltatás pótlására – OSAP 2237', 'ksh-felszolitas', 'KSH felszólítás', 2, '12:10', 'ok', 'folyamatban', 'LG', 0, 2, 0, 0, ['by' => 'LG', 'ai' => 1, 'read' => 1]],
            [7, 'CK', 'KAM', 'Nemzeti Agrárgazdasági Kamara', 'Tagdíjbevallási időszak megnyitása', 'kamara-tajekoztato', 'Kamarai tájékoztató', 2, '09:15', 'na', 'kesz', null, 0, null, 0, 0, ['read' => 1]],
            [4, 'ÜK', 'ÖNK', 'Érd Megyei Jogú Város Önkormányzata', 'Határozat gépjárműadó-mentesség tárgyában', 'onk-hatarozat', 'Önkormányzati határozat', 5, '14:26', 'ok', 'kesz', 'BT', 0, null, 0, 1, ['by' => 'BT', 'read' => 1]],
            [9, 'CK', 'VH', 'Dr. Halmos Végrehajtói Iroda', 'Megkeresés adatszolgáltatásra', 'vegrehajto-megkereses', 'Végrehajtói megkeresés', 5, '10:03', 'ok', 'ell', 'VA', 0, 3, 1, 1, ['by' => 'SN', 'read' => 1]],
            [1, 'CK', 'RSZ', 'Tárhely szolgáltató', 'A tárhely telítettsége elérte a 80%-ot', 'rendszeruzenet', 'Rendszerüzenet', 3, '03:00', 'na', 'uj', null, 0, null, 0, 0, ['sys' => 1]],
            [3, 'CK', 'RSZ', 'Tárhely szolgáltató', 'Küldemény törlése 5 nap múlva', 'rendszeruzenet', 'Rendszerüzenet', 4, '03:00', 'na', 'uj', null, 0, null, 0, 0, ['sys' => 1]],
            [8, 'ÜK', 'NAV', $NAV, 'Tájékoztatás adószámla-egyenlegről', 'nav-tajekoztatas', 'NAV tájékoztatás', 14, '09:44', 'ok', 'kesz', 'LG', 0, null, 0, 0, ['by' => 'LG', 'read' => 1, 'arch' => 1]],
        ];
        $ids = [];
        foreach ($M as $n => [$c, $b, $s, $sf, $sub, $tid, $tl, $d, $t, $off, $int, $as, $urg, $dd, $sure, $es3, $x]) {
            $arr = $at($d, $t);
            $ids[$n] = $id = DB::table('messages')->insertGetId(['office_id' => $o, 'client_id' => $C[$c], 'mailbox_id' => $B["$c$b"], 'source_id' => "seed-$n", 'sender' => $s, 'sender_full' => $sf,
                'subject' => $sub, 'type_id' => $tid, 'type_label' => $tl, 'type_ai' => $x['ai'] ?? 0, 'unknown' => $x['unknown'] ?? 0, 'receipt' => $x['receipt'] ?? 0, 'system' => $x['sys'] ?? 0,
                'arrived_at' => $arr, 'official' => $off, 'official_at' => in_array($off, ['ok', 'fic']) ? $arr->copy()->addMinutes(40) : null, 'official_by' => isset($x['by']) ? $U[$x['by']] : null,
                'internal' => $int, 'urgent' => $urg, 'archived' => $x['arch'] ?? 0, 'assignee_id' => $as ? $U[$as] : null,
                'deadline_date' => $dl($dd), 'deadline_sure' => $sure, 'deadline_source' => $dd === null ? null : ($sure ? 'Az iratban szereplő dátum' : 'Mintaszabály: átvételből számolva (nem hiteles)'),
                'deadline_confirmed_by' => $sure && $as ? $U[$as] : null, 'es3' => $es3] + $ts);
            if (!empty($x['read'])) foreach ($U as $uid) DB::table('message_reads')->insert(['message_id' => $id, 'user_id' => $uid, 'read_at' => now()]);
            DB::table('delivery_events')->insert(['office_id' => $o, 'message_id' => $id, 'type' => 'listazva', 'at' => $arr, 'evidence_ref' => 'demó-lista'] + $ts);
            if ($off === 'ok') {
                $msg = DB::table('messages')->find($id); $f = (new DemoConnector)->download($msg);
                $doc = Documents::store($o, $id, $f['name'], $f['bytes'], $U[$x['by']] ?? null);
                DB::table('delivery_events')->insert(['office_id' => $o, 'message_id' => $id, 'type' => 'atvett', 'at' => $msg->official_at, 'actor_id' => $U[$x['by']] ?? null, 'evidence_ref' => "demó letöltési igazolás, dokumentum #$doc"] + $ts);
            }
            if ($off === 'fic') DB::table('delivery_events')->insert(['office_id' => $o, 'message_id' => $id, 'type' => 'kezbesitesi_fikcio', 'at' => $arr, 'evidence_ref' => 'demó kézbesítési igazolás'] + $ts);
        }
        $task = fn ($n, $t, $k, $done = 0) => DB::table('tasks')->insert(['office_id' => $o, 'message_id' => $ids[$n], 'title' => $t, 'user_id' => $U[$k], 'done' => $done] + $ts);
        $task(1, 'Hiányzó mellékletek bekérése az ügyféltől', 'LG'); $task(1, 'Válasz feltöltése ÁNYK-ból', 'LG');
        $task(6, 'Megbízólevél és iratjegyzék átnézése', 'VA', 1); $task(6, 'Időpont egyeztetése a revizorral', 'VA');
        $task(14, 'OSAP 2237 kérdőív kitöltése', 'LG'); $task(17, 'Kért adatok összeállítása', 'VA', 1); $task(17, 'Válasz jóváhagyása', 'SN'); $task(9, '2558 bevallás elkészítése', 'LG');
        // Minta-értesítések, hogy a harang ne üresen induljon (mindhárom fajtából)
        $ntf = fn ($k, $n, $kind, $body, $min, $read = false) => DB::table('notifications')->insert(['office_id' => $o, 'user_id' => $U[$k], 'message_id' => $ids[$n], 'kind' => $kind, 'body' => $body,
            'dedupe_key' => "seed-$k-$n-$kind", 'read_at' => $read ? now() : null, 'created_at' => now()->subMinutes($min), 'updated_at' => now()]);
        $sub = fn ($n) => DB::table('messages')->where('id', $ids[$n])->value('subject');
        $ntf('SN', 1, 'szabaly', 'Új irat: ' . $sub(1), 240, true); $ntf('SN', 9, 'hatarido', '5 nap múlva lejár: ' . $sub(9), 180, true);
        $ntf('SN', 3, 'szabaly', 'Új irat: ' . $sub(3), 55); $ntf('SN', 2, 'hatarido', '2 nap múlva lejár: ' . $sub(2), 30);
        $ntf('LG', 1, 'szabaly', 'Új irat: ' . $sub(1), 240); $ntf('LG', 2, 'hatarido', '2 nap múlva lejár: ' . $sub(2), 30);
        foreach (Notify::audience($o, $C[3]) as $uid) Notify::once($o, $uid, null, 'szinkron', 'Leállt a szinkron: ' . DB::table('clients')->where('id', $C[3])->value('name') . ' (ÜK) – Lejárt a hitelesítés', "seed-sync-$uid");
        Notify::authorizations($o);
        DB::table('notes')->insert(['office_id' => $o, 'message_id' => $ids[1], 'user_id' => $U['SN'], 'body' => 'Az ügyfél tegnap jelezte, hogy a szállítói számlák egy része még nincs meg.'] + $ts);

        foreach ([
            ['NAV fizetési felszólítás', ['senders' => ['NAV'], 'type' => 'felszólítás'], 'Sürgős', null, 'Vezetőnek azonnal', 3, 0, 'manual'],
            ['NAV hiánypótlás és határozat', ['senders' => ['NAV'], 'type' => 'hiánypótl|határozat'], 'Sürgős', null, 'Felelősnek azonnal', 2, 0, 'manual'],
            ['Bírósági, cégbírósági és végrehajtói irat', ['senders' => ['BÍR', 'VH', 'CÉGB']], 'Sürgős', null, 'Vezetőnek azonnal', 1, 0, 'manual'],
            ['Önkormányzati adó', ['senders' => ['ÖNK']], 'Normál', 'BT', 'Reggeli összesítő', 4, 0, 'manual'],
            ['Elfogadó nyugták', ['receipt' => true], 'Alacsony', null, 'Nincs', 1, 0, 'auto_safe'],
            ['Ismeretlen típus', ['unknown' => true], 'Normál', null, 'Vezetőnek azonnal', 1, 1, 'manual'],
        ] as $p => [$n, $mt, $pri, $as, $no, $v, $lock, $dlm])
            DB::table('rules')->insert(['office_id' => $o, 'name' => $n, 'matcher' => json_encode($mt), 'priority' => $pri, 'assignee_id' => $as ? $U[$as] : null, 'notify' => $no, 'download_mode' => $dlm, 'version' => $v, 'locked' => $lock, 'position' => $lock ? 0 : $p + 1] + $ts);

        // Minta Ügyfélkapu+ / DÁP portálkapcsolatok (titok nélkül – a titkok kizárólag az OS kulcstartójában élnek)
        $p1 = DB::table('portal_connections')->insertGetId([
            'office_id' => $o, 'name' => 'Szalai Nóra – meghatalmazotti ÜK+', 'notes' => 'Cégkapu meghatalmazott (Borostyán, Tiszavirág, Délibáb, Ökörszem, Zöldkapu, Napfonat)',
            'notify_email' => 'sn@iratkapu.test', 'auth_mode' => 'totp', 'vault_key' => 'portal-sn-ukp', 'download_active' => true,
            'tarhely_state' => 'ok', 'tarhely_at' => now()->subMinutes(18), 'upo_state' => 'ok', 'upo_at' => now()->subMinutes(16),
        ] + $ts);
        $p2 = DB::table('portal_connections')->insertGetId([
            'office_id' => $o, 'name' => 'Lakatos Gergő – DÁP mobilazonosítás', 'notes' => 'Egyéni vállalkozók és agrár ügyfelek',
            'notify_email' => 'lg@iratkapu.test', 'auth_mode' => 'dap', 'vault_key' => 'portal-lg-dap', 'download_active' => true,
            'tarhely_state' => 'ok', 'tarhely_at' => now()->subHours(2), 'upo_state' => 'ok', 'upo_at' => now()->subHours(2),
        ] + $ts);
        $p3 = DB::table('portal_connections')->insertGetId([
            'office_id' => $o, 'name' => 'Hegyalja Gépész – saját ÜK+', 'notes' => 'Ügyvezető e-mailes másodlagos azonosítás',
            'notify_email' => 'ugyvezeto3@pelda.test', 'auth_mode' => 'email', 'vault_key' => 'portal-hg-mail', 'download_active' => true,
            'tarhely_state' => 'need', 'tarhely_at' => now()->subDays(2), 'upo_state' => 'need', 'upo_at' => now()->subDays(2),
            'last_error' => 'A KAÜ munkamenet lejárt – jóváhagyás szükséges.',
        ] + $ts);
        DB::table('portal_connections')->insert(['office_id' => $o2, 'name' => 'Másik Iroda Kapuja', 'auth_mode' => 'totp', 'vault_key' => 'portal-other', 'download_active' => true] + $ts);

        DB::table('mailboxes')->whereIn('client_id', [$C[1], $C[2], $C[5], $C[6], $C[9], $C[10]])->update(['portal_connection_id' => $p1, 'quota_pct' => 24.5]);
        DB::table('mailboxes')->whereIn('client_id', [$C[4], $C[7], $C[8]])->update(['portal_connection_id' => $p2, 'quota_pct' => 12.0]);
        DB::table('mailboxes')->where('client_id', $C[3])->update(['portal_connection_id' => $p3, 'quota_pct' => 81.5]);

        // Minta NAV ÜPO Adónaptár és bevallások (összepárosítva a meglévő nyugtákkal)
        $mStart = now()->subMonth()->startOfMonth()->toDateString();
        $mEnd = now()->subMonth()->endOfMonth()->toDateString();
        $due12 = now()->startOfMonth()->addDays(11)->toDateString(); // 12-e: 2608 / 2658
        $due20 = now()->startOfMonth()->addDays(19)->toDateString(); // 20-a: 2665 / 26A60
        $obs = [
            [$C[1], '2608', 'Havi adó- és járulékbevallás (08)', $mStart, $mEnd, $due12, false, 'submitted', '8104920114', now()->subDays(2)->toDateString(), null, null],
            [$C[1], '2665', 'Általános forgalmi adó bevallás (65)', $mStart, $mEnd, $due20, false, 'submittable', null, null, null, null],
            [$C[2], '2608', 'Havi adó- és járulékbevallás (08)', $mStart, $mEnd, $due12, false, 'rejected', '8104920299', now()->subDays(2)->toDateString(), now()->subDays(2)->toDateString(), $ids[13]],
            [$C[3], '2608', 'Havi adó- és járulékbevallás (08)', $mStart, $mEnd, now()->subDays(3)->toDateString(), false, 'missing', null, null, null, null],
            [$C[4], '2658', 'Egyéni vállalkozó járulékbevallása (58)', $mStart, $mEnd, $due12, false, 'submitted', '8104920458', now()->toDateString(), null, $ids[3]],
            [$C[5], '2608', 'Havi adó- és járulékbevallás (08)', $mStart, $mEnd, $due12, false, 'submitted', '8104920508', now()->subDays(1)->toDateString(), null, null],
            [$C[5], '2665', 'Általános forgalmi adó bevallás (65)', $mStart, $mEnd, $due20, false, 'submittable', null, null, null, null],
            [$C[5], '26A60', 'EK összesítő nyilatkozat (A60)', $mStart, $mEnd, $due20, true, 'conditional', null, null, null, null],
            [$C[6], '2665', 'Általános forgalmi adó bevallás (65)', $mStart, $mEnd, $due20, false, 'submitted', '8104920665', now()->subDays(1)->toDateString(), null, $ids[12]],
            [$C[7], '2608', 'Havi adó- és járulékbevallás (08)', $mStart, $mEnd, $due12, false, 'submittable', null, null, null, null],
            [$C[8], '2658', 'Egyéni vállalkozó járulékbevallása (58)', $mStart, $mEnd, now()->subDays(4)->toDateString(), false, 'missing', null, null, null, null],
            [$C[9], '2665', 'Általános forgalmi adó bevallás (65)', $mStart, $mEnd, $due20, false, 'submittable', null, null, null, null],
            [$C[10], '26A60', 'EK összesítő nyilatkozat (A60)', $mStart, $mEnd, $due20, true, 'conditional', null, null, null, null],
        ];
        foreach ($obs as [$cid, $fc, $title, $ps, $pe, $dd, $cond, $st, $bc, $subAt, $errAt, $rmid]) {
            DB::table('tax_obligations')->insert([
                'office_id' => $o, 'client_id' => $cid, 'source' => 'demo',
                'external_key' => "$fc|$ps|$pe|$dd", 'form_code' => $fc, 'title' => $title,
                'period_start' => $ps, 'period_end' => $pe, 'due_date' => $dd, 'conditional' => $cond,
                'status' => $st, 'barcode' => $bc, 'submitted_at' => $subAt, 'error_at' => $errAt,
                'receipt_message_id' => $rmid,
            ] + $ts);
        }
        DB::table('tax_obligations')->insert([
            'office_id' => $o2, 'client_id' => $c2, 'source' => 'demo',
            'external_key' => "2608|$mStart|$mEnd|$due12", 'form_code' => '2608', 'title' => 'Másik iroda bevallása',
            'due_date' => $due12, 'status' => 'submittable',
        ] + $ts);

        Audit::log($o, null, 'Mintaadatok betöltve – minden adat kitalált', ['evidence' => 'DatabaseSeeder']);
        Audit::log($o, (object) ['id' => $U['SN'], 'name' => 'Szalai Nóra'], 'Hivatalos átvétel (minta)', ['client_id' => $C[5], 'message_id' => $ids[1], 'evidence' => 'demó letöltési igazolás', 'policy' => 'átvétel v2']);
        Audit::log($o, null, 'Hitelesítés lejárt, szinkron leállítva', ['client_id' => $C[3], 'evidence' => 'szinkron']);
    }
}
