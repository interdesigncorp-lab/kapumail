<?php

namespace Tests\Feature;

use App\Iratkapu\FormCatalog;
use App\Iratkapu\OfficeMail;
use App\Iratkapu\OnlineSzamlaCodes;
use App\Mcp\IratkapuServer;
use App\Mcp\McpAccess;
use App\Mcp\Tools;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Nyomtatvány- és Online Számla 3.0 adókód-feloldó tesztek (ADR-012, R2).
 */
class ResolveCodeTest extends TestCase
{
    use RefreshDatabase;

    protected bool $seed = true;

    protected function setUp(): void
    {
        parent::setUp();
        OfficeMail::put($this->u('IA')->office_id, ['mcp' => ['enabled' => true]]);
    }

    protected function tearDown(): void
    {
        McpAccess::forget();
        parent::tearDown();
    }

    private function u(string $k): User
    {
        return User::where('initials', $k)->firstOrFail();
    }

    private function as(string $k, string $level): void
    {
        McpAccess::activate(new McpAccess($this->u($k), $level, 'teszt'));
    }

    private function rpc(?string $token, string $method, array $params = []): \Illuminate\Testing\TestResponse
    {
        return $this->withHeaders(array_filter(['Authorization' => $token ? "Bearer $token" : null, 'Accept' => 'application/json, text/event-stream']))
            ->postJson('/mcp', ['jsonrpc' => '2.0', 'id' => 1, 'method' => $method, 'params' => (object) $params]);
    }

    public function test_eufad37_feloldasa_afa_tv_es_a60_hivatkozasokkal(): void
    {
        $this->as('IA', 'olvasas');

        IratkapuServer::tool(Tools\ResolveCode::class, ['code' => 'EUFAD37'])
            ->assertHasNoErrors()
            ->assertSee('EUFAD37')
            ->assertSee('vatOutOfScope')
            ->assertSee('37. §')
            ->assertSee('A60');

        $t = McpAccess::issue($this->u('IA'), 'Claude', 'olvasas', null);
        $res = $this->rpc($t['token'], 'tools/call', ['name' => 'resolve_code', 'arguments' => ['code' => 'EUFAD37']])->assertOk();

        $text = $res->json('result.content.0.text');
        $this->assertIsString($text);
        $data = json_decode($text, true);

        $this->assertTrue($data['found']);
        $this->assertSame('EUFAD37', $data['code']);
        $this->assertNotNull($data['tax_code']);
        $this->assertSame('EUFAD37', $data['tax_code']['code']);
        $this->assertSame('vatOutOfScope', $data['tax_code']['category']);
        $this->assertStringContainsString('37. §', $data['tax_code']['legal_citation']);
        $this->assertStringContainsString('A60', $data['tax_code']['tax_return_relations']);
        $this->assertStringContainsString('közösségi adószám', mb_strtolower($data['tax_code']['partner_requirements']));
    }

    public function test_minden_hivatalos_online_szamla_3_adokod_feloldhato(): void
    {
        $all = OnlineSzamlaCodes::all();
        $this->assertCount(13, $all);

        // KBAET
        $kbaet = OnlineSzamlaCodes::resolve('KBAET');
        $this->assertNotNull($kbaet);
        $this->assertSame('vatExempt', $kbaet['category']);
        $this->assertStringContainsString('89. §', $kbaet['legal_citation']);
        $this->assertStringContainsString('A60', $kbaet['tax_return_relations']);

        // AAM
        $aam = OnlineSzamlaCodes::resolve('AAM');
        $this->assertNotNull($aam);
        $this->assertSame('vatExempt', $aam['category']);
        $this->assertStringContainsString('Alanyi adómentes', $aam['title']);
        $this->assertStringContainsString('187', $aam['legal_citation']);

        // TAM
        $tam = OnlineSzamlaCodes::resolve('TAM');
        $this->assertNotNull($tam);
        $this->assertSame('vatExempt', $tam['category']);
        $this->assertStringContainsString('85', $tam['legal_citation']);

        // FAD
        $fad = OnlineSzamlaCodes::resolve('FAD');
        $this->assertNotNull($fad);
        $this->assertSame('domesticReverseCharge', $fad['category']);
        $this->assertStringContainsString('142. §', $fad['legal_citation']);
        $this->assertStringContainsString('2665M', $fad['tax_return_relations']);

        // EAM
        $eam = OnlineSzamlaCodes::resolve('EAM');
        $this->assertNotNull($eam);
        $this->assertSame('vatExempt', $eam['category']);
        $this->assertStringContainsString('98', $eam['legal_citation']);
        $this->assertStringContainsString('IE599', $eam['rules']);

        // KBAUK
        $kbauk = OnlineSzamlaCodes::resolve('KBAUK');
        $this->assertNotNull($kbauk);
        $this->assertSame('vatExempt', $kbauk['category']);

        // EUFADE, ATK, HO, EUE
        $this->assertSame('vatOutOfScope', OnlineSzamlaCodes::resolve('EUFADE')['category']);
        $this->assertSame('vatOutOfScope', OnlineSzamlaCodes::resolve('ATK')['category']);
        $this->assertSame('vatOutOfScope', OnlineSzamlaCodes::resolve('HO')['category']);
        $this->assertSame('vatOutOfScope', OnlineSzamlaCodes::resolve('EUE')['category']);

        // NAM_1 és NAM_2 és változataik
        $nam1 = OnlineSzamlaCodes::resolve('NAM_1');
        $this->assertNotNull($nam1);
        $this->assertSame($nam1, OnlineSzamlaCodes::resolve('NAM-1'));
        $this->assertSame($nam1, OnlineSzamlaCodes::resolve('nam1'));

        $nam2 = OnlineSzamlaCodes::resolve('NAM_2');
        $this->assertNotNull($nam2);
        $this->assertSame($nam2, OnlineSzamlaCodes::resolve('NAM-2'));
        $this->assertSame($nam2, OnlineSzamlaCodes::resolve('nam2'));
    }

