<?php

namespace Tests\Feature;

use App\Iratkapu\ClientDiscovery;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * NAV ügyfélportál, „A kör” (ADR-010): az asztali app a belépő saját nevében kiolvasott adatokat küldi be.
 * A szerver ebből ügyfelet magától nem hoz létre: a képviselt adózókból ajánlat lesz, az adószámla pillanatkép.
 */
class NavPortalTest extends TestCase
{
    use RefreshDatabase;

    protected bool $seed = true;

    private int $pid;

    protected function setUp(): void
    {
        parent::setUp();
        // A tesztek a kapcsolók kikapcsolt alapállapotából indulnak, függetlenül a gép saját .env beállításától.
        config(['iratkapu.nav_switch' => false, 'iratkapu.nav_queries' => false, 'iratkapu.nav_exports' => false]);
        $lg = $this->u('LG');
        $this->pid = DB::table('portal_connections')->insertGetId(['office_id' => $lg->office_id, 'name' => 'LG saját belépője', 'auth_mode' => 'totp', 'vault_key' => 'portal-lg-nav',
            'download_active' => true, 'owner_user_id' => $lg->id, 'created_at' => now(), 'updated_at' => now()]);
    }

    private function u(string $k): User
    {
        return User::where('initials', $k)->firstOrFail();
    }

    private function body(array $extra = []): array
    {
        return $extra + ['portalId' => $this->pid, 'user' => ['name' => 'LAKATOS GERGŐ', 'taxId' => '8499999999'],
            'profiles' => [
                ['id' => 1, 'name' => 'BOROSTYÁN PÉKSÉG KFT', 'stem' => '24817365', 'taxNumber' => '24817365-2-13', 'taxId' => null, 'kind' => 'SZERVEZET'], // már ügyfél
                ['id' => 2, 'name' => 'ÚJ KÉPVISELT ZRT', 'stem' => '55667788', 'taxNumber' => '55667788-2-41', 'taxId' => null, 'kind' => 'SZERVEZET'],
                ['id' => 3, 'name' => 'MINTA BÉLA', 'stem' => null, 'taxNumber' => null, 'taxId' => '8412345678', 'kind' => 'MAGANSZEMELY'],
                ['id' => 4, 'name' => 'LAKATOS GERGŐ', 'stem' => null, 'taxNumber' => null, 'taxId' => '8499999999', 'kind' => 'MAGANSZEMELY'], // ő maga
            ],
            'account' => ['total' => -25000, 'debt' => 0, 'surplus' => 25000, 'deposit' => 0, 'unbooked' => 0],
            'missingCount' => 1, 'futureCount' => 2, 'calendarCount' => 3];
    }

    private function ingest(string $who = 'LG', array $extra = [])
    {
        return $this->actingAs($this->u($who))->postJson('/api/nav/ingest', $this->body($extra));
    }

    public function test_kepviselt_adozokbol_ajanlat_lesz_ugyfel_magatol_nem(): void
    {
        $before = DB::table('clients')->count();
        $r = $this->ingest()->assertOk()->json();
        $this->assertSame([1, 2], [$r['known'], $r['suggested']]);
        $this->assertSame($before, DB::table('clients')->count(), 'ügyfél magától nem jön létre');

        $s = collect($this->actingAs($this->u('LG'))->getJson('/api/state')->json('subjects'))->keyBy('identifier');
        $this->assertEqualsCanonicalizing(['55667788', '8412345678'], $s->keys()->all(), 'az ismert ügyfél és a belépő saját maga nem ajánlat');
        $this->assertSame(['business', 'Új Képviselt Zrt', 'nav'], [$s['55667788']['kind'], $s['55667788']['name'], $s['55667788']['source']]);
        $this->assertSame('person', $s['8412345678']['kind']);
        $this->assertNotNull(DB::table('clients')->where('tax', '24817365-2-13')->value('nav_seen_at'), 'az ismert ügyfélnél rögzül, hogy a NAV szerint képviselt');

        // újra beküldve nem kettőződik, és az elbírált ajánlat nem jön vissza
        $id = $s['55667788']['id'];
        $this->actingAs($this->u('LG'))->postJson("/api/discovered-subjects/$id", ['action' => 'ignore'])->assertOk();
        $r = $this->ingest()->assertOk()->json();
        $this->assertSame(1, DB::table('discovered_subjects')->where('identifier', '55667788')->count());
        $this->assertSame(['8412345678'], collect($this->actingAs($this->u('LG'))->getJson('/api/state')->json('subjects'))->pluck('identifier')->all());
    }

