<?php

namespace Tests\Feature;

use App\Iratkapu\Documents;
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

class IratTeendokElemzeseTest extends TestCase
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

    private function as(string $k, string $level = 'olvasas'): void
    {
        McpAccess::activate(new McpAccess($this->u($k), $level, 'teszt'));
    }

    public function test_irat_teendok_elemzese_helyi_futtatas_es_strukturalt_eredmeny(): void
    {
        Storage::fake('local');
        $lg = $this->u('LG');
        $m = DB::table('messages')->whereIn('client_id', Scope::clientIds($lg))->first();
        $this->assertNotNull($m);

        DB::table('messages')->where('id', $m->id)->update([
            'subject' => 'NAV Határozat adóbírság és késedelmi pótlék kiszabásáról',
            'deadline_date' => '2026-12-15',
            'deadline_source' => 'irat_szoveg',
            'deadline_excerpt' => 'Fizetési határidő 2026.12.15.',
            'arrived_at' => '2026-11-10 10:00:00',
        ]);

        $text = 'A Nemzeti Adó- és Vámhivatal határozata alapján a társaság terhére 250 000 Ft adóbírság és 45 000 Ft késedelmi pótlék megfizetését rendeli el az Art. 220. § és az Air. 72. § rendelkezései szerint. A döntéssel szemben a kézbesítéstől számított 15 napon belül a NAV Fellebbviteli Igazgatóságához címzett fellebbezés terjeszthető elő. Teljesítési határidő: 2026-12-15 napjáig.';
        Documents::store($lg->office_id, $m->id, 'nav_hatarozat.xml', "<?xml version=\"1.0\"?><doc><text>{$text}</text></doc>", $lg->id);

        $this->as('LG', 'olvasas');

        $res = IratkapuServer::tool(Tools\IratTeendokElemzese::class, ['message_id' => $m->id]);
        $res->assertHasNoErrors()
            ->assertSee('"success":true')
            ->assertSee('"message_id":'.(int) $m->id)
            ->assertSee('"irattipus":"hatarozat"')
            ->assertSee('"eljarasi_szakasz":"elsofoku_eljaras"')
            ->assertSee('"helyi_elemzes":true')
            ->assertSee('"van_helye":true')
            ->assertSee('"jogorvoslat_tipusa":"fellebbezes"')
            ->assertSee('"hatarido_nap":15')
            ->assertSee('NAV Fellebbviteli Igazgatóság')
            ->assertSee('Art.')
            ->assertSee('Air.')
            ->assertSee('250000')
            ->assertSee('45000')
            ->assertSee('adobirsag')
            ->assertSee('kesedelmi_potlek')
            ->assertSee('Fizetési kötelezettség');

        // Helyi audit esemény rögzítése
        $this->assertTrue(DB::table('audit_events')
            ->where('office_id', $lg->office_id)
            ->where('message_id', $m->id)
            ->where('action', 'like', 'MCP: irat teendőinek helyi elemzése%')
            ->exists());
    }

    public function test_irat_teendok_elemzese_konkret_dokumentum_id_alapjan(): void
    {
        Storage::fake('local');
        $lg = $this->u('LG');
        $m = DB::table('messages')->whereIn('client_id', Scope::clientIds($lg))->first();
        $this->assertNotNull($m);

        $docId1 = Documents::store($lg->office_id, $m->id, 'melleklet1.txt', 'Fizetési felszólítás 100 000 Ft megfizetésére 8 napon belül.', $lg->id);
        Documents::store($lg->office_id, $m->id, 'melleklet2.txt', 'Tájékoztató általános információkról.', $lg->id);

        $this->as('LG', 'olvasas');

        $res = IratkapuServer::tool(Tools\IratTeendokElemzese::class, [
            'message_id' => $m->id,
            'document_id' => $docId1,
        ]);
        $res->assertHasNoErrors()
            ->assertSee('"dokumentumok_szama":1')
            ->assertSee('"irattipus":"fizetesi_felszolitas"')
            ->assertSee('100000');
    }

    public function test_vegzes_onallo_fellebbezes_kizarva(): void
    {
        Storage::fake('local');
        $lg = $this->u('LG');
        $m = DB::table('messages')->whereIn('client_id', Scope::clientIds($lg))->first();

        DB::table('messages')->where('id', $m->id)->update([
            'subject' => 'Végzés hiánypótlási felhívásról',
        ]);

        $text = 'A hatóság végzése: hiánypótlásra hívja fel az adózót 8 napon belül. A végzés ellen önálló fellebbezésnek helye nincs.';
        Documents::store($lg->office_id, $m->id, 'vegzes.txt', $text, $lg->id);

        $this->as('LG', 'olvasas');

        $res = IratkapuServer::tool(Tools\IratTeendokElemzese::class, ['message_id' => $m->id]);
        $res->assertHasNoErrors()
            ->assertSee('"irattipus":"vegzes"')
            ->assertSee('"van_helye":false')
            ->assertSee('"jogorvoslat_tipusa":"nincs_onallo_fellebbezes"');
    }

    public function test_nem_letezo_vagy_nem_lathato_irat_elutasitva(): void
    {
        $this->as('LG', 'olvasas');

        // Nem létező message
        $res = IratkapuServer::tool(Tools\IratTeendokElemzese::class, ['message_id' => 999999]);
        $res->assertHasErrors();
    }

    public function test_osszegek_kinyerese_ervenyes_utf8_karakterhatarok_nem_serulnek(): void
    {
        Storage::fake('local');
        $lg = $this->u('LG');
        $m = DB::table('messages')->whereIn('client_id', Scope::clientIds($lg))->first();
        $this->assertNotNull($m);

        DB::table('messages')->where('id', $m->id)->update([
            'subject' => 'NAV Érdemi határozat fizetési kötelezettségről',
        ]);

        $text = 'Az adóhatóság az adózó terhére az alábbi fizetési kötelezettségeket állapítja meg: '
            .'1. 3 500 000 Ft társasági adóhiány az 1996. évi LXXXI. törvény (Tao tv.) alapján, '
            .'2. 1 750 000 Ft adóbírság az Art. 220. § (1) bekezdése szerint, '
            .'3. 280 000 Ft késedelmi pótlék az Art. 209. § alapján.';
        Documents::store($lg->office_id, $m->id, 'adoszamitas.txt', $text, $lg->id);

        $this->as('LG', 'olvasas');

        $res = IratkapuServer::tool(Tools\IratTeendokElemzese::class, ['message_id' => $m->id]);
        $res->assertHasNoErrors()
            ->assertSee('3500000')
            ->assertSee('1750000')
            ->assertSee('280000')
            ->assertSee('"adohiany"')
            ->assertSee('"adobirsag"')
            ->assertSee('"kesedelmi_potlek"');
    }

    public function test_multibyte_szoveg_karakter_offset_eltolas_es_hataridok_megorzese(): void
    {
        Storage::fake('local');
        $lg = $this->u('LG');
        $m = DB::table('messages')->whereIn('client_id', Scope::clientIds($lg))->first();
        $this->assertNotNull($m);

        DB::table('messages')->where('id', $m->id)->update([
            'subject' => 'Hosszú fejlécű NAV felhívás',
            'arrived_at' => '2026-11-15 08:00:00',
        ]);

        // A 25 ismétlésű ékezetes minta miatt a byte-offset jóval megelőzi a karakter-offsetet
        $prefix = str_repeat('árvíztűrő tükörfúrógép ', 25);
        $text = $prefix.'Kérjük, fellebbezéssel 15 napon belül éljen! Teljesítési határidő: 2026.12.31.';
        Documents::store($lg->office_id, $m->id, 'hosszu_irat.txt', $text, $lg->id);

        $this->as('LG', 'olvasas');

        $res = IratkapuServer::tool(Tools\IratTeendokElemzese::class, ['message_id' => $m->id]);
        $res->assertHasNoErrors()
            ->assertSee('"fellebbezesi_hatarido"')
            ->assertSee('"napok_szama":15')
            ->assertSee('"naptari_hatarido"')
            ->assertSee('2026-12-31');
    }

    public function test_osszetett_hatarozat_pozitiv_fellebbezesi_jog_elsobbsege(): void
    {
        Storage::fake('local');
        $lg = $this->u('LG');
        $m = DB::table('messages')->whereIn('client_id', Scope::clientIds($lg))->first();
        $this->assertNotNull($m);

        DB::table('messages')->where('id', $m->id)->update([
            'subject' => 'NAV Összetett érdemi határozat',
        ]);

        $text = 'A határozat ellen a kézbesítéstől számított 15 napon belül fellebbezés terjeszthető elő a NAV Fellebbviteli Igazgatóságához címezve. '
            .'Az eljárási költség megállapítása ellen önálló fellebbezésnek helye nincs.';
        Documents::store($lg->office_id, $m->id, 'osszetett_dontes.txt', $text, $lg->id);

        $this->as('LG', 'olvasas');

        $res = IratkapuServer::tool(Tools\IratTeendokElemzese::class, ['message_id' => $m->id]);
        $res->assertHasNoErrors()
            ->assertSee('"van_helye":true')
            ->assertSee('"jogorvoslat_tipusa":"fellebbezes"')
            ->assertSee('"hatarido_nap":15')
            ->assertSee('NAV Fellebbviteli Igazgatóság')
            ->assertSee('Jogorvoslati lehetőség (fellebbezés / észrevétel) megfontolása');
    }
}
