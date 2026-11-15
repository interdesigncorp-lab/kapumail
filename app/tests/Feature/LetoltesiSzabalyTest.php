<?php
namespace Tests\Feature;

use App\Iratkapu\{DownloadPolicy, Samples};
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\{DB, Storage};
use Tests\TestCase;

/**
 * Irattípusonkénti letöltési szabály (ADR-009): `auto` / `kezi` / `csak_lista`.
 * A szabályt a szerver kényszeríti ki; ismeretlen és `csak_lista` típust semmi nem tölt le automatikusan.
 */
class LetoltesiSzabalyTest extends TestCase
{
    use RefreshDatabase;
    protected bool $seed = true;

    private const NYUGTAK = ['nav.nyugta.egyeb_visszaigazolas', 'nav.nyugta.elfogado', 'nav.nyugta.elutasito'];

    private function u(string $k): User
    {
        return User::where('initials', $k)->firstOrFail();
    }

    public function test_tipuslista_kiindulo_besorolasa(): void
    {
        $by = DB::table('document_types')->get()->groupBy('download_policy')->map(fn ($g) => $g->pluck('type_id')->sort()->values()->all());

        $this->assertEqualsCanonicalizing(['auto', 'kezi', 'csak_lista'], $by->keys()->all());
        $this->assertSame(self::NYUGTAK, $by['auto']);
        $this->assertCount(26, $by['csak_lista']);
        foreach (['nav.illetek.fizetesi', 'nav.vh.fizetesi_felhivas', 'birosag.irat', 'kulso.fizetesi_felszolitas', 'ceg.cegbirosag.vegzes'] as $t) {
            $this->assertContains($t, $by['csak_lista'], $t);
        }
        $this->assertCount(46, $by['kezi']);
    }

