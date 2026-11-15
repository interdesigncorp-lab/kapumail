<?php
namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * Rendszerválasztó a belépőn: mely állami rendszerekbe léphet be vele a program.
 * A szerver a kikapcsolt rendszer adatát akkor is eldobja, ha az asztali app mégis beküldené.
 */
class RendszervalasztoTest extends TestCase
{
    use RefreshDatabase;
    protected bool $seed = true;

    private const MIND = ['tarhely_cegkapu', 'tarhely_personal', 'tarhely_hivatali', 'upo'];
    private const UJ = '55667780 (Új Felderített Kft)';

    protected function setUp(): void
    {
        parent::setUp();
        config(['iratkapu.live_listing' => true, 'iratkapu.live_download' => true]);
    }

    private function u(string $k): User
    {
        return User::where('initials', $k)->firstOrFail();
    }

    private function portal(?array $systems = null): int
    {
        $o = $this->u('SN');
        return DB::table('portal_connections')->insertGetId(['office_id' => $o->office_id, 'name' => 'Teszt belépő', 'auth_mode' => 'totp', 'vault_key' => 'portal-teszt-' . uniqid(),
            'download_active' => true, 'owner_user_id' => $o->id, 'enabled_systems' => $systems === null ? null : json_encode($systems), 'created_at' => now(), 'updated_at' => now()]);
    }

    private function ingest(?int $portalId, array $boxes, array $extra = [], string $type = 'Tájékoztatás bevallásról'): array
    {
        $letters = [];
        foreach ($boxes as $box => $eids) {
            foreach ($eids as $eid) {
                $letters[] = ['eid' => $eid, 'mailbox' => $box, 'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal', 'type' => $type, 'desc' => '', 'receivedAt' => '2026-11-11 08:10'];
            }
        }
        return $this->actingAs($this->u('SN'))->postJson('/api/live/ingest', ['autoMap' => true, 'portalId' => $portalId, 'letters' => $letters] + $extra)->assertOk()->json();
    }

    private function systemsOf(int $pid): array
    {
        return collect($this->actingAs($this->u('SN'))->getJson('/api/state')->json('portals'))->firstWhere('id', $pid)['systems'];
    }

    public function test_rendszerek_mentese_es_visszaolvasasa(): void
    {
        $save = fn (array $body) => $this->actingAs($this->u('SN'))->postJson('/api/portals', ['name' => 'Új belépő', 'authMode' => 'totp'] + $body);

        $pid = $save(['systems' => ['tarhely_cegkapu', 'upo']])->assertOk()->json('id');
        $this->assertSame(['tarhely_cegkapu', 'upo'], $this->systemsOf($pid));

        // Mind a négy: „minden rendszer”, üresen tárolva.
        $save(['id' => $pid, 'systems' => self::MIND])->assertOk();
        $this->assertNull(DB::table('portal_connections')->where('id', $pid)->value('enabled_systems'));
        $this->assertSame(self::MIND, $this->systemsOf($pid));

        // A mező elhagyása nem változtat a beállításon.
        $save(['id' => $pid, 'systems' => ['upo']])->assertOk();
        $save(['id' => $pid])->assertOk();
        $this->assertSame(['upo'], $this->systemsOf($pid));

        $save(['id' => $pid, 'systems' => ['tarhely_cegkapu', 'ismeretlen_rendszer']])->assertStatus(422);
        // Belépő alapból minden rendszerre szól.
        $this->assertSame(self::MIND, $this->systemsOf($save([])->json('id')));
    }

    public function test_kikapcsolt_cegkapu_levelei_es_ugyfelei_kimaradnak(): void
    {
        $pid = $this->portal(['tarhely_personal', 'tarhely_hivatali', 'upo']);
        $clients = DB::table('clients')->count();
        $messages = DB::table('messages')->count();

        $r = $this->ingest($pid, [self::UJ => ['C-1', 'C-2'], '24817365 Borostyán Pékség Kft.' => ['C-3']]);

        $this->assertSame(3, $r['systemOff']);
        $this->assertSame([0, 0], [$r['created'], $r['unmapped']]);
        $this->assertSame(['created' => 0, 'attached' => 0, 'pending' => 0, 'own' => 0], $r['discovery']);
        $this->assertSame([$clients, $messages, 0], [DB::table('clients')->count(), DB::table('messages')->count(), DB::table('discovered_mailboxes')->count()]);
        $this->assertFalse(DB::table('mailboxes')->where('live_ref', '24817365 Borostyán Pékség Kft.')->exists());
    }

