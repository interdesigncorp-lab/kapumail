<?php

namespace Tests\Feature;

use App\Http\Controllers\TermsController;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * Szerződési feltételek: a szövegek olvashatók, az elfogadás csak mind a négy nyilatkozat külön bejelölésével
 * rögzül, a szövegek lenyomatával és auditbejegyzéssel; új verziónál (akár a kapumail.hu-ról szinkronizálva is)
 * újra el kell fogadni, hiba vagy offline állapot esetén pedig a csomagolt szöveg marad érvényben.
 */
class TermsTest extends TestCase
{
    use RefreshDatabase;

    protected bool $seed = true;

    private const ALL = ['aszf' => true, 'uzleti' => true, 'kiemelt' => true, 'meghatalmazas' => true];

    private string $tempCacheDir = '';

    protected function setUp(): void
    {
        parent::setUp();
        $this->tempCacheDir = sys_get_temp_dir().'/kapumail-terms-test-'.uniqid('', true);
        config(['iratkapu.terms_cache_dir' => $this->tempCacheDir]);
        Cache::forget(TermsController::SYNC_CACHE_KEY);
    }

    protected function tearDown(): void
    {
        if ($this->tempCacheDir !== '' && is_dir($this->tempCacheDir)) {
            File::deleteDirectory($this->tempCacheDir);
        }
        parent::tearDown();
    }

    private function u(string $k): User
    {
        return User::where('initials', $k)->firstOrFail();
    }

    private function version(): string
    {
        return config('iratkapu.terms_version');
    }

    public function test_elfogadas_nelkul_a_felhasznalo_meg_nem_fogadta_el_es_bejelentkezes_kell(): void
    {
        $this->getJson('/api/terms')->assertUnauthorized();
        $this->actingAs($this->u('SN'))->getJson('/api/terms')->assertOk()
            ->assertJson(['version' => $this->version(), 'accepted' => false])->assertJsonCount(3, 'docs');
    }

    public function test_minden_nyilatkozatot_kulon_be_kell_jelolni(): void
    {
        $u = $this->u('SN');
        foreach (array_keys(self::ALL) as $missing) {
            $items = self::ALL;
            $items[$missing] = false;
            $this->actingAs($u)->postJson('/api/terms/accept', ['version' => $this->version(), 'items' => $items])->assertStatus(422);
        }
        $this->actingAs($u)->postJson('/api/terms/accept', ['version' => $this->version(), 'items' => []])->assertStatus(422);
        $this->assertSame(0, DB::table('terms_acceptances')->count());
    }

    public function test_az_elfogadas_a_szovegek_lenyomataval_es_auditbejegyzessel_rogzul_egyszer(): void
    {
        $u = $this->u('SN');
        $this->actingAs($u)->postJson('/api/terms/accept', ['version' => $this->version(), 'items' => self::ALL])->assertOk()->assertJson(['ok' => true]);
        $this->actingAs($u)->postJson('/api/terms/accept', ['version' => $this->version(), 'items' => self::ALL])->assertOk();
        $rows = DB::table('terms_acceptances')->where('user_id', $u->id)->get();
        $this->assertCount(1, $rows, 'Ismételt elfogadás nem ír új sort');
        $hashes = json_decode($rows[0]->hashes, true);
        $this->assertSame(hash_file('sha256', resource_path('legal/ASZF.md')), $hashes['aszf']);
        $this->assertSame(['aszf', 'uzleti', 'kiemelt', 'meghatalmazas'], json_decode($rows[0]->items, true));
        $this->assertSame($u->office_id, $rows[0]->office_id);
        $this->assertTrue(DB::table('audit_events')->where('actor_id', $u->id)->where('action', 'like', 'Szerződési feltételek elfogadva%')->exists());
        $this->actingAs($u)->getJson('/api/terms')->assertJson(['accepted' => true]);
        $this->actingAs($this->u('IA'))->getJson('/api/terms')->assertJson(['accepted' => false], 'Más felhasználó helyett nem fogad el');
    }

    public function test_regi_verzio_elfogadasa_elutasitva_uj_verzional_ujra_el_kell_fogadni(): void
    {
        $u = $this->u('SN');
        $this->actingAs($u)->postJson('/api/terms/accept', ['version' => 'régi', 'items' => self::ALL])->assertStatus(409);
        $this->actingAs($u)->postJson('/api/terms/accept', ['version' => $this->version(), 'items' => self::ALL])->assertOk();
        config(['iratkapu.terms_version' => '1.0 (teszt)']);
        $this->actingAs($u)->getJson('/api/terms')->assertJson(['accepted' => false, 'version' => '1.0 (teszt)']);
    }

