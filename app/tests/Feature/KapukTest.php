<?php
namespace Tests\Feature;

use App\Iratkapu\{ConnectorGuard, GateException, SyncService, Notify, Es3Reader, Es3Exception, Samples, Documents, SignatureCheck, Taxonomy};
use Illuminate\Support\Facades\Mail;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\{DB, Storage};
use Tests\TestCase;

/** A specifikáció 9. pontjának elfogadási feltételei és a joghatás-kapuk. */
class KapukTest extends TestCase
{
    use RefreshDatabase;
    protected bool $seed = true;

    private function u(string $k): User { return User::where('initials', $k)->firstOrFail(); }
    private function msg(string $subject): object { return DB::table('messages')->where('subject', 'like', "$subject%")->first(); }

    // 9.1 – jogosultság nem szivárog át irodák és ügyfelek között
    public function test_masik_iroda_es_nem_raosztott_ugyfel_adata_sehol_nem_latszik(): void
    {
        $r = $this->actingAs($this->u('LG'))->getJson('/api/state')->assertOk();
        $this->assertStringNotContainsString('Másik iroda titkos irata', $r->getContent());
        $this->assertStringNotContainsString('Tiszavirág Dental', $r->getContent()); // BT ügyfele, LG nem kezeli
        $idegen = DB::table('messages')->where('subject', 'Másik iroda titkos irata')->value('id');
        $this->postJson("/api/messages/m$idegen/action", ['action' => 'read'])->assertNotFound();
        $bt = $this->msg('Végzés változásbejegyzési')->id;
        $this->postJson("/api/messages/m$bt/action", ['action' => 'me'])->assertNotFound();
        $this->postJson("/api/messages/m$bt/receive")->assertNotFound();
        $this->assertStringNotContainsString('Tiszavirág', $this->get('/api/export')->getContent());
    }

    public function test_belepes_nelkul_semmi_nem_erheto_el(): void
    {
        $this->getJson('/api/state')->assertUnauthorized();
        $this->get('/')->assertRedirect('/login');
    }

    // 9.2 – újraszinkron nem hoz létre duplikátumot, értesítést vagy tárhelyműveletet
    public function test_ujraszinkron_idempotens(): void
    {
        $mb = DB::table('mailboxes')->where('sync_state', 'ok')->first();
        DB::table('mailboxes')->where('id', $mb->id)->update(['demo_cursor' => (4 - $mb->id % 4) % 4]);
        $this->assertSame(1, SyncService::run(DB::table('mailboxes')->find($mb->id), null)['created']);
        $n = DB::table('messages')->count(); $no = DB::table('notifications')->count(); $de = DB::table('delivery_events')->count();
        $res = SyncService::run(DB::table('mailboxes')->find($mb->id), null, false);
        $this->assertSame(0, $res['created']);
        $this->assertSame([$n, $no, $de], [DB::table('messages')->count(), DB::table('notifications')->count(), DB::table('delivery_events')->count()]);
    }

    // 9.3 – a belső „olvasott” más mező, mint a hivatalos állapot
    public function test_belso_olvasott_nem_valtoztat_hivatalos_allapotot(): void
    {
        $m = $this->msg('Fizetési felszólítás');
        $this->actingAs($this->u('LG'))->postJson("/api/messages/m{$m->id}/action", ['action' => 'read'])->assertOk();
        $after = DB::table('messages')->find($m->id);
        $this->assertSame('wait', $after->official); $this->assertNull($after->official_at);
        $this->assertSame(0, DB::table('delivery_events')->where('message_id', $m->id)->where('type', '!=', 'listazva')->count());
        // az olvasottság felhasználónkénti: LG olvasta, SN nem
        $unread = fn (string $k) => collect($this->actingAs($this->u($k))->getJson('/api/state')->json('messages'))->firstWhere('id', "m{$m->id}")['unread'];
        $this->assertFalse($unread('LG')); $this->assertTrue($unread('SN'));
    }

    public function test_atvetelre_varo_irat_nem_zarhato_le_sem_egyenkent_sem_tomegesen(): void
    {
        $m = $this->msg('Fizetési felszólítás');
        $this->actingAs($this->u('LG'))->postJson("/api/messages/m{$m->id}/action", ['action' => 'done'])->assertStatus(422);
        $this->postJson('/api/messages/bulk', ['ids' => ["m{$m->id}"], 'action' => 'done'])->assertOk()->assertJson(['skipped' => 1]);
        $this->postJson('/api/messages/bulk', ['ids' => ["m{$m->id}"], 'action' => 'arch'])->assertStatus(422);
        $this->assertSame('uj', DB::table('messages')->find($m->id)->internal);
    }

    // 9.4 – átvételt kiváltható hívás sem automatikusan, sem újrapróbálkozásból, sem jóváhagyás nélkül
    public function test_letoltes_rendszerbol_es_jovahagyas_nelkul_elutasitva(): void
    {
        $m = $this->msg('Fizetési felszólítás'); $mb = DB::table('mailboxes')->find($m->mailbox_id);
        foreach ([[null, null], [$this->u('LG'), null], [$this->u('LG'), 999999]] as [$actor, $appr]) {
            try { ConnectorGuard::authorize('download', $mb, $actor, $appr, $m->id); $this->fail('Az őrnek el kellett volna utasítania.'); }
            catch (GateException $e) { $this->assertTrue(true); }
        }
        $this->assertSame('wait', DB::table('messages')->find($m->id)->official);
        $this->assertSame(0, DB::table('documents')->where('message_id', $m->id)->count());
        $this->assertGreaterThanOrEqual(3, DB::table('audit_events')->where('action', 'like', 'Elutasított tárhelyművelet%')->count());
    }

    public function test_torles_es_kuldes_soha_nem_engedelyezett(): void
    {
        $mb = DB::table('mailboxes')->first();
        foreach (['delete', 'send'] as $op) {
            try { ConnectorGuard::authorize($op, $mb, $this->u('IA'), 1, 1); $this->fail(); } catch (GateException $e) { $this->assertSame('forbidden', $e->kind); }
        }
    }

