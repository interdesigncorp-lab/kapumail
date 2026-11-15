<?php
namespace Tests\Feature;

use App\Iratkapu\OwnMailRouter;
use App\Iratkapu\Scope;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * A könyvelő saját értesítési tárhelyére érkező ügyféliratok szétválogatása (Air. 79. §).
 * Automatikusan csak azonosító (adószám, adóazonosító jel) alapján; a név csak javaslat,
 * mert az átsorolt irat mások számára is láthatóvá válik.
 */
class SajatTarhelyTest extends TestCase
{
    use RefreshDatabase;
    protected bool $seed = true;

    private const BOX = 'Értesítési tárhely';
    private int $pid;
    private int $collector;

    protected function setUp(): void
    {
        parent::setUp();
        config(['iratkapu.live_listing' => true, 'iratkapu.live_download' => false]);
        // Lakatos Gergő (könyvelő) saját belépője és saját tárhelye. Ő látja a Borostyán Pékséget (24817365-2-13).
        $lg = $this->u('LG');
        $this->pid = DB::table('portal_connections')->insertGetId(['office_id' => $lg->office_id, 'name' => 'LG saját belépője', 'auth_mode' => 'totp', 'vault_key' => 'portal-lg-' . uniqid(), 'download_active' => true, 'owner_user_id' => $lg->id, 'created_at' => now(), 'updated_at' => now()]);
        $this->ingest([['eid' => 'ELSO', 'desc' => 'Gépjárműadó-értesítés']]);
        $this->actingAs($lg)->postJson('/api/discovered/' . DB::table('discovered_mailboxes')->where('live_ref', self::BOX)->value('id'), ['action' => 'own'])->assertOk();
        $this->collector = (int) DB::table('clients')->where('discovered_via', 'own')->value('id');
    }

    private function u(string $k): User
    {
        return User::where('initials', $k)->firstOrFail();
    }

    private function ingest(array $letters): array
    {
        $letters = array_map(fn ($l) => $l + ['mailbox' => self::BOX, 'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal', 'type' => 'Értesítés', 'desc' => '', 'receivedAt' => '2026-11-11 08:10'], $letters);
        return $this->actingAs($this->u('LG'))->postJson('/api/live/ingest', ['autoMap' => true, 'portalId' => $this->pid, 'letters' => $letters])->assertOk()->json();
    }

    private function msg(string $eid): object
    {
        return DB::table('messages')->where('source_id', "live-$eid")->firstOrFail();
    }

    private function borostyan(): object
    {
        return DB::table('clients')->where('tax', '24817365-2-13')->firstOrFail();
    }

    private function sees(string $who, string $eid): bool
    {
        return collect($this->actingAs($this->u($who))->getJson('/api/state')->json('messages'))->contains('eid', $eid);
    }

    public function test_adoszamos_level_az_ugyfel_ala_kerul_es_latszik_az_indok(): void
    {
        $r = $this->ingest([
            ['eid' => 'A-1', 'type' => 'Elfogadó nyugta', 'desc' => 'Elfogadó nyugta – 2658 bevallás, adózó: 24817365-2-13'],
            ['eid' => 'A-2', 'desc' => 'Felszólítás bevallás pótlására – Borostyán Pékség Kft. (24817365)'],
        ]);
        $this->assertSame([2, 2], [$r['created'], $r['routed']]);

        $m = $this->msg('A-1');
        $this->assertSame([$this->borostyan()->id, $this->collector, 0], [(int) $m->client_id, (int) $m->routed_from_client_id, (int) $m->route_manual]);
        $this->assertStringContainsString('24817365', $m->route_basis);
        $this->assertSame($this->borostyan()->id, (int) $this->msg('A-2')->client_id);
        $this->assertTrue(DB::table('audit_events')->where('message_id', $m->id)->where('action', 'like', 'Irat automatikusan ügyfélhez sorolva a saját tárhelyről%')->exists());

        // A besorolt irat az ügyfél láthatóságát követi: a vezető is látja; az állapot-kimenet jelzi az eredetét.
        $this->assertTrue($this->sees('SN', 'A-1'));
        $rt = collect($this->actingAs($this->u('LG'))->getJson('/api/state')->json('messages'))->firstWhere('eid', 'A-1')['rt'];
        $this->assertSame([false, false], [$rt['inOwn'], $rt['manual']]);
        $this->assertStringContainsString('24817365', $rt['basis']);
        // Ismételt listázás nem sorol át és nem kettőz.
        $r2 = $this->ingest([['eid' => 'A-1', 'type' => 'Elfogadó nyugta', 'desc' => 'Elfogadó nyugta – 2658 bevallás, adózó: 24817365-2-13']]);
        $this->assertSame([0, 1, 0], [$r2['created'], $r2['known'], $r2['routed']]);
    }

