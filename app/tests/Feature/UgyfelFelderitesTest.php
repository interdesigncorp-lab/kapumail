<?php
namespace Tests\Feature;

use App\Iratkapu\ClientDiscovery;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * Automatikus ügyfél-felderítés az élő postafiók-listából: a belépő mögött talált Cégkapu ügyfélként jön létre,
 * az azonosíthatatlan postafiók „Besorolásra vár” listába kerül. A program nem talál ki ügyfelet.
 */
class UgyfelFelderitesTest extends TestCase
{
    use RefreshDatabase;
    protected bool $seed = true;

    private const UJ = '55667780 (Új Felderített Kft)';

    protected function setUp(): void
    {
        parent::setUp();
        config(['iratkapu.live_listing' => true, 'iratkapu.live_download' => false]);
    }

    private function u(string $k): User
    {
        return User::where('initials', $k)->firstOrFail();
    }

    private function portal(string $ownerInitials = 'SN', array $extra = []): int
    {
        $o = $this->u($ownerInitials);
        return DB::table('portal_connections')->insertGetId($extra + ['office_id' => $o->office_id, 'name' => "Teszt belépő – $ownerInitials", 'auth_mode' => 'totp', 'vault_key' => 'portal-teszt-' . uniqid(), 'download_active' => true, 'owner_user_id' => $o->id, 'created_at' => now(), 'updated_at' => now()]);
    }

    /** Élő lista beküldése: [postafióknév => érkeztetési számok]. */
    private function ingest(string $who, ?int $portalId, array $boxes): array
    {
        $letters = [];
        foreach ($boxes as $box => $eids) {
            foreach ($eids as $eid) {
                $letters[] = ['eid' => $eid, 'mailbox' => $box, 'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal', 'type' => 'Tájékoztatás bevallásról', 'desc' => '', 'receivedAt' => '2026-11-11 08:10'];
            }
        }
        return $this->actingAs($this->u($who))->postJson('/api/live/ingest', ['autoMap' => true, 'portalId' => $portalId, 'letters' => $letters])->assertOk()->json();
    }

    public function test_sema_alapertekek(): void
    {
        $this->assertSame(0, DB::table('clients')->where('active', false)->count());
        $this->assertSame(0, DB::table('clients')->whereNotNull('discovered_via')->count());
        $this->assertSame(0, DB::table('portal_connections')->where('auto_create_clients', false)->count());
        $this->assertSame(0, DB::table('discovered_mailboxes')->count());
    }

    public function test_postafioknev_ertelmezese(): void
    {
        $p = fn (string $n) => ClientDiscovery::parseMailboxName($n);

        $this->assertSame(['tax8' => '12345676', 'tax' => '12345676', 'name' => 'Példa Kft', 'valid' => true], $p('12345676 (Példa Kft)'));
        $this->assertSame(['tax8' => '12345676', 'tax' => '12345676', 'name' => 'Példa Kft.', 'valid' => true], $p('12345676 Példa Kft.'));
        $this->assertSame(['tax8' => '12345676', 'tax' => '12345676-2-41', 'name' => 'Példa Kft', 'valid' => true], $p('Példa Kft (12345676-2-41)'));
        $this->assertSame(['tax8' => '12345676', 'tax' => '12345676-2-41', 'name' => 'Példa Kft.', 'valid' => true], $p('Példa Kft. 12345676241'));

        // Két különböző adószám-törzs: nem dönthető el, kié a postafiók.
        $this->assertNull($p('12345676 Példa Kft (87654323)')['tax8']);
        // Hibás ellenőrző jegy (telefonszám, dátum): törzsnek látszik, de nem érvényes adószám.
        $this->assertFalse($p('Kovács Bt. 06301234567')['valid']);
        $this->assertFalse($p('20261112 Dátumos Kft')['valid']);
        $this->assertFalse($p('12345676-9-41 Rossz áfakód Kft')['valid']);
        // 8-assal kezdődő, 10 jegyű szám adóazonosító jel, nem adószám-törzs.
        $this->assertNull($p('Kovács Éva 8412345678')['tax8']);
        $this->assertNull($p('Értesítési tárhely')['tax8']);
        $this->assertSame('Értesítési tárhely', $p('Értesítési tárhely')['name']);

        // Idegen eredetű szöveg: címkék nélkül, legfeljebb 120 karakter.
        $x = $p('12345676 <img src=x onerror=alert(1)>Gonosz <b>Kft</b>');
        $this->assertSame('12345676', $x['tax8']);
        $this->assertStringNotContainsString('<', $x['name']);
        $this->assertStringContainsString('Gonosz', $x['name']);
        $this->assertSame(120, mb_strlen($p('12345676 ' . str_repeat('Á', 300))['name']));
    }

    public function test_uj_cegkapu_ugyfelkent_jon_letre_es_a_levelei_bekerulnek(): void
    {
        $pid = $this->portal('SN');
        $r = $this->ingest('SN', $pid, [self::UJ => ['UJ-1', 'UJ-2']]);

        $this->assertSame(['created' => 1, 'attached' => 0, 'pending' => 0, 'own' => 0], $r['discovery']);
        $this->assertSame([2, 0], [$r['created'], $r['unmapped']]);

        $c = DB::table('clients')->where('tax', '55667780')->first();
        $this->assertNotNull($c);
        $this->assertSame(['Új Felderített Kft', 'cegkapu', $pid, 1, null, 'Cégkapu-ügykezelő (felderítve)'], [$c->name, $c->discovered_via, (int) $c->portal_connection_id, (int) $c->active, $c->auth_until, $c->auth_basis]);
        $mb = DB::table('mailboxes')->where('client_id', $c->id)->first();
        $this->assertSame(['CK', self::UJ, $pid], [$mb->type, $mb->live_ref, (int) $mb->portal_connection_id]);
        $this->assertTrue(DB::table('client_user')->where(['client_id' => $c->id, 'user_id' => $this->u('SN')->id])->exists());
        $this->assertSame(2, DB::table('messages')->where('client_id', $c->id)->count());
        $this->assertTrue(DB::table('audit_events')->where('client_id', $c->id)->where('action', 'like', 'Ügyfél automatikusan felvéve%')->exists());

        // Ismételve semmi nem kettőződik.
        $r2 = $this->ingest('SN', $pid, [self::UJ => ['UJ-1', 'UJ-2']]);
        $this->assertSame(['created' => 0, 'attached' => 0, 'pending' => 0, 'own' => 0], $r2['discovery']);
        $this->assertSame([0, 2], [$r2['created'], $r2['known']]);
        $this->assertSame(1, DB::table('clients')->where('tax', '55667780')->count());
        $this->assertSame(1, DB::table('mailboxes')->where('live_ref', self::UJ)->count());
    }