    public function test_sajat_kerest_nem_lehet_jovahagyni_es_konyvelo_nem_hagyhat_jova(): void
    {
        $m = $this->msg('Fizetési felszólítás');
        $this->actingAs($this->u('LG'))->postJson("/api/messages/m{$m->id}/receive")->assertOk();
        $aid = DB::table('approvals')->value('id');
        $this->postJson("/api/approvals/$aid", ['approve' => true])->assertForbidden();
        $this->assertSame('wait', DB::table('messages')->find($m->id)->official); // a kérés önmagában nem átvétel
        $m2 = $this->msg('Tájékoztatás ügyirat'); // VA és SN látja
        $this->actingAs($this->u('SN'))->postJson("/api/messages/m{$m2->id}/receive")->assertOk();
        $aid2 = DB::table('approvals')->where('message_id', $m2->id)->value('id');
        $this->postJson("/api/approvals/$aid2", ['approve' => true])->assertForbidden();
    }

    // 9.3 + 9.9 – „átvett” csak bizonyítékkal; minden jóváhagyás visszakereshető
    public function test_jovahagyott_atvetel_demo_modban_bizonyitekkal_es_audittal(): void
    {
        Storage::fake('local');
        $m = $this->msg('Fizetési felszólítás');
        $this->actingAs($this->u('LG'))->postJson("/api/messages/m{$m->id}/receive")->assertOk();
        $aid = DB::table('approvals')->value('id');
        $this->actingAs($this->u('SN'))->postJson("/api/approvals/$aid", ['approve' => true])->assertOk();
        $after = DB::table('messages')->find($m->id);
        $this->assertSame('ok', $after->official);
        $ev = DB::table('delivery_events')->where('message_id', $m->id)->where('type', 'atvett')->first();
        $this->assertNotNull($ev); $this->assertNotEmpty($ev->evidence_ref); $this->assertSame(64, strlen($ev->evidence_sha256));
        $this->assertNotNull($after->deadline_date); $this->assertSame(0, (int) $after->deadline_sure); // számolt határidő mindig becsült
        foreach (['Átvétel kérve', 'Átvétel jóváhagyva', 'Hivatalos átvétel (demó-csatlakozó)'] as $a)
            $this->assertTrue(DB::table('audit_events')->where('message_id', $m->id)->where('action', $a)->exists(), $a);
    }

    public function test_elo_modban_a_jovahagyas_utan_is_zarolt_a_tarhelymuvelet(): void
    {
        config(['iratkapu.mode' => 'live']);
        $m = $this->msg('Fizetési felszólítás');
        $this->actingAs($this->u('LG'))->postJson("/api/messages/m{$m->id}/receive")->assertOk();
        $aid = DB::table('approvals')->value('id');
        $this->actingAs($this->u('SN'))->postJson("/api/approvals/$aid", ['approve' => true])->assertOk();
        $this->assertSame('wait', DB::table('messages')->find($m->id)->official);
        $this->assertSame('blocked', DB::table('approvals')->find($aid)->status);
        $mb = DB::table('mailboxes')->where('sync_state', 'ok')->first();
        $this->assertSame('need', SyncService::run($mb, $this->u('SN'))['state']); // élő listázás sincs bizonyítva
    }

    public function test_lejart_meghatalmazasnal_nincs_tarhelymuvelet(): void
    {
        $m = $this->msg('Fizetési felszólítás');
        DB::table('clients')->where('id', $m->client_id)->update(['auth_until' => now()->subDay()->toDateString()]);
        $this->actingAs($this->u('LG'))->postJson("/api/messages/m{$m->id}/receive")->assertStatus(422);
        $this->assertSame('need', SyncService::run(DB::table('mailboxes')->find($m->mailbox_id), null)['state']);
    }

    // 9.8 – lejárt hitelesítés külön jelzés, nem „naprakész”
    public function test_lejart_hitelesitesu_tarhely_nem_naprakesz_es_nem_kerheto_atvetel(): void
    {
        $m = $this->msg('Határozat késedelmi pótlék');
        $r = $this->actingAs($this->u('LG'))->getJson('/api/state')->json();
        $c = collect($r['clients'])->firstWhere('name', 'Hegyalja Gépész Kft.');
        $this->assertFalse($c['sync']['ok']); $this->assertSame('Lejárt a hitelesítés', $c['sync']['why']);
        $this->postJson("/api/messages/m{$m->id}/receive")->assertStatus(422);
    }

    // 9.7 – becsült határidő nem biztos dátum; emlékeztető csak megerősítettre
    public function test_emlekezteto_csak_megerositett_hataridore_es_nem_ismetlodik(): void
    {
        $lg = $this->u('LG')->id;
        $becsult = DB::table('messages')->where('deadline_sure', false)->whereNotNull('deadline_date')->where('assignee_id', $lg)->first();
        DB::table('messages')->where('id', $becsult->id)->update(['deadline_date' => now()->addDays(2)->toDateString()]);
        $biztos = $this->msg('Végzés hiánypótlásra – 2665');
        DB::table('messages')->where('id', $biztos->id)->update(['deadline_date' => now()->addDays(2)->toDateString()]);
        DB::table('notifications')->delete();
        $this->assertSame(1, Notify::reminders()); $this->assertSame(0, Notify::reminders());
        $this->assertSame($biztos->id, DB::table('notifications')->value('message_id'));
    }

    public function test_at_nem_vett_iratnak_nem_adhato_hatarido(): void
    {
        $m = $this->msg('Fizetési felszólítás');
        $this->actingAs($this->u('LG'))->postJson("/api/messages/m{$m->id}/action", ['action' => 'deadline', 'to' => now()->addDays(5)->toDateString()])->assertStatus(422);
        $this->assertNull(DB::table('messages')->find($m->id)->deadline_date);
    }

    // ismeretlen típus: nincs automatikus kiosztás, de a vezető értesítést kap
    public function test_ismeretlen_tipus_felulvizsgalati_sorba_kerul(): void
    {
        $mb = DB::table('mailboxes')->where('sync_state', 'ok')->first();
        DB::table('mailboxes')->where('id', $mb->id)->update(['demo_cursor' => (4 - $mb->id % 36 + 36) % 36]); // (id+cursor) % 36 == 4 → új küldemény (4-gyel osztható), és a 9 elemű minta-készlet 4. (ismeretlen) eleme
        $mb = DB::table('mailboxes')->find($mb->id);
        SyncService::run($mb, null);
        $m = DB::table('messages')->where('mailbox_id', $mb->id)->where('source_id', 'like', 'demo-%')->first();
        $this->assertSame('oszt', $m->internal); $this->assertNull($m->assignee_id); $this->assertSame(1, (int) $m->unknown);
        $this->assertTrue(DB::table('notifications')->where('message_id', $m->id)->where('user_id', $this->u('SN')->id)->exists());
    }