    public function test_adoszamla_pillanatkep_a_belepo_gazdajanal_latszik_es_frissul(): void
    {
        $this->ingest()->assertOk();
        $nav = fn (string $who) => collect($this->actingAs($this->u($who))->getJson('/api/state')->json('portals'))->firstWhere('id', $this->pid)['nav'] ?? null;
        $mine = $nav('LG');
        $this->assertSame([25000, 0, 1, 2, 3, 3], [$mine['surplus'], $mine['debt'], $mine['missing'], $mine['future'], $mine['calendar'], $mine['profiles']]);
        $this->assertNotEmpty($mine['at']);
        $this->assertNull($nav('SN'), 'a belépő saját adószámlája magánadat: más nem látja, a vezető sem');

        $this->ingest('LG', ['account' => ['total' => 5000, 'debt' => 5000, 'surplus' => 0, 'deposit' => 0, 'unbooked' => 0], 'missingCount' => 0])->assertOk();
        $this->assertSame([0, 5000, 0], [$nav('LG')['surplus'], $nav('LG')['debt'], $nav('LG')['missing']]);
        $this->assertSame(1, DB::table('nav_snapshots')->where('portal_connection_id', $this->pid)->count(), 'belépőnként egy, a legfrissebb');
    }

    public function test_csak_a_belepo_gazdaja_kuldhet_be_es_kikapcsolt_nav_rendszernel_senki(): void
    {
        $this->ingest('BT')->assertStatus(403);
        $this->ingest('SN')->assertStatus(403);
        DB::table('portal_connections')->where('id', $this->pid)->update(['enabled_systems' => json_encode(['tarhely_cegkapu'])]);
        $this->ingest('LG')->assertStatus(422);
        $this->assertSame(0, DB::table('nav_snapshots')->count());
        $this->assertSame(0, DB::table('discovered_subjects')->count());
    }

    public function test_csak_vallalkozasok_beallitasnal_maganszemely_nem_ajanlodik(): void
    {
        DB::table('portal_connections')->where('id', $this->pid)->update(['subject_scope' => 'business']);
        $this->ingest()->assertOk();
        $this->assertSame(['55667788'], DB::table('discovered_subjects')->pluck('identifier')->all());
    }

    public function test_kiirt_cegformaju_szervezet_vallalkozas_es_a_csak_vallalkozasok_beallitas_nem_szuri_ki(): void
    {
        DB::table('portal_connections')->where('id', $this->pid)->update(['subject_scope' => 'business']);
        $this->ingest('LG', ['profiles' => [
            ['id' => 5, 'name' => 'PRÓBA ZÁRTKÖRŰEN MŰKÖDŐ RÉSZVÉNYTÁRSASÁG', 'stem' => '11223344', 'taxNumber' => '11223344-2-41', 'taxId' => null, 'kind' => 'SZERVEZET'],
            ['id' => 6, 'name' => 'NÉVTELEN FORMA', 'stem' => '22334455', 'taxNumber' => '22334455-2-41', 'taxId' => null, 'kind' => 'SZERVEZET'],
        ]])->assertOk();
        $this->assertSame(['11223344' => 'business', '22334455' => 'business'], DB::table('discovered_subjects')->orderBy('identifier')->pluck('kind', 'identifier')->all());
    }

    public function test_levelbol_a_kiirt_cegforma_is_vallalkozas(): void
    {
        foreach (['Próba Korlátolt Felelősségű Társaság', 'Próba Zártkörűen Működő Részvénytársaság', 'Próba Betéti Társaság'] as $n) {
            $this->assertSame('business', ClientDiscovery::parseSubjectParty("11223344 - $n - tárgy")['kind'], $n);
        }
        $this->assertSame('sole', ClientDiscovery::parseSubjectParty('11223344 - Minta Béla - tárgy')['kind']);
    }

    public function test_ceg_nem_jelolheto_sajatkent(): void
    {
        $this->ingest()->assertOk();
        $rows = DB::table('discovered_subjects')->pluck('id', 'identifier');
        $this->actingAs($this->u('LG'))->postJson('/api/discovered-subjects/' . $rows['55667788'], ['action' => 'self'])->assertStatus(422);
        $this->assertSame('pending', DB::table('discovered_subjects')->where('id', $rows['55667788'])->value('state'));
        $this->actingAs($this->u('LG'))->postJson('/api/discovered-subjects/' . $rows['8412345678'], ['action' => 'self'])->assertOk();
    }

    // ---- Adónaptár tételesen (a teljes szinkron 4. lépése): az asztali olvasó kimenetének alakjával