    public function test_mar_hozzarendelt_postafiok_fajtajat_a_tarhely_tipusa_adja(): void
    {
        $mind = $this->portal();
        $this->ingest($mind, [self::UJ => ['T-1']]); // felderítve: Cégkapu
        $csakSajat = $this->portal(['tarhely_personal']);

        $r = $this->ingest($csakSajat, [self::UJ => ['T-1', 'T-2']]);
        $this->assertSame([0, 0, 2], [$r['created'], $r['known'], $r['systemOff']]);
    }

    public function test_ismeretlen_fajtaju_postafiok_kimarad_ha_barmelyik_tarhely_ki_van_kapcsolva(): void
    {
        $pid = $this->portal(['tarhely_cegkapu', 'tarhely_hivatali', 'upo']); // a saját tárhely kikapcsolva
        $r = $this->ingest($pid, ['Értesítési tárhely' => ['S-1'], self::UJ => ['S-2']]);

        $this->assertSame([1, 1], [$r['created'], $r['systemOff']]); // a Cégkapu megy, az ismeretlen kimarad
        $this->assertSame(['created' => 1, 'attached' => 0, 'pending' => 0, 'own' => 0], $r['discovery']);
        $this->assertSame(0, DB::table('discovered_mailboxes')->count());

        // Ha mindhárom tárhely-rendszer engedélyezett, az ismeretlen a „Besorolásra vár” listába kerül.
        $r2 = $this->ingest($this->portal(['tarhely_cegkapu', 'tarhely_personal', 'tarhely_hivatali']), ['Értesítési tárhely' => ['S-1']]);
        $this->assertSame([0, 1], [$r2['systemOff'], $r2['discovery']['pending']]);
    }

    public function test_belepo_megadasa_nelkul_nincs_szures(): void
    {
        $this->portal(['upo']);
        $r = $this->ingest(null, ['24817365 Borostyán Pékség Kft.' => ['N-1']]);
        $this->assertSame([1, 0], [$r['created'], $r['systemOff']]);
    }

    public function test_kikapcsolt_nav_adata_elutasitva(): void
    {
        $pid = $this->portal(['tarhely_cegkapu']);
        $n = DB::table('tax_obligations')->count();
        $body = ['subject' => ['stem' => '24817365', 'taxId' => null], 'obligations' => [['formCode' => '2665', 'title' => 'Áfa', 'dueDate' => '2026-12-20']]];

        $this->actingAs($this->u('SN'))->postJson('/api/nav/ingest', ['portalId' => $pid] + $body)->assertStatus(422);
        $this->assertSame($n, DB::table('tax_obligations')->count());

        $this->postJson('/api/nav/ingest', ['portalId' => $this->portal()] + $body)->assertOk();
        $this->assertSame($n + 1, DB::table('tax_obligations')->count());
    }

    public function test_elo_listazas_bekerul_a_szinkronnaploba(): void
    {
        $pid = $this->portal();
        $maxId = (int) DB::table('sync_runs')->max('id');
        $this->ingest($pid, [self::UJ => ['L-1', 'L-2'], '24817365 Borostyán Pékség Kft.' => ['L-3']]);

        $runs = DB::table('sync_runs')->where('id', '>', $maxId)->get();
        $this->assertCount(2, $runs);
        $uj = $runs->firstWhere('mailbox_id', DB::table('mailboxes')->where('live_ref', self::UJ)->value('id'));
        $this->assertSame(['ok', 2, 2, 'Szalai Nóra'], [$uj->state, (int) $uj->listed, (int) $uj->created, $uj->actor]);

        // Ütemezett futás: a naplóban látszik, kinek a nevében ment.
        $this->ingest($pid, [self::UJ => ['L-1', 'L-2', 'L-4']], ['source' => 'scheduled']);
        $last = DB::table('sync_runs')->orderByDesc('id')->first();
        $this->assertSame(['ütemezett, Szalai Nóra nevében', 3, 1], [$last->actor, (int) $last->listed, (int) $last->created]);
    }

    public function test_egy_futasban_legfeljebb_otven_automatikus_letoltes(): void
    {
        $eids = array_map(fn ($i) => "NY-$i", range(1, 60));
        $r = $this->ingest($this->portal(), [self::UJ => $eids], [], 'Elfogadó nyugta – 2608 bevallás');

        $this->assertSame(60, $r['created']);
        $this->assertCount(50, $r['autoDownload']);
        $this->assertSame(10, $r['autoDownloadDeferred']);
    }