    public function test_szabaly_szarazfutas_semmit_nem_ir_es_mentes_verziot_noveli(): void
    {
        $rule = DB::table('rules')->where('name', 'NAV fizetési felszólítás')->first();
        $snap = fn () => [DB::table('messages')->sum('urgent'), DB::table('notifications')->count(), DB::table('audit_events')->count(), DB::table('rules')->find($rule->id)->version];
        $before = $snap();
        $hits = $this->actingAs($this->u('SN'))->postJson("/api/rules/{$rule->id}/dry")->assertOk()->json('hits');
        $this->assertNotEmpty($hits); $this->assertSame($before, $snap());
        $this->actingAs($this->u('LG'))->postJson("/api/rules/{$rule->id}", ['pri' => 'Normál', 'as' => '', 'notify' => 'Nincs'])->assertForbidden();
        $this->actingAs($this->u('SN'))->postJson("/api/rules/{$rule->id}", ['pri' => 'Normál', 'as' => '', 'notify' => 'Nincs'])->assertOk();
        $this->assertSame($rule->version + 1, DB::table('rules')->find($rule->id)->version);
        $this->assertTrue(DB::table('rule_versions')->where('rule_id', $rule->id)->where('version', $rule->version + 1)->exists());
    }

    // 9.9 – az auditnapló csak bővíthető
    public function test_auditnaplo_nem_modosithato_es_nem_torolheto(): void
    {
        $id = DB::table('audit_events')->value('id');
        foreach ([fn () => DB::table('audit_events')->where('id', $id)->update(['action' => 'hamisítva']), fn () => DB::table('audit_events')->where('id', $id)->delete()] as $f) {
            try { $f(); $this->fail('Az adatbázisnak tiltania kellett volna.'); } catch (\Illuminate\Database\QueryException $e) { $this->assertStringContainsString('csak bovitheto', $e->getMessage()); }
        }
    }

    // 9.5 – es3 megnyitható, PDF kinyerhető, az eredeti hash változatlan, a kibontás nem érvényesség
    public function test_es3_kibontas_hash_es_ervenyesseg_kulon(): void
    {
        Storage::fake('local');
        $pdf = Samples::pdf('teszt'); $es3 = Samples::es3('Teszt akta', ['irat.pdf' => $pdf, '../../etc/passwd' => 'x']);
        $id = Documents::store(1, null, 'minta.es3', $es3, null);
        $d = DB::table('documents')->find($id);
        $this->assertSame('kibontva', $d->parse_state); $this->assertSame('nem_ellenorizheto', $d->validity);
        $this->assertSame(hash('sha256', $es3), $d->sha256);
        $this->assertSame($es3, Storage::disk('local')->get($d->path)); // bájtra változatlan
        $kids = DB::table('documents')->where('parent_id', $id)->get();
        $this->assertSame(hash('sha256', $pdf), $kids->firstWhere('name', 'irat.pdf')->sha256);
        $this->assertSame('application/pdf', $kids->firstWhere('name', 'irat.pdf')->mime);
        $this->assertNotNull($kids->firstWhere('name', 'passwd')); // útvonal-bejárás normalizálva
        foreach (DB::table('documents')->get() as $x) { $this->assertStringStartsWith('eredeti/1/', $x->path); $this->assertNotSame('ervenyes', $x->validity); }
    }

    // 9.6 – sérült, rosszindulatú, túlméretezett es3 biztonságosan hibára fut
    public function test_es3_ellenseges_bemenetek(): void
    {
        $r = new Es3Reader; $ns = 'xmlns:es="https://www.microsec.hu/ds/e-szigno30#" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"';
        $bad = [
            'xxe' => '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><es:Dossier ' . $ns . '>&e;</es:Dossier>',
            'bomba' => '<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><es:Dossier ' . $ns . '>&b;</es:Dossier>',
            'nem akta' => '<?xml version="1.0"?><html><body>nem akta</body></html>',
            'serult' => '<es:Dossier ' . $ns . '><es:Documents><es:Document>',
            'rossz base64' => '<es:Dossier ' . $ns . '><es:Documents><es:Document><es:DocumentProfile><es:Title>a.pdf</es:Title></es:DocumentProfile><ds:Object>!!!nem base64!!!</ds:Object></es:Document></es:Documents></es:Dossier>',
            'ures' => '',
            'zip, nem xml' => "PK\x03\x04" . str_repeat("\0", 64),
        ];
        foreach ($bad as $name => $bytes) {
            try { $r->read($bytes); $this->fail("Hibára kellett volna futnia: $name"); } catch (Es3Exception $e) { $this->assertTrue(true); }
        }
        config(['iratkapu.es3.max_file' => 100]);
        try { $r->read(Samples::es3('nagy', ['a.pdf' => str_repeat('x', 500)])); $this->fail('méretkorlát'); } catch (Es3Exception $e) { $this->assertTrue(true); }
        config(['iratkapu.es3.max_file' => 20 * 1024 * 1024, 'iratkapu.es3.max_docs' => 2]);
        try { $r->read(Samples::es3('sok', ['a' => '1', 'b' => '2', 'c' => '3'])); $this->fail('elemszámkorlát'); } catch (Es3Exception $e) { $this->assertTrue(true); }
        config(['iratkapu.es3.max_docs' => 200]);
        $nested = Samples::es3('1', ['b.es3' => Samples::es3('2', ['c.es3' => Samples::es3('3', ['d.es3' => Samples::es3('4', ['x.txt' => 'x'])])])]);
        try { $r->read($nested); $this->fail('mélységkorlát'); } catch (Es3Exception $e) { $this->assertTrue(true); }
        // sérült fájl feltöltve: „nem bontható ki”, és soha nem „érvényes”
        Storage::fake('local');
        $d = DB::table('documents')->find(Documents::store(1, null, 'rossz.es3', $bad['xxe'], null));
        $this->assertSame('nem_bonthato', $d->parse_state); $this->assertNotSame('ervenyes', $d->validity);
        $this->assertSame(0, DB::table('documents')->where('parent_id', $d->id)->count());
    }