    public function test_adoazonosito_jel_alapjan_is_besorol(): void
    {
        $lg = $this->u('LG');
        $cid = DB::table('clients')->insertGetId(['office_id' => $lg->office_id, 'name' => 'Kiss Magdolna', 'tax' => '8412345678', 'created_at' => now(), 'updated_at' => now()]);
        DB::table('client_user')->insert(['client_id' => $cid, 'user_id' => $lg->id]);

        $this->ingest([['eid' => 'AJ-1', 'desc' => 'Tájékoztatás, adóazonosító jel: 8412345678']]);
        $this->assertSame($cid, (int) $this->msg('AJ-1')->client_id);
    }

    public function test_csak_a_nev_egyezese_nem_sorol_be_csak_javaslat(): void
    {
        $this->ingest([['eid' => 'N-1', 'sender' => 'X', 'senderFull' => 'Magánszemély', 'type' => 'Levél', 'desc' => 'Vacsora szombaton, a Borostyán Pékség Kft. süteményeivel']]);

        $m = $this->msg('N-1');
        $this->assertSame([$this->collector, null, $this->borostyan()->id], [(int) $m->client_id, $m->routed_from_client_id, (int) $m->route_suggest_client_id]);
        $this->assertFalse($this->sees('SN', 'N-1'));
        $rt = collect($this->actingAs($this->u('LG'))->getJson('/api/state')->json('messages'))->firstWhere('eid', 'N-1')['rt'];
        $this->assertSame([true, "c{$this->borostyan()->id}", 'Borostyán Pékség Kft.'], [$rt['inOwn'], $rt['suggest'], $rt['suggestName']]);
    }

    public function test_ket_ugyfelre_illo_level_a_gyujtoben_marad_javaslat_nelkul(): void
    {
        $masik = DB::table('clients')->where('office_id', $this->u('LG')->office_id)->where('tax', 'like', '________-_-__')->where('tax', '!=', '24817365-2-13')->first();
        $this->ingest([['eid' => 'K-1', 'desc' => "Összesítő: 24817365-2-13 és {$masik->tax}"]]);

        $m = $this->msg('K-1');
        $this->assertSame([$this->collector, null], [(int) $m->client_id, $m->route_suggest_client_id]);
    }

    public function test_inaktiv_ugyfelhez_es_ismeretlen_szamhoz_nem_sorol(): void
    {
        DB::table('clients')->where('id', $this->borostyan()->id)->update(['active' => false]);
        $this->ingest([['eid' => 'I-1', 'desc' => 'adózó: 24817365-2-13'], ['eid' => 'I-2', 'desc' => 'adózó: 99887764-2-41']]);

        $this->assertSame($this->collector, (int) $this->msg('I-1')->client_id);
        $this->assertSame($this->collector, (int) $this->msg('I-2')->client_id);
    }

    public function test_kesobb_felvett_ugyfel_levele_a_kovetkezo_listazasnal_besorolodik(): void
    {
        $letter = ['eid' => 'KF-1', 'desc' => 'adózó: 55667780-2-41'];
        $this->ingest([$letter]);
        $this->assertSame($this->collector, (int) $this->msg('KF-1')->client_id);

        $lg = $this->u('LG');
        $cid = DB::table('clients')->insertGetId(['office_id' => $lg->office_id, 'name' => 'Később Felvett Kft.', 'tax' => '55667780-2-41', 'created_at' => now(), 'updated_at' => now()]);
        DB::table('client_user')->insert(['client_id' => $cid, 'user_id' => $lg->id]);

        $r = $this->ingest([$letter]);
        $this->assertSame([1, 1], [$r['known'], $r['routed']]);
        $this->assertSame($cid, (int) $this->msg('KF-1')->client_id);
    }