    public function test_meglevo_ugyfelhez_kot_szabad_postafiok_nelkul_ujat_hoz_letre(): void
    {
        $pid = $this->portal('SN');
        $c = DB::table('clients')->where('tax', 'like', '24817365%')->first();
        $before = DB::table('mailboxes')->where('client_id', $c->id)->count();

        $r = $this->ingest('SN', $pid, ['24817365 Borostyán Pékség Kft.' => ['B-1']]);
        $this->assertSame(['created' => 0, 'attached' => 1, 'pending' => 0, 'own' => 0], $r['discovery']);
        $this->assertSame($before, DB::table('mailboxes')->where('client_id', $c->id)->count()); // a meglévő szabad postafiókhoz kötötte

        // Minden meglévő postafiókja foglalt: a második élő postafiók újat kap.
        DB::table('mailboxes')->where('client_id', $c->id)->whereNull('live_ref')->update(['live_ref' => 'foglalt-' . uniqid()]);
        $r2 = $this->ingest('SN', $pid, ['24817365 (Borostyán – második Cégkapu)' => ['B-2']]);
        $this->assertSame(['created' => 0, 'attached' => 1, 'pending' => 0, 'own' => 0], $r2['discovery']);
        $this->assertSame($before + 1, DB::table('mailboxes')->where('client_id', $c->id)->count());
        $this->assertSame(1, $r2['created']);
        $this->assertSame(1, DB::table('clients')->where('tax', 'like', '24817365%')->count());
    }

    public function test_azonosithatatlan_postafiok_besorolasra_var(): void
    {
        $pid = $this->portal('SN');
        $clients = DB::table('clients')->count();
        $r = $this->ingest('SN', $pid, ['Értesítési tárhely' => ['E-1', 'E-2'], '12345676 Kettő Kft (87654323)' => ['K-1']]);

        $this->assertSame(['created' => 0, 'attached' => 0, 'pending' => 2, 'own' => 0], $r['discovery']);
        $this->assertSame([0, 3], [$r['created'], $r['unmapped']]);
        $this->assertSame($clients, DB::table('clients')->count());
        $row = DB::table('discovered_mailboxes')->where('live_ref', 'Értesítési tárhely')->first();
        $this->assertSame(['pending', 2, $pid, null], [$row->state, (int) $row->letters, (int) $row->portal_connection_id, $row->tax8]);

        // Újabb listázás: a sor frissül, nem kettőződik.
        $this->ingest('SN', $pid, ['Értesítési tárhely' => ['E-1', 'E-2', 'E-3']]);
        $this->assertSame(1, DB::table('discovered_mailboxes')->where('live_ref', 'Értesítési tárhely')->count());
        $this->assertSame(3, (int) DB::table('discovered_mailboxes')->where('live_ref', 'Értesítési tárhely')->value('letters'));
    }

    public function test_kikapcsolt_automatikus_felvetel(): void
    {
        $pid = $this->portal('SN', ['auto_create_clients' => false]);
        $r = $this->ingest('SN', $pid, [self::UJ => ['UJ-1']]);

        $this->assertSame(['created' => 0, 'attached' => 0, 'pending' => 1, 'own' => 0], $r['discovery']);
        $this->assertFalse(DB::table('clients')->where('tax', '55667780')->exists());
        $row = DB::table('discovered_mailboxes')->where('live_ref', self::UJ)->first();
        $this->assertSame(['55667780', 'Új Felderített Kft'], [$row->tax8, $row->parsed_name]);

        // Belépő megadása nélkül sem jön létre ügyfél.
        $r2 = $this->ingest('SN', null, ['99887764 (Belépő Nélküli Kft)' => ['BN-1']]);
        $this->assertSame(['created' => 0, 'attached' => 0, 'pending' => 1, 'own' => 0], $r2['discovery']);
        $this->assertFalse(DB::table('clients')->where('tax', '99887764')->exists());
    }

    public function test_masik_iroda_ugyfele_nem_illeszkedik(): void
    {
        $other = DB::table('offices')->where('id', '!=', $this->u('SN')->office_id)->value('id');
        DB::table('clients')->insert(['office_id' => $other, 'name' => 'Másik iroda ügyfele', 'tax' => '55667780-2-41', 'created_at' => now(), 'updated_at' => now()]);
        $pid = $this->portal('SN');

        $r = $this->ingest('SN', $pid, [self::UJ => ['UJ-1']]);
        $this->assertSame(1, $r['discovery']['created']);
        $this->assertSame(1, DB::table('clients')->where('office_id', $this->u('SN')->office_id)->where('tax', '55667780')->count());
        $this->assertSame(0, DB::table('mailboxes')->where('office_id', $other)->whereNotNull('live_ref')->count());
    }