    // Valódi cégbírósági minta szerkezete alapján (2026-11-11): más névtér, a név kiterjesztése a MIME-Type attribútumban
    public function test_cegbirosagi_nevteru_akta_es_kiterjesztes_a_mime_tipusbol(): void
    {
        $ns = 'http://www.e-cegjegyzek.hu/2021/e-cegeljaras#';
        $x = '<?xml version="1.0" encoding="UTF-8"?><es:Dossier xmlns:es="' . $ns . '" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">'
            . '<es:DossierProfile Id="PObject0"><es:Title>Akta címe</es:Title><es:Cégnév Custom="true">Minta Kft.</es:Cégnév></es:DossierProfile><es:Documents Id="Object0">'
            . '<es:Document><es:DocumentProfile Id="PO1"><es:Title>Végzés</es:Title><es:Format><es:MIME-Type type="application" subtype="pdf" extension="pdf"/></es:Format><es:BaseTransform><es:Transform Algorithm="base64"/></es:BaseTransform></es:DocumentProfile><ds:Object Id="O1">' . base64_encode(Samples::pdf('a')) . '</ds:Object></es:Document>'
            . '<es:Document><es:DocumentProfile Id="PO2"><es:Title>belso.es3</es:Title><es:Format><es:MIME-Type type="application" subtype="vnd.eszigno3+xml" extension="es3"/></es:Format></es:DocumentProfile><ds:Object Id="O2">' . base64_encode(Samples::es3('Belső', ['b.pdf' => Samples::pdf('b')], $ns)) . '</ds:Object></es:Document>'
            . '</es:Documents></es:Dossier>';
        $o = (new Es3Reader)->read($x);
        $this->assertSame('Akta címe', $o['title']); $this->assertSame($ns, $o['namespace']);
        $this->assertSame(['Végzés.pdf', 'belso.es3'], array_column($o['documents'], 'name'));
        $this->assertSame('application/pdf', $o['documents'][0]['mime']);
        $this->assertSame('b.pdf', $o['documents'][1]['nested']['documents'][0]['name']);
        // ismeretlen névtérben lévő „Dossier” továbbra sem e-akta
        try { (new Es3Reader)->read(str_replace($ns, 'http://pelda.invalid/akarmi#', $x)); $this->fail(); } catch (Es3Exception $e) { $this->assertTrue(true); }
        // archiváláskor a beágyazott akta gyerekei is bekerülnek
        Storage::fake('local');
        $id = Documents::store(1, null, 'kulso.es3', $x, null);
        $inner = DB::table('documents')->where('parent_id', $id)->where('name', 'belso.es3')->first();
        $this->assertSame('kibontva', $inner->parse_state);
        $this->assertSame('b.pdf', DB::table('documents')->where('parent_id', $inner->id)->value('name'));
    }

    public function test_titkositott_es3_dokumentum_nem_bonthato_de_nem_omlik_ossze(): void
    {
        $x = '<es:Dossier xmlns:es="https://www.microsec.hu/ds/e-szigno30#" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><es:Documents><es:Document><es:DocumentProfile><es:Title>titkos.pdf</es:Title><es:BaseTransform><es:Transform Algorithm="encrypt"/><es:Transform Algorithm="base64"/></es:BaseTransform></es:DocumentProfile><ds:Object>QUJD</ds:Object></es:Document></es:Documents></es:Dossier>';
        $out = (new Es3Reader)->read($x);
        $this->assertStringContainsString('Titkosított', $out['documents'][0]['error']);
    }

    // Aláírás: a sértetlenség ellenőrzött, de „érvényes” soha; a manipulált fájl „érvénytelen”
    public function test_alairas_sertetlenseg_manipulacio_es_kulso_hivatkozas(): void
    {
        $signed = SignatureCheck::signSample(Samples::es3('Aláírt', ['irat.pdf' => Samples::pdf('eredeti')]));
        $ok = SignatureCheck::check($signed);
        $this->assertSame('nem_ellenorizheto', $ok['validity']); $this->assertSame('sertetlen', $ok['signatures'][0]['result']);
        $this->assertStringContainsString('KapuMail demó aláíró', $ok['signatures'][0]['signer']);
        // 1) a tartalom megváltozik az aláírás után
        $b64 = base64_encode(Samples::pdf('eredeti')); $this->assertStringContainsString($b64, $signed);
        $tampered = str_replace($b64, base64_encode(Samples::pdf('HAMISÍTOTT')), $signed);
        $bad = SignatureCheck::check($tampered);
        $this->assertSame('ervenytelen', $bad['validity']); $this->assertSame('hibas', $bad['signatures'][0]['result']);
        // 2) az aláírásérték sérül
        $bad2 = SignatureCheck::check(preg_replace_callback('#(<ds:SignatureValue>)(.{8})#', fn ($m) => $m[1] . strrev($m[2]), $signed));
        $this->assertSame('ervenytelen', $bad2['validity']);
        // 3) külső hivatkozást nem követünk, és nem minősítjük érvénytelennek
        $ext = str_replace('URI="#obj-1"', 'URI="file:///etc/passwd"', $signed);
        $e = SignatureCheck::check($ext);
        $this->assertSame('nem_ellenorizheto', $e['validity']); $this->assertStringContainsString('Külső hivatkozás', $e['signatures'][0]['why']);
        // 4) aláírás nélküli akta
        $this->assertSame('nem_ellenorizheto', SignatureCheck::check(Samples::es3('x', ['a.txt' => 'a']))['validity']);
        // 5) egyetlen ág sem ad „érvényes”-t
        foreach ([$ok, $bad, $bad2, $e] as $x) $this->assertNotSame('ervenyes', $x['validity']);
        // archiváláskor az eredmény a dokumentumra kerül, és a manipulált fájl gyerekei is megmaradnak bizonyítékként
        Storage::fake('local');
        $d = DB::table('documents')->find(Documents::store(1, null, 'hamis.es3', $tampered, null));
        $this->assertSame('ervenytelen', $d->validity); $this->assertSame('kibontva', $d->parse_state); $this->assertNotNull($d->validated_at);
    }