    private function calendar(array $subject, ?array $rows = null): array
    {
        return ['subject' => $subject, 'obligations' => $rows ?? [
            ['formCode' => '2558', 'title' => 'Havi bevallás', 'dueDate' => '2026-10-12', 'periodStart' => '2026-09-01', 'periodEnd' => '2026-09-30', 'conditional' => false, 'status' => 'missing', 'kind' => 'missing'],
            ['formCode' => '2658', 'title' => '2658 bevallás és járulékok befizetése', 'dueDate' => '2026-11-20', 'periodStart' => null, 'periodEnd' => null, 'conditional' => false, 'status' => 'submittable', 'kind' => 'calendar'],
            ['formCode' => 'ADONEM-103', 'title' => 'Személyi jövedelemadó előleg befizetése', 'dueDate' => '2026-12-12', 'periodStart' => null, 'periodEnd' => null, 'conditional' => false, 'status' => 'submittable', 'kind' => 'calendar'],
        ]];
    }

    private function obligationsOf(string $who)
    {
        return collect($this->actingAs($this->u($who))->getJson('/api/state')->json('obligations'))->where('source', 'nav')->values();
    }

    public function test_a_belepo_sajat_adonaptara_a_sajat_gyujtojebe_kerul_es_csak_o_latja(): void
    {
        $r = $this->ingest('LG', $this->calendar(['name' => 'LAKATOS GERGŐ', 'stem' => null, 'taxId' => '8499999999', 'taxNumber' => null, 'own' => true]))->assertOk()->json('calendar');
        $this->assertSame([3, true, 3], [$r['upserted'], $r['matched'], $r['received']]);
        $own = DB::table('clients')->where('discovered_via', 'own')->where('portal_connection_id', $this->pid)->first();
        $this->assertNotNull($own, 'a saját gyűjtő létrejött');
        $this->assertSame("c{$own->id}", $r['client']);

        $mine = $this->obligationsOf('LG');
        $this->assertSame([['2558', '2026-10-12', 'missing'], ['2658', '2026-11-20', 'submittable'], ['ADONEM-103', '2026-12-12', 'submittable']],
            $mine->map(fn ($o) => [$o['formCode'], $o['dueDate'], $o['status']])->all(), 'a határidőnaptár ugyanebből a listából dolgozik');
        $this->assertCount(0, $this->obligationsOf('SN'), 'a belépő saját adónaptára magánadat: a vezető sem látja');
        $this->assertSame(['ok', null], [DB::table('portal_connections')->where('id', $this->pid)->value('upo_state'), DB::table('portal_connections')->where('id', $this->pid)->value('last_error')]);

        // újra beküldve nem kettőződik; a közben nyugtával beadottá vált tétel állapotát nem írja vissza
        DB::table('tax_obligations')->where('client_id', $own->id)->where('form_code', '2658')->update(['status' => 'submitted']);
        $this->ingest('LG', $this->calendar(['stem' => null, 'taxId' => '8499999999']))->assertOk();
        $this->assertSame(3, DB::table('tax_obligations')->where('source', 'nav')->count());
        $this->assertSame('submitted', DB::table('tax_obligations')->where('form_code', '2658')->value('status'));
    }

    public function test_ismert_ugyfel_adonaptara_az_ugyfelhez_kerul_ismeretlen_adozoe_sehova(): void
    {
        $client = DB::table('clients')->where('tax', '24817365-2-13')->first();
        $r = $this->ingest('LG', $this->calendar(['stem' => '24817365', 'taxId' => null, 'own' => false]))->assertOk()->json('calendar');
        $this->assertSame([3, true, "c{$client->id}"], [$r['upserted'], $r['matched'], $r['client']]);
        $this->assertSame(3, DB::table('tax_obligations')->where('client_id', $client->id)->where('source', 'nav')->count());

        $before = DB::table('tax_obligations')->count();
        foreach ([['stem' => '99887766', 'taxId' => null], ['stem' => null, 'taxId' => '8412345678'], ['stem' => null, 'taxId' => null], []] as $subject) {
            $r = $this->ingest('LG', $this->calendar($subject))->assertOk()->json('calendar');
            $this->assertSame([0, false], [$r['upserted'], $r['matched']]);
        }
        $this->assertSame($before, DB::table('tax_obligations')->count(), 'ismeretlen adózó tétele nem kerül be, és ügyfél sem jön létre miatta');
        $this->assertSame(0, DB::table('clients')->where('discovered_via', 'own')->count());

        DB::table('clients')->where('id', $client->id)->update(['active' => false]);
        $this->assertSame('inactive', $this->ingest('LG', $this->calendar(['stem' => '24817365']))->assertOk()->json('calendar.reason'));
    }

