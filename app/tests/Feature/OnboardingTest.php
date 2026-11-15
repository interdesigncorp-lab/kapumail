<?php
namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * Asztali alkalmazás, helyi mód: jelszó nélküli, a gép kulcstartójában őrzött titokkal nyíló saját fiók,
 * a mintafelhasználók elrejtése, megjegyzett belépés és az egyfelhasználós korlátok.
 */
class OnboardingTest extends TestCase
{
    use RefreshDatabase;
    protected bool $seed = true;

    private const LOCAL = ['User-Agent' => 'Mozilla/5.0 KapuMail-Desktop/0.1.0 (local)'];
    private const SERVER = ['User-Agent' => 'Mozilla/5.0 KapuMail-Desktop/0.1.0 (server)'];
    private const TITOK = 'ez-egy-negyven-karakternel-hosszabb-veletlen-titok-0001';

    private function enter(string $secret = self::TITOK) { return $this->withHeaders(self::LOCAL)->postJson('/local/enter', ['secret' => $secret]); }

    public function test_bongeszoben_latszanak_a_mintafelhasznalok_asztali_appban_nem(): void
    {
        $this->get('/login')->assertOk()->assertSee('Demó mód')->assertSee('sn@iratkapu.test');
        $this->withHeaders(self::LOCAL)->get('/login')->assertOk()->assertDontSee('Demó mód')->assertDontSee('sn@iratkapu.test')->assertDontSee('iratkapu-demo');
        $this->withHeaders(self::SERVER)->get('/login')->assertOk()->assertDontSee('Demó mód');
    }

    public function test_helyi_fiok_csak_helyi_modu_asztali_appbol_a_sajat_geprol_nyilik(): void
    {
        $this->postJson('/local/enter', ['secret' => self::TITOK])->assertForbidden();
        $this->withHeaders(self::SERVER)->postJson('/local/enter', ['secret' => self::TITOK])->assertForbidden();
        $this->withServerVariables(['REMOTE_ADDR' => '10.0.0.7'])->withHeaders(self::LOCAL)->postJson('/local/enter', ['secret' => self::TITOK])->assertForbidden();
        $this->withServerVariables([]);
        $this->enter('rovid')->assertStatus(422);
        config(['iratkapu.local_account' => false]);
        $this->enter()->assertForbidden();
        $this->assertSame(2, DB::table('offices')->count());
    }

    public function test_az_elso_belepes_ures_sajat_irodat_hoz_letre_jelszo_nelkul(): void
    {
        $this->enter()->assertOk()->assertJson(['ok' => true, 'created' => true]);
        $u = User::where('email', 'helyi@kapumail.local')->firstOrFail();
        $this->assertAuthenticatedAs($u);
        $this->assertSame('admin', $u->role);
        $this->assertStringNotContainsString(self::TITOK, $u->password);
        $this->assertNotNull($u->fresh()->remember_token, 'A gép megjegyzi a belépést');
        $s = $this->getJson('/api/state')->assertOk()->json();
        $this->assertTrue($s['office']['single']);
        $this->assertTrue($s['office']['onboarding']);
        $this->assertSame('', $s['me']['email'], 'A belső cím nem látszik a felületen');
        $this->assertSame([], $s['clients']);
        $this->assertSame([], $s['messages']);
        $this->assertSame([], $s['portals']);
        $this->assertCount(1, $s['people']);
        $this->assertCount(6, $s['rules']);
        $this->assertSame(10, DB::table('clients')->where('office_id', 1)->count(), 'A mintairoda adatai érintetlenek');
    }

    public function test_ugyanaz_a_titok_ujra_beenged_mas_titok_nem_es_masodik_fiok_nem_jon_letre(): void
    {
        $this->enter()->assertOk();
        $this->post('/logout');
        $this->enter('egy-masik-gep-titka-ami-szinten-eleg-hosszu-0002')->assertForbidden();
        $this->assertGuest();
        $this->enter()->assertOk()->assertJson(['created' => false]);
        $this->assertSame(3, DB::table('offices')->count());
        $this->assertSame(1, DB::table('users')->where('office_id', DB::table('offices')->max('id'))->count());
    }

    public function test_nev_es_email_megadhato_es_a_belepes_utana_is_mukodik(): void
    {
        $this->enter();
        $this->postJson('/api/profile', ['name' => 'Szabó Nóra', 'email' => 'nem-cim'])->assertStatus(422);
        $this->postJson('/api/profile', ['name' => 'Szabó Nóra', 'email' => 'sn@iratkapu.test'])->assertStatus(422);
        $this->postJson('/api/profile', ['name' => 'Szabó Nóra', 'email' => 'nora@pelda.test', 'office' => 'Szabó Könyvelőiroda'])->assertOk();
        auth()->user()->refresh(); // a teszt egy folyamatban fut: a valóságban minden kérés frissen olvassa a felhasználót
        $s = $this->getJson('/api/state')->json();
        $this->assertSame(['SN', 'Szabó Nóra', 'nora@pelda.test'], [$s['me']['k'], $s['me']['name'], $s['me']['email']]);
        $this->assertSame('Szabó Könyvelőiroda', $s['office']['name']);
        $this->post('/logout');
        $this->enter()->assertOk();
        $this->assertSame('nora@pelda.test', auth()->user()->email);
        // A megadott címmel és a titokkal a sima belépőoldalon nem lehet belépni egy másik gépről kitalálva: a titok nem jelszó, amit bárki ismerne
        $this->post('/logout');
        $this->post('/login', ['email' => 'nora@pelda.test', 'password' => 'akarmi'])->assertSessionHasErrors('email');
    }

    public function test_helyi_modban_nincs_munkatars_felvetel_a_varazslo_lezarhato(): void
    {
        $this->enter();
        $this->postJson('/api/users', ['name' => 'Kolléga Kata', 'email' => 'kata@pelda.test', 'role' => 'konyvelo'])->assertForbidden();
        $this->postJson('/api/onboarding/done')->assertOk();
        $this->assertFalse($this->getJson('/api/state')->json('office.onboarding'));
        $this->assertTrue($this->getJson('/api/state')->json('office.single'));
    }

    public function test_a_mintairodaban_nincs_varazslo_van_munkatars_felvetel_es_nincs_profilmentes(): void
    {
        $this->actingAs(User::where('initials', 'IA')->firstOrFail());
        $s = $this->getJson('/api/state')->json('office');
        $this->assertFalse($s['single']); $this->assertFalse($s['onboarding']);
        $this->postJson('/api/profile', ['name' => 'Valaki Más', 'email' => 'vm@pelda.test'])->assertForbidden();
        $this->postJson('/api/users', ['name' => 'Kolléga Kata', 'email' => 'kata@pelda.test', 'role' => 'konyvelo'])->assertOk();
    }

    public function test_asztali_belepes_megjegyzi_a_gepet_bongeszos_nem(): void
    {
        $c = ['email' => 'sn@iratkapu.test', 'password' => \Database\Seeders\DatabaseSeeder::DEMO_PASSWORD];
        $this->post('/login', $c)->assertRedirect('/');
        $this->assertNull(User::where('email', $c['email'])->value('remember_token'));
        $this->post('/logout');
        $this->withHeaders(self::LOCAL)->post('/login', $c)->assertRedirect('/');
        $this->assertNotNull(User::where('email', $c['email'])->value('remember_token'));
    }
}