    public function test_taxonomia_felismeres_gepi_becsleskent_es_ismeretlen_marad_ismeretlen(): void
    {
        $this->assertSame(75, DB::table('document_types')->count());
        $this->assertSame('nav.folyoszamla.hatarozat_vegzes', Taxonomy::classify('NAV - Átvezetés végzés', 'NAV')->type_id);
        $this->assertNull(Taxonomy::classify('Teljesen ismeretlen tárgy', 'XYZ'));
        $this->assertNull(Taxonomy::classify('NAV', 'NAV')); // túl rövid minta nem illeszkedik mindenre
        $mb = DB::table('mailboxes')->where('sync_state', 'ok')->first();
        DB::table('mailboxes')->where('id', $mb->id)->update(['demo_cursor' => (24 - $mb->id % 36 + 36) % 36]); // a készlet 6. eleme: típus nélkül érkező NAV-végzés
        $res = SyncService::run(DB::table('mailboxes')->find($mb->id), null);
        $this->assertSame(1, $res['created'], json_encode($res, JSON_UNESCAPED_UNICODE));
        $m = DB::table('messages')->where('mailbox_id', $mb->id)->where('source_id', 'like', 'demo-%')->first();
        $this->assertSame('nav.folyoszamla.hatarozat_vegzes', $m->type_id); $this->assertSame(1, (int) $m->type_ai); $this->assertNotNull($m->type_group);
    }

    public function test_ugyfelertesites_csak_elonezetbol_ismetles_ellen_vedve_es_megmondja_miert_nem_megy(): void
    {
        Mail::fake();
        $m = $this->msg('Végzés hiánypótlásra – 2665');
        $p = $this->actingAs($this->u('LG'))->getJson("/api/messages/m{$m->id}/notice")->assertOk()->json();
        Mail::assertNothingSent(); $this->assertSame(0, DB::table('client_notices')->count()); // az előnézet nem küld és nem ment
        $this->assertNull($p['blocked']); $k = $p['contacts'][0]['id'];
        $send = ['contact' => $k, 'subject' => $p['subject'], 'body' => $p['body']];
        $this->postJson("/api/messages/m{$m->id}/notice", $send)->assertOk();
        $this->postJson("/api/messages/m{$m->id}/notice", $send)->assertStatus(409); // ismétlésvédelem
        $this->assertSame(1, DB::table('client_notices')->where('status', 'sent')->count());
        $this->postJson("/api/messages/m{$m->id}/notice", $send + ['again' => true])->assertOk(); // kifejezett megerősítéssel mehet
        $this->assertTrue(DB::table('audit_events')->where('message_id', $m->id)->where('action', 'like', 'Ügyfélértesítés elküldve%')->exists());
        // más ügyfél címzettjének nem küldhető
        $idegen = DB::table('client_contacts')->where('client_id', '!=', $m->client_id)->value('id');
        $this->postJson("/api/messages/m{$m->id}/notice", ['contact' => $idegen] + $send)->assertStatus(422);
        // ahol nincs cím, ott az előnézet megmondja az okot
        $nincs = $this->msg('Felszólítás bevallás benyújtására');
        $this->assertStringContainsString('nincs értesítési cím', $this->getJson("/api/messages/m{$nincs->id}/notice")->json('blocked'));
    }

    public function test_utemezett_szinkron_csak_listaz_es_nem_vesz_at(): void
    {
        $wait = DB::table('messages')->where('official', 'wait')->count(); $docs = DB::table('documents')->count();
        $this->artisan('iratkapu:szinkron')->assertSuccessful();
        $this->artisan('iratkapu:emlekeztetok')->assertSuccessful();
        $this->assertGreaterThanOrEqual($wait, DB::table('messages')->where('official', 'wait')->count());
        $this->assertSame($docs, DB::table('documents')->count());
        $this->assertSame(0, DB::table('delivery_events')->where('type', 'atvett')->where('created_at', '>=', now()->subMinute())->whereNull('actor_id')->where('evidence_ref', 'not like', 'demó letöltési igazolás%')->count());
        $this->assertSame(0, DB::table('audit_events')->where('actor_label', 'Rendszer')->where('action', 'like', 'Hivatalos átvétel%')->count());
    }

    // Harang: leállt szinkronról és lejáró/lejárt meghatalmazásról csak az ügyfelet látók kapnak értesítést, ismétlés nélkül
    public function test_szinkronleallas_es_meghatalmazas_ertesites_csak_az_ugyfelet_latoknak_es_egyszer(): void
    {
        DB::table('notifications')->delete();
        $m = $this->msg('Fizetési felszólítás'); $mb = DB::table('mailboxes')->find($m->mailbox_id);
        $latja = fn (string $k) => in_array($m->client_id, \App\Iratkapu\Scope::clientIds($this->u($k)));
        $this->assertTrue($latja('LG')); $kivul = collect(['BT', 'VA'])->first(fn ($k) => !$latja($k)); $this->assertNotNull($kivul);
        // 14 nappal a lejárat előtt figyelmeztetés, másodszorra nem ismétlődik
        DB::table('clients')->where('id', $m->client_id)->update(['auth_until' => now()->addDays(14)->toDateString()]);
        $this->assertGreaterThan(0, Notify::authorizations()); $this->assertSame(0, Notify::authorizations());
        $this->assertSame(1, DB::table('notifications')->where('user_id', $this->u('LG')->id)->where('kind', 'meghatalmazas')->where('body', 'like', '14 nap múlva%')->count());
        // lejárat után a szinkron leáll: „meghatalmazás” fajtájú értesítés megy, nem „szinkron”
        DB::table('clients')->where('id', $m->client_id)->update(['auth_until' => now()->subDay()->toDateString()]);
        $this->assertSame('need', SyncService::run($mb, null)['state']);
        $this->assertSame(1, DB::table('notifications')->where('user_id', $this->u('SN')->id)->where('body', 'like', 'Lejárt a meghatalmazás%')->count());
        $this->assertSame(0, Notify::authorizations(null, $m->client_id));
        $this->assertSame(0, DB::table('notifications')->where('kind', 'szinkron')->count());
        // érvényes meghatalmazás mellett leálló szinkron: „szinkron” fajta, naponta egyszer
        DB::table('clients')->where('id', $m->client_id)->update(['auth_until' => now()->addYear()->toDateString()]);
        $this->assertGreaterThan(0, Notify::syncStopped($mb, 'próba')); $this->assertSame(0, Notify::syncStopped($mb, 'próba'));
        // aki nem látja az ügyfelet, és a másik iroda, semmit nem kap
        $this->assertSame(0, DB::table('notifications')->where('user_id', $this->u($kivul)->id)->count());
        $this->assertSame(0, DB::table('notifications')->where('user_id', User::where('initials', 'KK')->value('id'))->count());
        $r = $this->actingAs($this->u('LG'))->getJson('/api/state')->json();
        $this->assertContains('szinkron', array_column($r['notifications'], 'kind')); $this->assertContains('meghatalmazas', array_column($r['notifications'], 'kind'));
    }