    public function test_a_nav_feltetelesnek_jelolt_tetele_feltetelesként_kerul_be_es_vegleges_lesz_ha_a_nav_ugy_jelzi(): void
    {
        $client = DB::table('clients')->where('tax', '24817365-2-13')->first(); $subject = ['stem' => '24817365', 'taxId' => null, 'own' => false];
        $row = ['formCode' => '26A60', 'title' => 'Összesítő nyilatkozat', 'dueDate' => '2026-11-20'];
        $this->ingest('LG', $this->calendar($subject, [$row + ['conditional' => true]]))->assertOk();
        $o = DB::table('tax_obligations')->where('client_id', $client->id)->where('source', 'nav')->first();
        $this->assertSame([1, 'conditional'], [(int) $o->conditional, $o->status]);
        $this->ingest('LG', $this->calendar($subject, [$row]))->assertOk();
        $o = DB::table('tax_obligations')->where('id', $o->id)->first();
        $this->assertSame([0, 'submittable'], [(int) $o->conditional, $o->status]);
    }

    public function test_hibas_alaku_kotelezettseg_elutasitva_ures_lista_rendben(): void
    {
        $subject = ['stem' => null, 'taxId' => '8499999999'];
        foreach ([['formCode' => '2658', 'dueDate' => 'holnap'], ['formCode' => '<b>', 'dueDate' => '2026-11-20'], ['dueDate' => '2026-11-20'], ['formCode' => '2658', 'dueDate' => '2026-11-20', 'status' => 'rejected']] as $bad) {
            $this->ingest('LG', $this->calendar($subject, [$bad]))->assertStatus(422);
        }
        $this->assertSame(0, DB::table('tax_obligations')->where('source', 'nav')->count());
        $r = $this->ingest('LG', $this->calendar($subject, []))->assertOk()->json('calendar');
        $this->assertSame([0, true], [$r['upserted'], $r['matched']]);
        $this->assertNull($this->ingest('LG')->assertOk()->json('calendar'), 'régebbi asztali app kötelezettségek nélkül küld: az adónaptárhoz nem nyúlunk');
        $this->ingest('LG', $this->calendar($subject, [['formCode' => '2658', 'title' => '<i>Dőlt</i> cím', 'dueDate' => '2026-11-20']]))->assertOk();
        $this->assertSame('Dőlt cím', DB::table('tax_obligations')->where('source', 'nav')->value('title'));
    }

    // ---- B kör: képviselet-váltás, ügyfelenkénti adatok (alapból kikapcsolva)

    private function clientsBody(array $extra = []): array
    {
        return $extra + ['portalId' => $this->pid, 'restored' => true, 'clients' => [
            ['stem' => '24817365', 'taxId' => null, 'account' => ['total' => 120000, 'debt' => 120000, 'surplus' => 0, 'deposit' => 0, 'unbooked' => 5000], 'missingCount' => 1, 'futureCount' => 2, 'calendarCount' => 3,
                'obligations' => [['formCode' => '2665', 'title' => 'Áfabevallás', 'dueDate' => '2026-12-20', 'periodStart' => null, 'periodEnd' => null, 'status' => 'submittable']]],
            ['stem' => '55667788', 'taxId' => null, 'account' => ['total' => 1], 'missingCount' => 0, 'futureCount' => 0, 'calendarCount' => 0, 'obligations' => []], // nem ügyfél
        ]];
    }

    public function test_kepviselet_valtas_alapbol_ki_van_kapcsolva(): void
    {
        $lg = $this->u('LG');
        $this->actingAs($lg)->getJson("/api/nav/targets?portalId={$this->pid}")->assertOk()->assertExactJson(['enabled' => false, 'ids' => []]);
        $this->actingAs($lg)->postJson('/api/nav/ingest-clients', $this->clientsBody())->assertStatus(422);
        $this->assertSame(0, DB::table('nav_client_snapshots')->count());
        $this->assertFalse($this->actingAs($lg)->getJson('/api/state')->json('office.nav_switch'));
    }