    /** A listázás óta megváltozott beállítás a letöltés pillanatában is számít: az engedélykérés újra ellenőrzi. */
    public function test_automatikus_letoltes_engedelye_ujra_ellenorzi_az_ugyfelet_a_rendszert_es_a_belepot(): void
    {
        $pid = $this->portal();
        $r = $this->ingest($pid, [self::UJ => ['EN-1']], [], 'Elfogadó nyugta – 2608 bevallás');
        $mid = $r['autoDownload'][0]['id'];
        $key = DB::table('portal_connections')->where('id', $pid)->value('vault_key');
        $check = fn (array $body = []) => $this->actingAs($this->u('SN'))->postJson("/api/messages/$mid/live-download-check", ['auto' => true] + $body);

        $check(['portalKey' => $key])->assertOk();

        // másik belépő nevében nem megy: a letöltés annak a belépőnek a munkamenetével történne
        $other = DB::table('portal_connections')->where('id', $this->portal())->value('vault_key');
        $check(['portalKey' => $other])->assertStatus(422);
        $check(['portalKey' => 'nincs-ilyen'])->assertStatus(422);

        // a Cégkapu kikapcsolva a belépőn
        DB::table('portal_connections')->where('id', $pid)->update(['enabled_systems' => json_encode(['tarhely_personal'])]);
        $check(['portalKey' => $key])->assertStatus(422);
        DB::table('portal_connections')->where('id', $pid)->update(['enabled_systems' => null]);
        $check(['portalKey' => $key])->assertOk();

        // az ügyfél inaktív
        $cid = DB::table('mailboxes')->where('live_ref', '55667780')->orWhere('live_ref', self::UJ)->value('client_id');
        DB::table('clients')->where('id', $cid)->update(['active' => false]);
        $check(['portalKey' => $key])->assertStatus(422);
    }

    /** A korábban sorra nem került automatikus letöltés akkor is visszajön, ha a (növekményes) lista már nem tartalmazza a levelet. */
    public function test_a_hatralevo_automatikus_letoltesek_a_kovetkezo_szinkronnal_is_sorra_kerulnek(): void
    {
        $pid = $this->portal();
        $first = $this->ingest($pid, [self::UJ => ['HL-1', 'HL-2']], [], 'Elfogadó nyugta – 2608 bevallás');
        $this->assertCount(2, $first['autoDownload']);

        // növekményes futás: csak egy új, nem automatikus levél van a listán
        $next = $this->ingest($pid, [self::UJ => ['HL-3']]);
        $this->assertSame(['HL-1', 'HL-2'], array_column($next['autoDownload'], 'eid'));
        $this->assertSame(array_column($first['autoDownload'], 'id'), array_column($next['autoDownload'], 'id'));

        // másik belépő futása nem hozza elő
        $this->assertSame([], $this->ingest($this->portal(), ['99887766 (Másik Kft)' => ['HL-9']])['autoDownload']);

        // inaktív ügyfél hátraléka sem jön elő
        $cid = DB::table('mailboxes')->where('portal_connection_id', $pid)->value('client_id');
        DB::table('clients')->where('id', $cid)->update(['active' => false]);
        $this->assertSame([], $this->ingest($pid, [self::UJ => ['HL-4']])['autoDownload']);
    }

    /** A tárhely saját típusneve megmarad, és a később megismert minta a már bent lévő, még besorolatlan iratot is besorolja. */
    public function test_a_tarhely_tipusneve_megmarad_es_az_ismeretlen_irat_ujra_besorolodik(): void
    {
        $pid = $this->portal();
        $letter = fn (string $eid, string $type, string $desc) => ['eid' => $eid, 'mailbox' => self::UJ, 'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal', 'type' => $type, 'desc' => $desc, 'receivedAt' => '2026-11-11 08:10'];
        $send = fn (array $letters) => $this->actingAs($this->u('SN'))->postJson('/api/live/ingest', ['autoMap' => true, 'portalId' => $pid, 'letters' => $letters])->assertOk()->json();
        $send([$letter('TN-1', 'Kitalált Fajta', '12345678 - Valami Kft'), $letter('TN-2', 'Kitalált Fajta', '12345678 - Valami Kft')]);

        $m = DB::table('messages')->where('source_id', 'live-TN-1')->first();
        $this->assertSame(['ismeretlen', 'Kitalált Fajta', 1], [$m->type_id, $m->live_type, (int) $m->unknown]);
        $row = collect($this->actingAs($this->u('SN'))->getJson('/api/state')->json('messages'))->firstWhere('eid', 'TN-1');
        $this->assertSame('Kitalált Fajta', $row['liveType']);

        // a második iratot ember sorolta be: ahhoz a program már nem nyúl
        DB::table('messages')->where('source_id', 'live-TN-2')->update(['unknown' => false, 'type_id' => 'nav.koma', 'type_label' => 'kézzel']);
        // a típuslista megismeri a fajtát
        $t = DB::table('document_types')->where('type_id', 'nav.tajekoztatas.altalanos')->first();
        DB::table('document_types')->where('id', $t->id)->update(['patterns' => json_encode(array_merge(json_decode($t->patterns, true), ['kitalált fajta']), JSON_UNESCAPED_UNICODE)]);
        \App\Iratkapu\Taxonomy::flush();

        $r = $send([$letter('TN-1', 'Kitalált Fajta', '12345678 - Valami Kft'), $letter('TN-2', 'Kitalált Fajta', '12345678 - Valami Kft')]);
        $this->assertSame(2, $r['known']);
        $m = DB::table('messages')->where('source_id', 'live-TN-1')->first();
        $this->assertSame(['nav.tajekoztatas.altalanos', 0], [$m->type_id, (int) $m->unknown]);
        $this->assertSame('nav.koma', DB::table('messages')->where('source_id', 'live-TN-2')->value('type_id'));
    }

