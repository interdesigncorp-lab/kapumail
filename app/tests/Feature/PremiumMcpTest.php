<?php

namespace Tests\Feature;

use App\Http\Controllers\TermsController;
use App\Iratkapu\TrialLicense;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/** Szakmai MCP (jogi, könyvelői) tokenje: automatikus próba vagy előfizetés a számlázástól. */
class PremiumMcpTest extends TestCase
{
    use RefreshDatabase;

    protected bool $seed = true;

    private const DEV = '0f1e2d3c-4b5a-4978-8877-665544332211';

    private const BILLING = 'https://billing.test';

    private string $privKey = '';

    private string $trialKey = 'KTR1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    private string $mcpToken = 'KMT1.eyJ2IjoxfQ.c2lnbmF0dXJl';

    protected function setUp(): void
    {
        parent::setUp();
        $kp = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
        openssl_pkey_export($kp, $priv);
        $this->privKey = $priv;
        config([
            'iratkapu.license_public_key' => openssl_pkey_get_details($kp)['key'],
            'iratkapu.official_build' => true,
            'iratkapu.billing_url' => self::BILLING,
        ]);
    }

    private function u(string $k = 'IA'): User
    {
        return User::where('initials', $k)->firstOrFail();
    }

    private function accept(User $u): void
    {
        DB::table('terms_acceptances')->insert([
            'office_id' => $u->office_id, 'user_id' => $u->id, 'version' => TermsController::version(),
            'items' => '[]', 'hashes' => '[]', 'accepted_at' => now(),
        ]);
    }

    private function license(User $u): string
    {
        $key = TrialLicense::issueKey(['lic' => 'LIC-000042', 'plan' => 'kapu_pro', 'sub' => 'Teszt', 'exp' => now()->addYear()->toDateString()], $this->privKey);
        DB::table('offices')->where('id', $u->office_id)->update(['license_key' => $key]);

        return $key;
    }

    private function tokenOk(string $plan = 'trial'): array
    {
        return ['token' => $this->mcpToken, 'exp' => now()->addHour()->timestamp, 'ent' => ['jog', 'konyvelo'], 'plan' => $plan,
            'ends_at' => now()->addDays(14)->toDateString(), 'url' => 'https://mcp.pelda.test/mcp/'];
    }

    private function fakeBilling(array $trial = null, int $trialStatus = 200, array $token = null, int $tokenStatus = 200): void
    {
        Http::fake([
            self::BILLING.'/api/billing/mcp/trial' => Http::response($trial ?? ['trial_key' => $this->trialKey, 'ends_at' => now()->addDays(14)->toDateString()], $trialStatus),
            self::BILLING.'/api/billing/mcp/token' => Http::response($token ?? $this->tokenOk(), $tokenStatus),
        ]);
    }

    private function premium(User $u, string $device = self::DEV)
    {
        return $this->actingAs($u)->getJson('/api/kapu/premium?device='.$device);
    }

    public function test_ervenyes_licenc_200_a_token_a_valaszban_es_masodszorra_cache_bol(): void
    {
        $u = $this->u();
        $this->accept($u);
        $key = $this->license($u);
        $this->fakeBilling(token: $this->tokenOk('kapu_pro'));

        $this->premium($u)->assertOk()->assertJson(['token' => $this->mcpToken, 'plan' => 'kapu_pro', 'url' => 'https://mcp.pelda.test/mcp/']);
        $this->premium($u)->assertOk();

        Http::assertSentCount(1);
        Http::assertSent(fn (Request $r) => $r->url() === self::BILLING.'/api/billing/mcp/token' && $r['license_key'] === $key && $r['device_id'] === self::DEV && ! isset($r['trial_key']));
    }

    public function test_licenc_nelkul_elso_hivasra_proba_indul_es_a_kulcs_titkositva_tarolodik(): void
    {
        $u = $this->u();
        $this->accept($u);
        $this->fakeBilling();

        $this->premium($u)->assertOk()->assertJson(['plan' => 'trial', 'token' => $this->mcpToken]);

        Http::assertSent(fn (Request $r) => $r->url() === self::BILLING.'/api/billing/mcp/trial' && $r['device_id'] === self::DEV);
        Http::assertSent(fn (Request $r) => $r->url() === self::BILLING.'/api/billing/mcp/token' && $r['trial_key'] === $this->trialKey);
        $raw = DB::table('offices')->where('id', $u->office_id)->value('mcp_trial_key');
        $this->assertNotEmpty($raw);
        $this->assertStringNotContainsString('KTR1_', $raw);
        $this->assertSame(now()->addDays(14)->toDateString(), substr((string) DB::table('offices')->where('id', $u->office_id)->value('mcp_trial_ends_at'), 0, 10));
    }

    public function test_masodik_hivas_uritett_cache_mellett_sem_ker_uj_probat(): void
    {
        $u = $this->u();
        $this->accept($u);
        $this->fakeBilling();
        $this->premium($u)->assertOk();
        Cache::flush();
        $this->premium($u)->assertOk();

        Http::assertSentCount(3); // próba, token, token
        $this->assertCount(1, collect(Http::recorded())->filter(fn ($p) => str_ends_with($p[0]->url(), '/mcp/trial')));
    }

