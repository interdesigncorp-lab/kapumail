<?php

namespace Tests\Feature;

use App\Iratkapu\Documents;
use App\Iratkapu\TrialLicense;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;
use ZipArchive;

/**
 * A hivatalos kiadás 14 napos próbaidőszaka, a nyílt forráskódú (AGPLv3) saját fordítás korlátlansága,
 * a lejárat utáni szinkronzár (HTTP 402), a már letöltött dokumentumok korlátlan olvashatósága és teljes ZIP-exportja,
 * valamint az ECDSA P-256 aláírású előfizetési licenckulcsok ellenőrzése.
 */
class TrialLicenseTest extends TestCase
{
    use RefreshDatabase;

    protected bool $seed = true;

    private string $privKey = '';

    private string $pubKey = '';

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');

        $kp = openssl_pkey_new([
            'private_key_type' => OPENSSL_KEYTYPE_EC,
            'curve_name' => 'prime256v1',
        ]);
        openssl_pkey_export($kp, $priv);
        $this->privKey = $priv;
        $this->pubKey = openssl_pkey_get_details($kp)['key'];

        config([
            'iratkapu.license_public_key' => $this->pubKey,
            'iratkapu.license_private_key' => $this->privKey,
            'iratkapu.trial_days' => 14,
        ]);
    }

    private function u(string $initials): User
    {
        return User::where('initials', $initials)->firstOrFail();
    }

    public function test_nyilt_forraskodu_sajat_forditasban_harminc_nap_utan_sincs_korlatozas(): void
    {
        config(['iratkapu.official_build' => false]);
        $u = $this->u('SN');
        DB::table('offices')->where('id', $u->office_id)->update([
            'trial_started_at' => now()->subDays(45),
        ]);

        $state = $this->actingAs($u)->getJson('/api/state')->assertOk();
        $state->assertJsonPath('office.license.officialBuild', false);
        $state->assertJsonPath('office.license.state', 'open_source');
        $state->assertJsonPath('office.license.canSync', true);

        $mb = DB::table('mailboxes')->where('office_id', $u->office_id)->where('sync_state', 'ok')->first();
        $this->actingAs($u)->postJson('/api/sync', ['mailbox' => $mb->id])->assertOk();
    }

    public function test_hivatalos_kiadasban_14_napig_teljes_erteku_probaido_fut(): void
    {
        config(['iratkapu.official_build' => true]);
        $u = $this->u('SN');
        DB::table('offices')->where('id', $u->office_id)->update([
            'trial_started_at' => now()->subDays(5),
        ]);

        $state = $this->actingAs($u)->getJson('/api/state')->assertOk();
        $state->assertJsonPath('office.license.officialBuild', true);
        $state->assertJsonPath('office.license.state', 'trial');
        $state->assertJsonPath('office.license.canSync', true);
        $this->assertGreaterThanOrEqual(8, $state->json('office.license.daysLeft'));
        $this->assertLessThanOrEqual(10, $state->json('office.license.daysLeft'));

        $mb = DB::table('mailboxes')->where('office_id', $u->office_id)->where('sync_state', 'ok')->first();
        $this->actingAs($u)->postJson('/api/sync', ['mailbox' => $mb->id])->assertOk();
    }

    public function test_14_nap_utan_a_szinkron_leall_402_vel_de_a_dokumentumok_es_a_zip_export_elerheto_marad(): void
    {
        config(['iratkapu.official_build' => true]);
        $u = $this->u('SN');

        // Elmentünk egy valódi PDF dokumentumot a próbaidő lejárta előtt
        $msg = DB::table('messages')->where('office_id', $u->office_id)->first();
        $pdfBytes = "%PDF-1.4\n% Hivatalos NAV határozat teszt\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n";
        $docId = Documents::store($u->office_id, $msg->id, 'nav-hatarozat-2026.pdf', $pdfBytes, $u->id);

        // Lejár a 14 napos próbaidőszak
        DB::table('offices')->where('id', $u->office_id)->update([
            'trial_started_at' => now()->subDays(15),
        ]);

        $state = $this->actingAs($u)->getJson('/api/state')->assertOk();
        $state->assertJsonPath('office.license.state', 'expired');
        $state->assertJsonPath('office.license.canSync', false);
        $state->assertJsonPath('office.license.daysLeft', 0);
        $state->assertJsonPath('office.license.subscribeUrl', 'https://kapumail.hu/#elofizetes');
        $state->assertJsonPath('office.license.githubUrl', 'https://github.com/interdesigncorp-lab/kapumail');

        // Az új külső szinkronok és letöltések 402-vel leállnak
        $mb = DB::table('mailboxes')->where('office_id', $u->office_id)->where('sync_state', 'ok')->first();
        $this->actingAs($u)->postJson('/api/sync', ['mailbox' => $mb->id])
            ->assertStatus(402)
            ->assertJson(['trialExpired' => true]);
        $this->actingAs($u)->postJson('/api/live/ingest', ['letters' => []])->assertStatus(402);
        $this->actingAs($u)->postJson('/api/nav/ingest', ['portalId' => 1])->assertStatus(402);
        $this->actingAs($u)->postJson('/api/asp/ingest', ['subject' => ['own' => true], 'tenants' => []])->assertStatus(402);

        // Az ütemezett háttérszinkron is kihagyja a lejárt próbaidejű irodát
        $beforeCount = DB::table('messages')->where('office_id', $u->office_id)->count();
        Artisan::call('iratkapu:szinkron');
        $this->assertSame($beforeCount, DB::table('messages')->where('office_id', $u->office_id)->count());

        // Ugyanakkor a már letöltött dokumentum megnyitása, a CSV-export és a teljes ZIP-export 200 OK marad!
        $docRes = $this->actingAs($u)->get("/api/documents/{$docId}")->assertOk();
        $this->assertSame($pdfBytes, $docRes->getContent());

        $this->actingAs($u)->get('/api/export')->assertOk();

        $zipRes = $this->actingAs($u)->get('/api/export/documents')->assertOk();
        $zipPath = $zipRes->baseResponse->getFile()->getPathname();
        $zip = new ZipArchive;
        $this->assertSame(true, $zip->open($zipPath));

        $csvInside = $zip->getFromName('iratok.csv');
        $this->assertNotFalse($csvInside);
        $this->assertStringContainsString('Ügyfél;Feladó;Tárgy', $csvInside);
        $this->assertNotFalse($zip->getFromName('OLVASS_EL.txt'));

        $foundPdf = false;
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $entry = $zip->getNameIndex($i);
            if (str_ends_with((string) $entry, 'nav-hatarozat-2026.pdf')) {
                $foundPdf = true;
                $this->assertSame($pdfBytes, $zip->getFromIndex($i));
            }
        }
        $zip->close();
        $this->assertTrue($foundPdf, 'A letöltött PDF dokumentumnak benne kell lennie az exportált ZIP csomagban.');
    }

    public function test_ervenyes_ecdsa_licenckulcs_azonnal_feloldja_a_szinkront_hamis_vagy_lejart_kulcs_elutasitva(): void
    {
        config(['iratkapu.official_build' => true]);
        $leader = $this->u('SN');
        $accountant = $this->u('LG');

        DB::table('offices')->where('id', $leader->office_id)->update([
            'trial_started_at' => now()->subDays(20),
        ]);

        // Könyvelő szerepkör nem aktiválhat licencet (csak vezető / admin)
        $validKey = TrialLicense::issueKey([
            'lic' => 'LIC-2026-0042',
            'plan' => 'iroda',
            'sub' => 'Minta Könyvelőiroda Kft.',
            'exp' => now()->addYear()->toDateString(),
        ], $this->privKey);

        $this->actingAs($accountant)->postJson('/api/license/activate', ['key' => $validKey])->assertStatus(403);

        // Meghamisított kulcs elutasítva (422)
        $tampered = substr($validKey, 0, -4).'AAAA';
        $this->actingAs($leader)->postJson('/api/license/activate', ['key' => $tampered])->assertStatus(422);

        // Már lejárt kulcs elutasítva (422)
        $expiredKey = TrialLicense::issueKey([
            'lic' => 'LIC-OLD-0001',
            'plan' => 'iroda',
            'exp' => now()->subDay()->toDateString(),
        ], $this->privKey);
        $this->actingAs($leader)->postJson('/api/license/activate', ['key' => $expiredKey])->assertStatus(422);

        // Érvényes kulcs aktiválása azonnal feloldja a szinkront
        $act = $this->actingAs($leader)->postJson('/api/license/activate', ['key' => "  {$validKey}\n "])->assertOk();
        $act->assertJsonPath('license.state', 'active');
        $act->assertJsonPath('license.canSync', true);
        $act->assertJsonPath('license.licenseId', 'LIC-2026-0042');
        $act->assertJsonPath('license.plan', 'iroda');

        $mb = DB::table('mailboxes')->where('office_id', $leader->office_id)->where('sync_state', 'ok')->first();
        $this->actingAs($leader)->postJson('/api/sync', ['mailbox' => $mb->id])->assertOk();

        // Ha közvetlenül az adatbázisban átírják a dátumot aláírás nélkül, a kriptográfiai ellenőrzés megfogja
        DB::table('offices')->where('id', $leader->office_id)->update([
            'license_key' => 'KM1.hamis.kulcs',
            'license_valid_until' => '2099-12-31',
        ]);
        $this->actingAs($leader)->getJson('/api/license')
            ->assertOk()
            ->assertJsonPath('state', 'expired')
            ->assertJsonPath('canSync', false);
    }

    public function test_artisan_licenc_kiadas_parancs_ervenyes_kulcsot_general(): void
    {
        $exp = now()->addMonths(6)->toDateString();
        $code = Artisan::call('kapumail:licenc-kiadas', [
            'lic' => 'LIC-CLI-100',
            '--plan' => 'pro',
            '--exp' => $exp,
            '--sub' => 'Teszt E.V.',
        ]);
        $this->assertSame(0, $code);
        $token = trim(Artisan::output());
        $verified = TrialLicense::verifyKey($token, $this->pubKey);
        $this->assertNotNull($verified);
        $this->assertSame('LIC-CLI-100', $verified['lic']);
        $this->assertSame('pro', $verified['plan']);
        $this->assertSame($exp, $verified['exp']);
    }
}
