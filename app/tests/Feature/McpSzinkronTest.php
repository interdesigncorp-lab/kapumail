<?php

namespace Tests\Feature;

use App\Iratkapu\DesktopAlive;
use App\Iratkapu\McpSyncRequests;
use App\Iratkapu\OfficeMail;
use App\Mcp\IratkapuServer;
use App\Mcp\McpAccess;
use App\Mcp\Tools;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/** MCP-ből indítható szinkron (ADR-016): kérések, lejárat, az asztali app életjele és indítása. */
class McpSzinkronTest extends TestCase
{
    use RefreshDatabase;

    protected bool $seed = true;

    private string $tmp;

    /** @var array<int, array<int, string>> */
    private array $launched = [];

    protected function setUp(): void
    {
        parent::setUp();
        OfficeMail::put($this->u('IA')->office_id, ['mcp' => ['enabled' => true]]);
        $this->tmp = sys_get_temp_dir().'/mcp-szinkron-'.uniqid();
        mkdir($this->tmp, 0700, true);
        DesktopAlive::$path = $this->tmp.'/desktop-alive.json';
        DesktopAlive::$runner = function (array $argv): void { $this->launched[] = $argv; };
    }

    protected function tearDown(): void
    {
        McpAccess::forget();
        DesktopAlive::$path = null;
        DesktopAlive::$runner = null;
        @unlink($this->tmp.'/desktop-alive.json');
        @rmdir($this->tmp.'/KapuMail.app');
        @rmdir($this->tmp);
        parent::tearDown();
    }

    private function u(string $k): User
    {
        return User::where('initials', $k)->firstOrFail();
    }

    private function access(string $k = 'SN', string $level = 'munka'): McpAccess
    {
        return new McpAccess($this->u($k), $level, 'teszt', tokenId: 7);
    }

    private function writeAlive(int $ageSeconds, bool $packaged = true, ?string $path = null, string $platform = 'darwin'): void
    {
        $app = $path ?? $this->tmp.'/KapuMail.app';
        @mkdir($app);
        file_put_contents(DesktopAlive::$path, json_encode(['at' => now()->subSeconds($ageSeconds)->getTimestampMs(), 'pid' => 1, 'packaged' => $packaged,
            'launch' => ['platform' => $platform, 'path' => $app]]));
    }

    public function test_keres_letrejon_es_masodik_hivas_ugyanazt_adja(): void
    {
        $a = McpSyncRequests::request($this->access(), true);
        $b = McpSyncRequests::request($this->access(), true);
        $this->assertTrue($a['created']);
        $this->assertFalse($b['created']);
        $this->assertSame($a['request']['id'], $b['request']['id']);
        $this->assertSame('pending', $a['request']['status']);
        $this->assertSame(7, (int) $a['request']['token_id']);
        $this->assertDatabaseCount('mcp_sync_requests', 1);
    }

    public function test_befejezes_utan_15_percig_retry_after(): void
    {
        $office = $this->u('SN')->office_id;
        $id = McpSyncRequests::request($this->access(), true)['request']['id'];
        $this->assertTrue(McpSyncRequests::start($office, $id));
        $this->assertTrue(McpSyncRequests::finish($office, $id, true, 'kész'));
        $again = McpSyncRequests::request($this->access(), true);
        $this->assertFalse($again['created']);
        $this->assertNotNull($again['retry_after']);
        $this->travel(16)->minutes();
        $this->assertTrue(McpSyncRequests::request($this->access(), true)['created']);
    }

    public function test_pending_lejar_ha_az_app_nem_el(): void
    {
        $office = $this->u('SN')->office_id;
        $id = McpSyncRequests::request($this->access(), false)['request']['id'];
        $this->travel(181)->seconds();
        $this->assertSame('pending', McpSyncRequests::find($office, $id, true)['status']);
        $this->assertSame('expired', McpSyncRequests::find($office, $id, false)['status']);

        $id2 = McpSyncRequests::request($this->access(), true)['request']['id'];
        $this->travel(181)->seconds();
        $this->assertSame('pending', McpSyncRequests::find($office, $id2, true)['status']);
        $this->travel(61)->minutes();
        $this->assertSame('expired', McpSyncRequests::find($office, $id2, true)['status']);
    }