    public function test_a_dontes_fuggvenye(): void
    {
        $office = $this->u('LG')->office_id;
        $d = OwnMailRouter::decide($office, 'Címzett: 24817365-2-13');
        $this->assertSame($this->borostyan()->id, $d['client']->id);
        $this->assertNull(OwnMailRouter::decide($office, 'Nincs benne semmi')['client']);
        $this->assertNull(OwnMailRouter::decide($office, 'Nincs benne semmi')['suggest']);
        // Más iroda ügyfele soha nem illeszkedik.
        $other = DB::table('offices')->where('id', '!=', $office)->value('id');
        $this->assertNull(OwnMailRouter::decide($other, 'Címzett: 24817365-2-13')['client']);
        // A saját gyűjtő neve nem javaslat.
        $this->assertNull(OwnMailRouter::decide($office, 'Saját tárhely – LG saját belépője')['suggest']);
    }

    private function reassign(string $who, string $eid, string $to)
    {
        return $this->actingAs($this->u($who))->postJson('/api/messages/m' . $this->msg($eid)->id . '/reassign', ['to' => $to]);
    }

    public function test_a_gazda_elfogadja_a_javaslatot_es_at_is_sorolhat(): void
    {
        $this->ingest([['eid' => 'J-1', 'type' => 'Levél', 'desc' => 'A Borostyán Pékség Kft. ügyében']]);
        $b = $this->borostyan()->id;

        $this->reassign('LG', 'J-1', "c$b")->assertOk()->assertJson(['clientId' => "c$b"]);
        $m = $this->msg('J-1');
        $this->assertSame([$b, $this->collector, 1, 'kézi besorolás'], [(int) $m->client_id, (int) $m->routed_from_client_id, (int) $m->route_manual, $m->route_basis]);
        $this->assertTrue($this->sees('SN', 'J-1'));
        $this->assertTrue(DB::table('audit_events')->where('message_id', $m->id)->where('action', 'like', 'Irat átsorolva:%Borostyán%')->exists());
    }

    public function test_visszatett_iratot_a_program_nem_sorolja_be_ujra(): void
    {
        $letter = ['eid' => 'V-1', 'desc' => 'adózó: 24817365-2-13'];
        $this->ingest([$letter]);
        $this->assertSame($this->borostyan()->id, (int) $this->msg('V-1')->client_id);

        $this->reassign('LG', 'V-1', 'own')->assertOk();
        $this->assertSame([$this->collector, 1], [(int) $this->msg('V-1')->client_id, (int) $this->msg('V-1')->route_manual]);

        $r = $this->ingest([$letter]);
        $this->assertSame(0, $r['routed']);
        $this->assertSame($this->collector, (int) $this->msg('V-1')->client_id);
    }

    public function test_a_vezeto_atsorolhat_vagy_visszatehet_es_utana_mar_nem_latja(): void
    {
        $this->ingest([['eid' => 'VZ-1', 'desc' => 'adózó: 24817365-2-13']]);
        $masik = DB::table('clients')->where('office_id', $this->u('SN')->office_id)->whereNull('discovered_via')->where('id', '!=', $this->borostyan()->id)->first();

        $this->reassign('SN', 'VZ-1', "c{$masik->id}")->assertOk();
        $this->assertSame($masik->id, (int) $this->msg('VZ-1')->client_id);

        $this->reassign('SN', 'VZ-1', 'own')->assertOk();
        $this->assertSame($this->collector, (int) $this->msg('VZ-1')->client_id);
        $this->assertFalse($this->sees('SN', 'VZ-1'));
        $this->reassign('SN', 'VZ-1', "c{$masik->id}")->assertStatus(404); // már nem látja, nem nyúlhat hozzá
        $this->assertTrue($this->sees('LG', 'VZ-1'));
    }