    public function test_konyvelo_csak_a_sajat_belepojevel_derit_fel(): void
    {
        $sajat = $this->portal('LG');
        $mase = $this->portal('SN');

        // Nem a saját belépője: semmi nem jön létre, a levél hozzárendelés nélküli marad.
        $r = $this->ingest('LG', $mase, [self::UJ => ['UJ-1']]);
        $this->assertSame(['created' => 0, 'attached' => 0, 'pending' => 0, 'own' => 0], $r['discovery']);
        $this->assertSame(1, $r['unmapped']);
        $this->assertSame(0, DB::table('discovered_mailboxes')->count());

        // A saját belépőjével felderíthet, és látja, amit talált.
        $r2 = $this->ingest('LG', $sajat, [self::UJ => ['UJ-1']]);
        $this->assertSame(1, $r2['discovery']['created']);
        $this->assertSame(1, $r2['created']);
        $cid = DB::table('clients')->where('tax', '55667780')->value('id');
        $this->assertContains($cid, \App\Iratkapu\Scope::clientIds($this->u('LG')));
    }

    public function test_ket_belepo_ugyanazt_a_cegkaput_latja(): void
    {
        $a = $this->portal('SN');
        $b = $this->portal('LG');
        $this->ingest('SN', $a, [self::UJ => ['UJ-1']]);
        $r = $this->ingest('LG', $b, [self::UJ => ['UJ-1', 'UJ-2']]);

        $this->assertSame(['created' => 0, 'attached' => 0, 'pending' => 0, 'own' => 0], $r['discovery']);
        $this->assertSame(1, DB::table('clients')->where('tax', '55667780')->count());
        $this->assertSame(1, DB::table('mailboxes')->where('live_ref', self::UJ)->count());
    }

    private function pendingId(string $liveRef): int
    {
        return (int) DB::table('discovered_mailboxes')->where('live_ref', $liveRef)->value('id');
    }

    private function resolve(string $who, string $liveRef, array $body)
    {
        return $this->actingAs($this->u($who))->postJson('/api/discovered/' . $this->pendingId($liveRef), $body);
    }

    public function test_besorolas_meglevo_ugyfelhez(): void
    {
        $pid = $this->portal('SN');
        $this->ingest('SN', $pid, ['Példa Nyrt. tárhelye' => ['P-1', 'P-2']]);
        $c = DB::table('clients')->where('tax', 'like', '24817365%')->first();
        $before = DB::table('mailboxes')->where('client_id', $c->id)->count();

        $this->resolve('BT', 'Példa Nyrt. tárhelye', ['action' => 'assign', 'clientId' => "c{$c->id}"])->assertStatus(403);
        $this->resolve('SN', 'Példa Nyrt. tárhelye', ['action' => 'assign', 'clientId' => "c{$c->id}"])->assertOk();

        $mb = DB::table('mailboxes')->where('live_ref', 'Példa Nyrt. tárhelye')->first();
        $this->assertSame([$c->id, $pid, $before + 1], [(int) $mb->client_id, (int) $mb->portal_connection_id, DB::table('mailboxes')->where('client_id', $c->id)->count()]);
        $this->assertSame('assigned', DB::table('discovered_mailboxes')->where('live_ref', 'Példa Nyrt. tárhelye')->value('state'));
        // A korábban kimaradt levelek a következő listázással jönnek be.
        $r = $this->ingest('SN', $pid, ['Példa Nyrt. tárhelye' => ['P-1', 'P-2']]);
        $this->assertSame([2, 0], [$r['created'], $r['unmapped']]);
    }

    public function test_sajat_tarhely_gyujto_csak_a_gazdanak_latszik(): void
    {
        $pid = $this->portal('LG');
        $this->ingest('LG', $pid, ['Értesítési tárhely' => ['S-1']]);

        // Más nem nyilváníthatja a belépő saját tárhelyének, vezető sem.
        $this->resolve('SN', 'Értesítési tárhely', ['action' => 'own'])->assertStatus(403);
        $this->resolve('LG', 'Értesítési tárhely', ['action' => 'own'])->assertOk();

        $c = DB::table('clients')->where('discovered_via', 'own')->first();
        $this->assertSame(["sajat-$pid", $pid], [$c->tax, (int) $c->portal_connection_id]);
        $this->assertSame('ÜK', DB::table('mailboxes')->where('client_id', $c->id)->value('type'));
        $this->assertContains($c->id, \App\Iratkapu\Scope::clientIds($this->u('LG')));
        $this->assertNotContains($c->id, \App\Iratkapu\Scope::clientIds($this->u('SN')));
        $this->assertNotContains($c->id, \App\Iratkapu\Scope::clientIds($this->u('IA')));

        $this->assertSame(1, $this->ingest('LG', $pid, ['Értesítési tárhely' => ['S-1']])['created']);
        $names = fn (string $who) => collect($this->actingAs($this->u($who))->getJson('/api/state')->json('messages'))->pluck('eid')->all();
        $this->assertContains('S-1', $names('LG'));
        $this->assertNotContains('S-1', $names('SN'));
    }

    public function test_uj_ugyfel_a_besorolasra_varobol(): void
    {
        $pid = $this->portal('SN');
        $this->ingest('SN', $pid, ['Gamma Bt. cégkapu' => ['G-1']]);

        $this->resolve('SN', 'Gamma Bt. cégkapu', ['action' => 'create', 'name' => 'Gamma Bt.', 'tax' => '33445568-2-41', 'type' => 'CK'])->assertStatus(422); // nincs nyilatkozat
        $this->resolve('SN', 'Gamma Bt. cégkapu', ['action' => 'create', 'name' => 'Gamma Bt.', 'tax' => 'rossz', 'type' => 'CK', 'authorized' => true])->assertStatus(422);
        $this->resolve('SN', 'Gamma Bt. cégkapu', ['action' => 'create', 'name' => 'Gamma Bt.', 'tax' => '33445568-2-41', 'type' => 'CK', 'authorized' => true])->assertOk();

        $c = DB::table('clients')->where('tax', '33445568-2-41')->first();
        $this->assertSame(['Gamma Bt.', null, $pid], [$c->name, $c->discovered_via, (int) $c->portal_connection_id]);
        $this->assertSame('Gamma Bt. cégkapu', DB::table('mailboxes')->where('client_id', $c->id)->value('live_ref'));
        $this->assertSame(1, $this->ingest('SN', $pid, ['Gamma Bt. cégkapu' => ['G-1']])['created']);
    }