    public function test_running_150_perc_utan_megszakadt(): void
    {
        $office = $this->u('SN')->office_id;
        $id = McpSyncRequests::request($this->access(), true)['request']['id'];
        McpSyncRequests::start($office, $id);
        $this->travel(121)->minutes();
        $this->assertSame('running', McpSyncRequests::find($office, $id, true)['status']);
        $this->travel(30)->minutes();
        $r = McpSyncRequests::find($office, $id, true);
        $this->assertSame('failed', $r['status']);
        $this->assertStringContainsString('megszakadt', $r['note']);
    }

    public function test_eletjel_friss_es_elavult(): void
    {
        $this->assertTrue(DesktopAlive::isAlive(['at' => now()->getTimestampMs()]));
        $this->assertFalse(DesktopAlive::isAlive(['at' => now()->subSeconds(91)->getTimestampMs()]));
        $this->assertFalse(DesktopAlive::isAlive(null));
        $this->writeAlive(5);
        $this->assertTrue(DesktopAlive::isAlive(DesktopAlive::read()));
    }

    public function test_inditas_csak_csomagolt_appnal_es_ismert_utvonallal(): void
    {
        $none = DesktopAlive::launch(null);
        $this->assertFalse($none['tried']);
        $this->assertStringContainsString('egyszer kézzel', $none['reason']);

        $this->writeAlive(600, packaged: false);
        $this->assertFalse(DesktopAlive::launch(DesktopAlive::read())['tried']);
        $this->assertSame([], $this->launched);

        $this->writeAlive(600);
        $res = DesktopAlive::launch(DesktopAlive::read());
        $this->assertTrue($res['tried']);
        $this->assertSame([['open', '-g', '-a', $this->tmp.'/KapuMail.app', '--args', '--mcp-hatter']], $this->launched);
    }

    private function as(string $k, string $level): void
    {
        McpAccess::activate(new McpAccess($this->u($k), $level, 'teszt'));
    }

    public function test_olvaso_es_kapu_szint_nem_indithat(): void
    {
        $this->as('IA', 'olvasas');
        IratkapuServer::tool(Tools\StartSync::class, [])->assertHasErrors();
        $this->as('IA', 'kapu');
        IratkapuServer::tool(Tools\StartSync::class, [])->assertHasErrors();
        $this->assertDatabaseCount('mcp_sync_requests', 0);
    }

    public function test_konyvelo_munka_szinten_sem_indithat(): void
    {
        $this->as('LG', 'munka');
        IratkapuServer::tool(Tools\StartSync::class, [])->assertHasErrors(['admin vagy vezető']);
        $this->assertDatabaseCount('mcp_sync_requests', 0);
    }

    public function test_vezeto_munka_szinten_indit_es_naplozza(): void
    {
        $this->writeAlive(5);
        $this->as('SN', 'munka');
        IratkapuServer::tool(Tools\StartSync::class, [])->assertHasNoErrors()->assertSee('request_id');
        $this->assertDatabaseCount('mcp_sync_requests', 1);
        $this->assertDatabaseHas('audit_events', ['action' => 'MCP: start_sync (teszt)']);
    }

    public function test_ismetelt_hivas_nem_nyit_ujat(): void
    {
        $this->writeAlive(5);
        $this->as('SN', 'munka');
        IratkapuServer::tool(Tools\StartSync::class, []);
        IratkapuServer::tool(Tools\StartSync::class, [])->assertHasNoErrors();
        $this->assertDatabaseCount('mcp_sync_requests', 1);
    }

    public function test_nem_futo_appnal_indit_futonal_nem(): void
    {
        $this->as('SN', 'munka');
        $this->writeAlive(5);
        IratkapuServer::tool(Tools\StartSync::class, [])->assertSee('"app_running":true');
        $this->assertSame([], $this->launched);
        \DB::table('mcp_sync_requests')->delete();
        $this->writeAlive(600);
        IratkapuServer::tool(Tools\StartSync::class, [])->assertSee('"tried":true');
        $this->assertCount(1, $this->launched);
    }

    public function test_sync_status_a_legutobbit_adja(): void
    {
        $this->writeAlive(5);
        $this->as('SN', 'munka');
        IratkapuServer::tool(Tools\StartSync::class, []);
        $this->as('SN', 'olvasas');
        IratkapuServer::tool(Tools\SyncStatus::class, [])->assertHasNoErrors()->assertSee('pending');
    }