    // Élő listázás (tarhely-cli): alapból zárva; bekapcsolva is csak metaadat, idempotensen, „nem ismert” hivatalos állapottal
    public function test_elo_lista_fogadasa_kapuk_idempotencia_es_ismeretlen_atveteli_allapot(): void
    {
        $letters = ['letters' => [
            ['eid' => 'E1', 'mailbox' => '12345678 Példa Kft.', 'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal', 'type' => 'NAV - Átvezetés végzés', 'desc' => '', 'receivedAt' => '2026-11-08 09:12'],
            ['eid' => 'E2', 'mailbox' => 'Ismeretlen postafiók', 'sender' => 'X', 'senderFull' => 'X', 'type' => 'valami', 'desc' => '', 'receivedAt' => '2026-11-08 09:12'],
        ]];
        $mb = DB::table('mailboxes')->where('sync_state', 'ok')->first();
        $this->actingAs($this->u('LG'))->postJson("/api/mailboxes/{$mb->id}/live", ['name' => '12345678 Példa Kft.'])->assertForbidden();
        $this->actingAs($this->u('SN'))->postJson("/api/mailboxes/{$mb->id}/live", ['name' => '12345678 Példa Kft.'])->assertOk();
        $n = DB::table('messages')->count();
        // 1) kikapcsolt állapotban semmi nem jön létre
        config(['iratkapu.live_listing' => false]); // a helyi .env ne befolyásolja
        $r = $this->postJson('/api/live/ingest', $letters)->assertOk()->json();
        $this->assertSame([0, 1, 1], [$r['created'], $r['blocked'], $r['unmapped']]); $this->assertSame($n, DB::table('messages')->count());
        // 2) bekapcsolva: csak a hozzárendelt postafiók levele jön létre
        config(['iratkapu.live_listing' => true]);
        $r = $this->postJson('/api/live/ingest', $letters)->assertOk()->json();
        $this->assertSame([1, 0, 1], [$r['created'], $r['known'], $r['unmapped']]); $this->assertSame(['Ismeretlen postafiók'], $r['unmappedNames']);
        $m = DB::table('messages')->where('source_id', 'live-E1')->first();
        $this->assertSame('listed', $m->official); $this->assertNull($m->official_at); $this->assertNull($m->deadline_date);
        $this->assertSame('nav.folyoszamla.hatarozat_vegzes', $m->type_id); $this->assertSame(1, (int) $m->type_ai);
        $this->assertSame(0, DB::table('documents')->where('message_id', $m->id)->count()); // irat nem jön le
        // 3) ismétlés: nincs duplikátum
        $r = $this->postJson('/api/live/ingest', $letters)->json(); $this->assertSame([0, 1], [$r['created'], $r['known']]);
        // 4) élő iratra nem kérhető átvétel az alkalmazásból, és könyvelő nem látja más ügyfelét
        $this->postJson("/api/messages/m{$m->id}/receive")->assertStatus(422);
        // 5) lejárt meghatalmazásnál elutasítva
        DB::table('clients')->where('id', $mb->client_id)->update(['auth_until' => now()->subDay()->toDateString()]);
        $letters['letters'][0]['eid'] = 'E3';
        $this->assertSame(1, $this->postJson('/api/live/ingest', $letters)->json('blocked'));
        // 6) rendszer nem indíthat élő listázást
        try { ConnectorGuard::authorizeLiveListing(DB::table('mailboxes')->find($mb->id), null); $this->fail(); } catch (GateException $e) { $this->assertTrue(true); }
        // 7) hibás bemenet elutasítva
        $this->postJson('/api/live/ingest', ['letters' => [['eid' => str_repeat('x', 200), 'mailbox' => 'a']]])->assertStatus(422);
    }

    public function test_titok_nem_kerul_az_allapotba_es_a_naploba(): void
    {
        $body = $this->actingAs($this->u('IA'))->getJson('/api/state')->getContent();
        foreach (['password', 'os-vault://', 'remember_token', \Database\Seeders\DatabaseSeeder::DEMO_PASSWORD] as $s) $this->assertStringNotContainsString($s, $body);
        $this->assertSame(0, DB::table('audit_events')->where('action', 'like', '%os-vault%')->orWhere('evidence', 'like', '%os-vault%')->count());
    }

    public function test_ugyfel_felvetele_meghatalmazas_megerositese_nelkul_elutasitva(): void
    {
        $p = ['name' => 'Új Kft.', 'tax' => '12345678-2-13', 'type' => 'CK', 'auth_until' => now()->addYear()->toDateString()];
        $this->actingAs($this->u('SN'))->postJson('/api/clients', $p)->assertStatus(422);
        $this->actingAs($this->u('LG'))->postJson('/api/clients', $p + ['authorized' => true])->assertForbidden();
        $this->actingAs($this->u('SN'))->postJson('/api/clients', $p + ['authorized' => true])->assertOk();
        $this->postJson('/api/clients', $p + ['authorized' => true])->assertStatus(422); // duplikált adószám
    }