    public function test_bekapcsolva_csak_latott_aktiv_ugyfelre_valt_es_az_adat_az_ugyfelhez_kerul(): void
    {
        config(['iratkapu.nav_switch' => true]);
        $lg = $this->u('LG'); $cid = DB::table('clients')->where('tax', '24817365-2-13')->value('id');
        $off = DB::table('clients')->where('office_id', $lg->office_id)->where('id', '!=', $cid)->whereIn('id', \App\Iratkapu\Scope::clientIds($lg))->where('tax', 'like', '________-_-__')->value('id');
        $offStem = substr(DB::table('clients')->where('id', $off)->value('tax'), 0, 8);
        DB::table('clients')->where('id', $off)->update(['active' => false]);

        $t = $this->actingAs($lg)->getJson("/api/nav/targets?portalId={$this->pid}")->assertOk()->json();
        $this->assertTrue($t['enabled']); $this->assertContains('24817365', $t['ids']);
        $this->assertNotContains($offStem, $t['ids'], 'inaktív ügyfélre nem vált');
        foreach ($t['ids'] as $id) $this->assertMatchesRegularExpression('/^(\d{8}|8\d{9})$/', $id);

        $before = DB::table('clients')->count();
        $r = $this->actingAs($lg)->postJson('/api/nav/ingest-clients', $this->clientsBody())->assertOk()->json();
        $this->assertSame([1, 1, 1, true], [$r['saved'], $r['skipped'], $r['obligations'], $r['restored']]);
        $this->assertSame($before, DB::table('clients')->count(), 'ügyfél a váltásból nem jön létre');
        $snap = DB::table('nav_client_snapshots')->get();
        $this->assertCount(1, $snap); $this->assertSame([$cid, 120000, 1], [(int) $snap[0]->client_id, (int) $snap[0]->debt, (int) $snap[0]->missing_count]);
        $this->assertSame(1, DB::table('tax_obligations')->where('client_id', $cid)->where('source', 'nav')->where('form_code', '2665')->count());

        $c = collect($this->actingAs($lg)->getJson('/api/state')->json('clients'))->firstWhere('id', "c$cid");
        $this->assertSame([120000, 5000, 2], [$c['nav']['debt'], $c['nav']['unbooked'], $c['nav']['future']]);
        // ma már kiolvasott ügyfél nem kerül újra a listára; újra beküldve nem kettőződik
        $this->assertNotContains('24817365', $this->actingAs($lg)->getJson("/api/nav/targets?portalId={$this->pid}")->json('ids'));
        $this->actingAs($lg)->postJson('/api/nav/ingest-clients', $this->clientsBody())->assertOk();
        $this->assertSame(1, DB::table('nav_client_snapshots')->count());
        $this->assertSame(1, DB::table('tax_obligations')->where('client_id', $cid)->where('source', 'nav')->where('form_code', '2665')->count());
    }

    public function test_mas_belepojenek_portaljan_nem_lehet_valtani_es_a_sikertelen_visszavaltas_naplozva_van(): void
    {
        config(['iratkapu.nav_switch' => true]);
        $other = User::where('office_id', $this->u('LG')->office_id)->where('initials', '!=', 'LG')->firstOrFail();
        $this->actingAs($other)->getJson("/api/nav/targets?portalId={$this->pid}")->assertForbidden();
        $this->actingAs($other)->postJson('/api/nav/ingest-clients', $this->clientsBody())->assertForbidden();
        $this->actingAs($this->u('LG'))->postJson('/api/nav/ingest-clients', $this->clientsBody(['restored' => false]))->assertOk()->assertJson(['restored' => false]);
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', '%VISSZAVÁLTÁS%NEM VOLT IGAZOLHATÓ%')->exists());
    }

    // ---- C kör: beadott bevallások (alapból kikapcsolva)

    private const RET = [
        ['regNo' => '8104920114', 'formCode' => '2608', 'title' => 'Havi <b>bevallás</b>', 'periodStart' => '2026-09-01', 'periodEnd' => '2026-09-30', 'submittedAt' => '2026-10-12 09:41', 'state' => 'Feldolgozott', 'kind' => 'ALAPBEVALLAS'],
        ['regNo' => '8100000002', 'formCode' => '2665', 'title' => null, 'periodStart' => null, 'periodEnd' => null, 'submittedAt' => null, 'state' => null, 'kind' => null],
    ];