    public function test_atsorolas_korlatai(): void
    {
        $this->ingest([['eid' => 'KO-1', 'desc' => 'adózó: 24817365-2-13']]);
        $lg = $this->u('LG');
        $rejtett = DB::table('clients')->where('office_id', $lg->office_id)->whereNull('discovered_via')->whereNotIn('id', Scope::clientIds($lg))->first();
        $this->assertNotNull($rejtett);

        $this->reassign('LG', 'KO-1', "c{$rejtett->id}")->assertStatus(404);       // a célügyfelet nem látja
        $this->reassign('LG', 'KO-1', 'c999999')->assertStatus(404);
        $this->reassign('LG', 'KO-1', 'ertelmetlen')->assertStatus(422);
        $this->assertSame($this->borostyan()->id, (int) $this->msg('KO-1')->client_id);

        // Nem a saját tárhelyről érkezett irat nem sorolható át ezen az úton.
        $sima = DB::table('messages')->where('client_id', $this->borostyan()->id)->whereNull('routed_from_client_id')->first();
        $this->actingAs($this->u('SN'))->postJson("/api/messages/m{$sima->id}/reassign", ['to' => 'own'])->assertStatus(422);
        // Másik saját gyűjtő nem lehet cél.
        $this->reassign('LG', 'KO-1', "c{$this->collector}")->assertStatus(422);
    }

    /** A címzett mezőben jó eséllyel a tárhely gazdájának saját azonosítója áll: ebből nem sorolunk be, csak javaslunk. */
    public function test_a_cimzett_mezobol_csak_javaslat_lesz(): void
    {
        $this->ingest([['eid' => 'CZ-1', 'recipient' => 'Borostyán Pékség Kft. 24817365-2-13', 'desc' => 'Értesítés']]);
        $m = $this->msg('CZ-1');
        $this->assertSame([$this->collector, $this->borostyan()->id], [(int) $m->client_id, (int) $m->route_suggest_client_id]);
        $this->assertFalse($this->sees('SN', 'CZ-1'));
    }

    public function test_a_gazda_sajat_azonositoira_nem_sorol_es_nem_javasol(): void
    {
        DB::table('portal_connections')->where('id', $this->pid)->update(['self_identifiers' => json_encode(['24817365'])]);
        $this->ingest([['eid' => 'SA-1', 'desc' => 'Adóigazolás, munkáltató: 24817365-2-13 Borostyán Pékség Kft.']]);

        $m = $this->msg('SA-1');
        $this->assertSame([$this->collector, null], [(int) $m->client_id, $m->route_suggest_client_id]);

        // A felületről menthető, és csak számjegyek tárolódnak.
        $this->actingAs($this->u('SN'))->postJson('/api/portals', ['id' => $this->pid, 'name' => 'LG saját belépője', 'authMode' => 'totp', 'selfIds' => "8412345678, 24817365-2-13\nértelmetlen"])->assertOk();
        $this->assertSame(['8412345678', '24817365'], json_decode(DB::table('portal_connections')->where('id', $this->pid)->value('self_identifiers'), true));
    }

    public function test_azonos_torzsu_ket_ugyfel_eseten_nem_dont(): void
    {
        $lg = $this->u('LG');
        $cid = DB::table('clients')->insertGetId(['office_id' => $lg->office_id, 'name' => 'Borostyán fióktelep', 'tax' => '24817365-1-11', 'created_at' => now(), 'updated_at' => now()]);
        DB::table('client_user')->insert(['client_id' => $cid, 'user_id' => $lg->id]);

        $this->ingest([['eid' => 'DT-1', 'desc' => 'adózó: 24817365-2-13']]);
        $this->assertSame($this->collector, (int) $this->msg('DT-1')->client_id);
        $this->assertNull($this->msg('DT-1')->route_suggest_client_id);
    }

    public function test_a_gazda_altal_nem_latott_ugyfelhez_nem_sorol(): void
    {
        $lg = $this->u('LG');
        $rejtett = DB::table('clients')->where('office_id', $lg->office_id)->whereNull('discovered_via')->where('tax', 'like', '________-_-__')->whereNotIn('id', Scope::clientIds($lg))->first();
        $this->assertNotNull($rejtett);

        $this->ingest([['eid' => 'RL-1', 'desc' => "adózó: {$rejtett->tax} – {$rejtett->name}"]]);
        $m = $this->msg('RL-1');
        $this->assertSame([$this->collector, null], [(int) $m->client_id, $m->route_suggest_client_id]);
        $this->assertTrue($this->sees('LG', 'RL-1')); // nem tűnt el a gazda szeme elől
    }