    public function test_kihagyott_postafiok_nem_ter_vissza(): void
    {
        $pid = $this->portal('SN');
        $this->ingest('SN', $pid, ['Régi megszűnt cég' => ['R-1']]);
        $this->resolve('SN', 'Régi megszűnt cég', ['action' => 'ertelmetlen'])->assertStatus(422);
        $this->resolve('SN', 'Régi megszűnt cég', ['action' => 'ignore'])->assertOk();

        $r = $this->ingest('SN', $pid, ['Régi megszűnt cég' => ['R-1', 'R-2']]);
        $this->assertSame(0, $r['discovery']['pending']);
        $this->assertSame('ignored', DB::table('discovered_mailboxes')->where('live_ref', 'Régi megszűnt cég')->value('state'));
        $this->assertSame([], $this->actingAs($this->u('SN'))->getJson('/api/state')->json('discovered'));
        $this->resolve('SN', 'Régi megszűnt cég', ['action' => 'ignore'])->assertStatus(404); // már nincs függőben
    }

    public function test_inaktiv_ugyfel_levelei_kimaradnak_majd_visszajonnek(): void
    {
        $pid = $this->portal('SN');
        $this->ingest('SN', $pid, [self::UJ => ['I-1']]);
        $cid = DB::table('clients')->where('tax', '55667780')->value('id');

        $this->actingAs($this->u('LG'))->postJson("/api/clients/c$cid/active", ['active' => false])->assertStatus(403);
        $this->actingAs($this->u('SN'))->postJson("/api/clients/c$cid/active", ['active' => false])->assertOk();
        $this->assertTrue(DB::table('audit_events')->where('client_id', $cid)->where('action', 'like', 'Ügyfél inaktívvá téve%')->exists());

        $r = $this->ingest('SN', $pid, [self::UJ => ['I-1', 'I-2']]);
        $this->assertSame([0, 0, 2, 0], [$r['created'], $r['known'], $r['inactive'], $r['unmapped']]);
        $this->assertSame(1, DB::table('messages')->where('client_id', $cid)->count());

        $this->postJson("/api/clients/c$cid/active", ['active' => true])->assertOk();
        $r2 = $this->ingest('SN', $pid, [self::UJ => ['I-1', 'I-2']]);
        $this->assertSame([1, 1, 0], [$r2['created'], $r2['known'], $r2['inactive']]);
    }

    public function test_allapot_a_felderites_mezoivel(): void
    {
        $pid = $this->portal('LG');
        $this->ingest('LG', $pid, [self::UJ => ['A-1'], 'Értesítési tárhely' => ['A-2', 'A-3']]);
        $state = fn (string $who) => $this->actingAs($this->u($who))->getJson('/api/state')->assertOk()->json();

        $lg = $state('LG');
        $c = collect($lg['clients'])->firstWhere('tax', '55667780');
        $this->assertSame([true, 'cegkapu', $pid], [$c['active'], $c['via'], $c['portalId']]);
        $p = collect($lg['portals'])->firstWhere('id', $pid);
        $this->assertSame([true, true], [$p['autoCreate'], $p['mine']]);
        $this->assertCount(1, $lg['discovered']);
        $this->assertSame(['Értesítési tárhely', null, $pid, 2], [$lg['discovered'][0]['name'], $lg['discovered'][0]['tax8'], $lg['discovered'][0]['portalId'], $lg['discovered'][0]['letters']]);

        $this->assertCount(1, $state('SN')['discovered']);          // a vezető látja
        $this->assertSame([], $state('BT')['discovered']);          // más könyvelő nem
        $this->assertFalse(collect($state('SN')['portals'])->firstWhere('id', $pid)['mine']);
    }

    /** A felderítés előtt létrehozott belépőnek nincs gazdája: aki saját tárhelyként jelöli meg, az lesz a gazda. */
    public function test_gazda_nelkuli_belepo_sajat_tarhelye(): void
    {
        $pid = $this->portal('SN', ['owner_user_id' => null]);
        $this->ingest('SN', $pid, ['Értesítési tárhely' => ['GN-1']]);
        $this->assertFalse(collect($this->actingAs($this->u('SN'))->getJson('/api/state')->json('portals'))->firstWhere('id', $pid)['mine']);

        $this->resolve('LG', 'Értesítési tárhely', ['action' => 'own'])->assertStatus(403); // könyvelő nem veheti birtokba
        $this->resolve('SN', 'Értesítési tárhely', ['action' => 'own'])->assertOk();

        $this->assertSame($this->u('SN')->id, (int) DB::table('portal_connections')->where('id', $pid)->value('owner_user_id'));
        $cid = DB::table('clients')->where('discovered_via', 'own')->value('id');
        $this->assertContains($cid, \App\Iratkapu\Scope::clientIds($this->u('SN')));
        $this->assertNotContains($cid, \App\Iratkapu\Scope::clientIds($this->u('IA')));
    }