    public function test_elofizetes_utan_a_licenckulcsot_hasznalja(): void
    {
        $u = $this->u();
        $this->accept($u);
        $this->fakeBilling();
        $this->premium($u)->assertOk();
        $key = $this->license($u);
        $this->premium($u)->assertOk();

        $last = collect(Http::recorded())->last()[0];
        $this->assertSame($key, $last['license_key']);
        $this->assertArrayNotHasKey('trial_key', $last->data());
    }

    public function test_masik_eszkoz_ugyanazt_a_probat_hasznalja(): void
    {
        $u = $this->u();
        $this->accept($u);
        $this->fakeBilling();
        $this->premium($u)->assertOk();
        $this->premium($u, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')->assertOk();
        $this->assertCount(1, collect(Http::recorded())->filter(fn ($p) => str_ends_with($p[0]->url(), '/mcp/trial')));
    }

    public function test_elutasitott_probakulcs_utan_egyszer_ujat_ker_es_ujraprobal(): void
    {
        $u = $this->u();
        $this->accept($u);
        $old = \Illuminate\Support\Facades\Crypt::encryptString($this->trialKey);
        DB::table('offices')->where('id', $u->office_id)->update(['mcp_trial_key' => $old]);

        $newKey = 'KTR1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        Http::fake([
            self::BILLING.'/api/billing/mcp/trial' => Http::response(['trial_key' => $newKey, 'ends_at' => now()->addDays(13)->toDateString()]),
            self::BILLING.'/api/billing/mcp/token' => Http::sequence()->push(['error' => 'invalid_license'], 401)->push($this->tokenOk()),
        ]);
        $this->premium($u)->assertOk()->assertJson(['token' => $this->mcpToken]);

        Http::assertSent(fn (Request $r) => str_ends_with($r->url(), '/mcp/token') && ($r['trial_key'] ?? null) === $newKey);
        $this->assertNotSame($old, DB::table('offices')->where('id', $u->office_id)->value('mcp_trial_key'));
    }

    public function test_masodszor_is_elutasitott_probakulcs_nem_hurkol(): void
    {
        $u = $this->u();
        $this->accept($u);
        $this->fakeBilling(token: ['error' => 'invalid_license'], tokenStatus: 401);
        $this->premium($u)->assertNoContent()->assertHeader('X-Kapu-Premium-Reason', 'unavailable');
        $this->assertLessThanOrEqual(4, count(Http::recorded())); // próba, token, újrapróba, token
    }

    public function test_nem_hivatalos_build_204_not_official_billing_hivas_nelkul(): void
    {
        config(['iratkapu.official_build' => false]);
        $u = $this->u();
        $this->accept($u);
        Http::fake();
        $this->premium($u)->assertNoContent()->assertHeader('X-Kapu-Premium-Reason', 'not_official');
        Http::assertNothingSent();
    }

    public function test_el_nem_fogadott_feltetelek_204_terms(): void
    {
        $u = $this->u();
        Http::fake();
        $this->premium($u)->assertNoContent()->assertHeader('X-Kapu-Premium-Reason', 'terms');
        Http::assertNothingSent();
    }

    public function test_proba_429_trial_limit(): void
    {
        $u = $this->u();
        $this->accept($u);
        $this->fakeBilling(trial: ['error' => 'trial_limit'], trialStatus: 429);
        $this->premium($u)->assertNoContent()->assertHeader('X-Kapu-Premium-Reason', 'trial_limit');
    }

    public function test_billing_hibakodok_okra_fordulnak(): void
    {
        $u = $this->u();
        $this->accept($u);
        $this->license($u);
        $status = 0;
        Http::fake(function () use (&$status) {
            return Http::response(['error' => 'x'], $status);
        });
        foreach ([402 => 'no_entitlement', 403 => 'revoked', 409 => 'device_limit', 500 => 'unavailable', 400 => 'unavailable'] as $status => $reason) {
            Cache::flush();
            $this->premium($u)->assertNoContent()->assertHeader('X-Kapu-Premium-Reason', $reason);
        }
    }

    public function test_idotullepes_vagy_kapcsolati_hiba_unavailable(): void
    {
        $u = $this->u();
        $this->accept($u);
        $this->license($u);
        Http::fake(fn () => throw new ConnectionException('timeout'));
        $this->premium($u)->assertNoContent()->assertHeader('X-Kapu-Premium-Reason', 'unavailable');
    }

    public function test_nem_uuid_eszkoz_422(): void
    {
        $u = $this->u();
        $this->accept($u);
        $this->premium($u, 'nem-uuid')->assertStatus(422);
    }

    public function test_bejelentkezes_nelkul_401(): void
    {
        $this->getJson('/api/kapu/premium?device='.self::DEV)->assertUnauthorized();
    }

    public function test_nem_naploz_tokent_es_kulcsot(): void
    {
        $logged = [];
        Event::listen(MessageLogged::class, function (MessageLogged $e) use (&$logged) {
            $logged[] = $e->message.' '.json_encode($e->context);
        });
        $u = $this->u();
        $this->accept($u);
        $this->fakeBilling();
        $this->premium($u)->assertOk();
        $key = $this->license($u);
        Cache::flush();
        $this->premium($u)->assertOk();
        Http::fake(fn () => throw new ConnectionException('boom '.$key));
        Cache::flush();
        $this->premium($u)->assertNoContent();

        $all = implode("\n", $logged);
        foreach ([$key, $this->trialKey, $this->mcpToken] as $secret) {
            $this->assertStringNotContainsString($secret, $all);
        }
    }
}
