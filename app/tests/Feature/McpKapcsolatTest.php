<?php

namespace Tests\Feature;

use App\Iratkapu\OfficeMail;
use App\Iratkapu\Scope;
use App\Mcp\IratkapuServer;
use App\Mcp\McpAccess;
use App\Mcp\Tools;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/** AI-kapcsolat MCP-n át (ADR-012): hitelesítés, szintek, ügyfélhatókör, titkok, naplózás, dokumentumszöveg. */
class McpKapcsolatTest extends TestCase
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

    private function rpc(?string $token, string $method = 'tools/list', array $params = []): \Illuminate\Testing\TestResponse
    {
        return $this->withHeaders(array_filter(['Authorization' => $token ? "Bearer $token" : null, 'Accept' => 'application/json, text/event-stream']))
            ->postJson('/mcp', ['jsonrpc' => '2.0', 'id' => 1, 'method' => $method, 'params' => (object) $params]);
    }

    public function test_token_nelkul_401_es_oauth_utmutatas(): void
    {
        $this->rpc(null)->assertStatus(401)->assertHeader('WWW-Authenticate');
        $this->rpc('ik_rossz')->assertStatus(401);
    }

    public function test_ervenyes_token_listazza_az_eszkozoket_visszavonva_es_kikapcsolva_nem(): void
    {
        $t = McpAccess::issue($this->u('IA'), 'Claude', 'olvasas', null);
        $this->rpc($t['token'])->assertOk()->assertSee('search_clients')->assertSee('save_rule');
        $this->assertNotNull(DB::table('mcp_tokens')->find($t['id'])->last_used_at);

        OfficeMail::put($this->u('IA')->office_id, ['mcp' => ['enabled' => false]]);
        $this->rpc($t['token'])->assertStatus(401);

        OfficeMail::put($this->u('IA')->office_id, ['mcp' => ['enabled' => true]]);
        DB::table('mcp_tokens')->where('id', $t['id'])->update(['revoked_at' => now()]);
        $this->rpc($t['token'])->assertStatus(401);
    }

    public function test_lejart_token_nem_ervenyes(): void
    {
        $t = McpAccess::issue($this->u('IA'), 'Régi', 'admin', now()->subDay()->toDateTimeString());
        $this->rpc($t['token'])->assertStatus(401);
    }

    public function test_olvaso_szint_nem_irhat(): void
    {
        $this->as('LG', 'olvasas');
        $m = DB::table('messages')->whereIn('client_id', Scope::clientIds($this->u('LG')))->first();
        IratkapuServer::tool(Tools\AddNote::class, ['message_id' => $m->id, 'text' => 'próba'])->assertHasErrors(['„munka” szintű kapcsolat kell']);
        $this->assertSame(0, DB::table('notes')->where('body', 'próba')->count());

        $this->as('LG', 'munka');
        IratkapuServer::tool(Tools\AddNote::class, ['message_id' => $m->id, 'text' => 'próba'])->assertHasNoErrors();
        $this->assertSame(1, DB::table('notes')->where('body', 'próba')->count());
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', 'MCP: add_note%')->exists());
    }

    public function test_konyvelo_az_mcp_n_at_sem_lat_mas_ugyfelet(): void
    {
        $lg = $this->u('LG');
        $foreign = DB::table('clients')->where('office_id', $lg->office_id)->whereNotIn('id', Scope::clientIds($lg))->first();
        $this->assertNotNull($foreign);
        $this->as('LG', 'admin');
        IratkapuServer::tool(Tools\GetClient::class, ['client_id' => $foreign->id])->assertHasErrors();
        IratkapuServer::tool(Tools\SearchClients::class, ['query' => $foreign->name])->assertDontSee($foreign->tax);
        IratkapuServer::tool(Tools\SearchClients::class, [])->assertDontSee('Idegen Ügyfél');
    }

    public function test_admin_szintu_token_sem_ad_tobbet_a_szerepkornel(): void
    {
        $this->as('LG', 'admin'); // könyvelő
        IratkapuServer::tool(Tools\ManageUsers::class, ['action' => 'invite', 'name' => 'Új Ember', 'email' => 'uj@pelda.test', 'role' => 'konyvelo', 'confirm' => true])
            ->assertHasErrors(['Munkatársat csak admin vehet fel.']);
        $this->assertFalse(DB::table('users')->where('email', 'uj@pelda.test')->exists());
    }

    public function test_kockazatos_muvelet_elonezetet_ad_megerosites_nelkul(): void
    {
        $this->as('IA', 'admin');
        IratkapuServer::tool(Tools\ManageUsers::class, ['action' => 'invite', 'name' => 'Új Ember', 'email' => 'uj@pelda.test', 'role' => 'konyvelo'])->assertSee('preview');
        $this->assertFalse(DB::table('users')->where('email', 'uj@pelda.test')->exists());

        IratkapuServer::tool(Tools\ManageUsers::class, ['action' => 'invite', 'name' => 'Új Ember', 'email' => 'uj@pelda.test', 'role' => 'konyvelo', 'confirm' => true])->assertHasNoErrors();
        $this->assertTrue(DB::table('users')->where('email', 'uj@pelda.test')->exists());
    }

    public function test_utolso_admin_szerepkore_nem_veheto_el(): void
    {
        $this->as('IA', 'admin');
        IratkapuServer::tool(Tools\ManageUsers::class, ['action' => 'set_role', 'initials' => 'IA', 'role' => 'konyvelo', 'confirm' => true])->assertHasErrors(['utolsó adminjának']);
        IratkapuServer::tool(Tools\ManageUsers::class, ['action' => 'set_role', 'initials' => 'LG', 'role' => 'vezeto', 'confirm' => true])->assertHasNoErrors();
        $this->assertSame('vezeto', $this->u('LG')->role);
    }

    public function test_smtp_jelszo_nem_jon_vissza(): void
    {
        $this->as('IA', 'admin');
        IratkapuServer::tool(Tools\ConfigureSmtp::class, ['action' => 'save', 'host' => 'smtp.pelda.test', 'port' => 587, 'encryption' => 'starttls',
            'username' => 'iroda', 'password' => 'NagyonTitkos123', 'from' => 'iroda@pelda.test'])->assertDontSee('NagyonTitkos123');
        IratkapuServer::tool(Tools\ConfigureSmtp::class, ['action' => 'save', 'host' => 'smtp.pelda.test', 'port' => 587, 'encryption' => 'starttls',
            'username' => 'iroda', 'password' => 'NagyonTitkos123', 'from' => 'iroda@pelda.test', 'confirm' => true])->assertHasNoErrors();
        IratkapuServer::tool(Tools\GetSettings::class, [])->assertSee('smtp.pelda.test')->assertDontSee('NagyonTitkos123')->assertDontSee('eyJpdiI');
        IratkapuServer::tool(Tools\ConnectionsStatus::class, [])->assertDontSee('NagyonTitkos123')->assertDontSee('eyJpdiI');
    }

    public function test_dokumentum_szovege_es_kereses(): void
    {
        Storage::fake('local');
        $lg = $this->u('LG');
        $m = DB::table('messages')->whereIn('client_id', Scope::clientIds($lg))->first();
        $xml = '<?xml version="1.0"?><hatarozat><cim>Fizetési meghagyás</cim><szoveg>A tartozás összege 125 000 Ft, határidő 2026.12.15.</szoveg></hatarozat>';
        $id = \App\Iratkapu\Documents::store($lg->office_id, $m->id, 'hatarozat.xml', $xml, $lg->id);

        $this->as('LG', 'olvasas');
        IratkapuServer::tool(Tools\GetDocumentText::class, ['document_id' => $id])->assertSee('125 000 Ft')->assertSee('Fizetési meghagyás');
        IratkapuServer::tool(Tools\SearchDocuments::class, ['query' => 'fizetesi meghagyas'])->assertSee('hatarozat.xml');
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', 'MCP: dokumentum szövege kiolvasva%')->exists());

        $this->as('BT', 'olvasas');
        if (! in_array($m->client_id, Scope::clientIds($this->u('BT')))) {
            IratkapuServer::tool(Tools\GetDocumentText::class, ['document_id' => $id])->assertHasErrors();
            IratkapuServer::tool(Tools\SearchDocuments::class, ['query' => 'meghagyas'])->assertDontSee('hatarozat.xml');
        }
    }

    public function test_osszekottetesek_es_sugo(): void
    {
        $this->as('IA', 'olvasas');
        IratkapuServer::tool(Tools\ConnectionsStatus::class, [])->assertSee('portal_logins')->assertSee('email_smtp')->assertSee('ai_connections');
        IratkapuServer::tool(Tools\AppGuide::class, [])->assertSee('topics');
        IratkapuServer::tool(Tools\ListDeadlines::class, [])->assertHasNoErrors()->assertSee('today');
    }

    public function test_beallitasok_lap_csak_adminnak_token_egyszer_latszik_es_visszavonhato(): void
    {
        $this->actingAs($this->u('SN'))->getJson('/api/mcp')->assertForbidden();
        $this->actingAs($this->u('SN'))->postJson('/api/mcp/tokens', ['name' => 'x', 'level' => 'admin'])->assertForbidden();

        $admin = $this->actingAs($this->u('IA'));
        $token = $admin->postJson('/api/mcp/tokens', ['name' => 'Claude Desktop', 'level' => 'munka', 'user' => 'LG', 'days' => 90])->assertOk()->json('token');
        $this->assertStringStartsWith('ik_', $token);
        $row = DB::table('mcp_tokens')->where('name', 'Claude Desktop')->first();
        $this->assertSame($this->u('LG')->id, (int) $row->user_id);
        $this->assertNotSame($token, $row->token_hash);
        $admin->getJson('/api/mcp')->assertOk()->assertJsonPath('tokens.0.user', 'LG')->assertJsonPath('tokens.0.level', 'munka')->assertDontSee($token);

        $this->rpc($token)->assertOk();
        $admin = $this->actingAs($this->u('IA'));
        // Szintváltás utólag, ugyanazzal a tokennel: a kliensben nem kell semmit átírni.
        $admin->postJson("/api/mcp/tokens/{$row->id}", ['level' => 'olvasas'])->assertOk();
        $this->assertSame('olvasas', DB::table('mcp_tokens')->find($row->id)->level);
        $this->assertSame('olvasas', McpAccess::fromToken($token)->level);
        $admin = $this->actingAs($this->u('IA')); // az MCP-hívás a token gazdájára állította a tesztkörnyezet felhasználóját
        $admin->deleteJson("/api/mcp/tokens/{$row->id}")->assertOk();
        $this->rpc($token)->assertStatus(401);

        $admin = $this->actingAs($this->u('IA'));
        $admin->postJson('/api/settings/mcp', ['enabled' => false])->assertOk();
        $this->assertFalse(McpAccess::enabled($this->u('IA')->office_id));
    }

    public function test_oauth_kapcsolat_olvasasi_szinttel_indul_es_az_admin_emelheti(): void
    {
        $access = McpAccess::fromOAuth($this->u('LG'), 'kliens-1', 'ChatGPT');
        $this->assertSame('olvasas', $access->level);
        $grant = DB::table('mcp_grants')->where('oauth_client_id', 'kliens-1')->first();
        $this->actingAs($this->u('IA'))->postJson("/api/mcp/grants/{$grant->id}", ['level' => 'munka'])->assertOk();
        $this->assertSame('munka', McpAccess::fromOAuth($this->u('LG'), 'kliens-1', 'ChatGPT')->level);
        $this->actingAs($this->u('IA'))->deleteJson("/api/mcp/grants/{$grant->id}")->assertOk();
        $this->assertNull(McpAccess::fromOAuth($this->u('LG'), 'kliens-1', 'ChatGPT'));
    }

    public function test_asztali_jelentkezes_latszik_az_osszekottetesekben(): void
    {
        $this->actingAs($this->u('IA'))->postJson('/api/desktop/heartbeat', ['schedule' => 'munkanapokon 8, 12, 16 órakor', 'next' => '2026-11-14T08:00'])->assertOk();
        $this->as('IA', 'olvasas');
        IratkapuServer::tool(Tools\ConnectionsStatus::class, [])->assertSee('munkanapokon 8, 12, 16 órakor');
    }

    public function test_kulso_es_kapu_mcp_is_latja_az_adonaptar_allapotokat_nyugtaval(): void
    {
        $lg = $this->u('LG');
        $cid = Scope::clientIds($lg)[0];
        $rcpt = DB::table('messages')->where('client_id', $cid)->value('id');
        DB::table('tax_obligations')->where('client_id', $cid)->delete();
        DB::table('tax_obligations')->insert([
            ['office_id' => $lg->office_id, 'client_id' => $cid, 'source' => 'nav', 'external_key' => 'mcp-sub', 'form_code' => '2665',
                'title' => 'Bevallás az általános forgalmi adó kötelezettségének összegéről', 'due_date' => '2026-11-20',
                'conditional' => false, 'status' => 'submittable', 'barcode' => null, 'receipt_message_id' => null, 'created_at' => now(), 'updated_at' => now()],
            ['office_id' => $lg->office_id, 'client_id' => $cid, 'source' => 'nav', 'external_key' => 'mcp-done', 'form_code' => '2608',
                'title' => 'Havi adó- és járulékbevallás', 'due_date' => '2026-11-12',
                'conditional' => false, 'status' => 'submitted', 'barcode' => '9876543210', 'receipt_message_id' => $rcpt, 'created_at' => now(), 'updated_at' => now()],
        ]);

        foreach (['olvasas', 'kapu'] as $lvl) {
            $this->as('LG', $lvl);
            IratkapuServer::tool(Tools\ListDeadlines::class, ['client_id' => $cid])
                ->assertHasNoErrors()
                ->assertSee('2665')
                ->assertSee('submittable')
                ->assertSee('beadható');
            IratkapuServer::tool(Tools\GetClient::class, ['client_id' => $cid])
                ->assertHasNoErrors()
                ->assertSee('tax_obligations')
                ->assertSee('submittable')
                ->assertSee('beadható')
                ->assertSee('submitted')
                ->assertSee('beadva')
                ->assertSee('9876543210');
        }
    }

    public function test_adozoi_tablak_elerhetok_mcp_n_es_kapun_at_szigoru_ugyfelhatokorrel(): void
    {
        $lg = $this->u('LG');
        $allowedCid = Scope::clientIds($lg)[0];
        $foreign = DB::table('clients')->where('office_id', $lg->office_id)->whereNotIn('id', Scope::clientIds($lg))->firstOrFail();

        \App\Iratkapu\TaxpayerDataTables::syncClientSnapshot((int) $lg->office_id, (int) $allowedCid, [
            'insured_persons' => [['name' => 'Engedélyezett Dolgozó', 'tax_id' => '8411111119', 'taj' => '111-222-333', 'relationship_start' => '2025-02-01', 'relationship_type' => '1101 - munkaviszony', 'weekly_hours' => 40]],
            'reconciliations' => [['reconciler_name' => 'ÁFA adategyeztetés 2026', 'status' => 'Folyamatban', 'case_number' => 'EGY-101', 'created_date' => '2026-10-10']],
        ]);
        \App\Iratkapu\TaxpayerDataTables::syncClientSnapshot((int) $lg->office_id, (int) $foreign->id, [
            'insured_persons' => [['name' => 'Tiltott Idegen Dolgozó', 'tax_id' => '8499999991', 'taj' => '999-888-777', 'relationship_start' => '2025-01-01', 'relationship_type' => '1101 - munkaviszony', 'weekly_hours' => 40]],
        ]);

        foreach (['olvasas', 'kapu'] as $lvl) {
            $this->as('LG', $lvl);

            // 1. Gyors overview egy hívásban
            IratkapuServer::tool(Tools\ListTaxpayerTables::class, ['view' => 'overview'])
                ->assertHasNoErrors()
                ->assertSee('active_insured_persons')
                ->assertDontSee($foreign->name);

            // 2. Biztosítottak és Adategyeztetések szigorú ügyfélhatókörrel
            IratkapuServer::tool(Tools\ListTaxpayerTables::class, ['view' => 'insured'])
                ->assertHasNoErrors()
                ->assertSee('Engedélyezett Dolgozó')
                ->assertSee('2025-02-01')
                ->assertDontSee('Tiltott Idegen Dolgozó');

            IratkapuServer::tool(Tools\ListTaxpayerTables::class, ['view' => 'reconciliations', 'client_id' => $allowedCid])
                ->assertHasNoErrors()
                ->assertSee('ÁFA adategyeztetés 2026')
                ->assertSee('EGY-101');

            // 3. Idegen ügyfélre kérdezve elutasít
            IratkapuServer::tool(Tools\ListTaxpayerTables::class, ['view' => 'insured', 'client_id' => $foreign->id])
                ->assertHasErrors();

            // 4. GetClient adatlap és ConnectionsStatus és AppGuide is tartalmazza az új táblákat
            IratkapuServer::tool(Tools\GetClient::class, ['client_id' => $allowedCid])
                ->assertHasNoErrors()
                ->assertSee('Engedélyezett Dolgozó')
                ->assertSee('ÁFA adategyeztetés 2026')
                ->assertSee('insured_persons_total');

            IratkapuServer::tool(Tools\ConnectionsStatus::class, [])
                ->assertHasNoErrors()
                ->assertSee('latest_taxpayer_tables_at');

            IratkapuServer::tool(Tools\AppGuide::class, ['topic' => 'tables'])
                ->assertHasNoErrors()
                ->assertSee('Adózói táblák');
        }
    }
}