    /** Az iroda saját irattípust vehet fel kulcsszavakkal: elsőbbséget élvez, a bent lévő gépi besorolású iratot is átsorolja, törléskor visszaáll. */
    public function test_sajat_irattipus_felvetele_atsorol_es_torleskor_visszaall(): void
    {
        \App\Iratkapu\Taxonomy::flush();
        $pid = $this->portal();
        $letter = fn (string $eid, string $type, string $desc) => ['eid' => $eid, 'mailbox' => self::UJ, 'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal', 'type' => $type, 'desc' => $desc, 'receivedAt' => '2026-11-11 08:10'];
        $send = fn (array $letters) => $this->actingAs($this->u('SN'))->postJson('/api/live/ingest', ['autoMap' => true, 'portalId' => $pid, 'letters' => $letters])->assertOk()->json();
        $type = fn (string $eid) => DB::table('messages')->where('source_id', "live-$eid")->value('type_id');
        $send([$letter('ST-1', 'Sosemvolt Jelleg', 'Zöldövezeti díj kivetése'), $letter('ST-2', 'Bevallás', 'Minta Zrt. - Értesítés - Tájékoztatás a zöldövezeti díjról'), $letter('ST-3', 'Sosemvolt Jelleg', 'Semmi különös')]);
        $this->assertSame(['ismeretlen', 'nav.bevallas.tajekoztatas', 'ismeretlen'], [$type('ST-1'), $type('ST-2'), $type('ST-3')]);
        // a harmadikat ember sorolta be: ahhoz a program nem nyúl
        DB::table('messages')->where('source_id', 'live-ST-3')->update(['unknown' => false, 'type_ai' => false, 'type_id' => 'nav.koma', 'subject' => 'Zöldövezeti díj – kézzel besorolva']);

        // könyvelő nem vehet fel típust; a túl rövid kulcsszó és az automatikus letöltés elutasítva
        $konyvelo = \App\Models\User::where('role', 'konyvelo')->first();
        $this->actingAs($konyvelo)->postJson('/api/types', ['label' => 'Zöldövezeti díj', 'patterns' => 'zöldövezeti díj', 'policy' => 'kezi'])->assertStatus(403);
        $this->actingAs($this->u('SN'))->postJson('/api/types', ['label' => 'Zöldövezeti díj', 'patterns' => 'zö', 'policy' => 'kezi'])->assertStatus(422);
        $this->actingAs($this->u('SN'))->postJson('/api/types', ['label' => 'Zöldövezeti díj', 'patterns' => 'zöldövezeti díj', 'policy' => 'auto'])->assertStatus(422);

        $r = $this->actingAs($this->u('SN'))->postJson('/api/types', ['label' => 'Zöldövezeti díj', 'patterns' => 'zöldövezeti díj; zöldövezeti díjról', 'policy' => 'csak_lista'])->assertOk()->json();
        $id = $r['typeId'];
        $this->assertSame(2, $r['retyped']);
        $this->assertSame([$id, $id, 'nav.koma'], [$type('ST-1'), $type('ST-2'), $type('ST-3')]);
        $m = DB::table('messages')->where('source_id', 'live-ST-1')->first();
        $this->assertSame(['Zöldövezeti díj', 0, 1], [$m->type_label, (int) $m->unknown, (int) $m->type_ai]);
        $this->assertSame('csak_lista', \App\Iratkapu\DownloadPolicy::forType($m->office_id, $id));
        $row = collect($this->actingAs($this->u('SN'))->getJson('/api/state')->json('types'))->firstWhere('type_id', $id);
        $this->assertSame([true, 'Saját típusok', ['zöldövezeti díj', 'zöldövezeti díjról']], [$row['custom'], $row['group'], $row['patterns']]);
        // új levél is a saját típusba kerül; másik iroda nem látja és nem törölheti
        $send([$letter('ST-4', 'Sosemvolt Jelleg', 'Zöldövezeti díj kivetése 2.')]);
        $this->assertSame($id, $type('ST-4'));
        $other = \App\Models\User::where('email', 'kk@masik.test')->first();
        $this->assertNull(collect($this->actingAs($other)->getJson('/api/state')->json('types'))->firstWhere('type_id', $id));
        $this->actingAs($other)->deleteJson('/api/types/' . $id)->assertStatus(404);
        // azonos név kétszer nem vehető fel
        $this->actingAs($this->u('SN'))->postJson('/api/types', ['label' => 'Zöldövezeti díj', 'patterns' => 'valami más', 'policy' => 'kezi'])->assertStatus(422);

        // törlés: az iratok a többi típus szerint sorolódnak vissza
        $this->actingAs($this->u('SN'))->deleteJson('/api/types/' . $id)->assertOk();
        $this->assertSame(['ismeretlen', 'nav.bevallas.tajekoztatas', 'nav.koma', 'ismeretlen'], [$type('ST-1'), $type('ST-2'), $type('ST-3'), $type('ST-4')]);
        $this->assertSame(1, (int) DB::table('messages')->where('source_id', 'live-ST-1')->value('unknown'));
    }

