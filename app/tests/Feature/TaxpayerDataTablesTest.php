<?php

namespace Tests\Feature;

use App\Iratkapu\Scope;
use App\Iratkapu\TaxpayerDataTables;
use App\Iratkapu\XlsxReader;
use App\Iratkapu\XlsxWriter;
use App\Models\User;
use Database\Seeders\TaxpayerTablesSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class TaxpayerDataTablesTest extends TestCase
{
    use RefreshDatabase;

    protected bool $seed = true;

    protected function setUp(): void
    {
        parent::setUp();
        (new TaxpayerTablesSeeder())->run();
    }

    private function u(string $initials = 'LG'): User
    {
        return User::where('initials', $initials)->firstOrFail();
    }

    public function test_migrations_and_schema_are_present(): void
    {
        $this->assertTrue(Schema::hasTable('nav_returns'));
        $this->assertTrue(Schema::hasColumn('nav_returns', 'barcode'));
        $this->assertTrue(Schema::hasColumn('nav_returns', 'accepted_at'));
        $this->assertTrue(Schema::hasColumn('nav_returns', 'error_at'));

        $this->assertTrue(Schema::hasTable('nav_insured_persons'));
        $this->assertTrue(Schema::hasTable('nav_employers'));
        $this->assertTrue(Schema::hasTable('nav_efo_declarations'));
        $this->assertTrue(Schema::hasTable('nav_efo_quotas'));
        $this->assertTrue(Schema::hasTable('nav_reconciliations'));
    }

    public function test_missing_returns_endpoint_and_filters(): void
    {
        $u = $this->u('LG');
        $res = $this->actingAs($u)->getJson('/api/taxpayer-tables/data?view=missing_returns');

        $res->assertOk();
        $res->assertJsonStructure([
            'items',
            'total',
            'page',
            'per_page',
            'years',
            'clients',
        ]);

        $items = $res->json('items');
        $this->assertNotEmpty($items);
        foreach ($items as $item) {
            $this->assertArrayHasKey('client_name', $item);
            $this->assertArrayHasKey('form_code', $item);
            $this->assertArrayHasKey('due_date', $item);
            $this->assertEquals('missing', $item['status']);
        }

        // Test search filter
        $searchRes = $this->actingAs($u)->getJson('/api/taxpayer-tables/data?view=missing_returns&search=2608');
        $searchRes->assertOk();
        foreach ($searchRes->json('items') as $item) {
            $this->assertStringContainsString('2608', $item['form_code'] . $item['title']);
        }
    }

    public function test_returns_endpoint_with_barcode_and_dates(): void
    {
        $u = $this->u('LG');
        $res = $this->actingAs($u)->getJson('/api/taxpayer-tables/data?view=returns');

        $res->assertOk();
        $items = $res->json('items');
        $this->assertNotEmpty($items);
        $first = $items[0];
        $this->assertArrayHasKey('barcode', $first);
        $this->assertArrayHasKey('reg_no', $first);
        $this->assertArrayHasKey('accepted_at', $first);
        $this->assertArrayHasKey('client_name', $first);
    }

    public function test_insured_persons_endpoint_and_scoping(): void
    {
        $u = $this->u('LG');
        $res = $this->actingAs($u)->getJson('/api/taxpayer-tables/data?view=insured');

        $res->assertOk();
        $items = $res->json('items');
        $this->assertNotEmpty($items);
        $first = $items[0];
        $this->assertArrayHasKey('name', $first);
        $this->assertArrayHasKey('tax_id', $first);
        $this->assertArrayHasKey('taj', $first);
        $this->assertArrayHasKey('relationship_type', $first);
        $this->assertArrayHasKey('weekly_hours', $first);
    }

    public function test_employers_endpoint(): void
    {
        $u = $this->u('LG');
        $res = $this->actingAs($u)->getJson('/api/taxpayer-tables/data?view=employers');

        $res->assertOk();
        $items = $res->json('items');
        $this->assertNotEmpty($items);
        $first = $items[0];
        $this->assertArrayHasKey('employer_name', $first);
        $this->assertArrayHasKey('employer_tax_number', $first);
        $this->assertArrayHasKey('relationship_start', $first);
    }

    public function test_efo_declarations_and_quotas_endpoints(): void
    {
        $u = $this->u('LG');

        // Declarations
        $decRes = $this->actingAs($u)->getJson('/api/taxpayer-tables/data?view=efo_declarations');
        $decRes->assertOk();
        $items = $decRes->json('items');
        $this->assertNotEmpty($items);
        $first = $items[0];
        $this->assertArrayHasKey('employee_name', $first);
        $this->assertArrayHasKey('declaration_code', $first);
        $this->assertArrayHasKey('days_count', $first);

        // Quotas
        $quoRes = $this->actingAs($u)->getJson('/api/taxpayer-tables/data?view=efo_quotas');
        $quoRes->assertOk();
        $qItems = $quoRes->json('items');
        $this->assertNotEmpty($qItems);
        $qFirst = $qItems[0];
        $this->assertArrayHasKey('quota_limit', $qFirst);
        $this->assertArrayHasKey('used_days', $qFirst);
        $this->assertArrayHasKey('remaining_days', $qFirst);
    }

    public function test_reconciliations_endpoint(): void
    {
        $u = $this->u('LG');
        $res = $this->actingAs($u)->getJson('/api/taxpayer-tables/data?view=reconciliations');

        $res->assertOk();
        $items = $res->json('items');
        $this->assertNotEmpty($items);
        $first = $items[0];
        $this->assertArrayHasKey('reconciler_name', $first);
        $this->assertArrayHasKey('status', $first);
        $this->assertArrayHasKey('case_number', $first);
    }

    public function test_tax_calendar_matrix(): void
    {
        $u = $this->u('LG');
        $year = (int) date('Y');
        $res = $this->actingAs($u)->getJson('/api/taxpayer-tables/data?view=calendar&year=' . $year);

        $res->assertOk();
        $items = $res->json('items');
        $this->assertNotEmpty($items);
        $first = $items[0];
        $this->assertArrayHasKey('client_name', $first);
        $this->assertArrayHasKey('months', $first);
        $this->assertCount(12, $first['months']);
        $this->assertArrayHasKey('summary', $first['months'][1]);
    }

    public function test_csv_export_all_views(): void
    {
        $u = $this->u('LG');
        $views = [
            'missing_returns',
            'returns',
            'insured',
            'employers',
            'efo_declarations',
            'efo_quotas',
            'reconciliations',
            'calendar',
        ];

        foreach ($views as $view) {
            $res = $this->actingAs($u)->get('/api/taxpayer-tables/export?view=' . $view . '&format=csv');
            $res->assertOk();
            $this->assertStringContainsString('text/csv', (string) $res->headers->get('Content-Type'));
            $this->assertStringContainsString($view . '-export.csv', (string) $res->headers->get('Content-Disposition'));

            $content = $res->getContent();
            // Ellenőrizzük a UTF-8 BOM meglétét
            $this->assertTrue(str_starts_with($content, "\xEF\xBB\xBF"), "View {$view} hiányzó UTF-8 BOM");
            // Pontosvessző delimiter
            $this->assertStringContainsString(';', $content);
        }
    }

    public function test_xlsx_export_roundtrip(): void
    {
        $u = $this->u('LG');
        $views = [
            'missing_returns',
            'returns',
            'insured',
            'employers',
            'efo_declarations',
            'efo_quotas',
            'reconciliations',
            'calendar',
        ];

        foreach ($views as $view) {
            $res = $this->actingAs($u)->get('/api/taxpayer-tables/export?view=' . $view . '&format=xlsx');
            $res->assertOk();
            $this->assertStringContainsString('spreadsheetml', (string) $res->headers->get('Content-Type'));
            $this->assertStringContainsString($view . '-export.xlsx', (string) $res->headers->get('Content-Disposition'));

            $bytes = $res->getContent();
            $this->assertTrue(str_starts_with($bytes, "PK\x03\x04"), "View {$view} érvénytelen ZIP fejléc");

            // Round-trip parse-olás XlsxReader-rel
            $parsedRows = XlsxReader::rows($bytes);
            $this->assertNotNull($parsedRows, "View {$view} XLSX fájlja nem értelmezhető");
            $this->assertNotEmpty($parsedRows);
            $header = TaxpayerDataTables::getHeaders($view);
            $this->assertEquals($header[0], $parsedRows[0][0]);
        }
    }

    public function test_ingest_taxpayer_tables_api(): void
    {
        $u = $this->u('LG');
        $allowed = Scope::clientIds($u);
        $clientId = $allowed[0];

        $payload = [
            'insured_persons' => [
                [
                    'client_id' => $clientId,
                    'name' => 'Teszt Elek',
                    'tax_id' => '8401928374',
                    'taj' => '999-888-777',
                    'relationship_start' => '2026-01-01',
                    'relationship_type' => '1101 - munkaviszony',
                    'weekly_hours' => 40.0,
                ],
            ],
            'employers' => [
                [
                    'client_id' => $clientId,
                    'employer_name' => 'Ingest Teszt Kft.',
                    'employer_tax_number' => '99887766-1-41',
                    'relationship_start' => '2025-01-01',
                    'relationship_type' => 'Munkaviszony',
                    'weekly_hours' => 30.0,
                ],
            ],
            'efo_declarations' => [
                [
                    'client_id' => $clientId,
                    'employee_name' => 'EFO Ingest Béla',
                    'employee_tax_id' => '8499998888',
                    'start_date' => '2026-11-10',
                    'end_date' => '2026-11-12',
                    'days_count' => 3,
                ],
            ],
            'efo_quotas' => [
                [
                    'client_id' => $clientId,
                    'year' => 2026,
                    'employee_name' => 'EFO Ingest Béla',
                    'employee_tax_id' => '8499998888',
                    'quota_limit' => 90,
                    'used_days' => 10,
                    'remaining_days' => 80,
                ],
            ],
            'reconciliations' => [
                [
                    'client_id' => $clientId,
                    'reconciler_name' => 'NAV Teszt Igazgatóság',
                    'status' => 'Függőben',
                    'case_number' => 'TESZT-2026-001',
                ],
            ],
        ];

        $res = $this->actingAs($u)->postJson('/api/nav/ingest-taxpayer-tables', $payload);
        $res->assertOk();
        $this->assertTrue($res->json('ok'));
        $this->assertEquals(1, $res->json('counts.insured_persons'));
        $this->assertEquals(1, $res->json('counts.employers'));
        $this->assertEquals(1, $res->json('counts.efo_declarations'));
        $this->assertEquals(1, $res->json('counts.efo_quotas'));
        $this->assertEquals(1, $res->json('counts.reconciliations'));

        $this->assertDatabaseHas('nav_insured_persons', [
            'client_id' => $clientId,
            'name' => 'Teszt Elek',
        ]);
    }

    public function test_tenant_isolation(): void
    {
        $u1 = $this->u('LG'); // Office 1
        $u2 = $this->u('KK'); // Office 2 (Másik Iroda)

        // Iroda 1 adózói tábla
        $res1 = $this->actingAs($u1)->getJson('/api/taxpayer-tables/data?view=insured');
        $res1->assertOk();
        $office1Items = $res1->json('items');
        $this->assertNotEmpty($office1Items);

        // Iroda 2 felhasználója kizárólag a saját irodájának ügyfeleit láthatja
        $res2 = $this->actingAs($u2)->getJson('/api/taxpayer-tables/data?view=insured');
        $res2->assertOk();
        $office2Items = $res2->json('items');

        $o1ClientIds = Scope::clientIds($u1);
        $o2ClientIds = Scope::clientIds($u2);
        $this->assertNotEmpty($o1ClientIds);
        $this->assertNotEmpty($o2ClientIds);
        $this->assertEmpty(array_intersect($o1ClientIds, $o2ClientIds), 'Iroda 1 és Iroda 2 ügyfélköre szigorúan elkülönül');

        foreach ($office1Items as $item) {
            $this->assertContains($item['client_id'], $o1ClientIds);
            $this->assertNotContains($item['client_id'], $o2ClientIds);
        }

        foreach ($office2Items as $item) {
            $this->assertContains($item['client_id'], $o2ClientIds);
            $this->assertNotContains($item['client_id'], $o1ClientIds);
        }
    }

    public function test_sorting_by_id_and_name_on_joined_views(): void
    {
        $u = $this->u('LG');

        // Test sorting by ambiguous column 'id' across multiple joined views
        $views = [
            'missing_returns',
            'returns',
            'insured',
            'employers',
            'efo_declarations',
            'efo_quotas',
            'reconciliations',
        ];

        foreach ($views as $view) {
            $resIdAsc = $this->actingAs($u)->getJson("/api/taxpayer-tables/data?view={$view}&sort_by=id&sort_dir=asc");
            $resIdAsc->assertOk();
            $this->assertArrayHasKey('items', $resIdAsc->json());

            $resIdDesc = $this->actingAs($u)->getJson("/api/taxpayer-tables/data?view={$view}&sort_by=id&sort_dir=desc");
            $resIdDesc->assertOk();
            $this->assertArrayHasKey('items', $resIdDesc->json());
        }

        // Test sorting by 'name' or 'client_name' on joined views
        $resName = $this->actingAs($u)->getJson('/api/taxpayer-tables/data?view=insured&sort_by=name&sort_dir=asc');
        $resName->assertOk();
        $this->assertNotEmpty($resName->json('items'));

        $resClientName = $this->actingAs($u)->getJson('/api/taxpayer-tables/data?view=insured&sort_by=client_name&sort_dir=desc');
        $resClientName->assertOk();
        $this->assertNotEmpty($resClientName->json('items'));

        $resEmpName = $this->actingAs($u)->getJson('/api/taxpayer-tables/data?view=employers&sort_by=name&sort_dir=desc');
        $resEmpName->assertOk();
        $this->assertNotEmpty($resEmpName->json('items'));

        $resEfoName = $this->actingAs($u)->getJson('/api/taxpayer-tables/data?view=efo_declarations&sort_by=name&sort_dir=asc');
        $resEfoName->assertOk();
        $this->assertNotEmpty($resEfoName->json('items'));

        $resReconName = $this->actingAs($u)->getJson('/api/taxpayer-tables/data?view=reconciliations&sort_by=name&sort_dir=asc');
        $resReconName->assertOk();
        $this->assertNotEmpty($resReconName->json('items'));
    }

    public function test_query_parameter_type_defense_with_array_input(): void
    {
        $u = $this->u('LG');

        // Query with array input where strings/integers are expected
        $res = $this->actingAs($u)->getJson('/api/taxpayer-tables/data?view=missing_returns&search[]=malicious&sort_by[]=id&sort_dir[]=desc&status[]=missing&year[]=2026');
        $res->assertOk();
        $this->assertArrayHasKey('items', $res->json());

        // Calendar query with array parameters
        $resCal = $this->actingAs($u)->getJson('/api/taxpayer-tables/data?view=calendar&search[]=test&status[]=all&year[]=2026');
        $resCal->assertOk();
        $this->assertArrayHasKey('items', $resCal->json());

        // Export with array parameters
        $resExp = $this->actingAs($u)->get('/api/taxpayer-tables/export?view=insured&format=csv&search[]=test');
        $resExp->assertOk();
    }

    public function test_xlsx_export_with_control_characters(): void
    {
        // Control characters in headers and data
        $headers = [
            'Adózó' . "\x00\x08",
            'Megjegyzés' . "\x0B\x0C\x0E\x1F",
        ];
        $rows = [
            [
                'Teszt Kft.' . "\x01\x02\x03\x04\x05\x06\x07",
                "Normál szöveg \x1A\x1B\x1E és adat",
            ],
            [
                'Másik Kft.',
                12345,
            ],
        ];

        $bytes = XlsxWriter::createXlsx($headers, $rows);
        $this->assertTrue(str_starts_with($bytes, "PK\x03\x04"));

        // Parsolás vissza XlsxReader-rel: nem dob hibát, az XML ép és érvényes
        $parsed = XlsxReader::rows($bytes);
        $this->assertNotNull($parsed);
        $this->assertCount(3, $parsed);
        $this->assertEquals('Adózó', $parsed[0][0]);
        $this->assertEquals('Megjegyzés', $parsed[0][1]);
        $this->assertEquals('Teszt Kft.', $parsed[1][0]);
        $this->assertEquals('Normál szöveg  és adat', $parsed[1][1]);
    }

    public function test_all_eight_views_report_sync_supported_true(): void
    {
        $u = $this->u('LG');
        $views = [
            'missing_returns',
            'returns',
            'insured',
            'employers',
            'efo_declarations',
            'efo_quotas',
            'reconciliations',
            'calendar',
        ];
        foreach ($views as $view) {
            $this->assertTrue(TaxpayerDataTables::isSyncSupported($view), "sync_supported hiányzik: {$view}");
            $res = $this->actingAs($u)->getJson("/api/taxpayer-tables/data?view={$view}");
            $res->assertOk();
            $this->assertTrue((bool) $res->json('sync_supported'));
        }
    }

    public function test_live_nav_snapshot_replaces_mock_rows_and_force_targets_works(): void
    {
        config(['iratkapu.nav_switch' => true, 'iratkapu.nav_queries' => true]);
        $u = $this->u('LG');
        $allowed = Scope::clientIds($u);
        $client = DB::table('clients')->whereIn('id', $allowed)->where('active', true)->first();
        $this->assertNotNull($client);
        $cid = (int) $client->id;
        $stem = substr(preg_replace('/\D+/', '', (string) $client->tax), 0, 8);

        $pid = DB::table('portal_connections')->insertGetId([
            'office_id' => $u->office_id,
            'owner_user_id' => $u->id,
            'name' => 'Teszt ÜK+',
            'auth_mode' => 'totp',
            'vault_key' => 'portal-test-live',
            'download_active' => true,
            'tarhely_state' => 'ok',
            'upo_state' => 'ok',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        DB::table('clients')->where('id', $cid)->update(['nav_seen_at' => now()]);

        // A seeder 4 minta biztosítottat tett be ehhez az ügyfélhez; az élő NAV-válasz (1 valódi sor, üres EFO) lecseréli őket
        $this->assertGreaterThanOrEqual(4, DB::table('nav_insured_persons')->where('client_id', $cid)->count());
        $this->assertGreaterThan(0, DB::table('nav_efo_declarations')->where('client_id', $cid)->count());

        $ingestRes = $this->actingAs($u)->postJson('/api/nav/ingest-clients', [
            'portalId' => $pid,
            'restored' => true,
            'clients' => [[
                'stem' => $stem,
                'account' => ['total' => 0, 'debt' => 0, 'surplus' => 0, 'deposit' => 0, 'unbooked' => 0],
                'obligations' => [],
                'taxpayerTables' => [
                    'insured_persons' => [[
                        'name' => 'Élő Teszt Dolgozó',
                        'tax_id' => '8411111119',
                        'taj' => '111-222-333',
                        'relationship_start' => '2025-02-01',
                        'relationship_type' => '1101 - munkaviszony',
                        'weekly_hours' => 40,
                        'status' => 'active',
                    ]],
                    'employers' => [],
                    'efo_declarations' => [],
                    'efo_quotas' => [],
                    'reconciliations' => [[
                        'reconciler_name' => 'SZIMULÁTOR – ÁFA adategyeztetés',
                        'status' => 'Folyamatban',
                        'case_number' => '901',
                        'created_date' => '2026-10-05',
                        'submitted_date' => null,
                    ]],
                ],
            ]],
        ])->assertOk()->json();

        $this->assertSame(1, $ingestRes['taxpayerTables']['insured_persons']);
        $this->assertSame(1, DB::table('nav_insured_persons')->where('client_id', $cid)->count(), 'minta biztosítottak törlődtek, csak az élő maradt');
        $this->assertSame('Élő Teszt Dolgozó', DB::table('nav_insured_persons')->where('client_id', $cid)->value('name'));
        $this->assertSame(0, DB::table('nav_employers')->where('client_id', $cid)->count(), 'üres tömb törli a régi mintasorokat');
        $this->assertSame(0, DB::table('nav_efo_declarations')->where('client_id', $cid)->count());
        $this->assertSame(0, DB::table('nav_efo_quotas')->where('client_id', $cid)->where('year', (int) date('Y'))->count());
        $this->assertSame(1, DB::table('nav_reconciliations')->where('client_id', $cid)->count());

        // Napi szűrés vs kézi force=1
        $dailyIds = $this->actingAs($u)->getJson("/api/nav/targets?portalId={$pid}")->assertOk()->json('ids');
        $this->assertNotContains($stem, $dailyIds);
        $forcedIds = $this->actingAs($u)->getJson("/api/nav/targets?portalId={$pid}&force=1")->assertOk()->json('ids');
        $this->assertContains($stem, $forcedIds);
    }

    public function test_xlsx_fallback_ingestion_parses_insured_employers_and_efo_quotas(): void
    {
        $u = $this->u('LG');
        $cid = Scope::clientIds($u)[0];

        $insBytes = XlsxWriter::createXlsx(
            ['Munkavállaló neve', 'Adóazonosító jel', 'TAJ szám', 'Jogviszony kezdete', 'Jogviszony megnevezése', 'Heti munkaóra'],
            [['Minta Mária', '8422222228', '123456789', '2025.04.01', '1101 - munkaviszony', '30']]
        );
        $empBytes = XlsxWriter::createXlsx(
            ['Foglalkoztató neve', 'Foglalkoztató adószáma', 'Jogviszony kezdete', 'Jogviszony', 'Heti óra'],
            [['SZIMULÁTOR Munkáltató Kft.', '12345678-2-42', '2024.09.01', 'Megbízási jogviszony', '20']]
        );
        $efoBytes = XlsxWriter::createXlsx(
            ['Munkavállaló neve', 'Adóazonosító', 'TAJ', 'Felhasznált napok', 'Felhasználható napok'],
            [['Alkalmi Ádám', '8433333337', '987654321', '18', '102']]
        );

        $res = $this->actingAs($u)->postJson('/api/nav/ingest-taxpayer-tables', [
            'client_id' => $cid,
            'snapshot' => true,
            'insured_xlsx_base64' => base64_encode($insBytes),
            'employers_xlsx_base64' => base64_encode($empBytes),
            'efo_quotas_xlsx_base64' => base64_encode($efoBytes),
        ])->assertOk()->json('counts');

        $this->assertSame(1, $res['insured_persons']);
        $this->assertSame(1, $res['employers']);
        $this->assertSame(1, $res['efo_quotas']);

        $insRow = DB::table('nav_insured_persons')->where('client_id', $cid)->first();
        $this->assertSame('Minta Mária', $insRow->name ?? null);
        $this->assertSame('123-456-789', $insRow->taj ?? null);
        $this->assertEquals(30.0, (float) ($insRow->weekly_hours ?? 0));

        $quotaRow = DB::table('nav_efo_quotas')->where('client_id', $cid)->where('employee_tax_id', '8433333337')->first();
        $this->assertNotNull($quotaRow);
        $this->assertSame(18, (int) ($quotaRow->used_days ?? 0));
        $this->assertSame(102, (int) ($quotaRow->remaining_days ?? 0));
        $this->assertSame(120, (int) ($quotaRow->quota_limit ?? 0));
    }

    public function test_returns_enrichment_pairs_tarhely_acceptance_and_error_receipts_and_skips_deleted(): void
    {
        $u = $this->u('LG');
        $cid = Scope::clientIds($u)[0];
        $mailboxId = DB::table('mailboxes')->where('client_id', $cid)->value('id')
            ?: DB::table('mailboxes')->insertGetId([
                'office_id' => $u->office_id,
                'client_id' => $cid,
                'type' => 'CK',
                'sync_state' => 'ok',
                'created_at' => now(),
                'updated_at' => now(),
            ]);

        DB::table('nav_returns')->where('client_id', $cid)->delete();
        DB::table('nav_returns')->insert([
            [
                'office_id' => $u->office_id,
                'client_id' => $cid,
                'reg_no' => '8155550001',
                'barcode' => null,
                'form_code' => '2608',
                'title' => 'Havi járulékbevallás',
                'period_from' => '2026-09-01',
                'period_to' => '2026-09-30',
                'submitted_at' => '2026-10-12 08:15',
                'accepted_at' => null,
                'error_at' => null,
                'state' => 'Feldolgozott',
                'kind' => 'ALAPBEVALLAS',
                'fetched_at' => now(),
                'created_at' => now(),
                'updated_at' => now(),
            ],
            [
                'office_id' => $u->office_id,
                'client_id' => $cid,
                'reg_no' => '8155550002',
                'barcode' => null,
                'form_code' => '2665',
                'title' => 'ÁFA bevallás',
                'period_from' => '2026-09-01',
                'period_to' => '2026-09-30',
                'submitted_at' => '2026-10-20 11:00',
                'accepted_at' => null,
                'error_at' => null,
                'state' => 'Hibás',
                'kind' => 'ALAPBEVALLAS',
                'fetched_at' => now(),
                'created_at' => now(),
                'updated_at' => now(),
            ],
            [
                'office_id' => $u->office_id,
                'client_id' => $cid,
                'reg_no' => '8155550003',
                'barcode' => null,
                'form_code' => '2665',
                'title' => 'Törölt ÁFA bevallás',
                'period_from' => '2026-09-01',
                'period_to' => '2026-09-30',
                'submitted_at' => '2026-10-19 09:00',
                'accepted_at' => null,
                'error_at' => null,
                'state' => 'Törölt',
                'kind' => 'ALAPBEVALLAS',
                'fetched_at' => now(),
                'created_at' => now(),
                'updated_at' => now(),
            ],
        ]);

        // 1. Elfogadó nyugta vonalkód alapján
        DB::table('messages')->insert([
            'office_id' => $u->office_id,
            'client_id' => $cid,
            'mailbox_id' => $mailboxId,
            'source_id' => 'nyugta-ok-1',
            'sender' => 'NAV',
            'sender_full' => 'Nemzeti Adó- és Vámhivatal',
            'subject' => '2608, Elfogadó nyugta',
            'type_id' => 'nav.nyugta.elfogado',
            'type_label' => 'NAV elfogadó nyugta',
            'receipt' => true,
            'barcode' => '8155550001',
            'arrived_at' => '2026-10-12 08:19:00',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // 2. Elutasító / hibaüzenet nyugta nyomtatványkód + időszak alapján a tárgyból
        DB::table('messages')->insert([
            'office_id' => $u->office_id,
            'client_id' => $cid,
            'mailbox_id' => $mailboxId,
            'source_id' => 'nyugta-err-2',
            'sender' => 'NAV',
            'sender_full' => 'Nemzeti Adó- és Vámhivatal',
            'subject' => '2665, Elutasító nyugta (12345678), 2026.09.01-2026.09.30, Szimulátor Kft.',
            'type_id' => 'nav.nyugta.elutasito',
            'type_label' => 'NAV elutasító nyugta',
            'receipt' => true,
            'barcode' => '9988776655',
            'arrived_at' => '2026-10-20 11:04:00',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $items = collect($this->actingAs($u)->getJson("/api/taxpayer-tables/data?view=returns&client_id={$cid}")->assertOk()->json('items'))->keyBy('reg_no');

        $this->assertSame('8155550001', $items['8155550001']['barcode']);
        $this->assertSame('2026-10-12 08:19', $items['8155550001']['accepted_at']);
        $this->assertSame('', $items['8155550001']['error_at']);

        $this->assertSame('9988776655', $items['8155550002']['barcode']);
        $this->assertSame('2026-10-20 11:04', $items['8155550002']['error_at']);

        // Törölt bevallás nem örökli a másik bevallás elutasító nyugtáját
        $this->assertSame('', $items['8155550003']['error_at']);
    }

    public function test_calendar_merges_nav_returns_and_prevents_past_receipts_from_marking_future_obligations(): void
    {
        $u = $this->u('LG');
        $cid = Scope::clientIds($u)[0];
        $mailboxId = DB::table('mailboxes')->where('client_id', $cid)->value('id')
            ?: DB::table('mailboxes')->insertGetId([
                'office_id' => $u->office_id,
                'client_id' => $cid,
                'type' => 'CK',
                'sync_state' => 'ok',
                'created_at' => now(),
                'updated_at' => now(),
            ]);

        DB::table('tax_obligations')->where('client_id', $cid)->delete();
        DB::table('nav_returns')->where('client_id', $cid)->delete();

        // Jövőbeli adónaptár-kötelezettségek (november és december)
        $novId = DB::table('tax_obligations')->insertGetId([
            'office_id' => $u->office_id,
            'client_id' => $cid,
            'source' => 'nav',
            'external_key' => 'nav|2665|||2026-11-20|teszt',
            'form_code' => '2665',
            'title' => 'ÁFA bevallás',
            'due_date' => '2026-11-20',
            'conditional' => false,
            'status' => 'submittable',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        $decId = DB::table('tax_obligations')->insertGetId([
            'office_id' => $u->office_id,
            'client_id' => $cid,
            'source' => 'nav',
            'external_key' => 'nav|2665|||2026-12-21|teszt',
            'form_code' => '2665',
            'title' => 'ÁFA bevallás',
            'due_date' => '2026-12-21',
            'conditional' => false,
            'status' => 'submittable',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // Októberi nyugta (szeptemberi időszakra) és egy novemberi Letöltési igazolás NEM jelölheti Beadva-ra a novemberi/decemberi esedékességet!
        $octMsgId = DB::table('messages')->insertGetId([
            'office_id' => $u->office_id,
            'client_id' => $cid,
            'mailbox_id' => $mailboxId,
            'source_id' => 'oct-ack-2665',
            'sender' => 'NAV',
            'sender_full' => 'Nemzeti Adó- és Vámhivatal',
            'subject' => 'Feladási igazolás (2665A_12345678_Teszt.kr)',
            'type_id' => 'rendszer.idomsoft',
            'type_label' => 'Feladási igazolás',
            'receipt' => true,
            'arrived_at' => '2026-10-20 09:08:00',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        $dlAckId = DB::table('messages')->insertGetId([
            'office_id' => $u->office_id,
            'client_id' => $cid,
            'mailbox_id' => $mailboxId,
            'source_id' => 'nov-dl-ack',
            'sender' => 'NAV',
            'sender_full' => 'Nemzeti Adó- és Vámhivatal',
            'subject' => 'Letöltési igazolás (2665A_12345678_Teszt.kr)',
            'type_id' => 'rendszer.idomsoft',
            'type_label' => 'Letöltési igazolás',
            'receipt' => true,
            'arrived_at' => '2026-11-15 10:00:00',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $this->assertNull(\App\Iratkapu\DeadlineExtractor::pairObligation(DB::table('messages')->find($octMsgId)));
        $this->assertNull(\App\Iratkapu\DeadlineExtractor::pairObligation(DB::table('messages')->find($dlAckId)));
        $this->assertSame('submittable', DB::table('tax_obligations')->where('id', $novId)->value('status'));
        $this->assertSame('submittable', DB::table('tax_obligations')->where('id', $decId)->value('status'));

        // Korábbi hónapokban (pl. február, október, november eleje) ténylegesen beadott bevallások a nav_returns táblában
        DB::table('nav_returns')->insert([
            [
                'office_id' => $u->office_id,
                'client_id' => $cid,
                'reg_no' => '8177770001',
                'form_code' => '2608',
                'title' => 'Havi járulékbevallás',
                'period_from' => '2026-01-01',
                'period_to' => '2026-01-31',
                'submitted_at' => '2026-02-04 08:15',
                'state' => 'Feldolgozott',
                'kind' => 'ALAPBEVALLAS',
                'fetched_at' => now(),
                'created_at' => now(),
                'updated_at' => now(),
            ],
            [
                'office_id' => $u->office_id,
                'client_id' => $cid,
                'reg_no' => '8177770002',
                'form_code' => '2608',
                'title' => 'Havi járulékbevallás',
                'period_from' => '2026-10-01',
                'period_to' => '2026-10-31',
                'submitted_at' => '2026-11-04 08:11',
                'state' => 'Feldolgozott',
                'kind' => 'ALAPBEVALLAS',
                'fetched_at' => now(),
                'created_at' => now(),
                'updated_at' => now(),
            ],
        ]);

        // Beadva szűrővel: februárban és novemberben látszik a 2608, decemberben viszont 0 beadott van!
        $subCal = $this->actingAs($u)->getJson("/api/taxpayer-tables/data?view=calendar&year=2026&status=submitted&client_id={$cid}")->assertOk()->json('items.0');
        $this->assertSame(1, $subCal['months']['2']['summary']['submitted']);
        $this->assertSame('2608', $subCal['months']['2']['items'][0]['form_code']);
        $this->assertSame(1, $subCal['months']['11']['summary']['submitted']);
        $this->assertSame('2608', $subCal['months']['11']['items'][0]['form_code']);
        $this->assertSame(0, $subCal['months']['12']['summary']['submitted']);
        $this->assertEmpty($subCal['months']['12']['items']);

        // Mind szűrővel novemberben együtt látszik a beadott 2608 és a beadható 2665
        $allCal = $this->actingAs($u)->getJson("/api/taxpayer-tables/data?view=calendar&year=2026&client_id={$cid}")->assertOk()->json('items.0');
        $this->assertSame(1, $allCal['months']['11']['summary']['submitted']);
        $this->assertSame(1, $allCal['months']['11']['summary']['submittable']);
    }
}