    public function test_maganszemely_adoazonosito_jellel_csak_ugyfelkapura_veheto_fel(): void
    {
        $p = ['name' => 'Minta Márta', 'tax' => '8432156787', 'authorized' => true];
        $this->actingAs($this->u('SN'))->postJson('/api/clients', $p + ['type' => 'CK'])->assertStatus(422); // Cégkapuhoz adószám kell
        $this->postJson('/api/clients', ['tax' => '8432156788', 'type' => 'ÜK'] + $p)->assertStatus(422); // hibás ellenőrző jegy
        $this->postJson('/api/clients', ['tax' => '', 'type' => 'ÜK'] + $p)->assertStatus(422); // azonosító nélkül nem
        $this->postJson('/api/clients', $p + ['type' => 'ÜK'])->assertOk();
        $this->postJson('/api/clients', $p + ['type' => 'ÜK'])->assertStatus(422); // duplikált adóazonosító jel
        $this->postJson('/api/clients', ['name' => 'Egyéni Vállalkozó', 'tax' => '56781234-1-13', 'type' => 'ÜK', 'authorized' => true])->assertOk(); // egyéni vállalkozó adószámmal
        // a 84321567 törzsű adószámra érkező NAV-kötelezettség nem kerülhet a magánszemélyhez
        $sn = $this->u('SN');
        $pid = DB::table('portal_connections')->insertGetId(['office_id' => $sn->office_id, 'name' => 'SN NAV-belépője', 'auth_mode' => 'totp', 'vault_key' => 'portal-sn-nav', 'download_active' => true, 'owner_user_id' => $sn->id, 'created_at' => now(), 'updated_at' => now()]);
        $nav = fn (string $stem) => $this->postJson('/api/nav/ingest', ['portalId' => $pid, 'subject' => ['stem' => $stem], 'obligations' => [['formCode' => '2665', 'title' => 'Áfa', 'dueDate' => '2026-12-20']]])->assertOk()->json('calendar');
        $this->assertSame([false, 0], [$nav('84321567')['matched'], $nav('84321567')['upserted']]);
        $this->assertSame(0, DB::table('tax_obligations')->where('client_id', DB::table('clients')->where('tax', '8432156787')->value('id'))->count());
        $this->assertSame(1, $nav('56781234')['upserted']);
    }

    public function test_lejarat_nelkuli_meghatalmazas_hatarozatlan_ideju_nem_szamit_lejartnak(): void
    {
        $sn = $this->u('SN'); $p = ['name' => 'Határozatlan Kft.', 'tax' => '87654321-2-13', 'type' => 'CK', 'authorized' => true];
        $r = $this->actingAs($sn)->postJson('/api/clients', $p)->assertOk()->json(); // lejárat nélkül is felvehető
        $c = DB::table('clients')->where('tax', '87654321-2-13')->first(); $this->assertNull($c->auth_until);
        $this->postJson('/api/clients', ['tax' => '87654322-2-13', 'auth_until' => now()->subDay()->toDateString()] + $p)->assertStatus(422); // ha megadják, múltbeli nem lehet
        $mb = DB::table('mailboxes')->where('client_id', $c->id)->first();
        $this->assertNotSame('need', SyncService::run($mb, $sn)['state']); // a szinkron nem tekinti lejártnak
        $this->assertFalse(DB::table('notifications')->where('kind', 'meghatalmazas')->where('body', 'like', '%Határozatlan Kft.%')->exists());
        $this->assertNull(collect($this->getJson('/api/state')->json('clients'))->firstWhere('name', 'Határozatlan Kft.')['auth']);
    }

    public function test_ugyfelertesites_formazott_szoveggel_es_csak_keresre_csatolmannyal(): void
    {
        config(['mail.default' => 'array']);
        $m = $this->msg('Végzés hiánypótlásra – 2665'); $u = $this->u('LG'); $url = "/api/messages/m{$m->id}/notice";
        $p = $this->actingAs($u)->getJson($url)->assertOk()->json();
        $send = ['contact' => $p['contacts'][0]['id'], 'subject' => $p['subject'], 'body' => 'Fontos irat', 'html' => '<p onclick="x()">Fontos <b style="color:red">irat</b><script>alert(1)</script> <a href="javascript:alert(1)">rossz</a> <a href="https://pelda.test/a" target="_blank">jó</a></p>'];
        // fájl nélküli irathoz nem kérhető csatolás
        DB::table('documents')->where('message_id', $m->id)->delete();
        $this->assertSame([], $this->getJson($url)->json('attachments'));
        $this->postJson($url, $send + ['attach' => true])->assertStatus(422);
        $this->assertSame(0, DB::table('client_notices')->count());
        // csatolás nélkül: formázott levél megy, a veszélyes HTML kiszűrve, fájl nincs benne
        $this->postJson($url, $send)->assertOk()->assertJson(['attached' => 0]);
        $mail = app('mailer')->getSymfonyTransport()->messages()->last()->getOriginalMessage();
        $this->assertSame('<p>Fontos <b>irat</b>alert(1) <a>rossz</a> <a href="https://pelda.test/a">jó</a></p>', $mail->getHtmlBody());
        $this->assertSame('Fontos irat', $mail->getTextBody()); $this->assertCount(0, $mail->getAttachments());
        // kifejezett kérésre az archivált eredeti megy, és az audit rögzíti a hash-ét
        $id = Documents::store($u->office_id, $m->id, 'vegzes.pdf', "%PDF-1.4\nminta", $u->id); $sha = DB::table('documents')->where('id', $id)->value('sha256');
        $this->assertSame('vegzes.pdf', $this->getJson($url)->json('attachments.0.name'));
        $this->postJson($url, $send + ['attach' => true, 'again' => true])->assertOk()->assertJson(['attached' => 1]);
        $mail = app('mailer')->getSymfonyTransport()->messages()->last()->getOriginalMessage();
        $this->assertCount(1, $mail->getAttachments()); $this->assertSame('vegzes.pdf', $mail->getAttachments()[0]->getFilename());
        $this->assertSame("%PDF-1.4\nminta", $mail->getAttachments()[0]->getBody());
        $this->assertTrue(DB::table('audit_events')->where('message_id', $m->id)->where('evidence', 'like', "%vegzes.pdf (SHA-256 $sha)%")->exists());
    }