    /** Ha egyetlen minta sem illik: a feladó, a tárhely típusneve (ügycsoport) és a tárgy fajtát jelölő szava együtt ad típust. */
    public function test_okos_besorolas_feladobol_ugycsoportbol_es_a_targy_fajtajabol(): void
    {
        \App\Iratkapu\Taxonomy::flush();
        $nav = fn (string $type, string $desc) => (\App\Iratkapu\Taxonomy::classify("$type $desc", 'NAV Nemzeti Adó- és Vámhivatal')->type_id ?? null);
        // ügycsoport × fajta
        $this->assertSame('nav.bevallas.tajekoztatas', $nav('Bevallás', '12345678 - Minta Zrt. - Értesítés - Tájékoztatás'));
        $this->assertSame('nav.bevallas.intezkedes', $nav('Bevallás', '12345678 - Minta Zrt. - Értesítés - Intézkedés'));
        $this->assertSame('nav.rendelkezes.tajekoztatas', $nav('Rendelkezés, felajánlás', '8123456789 - MINTA BÉLA - Értesítés'));
        $this->assertSame('nav.igazolas.kiadott', $nav('Egyéb NAV irat', '12345678 - Minta Zrt. - Igazolás'));
        $this->assertSame('nav.tajekoztatas.altalanos', $nav('Tájékoztató - 2020. évi SZJA', 'Tájékoztatás a 2020. évi szja-ról'));
        $this->assertSame('nav.azonositatlan_kod', $nav('Nyu620762721202505051152388412', 'Nyu620762721202505051152388412'));
        // a kikövetkeztetett döntés jellegű irat mindig „csak lista” típusba kerül
        foreach ([$nav('Valami új ügycsoport', 'Minta Zrt. - Határozat'), $nav('Bevallás', 'Minta Zrt. - Végzés'), $nav('Rendelkezés, felajánlás', 'Minta Zrt. - Elutasító határozat')] as $t) {
            $this->assertSame('csak_lista', DB::table('document_types')->where('type_id', $t)->value('download_policy'), (string) $t);
        }
        // jel nélkül a NAV-irat is ismeretlen marad
        $this->assertNull($nav('Kitalált Fajta', '12345678 - Valami Kft'));

        // más feladó: a szervezetcsalád gyűjtőtípusa, döntésnél a szigorú típus
        $is = fn (string $text, string $sender) => (\App\Iratkapu\Taxonomy::classify($text, $sender)->type_id ?? null);
        $this->assertSame('hatosag.egyeb', $is('küldemény küldemény', 'NMHH Nemzeti Média- és Hírközlési Hatóság'));
        $this->assertSame('hatosag.egyeb', $is('PDF 12345678.pdf', 'KSHG NEM CÍMEZHETŐ KSH technikai HK'));
        $this->assertSame('onk.irat.egyeb', $is('felhivas Minta Zrt. felhívás ()', 'Mintafalvi Polgármesteri Hivatal'));
        $this->assertSame('altalanos.hatarozat_vegzes', $is('314/2026/HAT Megszüntetés', 'Mintaváros Önkormányzata'));
        $this->assertNull($is('küldemény', 'Sosemvolt Szervezet'));
    }