    /** A levél nélküli (üres) Cégkapu is felderítendő: a postafiókok listája külön is beküldhető. */
    public function test_ures_cegkapu_is_felderul(): void
    {
        $pid = $this->portal('SN');
        $r = $this->actingAs($this->u('SN'))->postJson('/api/live/ingest', ['autoMap' => true, 'portalId' => $pid, 'letters' => [], 'mailboxes' => ['55443320 (Gamma Szolgáltató Kft)', 'Értesítési tárhely']])->assertOk()->json();

        $this->assertSame(['created' => 1, 'attached' => 0, 'pending' => 1, 'own' => 0], $r['discovery']);
        $this->assertTrue(DB::table('clients')->where('tax', '55443320')->exists());
        $this->assertSame(0, (int) DB::table('discovered_mailboxes')->where('live_ref', 'Értesítési tárhely')->value('letters'));
    }

    public function test_ervenytelen_szamu_postafiokbol_nem_lesz_ugyfel(): void
    {
        $pid = $this->portal('SN');
        $n = DB::table('clients')->count();
        $r = $this->ingest('SN', $pid, ['Kovács Bt. 06301234567' => ['T-1'], '20261112 Dátumos Kft' => ['D-1']]);

        $this->assertSame(['created' => 0, 'attached' => 0, 'pending' => 2, 'own' => 0], $r['discovery']);
        $this->assertSame($n, DB::table('clients')->count());
    }

    public function test_postafioknev_nem_kerul_szuretlenul_a_naploba(): void
    {
        $pid = $this->portal('SN');
        $this->ingest('SN', $pid, ['<img src=x onerror=alert(1)> 55667780' => ['X-1'], '<script>alert(2)</script> névtelen' => ['X-2']]);
        $this->assertTrue(DB::table('clients')->where('tax', '55667780')->exists());
        $this->resolve('SN', '<script>alert(2)</script> névtelen', ['action' => 'ignore'])->assertOk();

        foreach (['action', 'evidence', 'policy'] as $col) {
            $this->assertSame(0, DB::table('audit_events')->where($col, 'like', '%<img%')->orWhere($col, 'like', '%<script%')->count(), $col);
        }
        $this->assertStringNotContainsString('<', DB::table('clients')->where('tax', '55667780')->value('name'));
    }

    public function test_sajat_tarhely_levelei_nem_szivarognak_a_vezetokhoz(): void
    {
        $pid = $this->portal('LG');
        $this->ingest('LG', $pid, ['Értesítési tárhely' => ['M-0']]);
        $this->resolve('LG', 'Értesítési tárhely', ['action' => 'own'])->assertOk();
        $cid = DB::table('clients')->where('discovered_via', 'own')->value('id');

        // Ismeretlen típusú magánlevél: a „vezetőnek azonnal” szabály illeszkedik rá.
        $letters = [['eid' => 'M-1', 'mailbox' => 'Értesítési tárhely', 'sender' => 'X', 'senderFull' => 'X', 'type' => 'Titkos magánügy 42', 'desc' => '', 'receivedAt' => '2026-11-11 08:10']];
        $this->actingAs($this->u('LG'))->postJson('/api/live/ingest', ['autoMap' => true, 'portalId' => $pid, 'letters' => $letters])->assertOk()->assertJson(['created' => 1]);

        foreach (['SN', 'IA'] as $who) {
            $this->assertSame(0, DB::table('notifications')->where('user_id', $this->u($who)->id)->where('body', 'like', '%Titkos%')->count(), "értesítés: $who");
            $audit = json_encode($this->actingAs($this->u($who))->getJson('/api/state')->json('audit'), JSON_UNESCAPED_UNICODE);
            $this->assertStringNotContainsString('M-1', $audit, "napló: $who");
            $this->assertNotContains($this->u($who)->id, \App\Iratkapu\Notify::audience($this->u($who)->office_id, $cid));
        }
        $this->assertContains($this->u('LG')->id, \App\Iratkapu\Notify::audience($this->u('LG')->office_id, $cid));
    }

    public function test_fuggo_sor_lezarul_ha_a_postafiok_kozben_gazdara_talal(): void
    {
        $lg = $this->u('LG');
        $rejtett = DB::table('clients')->where('office_id', $lg->office_id)->whereNotIn('id', \App\Iratkapu\Scope::clientIds($lg))->first();
        $this->assertNotNull($rejtett);
        $box = substr(preg_replace('/\D/', '', $rejtett->tax), 0, 8) . ' (Rejtett ügyfél Cégkapuja)';

        $this->ingest('LG', $this->portal('LG'), [$box => ['R-1']]); // a könyvelő nem látja az ügyfelet: függőbe kerül
        $this->assertSame('pending', DB::table('discovered_mailboxes')->where('live_ref', $box)->value('state'));

        $this->ingest('SN', $this->portal('SN'), [$box => ['R-1']]); // a vezető szinkronja hozzáköti
        $this->assertSame('assigned', DB::table('discovered_mailboxes')->where('live_ref', $box)->value('state'));
        $this->assertSame([], $this->actingAs($lg)->getJson('/api/state')->json('discovered'));
    }

    public function test_uj_ugyfel_nem_hozhato_letre_meglevo_adoszam_torzzsel(): void
    {
        $pid = $this->portal('SN');
        $this->ingest('SN', $pid, ['Borostyán másik tárhelye' => ['BM-1']]);
        $n = DB::table('clients')->count();

        $this->resolve('SN', 'Borostyán másik tárhelye', ['action' => 'create', 'name' => 'Borostyán Pékség (másodszor)', 'tax' => '24817365-1-11', 'type' => 'CK', 'authorized' => true])->assertStatus(422);
        $this->assertSame($n, DB::table('clients')->count());
    }

    public function test_egy_elo_postafiok_csak_egyszer_szerepelhet_az_irodaban(): void
    {
        $this->ingest('SN', $this->portal('SN'), [self::UJ => ['EGY-1']]);
        $mb = (array) DB::table('mailboxes')->where('live_ref', self::UJ)->first();
        unset($mb['id']);

        $this->expectException(\Illuminate\Database\UniqueConstraintViolationException::class);
        DB::table('mailboxes')->insert($mb);
    }