    public function test_beadott_bevallasok_kikapcsolva_nem_tarolodnak_bekapcsolva_az_ugyfelhez_kerulnek_es_parosulnak_a_nyugtaval(): void
    {
        config(['iratkapu.nav_switch' => true]);
        $lg = $this->u('LG'); $cid = DB::table('clients')->where('tax', '24817365-2-13')->value('id');
        $body = $this->clientsBody(); $body['clients'][0]['returns'] = self::RET;
        $this->assertSame(0, $this->actingAs($lg)->postJson('/api/nav/ingest-clients', $body)->assertOk()->json('returns'));
        $this->assertSame(0, DB::table('nav_returns')->count(), 'kikapcsolt lekérdezésnél a beküldött bevallások nem tárolódnak');

        config(['iratkapu.nav_queries' => true]);
        $mid = DB::table('messages')->where('client_id', $cid)->value('id');
        DB::table('messages')->where('id', $mid)->update(['barcode' => '8104920114', 'receipt' => true]);
        // élő alakú nyugta vonalkód nélkül: a tárgyban a nyomtatványkód és az időszak
        $mid2 = DB::table('messages')->where('client_id', $cid)->where('id', '!=', $mid)->value('id');
        DB::table('messages')->where('id', $mid2)->update(['barcode' => null, 'receipt' => true, 'subject' => '2665, Elfogadó nyugta (12345678), 2026.07.01-2026.09.30, Borostyán Pékség Kft.']);
        $this->assertSame(2, $this->actingAs($lg)->postJson('/api/nav/ingest-clients', $body)->assertOk()->json('returns'));
        $this->actingAs($lg)->postJson('/api/nav/ingest-clients', $body)->assertOk();
        $this->assertSame(2, DB::table('nav_returns')->count(), 'újra beküldve nem kettőződik');
        $state = $this->actingAs($lg)->getJson('/api/state')->json();
        $this->assertTrue($state['office']['nav_queries']);
        $rows = collect($state['navReturns'])->keyBy('regNo');
        $this->assertSame(["c$cid", '2608', "m$mid", '2026-09-01'], [$rows['8104920114']['c'], $rows['8104920114']['formCode'], $rows['8104920114']['receipt'], $rows['8104920114']['from']]);
        $this->assertSame('Havi bevallás', $rows['8104920114']['title'], 'idegen eredetű szöveg tisztítva');
        $this->assertSame('regno', $rows['8104920114']['by']);
        $this->assertNull($rows['8100000002']['receipt'], 'időszak nélküli bevallás nem párosítható a tárgy alapján');
        DB::table('nav_returns')->where('reg_no', '8100000002')->update(['period_from' => '2026-07-01', 'period_to' => '2026-09-30']);
        $r2 = collect($this->actingAs($lg)->getJson('/api/state')->json('navReturns'))->keyBy('regNo')['8100000002'];
        $this->assertSame(["m$mid2", 'period'], [$r2['receipt'], $r2['by']], 'vonalkód nélkül a nyomtatványkód és az időszak párosít');
        DB::table('nav_returns')->where('reg_no', '8100000002')->update(['state' => 'Törölt']);
        $r3 = collect($this->actingAs($lg)->getJson('/api/state')->json('navReturns'))->keyBy('regNo')['8100000002'];
        $this->assertSame([true, null], [$r3['deleted'], $r3['receipt']], 'a NAV-nál törölt bevalláshoz nem keresünk nyugtát');
        // hibás alakú sor az egész kérést elutasítja
        $body['clients'][0]['returns'][0]['regNo'] = 'abc';
        $this->actingAs($lg)->postJson('/api/nav/ingest-clients', $body)->assertStatus(422);
    }

    public function test_ujra_beolvasott_bevallasok_es_dokumentumok_uj_valtozott_es_valtozatlan_szerint_szamlalodnak(): void
    {
        config(['iratkapu.nav_switch' => true, 'iratkapu.nav_queries' => true]);
        $lg = $this->u('LG');
        $doc = ['barcode' => '8104920114', 'regNo' => '8104920114/2026/NAV', 'subject' => 'Havi bevallás', 'formCode' => '2608', 'submittedAt' => '2026-10-12 09:41', 'files' => 2];
        $body = $this->clientsBody(); $body['clients'][0]['returns'] = self::RET; $body['clients'][0]['documents'] = [$doc];
        $r = $this->actingAs($lg)->postJson('/api/nav/ingest-clients', $body)->assertOk()->json();
        $this->assertSame([['new' => 2, 'changed' => 0, 'same' => 0], ['new' => 1, 'changed' => 0, 'same' => 0]], [$r['returnsTally'], $r['documentsTally']]);
        $before = DB::table('nav_returns')->where('reg_no', '8100000002')->value('fetched_at');

        $this->travel(1)->hours();
        $r = $this->actingAs($lg)->postJson('/api/nav/ingest-clients', $body)->assertOk()->json();
        $this->assertSame([['new' => 0, 'changed' => 0, 'same' => 2], ['new' => 0, 'changed' => 0, 'same' => 1]], [$r['returnsTally'], $r['documentsTally']], 'ugyanaz a lista nem „új”');
        $this->assertNotSame($before, DB::table('nav_returns')->where('reg_no', '8100000002')->value('fetched_at'), 'az utoljára látva időpont frissül');

        $body['clients'][0]['returns'][1]['state'] = 'Feldolgozott';
        $body['clients'][0]['returns'] = [$body['clients'][0]['returns'][1]];
        $r = $this->actingAs($lg)->postJson('/api/nav/ingest-clients', $body)->assertOk()->json();
        $this->assertSame(['new' => 0, 'changed' => 1, 'same' => 0], $r['returnsTally']);
        $this->assertSame(2, DB::table('nav_returns')->count(), 'a listából kimaradt sor nem törlődik');

        $own = $this->ingest('LG', ['subject' => ['stem' => '24817365', 'taxId' => null, 'own' => false], 'returns' => self::RET, 'documents' => [$doc]])->assertOk()->json();
        $this->assertSame(['new' => 0, 'changed' => 1, 'same' => 1], $own['returnsTally'], 'a saját néven küldött lista is számlál; az előbb módosult sor most visszaváltozott');
        $this->assertSame(1, $own['documentsTally']['same']);
    }