    private const BOX = '24817365 Borostyán Pékség Kft.';

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        config(['iratkapu.live_listing' => true, 'iratkapu.live_download' => true]);
    }

    /** Élő lista befogadása a vezető nevében; a postafiók adószám alapján rendelődik az ügyfélhez. */
    private function ingest(array $letters): array
    {
        $letters = array_map(fn ($l) => $l + ['mailbox' => self::BOX, 'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal', 'desc' => '', 'receivedAt' => '2026-11-11 08:10'], $letters);
        return $this->actingAs($this->u('SN'))->postJson('/api/live/ingest', ['autoMap' => true, 'letters' => $letters])->assertOk()->json();
    }

    private function msg(string $eid): object
    {
        return DB::table('messages')->where('source_id', "live-$eid")->firstOrFail();
    }

    private function download(string $eid, array $extra = [])
    {
        return $this->actingAs($this->u('SN'))->postJson('/api/messages/m' . $this->msg($eid)->id . '/live-download', ['fileName' => 'irat.pdf', 'bytesBase64' => base64_encode(Samples::pdf('Irat'))] + $extra);
    }

    /** Az iroda minden levelezési szabálya illeszkedjen a NAV-levelekre, a megadott letöltési móddal. */
    private function allRules(string $mode, array $matcher = ['senders' => ['NAV']]): void
    {
        DB::table('rules')->where('office_id', $this->u('SN')->office_id)->update(['download_mode' => $mode, 'matcher' => json_encode($matcher)]);
    }

    public function test_nyugta_szabaly_nelkul_is_automatikus(): void
    {
        $this->allRules('manual', []); // egyetlen szabály sem illeszkedik
        $r = $this->ingest([['eid' => 'NY-1', 'type' => 'Elfogadó nyugta – 2608 bevallás']]);

        $this->assertCount(1, $r['autoDownload']);
        $this->assertSame('type', $r['autoDownload'][0]['via']);
        $this->assertNull($r['autoDownload'][0]['ruleId']);
        $this->assertFalse($r['autoDownload'][0]['override']);

        $this->download('NY-1', ['auto' => true])->assertOk()->assertJson(['official' => 'na']);
        $this->assertTrue(DB::table('audit_events')->where('message_id', $this->msg('NY-1')->id)->where('action', 'Élő nyugta automatikusan letöltve az irattípus szabálya szerint')->exists());
    }

    /**
     * Tulajdonosi döntés (2026-11-13): amit a hivatalos tárhelyen már átvettek – a tartós tárban van, vagy a tárhely
     * megnyitottnak jelzi –, az „csak lista” típusként is letölthető kézzel. Automatikusan így sem, felülíró szabállyal sem;
     * az olvasatlan és az ismeretlen állapotú iratnál a tiltás marad.
     */
    public function test_a_tarhelyen_mar_atvett_csak_lista_irat_kezzel_letoltheto_automatikusan_nem(): void
    {
        $this->allRules('auto_override_legal');
        $r = $this->ingest([
            ['eid' => 'TT-1', 'type' => 'Illeték fizetési meghagyás', 'folder' => 'TARTOS_TAR', 'portalOpened' => true],
            ['eid' => 'TT-2', 'type' => 'Illeték fizetési meghagyás', 'folder' => 'BEERKEZETT', 'portalOpened' => true],
            ['eid' => 'TT-3', 'type' => 'Illeték fizetési meghagyás', 'folder' => 'BEERKEZETT', 'portalOpened' => false],
            ['eid' => 'TT-4', 'type' => 'Illeték fizetési meghagyás', 'folder' => 'BEERKEZETT'],
        ]);
        $this->assertSame([], $r['autoDownload'], 'automatikusan egyik sem');
        $dlp = fn (string $eid) => collect($this->actingAs($this->u('SN'))->getJson('/api/state')->json('messages'))->firstWhere('eid', $eid)['dlp'];
        $this->assertSame(['kezi', 'kezi', 'csak_lista', 'csak_lista'], [$dlp('TT-1'), $dlp('TT-2'), $dlp('TT-3'), $dlp('TT-4')]);

        $this->download('TT-1', ['auto' => true])->assertStatus(422);
        $this->download('TT-2', ['auto' => true])->assertStatus(422);
        $this->download('TT-3')->assertStatus(422);
        $this->download('TT-4')->assertStatus(422);
        $this->download('TT-1')->assertOk();
        $this->download('TT-2')->assertOk();
        $this->assertSame(1, DB::table('documents')->where('message_id', $this->msg('TT-2')->id)->count());
    }

    public function test_csak_lista_tipust_semmi_nem_tolt_le(): void
    {
        $this->allRules('auto_override_legal');
        $r = $this->ingest([['eid' => 'FM-1', 'type' => 'Illeték fizetési meghagyás']]);

        $this->assertSame('nav.illetek.fizetesi', $this->msg('FM-1')->type_id);
        $this->assertSame([], $r['autoDownload']);

        $this->download('FM-1')->assertStatus(422)->assertJsonFragment(['message' => 'Ezt az irattípust a program nem tölti le; a hivatalos tárhelyen vehető át.']);
        $this->download('FM-1', ['auto' => true])->assertStatus(422);
        $m = $this->msg('FM-1');
        $this->assertSame('listed', $m->official);
        $this->assertSame(0, DB::table('documents')->where('message_id', $m->id)->count());
        $this->assertTrue(DB::table('audit_events')->where('message_id', $m->id)->where('action', 'like', 'Elutasított élő letöltés%')->exists());
    }

    public function test_ismeretlen_tipust_feluliro_szabaly_sem_emel_fel(): void
    {
        $this->allRules('auto_override_legal', ['unknown' => true]);
        $r = $this->ingest([['eid' => 'ISM-1', 'type' => 'Xyzzy qwerty 42']]);

        $this->assertSame(1, (int) $this->msg('ISM-1')->unknown);
        $this->assertSame([], $r['autoDownload']);
        $this->download('ISM-1')->assertOk(); // ember, kézzel letöltheti
    }

    public function test_feluliro_szabaly_ismert_kezi_tipust_felemel(): void
    {
        $this->allRules('auto_override_legal');
        $r = $this->ingest([['eid' => 'TJ-1', 'type' => 'Tájékoztatás bevallásról']]);

        $this->assertSame('nav.bevallas.tajekoztatas', $this->msg('TJ-1')->type_id);
        $this->assertCount(1, $r['autoDownload']);
        $this->assertSame('rule', $r['autoDownload'][0]['via']);
        $this->assertTrue($r['autoDownload'][0]['override']);
        $this->download('TJ-1', ['auto' => true, 'viaRuleId' => $r['autoDownload'][0]['ruleId']])->assertOk();
    }

    public function test_nyugtanak_latszo_de_mas_tipusu_irat_nem_automatikus(): void
    {
        // Minden szabály a tárgyból felismert nyugta-jelzőre illeszkedik, „automatikus nyugtákra” móddal.
        $this->allRules('auto_safe', ['receipt' => true]);
        $r = $this->ingest([['eid' => 'IG-1', 'type' => 'Igazolás köztartozásmentességről']]);

        $this->assertSame(1, (int) $this->msg('IG-1')->receipt);
        $this->assertSame([], $r['autoDownload']);
    }

    public function test_hivatali_kapubol_nincs_automatikus_letoltes(): void
    {
        $this->ingest([['eid' => 'HK-0', 'type' => 'Tájékoztatás bevallásról']]); // létrejön a hozzárendelés
        DB::table('mailboxes')->where('live_ref', self::BOX)->update(['type' => 'HK']);

        $r = $this->ingest([['eid' => 'HK-1', 'type' => 'Elfogadó nyugta – 2608 bevallás']]);
        $this->assertSame([], $r['autoDownload']);
        $this->download('HK-1', ['auto' => true])->assertStatus(422);
        $this->download('HK-1')->assertOk();
    }

    public function test_belepon_kikapcsolt_letoltes(): void
    {
        $this->ingest([['eid' => 'KI-0', 'type' => 'Tájékoztatás bevallásról']]);
        $pid = DB::table('mailboxes')->where('live_ref', self::BOX)->value('portal_connection_id');
        $this->assertNotNull($pid);
        DB::table('portal_connections')->where('id', $pid)->update(['download_active' => false]);

        $r = $this->ingest([['eid' => 'KI-1', 'type' => 'Elfogadó nyugta – 2608 bevallás']]);
        $this->assertSame([], $r['autoDownload']);
        $this->download('KI-1', ['auto' => true])->assertStatus(422);
        $this->assertSame('listed', $this->msg('KI-1')->official);
    }

    public function test_auto_jelzo_nem_automatikus_iraton_elutasitva(): void
    {
        $this->allRules('manual');
        $this->ingest([['eid' => 'AJ-1', 'type' => 'Tájékoztatás bevallásról']]);

        $this->download('AJ-1', ['auto' => true])->assertStatus(422);
        $this->assertSame('listed', $this->msg('AJ-1')->official);
        $this->assertSame(0, DB::table('documents')->where('message_id', $this->msg('AJ-1')->id)->count());
    }

    public function test_mar_letoltott_iratra_nincs_masodik_automatikus_letoltes(): void
    {
        $this->ingest([['eid' => 'KET-1', 'type' => 'Elfogadó nyugta – 2608 bevallás']]);
        $this->download('KET-1', ['auto' => true])->assertOk();
        $docs = DB::table('documents')->where('message_id', $this->msg('KET-1')->id)->count();

        $this->download('KET-1', ['auto' => true])->assertStatus(422);
        $this->assertSame($docs, DB::table('documents')->where('message_id', $this->msg('KET-1')->id)->count());
        $r = $this->ingest([['eid' => 'KET-1', 'type' => 'Elfogadó nyugta – 2608 bevallás']]);
        $this->assertSame([], $r['autoDownload']);
    }

    public function test_regi_azonositoju_tipus_kezi(): void
    {
        $office = $this->u('SN')->office_id;
        $this->assertSame('kezi', DownloadPolicy::forType($office, 'valami-ismeretlen-azonosito'));
        // A demó mintaadatok régi azonosítói a mai típusra képződnek le, így a demó is a valódi szabályt mutatja.
        $this->assertSame('csak_lista', DownloadPolicy::forType($office, 'cegbirosag-vegzes'));
        $this->assertSame('csak_lista', DownloadPolicy::forType($office, 'nav-hatarozat'));
        $this->assertSame('csak_lista', DownloadPolicy::forType($office, 'birosag'));
        $this->assertSame('kezi', DownloadPolicy::forType($office, 'nav-hianypotlas'));
        $this->assertSame('kezi', DownloadPolicy::forType($office, null));
        $this->assertSame('kezi', DownloadPolicy::forType($office, 'ismeretlen'));
        $this->assertSame('auto', DownloadPolicy::forType($office, 'nav.nyugta.elfogado'));
        $this->assertSame('csak_lista', DownloadPolicy::forType($office, 'birosag.irat'));
    }

    public function test_atsorolas_koveti_a_tipus_szabalyat(): void
    {
        $this->allRules('manual');
        $this->ingest([['eid' => 'AT-1', 'type' => 'Xyzzy qwerty 42']]);
        $id = 'm' . $this->msg('AT-1')->id;

        // Ember nyugtának sorolja: a következő listázásnál már automatikusan letölthető.
        $this->postJson("/api/messages/$id/action", ['action' => 'type', 'to' => 'NAV elfogadó nyugta'])->assertOk();
        $r = $this->ingest([['eid' => 'AT-1', 'type' => 'Xyzzy qwerty 42']]);
        $this->assertCount(1, $r['autoDownload']);
        $this->assertSame('type', $r['autoDownload'][0]['via']);

        // Ember fizetési meghagyásnak sorolja: a kézi letöltés is tiltott.
        $this->postJson("/api/messages/$id/action", ['action' => 'type', 'to' => 'Illeték: fizetési felhívás vagy meghagyás'])->assertOk();
        $this->assertSame([], $this->ingest([['eid' => 'AT-1', 'type' => 'Xyzzy qwerty 42']])['autoDownload']);
        $this->download('AT-1')->assertStatus(422);
    }

    private function setPolicy(string $who, string $typeId, string $policy)
    {
        return $this->actingAs($this->u($who))->postJson("/api/types/$typeId/policy", ['policy' => $policy]);
    }

    public function test_vezeto_szigorithat_de_nem_lazithat(): void
    {
        $this->setPolicy('SN', 'nav.nyugta.elfogado', 'kezi')->assertOk()->assertJson(['typeId' => 'nav.nyugta.elfogado', 'dlp' => 'kezi', 'dlpDefault' => 'auto']);
        $this->assertSame([], $this->ingest([['eid' => 'SZ-1', 'type' => 'Elfogadó nyugta – 2608 bevallás']])['autoDownload']);

        $this->setPolicy('SN', 'nav.illetek.fizetesi', 'kezi')->assertStatus(403);
        $this->setPolicy('SN', 'nav.bevallas.tajekoztatas', 'auto')->assertStatus(403);
        $this->assertSame('csak_lista', DownloadPolicy::forType($this->u('SN')->office_id, 'nav.illetek.fizetesi'));

        // Visszaállítás az alapértékre: újra automatikus.
        $this->setPolicy('SN', 'nav.nyugta.elfogado', 'default')->assertOk()->assertJson(['dlp' => 'auto']);
        $this->assertCount(1, $this->ingest([['eid' => 'SZ-2', 'type' => 'Elfogadó nyugta – 2608 bevallás']])['autoDownload']);
    }

    public function test_admin_lazithat_es_naplozodik(): void
    {
        $this->setPolicy('IA', 'nav.illetek.fizetesi', 'kezi')->assertOk()->assertJson(['dlp' => 'kezi', 'dlpDefault' => 'csak_lista']);
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', 'Letöltési szabály módosítva: %csak_lista → kezi')->exists());

        $this->ingest([['eid' => 'AD-1', 'type' => 'Illeték fizetési meghagyás']]);
        $this->download('AD-1')->assertOk(); // kézzel most már letölthető
    }

    public function test_konyvelo_nem_modosithat(): void
    {
        $this->setPolicy('LG', 'nav.nyugta.elfogado', 'kezi')->assertStatus(403);
        $this->assertSame(0, DB::table('document_type_overrides')->count());
    }

    public function test_feluliras_irodankent_elszigetelt_es_ismeretlen_tipus_404(): void
    {
        $this->setPolicy('IA', 'nincs.ilyen.tipus', 'kezi')->assertStatus(404);
        $this->setPolicy('IA', 'nav.nyugta.elfogado', 'ertelmetlen')->assertStatus(422);

        $this->setPolicy('IA', 'nav.nyugta.elfogado', 'csak_lista')->assertOk();
        $other = DB::table('offices')->where('id', '!=', $this->u('IA')->office_id)->value('id');
        $this->assertSame('auto', DownloadPolicy::forType($other, 'nav.nyugta.elfogado'));
        $this->assertSame('csak_lista', DownloadPolicy::forType($this->u('IA')->office_id, 'nav.nyugta.elfogado'));
    }

    public function test_allapot_tartalmazza_a_szabalyt(): void
    {
        $this->setPolicy('SN', 'nav.nyugta.elutasito', 'kezi')->assertOk();
        $this->ingest([['eid' => 'ALL-1', 'type' => 'Illeték fizetési meghagyás'], ['eid' => 'ALL-2', 'type' => 'Elfogadó nyugta – 2608 bevallás']]);
        $s = $this->actingAs($this->u('SN'))->getJson('/api/state')->assertOk()->json();

        $types = collect($s['types'])->keyBy('type_id');
        $this->assertSame(['dlp' => 'kezi', 'dlpDefault' => 'auto'], array_intersect_key($types['nav.nyugta.elutasito'], ['dlp' => 1, 'dlpDefault' => 1]));
        $this->assertSame('csak_lista', $types['birosag.irat']['dlp']);

        $msgs = collect($s['messages'])->keyBy('eid');
        $this->assertSame('csak_lista', $msgs['ALL-1']['dlp']);
        $this->assertSame('auto', $msgs['ALL-2']['dlp']);
    }

    private function check(string $eid, array $body = [], string $who = 'SN')
    {
        return $this->actingAs($this->u($who))->postJson('/api/messages/m' . $this->msg($eid)->id . '/live-download-check', $body);
    }

    /** Az asztali app a tárhelyről való letöltés ELŐTT kér engedélyt: a tiltásnak a letöltést kell megelőznie. */
    public function test_elozetes_engedelykeres_letoltes_elott(): void
    {
        $this->allRules('manual');
        $this->ingest([
            ['eid' => 'EL-1', 'type' => 'Illeték fizetési meghagyás'],
            ['eid' => 'EL-2', 'type' => 'Tájékoztatás bevallásról'],
            ['eid' => 'EL-3', 'type' => 'Elfogadó nyugta – 2608 bevallás'],
        ]);

        $this->check('EL-1')->assertStatus(422)->assertJsonFragment(['message' => 'Ezt az irattípust a program nem tölti le; a hivatalos tárhelyen vehető át.']);
        $this->check('EL-2')->assertOk()->assertJson(['ok' => true, 'dlp' => 'kezi']);
        $this->check('EL-2', ['auto' => true])->assertStatus(422);
        $this->check('EL-3', ['auto' => true])->assertOk()->assertJson(['ok' => true, 'dlp' => 'auto']);

        foreach (['EL-1', 'EL-2', 'EL-3'] as $eid) { // az engedélykérés semmit nem változtat
            $this->assertSame('listed', $this->msg($eid)->official);
            $this->assertSame(0, DB::table('documents')->where('message_id', $this->msg($eid)->id)->count());
        }

        config(['iratkapu.live_download' => false]);
        $this->check('EL-2')->assertStatus(422);
    }

    public function test_ketertelmu_targynal_a_szigorubb_tipus_nyer(): void
    {
        // A tárgyra egy nyugtatípus (auto) és a mulasztási bírság (csak lista) mintája is illik.
        $r = $this->ingest([['eid' => 'KE-1', 'type' => 'Mulasztási bírság határozat – beküldési visszaigazolás']]);

        $this->assertSame('nav.birsag.mulasztasi', $this->msg('KE-1')->type_id);
        $this->assertSame([], $r['autoDownload']);
        $this->download('KE-1')->assertStatus(422);
    }

    public function test_konyvelo_atsorolassal_nem_lazithat(): void
    {
        $this->allRules('manual');
        $this->ingest([['eid' => 'KA-1', 'type' => 'Xyzzy qwerty 42'], ['eid' => 'KA-2', 'type' => 'Illeték fizetési meghagyás']]);
        $cid = $this->msg('KA-1')->client_id;
        $konyvelo = User::where('role', 'konyvelo')->get()->first(fn ($x) => in_array($cid, \App\Iratkapu\Scope::clientIds($x)));
        $this->assertNotNull($konyvelo, 'kell egy könyvelő, aki látja az ügyfelet');
        $act = fn (string $eid, string $to) => $this->actingAs($konyvelo)->postJson('/api/messages/m' . $this->msg($eid)->id . '/action', ['action' => 'type', 'to' => $to]);

        // kézi → automatikus: lazítás, könyvelőnek tiltott
        $act('KA-1', 'NAV elfogadó nyugta')->assertStatus(403);
        $this->assertSame('ismeretlen', $this->msg('KA-1')->type_id);
        // csak lista → kézi: lazítás, könyvelőnek tiltott
        $act('KA-2', 'Bevallásról szóló tájékoztatás')->assertStatus(403);
        $this->assertSame('nav.illetek.fizetesi', $this->msg('KA-2')->type_id);
        // kézi → csak lista: szigorítás, engedett
        $act('KA-1', 'Illeték: fizetési felhívás vagy meghagyás')->assertOk();
        // azonos szigorúságú átsorolás engedett
        $this->ingest([['eid' => 'KA-3', 'type' => 'Xyzzy qwerty 43']]);
        $act('KA-3', 'Bevallásról szóló tájékoztatás')->assertOk();

        // vezető lazíthat, és a szabály változása a naplóba kerül
        $this->actingAs($this->u('SN'))->postJson('/api/messages/m' . $this->msg('KA-2')->id . '/action', ['action' => 'type', 'to' => 'Bevallásról szóló tájékoztatás'])->assertOk();
        $this->assertTrue(DB::table('audit_events')->where('message_id', $this->msg('KA-2')->id)->where('action', 'like', 'Irattípus besorolva:%letöltési szabály: csak_lista → kezi%')->exists());
    }

    public function test_tipus_szerinti_automatikus_letoltest_nem_lehet_szabalynak_tulajdonitani(): void
    {
        $this->allRules('manual');
        $this->ingest([['eid' => 'TU-1', 'type' => 'Elfogadó nyugta – 2608 bevallás']]);
        $ruleId = DB::table('rules')->where('office_id', $this->u('SN')->office_id)->value('id');

        $this->download('TU-1', ['auto' => true, 'viaRuleId' => $ruleId])->assertOk();
        $id = $this->msg('TU-1')->id;
        $this->assertFalse(DB::table('audit_events')->where('message_id', $id)->where('action', 'like', '%felülíró szabállyal%')->exists());
        $this->assertTrue(DB::table('audit_events')->where('message_id', $id)->where('action', 'Élő nyugta automatikusan letöltve az irattípus szabálya szerint')->exists());
    }

    /** Az engedély azt is megmondja, MIT szabad letölteni: az asztali főfolyamat ebből dolgozik, nem a felület által adott adatból. */
    public function test_az_engedely_tartalmazza_a_letoltendo_irat_azonositoit(): void
    {
        $this->allRules('manual');
        $this->ingest([['eid' => 'ENG-1', 'type' => 'Tájékoztatás bevallásról']]);

        $this->check('ENG-1')->assertOk()->assertJson(['ok' => true, 'eid' => 'ENG-1', 'mailbox' => self::BOX, 'folder' => 'BEERKEZETT', 'auto' => false]);
    }

    /** Kézzel feltöltött fájl után az irat már nem kerül az automatikus letöltési sorba. */
    public function test_kezi_feltoltes_utan_nincs_automatikus_letoltes(): void
    {
        $letter = ['eid' => 'FEL-1', 'type' => 'Elfogadó nyugta – 2608 bevallás'];
        $this->assertCount(1, $this->ingest([$letter])['autoDownload']);
        $id = $this->msg('FEL-1')->id;

        $file = \Illuminate\Http\UploadedFile::fake()->createWithContent('nyugta.pdf', Samples::pdf('Nyugta'));
        $this->actingAs($this->u('SN'))->post("/api/messages/m$id/upload", ['file' => $file])->assertOk();

        $this->assertSame([], $this->ingest([$letter])['autoDownload']);
        $this->download('FEL-1', ['auto' => true])->assertStatus(422);
    }

    public function test_az_engedely_a_targyat_es_a_szabalyt_is_megadja(): void
    {
        $this->allRules('manual');
        $this->ingest([['eid' => 'ENG-2', 'type' => 'Tájékoztatás bevallásról', 'desc' => 'Tájékoztatás bevallásról – 2665']]);
        $this->check('ENG-2')->assertOk()->assertJson(['subject' => 'Tájékoztatás bevallásról – 2665', 'dlp' => 'kezi', 'auto' => false]);
    }

    /** Az élő próbán megfigyelt feladó- és típuskódok felismerése: a bírósági kiadmány „csak lista”. */
    public function test_valodi_kodok_felismerese(): void
    {
        $this->allRules('auto_override_legal');
        $r = $this->ingest([
            ['eid' => 'VK-1', 'sender' => 'OBHIFORM', 'senderFull' => 'Országos Bírósági Hivatal', 'type' => 'OBH_UKE_KIADMANY', 'desc' => 'Kiadmány'],
            ['eid' => 'VK-2', 'sender' => 'IdomSoft BKSZ', 'senderFull' => 'IdomSoft Zrt.', 'type' => 'LetoltesiIgazolas', 'desc' => ''],
        ]);
        $this->assertSame('birosag.irat', $this->msg('VK-1')->type_id);
        $this->assertSame('rendszer.idomsoft', $this->msg('VK-2')->type_id);
        $this->assertSame([], array_values(array_filter($r['autoDownload'], fn ($a) => $a['eid'] === 'VK-1')));
        $this->download('VK-1')->assertStatus(422);
    }
}