    public function test_masik_iroda_nem_er_el_semmit(): void
    {
        $pid = $this->portal('SN');
        $this->ingest('SN', $pid, ['Értesítési tárhely' => ['MI-1'], self::UJ => ['MI-2']]);
        $cid = DB::table('clients')->where('tax', '55667780')->value('id');
        $other = DB::table('offices')->where('id', '!=', $this->u('SN')->office_id)->value('id');
        $idegen = User::forceCreate(['office_id' => $other, 'name' => 'Idegen Admin', 'initials' => 'XA', 'role' => 'admin', 'email' => 'xa@pelda.test', 'password' => bcrypt('x')]);

        $this->actingAs($idegen)->postJson('/api/discovered/' . $this->pendingId('Értesítési tárhely'), ['action' => 'ignore'])->assertStatus(404);
        $this->actingAs($idegen)->postJson("/api/clients/c$cid/active", ['active' => false])->assertStatus(404);
        $this->assertSame([], $this->actingAs($idegen)->getJson('/api/state')->json('discovered'));
        $this->assertSame(1, (int) DB::table('clients')->where('id', $cid)->value('active'));
    }

    /** Védelem a felület mögött is: ügyfélnévbe kézi felvételkor sem kerülhet HTML-jel. */
    public function test_ugyfelnev_nem_tartalmazhat_html_jelet(): void
    {
        $n = DB::table('clients')->count();
        $this->actingAs($this->u('SN'))->postJson('/api/clients', ['name' => '<img src=x onerror=alert(1)> Kft', 'tax' => '33445568-2-41', 'type' => 'CK', 'authorized' => true])->assertStatus(422);
        $this->assertSame($n, DB::table('clients')->count());

        $pid = $this->portal('SN');
        $this->ingest('SN', $pid, ['Névtelen tárhely' => ['H-1']]);
        $this->resolve('SN', 'Névtelen tárhely', ['action' => 'create', 'name' => 'Jó <b>Kft</b>', 'tax' => '33445568-2-41', 'type' => 'CK', 'authorized' => true])->assertOk();
        $this->assertSame('Jó Kft', DB::table('clients')->where('tax', '33445568-2-41')->value('name')); // a besorolásnál tisztítva tárolódik
    }

    public function test_inaktiv_ugyfel_nav_kotelezettsegei_kimaradnak(): void
    {
        $c = DB::table('clients')->where('tax', '24817365-2-13')->first();
        DB::table('clients')->where('id', $c->id)->update(['active' => false]);
        $n = DB::table('tax_obligations')->where('client_id', $c->id)->count();

        $sn = $this->u('SN');
        $pid = DB::table('portal_connections')->insertGetId(['office_id' => $sn->office_id, 'name' => 'SN NAV-belépője', 'auth_mode' => 'totp', 'vault_key' => 'portal-sn-nav', 'download_active' => true, 'owner_user_id' => $sn->id, 'created_at' => now(), 'updated_at' => now()]);
        $r = $this->actingAs($sn)->postJson('/api/nav/ingest', ['portalId' => $pid, 'subject' => ['stem' => '24817365'], 'obligations' => [['formCode' => '2665', 'title' => 'Áfa', 'dueDate' => '2026-12-20']]])->assertOk()->json('calendar');
        $this->assertSame([0, 'inactive'], [$r['upserted'], $r['reason']]);
        $this->assertSame($n, DB::table('tax_obligations')->where('client_id', $c->id)->count());
    }

    /** A belépő törlése után a saját tárhely gyűjtője nem válik gazdátlanná: a volt gazda továbbra is látja, más nem. */
    public function test_belepo_torlese_utan_a_sajat_gyujto_a_gazdanal_marad(): void
    {
        $pid = $this->portal('LG');
        $this->ingest('LG', $pid, ['Értesítési tárhely' => ['TG-1']]);
        $this->resolve('LG', 'Értesítési tárhely', ['action' => 'own'])->assertOk();
        $this->ingest('LG', $pid, ['Értesítési tárhely' => ['TG-1']]);
        $cid = (int) DB::table('clients')->where('discovered_via', 'own')->value('id');

        $this->actingAs($this->u('SN'))->deleteJson("/api/portals/$pid")->assertOk();

        $this->assertContains($cid, \App\Iratkapu\Scope::clientIds($this->u('LG')));
        $this->assertNotContains($cid, \App\Iratkapu\Scope::clientIds($this->u('SN')));
        $this->assertNotContains($cid, \App\Iratkapu\Scope::clientIds($this->u('IA')));
        $this->assertTrue(collect($this->actingAs($this->u('LG'))->getJson('/api/state')->json('messages'))->contains('eid', 'TG-1'));
    }

    /** A saját tárhely gyűjtőjének gazdája az ügyfélen tárolódik: a kezelők szerkesztése és a belépő törlése sem viheti át másra. */
    public function test_sajat_gyujto_kezeloi_nem_szerkeszthetok_es_a_gazda_megmarad(): void
    {
        $pid = $this->portal('SN'); // a gazda most vezető
        $this->ingest('SN', $pid, ['Értesítési tárhely' => ['GZ-1']]);
        $this->resolve('SN', 'Értesítési tárhely', ['action' => 'own'])->assertOk();
        $cid = (int) DB::table('clients')->where('discovered_via', 'own')->value('id');
        $this->assertSame($this->u('SN')->id, (int) DB::table('clients')->where('id', $cid)->value('owner_user_id'));

        $this->actingAs($this->u('SN'))->postJson("/api/clients/c$cid/users", ['users' => ['LG', 'BT']])->assertStatus(422);
        // Ha valahogy mégis más kerülne a kezelők közé, a láthatóság akkor sem megy át rá.
        DB::table('client_user')->where('client_id', $cid)->delete();
        DB::table('client_user')->insert(['client_id' => $cid, 'user_id' => $this->u('LG')->id]);
        $this->deleteJson("/api/portals/$pid")->assertOk();

        $this->assertContains($cid, \App\Iratkapu\Scope::clientIds($this->u('SN')));
        $this->assertNotContains($cid, \App\Iratkapu\Scope::clientIds($this->u('LG')));
        $this->assertNotContains($cid, \App\Iratkapu\Scope::clientIds($this->u('IA')));
    }