    // ES3-megnyitó: kibont és visszaad, de semmit nem archivál
    public function test_es3_megnyito_nem_archival(): void
    {
        $before = DB::table('documents')->count();
        $file = \Illuminate\Http\UploadedFile::fake()->createWithContent('akta.es3', Samples::es3('Próba akta', ['irat.pdf' => Samples::pdf('Minta'), 'kisero.xml' => '<a/>']));
        $r = $this->actingAs($this->u('LG'))->post('/api/es3/open', ['file' => $file], ['Accept' => 'application/json'])->assertOk();
        $this->assertSame('Próba akta', $r->json('title')); $this->assertCount(2, $r->json('docs'));
        $this->assertSame('application/pdf', $r->json('docs.0.mime')); $this->assertSame(Samples::pdf('Minta'), base64_decode($r->json('docs.0.data')));
        $this->assertNotSame('ervenyes', $r->json('validity'));
        $this->assertSame($before, DB::table('documents')->count());
        $bad = \Illuminate\Http\UploadedFile::fake()->createWithContent('rossz.es3', '<nem-akta/>');
        $this->actingAs($this->u('LG'))->post('/api/es3/open', ['file' => $bad], ['Accept' => 'application/json'])->assertStatus(422);
        $this->assertSame($before, DB::table('documents')->count());
    }

    public function test_smtp_beallitas_a_jelszo_nem_szivarog_es_az_ertesito_az_iroda_levelezojen_megy(): void
    {
        $this->actingAs($this->u('LG'))->postJson('/api/settings/smtp', [])->assertForbidden(); // könyvelő nem állíthatja
        $cfg = ['host' => 'smtp.pelda.hu', 'port' => 587, 'enc' => 'starttls', 'username' => 'iroda@pelda.hu', 'password' => 'nagyon-titkos', 'from' => 'iroda@pelda.hu', 'fromName' => 'Lakatos Iroda'];
        $this->actingAs($this->u('IA'))->postJson('/api/settings/smtp', $cfg)->assertOk();
        $raw = DB::table('offices')->where('id', $this->u('IA')->office_id)->value('settings');
        $this->assertStringNotContainsString('nagyon-titkos', $raw); // titkosítva tárolva
        $this->assertSame([5, 2, 1], json_decode($raw, true)['reminders']); // a többi beállítás megmarad
        $st = $this->getJson('/api/state')->assertOk();
        $this->assertStringNotContainsString('nagyon-titkos', $st->getContent());
        $this->assertSame(['configured' => true, 'host' => 'smtp.pelda.hu', 'port' => 587, 'enc' => 'starttls', 'username' => 'iroda@pelda.hu', 'hasPassword' => true, 'from' => 'iroda@pelda.hu', 'fromName' => 'Lakatos Iroda'], $st->json('office.mail'));
        $this->assertSame(['configured' => true], $this->actingAs($this->u('LG'))->getJson('/api/state')->json('office.mail'));
        // üres jelszóval mentve a régi marad; az emlékeztetők mentése nem törli az SMTP-t
        $this->actingAs($this->u('IA'))->postJson('/api/settings/smtp', ['password' => '', 'port' => 465, 'enc' => 'ssl'] + $cfg)->assertOk();
        $this->postJson('/api/settings', ['reminders' => [2]])->assertOk();
        $m = \App\Iratkapu\OfficeMail::settings($this->u('IA')->office_id)['smtp'];
        $this->assertSame('nagyon-titkos', \Illuminate\Support\Facades\Crypt::decryptString($m['password'])); $this->assertSame(465, $m['port']);
        $mailer = \App\Iratkapu\OfficeMail::mailer($this->u('IA')->office_id);
        $t = $mailer->getSymfonyTransport(); $this->assertInstanceOf(\Symfony\Component\Mailer\Transport\Smtp\EsmtpTransport::class, $t);
        $this->assertSame('nagyon-titkos', $t->getPassword()); $this->assertSame('smtp.pelda.hu', $t->getStream()->getHost()); $this->assertTrue($t->getStream()->isTLS());
        // a másik iroda levelezője érintetlen
        $this->assertFalse(\App\Iratkapu\OfficeMail::summary(DB::table('offices')->where('name', 'like', 'Másik%')->value('id'))['configured']);
        $this->deleteJson('/api/settings/smtp')->assertOk();
        $this->assertFalse($this->getJson('/api/state')->json('office.mail.configured'));
        $this->postJson('/api/settings/smtp/test')->assertStatus(422);
    }

    public function test_hatarido_emlekezteto_emailben_bekapcsolva_ertesitesenkent_egyszer_es_hiba_nem_allitja_meg(): void
    {
        Mail::fake();
        $ia = $this->u('IA'); $lg = $this->u('LG');
        $m = DB::table('messages')->where('office_id', $ia->office_id)->where('assignee_id', $lg->id)->first();
        DB::table('messages')->where('id', $m->id)->update(['deadline_date' => now()->addDays(2)->toDateString(), 'deadline_sure' => true, 'internal' => 'uj', 'archived' => false]);
        DB::table('notifications')->delete();
        $this->actingAs($ia)->postJson('/api/settings/smtp', ['host' => '127.0.0.1', 'port' => 1, 'enc' => 'starttls', 'from' => 'iroda@pelda.hu'])->assertOk(); // nem létező kiszolgáló: a küldési kísérlet azonnal elbukik
        $this->postJson('/api/settings', ['reminders' => [5, 2, 1], 'reminderEmail' => true])->assertOk();
        $this->assertTrue($this->getJson('/api/state')->json('office.settings.reminderEmail'));
        $before = $this->actingAs($lg)->getJson('/api/notifications/last')->json('last');
        $this->assertGreaterThanOrEqual(1, Notify::reminders($ia->office_id));
        // a levélküldés megtörtént kísérletként, és a hibája nem állította meg az emlékeztetőt
        $this->assertSame(1, DB::table('audit_events')->where('message_id', $m->id)->where('action', 'like', 'Határidő-emlékeztető e-mail%')->count());
        $this->assertGreaterThan($before, $this->getJson('/api/notifications/last')->json('last'));
        $n = DB::table('audit_events')->where('action', 'like', 'Határidő-emlékeztető e-mail%')->count();
        Notify::reminders($ia->office_id); // ismételt futás nem küld újra
        $this->assertSame($n, DB::table('audit_events')->where('action', 'like', 'Határidő-emlékeztető e-mail%')->count());
    }
}