    public function test_visszatetel_utan_mas_nem_lat_belole_semmit_es_a_gazda_ertesul(): void
    {
        DB::table('rules')->where('office_id', $this->u('LG')->office_id)->update(['matcher' => json_encode(['senders' => ['NAV']]), 'notify' => 'Vezetőnek azonnal']);
        $this->ingest([['eid' => 'VT-1', 'type' => 'Titkos tárgyú határozat', 'desc' => 'adózó: 24817365-2-13']]);
        $sn = $this->u('SN');
        $this->assertSame(1, DB::table('notifications')->where('user_id', $sn->id)->where('message_id', $this->msg('VT-1')->id)->count());

        // Könyvelő, aki az ügyfelet látja, de nem gazdája a tárhelynek és nem vezető: nem teheti vissza.
        $masikKonyvelo = User::where('role', 'konyvelo')->where('id', '!=', $this->u('LG')->id)->get()->first(fn ($x) => in_array($this->borostyan()->id, Scope::clientIds($x)));
        if ($masikKonyvelo) $this->actingAs($masikKonyvelo)->postJson('/api/messages/m' . $this->msg('VT-1')->id . '/reassign', ['to' => 'own'])->assertStatus(403);

        $this->reassign('SN', 'VT-1', 'own')->assertOk();
        $this->assertSame(0, DB::table('notifications')->where('user_id', $sn->id)->where('message_id', $this->msg('VT-1')->id)->count());
        $this->assertStringNotContainsString('Titkos', json_encode($this->actingAs($sn)->getJson('/api/state')->json('notifications'), JSON_UNESCAPED_UNICODE));
        $this->assertSame(1, DB::table('notifications')->where('user_id', $this->u('LG')->id)->where('body', 'like', '%visszakerült a saját tárhelyedre%')->count());
    }

    public function test_kesobb_besorolt_nyugta_is_parosul_es_visszatetelkor_a_parositas_megszunik(): void
    {
        $letter = ['eid' => 'NY-1', 'type' => 'Elfogadó nyugta', 'desc' => 'Elfogadó nyugta – 2658 bevallás, adózó: 55667780-2-41'];
        $this->ingest([$letter]);
        $lg = $this->u('LG');
        $cid = DB::table('clients')->insertGetId(['office_id' => $lg->office_id, 'name' => 'Később Felvett Kft.', 'tax' => '55667780-2-41', 'created_at' => now(), 'updated_at' => now()]);
        DB::table('client_user')->insert(['client_id' => $cid, 'user_id' => $lg->id]);
        $ob = DB::table('tax_obligations')->insertGetId(['office_id' => $lg->office_id, 'client_id' => $cid, 'source' => 'upo', 'external_key' => 'teszt-2658', 'form_code' => '2658', 'title' => 'Járulékbevallás',
            'due_date' => '2026-11-12', 'status' => 'submittable', 'created_at' => now(), 'updated_at' => now()]);

        $this->ingest([$letter]); // most már van ügyfél: besorolódik, és a nyugta párosul
        $this->assertSame($cid, (int) $this->msg('NY-1')->client_id);
        $this->assertSame([$this->msg('NY-1')->id, 'submitted'], [(int) DB::table('tax_obligations')->where('id', $ob)->value('receipt_message_id'), DB::table('tax_obligations')->where('id', $ob)->value('status')]);

        $this->reassign('LG', 'NY-1', 'own')->assertOk();
        $this->assertNull(DB::table('tax_obligations')->where('id', $ob)->value('receipt_message_id'));
    }