    /** Az élő tárhelyen megfigyelt megfogalmazások (2026-11-13) besorolása; a kétes eset a szigorúbb irányba esik. */
    public function test_elo_tarhelyen_megfigyelt_megfogalmazasok_besorolasa(): void
    {
        $is = fn (string $text) => (\App\Iratkapu\Taxonomy::classify($text)->type_id ?? null);
        $this->assertSame('nav.folyoszamla.ertesites', $is('12345678 - MINTA BÉLA - Tájékoztatás az adószámláról'));
        $this->assertSame('nav.rendelkezes.tajekoztatas', $is('Tájékoztatás a felajánlott összeg kiutalásáról, és a kedvezményezettek'));
        $this->assertSame('nav.adoalany.hatarozat', $is('12345678 - MINTA BÉLA - I. fokú határozat'));
        $this->assertSame('hatosag.neak', $is('Tájékoztatás jogviszony változásról'));
        $this->assertSame('hatosag.egyeb', $is('Igazolás kamarai hozzájárulás megfizetéséről'));
        $this->assertSame('kulso.fizetesi_felszolitas', $is('Felszólítás kamarai hozzájárulás megfizetésére - folyószámla egyeztetés'));
        $this->assertSame('obh.beszamolo', $is('2025.01.01-2025.12.31, Általános üzleti évet záró, Egyszerűsített éves beszámoló'));
        $this->assertSame('ceg.nyilvantartas', $is('Értesítés cégkapu regisztrációról'));
        $this->assertSame('rny.rendelkezes', $is('Értesítés rendelkezés létrehozásáról'));
        $this->assertSame('hatosag.egyeb', $is('Védjegy lajstromozása'));
        $this->assertSame('nav.vh.foglalas_letiltas', $is('12345678 - Valami Kft - Munkabérletiltás visszavonása'));
        $this->assertSame('nav.vh.foglalas_letiltas', $is('12345678 - Valami Kft - Munkabér letiltás'));
        $this->assertSame('nav.eljaras.megszunteto_vegzes', $is('12345678 - Valami Kft - Eljárás megszüntető végzés'));
        $this->assertSame('nav.bevallas.tajekoztatas', $is('12345678 - Valami Kft - Értesítés bevallás továbbításáról'));
        $this->assertNull($is('Megszüntetés'), 'egyetlen általános szóból nem találgatunk');
        $this->assertNull($is('Bevallás 12345678 - Valami Kft'));
    }

    /** Belépő megjelölése nélkül (pl. újrahitelesítéskor) a postafiók saját belépőjének beállítása dönt. */
    public function test_belepo_megjelolese_nelkul_a_postafiok_sajat_belepoje_dont(): void
    {
        $pid = $this->portal();
        $this->ingest($pid, [self::UJ => ['SB-1']]); // felderítve, a postafiók ehhez a belépőhöz tartozik
        DB::table('portal_connections')->where('id', $pid)->update(['enabled_systems' => json_encode(['tarhely_personal'])]); // a Cégkapu kikapcsolva

        $r = $this->ingest(null, [self::UJ => ['SB-1', 'SB-2']]);
        $this->assertSame([0, 0, 2], [$r['created'], $r['known'], $r['systemOff']]);
    }

    public function test_kikapcsolt_rendszer_kvotaja_sem_kerul_be(): void
    {
        $pid = $this->portal();
        $this->ingest($pid, [self::UJ => ['KV-1']], ['quotas' => [self::UJ => 11.0]]);
        $this->assertSame(11.0, (float) DB::table('mailboxes')->where('live_ref', self::UJ)->value('quota_pct'));
        DB::table('portal_connections')->where('id', $pid)->update(['enabled_systems' => json_encode(['tarhely_personal'])]);

        $this->ingest($pid, [], ['quotas' => [self::UJ => 77.0]]);
        $this->ingest(null, [], ['quotas' => [self::UJ => 88.0]]);
        $this->assertSame(11.0, (float) DB::table('mailboxes')->where('live_ref', self::UJ)->value('quota_pct'));
    }

    public function test_nav_adat_belepo_megadasa_nelkul_nem_fogadhato(): void
    {
        $n = DB::table('tax_obligations')->count();
        $this->actingAs($this->u('SN'))->postJson('/api/nav/ingest', ['subject' => ['stem' => '24817365'], 'obligations' => [['formCode' => '2665', 'title' => 'Áfa', 'dueDate' => '2026-12-20']]])->assertStatus(422);
        $this->assertSame($n, DB::table('tax_obligations')->count(), 'belépő nélkül nem dönthető el, hogy a NAV-rendszer be van-e kapcsolva');
        $this->postJson('/api/live/upo-ingest', [])->assertStatus(404); // a régi, belépőhöz nem kötött fogadó megszűnt
    }