    public function test_a_sajat_neven_lekerdezett_bevallasok_csak_ismert_alanyhoz_tarolodnak(): void
    {
        config(['iratkapu.nav_queries' => true]);
        $this->ingest('LG', ['subject' => ['stem' => '24817365', 'taxId' => null, 'own' => false], 'returns' => self::RET])->assertOk()->assertJson(['returns' => 2]);
        $this->ingest('LG', ['subject' => ['stem' => '99887766', 'taxId' => null, 'own' => false], 'returns' => self::RET])->assertOk()->assertJson(['returns' => null]);
        $this->assertSame(2, DB::table('nav_returns')->count());
    }

    public function test_nav_dokumentumok_kikapcsolva_nem_tarolodnak_bekapcsolva_az_ugyfelhez_kerulnek(): void
    {
        config(['iratkapu.nav_switch' => true]);
        $lg = $this->u('LG'); $cid = DB::table('clients')->where('tax', '24817365-2-13')->value('id');
        $doc = ['barcode' => '8104920114', 'regNo' => '8104920114/2026/NAV', 'subject' => 'Havi <i>bevallás</i>', 'docType' => 'B0001', 'formCode' => '2608', 'formName' => 'Havi bevallás',
            'caseType' => 'Bevallás', 'caseNo' => '9000000001', 'krNo' => null, 'submittedAt' => '2026-10-12 09:41', 'arrivedAt' => '2026-10-12 09:41', 'downloadedAt' => null, 'files' => 2];
        $body = $this->clientsBody(); $body['clients'][0]['documents'] = [$doc, ['barcode' => null, 'regNo' => '1234/2026/NAV']];
        $this->assertSame(0, $this->actingAs($lg)->postJson('/api/nav/ingest-clients', $body)->assertOk()->json('documents'));
        $this->assertSame(0, DB::table('nav_documents')->count());
        config(['iratkapu.nav_queries' => true]);
        $this->assertSame(2, $this->actingAs($lg)->postJson('/api/nav/ingest-clients', $body)->assertOk()->json('documents'));
        $this->actingAs($lg)->postJson('/api/nav/ingest-clients', $body)->assertOk();
        $this->assertSame(2, DB::table('nav_documents')->count(), 'újra beküldve nem kettőződik');
        $rows = collect($this->actingAs($lg)->getJson('/api/state')->json('navDocuments'))->keyBy('regNo');
        $r = $rows['8104920114/2026/NAV'];
        $this->assertSame(["c$cid", '8104920114', 'Havi bevallás', 2], [$r['c'], $r['barcode'], $r['subject'], $r['files']]);
        $body['clients'][0]['documents'][0]['submittedAt'] = 'tegnap';
        $this->actingAs($lg)->postJson('/api/nav/ingest-clients', $body)->assertStatus(422);
    }

    // ---- letölthető kimutatások (alapból kikapcsolva)

    private function exportBody(array $subject, array $extra = []): array
    {
        return $extra + ['portalId' => $this->pid, 'restored' => true, 'subject' => $subject, 'files' => [
            ['kind' => 'adoszamla', 'format' => 'PDF_HITELESITETT', 'from' => '2026-01-01', 'to' => '2026-11-13', 'base64' => base64_encode('%PDF-1.4 adoszamla')],
            ['kind' => 'adoszamla', 'format' => 'XLSX', 'from' => '2026-01-01', 'to' => '2026-11-13', 'base64' => base64_encode("PK\x03\x04 xlsx")],
            ['kind' => 'torzsadat', 'format' => 'PDF', 'base64' => base64_encode('%PDF-1.4 torzsadat')],
        ]];
    }