    /** Élő lista a tárhely valódi alakjával: a postafiókok típusa és megjelenített neve külön jön (élő próba, 2026-11-12). */
    private function ingestReal(string $who, ?int $portalId, array $mailboxes, array $letters = []): array
    {
        $rows = [];
        foreach ($letters as $box => $eids) {
            foreach ($eids as $eid) {
                $rows[] = ['eid' => $eid, 'mailbox' => (string) $box, 'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal', 'type' => 'Tájékoztatás bevallásról', 'desc' => '', 'receivedAt' => '2026-11-11 08:10'];
            }
        }
        return $this->actingAs($this->u($who))->postJson('/api/live/ingest', ['autoMap' => true, 'portalId' => $portalId, 'letters' => $rows, 'mailboxes' => $mailboxes])->assertOk()->json();
    }

    public function test_valodi_alak_a_cegkapu_neve_csak_az_adoszam_torzs_a_ceg_neve_kulon_jon(): void
    {
        $pid = $this->portal('SN');
        $r = $this->ingestReal('SN', $pid, [
            ['name' => '55667780', 'displayName' => 'Valódi Alakú Kereskedelmi Kft', 'type' => 'CKP', 'isDefault' => false],
        ], ['55667780' => ['VA-1']]);

        $this->assertSame(1, $r['discovery']['created']);
        $c = DB::table('clients')->where('tax', '55667780')->first();
        $this->assertSame(['Valódi Alakú Kereskedelmi Kft', 'cegkapu'], [$c->name, $c->discovered_via]);
        $this->assertSame(1, $r['created']);
    }

    public function test_a_belepo_sajat_tarhelye_magatol_gyujtot_kap_mas_szemelyes_tarhely_besorolasra_var(): void
    {
        $pid = $this->portal('LG');
        $own = 'értesítési tárhely · 1a2b3c4d';
        $r = $this->ingestReal('LG', $pid, [
            ['name' => $own, 'displayName' => 'értesítési tárhely', 'type' => 'AP', 'isDefault' => true],
            ['name' => 'értesítési tárhely · 99998888', 'displayName' => 'értesítési tárhely', 'type' => 'AP', 'isDefault' => false],
        ], [$own => ['OWN-1']]);

        $this->assertSame(1, $r['discovery']['own']);
        $this->assertSame(1, $r['discovery']['pending']);
        $c = DB::table('clients')->where('discovered_via', 'own')->first();
        $this->assertSame([$pid, $this->u('LG')->id], [(int) $c->portal_connection_id, (int) $c->owner_user_id]);
        $this->assertSame(['ÜK', $own], [DB::table('mailboxes')->where('client_id', $c->id)->value('type'), DB::table('mailboxes')->where('client_id', $c->id)->value('live_ref')]);
        $this->assertSame(1, $r['created']); // a levél rögtön bekerült, és csak a gazda látja
        $this->assertNotContains($c->id, \App\Iratkapu\Scope::clientIds($this->u('SN')));
        $this->assertSame('AP', DB::table('discovered_mailboxes')->where('live_ref', 'értesítési tárhely · 99998888')->value('type_code'));

        // Két belépő saját tárhelye ugyanúgy hívódik, de a kulcsuk különbözik: nem keverednek.
        $pid2 = $this->portal('SN');
        $own2 = 'értesítési tárhely · 5e6f7a8b';
        $this->ingestReal('SN', $pid2, [['name' => $own2, 'displayName' => 'értesítési tárhely', 'type' => 'AP', 'isDefault' => true]], [$own2 => ['OWN-2']]);
        $this->assertSame(2, DB::table('clients')->where('discovered_via', 'own')->count());
        $this->assertFalse(collect($this->actingAs($this->u('SN'))->getJson('/api/state')->json('messages'))->contains('eid', 'OWN-1'));
        $this->assertFalse(collect($this->actingAs($this->u('LG'))->getJson('/api/state')->json('messages'))->contains('eid', 'OWN-2'));
    }

    public function test_gazda_nelkuli_belepo_sajat_tarhelye_nem_jon_letre_magatol_es_ismeretlen_tipus_fuggoben_marad(): void
    {
        $pid = $this->portal('SN', ['owner_user_id' => null]);
        $r = $this->ingestReal('SN', $pid, [
            ['name' => 'értesítési tárhely · 1a2b3c4d', 'displayName' => 'értesítési tárhely', 'type' => 'AP', 'isDefault' => true],
            ['name' => 'MINTAONK · 9f9f9f9f', 'displayName' => 'Minta Önkormányzat', 'type' => 'HKP', 'isDefault' => false],
        ]);
        $this->assertSame([0, 2], [$r['discovery']['own'], $r['discovery']['pending']]);
        $row = DB::table('discovered_mailboxes')->where('live_ref', 'MINTAONK · 9f9f9f9f')->first();
        $this->assertSame(['HKP', 'Minta Önkormányzat'], [$row->type_code, $row->parsed_name]);
        $st = $this->actingAs($this->u('SN'))->getJson('/api/state')->json('discovered');
        $this->assertSame('HKP', collect($st)->firstWhere('name', 'MINTAONK · 9f9f9f9f')['typeCode']);
    }