    public function test_felulet_felveszi_lefuttatja_es_lezarja(): void
    {
        $id = McpSyncRequests::request($this->access(), true)['request']['id'];
        $this->actingAs($this->u('SN'));
        $this->getJson('/api/desktop/mcp-sync/next')->assertOk()->assertJsonPath('request.id', $id);
        $this->postJson("/api/desktop/mcp-sync/{$id}/start")->assertOk()->assertJsonPath('ok', true);
        $this->postJson("/api/desktop/mcp-sync/{$id}/finish", ['ok' => true, 'note' => '3 belépő, 2 új irat'])->assertOk()->assertJsonPath('ok', true);
        $this->assertDatabaseHas('mcp_sync_requests', ['id' => $id, 'status' => 'done', 'note' => '3 belépő, 2 új irat']);
        $this->getJson('/api/desktop/mcp-sync/next')->assertOk()->assertJsonPath('request', null);
    }

    public function test_konyvelonek_nem_ad_kerest(): void
    {
        McpSyncRequests::request($this->access(), true);
        $this->actingAs($this->u('LG'))->getJson('/api/desktop/mcp-sync/next')->assertForbidden();
    }

    public function test_masik_iroda_kereset_nem_latja(): void
    {
        $id = McpSyncRequests::request($this->access(), true)['request']['id'];
        $this->actingAs($this->u('KK'))->postJson("/api/desktop/mcp-sync/{$id}/start")->assertJsonPath('ok', false);
        $this->assertDatabaseHas('mcp_sync_requests', ['id' => $id, 'status' => 'pending']);
    }

    public function test_sikertelen_futas_oka_megmarad(): void
    {
        $id = McpSyncRequests::request($this->access(), true)['request']['id'];
        $this->actingAs($this->u('SN'));
        $this->postJson("/api/desktop/mcp-sync/{$id}/start");
        $this->postJson("/api/desktop/mcp-sync/{$id}/finish", ['ok' => false, 'note' => 'Nincs futtatható belépő'])->assertJsonPath('ok', true);
        $this->as('SN', 'olvasas');
        IratkapuServer::tool(Tools\SyncStatus::class, ['request_id' => $id])->assertSee('failed')->assertSee('Nincs futtatható belépő');
    }

    public function test_sikertelen_futas_utan_is_15_perc_kell(): void
    {
        $office = $this->u('SN')->office_id;
        $id = McpSyncRequests::request($this->access(), true)['request']['id'];
        McpSyncRequests::start($office, $id);
        McpSyncRequests::finish($office, $id, false, 'hiba');
        $again = McpSyncRequests::request($this->access(), true);
        $this->assertFalse($again['created']);
        $this->assertNotNull($again['retry_after']);
    }

    public function test_windows_inditas_ures_ablakcimmel(): void
    {
        $this->writeAlive(600, platform: 'win32');
        DesktopAlive::launch(DesktopAlive::read());
        $this->assertSame([['cmd', '/c', 'start', '', '/b', $this->tmp.'/KapuMail.app', '--mcp-hatter']], $this->launched);
    }

    public function test_sync_status_megjegyzest_csak_admin_vagy_vezeto_lat(): void
    {
        $office = $this->u('SN')->office_id;
        $id = McpSyncRequests::request($this->access(), true)['request']['id'];
        McpSyncRequests::start($office, $id);
        McpSyncRequests::finish($office, $id, true, 'Titkos Ügyfél Kft.: 2 új irat');
        $this->as('LG', 'olvasas');
        IratkapuServer::tool(Tools\SyncStatus::class, [])->assertSee('done')->assertDontSee('Titkos Ügyfél');
        $this->as('SN', 'olvasas');
        IratkapuServer::tool(Tools\SyncStatus::class, [])->assertSee('Titkos Ügyfél');
    }

    public function test_fofolyamat_ellenorizheti_a_kerest(): void
    {
        $id = McpSyncRequests::request($this->access(), true)['request']['id'];
        $this->actingAs($this->u('SN'))->getJson("/api/desktop/mcp-sync/{$id}")->assertOk()->assertJsonPath('status', 'pending');
        $this->actingAs($this->u('KK'))->getJson("/api/desktop/mcp-sync/{$id}")->assertOk()->assertJsonPath('status', null);
        $this->actingAs($this->u('LG'))->getJson("/api/desktop/mcp-sync/{$id}")->assertForbidden();
    }
}
