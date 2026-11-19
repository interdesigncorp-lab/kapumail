<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * E-Önkormányzat Portál (ASP), ablakos út (ADR-011): az asztali app a belépőablak munkamenetéből kiolvasott helyi adó
 * adatokat küldi be. Ügyfél ebből magától nem jön létre; a saját adat magán.
 */
class AspPortalTest extends TestCase
{
    use RefreshDatabase;

    protected bool $seed = true;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
    }

    private function u(string $k): User
    {
        return User::where('initials', $k)->firstOrFail();
    }

    private function pdf(string $what = 'kivonat'): string
    {
        return base64_encode("%PDF-1.4 teszt $what");
    }

    private function body(array $subject, array $extra = []): array
    {
        return $extra + ['subject' => $subject, 'tenants' => [
            ['uid' => 'szim-tenant-0001', 'name' => 'Példafalva Község Önkormányzata', 'city' => 'Példafalva',
                'balance' => ['year' => 2026, 'kind' => 'DETAILED', 'status' => 'OK', 'pdfBase64' => $this->pdf()],
                'returns' => [['taxCode' => '087', 'taxName' => 'Helyi iparűzési adó', 'fileName' => 'bevallas-2025.pdf', 'comments' => 'Bevallás adó éve: 2025', 'returnId' => 7]], 'cases' => 0, 'notes' => []],
            ['uid' => 'szim-tenant-0002', 'name' => 'Mintaváros Önkormányzata', 'city' => 'Mintaváros', 'balance' => null, 'returns' => [], 'cases' => 1, 'notes' => ['adóegyenleg: nincs kivonat (NINCS_ADAT)']],
        ]];
    }

    private const FIRM = ['own' => false, 'role' => 'CEG_NEVEBEN', 'id' => '24817365'];
    private const OWN = ['own' => true, 'role' => 'SAJAT_NEVEN_TERMESZETES_SZEMELY', 'id' => '8499999999'];

    public function test_ceg_neveben_beolvasott_adat_a_meglevo_ugyfelhez_kerul_es_ujra_bekuldve_nem_kettozodik(): void
    {
        $lg = $this->u('LG'); $clients = DB::table('clients')->count();
        $r = $this->actingAs($lg)->postJson('/api/asp/ingest', $this->body(self::FIRM))->assertOk()->json();
        $this->assertSame([2, 1, false], [$r['saved'], $r['pdfs'], $r['own']]);
        $cid = DB::table('clients')->where('tax', '24817365-2-13')->value('id');
        $this->assertSame([$cid, $cid], DB::table('asp_statements')->pluck('client_id')->all());
        $this->assertSame($clients, DB::table('clients')->count(), 'ügyfél magától nem jön létre');

        $rows = collect($this->actingAs($lg)->getJson('/api/state')->json('aspStatements'))->keyBy('city');
        $this->assertSame([true, 1, 0, 2026], [$rows['Példafalva']['pdf'], $rows['Példafalva']['returns'], $rows['Példafalva']['cases'], $rows['Példafalva']['year']]);
        $state = $this->actingAs($lg)->getJson('/api/state')->json();
        $this->assertContains($rows['Példafalva']['c'], array_column($state['clients'], 'id'), 'a sor ügyfél-azonosítója a felület ügyféllistájában megtalálható');
        $this->assertSame("c$cid", $rows['Példafalva']['c']);
        $this->assertSame([false, ['adóegyenleg: nincs kivonat (NINCS_ADAT)']], [$rows['Mintaváros']['pdf'], $rows['Mintaváros']['notes']]);
        $this->assertArrayNotHasKey('returnId', $rows['Példafalva']['returnList'][0], 'csak a megnevezett mezők kerülnek tárolásra');

        $this->actingAs($lg)->postJson('/api/asp/ingest', $this->body(self::FIRM))->assertOk();
        $this->assertSame(2, DB::table('asp_statements')->count());

        $id = $rows['Példafalva']['id'];
        $res = $this->actingAs($lg)->get("/api/asp/statements/$id/pdf")->assertOk();
        $this->assertSame('application/pdf', $res->headers->get('Content-Type'));
        $this->assertStringStartsWith('%PDF-', $res->getContent());
        $this->actingAs($lg)->get('/api/asp/statements/' . $rows['Mintaváros']['id'] . '/pdf')->assertNotFound();
    }

    public function test_a_kivonat_iratkent_is_megjelenik_az_ugyfelnel_de_nem_keveredik_a_tarhely_leveleivel(): void
    {
        $lg = $this->u('LG'); $cid = DB::table('clients')->where('tax', '24817365-2-13')->value('id'); $before = DB::table('messages')->count();
        $r = $this->actingAs($lg)->postJson('/api/asp/ingest', $this->body(self::FIRM))->assertOk()->json();
        $this->assertSame(1, $r['filed'], 'csak ahol kivonat jött, ott lesz irat');
        $m = DB::table('messages')->where('source_id', 'like', 'asp:%')->get();
        $this->assertCount(1, $m); $m = $m[0];
        $this->assertSame([$cid, 'ASP', 'na', 'asp-adoszamla-kivonat', 1], [$m->client_id, $m->sender, $m->official, $m->type_id, (int) $m->att]);
        $this->assertStringStartsWith('Portálról lekérdezve:', $m->subject);
        $this->assertStringContainsString('Példafalva, 2026', $m->subject);
        $doc = DB::table('documents')->where('message_id', $m->id)->first();
        $this->assertSame(['application/pdf', 'adoszamla-kivonat-Peldafalva-2026.pdf'], [$doc->mime, $doc->name]);
        $this->actingAs($lg)->get("/api/documents/{$doc->id}")->assertOk();
        // aznapi újabb beolvasás nem kettőz, akkor sem, ha a PDF bájtjai eltérnek
        $b = $this->body(self::FIRM); $b['tenants'][0]['balance']['pdfBase64'] = $this->pdf('masik');
        $this->assertSame(0, $this->actingAs($lg)->postJson('/api/asp/ingest', $b)->assertOk()->json('filed'));
        $this->assertSame($before + 1, DB::table('messages')->count());
        // az irat a felület iratlistájában az ügyfélnél látszik
        $row = collect($this->actingAs($lg)->getJson('/api/state')->json('messages'))->firstWhere('id', "m{$m->id}");
        $this->assertNotNull($row, 'az irat megjelenik az iratok között');
    }

    public function test_masnap_valtozatlan_kivonatbol_nem_lesz_uj_irat_valtozottbol_igen(): void
    {
        $lg = $this->u('LG');
        $this->travelTo(now()->startOfDay()->addHours(9));
        $this->assertSame(1, $this->actingAs($lg)->postJson('/api/asp/ingest', $this->body(self::FIRM))->assertOk()->json('filed'));
        $this->travel(1)->days();
        $this->assertSame(0, $this->actingAs($lg)->postJson('/api/asp/ingest', $this->body(self::FIRM))->assertOk()->json('filed'), 'ugyanaz a PDF nem lesz újra irat');
        $this->assertSame(1, DB::table('messages')->where('source_id', 'like', 'asp:%')->count());
        $this->assertNotNull(DB::table('asp_statements')->where('tenant_uid', 'szim-tenant-0001')->value('pdf_path'), 'a táblázat sora így is frissül');
        $this->travel(1)->days();
        $b = $this->body(self::FIRM); $b['tenants'][0]['balance']['pdfBase64'] = $this->pdf('uj-egyenleg');
        $this->assertSame(1, $this->actingAs($lg)->postJson('/api/asp/ingest', $b)->assertOk()->json('filed'), 'megváltozott kivonatból új irat lesz');
        $this->assertSame(2, DB::table('messages')->where('source_id', 'like', 'asp:%')->count());
    }

    public function test_sajat_adat_magan_csak_a_beolvaso_latja(): void
    {
        $lg = $this->u('LG');
        $this->actingAs($lg)->postJson('/api/asp/ingest', $this->body(self::OWN))->assertOk()->assertJson(['own' => true, 'client' => null]);
        $this->assertSame(0, DB::table('messages')->where('source_id', 'like', 'asp:%')->count(), 'saját gyűjtő nélkül a saját kivonatból nem lesz irat');
        $mine = $this->actingAs($lg)->getJson('/api/state')->json('aspStatements');
        $this->assertCount(2, $mine); $this->assertTrue($mine[0]['own']);
        $withPdf = collect($mine)->firstWhere('pdf', true)['id'];
        foreach (User::where('office_id', $lg->office_id)->where('id', '!=', $lg->id)->get() as $other) {
            $this->assertSame([], $this->actingAs($other)->getJson('/api/state')->json('aspStatements'), "{$other->initials} nem láthatja más saját adatát");
            $this->actingAs($other)->get("/api/asp/statements/$withPdf/pdf")->assertNotFound();
        }
        // a saját adat csak a magánszemélyes szerepkörből fogadható el
        $this->actingAs($lg)->postJson('/api/asp/ingest', $this->body(['own' => true, 'role' => 'CEG_NEVEBEN', 'id' => '24817365']))->assertStatus(422);
    }

    public function test_ismeretlen_inaktiv_vagy_nem_egyertelmu_alany_adata_nem_kerul_mentesre(): void
    {
        $lg = $this->u('LG');
        $this->actingAs($lg)->postJson('/api/asp/ingest', $this->body(['own' => false, 'role' => 'CEG_NEVEBEN', 'id' => '99887766']))->assertStatus(422);
        $this->actingAs($lg)->postJson('/api/asp/ingest', $this->body(['own' => false, 'role' => 'CEG_NEVEBEN', 'id' => null]))->assertStatus(422);
        DB::table('clients')->where('tax', '24817365-2-13')->update(['active' => false]);
        $this->actingAs($lg)->postJson('/api/asp/ingest', $this->body(self::FIRM))->assertStatus(422);
        $this->assertSame(0, DB::table('asp_statements')->count());
    }

    public function test_ami_nem_pdf_azt_nem_fogadja_el(): void
    {
        $b = $this->body(self::FIRM); $b['tenants'][0]['balance']['pdfBase64'] = base64_encode('<html>hiba</html>');
        $this->actingAs($this->u('LG'))->postJson('/api/asp/ingest', $b)->assertStatus(422);
        $b['tenants'][0]['uid'] = '../etc';
        $this->actingAs($this->u('LG'))->postJson('/api/asp/ingest', $b)->assertStatus(422);
        $this->assertSame(0, DB::table('asp_statements')->count());
    }
}
