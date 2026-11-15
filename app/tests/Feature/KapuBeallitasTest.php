<?php

namespace Tests\Feature;

use App\Iratkapu\OfficeMail;
use App\Iratkapu\TypeSettings;
use App\Mcp\IratkapuServer;
use App\Mcp\McpAccess;
use App\Mcp\Tools;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Server\Testing\TestResponse;
use Tests\TestCase;

/** Kapu-chat, 2. lépés: bővített get_settings és jóváhagyáshoz kötött update_settings a `kapu` szinten (ADR-014). */
class KapuBeallitasTest extends TestCase
{
    use RefreshDatabase;

    protected bool $seed = true;

    protected function setUp(): void
    {
        parent::setUp();
        OfficeMail::put($this->u('IA')->office_id, ['mcp' => ['enabled' => true], 'reminders' => [5, 2, 1]]);
    }

    protected function tearDown(): void
    {
        McpAccess::forget();
        Carbon::setTestNow();
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

    /** Az eszköz JSON-válasza tömbként. */
    private function data(TestResponse $r): array
    {
        $text = (fn () => $this->content())->call($r)[0] ?? '';

        return json_decode($text, true) ?? [];
    }

    private function reminders(): array
    {
        return OfficeMail::settings($this->u('IA')->office_id)['reminders'];
    }

    /** Első Kapu-hívás: jóváhagyást kér, a confirm_id-t adja vissza. */
    private function ask(array $in): string
    {
        $d = $this->data(IratkapuServer::tool(Tools\UpdateSettings::class, $in)->assertHasNoErrors());
        $this->assertTrue($d['needs_approval'] ?? false);

        return $d['confirm_id'];
    }

    public function test_get_settings_mutatja_az_uj_beallitasokat(): void
    {
        $this->as('IA', 'kapu');
        $d = $this->data(IratkapuServer::tool(Tools\GetSettings::class, [])->assertHasNoErrors());
        foreach (['reply_to', 'from_name', 'default_active', 'digest_days', 'arrears_days', 'payment_days'] as $k) {
            $this->assertArrayHasKey($k, $d);
        }
        $this->assertSame(['mail' => true, 'nav' => true, 'cegkapu' => true], $d['default_active']);
        $this->assertSame(array_keys(TypeSettings::DEFAULTS), array_keys($d['document_types'][0]['settings']));
    }

    public function test_kapu_elso_hivas_nem_modosit_confirm_id_t_ad(): void
    {
        $this->as('IA', 'kapu');
        $d = $this->data(IratkapuServer::tool(Tools\UpdateSettings::class, ['reminders' => [5, 1]])->assertHasNoErrors());
        $this->assertTrue($d['needs_approval']);
        $this->assertSame([['label' => 'Emlékeztető napok', 'from' => '5, 2, 1', 'to' => '5, 1']], $d['summary']);
        $this->assertStringContainsString('confirm_id', $d['message']);
        $this->assertSame([5, 2, 1], $this->reminders());
        $row = DB::table('kapu_confirmations')->find($d['confirm_id']);
        $this->assertNotNull($row);
        $this->assertNull($row->approved_at);
    }

    public function test_kapu_jovahagyott_confirm_id_val_modosit_es_naploz(): void
    {
        $this->as('IA', 'kapu');
        $id = $this->ask(['reminders' => [5, 1]]);
        $card = $this->actingAs($this->u('IA'))->getJson("/api/kapu/confirm/$id")->assertOk()->json();
        $this->assertSame('Emlékeztető napok', $card['summary'][0]['label']);
        $this->assertFalse($card['approved']);
        $this->actingAs($this->u('IA'))->postJson("/api/kapu/confirm/$id")->assertOk();
        $this->assertTrue($this->actingAs($this->u('IA'))->getJson("/api/kapu/confirm/$id")->json('approved'));
        $this->assertSame([5, 2, 1], $this->reminders());

        IratkapuServer::tool(Tools\UpdateSettings::class, ['reminders' => [5, 1], 'confirm_id' => $id])->assertHasNoErrors()->assertSee('emlékeztetők');
        $this->assertSame([5, 1], $this->reminders());
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', 'Kapu: beállítás jóváhagyva%')->exists());
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', 'Iroda beállításai módosítva: emlékeztető napok%')->exists());
        $this->assertNotNull(DB::table('kapu_confirmations')->find($id)->used_at);
    }

    public function test_kapu_jovahagyas_nelkuli_confirm_id_elutasitva(): void
    {
        $this->as('IA', 'kapu');
        $id = $this->ask(['reminders' => [5, 1]]);
        IratkapuServer::tool(Tools\UpdateSettings::class, ['reminders' => [5, 1], 'confirm_id' => $id])->assertHasErrors(['jóváhagy']);
        $this->assertSame([5, 2, 1], $this->reminders());
    }

    public function test_kapu_lejart_confirm_id_elutasitva(): void
    {
        $this->as('IA', 'kapu');
        $id = $this->ask(['reminders' => [5, 1]]);
        $this->actingAs($this->u('IA'))->postJson("/api/kapu/confirm/$id")->assertOk();
        Carbon::setTestNow(now()->addMinutes(11));
        IratkapuServer::tool(Tools\UpdateSettings::class, ['reminders' => [5, 1], 'confirm_id' => $id])->assertHasErrors(['jóváhagy']);
        $this->assertSame([5, 2, 1], $this->reminders());
    }

    public function test_lejart_kerest_nem_lehet_jovahagyni(): void
    {
        $this->as('IA', 'kapu');
        $id = $this->ask(['reminders' => [5, 1]]);
        Carbon::setTestNow(now()->addMinutes(11));
        $this->actingAs($this->u('IA'))->postJson("/api/kapu/confirm/$id")->assertStatus(410);
    }

    public function test_kapu_masik_modositasra_szolo_confirm_id_elutasitva(): void
    {
        $this->as('IA', 'kapu');
        $id = $this->ask(['reminders' => [5, 1]]);
        $this->actingAs($this->u('IA'))->postJson("/api/kapu/confirm/$id")->assertOk();
        IratkapuServer::tool(Tools\UpdateSettings::class, ['reminders' => [1], 'confirm_id' => $id])->assertHasErrors(['jóváhagy']);
        $this->assertSame([5, 2, 1], $this->reminders());
    }

    public function test_kapu_felhasznalt_confirm_id_masodszor_elutasitva(): void
    {
        $this->as('IA', 'kapu');
        $id = $this->ask(['reminders' => [5, 1]]);
        $this->actingAs($this->u('IA'))->postJson("/api/kapu/confirm/$id")->assertOk();
        IratkapuServer::tool(Tools\UpdateSettings::class, ['reminders' => [5, 1], 'confirm_id' => $id])->assertHasNoErrors();
        OfficeMail::put($this->u('IA')->office_id, ['reminders' => [2]]);
        IratkapuServer::tool(Tools\UpdateSettings::class, ['reminders' => [5, 1], 'confirm_id' => $id])->assertHasErrors(['jóváhagy']);
        $this->assertSame([2], $this->reminders());
    }

    public function test_kapu_mas_felhasznalo_nem_hagyhatja_jova(): void
    {
        $this->as('IA', 'kapu');
        $id = $this->ask(['reminders' => [5, 1]]);
        $this->actingAs($this->u('SN'))->getJson("/api/kapu/confirm/$id")->assertForbidden();
        $this->actingAs($this->u('SN'))->postJson("/api/kapu/confirm/$id")->assertForbidden();
        $this->assertNull(DB::table('kapu_confirmations')->find($id)->approved_at);
    }

    public function test_kapu_konyvelo_szerepkornel_a_beallitas_403_at_ad_emberi_szoveggel(): void
    {
        $this->as('LG', 'kapu');
        IratkapuServer::tool(Tools\UpdateSettings::class, ['reminders' => [5, 1]])->assertHasErrors(['vezető vagy admin']);
        $this->assertSame(0, DB::table('kapu_confirmations')->count());
        $this->assertSame([5, 2, 1], $this->reminders());
    }

    public function test_type_settings_es_default_active_atmegy_a_felulet_vezerlojen(): void
    {
        $this->as('IA', 'kapu');
        $type = DB::table('document_types')->whereNull('office_id')->orderBy('label')->first();
        $in = ['default_active' => ['nav' => false], 'digest_days' => 7, 'payment_days' => [10, 3],
            'type_settings' => [['type_id' => $type->type_id, 'hidden' => true, 'legal_days' => 15]]];
        $id = $this->ask($in);
        $labels = array_column(DB::table('kapu_confirmations')->find($id) ? json_decode(DB::table('kapu_confirmations')->find($id)->summary, true) : [], 'label');
        $this->assertContains("{$type->label}: Nem kell", $labels);
        $this->actingAs($this->u('IA'))->postJson("/api/kapu/confirm/$id")->assertOk();
        IratkapuServer::tool(Tools\UpdateSettings::class, $in + ['confirm_id' => $id])->assertHasNoErrors();

        $office = OfficeMail::office($this->u('IA')->office_id);
        $this->assertSame(['mail' => true, 'nav' => false, 'cegkapu' => true], $office['defaultActive']);
        $this->assertSame(7, $office['digestDays']);
        $this->assertSame([10, 3], $office['paymentDays']);
        TypeSettings::flush();
        $s = TypeSettings::for($this->u('IA')->office_id, $type->type_id);
        $this->assertTrue($s['hidden']);
        $this->assertSame(15, $s['legalDays']);
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', "Irattípus beállítása módosítva: {$type->label}%")->exists());
    }

    public function test_from_name_smtp_nelkul_422(): void
    {
        $this->as('IA', 'admin');
        IratkapuServer::tool(Tools\UpdateSettings::class, ['from_name' => 'Iroda'])->assertHasErrors(['Előbb az e-mail küldést kell beállítani.']);
    }

    public function test_from_name_csak_a_felado_nevet_irja_at(): void
    {
        $oid = $this->u('IA')->office_id;
        OfficeMail::put($oid, ['smtp' => ['host' => 'smtp.pelda.test', 'port' => 587, 'enc' => 'starttls', 'username' => 'iroda', 'password' => 'titkos-hash', 'from' => 'iroda@pelda.test', 'from_name' => 'Régi']]);
        $this->as('IA', 'admin');
        IratkapuServer::tool(Tools\UpdateSettings::class, ['from_name' => 'Új Iroda Kft.', 'reply_to' => 'valasz@pelda.test'])->assertHasNoErrors();
        $smtp = OfficeMail::settings($oid)['smtp'];
        $this->assertSame('Új Iroda Kft.', $smtp['from_name']);
        $this->assertSame('titkos-hash', $smtp['password']);
        $this->assertSame('smtp.pelda.test', $smtp['host']);
        $this->assertSame('valasz@pelda.test', OfficeMail::office($oid)['replyTo']);
    }

    public function test_kapu_ugyanannak_a_felhasznalonak_masik_tokenjerol_a_confirm_id_elutasitva(): void
    {
        McpAccess::activate(new McpAccess($this->u('IA'), 'kapu', 'teszt', tokenId: 101));
        $id = $this->ask(['reminders' => [5, 1]]);
        $this->actingAs($this->u('IA'))->postJson("/api/kapu/confirm/$id")->assertOk();
        McpAccess::activate(new McpAccess($this->u('IA'), 'kapu', 'teszt', tokenId: 102));
        IratkapuServer::tool(Tools\UpdateSettings::class, ['reminders' => [5, 1], 'confirm_id' => $id])->assertHasErrors(['jóváhagy']);
        $this->assertSame([5, 2, 1], $this->reminders());
        $this->assertNull(DB::table('kapu_confirmations')->find($id)->used_at);
        // Az eredeti tokenről működik.
        McpAccess::activate(new McpAccess($this->u('IA'), 'kapu', 'teszt', tokenId: 101));
        IratkapuServer::tool(Tools\UpdateSettings::class, ['reminders' => [5, 1], 'confirm_id' => $id])->assertHasNoErrors();
        $this->assertSame([5, 1], $this->reminders());
    }

    public function test_egy_napnal_regebbi_jovahagyasi_kerest_az_uj_keres_torli(): void
    {
        $this->as('IA', 'kapu');
        $old = $this->ask(['reminders' => [5, 1]]);
        Carbon::setTestNow(now()->addHours(25));
        $new = $this->ask(['reminders' => [1]]);
        $this->assertNull(DB::table('kapu_confirmations')->find($old));
        $this->assertNotNull(DB::table('kapu_confirmations')->find($new));
        $this->assertSame(1, DB::table('kapu_confirmations')->count());
    }

    public function test_default_active_ismeretlen_kulcsa_elutasitva(): void
    {
        $this->as('IA', 'admin');
        IratkapuServer::tool(Tools\UpdateSettings::class, ['default_active' => ['nav' => false, 'ugyfelkapu' => true]])->assertHasErrors();
        $this->assertSame(['mail' => true, 'nav' => true, 'cegkapu' => true], OfficeMail::office($this->u('IA')->office_id)['defaultActive']);
    }

    public function test_type_settings_ismetlodo_type_id_elutasitva(): void
    {
        $this->as('IA', 'admin');
        $type = DB::table('document_types')->whereNull('office_id')->orderBy('label')->first();
        IratkapuServer::tool(Tools\UpdateSettings::class, ['type_settings' => [['type_id' => $type->type_id, 'hidden' => true], ['type_id' => $type->type_id, 'hidden' => false]]])->assertHasErrors();
        TypeSettings::flush();
        $this->assertFalse(TypeSettings::for($this->u('IA')->office_id, $type->type_id)['hidden']);
    }

    public function test_admin_szintu_token_tovabbra_is_jovahagyas_nelkul_modosit(): void
    {
        $this->as('IA', 'admin');
        IratkapuServer::tool(Tools\UpdateSettings::class, ['reminders' => [5, 1]])->assertHasNoErrors()->assertDontSee('needs_approval');
        $this->assertSame([5, 1], $this->reminders());
        $this->assertSame(0, DB::table('kapu_confirmations')->count());
    }
}