    public function test_dokumentum_megnyitasa_az_ugyfel_neve_alatt_naplozodik(): void
    {
        \Illuminate\Support\Facades\Storage::fake('local');
        config(['iratkapu.live_download' => true]);
        $this->ingest([['eid' => 'DOK-1', 'type' => 'Magánlevél', 'desc' => 'Titkos melléklet']]);
        $m = $this->msg('DOK-1');
        $doc = $this->actingAs($this->u('LG'))->postJson("/api/messages/m{$m->id}/live-download", ['fileName' => 'titkos-melleklet.pdf', 'bytesBase64' => base64_encode(\App\Iratkapu\Samples::pdf('x'))])->assertOk()->json('docId');
        $this->get("/api/documents/$doc")->assertOk();

        $row = DB::table('audit_events')->where('action', 'like', 'Dokumentum megnyitva:%')->orderByDesc('id')->first();
        $this->assertSame($this->collector, (int) $row->client_id);
        $this->assertStringNotContainsString('titkos-melleklet', json_encode($this->actingAs($this->u('IA'))->getJson('/api/state')->json('audit'), JSON_UNESCAPED_UNICODE));
    }

    /** A saját tárhely a tulajdonosa nevét a levelek címzettjéből kapja meg; kézzel átírt nevet a program nem ír felül. */
    public function test_a_gyujto_a_cimzett_nevet_kapja_ha_egyertelmu(): void
    {
        $name = fn () => DB::table('clients')->where('id', $this->collector)->value('name');
        $this->assertSame('Saját tárhely – LG saját belépője', $name());

        // vegyes címzettek: nem egyértelmű, a név marad
        $this->ingest([['eid' => 'N-1', 'recipient' => 'MINTA BÉLA'], ['eid' => 'N-2', 'recipient' => 'MÁS VALAKI'], ['eid' => 'N-3', 'recipient' => '']]);
        $this->assertSame('Saját tárhely – LG saját belépője', $name());

        $this->ingest([['eid' => 'N-4', 'recipient' => 'LAKATOS GERGŐ'], ['eid' => 'N-5', 'recipient' => 'LAKATOS GERGŐ'], ['eid' => 'N-6', 'recipient' => 'Lakatos Gergő'], ['eid' => 'N-7', 'recipient' => '<b>x</b>']]);
        $this->assertSame('Saját tárhely – Lakatos Gergő', $name());

        DB::table('clients')->where('id', $this->collector)->update(['name' => 'Gergő magán']);
        $this->ingest([['eid' => 'N-8', 'recipient' => 'LAKATOS GERGŐ'], ['eid' => 'N-9', 'recipient' => 'LAKATOS GERGŐ']]);
        $this->assertSame('Gergő magán', $name());
    }

    private function subjects(string $who = 'LG'): \Illuminate\Support\Collection
    {
        return collect($this->actingAs($this->u($who))->getJson('/api/state')->json('subjects'));
    }

    /** A saját tárhely leveleinek tárgyából („azonosító - NÉV - …”) a még ismeretlen felek névvel felajánlódnak; ügyfél magától nem jön létre. */
    public function test_ismeretlen_fel_nevvel_felajanlodik_a_targybol(): void
    {
        $before = DB::table('clients')->count();
        $this->ingest([
            ['eid' => 'F-1', 'desc' => '8412345678 - MINTA BÉLA - Tájékoztatás az adószámláról'],
            ['eid' => 'F-2', 'desc' => '8412345678 - MINTA BÉLA - I. fokú határozat'],
            ['eid' => 'F-3', 'desc' => '55667788 - Új Cég Kft - Értesítés'],
            ['eid' => 'F-4', 'desc' => '44556677 - KISS ANNA e.v. - Értesítés'],
            ['eid' => 'F-5', 'desc' => '33445566 - Nagy Ottó'],
            ['eid' => 'F-6', 'desc' => 'Gépjárműadó-értesítés'],
            ['eid' => 'F-7', 'desc' => 'Értesítés a 24817365-2-13 adószámú adózóról'], // ismert ügyfél: besorolódik, nem ajánlat
        ]);
        $this->assertSame($before, DB::table('clients')->count(), 'ügyfél magától nem jön létre');
        $s = $this->subjects()->keyBy('identifier');
        $this->assertEqualsCanonicalizing(['8412345678', '55667788', '44556677', '33445566'], $s->keys()->all());
        $this->assertSame(['person', 'Minta Béla', 2], [$s['8412345678']['kind'], $s['8412345678']['name'], $s['8412345678']['letters']]);
        $this->assertSame(['business', 'Új Cég Kft'], [$s['55667788']['kind'], $s['55667788']['name']]);
        $this->assertSame(['sole', 'Kiss Anna e.v.'], [$s['44556677']['kind'], $s['44556677']['name']]);
        $this->assertSame('sole', $s['33445566']['kind'], 'adószám, de nincs cégforma a névben: egyéni vállalkozónak vesszük');
        $this->assertSame([], $this->subjects('SN')->all(), 'a saját tárhely magán: az ajánlatot csak a gazdája látja');
    }