    public function test_a_dokumentumok_bejelentkezes_nelkul_olvashatok_a_hivatkozasok_a_programon_belul_maradnak(): void
    {
        $r = $this->get('/legal/aszf')->assertOk()->assertHeader('Content-Type', 'text/html; charset=UTF-8');
        $r->assertSee('Általános Szerződési Feltételek')->assertSee('Kiemelt rendelkezések')->assertSee('Laczkovszki Gábor E.V.');
        $r->assertSee('GNU AGPLv3')->assertSee('14 napig minden funkcióját díjmentesen használhatja')->assertDontSee('MIT licenc');
        $r->assertSee('href="/legal/adatkezeles"', false)->assertDontSee('ADATKEZELESI-TAJEKOZTATO.md', false);
        $this->assertStringContainsString("default-src 'none'", $r->headers->get('Content-Security-Policy'));
        $this->get('/legal/adatkezeles')->assertOk()->assertSee('Nemzeti Adatvédelmi')->assertSee('Laczkovszki Gábor E.V.')->assertDontSee('Adatvédelmi tisztviselő');
        $this->get('/legal/adatfeldolgozas')->assertOk()->assertSee('GDPR 28. cikk')->assertSee('Laczkovszki Gábor E.V.');
        $this->get('/legal/titkos')->assertNotFound();
    }

    public function test_a_nyitokepernyo_elfogadasa_a_helyi_belepessel_rogzul_egyszer(): void
    {
        $local = ['User-Agent' => 'Mozilla/5.0 KapuMail-Desktop/0.1.0 (local)'];
        $secret = 'ez-egy-negyven-karakternel-hosszabb-veletlen-titok-0001';
        $this->withHeaders($local)->postJson('/local/enter', ['secret' => $secret])->assertOk();
        $this->assertSame(0, DB::table('terms_acceptances')->count(), 'Pipa nélkül nincs elfogadás');
        $this->getJson('/api/terms')->assertJson(['accepted' => false]);

        $this->withHeaders($local)->postJson('/local/enter', ['secret' => $secret, 'terms' => true])->assertOk();
        $this->withHeaders($local)->postJson('/local/enter', ['secret' => $secret, 'terms' => true])->assertOk();
        $row = DB::table('terms_acceptances')->sole();
        $this->assertSame($this->version(), $row->version);
        $this->assertSame(['aszf', 'uzleti', 'kiemelt', 'meghatalmazas'], json_decode($row->items, true));
        $this->assertTrue(DB::table('audit_events')->where('evidence', 'like', '%nyitóképernyőn%')->exists());
        $this->getJson('/api/terms')->assertJson(['accepted' => true]);
    }

    public function test_a_landing_jogi_jegyzeke_es_oldalai_szinkronban_vannak_a_kozos_forrassal(): void
    {
        $landingJogi = base_path('../marketing/landing/jogi');
        if (! is_dir($landingJogi) || ! file_exists($landingJogi.'/manifest.json')) {
            $this->markTestSkipped('marketing/landing/jogi nem érhető el');
        }

        $manifest = json_decode((string) file_get_contents($landingJogi.'/manifest.json'), true);
        $this->assertIsArray($manifest);
        $this->assertSame($this->version(), $manifest['version']);

        foreach (TermsController::DOCS as $key => [$srcFile]) {
            $expectedSha = hash_file('sha256', resource_path('legal/'.$srcFile));
            $this->assertSame($expectedSha, $manifest['docs'][$key]['sha256'] ?? null, "Eltérő SHA-256 ($key) – futtasd a marketing/landing/jogi-oldalak.sh szkriptet!");
            $this->assertSame($expectedSha, hash_file('sha256', $landingJogi.'/'.$key.'.md'));
            $html = (string) file_get_contents($landingJogi.'/'.$key.'.html');
            $this->assertStringContainsString('Laczkovszki Gábor E.V.', $html);
        }

        $impresszum = (string) file_get_contents($landingJogi.'/impresszum.html');
        $this->assertStringContainsString('Laczkovszki Gábor E.V.', $impresszum);
        $this->assertMatchesRegularExpression('/\b\d{8}\b/', $impresszum);
        $this->assertMatchesRegularExpression('/\b\d{8}-\d-\d{2}\b/', $impresszum);
        $this->assertStringContainsString('info@kapumail.hu', $impresszum);
    }