    /**
     * Frissítés régi adatról: a postafiók kulcsa korábban a puszta név volt. Az első szinkron az új kulccsal nem hozhat létre
     * második postafiókot, és nem hozhatja létre újra a már meglévő leveleket.
     */
    public function test_regi_kulcsu_postafiok_helyben_frissul_nem_kettozodik(): void
    {
        $pid = $this->portal('LG');
        // Régi állapot: saját tárhely gyűjtő, a postafiók kulcsa a puszta, minden belépőnél azonos név.
        $this->ingest('LG', $pid, ['értesítési tárhely' => ['RG-1', 'RG-2']]);
        $this->resolve('LG', 'értesítési tárhely', ['action' => 'own'])->assertOk();
        $this->ingest('LG', $pid, ['értesítési tárhely' => ['RG-1', 'RG-2']]);
        $cid = (int) DB::table('clients')->where('discovered_via', 'own')->value('id');
        $this->assertSame([1, 2], [DB::table('mailboxes')->where('client_id', $cid)->count(), DB::table('messages')->where('client_id', $cid)->count()]);

        $new = 'értesítési tárhely · 1a2b3c4d';
        $r = $this->ingestReal('LG', $pid, [['name' => $new, 'rawName' => 'értesítési tárhely', 'displayName' => 'értesítési tárhely', 'type' => 'AP', 'isDefault' => true]], [$new => ['RG-1', 'RG-2', 'RG-3']]);

        $this->assertSame([1, 2, 0], [$r['created'], $r['known'], $r['discovery']['own']]);
        $this->assertSame(1, DB::table('clients')->where('discovered_via', 'own')->count());
        $this->assertSame([1, $new], [DB::table('mailboxes')->where('client_id', $cid)->count(), DB::table('mailboxes')->where('client_id', $cid)->value('live_ref')]);
        $this->assertSame(3, DB::table('messages')->where('client_id', $cid)->count());

        // Ha a tárhely később átnevezi az általános szöveget, az azonosító vége alapján ugyanaz a postafiók marad.
        $renamed = 'személyes tárhely · 1a2b3c4d';
        $r2 = $this->ingestReal('LG', $pid, [['name' => $renamed, 'rawName' => 'személyes tárhely', 'displayName' => 'személyes tárhely', 'type' => 'AP', 'isDefault' => true]], [$renamed => ['RG-1']]);
        $this->assertSame([0, 1], [$r2['created'], $r2['known']]);
        $this->assertSame([1, $renamed], [DB::table('mailboxes')->where('client_id', $cid)->count(), DB::table('mailboxes')->where('client_id', $cid)->value('live_ref')]);

        // Más belépő azonos nevű régi postafiókját nem viheti el.
        $pid2 = $this->portal('SN');
        $this->ingestReal('SN', $pid2, [['name' => 'személyes tárhely · 9z9z9z9z', 'rawName' => 'személyes tárhely', 'displayName' => 'személyes tárhely', 'type' => 'AP', 'isDefault' => true]]);
        $this->assertSame($renamed, DB::table('mailboxes')->where('client_id', $cid)->value('live_ref'));
        $this->assertSame(2, DB::table('clients')->where('discovered_via', 'own')->count());
    }

    private function alapertek(array $a): void
    {
        $this->actingAs($this->u('SN'))->postJson('/api/settings', ['defaultActive' => $a])->assertOk();
    }

    public function test_cegkapu_felderites_inaktivra_allitva(): void
    {
        $this->alapertek(['cegkapu' => false]);
        $pid = $this->portal('SN');
        $this->ingest('SN', $pid, [self::UJ => ['UJ-1']]);
        $this->assertSame(0, (int) DB::table('clients')->where('tax', '55667780')->value('active'));
    }

    public function test_ajanlott_fel_forrasonkent(): void
    {
        $this->alapertek(['mail' => true, 'nav' => false]);
        $u = $this->u('SN'); $pid = $this->portal('SN'); $portal = DB::table('portal_connections')->find($pid);
        $col = ClientDiscovery::ownCollector($u, $portal);
        $ids = [];
        foreach (['mail' => '11223344', 'nav' => '22334455'] as $src => $tax) {
            $ids[$src] = DB::table('discovered_subjects')->insertGetId(['office_id' => $u->office_id, 'portal_connection_id' => $pid, 'collector_client_id' => $col->id, 'identifier' => $tax,
                'kind' => 'business', 'parsed_name' => "Forrás $src Kft", 'letters' => 0, 'state' => 'pending', 'source' => $src, 'last_seen_at' => now(), 'created_at' => now(), 'updated_at' => now()]);
            $this->actingAs($u)->postJson("/api/discovered-subjects/{$ids[$src]}", ['action' => 'create', 'authorized' => true])->assertOk();
        }
        $m = DB::table('clients')->where('tax', '11223344')->first(); $n = DB::table('clients')->where('tax', '22334455')->first();
        $this->assertSame([1, 'A saját tárhely leveleiből felvéve'], [(int) $m->active, $m->auth_basis]);
        $this->assertSame([0, 'A NAV ügyfélportál képviseleti listájából felvéve'], [(int) $n->active, $n->auth_basis]);
    }

    public function test_kezi_felvetel_mindig_aktiv(): void
    {
        $this->alapertek(['mail' => false, 'nav' => false, 'cegkapu' => false]);
        $pid = $this->portal('SN');
        $this->ingest('SN', $pid, ['Gamma Bt. cégkapu' => ['G-1']]);
        $this->resolve('SN', 'Gamma Bt. cégkapu', ['action' => 'create', 'name' => 'Gamma Bt.', 'tax' => '33445568-2-41', 'type' => 'CK', 'authorized' => true])->assertOk();
        $this->assertSame(1, (int) DB::table('clients')->where('tax', '33445568-2-41')->value('active'));
    }
}