    /** A postafiók fajtáját a tárhely saját típuskódja adja (AP = saját tárhely, CKP = Cégkapu); ismeretlen kódnál nem találgatunk. */
    public function test_a_tarhely_tipuskodja_donti_el_a_postafiok_fajtajat(): void
    {
        $pid = $this->portal(['tarhely_cegkapu', 'tarhely_hivatali', 'upo']); // a saját tárhely kikapcsolva
        $own = 'értesítési tárhely · 1a2b3c4d';
        $letters = fn (string $box, string $eid) => ['eid' => $eid, 'mailbox' => $box, 'sender' => 'NAV', 'senderFull' => 'NAV', 'type' => 'Tájékoztatás bevallásról', 'desc' => '', 'receivedAt' => '2026-11-11 08:10'];
        $r = $this->actingAs($this->u('SN'))->postJson('/api/live/ingest', ['autoMap' => true, 'portalId' => $pid,
            'mailboxes' => [['name' => $own, 'displayName' => 'értesítési tárhely', 'type' => 'AP', 'isDefault' => true], ['name' => '55667780', 'displayName' => 'Új Kft', 'type' => 'CKP', 'isDefault' => false]],
            'letters' => [$letters($own, 'TK-1'), $letters('55667780', 'TK-2')]])->assertOk()->json();

        $this->assertSame([1, 1], [$r['created'], $r['systemOff']]);
        $this->assertSame(0, $r['discovery']['own']);
        $this->assertSame(0, DB::table('clients')->where('discovered_via', 'own')->count());
        $this->assertSame(0, DB::table('discovered_mailboxes')->count());
    }