    public function test_tavoli_uj_verzio_eseten_a_program_frissit_a_kapumail_hu_rol_es_ujra_elfogadtat(): void
    {
        $u = $this->u('SN');
        $this->actingAs($u)->postJson('/api/terms/accept', ['version' => $this->version(), 'items' => self::ALL])->assertOk();

        $newAszf = "# KapuMail – ÁSZF 2.0\n\nÚj távszinkronizált feltétel [Adatkezelés](ADATKEZELESI-TAJEKOZTATO.md).";
        $newAdat = '# KapuMail – Adatkezelési tájékoztató 2.0';
        $newFeld = '# KapuMail – Adatfeldolgozási feltételek 2.0';

        Http::fake([
            'https://kapumail.hu/jogi/manifest.json' => Http::response([
                'version' => '2.0 (2026-12-01)',
                'docs' => [
                    'aszf' => ['file' => 'aszf.md', 'title' => 'ÁSZF', 'sha256' => hash('sha256', $newAszf)],
                    'adatkezeles' => ['file' => 'adatkezeles.md', 'title' => 'Adatkezelés', 'sha256' => hash('sha256', $newAdat)],
                    'adatfeldolgozas' => ['file' => 'adatfeldolgozas.md', 'title' => 'Adatfeldolgozás', 'sha256' => hash('sha256', $newFeld)],
                ],
            ], 200),
            'https://kapumail.hu/jogi/aszf.md' => Http::response($newAszf, 200),
            'https://kapumail.hu/jogi/adatkezeles.md' => Http::response($newAdat, 200),
            'https://kapumail.hu/jogi/adatfeldolgozas.md' => Http::response($newFeld, 200),
        ]);

        config(['iratkapu.terms_remote_url' => 'https://kapumail.hu/jogi/manifest.json']);
        Cache::forget(TermsController::SYNC_CACHE_KEY);

        $this->actingAs($u)->getJson('/api/terms')->assertOk()
            ->assertJson(['version' => '2.0 (2026-12-01)', 'accepted' => false]);

        $this->get('/legal/aszf')->assertOk()
            ->assertSee('Új távszinkronizált feltétel')
            ->assertSee('href="/legal/adatkezeles"', false);

        $this->actingAs($u)->postJson('/api/terms/accept', ['version' => '2.0 (2026-12-01)', 'items' => self::ALL])->assertOk();
        $latest = DB::table('terms_acceptances')->where('user_id', $u->id)->orderByDesc('id')->first();
        $this->assertSame('2.0 (2026-12-01)', $latest->version);
        $this->assertSame(hash('sha256', $newAszf), json_decode($latest->hashes, true)['aszf']);
    }

    public function test_hibas_lenyomat_vagy_halozati_hiba_eseten_a_csomagolt_szoveg_marad(): void
    {
        Http::fake([
            'https://kapumail.hu/jogi/manifest.json' => Http::response([
                'version' => '9.9 (hibás)',
                'docs' => [
                    'aszf' => ['file' => 'aszf.md', 'title' => 'ÁSZF', 'sha256' => str_repeat('a', 64)],
                    'adatkezeles' => ['file' => 'adatkezeles.md', 'title' => 'Adatkezelés', 'sha256' => str_repeat('b', 64)],
                    'adatfeldolgozas' => ['file' => 'adatfeldolgozas.md', 'title' => 'Adatfeldolgozás', 'sha256' => str_repeat('c', 64)],
                ],
            ], 200),
            'https://kapumail.hu/jogi/*' => Http::response('csonka tartalom, nem egyező lenyomat', 200),
        ]);

        config(['iratkapu.terms_remote_url' => 'https://kapumail.hu/jogi/manifest.json']);
        Cache::forget(TermsController::SYNC_CACHE_KEY);

        $this->actingAs($this->u('SN'))->getJson('/api/terms')->assertOk()
            ->assertJson(['version' => $this->version()]);
        $this->get('/legal/aszf')->assertOk()->assertSee('Kiemelt rendelkezések');
    }
}
