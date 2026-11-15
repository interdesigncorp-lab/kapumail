<?php

namespace Tests\Feature;

use App\Iratkapu\OfficeMail;
use App\Mcp\McpAccess;
use App\Mcp\McpPairing;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** MCP-közvetítő (ADR-013): a közvetített kérések szűrése, a nyilvános cím, és a jelszó nélküli párosítás. */
class McpRelayTest extends TestCase
{
    use RefreshDatabase;

    protected bool $seed = true;

    private const BASE = 'https://mcp.kapumail.hu/AbCdEfGhIjKlMnOpQrStUv';

    protected function setUp(): void
    {
        parent::setUp();
        OfficeMail::put($this->u('IA')->office_id, ['mcp' => ['enabled' => true]]);
    }

    private function u(string $k): User
    {
        return User::where('initials', $k)->firstOrFail();
    }

    private function relayed(): static
    {
        return $this->withHeaders(['X-KapuMail-Relay-Base' => self::BASE]);
    }

    public function test_kozvetitett_keres_nem_eri_el_a_feluletet_es_a_helyi_belepest(): void
    {
        $this->actingAs($this->u('IA'));
        $this->relayed()->getJson('/api/state')->assertForbidden();
        $this->relayed()->get('/')->assertForbidden();
        $this->relayed()->postJson('/local/enter', [])->assertForbidden();
        $this->relayed()->get('/api/documents/1')->assertForbidden();
        $this->relayed()->post('/login', ['email' => 'ia@iratkapu.test', 'password' => 'x'])->assertForbidden();
        // Közvetítő fejléc nélkül a felület változatlanul él.
        $this->withoutHeader('X-KapuMail-Relay-Base')->getJson('/api/state')->assertOk();
    }

    public function test_hamis_kozvetito_cim_elutasitva(): void
    {
        $this->withHeaders(['X-KapuMail-Relay-Base' => 'https://evil.example/AbCdEfGhIjKlMnOpQrStUv'])->getJson('/.well-known/oauth-protected-resource/mcp')->assertForbidden();
        $this->withHeaders(['X-KapuMail-Relay-Base' => self::BASE])->withServerVariables(['REMOTE_ADDR' => '203.0.113.5'])
            ->getJson('/.well-known/oauth-protected-resource/mcp')->assertForbidden();
    }

    public function test_oauth_metaadat_a_kozvetito_nyilvanos_cimere_mutat(): void
    {
        $this->relayed()->getJson('/.well-known/oauth-protected-resource/mcp')->assertOk()
            ->assertJsonPath('resource', self::BASE.'/mcp')->assertJsonPath('authorization_servers.0', self::BASE);
        $this->relayed()->getJson('/.well-known/oauth-authorization-server')->assertOk()
            ->assertJsonPath('issuer', self::BASE)
            ->assertJsonPath('authorization_endpoint', self::BASE.'/oauth/authorize')
            ->assertJsonPath('token_endpoint', self::BASE.'/oauth/token')
            ->assertJsonPath('registration_endpoint', self::BASE.'/oauth/register');
        $this->relayed()->postJson('/mcp', ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list'])
            ->assertStatus(401)->assertHeader('WWW-Authenticate', 'Bearer realm="mcp", resource_metadata="'.self::BASE.'/.well-known/oauth-protected-resource/mcp"');
    }

    public function test_belepes_helyett_parosito_oldal_es_a_suti_a_kapcsolat_utvonalan(): void
    {
        $this->relayed()->get('/login')->assertRedirect(self::BASE.'/mcp-connect');
        $res = $this->relayed()->get('/mcp-connect')->assertOk()->assertSee('Csatlakozási kód');
        $cookie = collect($res->headers->getCookies())->first(fn ($c) => $c->getName() === 'kapumail_relay_session');
        $this->assertNotNull($cookie);
        $this->assertSame('/AbCdEfGhIjKlMnOpQrStUv', $cookie->getPath());
        $this->assertTrue($cookie->isSecure());
        // Közvetítés nélkül a párosító oldal nem létezik.
        $this->withoutHeader('X-KapuMail-Relay-Base')->get('/mcp-connect')->assertNotFound();
    }

    public function test_parositas_koddal_belep_es_a_szint_a_kliensre_kerul(): void
    {
        $code = $this->actingAs($this->u('IA'))->postJson('/api/mcp/pairing', ['level' => 'admin'])->assertOk()->json('code');
        $this->assertMatchesRegularExpression('/^\d{4} \d{4}$/', $code);
        auth()->logout();

        $this->relayed()->post('/mcp-connect', ['code' => $code])->assertRedirect(self::BASE.'/mcp-connect/kesz');
        $this->assertAuthenticatedAs($this->u('IA'));

        McpPairing::applyToClient((string) $this->u('IA')->id, 'chatgpt-kliens');
        $this->assertSame('admin', McpAccess::fromOAuth($this->u('IA'), 'chatgpt-kliens', 'ChatGPT')->level);

        // Ugyanaz a kód másodszor nem jó.
        auth()->logout();
        $this->relayed()->post('/mcp-connect', ['code' => $code])->assertStatus(422);
        $this->assertGuest();
    }

    public function test_a_megszakitott_engedelyezes_helyi_cime_a_nyilvanos_cimre_fordul(): void
    {
        // A Passport a megszakított engedélyezés címét a kérés saját (helyi) címéből jegyzi meg; a böngésző a nyilvánosat kapja.
        $code = McpPairing::create($this->u('IA'), 'olvasas')['code'];
        $this->relayed()->withSession(['url.intended' => rtrim(config('app.url'), '/').'/oauth/authorize?client_id=x&state=y'])
            ->post('/mcp-connect', ['code' => $code])->assertRedirect(self::BASE.'/oauth/authorize?client_id=x&state=y');
    }

    public function test_ot_rossz_kod_utan_a_fuggo_kod_ervenytelen(): void
    {
        $code = McpPairing::create($this->u('IA'), 'olvasas')['code'];
        for ($i = 0; $i < McpPairing::MAX_ATTEMPTS; $i++) {
            $this->assertNull(McpPairing::redeem('0000 0001') ?? null);
        }
        $this->assertNull(McpPairing::redeem($code));
    }

    public function test_lejart_kod_nem_jo_es_kikapcsolt_mcp_mellett_nincs_kod(): void
    {
        $code = McpPairing::create($this->u('IA'), 'olvasas')['code'];
        DB::table('mcp_pairings')->update(['expires_at' => now()->subMinute()]);
        $this->assertNull(McpPairing::redeem($code));

        OfficeMail::put($this->u('IA')->office_id, ['mcp' => ['enabled' => false]]);
        $this->actingAs($this->u('IA'))->postJson('/api/mcp/pairing', ['level' => 'olvasas'])->assertStatus(422);
    }
}
