<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;

class TaxpayerTablesSeeder extends Seeder
{
    /**
     * Seed realistic mock/demo data for any empty taxpayer tables if clients exist.
     */
    public function run(): void
    {
        $pureDemo = config('iratkapu.mode') === 'demo'
            && !config('iratkapu.live_listing')
            && DB::table('portal_connections')->whereNotNull('vault_key')->count() === 0;
        if (!app()->runningUnitTests() && !$pureDemo) {
            return;
        }

        $clients = DB::table('clients')->get();
        if ($clients->isEmpty()) {
            return;
        }

        $now = now();
        $ts = ['created_at' => $now, 'updated_at' => $now];

        // 1. Frissítsük a meglévő nav_returns vonalkódjait és befogadási dátumait (csak teszt / tiszta demó módban)
        DB::table('nav_returns')->whereNull('barcode')->orWhere('barcode', '')->get()->each(function ($ret) {
            DB::table('nav_returns')->where('id', $ret->id)->update([
                'barcode' => (string) (($ret->reg_no ?? null) ?: ('810000' . $ret->id)),
                'accepted_at' => ($ret->accepted_at ?? null) ?: ($ret->submitted_at ?? date('Y-m-d H:i')),
            ]);
        });

        // Ha nincsenek nav_returns rekordok, szúrjunk be mintákat az ügyfelekhez
        if (DB::table('nav_returns')->count() === 0) {
            foreach ($clients->take(5) as $client) {
                DB::table('nav_returns')->insert([
                    [
                        'office_id' => $client->office_id,
                        'client_id' => $client->id,
                        'reg_no' => '8104920' . $client->id . '1',
                        'barcode' => '8104920' . $client->id . '1',
                        'form_code' => '2608',
                        'title' => 'Havi adó- és járulékbevallás',
                        'period_from' => date('Y-m-01', strtotime('-1 month')),
                        'period_to' => date('Y-m-t', strtotime('-1 month')),
                        'submitted_at' => date('Y-m-12 10:15', strtotime('-1 month')),
                        'accepted_at' => date('Y-m-12 10:18', strtotime('-1 month')),
                        'error_at' => null,
                        'state' => 'Feldolgozott',
                        'kind' => 'ALAPBEVALLAS',
                        'fetched_at' => $now,
                        'created_at' => $now,
                        'updated_at' => $now,
                    ],
                    [
                        'office_id' => $client->office_id,
                        'client_id' => $client->id,
                        'reg_no' => '8104920' . $client->id . '2',
                        'barcode' => '8104920' . $client->id . '2',
                        'form_code' => '2665',
                        'title' => 'Általános forgalmi adó bevallás',
                        'period_from' => date('Y-m-01', strtotime('-1 month')),
                        'period_to' => date('Y-m-t', strtotime('-1 month')),
                        'submitted_at' => date('Y-m-20 14:22', strtotime('-1 month')),
                        'accepted_at' => date('Y-m-20 14:25', strtotime('-1 month')),
                        'error_at' => null,
                        'state' => 'Feldolgozott',
                        'kind' => 'ALAPBEVALLAS',
                        'fetched_at' => $now,
                        'created_at' => $now,
                        'updated_at' => $now,
                    ],
                ]);
            }
        }

        $insuredMock = [
            ['name' => 'Kovács János', 'tax_id' => '8410293847', 'taj' => '012-345-678', 'start' => '2023-01-01', 'type' => '1101 - munkaviszony (teljes munkaidő)', 'hours' => 40.0],
            ['name' => 'Tóth Andrea', 'tax_id' => '8501239871', 'taj' => '023-456-789', 'start' => '2023-06-15', 'type' => '1101 - munkaviszony (részmunkaidő)', 'hours' => 20.0],
            ['name' => 'Varga Gábor', 'tax_id' => '8392018273', 'taj' => '034-567-890', 'start' => '2024-02-01', 'type' => '1210 - megbízási jogviszony', 'hours' => 10.0],
            ['name' => 'Szabó Eszter', 'tax_id' => '8481927364', 'taj' => '045-678-901', 'start' => '2022-09-01', 'type' => '1101 - munkaviszony', 'hours' => 40.0],
        ];

        $employerMock = [
            ['name' => 'Fővárosi Vízművek Zrt.', 'tax_number' => '11223344-2-41', 'tax_id' => '8192837465', 'start' => '2020-03-01', 'type' => 'Munkaviszony', 'hours' => 40.0],
            ['name' => 'Duna Tech Informatika Kft.', 'tax_number' => '22334455-2-41', 'tax_id' => '8201928374', 'start' => '2022-07-01', 'type' => 'Megbízási szerződés', 'hours' => 15.0],
        ];

        $efoMock = [
            ['name' => 'Balogh Ferenc', 'tax_id' => '8492019283', 'taj' => '056-789-012', 'code' => '26T1042E', 'type' => 'Alkalmi munka', 'days' => 3, 'reg' => '8109920111', 'status' => 'Befogadva'],
            ['name' => 'Molnár Katalin', 'tax_id' => '8519283746', 'taj' => '067-890-123', 'code' => '26T1042E', 'type' => 'Idénymunka (mezőgazdasági)', 'days' => 5, 'reg' => '8109920112', 'status' => 'Befogadva'],
            ['name' => 'Németh László', 'tax_id' => '8382910293', 'taj' => '078-901-234', 'code' => '26T1042E', 'type' => 'Filmipari statiszta', 'days' => 1, 'reg' => '8109920113', 'status' => 'Feldolgozás alatt'],
        ];

        $reconcileMock = [
            ['reconciler' => 'NAV Kelet-budapesti Adó- és Vámigazgatósága', 'status' => 'Folyamatban', 'case' => 'NAV-2026-EGY-0112', 'notes' => '2026. évi I. negyedéves áfa egyeztetés.'],
            ['reconciler' => 'Budapest Főváros Önkormányzata (Helyi iparűzési adó)', 'status' => 'Függőben', 'case' => 'BP-HIPA-2026-88', 'notes' => 'Megosztási arány pontosítása.'],
        ];

        foreach ($clients as $client) {
            $cid = $client->id;
            $oid = $client->office_id;

            // Insured persons
            if (DB::table('nav_insured_persons')->where('client_id', $cid)->count() === 0) {
                foreach ($insuredMock as $ins) {
                    DB::table('nav_insured_persons')->insert([
                        'office_id' => $oid,
                        'client_id' => $cid,
                        'name' => $ins['name'],
                        'tax_id' => $ins['tax_id'],
                        'taj' => $ins['taj'],
                        'relationship_start' => $ins['start'],
                        'relationship_type' => $ins['type'],
                        'weekly_hours' => $ins['hours'],
                        'status' => 'active',
                        'source' => 'nav_upo',
                        'fetched_at' => $now,
                    ] + $ts);
                }
            }

            // Employers
            if (DB::table('nav_employers')->where('client_id', $cid)->count() === 0) {
                foreach ($employerMock as $emp) {
                    DB::table('nav_employers')->insert([
                        'office_id' => $oid,
                        'client_id' => $cid,
                        'employer_name' => $emp['name'],
                        'employer_tax_number' => $emp['tax_number'],
                        'employer_tax_id' => $emp['tax_id'],
                        'relationship_start' => $emp['start'],
                        'relationship_type' => $emp['type'],
                        'weekly_hours' => $emp['hours'],
                        'status' => 'active',
                        'source' => 'nav_upo',
                        'fetched_at' => $now,
                    ] + $ts);
                }
            }

            // EFO declarations
            if (DB::table('nav_efo_declarations')->where('client_id', $cid)->count() === 0) {
                foreach ($efoMock as $idx => $efo) {
                    $start = date('Y-m-d', strtotime("-{$idx} week"));
                    $end = date('Y-m-d', strtotime("-{$idx} week + " . ($efo['days'] - 1) . ' days'));
                    DB::table('nav_efo_declarations')->insert([
                        'office_id' => $oid,
                        'client_id' => $cid,
                        'employee_name' => $efo['name'],
                        'employee_tax_id' => $efo['tax_id'],
                        'employee_taj' => $efo['taj'],
                        'declaration_code' => $efo['code'],
                        'employment_type' => $efo['type'],
                        'start_date' => $start,
                        'end_date' => $end,
                        'days_count' => $efo['days'],
                        'reg_no' => $efo['reg'] . "-{$cid}",
                        'status' => $efo['status'],
                        'filing_type' => 'Új',
                        'submitted_at' => $start . ' 08:30:00',
                        'seq_no' => $idx + 1,
                        'source' => 'nav_upo',
                        'fetched_at' => $now,
                    ] + $ts);
                }
            }

            // EFO quotas
            if (DB::table('nav_efo_quotas')->where('client_id', $cid)->count() === 0) {
                $curYear = (int) date('Y');
                // Összesített keret
                DB::table('nav_efo_quotas')->insert([
                    'office_id' => $oid,
                    'client_id' => $cid,
                    'year' => $curYear,
                    'employee_name' => null,
                    'employee_tax_id' => null,
                    'employee_taj' => null,
                    'employment_type' => 'Foglalkoztatói összesített napkeret',
                    'quota_limit' => 300,
                    'used_days' => 45,
                    'remaining_days' => 255,
                ] + $ts);

                // Munkavállalónkénti keret
                foreach ($efoMock as $efo) {
                    DB::table('nav_efo_quotas')->insert([
                        'office_id' => $oid,
                        'client_id' => $cid,
                        'year' => $curYear,
                        'employee_name' => $efo['name'],
                        'employee_tax_id' => $efo['tax_id'],
                        'employee_taj' => $efo['taj'],
                        'employment_type' => $efo['type'],
                        'quota_limit' => 90,
                        'used_days' => 15,
                        'remaining_days' => 75,
                    ] + $ts);
                }
            }

            // Reconciliations
            if (DB::table('nav_reconciliations')->where('client_id', $cid)->count() === 0) {
                foreach ($reconcileMock as $idx => $rec) {
                    DB::table('nav_reconciliations')->insert([
                        'office_id' => $oid,
                        'client_id' => $cid,
                        'reconciler_name' => $rec['reconciler'],
                        'status' => $rec['status'],
                        'case_number' => $rec['case'],
                        'created_date' => date('Y-m-d', strtotime("-{$idx} month")),
                        'submitted_date' => $rec['status'] === 'Lezárt' ? date('Y-m-d') : null,
                        'notes' => $rec['notes'],
                        'source' => 'nav_upo',
                        'fetched_at' => $now,
                    ] + $ts);
                }
            }
        }
    }
}