    public function test_nyomtatvanykodok_feloldasa_a_formcatalogbol(): void
    {
        $t = McpAccess::issue($this->u('IA'), 'Kapu', 'kapu', null);

        // 2608 havi adó- és járulékbevallás
        $r2608 = $this->rpc($t['token'], 'tools/call', ['name' => 'resolve_code', 'arguments' => ['code' => '2608']])->assertOk();
        $d2608 = json_decode($r2608->json('result.content.0.text'), true);
        $this->assertTrue($d2608['found']);
        $this->assertNull($d2608['tax_code']);
        $this->assertNotNull($d2608['form']);
        $this->assertSame('2608', $d2608['form']['code']);
        $this->assertStringContainsString('Havi adó- és járulékbevallás', $d2608['form']['short']);

        // 26A60 EK összesítő nyilatkozat
        $rA60 = $this->rpc($t['token'], 'tools/call', ['name' => 'resolve_code', 'arguments' => ['code' => '26A60']])->assertOk();
        $dA60 = json_decode($rA60->json('result.content.0.text'), true);
        $this->assertTrue($dA60['found']);
        $this->assertNotNull($dA60['form']);
        $this->assertSame('26A60', $dA60['form']['code']);
        $this->assertStringContainsString('összesítő nyilatkozat', $dA60['form']['short']);

        // HIPAK önkormányzati HIPA bevallás
        $rHipak = $this->rpc($t['token'], 'tools/call', ['name' => 'resolve_code', 'arguments' => ['code' => 'HIPAK']])->assertOk();
        $dHipak = json_decode($rHipak->json('result.content.0.text'), true);
        $this->assertTrue($dHipak['found']);
        $this->assertNotNull($dHipak['form']);
        $this->assertSame('ONK', $dHipak['form']['org']);
        $this->assertStringContainsString('HIPA', $dHipak['form']['short']);
    }

    public function test_ismeretlen_kod_kezelese(): void
    {
        $t = McpAccess::issue($this->u('IA'), 'Claude', 'olvasas', null);

        $res = $this->rpc($t['token'], 'tools/call', ['name' => 'resolve_code', 'arguments' => ['code' => 'TELJESEN_ISMERETLEN_999']])->assertOk();
        $data = json_decode($res->json('result.content.0.text'), true);

        $this->assertFalse($data['found']);
        $this->assertSame('TELJESEN_ISMERETLEN_999', $data['code']);
        $this->assertNull($data['tax_code']);
        $this->assertNull($data['form']);
    }

    public function test_kisbetus_es_szokozos_kodok_normalizalasa(): void
    {
        $t = McpAccess::issue($this->u('IA'), 'Claude', 'olvasas', null);

        $res = $this->rpc($t['token'], 'tools/call', ['name' => 'resolve_code', 'arguments' => ['code' => '  eufad37  ']])->assertOk();
        $data = json_decode($res->json('result.content.0.text'), true);

        $this->assertTrue($data['found']);
        $this->assertNotNull($data['tax_code']);
        $this->assertSame('EUFAD37', $data['tax_code']['code']);
    }
}