    /** Mind a 41 tizenöt napos joghatályú tárhely-boríték pontosan a saját 15 napos, „csak lista” típusába kerül letöltés előtt. */
    public function test_joghatalyos_41_boritek_letoltes_elotti_pontos_besorolasa(): void
    {
        \App\Iratkapu\Taxonomy::flush();
        \App\Iratkapu\TypeSettings::flush();

        $expected41 = [
            ['CEGS Céginformációs Szolgálat', 'Cégbíróság végzés', 'Cg.01-09-123456/12 Végzés', 'ceg.cegbirosag.vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Egyéb NAV irat', '12345678 - Minta Kft. - kézbesítés vélelmezés', 'nav.kezbesitesi_velelem'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Adóalany nyilvántartás', '12345678 - Minta Kft. - Elutasító határozat', 'nav.adoalany.hatarozat'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Adóalany nyilvántartás', '12345678 - Minta Kft. - I. fokú határozat', 'nav.adoalany.hatarozat'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Adóalany nyilvántartás', '12345678 - Minta Kft. - KATA megszüntető határozat', 'nav.adoalany.hatarozat'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Átvezetés', '12345678 - Minta Kft. - Elutasító határozat', 'nav.folyoszamla.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Átvezetés', '12345678 - Minta Kft. - I. fokú határozat', 'nav.folyoszamla.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Bevallás', '12345678 - Minta Kft. - Mulasztási bírság határozat', 'nav.birsag.mulasztasi'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Ellenőrzés', '12345678 - Minta Kft. - Eljárási bírság kiszabása', 'nav.ellenorzes.hatarozat_birsag'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Ellenőrzés', '12345678 - Minta Kft. - Eljárást megszüntető végzés', 'nav.ellenorzes.eljarasi_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Ellenőrzés', '12345678 - Minta Kft. - Mulasz.bírság határozat', 'nav.ellenorzes.hatarozat_birsag'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Engedélyezés', '12345678 - Minta Kft. - I. fokú határozat', 'nav.adoalany.hatarozat'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Fiz.kedv. Eljárás', '12345678 - Minta Kft. - Eljárást megszüntető végzés', 'nav.fizkedv.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Fiz.kedv. Eljárás', '12345678 - Minta Kft. - Elutasító határozat', 'nav.fizkedv.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Fiz.kedv. Eljárás', '12345678 - Minta Kft. - I. fokú határozat', 'nav.fizkedv.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Fiz.kedv. Eljárás', '12345678 - Minta Kft. - Végzés', 'nav.fizkedv.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Folyószámla rendezés', '12345678 - Minta Kft. - I. fokú határozat', 'nav.folyoszamla.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Adómegállapítás', '12345678 - Minta Kft. - Gépjárműadó határozat', 'nav.gepjarmuado'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Adóhatósági és egyéb igazolás', '12345678 - Minta Kft. - Eljárás megszüntető végzés', 'nav.igazolas.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Adóhatósági és egyéb igazolás', '12345678 - Minta Kft. - Elutasító végzés', 'nav.igazolas.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Adóhatósági és egyéb igazolás', '12345678 - Minta Kft. - Igazolást megtagadó határozat', 'nav.igazolas.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Illeték', '12345678 - Minta Kft. - I. fokú határozat', 'nav.illetek.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Illeték', '12345678 - Minta Kft. - Kijavító határozat', 'nav.illetek.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Illeték', '12345678 - Minta Kft. - Végzés', 'nav.illetek.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Illeték', '12345678 - Minta Kft. - Végzés kijavítása', 'nav.illetek.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Illeték', '12345678 - Minta Kft. - Illeték fizetési meghagyás', 'nav.illetek.fizetesi'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Jövedéki ügy', '12345678 - Minta Kft. - I. fokú határozat', 'nav.jovedek.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Jövedéki ügy', '12345678 - Minta Kft. - Végzés', 'nav.jovedek.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Adóalany nyilvántartás', '12345678 - Minta Kft. - Mulasztási bírság', 'nav.birsag.mulasztasi'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Rendelkezés, felajánlás', '12345678 - Minta Kft. - Elutasító határozat', 'nav.rendelkezes.hatarozat'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Számviteli beszámoló', '12345678 - Minta Kft. - Határozat visszavonása', 'nav.beszamolo.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Számviteli beszámoló', '12345678 - Minta Kft. - Mulasz.bírság határozat', 'nav.beszamolo.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Számviteli beszámoló', '12345678 - Minta Kft. - Végzés', 'nav.beszamolo.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Vámigazgatás', '12345678 - Minta Kft. - Határozat', 'nav.vam.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Vámigazgatás', '12345678 - Minta Kft. - I. fokú határozat', 'nav.vam.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Vámigazgatás', '12345678 - Minta Kft. - Végzés', 'nav.vam.hatarozat_vegzes'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Végrehajtás/hátralékkezelés', '12345678 - Minta Kft. - Végrehajtási költségátalány', 'nav.vh.vegzes_koltseg'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Végrehajtás/hátralékkezelés', '12345678 - Minta Kft. - Végrehajtási költségminimum', 'nav.vh.vegzes_koltseg'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Végrehajtás/hátralékkezelés', '12345678 - Minta Kft. - Végzés SHK visszavonása', 'nav.vh.vegzes_koltseg'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Végrehajtás/hátralékkezelés', '12345678 - Minta Kft. - Végzés visszavonása', 'nav.vh.vegzes_koltseg'],
            ['NAV Nemzeti Adó- és Vámhivatal', 'Végrehajtás/hátralékkezelés', '12345678 - Minta Kft. - Vh. összeg felosztási terv', 'nav.vh.vegzes_koltseg'],
        ];
        $this->assertCount(41, $expected41);

        foreach ($expected41 as [$sender, $liveType, $desc, $expectedType]) {
            $hit = \App\Iratkapu\Taxonomy::classify("$liveType $desc", $sender, null, false, '', $liveType);
            $this->assertNotNull($hit, "$liveType | $desc");
            $this->assertSame($expectedType, $hit->type_id, "$liveType | $desc");
            $this->assertSame('csak_lista', $hit->download_policy, "$liveType | $desc");
            $this->assertSame(15, \App\Iratkapu\TypeSettings::defaultsFor($hit->type_id)['legalDays'], "$liveType | $desc");
        }

        // Az ellenőrzési felhívó végzések nem csúsznak be a 15 napos fellebbezésű határozat/bírság típusba, hanem a saját felhívás típusba kerülnek
        foreach ([
            'Bizonyítékok, tények előterjesztésére felhívó végzés',
            'Iratbemutatásra felhívó végzés',
            'Iratok, nyilvántartások rendezésére, pótlására, javítására kötelező végzés',
            'Iratrendezésre kötelező végzés',
        ] as $desc) {
            $hit = \App\Iratkapu\Taxonomy::classify("Ellenőrzés 12345678 - Minta Kft. - $desc", 'NAV Nemzeti Adó- és Vámhivatal');
            $this->assertSame('nav.ellenorzes.felhivas', $hit->type_id ?? null, $desc);
            $this->assertSame('csak_lista', $hit->download_policy ?? null, $desc);
            $this->assertNull(\App\Iratkapu\TypeSettings::defaultsFor($hit->type_id)['legalDays'], $desc);
        }

        // Jogutód nélküli megszűnés fizetési felhívása sem marad a „kézi” értesítési gyűjtőben
        $hit = \App\Iratkapu\Taxonomy::classify('Jogutód nélküli megszűnés 12345678 - Minta Kft. - Fizetési felhívás', 'NAV');
        $this->assertSame('nav.megszunes.fizetesi_felhivas', $hit->type_id ?? null);
        $this->assertSame('csak_lista', $hit->download_policy ?? null);
    }
}