    public function test_kimutatasok_kikapcsolva_elutasitva_bekapcsolva_iratkent_az_ugyfelhez(): void
    {
        $lg = $this->u('LG'); $cid = DB::table('clients')->where('tax', '24817365-2-13')->value('id'); $before = DB::table('messages')->count();
        $this->actingAs($lg)->postJson('/api/nav/exports', $this->exportBody(['stem' => '24817365', 'taxId' => null]))->assertStatus(422);
        $this->assertFalse($this->actingAs($lg)->getJson('/api/state')->json('office.nav_exports'));
        config(['iratkapu.nav_exports' => true]);
        $r = $this->actingAs($lg)->postJson('/api/nav/exports', $this->exportBody(['stem' => '24817365', 'taxId' => null]))->assertOk()->json();
        $this->assertSame([3, 0], [$r['saved'], $r['skipped']]);
        $m = DB::table('messages')->where('source_id', 'like', 'navexp:%')->orderBy('id')->get();
        $this->assertSame([$cid, 'NAV', 'na'], [$m[0]->client_id, $m[0]->sender, $m[0]->official]);
        $this->assertSame('Portálról lekérdezve: NAV adószámla-kivonat (2026.01.01–2026.11.13), hitelesített PDF', $m[0]->subject);
        $this->assertStringEndsWith(', XLSX', $m[1]->subject);
        $this->assertSame(['application/pdf'], DB::table('documents')->where('message_id', $m[0]->id)->pluck('mime')->all());
        $this->assertSame(1, $this->actingAs($lg)->postJson('/api/nav/exports', $this->exportBody(['stem' => '24817365', 'taxId' => null]))->assertOk()->json('skipped') === 3 ? 1 : 0, 'aznap nem kettőz');
        $this->assertSame($before + 3, DB::table('messages')->count());
    }

    public function test_kimutatas_ismeretlen_alanynal_vagy_rossz_fajlnal_elutasitva(): void
    {
        config(['iratkapu.nav_exports' => true]);
        $lg = $this->u('LG');
        $this->actingAs($lg)->postJson('/api/nav/exports', $this->exportBody(['stem' => '99887766', 'taxId' => null]))->assertStatus(422);
        $b = $this->exportBody(['stem' => '24817365', 'taxId' => null]); $b['files'][0]['base64'] = base64_encode('<html>');
        $this->actingAs($lg)->postJson('/api/nav/exports', $b)->assertStatus(422);
        $other = User::where('office_id', $lg->office_id)->where('initials', '!=', 'LG')->firstOrFail();
        $this->actingAs($other)->postJson('/api/nav/exports', $this->exportBody(['stem' => '24817365', 'taxId' => null]))->assertForbidden();
        $this->assertSame(0, DB::table('messages')->where('source_id', 'like', 'navexp:%')->count());
    }

    /** Kis, valódi szerkezetű XLSX: megosztott szöveg, beágyazott szöveg, szám, dátumstílusú cella, kihagyott oszlop. */
    private static function xlsx(): string
    {
        $tmp = tempnam(sys_get_temp_dir(), 'tx'); $z = new \ZipArchive(); $z->open($tmp, \ZipArchive::OVERWRITE);
        $ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
        $z->addFromString('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
        $z->addFromString('xl/workbook.xml', "<workbook $ns xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"Kivonat\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>");
        $z->addFromString('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>');
        $z->addFromString('xl/sharedStrings.xml', "<sst $ns><si><t>Adónem</t></si><si><r><t>Tartozás</t></r><r><t> (Ft)</t></r></si><si><t>Társasági adó</t></si></sst>");
        $z->addFromString('xl/styles.xml', "<styleSheet $ns><cellXfs><xf numFmtId=\"0\"/><xf numFmtId=\"14\"/></cellXfs></styleSheet>");
        $z->addFromString('xl/worksheets/sheet1.xml', "<worksheet $ns><sheetData>"
            . '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Esedékes</t></is></c></row>'
            . '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>125000</v></c><c r="D2" s="1"><v>46356</v></c></row>'
            . '</sheetData></worksheet>');
        $z->close(); $b = file_get_contents($tmp); @unlink($tmp); return $b;
    }

    public function test_xlsx_kimutatas_tablazatkent_latszik_nem_nyers_bajtokkent(): void
    {
        config(['iratkapu.nav_exports' => true]);
        $lg = $this->u('LG'); $b = $this->exportBody(['stem' => '24817365', 'taxId' => null]); $b['files'] = [$b['files'][1]]; $b['files'][0]['base64'] = base64_encode(self::xlsx());
        $this->actingAs($lg)->postJson('/api/nav/exports', $b)->assertOk();
        $mid = DB::table('messages')->where('source_id', 'like', 'navexp:adoszamla:XLSX:%')->value('id');
        $this->assertSame("Adónem\t\tTartozás (Ft)\tEsedékes\nTársasági adó\t\t125000\t2026.11.30.", DB::table('documents')->where('message_id', $mid)->value('text'));
        $doc = collect($this->actingAs($lg)->getJson('/api/state')->json('messages'))->firstWhere('id', "m$mid")['docs'][0];
        $this->assertNull($doc['preview']);
        $this->assertSame(['rows' => [['Adónem', '', 'Tartozás (Ft)', 'Esedékes'], ['Társasági adó', '', '125000', '2026.11.30.']], 'more' => 0], $doc['sheet']);
    }
}