    public function test_csak_vallalkozasok_beallitasnal_maganszemely_es_egyeni_vallalkozo_nem_ajanlodik(): void
    {
        DB::table('portal_connections')->where('id', $this->pid)->update(['subject_scope' => 'business']);
        $this->ingest([
            ['eid' => 'V-1', 'desc' => '8412345678 - MINTA BÉLA - Tájékoztatás az adószámláról'],
            ['eid' => 'V-2', 'desc' => '55667788 - Új Cég Kft - Értesítés'],
            ['eid' => 'V-3', 'desc' => '44556677 - KISS ANNA e.v. - Értesítés'],
        ]);
        $this->assertSame(['55667788'], $this->subjects()->pluck('identifier')->all());

        // a beállítás menthető és visszaolvasható
        $this->actingAs($this->u('SN'))->postJson('/api/portals', ['id' => $this->pid, 'name' => 'LG saját belépője', 'authMode' => 'totp', 'subjectScope' => 'all'])->assertOk(); // belépőt vezető menthet
        $this->assertSame('all', collect($this->actingAs($this->u('LG'))->getJson('/api/state')->json('portals'))->firstWhere('id', $this->pid)['subjectScope']);
    }

    public function test_az_ajanlat_jovahagyasa_ugyfelet_vesz_fel_es_besorolja_a_leveleit(): void
    {
        $this->ingest([
            ['eid' => 'J-1', 'desc' => '8412345678 - MINTA BÉLA - Tájékoztatás az adószámláról'],
            ['eid' => 'J-2', 'desc' => '8412345678 - MINTA BÉLA - I. fokú határozat'],
            ['eid' => 'J-3', 'desc' => '8499999999 - LAKATOS GERGŐ - Tájékoztatás az adószámláról'],
        ]);
        $s = $this->subjects()->keyBy('identifier');
        $post = fn (string $who, int $id, array $body) => $this->actingAs($this->u($who))->postJson("/api/discovered-subjects/$id", $body);

        $post('SN', $s['8412345678']['id'], ['action' => 'ignore'])->assertStatus(403);
        $post('LG', $s['8412345678']['id'], ['action' => 'create', 'name' => 'Minta Béla'])->assertStatus(422); // meghatalmazás megerősítése nélkül nem
        $cid = (int) substr($post('LG', $s['8412345678']['id'], ['action' => 'create', 'name' => 'Minta Béla', 'authorized' => true])->assertOk()->json('clientId'), 1);

        $c = DB::table('clients')->find($cid);
        $this->assertSame(['Minta Béla', '8412345678'], [$c->name, $c->tax]);
        $this->assertSame([$cid, $cid], [$this->msg('J-1')->client_id, $this->msg('J-2')->client_id], 'a két levele átkerült hozzá');
        $this->assertSame($this->collector, (int) $this->msg('J-3')->client_id);
        $this->assertTrue($this->sees('LG', 'J-1'));

        // „ez én vagyok”: a saját azonosítók közé kerül, ügyfél nem lesz belőle, és többé nem ajánlódik
        $post('LG', $s['8499999999']['id'], ['action' => 'self'])->assertOk();
        $this->assertContains('8499999999', json_decode(DB::table('portal_connections')->where('id', $this->pid)->value('self_identifiers'), true));
        $this->ingest([['eid' => 'J-4', 'desc' => '8499999999 - LAKATOS GERGŐ - Értesítés']]);
        $this->assertSame([], $this->subjects()->all());
        $this->assertSame($this->collector, (int) $this->msg('J-4')->client_id);
    }
}
