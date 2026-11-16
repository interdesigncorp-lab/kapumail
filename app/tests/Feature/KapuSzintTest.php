<?php

namespace Tests\Feature;

use App\Iratkapu\OfficeMail;
use App\Mcp\IratkapuServer;
use App\Mcp\McpAccess;
use App\Mcp\Tools;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** A Kapu-chat szűk MCP-szintje és az önkiszolgáló Kapu-token (ADR-014). */
class KapuSzintTest extends TestCase
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

    public function test_kapu_szint_olvaso_eszkozt_hivhat(): void
    {
        $this->as('IA', 'kapu');
        IratkapuServer::tool(Tools\SearchClients::class, [])->assertHasNoErrors();
    }

    public function test_kapu_szint_munka_eszkozt_nem_hivhat(): void
    {
        $this->as('IA', 'kapu');
        IratkapuServer::tool(Tools\CreateTask::class, ['message_id' => 1, 'title' => 'próba'])->assertHasErrors(['Kapu']);
        $this->assertSame(0, DB::table('tasks')->where('title', 'próba')->count());
    }

    public function test_kapu_szint_admin_eszkozok_kozul_csak_a_beallitasokat(): void
    {
        $this->as('IA', 'kapu');
        IratkapuServer::tool(Tools\SaveRule::class, ['confirm' => true])->assertHasErrors(['Kapu']);
        IratkapuServer::tool(Tools\GetSettings::class, [])->assertHasNoErrors();
        // Kapu szinten a módosítás jóváhagyást kér, közvetlenül nem fut le (a részletek: KapuBeallitasTest).
        IratkapuServer::tool(Tools\UpdateSettings::class, ['reminders' => [5, 1]])->assertHasNoErrors()->assertSee(['needs_approval', 'confirm_id']);
        $this->assertNotSame([5, 1], OfficeMail::settings($this->u('IA')->office_id)['reminders'] ?? null);
    }

    public function test_nem_admin_is_kerhet_kapu_tokent(): void
    {
        $lg = $this->u('LG');
        $r = $this->actingAs($lg)->postJson('/api/kapu/token', ['device' => 'Laptop'])->assertOk()->assertJson(['ok' => true]);
        $this->assertStringStartsWith('ik_', $r->json('token'));
        $row = DB::table('mcp_tokens')->where('user_id', $lg->id)->first();
        $this->assertSame('kapu', $row->level);
        $this->assertSame('Kapu – Laptop', $row->name);
        $this->assertSame(hash('sha256', $r->json('token')), $row->token_hash);
        $this->assertSame('kapu', McpAccess::fromToken($r->json('token'))->level);
    }

    public function test_kapu_me_a_bejelentkezett_felhasznalo_azonositoi(): void
    {
        $lg = $this->u('LG');
        $this->actingAs($lg)->getJson('/api/kapu/me')->assertOk()
            ->assertExactJson(['ok' => true, 'userId' => $lg->id, 'officeId' => $lg->office_id]);
    }

    public function test_kapu_me_vendegnek_nem_elerheto(): void
    {
        $this->getJson('/api/kapu/me')->assertUnauthorized();
    }

    public function test_kapu_token_valasza_az_azonositokat_is_adja(): void
    {
        $lg = $this->u('LG');
        $this->actingAs($lg)->postJson('/api/kapu/token', ['device' => 'Laptop'])->assertOk()
            ->assertJson(['ok' => true, 'userId' => $lg->id, 'officeId' => $lg->office_id]);
    }

    public function test_alapertelmezett_nev_es_hosszkorlat(): void
    {
        $lg = $this->u('LG');
        $this->actingAs($lg)->postJson('/api/kapu/token')->assertOk();
        $this->assertSame('Kapu – ez a gép', DB::table('mcp_tokens')->where('user_id', $lg->id)->value('name'));
        $this->actingAs($lg)->postJson('/api/kapu/token', ['device' => str_repeat('é', 100)])->assertOk();
        $this->assertSame('Kapu – '.str_repeat('é', 60), DB::table('mcp_tokens')->where('user_id', $lg->id)->orderByDesc('id')->value('name'));
        $this->actingAs($lg)->postJson('/api/kapu/token', ['device' => str_repeat('x', 201)])->assertStatus(422);
    }

    public function test_ugyanarra_a_gepre_uj_token_a_regit_visszavonja(): void
    {
        $lg = $this->u('LG');
        $a = $this->actingAs($lg)->postJson('/api/kapu/token', ['device' => 'Laptop'])->json('token');
        $b = $this->actingAs($lg)->postJson('/api/kapu/token', ['device' => 'Laptop'])->json('token');
        $c = $this->actingAs($lg)->postJson('/api/kapu/token', ['device' => 'Asztali'])->json('token');
        $this->assertNull(McpAccess::fromToken($a));
        $this->assertNotNull(McpAccess::fromToken($b));
        $this->assertNotNull(McpAccess::fromToken($c));
        $this->assertSame(2, DB::table('mcp_tokens')->where('user_id', $lg->id)->whereNull('revoked_at')->count());
    }

    public function test_torles_az_osszes_sajat_kapu_tokent_visszavonja_masebe_nem_nyul(): void
    {
        $lg = $this->u('LG');
        $own = McpAccess::issue($lg, 'Claude', 'olvasas', null);
        $other = $this->actingAs($this->u('IA'))->postJson('/api/kapu/token', ['device' => 'X'])->json('token');
        $a = $this->actingAs($lg)->postJson('/api/kapu/token', ['device' => 'A'])->json('token');
        $b = $this->actingAs($lg)->postJson('/api/kapu/token', ['device' => 'B'])->json('token');
        $this->actingAs($lg)->deleteJson('/api/kapu/token')->assertOk();
        $this->assertNull(McpAccess::fromToken($a));
        $this->assertNull(McpAccess::fromToken($b));
        $this->assertNotNull(McpAccess::fromToken($own['token']));
        $this->assertNotNull(McpAccess::fromToken($other));
    }

    public function test_kapu_token_kikapcsolt_mcp_mellett_nem_mukodik(): void
    {
        $t = $this->actingAs($this->u('LG'))->postJson('/api/kapu/token', [])->json('token');
        $this->assertNotNull(McpAccess::fromToken($t));
        OfficeMail::put($this->u('IA')->office_id, ['mcp' => ['enabled' => false]]);
        $this->assertNull(McpAccess::fromToken($t));
    }

    public function test_admin_kapu_token_kerese_automatikusan_bekapcsolja_az_mcp_kapcsolatot_nem_admine_nem(): void
    {
        $ia = $this->u('IA');
        $lg = $this->u('LG');
        OfficeMail::put($ia->office_id, ['mcp' => ['enabled' => false]]);

        $tNonAdmin = $this->actingAs($lg)->postJson('/api/kapu/token', ['device' => 'Könyvelő gép'])->assertOk()->json('token');
        $this->assertFalse(McpAccess::enabled($ia->office_id));
        $this->assertNull(McpAccess::fromToken($tNonAdmin));

        $tAdmin = $this->actingAs($ia)->postJson('/api/kapu/token', ['device' => 'Admin gép'])->assertOk()->json('token');
        $this->assertTrue(McpAccess::enabled($ia->office_id));
        $this->assertNotNull(McpAccess::fromToken($tAdmin));
        $this->assertTrue(DB::table('audit_events')->where('office_id', $ia->office_id)->where('action', 'like', '%AI-kapcsolat (MCP) automatikusan bekapcsolva%')->exists());
    }

    public function test_helyi_fiok_letrehozasakor_az_mcp_alapbol_be_van_kapcsolva(): void
    {
        $this->withHeaders(['User-Agent' => 'Mozilla/5.0 KapuMail-Desktop/0.1.0 (local)'])
            ->postJson('/local/enter', ['secret' => str_repeat('a', 40)])
            ->assertOk()
            ->assertJson(['ok' => true, 'created' => true]);

        $localOffice = DB::table('offices')->where('name', 'Saját iroda')->orderByDesc('id')->first();
        $this->assertNotNull($localOffice);
        $this->assertTrue(McpAccess::enabled((int) $localOffice->id));
    }

    public function test_admin_listaban_latszik_es_visszavonhato(): void
    {
        $this->actingAs($this->u('LG'))->postJson('/api/kapu/token', ['device' => 'Laptop'])->assertOk();
        $ia = $this->u('IA');
        $list = $this->actingAs($ia)->getJson('/api/mcp')->assertOk()->json('tokens');
        $kapu = collect($list)->firstWhere('name', 'Kapu – Laptop');
        $this->assertSame('kapu', $kapu['level']);
        $this->actingAs($ia)->deleteJson('/api/mcp/tokens/'.$kapu['id'])->assertOk();
        $this->assertNull(collect($this->actingAs($ia)->getJson('/api/mcp')->json('tokens'))->firstWhere('name', 'Kapu – Laptop'));
    }

    public function test_admin_a_kapu_token_szintjet_nem_emelheti(): void
    {
        $this->actingAs($this->u('LG'))->postJson('/api/kapu/token', ['device' => 'Laptop'])->assertOk();
        $ia = $this->u('IA');
        $kapu = collect($this->actingAs($ia)->getJson('/api/mcp')->json('tokens'))->firstWhere('name', 'Kapu – Laptop');
        foreach (['admin', 'munka', 'olvasas'] as $level) {
            $this->actingAs($ia)->postJson('/api/mcp/tokens/'.$kapu['id'], ['level' => $level])->assertStatus(422)->assertJson(['message' => 'A Kapu-token szintje nem módosítható. Ha nem kell, vond vissza.']);
        }
        $this->assertSame('kapu', DB::table('mcp_tokens')->find($kapu['id'])->level);
        $this->assertFalse(DB::table('audit_events')->where('action', 'like', 'MCP-token szintje:%')->exists());
    }

    public function test_audit_naplo_a_kapu_token_letrehozasarol(): void
    {
        $this->actingAs($this->u('LG'))->postJson('/api/kapu/token', ['device' => 'Laptop'])->assertOk();
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', 'Kapu-token létrehozva: Kapu – Laptop%')->exists());
    }

    public function test_a_regi_szintek_nem_valtoznak(): void
    {
        $this->as('IA', 'olvasas');
        IratkapuServer::tool(Tools\GetSettings::class, [])->assertHasNoErrors();
        IratkapuServer::tool(Tools\UpdateSettings::class, ['reminders' => [5, 1]])->assertHasErrors(['„admin” szintű']);
        IratkapuServer::tool(Tools\SaveRule::class, ['confirm' => true])->assertHasErrors(['„admin” szintű']);

        $this->as('IA', 'munka');
        IratkapuServer::tool(Tools\UpdateSettings::class, ['reminders' => [5, 1]])->assertHasErrors(['„admin” szintű']);
    }
}
