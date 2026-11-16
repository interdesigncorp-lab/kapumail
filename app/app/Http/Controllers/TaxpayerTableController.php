<?php

namespace App\Http\Controllers;

use App\Iratkapu\Audit;
use App\Iratkapu\Scope;
use App\Iratkapu\TaxpayerDataTables;
use App\Iratkapu\XlsxWriter;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

class TaxpayerTableController extends Controller
{
    private const ALLOWED_VIEWS = [
        'missing_returns',
        'returns',
        'insured',
        'employers',
        'efo_declarations',
        'efo_quotas',
        'reconciliations',
        'calendar',
    ];

    private function u(): object
    {
        return Auth::user();
    }

    /**
     * GET /api/taxpayer-tables/data
     */
    public function data(Request $request)
    {
        $u = $this->u();
        $view = is_string($request->query('view')) ? (string) $request->query('view') : 'missing_returns';
        if (!in_array($view, self::ALLOWED_VIEWS, true)) {
            $view = 'missing_returns';
        }

        $data = TaxpayerDataTables::getData($u, $view, $request->all());

        return response()->json($data);
    }

    /**
     * GET /api/taxpayer-tables/export
     */
    public function export(Request $request)
    {
        $u = $this->u();
        $view = is_string($request->query('view')) ? (string) $request->query('view') : 'missing_returns';
        if (!in_array($view, self::ALLOWED_VIEWS, true)) {
            $view = 'missing_returns';
        }

        $format = is_string($request->query('format')) ? strtolower((string) $request->query('format')) : 'csv';
        $exportData = TaxpayerDataTables::getExportData($u, $view, $request->all());

        Audit::log($u->office_id, $u, "Adózói tábla exportálva ({$view}, {$format}, " . count($exportData['rows']) . ' sor)');

        if ($format === 'xlsx') {
            $bytes = XlsxWriter::createXlsx($exportData['headers'], $exportData['rows']);
            return response($bytes, 200, [
                'Content-Type' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition' => 'attachment; filename="' . $view . '-export.xlsx"',
                'Cache-Control' => 'no-cache, private',
            ]);
        }

        $csv = XlsxWriter::createCsv($exportData['headers'], $exportData['rows']);
        return response($csv, 200, [
            'Content-Type' => 'text/csv; charset=UTF-8',
            'Content-Disposition' => 'attachment; filename="' . $view . '-export.csv"',
            'Cache-Control' => 'no-cache, private',
        ]);
    }

    /**
     * POST /api/nav/ingest-taxpayer-tables
     */
    public function ingest(Request $request)
    {
        $u = $this->u();
        $allowedClients = Scope::clientIds($u);

        $counts = DB::transaction(function () use ($u, $allowedClients, $request) {
            $counts = [
                'insured_persons' => 0,
                'employers' => 0,
                'efo_declarations' => 0,
                'efo_quotas' => 0,
                'reconciliations' => 0,
            ];

            // Pillanatkép-mód ügyfelenként (clients: [{ client_id, ... }] vagy client_id + snapshot / *_xlsx_base64)
            $clientSnapshots = $request->input('clients');
            if (is_array($clientSnapshots)) {
                foreach ($clientSnapshots as $cs) {
                    if (!is_array($cs)) {
                        continue;
                    }
                    $cid = (int) ($cs['client_id'] ?? 0);
                    if (!$cid || !in_array($cid, $allowedClients, true)) {
                        continue;
                    }
                    $sc = TaxpayerDataTables::syncClientSnapshot((int) $u->office_id, $cid, $cs);
                    foreach ($counts as $k => $v) {
                        $counts[$k] += (int) ($sc[$k] ?? 0);
                    }
                }
            } elseif ($request->filled('client_id') && ($request->boolean('snapshot') || $request->hasAny(['insured_xlsx_base64', 'employers_xlsx_base64', 'efo_quotas_xlsx_base64']))) {
                $cid = (int) $request->input('client_id');
                if ($cid && in_array($cid, $allowedClients, true)) {
                    $sc = TaxpayerDataTables::syncClientSnapshot((int) $u->office_id, $cid, $request->all());
                    foreach ($counts as $k => $v) {
                        $counts[$k] += (int) ($sc[$k] ?? 0);
                    }
                }
                return $counts;
            }

            // 1. Insured persons
            $insured = $request->input('insured_persons', []);
            if (is_array($insured)) {
                foreach ($insured as $item) {
                    $cid = (int) ($item['client_id'] ?? 0);
                    if (!$cid || !in_array($cid, $allowedClients, true)) {
                        continue;
                    }
                    DB::table('nav_insured_persons')->updateOrInsert(
                        [
                            'office_id' => $u->office_id,
                            'client_id' => $cid,
                            'name' => (string) ($item['name'] ?? ''),
                            'tax_id' => !empty($item['tax_id']) ? (string) $item['tax_id'] : null,
                        ],
                        [
                            'taj' => !empty($item['taj']) ? (string) $item['taj'] : null,
                            'relationship_start' => !empty($item['relationship_start']) ? (string) $item['relationship_start'] : null,
                            'relationship_end' => !empty($item['relationship_end']) ? (string) $item['relationship_end'] : null,
                            'relationship_type' => !empty($item['relationship_type']) ? (string) $item['relationship_type'] : null,
                            'weekly_hours' => isset($item['weekly_hours']) ? (float) $item['weekly_hours'] : null,
                            'status' => (string) ($item['status'] ?? 'active'),
                            'source' => (string) ($item['source'] ?? 'nav_upo'),
                            'fetched_at' => now(),
                            'updated_at' => now(),
                        ]
                    );
                    $counts['insured_persons']++;
                }
            }

            // 2. Employers
            $employers = $request->input('employers', $request->input('own_employers', []));
            if (is_array($employers)) {
                foreach ($employers as $item) {
                    $cid = (int) ($item['client_id'] ?? 0);
                    if (!$cid || !in_array($cid, $allowedClients, true)) {
                        continue;
                    }
                    DB::table('nav_employers')->updateOrInsert(
                        [
                            'office_id' => $u->office_id,
                            'client_id' => $cid,
                            'employer_name' => (string) ($item['employer_name'] ?? ''),
                        ],
                        [
                            'employer_tax_number' => !empty($item['employer_tax_number']) ? (string) $item['employer_tax_number'] : null,
                            'employer_tax_id' => !empty($item['employer_tax_id']) ? (string) $item['employer_tax_id'] : null,
                            'relationship_start' => !empty($item['relationship_start']) ? (string) $item['relationship_start'] : null,
                            'relationship_end' => !empty($item['relationship_end']) ? (string) $item['relationship_end'] : null,
                            'relationship_type' => !empty($item['relationship_type']) ? (string) $item['relationship_type'] : null,
                            'weekly_hours' => isset($item['weekly_hours']) ? (float) $item['weekly_hours'] : null,
                            'status' => (string) ($item['status'] ?? 'active'),
                            'source' => (string) ($item['source'] ?? 'nav_upo'),
                            'fetched_at' => now(),
                            'updated_at' => now(),
                        ]
                    );
                    $counts['employers']++;
                }
            }

            // 3. EFO declarations
            $efo = $request->input('efo_declarations', []);
            if (is_array($efo)) {
                foreach ($efo as $item) {
                    $cid = (int) ($item['client_id'] ?? 0);
                    if (!$cid || !in_array($cid, $allowedClients, true)) {
                        continue;
                    }
                    DB::table('nav_efo_declarations')->updateOrInsert(
                        [
                            'office_id' => $u->office_id,
                            'client_id' => $cid,
                            'employee_name' => (string) ($item['employee_name'] ?? ''),
                            'start_date' => (string) ($item['start_date'] ?? date('Y-m-d')),
                        ],
                        [
                            'employee_tax_id' => !empty($item['employee_tax_id']) ? (string) $item['employee_tax_id'] : null,
                            'employee_taj' => !empty($item['employee_taj']) ? (string) $item['employee_taj'] : null,
                            'declaration_code' => !empty($item['declaration_code']) ? (string) $item['declaration_code'] : null,
                            'employment_type' => !empty($item['employment_type']) ? (string) $item['employment_type'] : null,
                            'end_date' => (string) ($item['end_date'] ?? ($item['start_date'] ?? date('Y-m-d'))),
                            'days_count' => (int) ($item['days_count'] ?? 1),
                            'reg_no' => !empty($item['reg_no']) ? (string) $item['reg_no'] : null,
                            'status' => (string) ($item['status'] ?? 'Befogadva'),
                            'filing_type' => (string) ($item['filing_type'] ?? 'Új'),
                            'submitted_at' => !empty($item['submitted_at']) ? (string) $item['submitted_at'] : null,
                            'seq_no' => isset($item['seq_no']) ? (int) $item['seq_no'] : null,
                            'source' => (string) ($item['source'] ?? 'nav_upo'),
                            'fetched_at' => now(),
                            'updated_at' => now(),
                        ]
                    );
                    $counts['efo_declarations']++;
                }
            }

            // 4. EFO quotas
            $quotas = $request->input('efo_quotas', []);
            if (is_array($quotas)) {
                foreach ($quotas as $item) {
                    $cid = (int) ($item['client_id'] ?? 0);
                    if (!$cid || !in_array($cid, $allowedClients, true)) {
                        continue;
                    }
                    $yr = (int) ($item['year'] ?? date('Y'));
                    $empTaxId = !empty($item['employee_tax_id']) ? (string) $item['employee_tax_id'] : null;

                    DB::table('nav_efo_quotas')->updateOrInsert(
                        [
                            'office_id' => $u->office_id,
                            'client_id' => $cid,
                            'year' => $yr,
                            'employee_tax_id' => $empTaxId,
                        ],
                        [
                            'employee_name' => !empty($item['employee_name']) ? (string) $item['employee_name'] : null,
                            'employee_taj' => !empty($item['employee_taj']) ? (string) $item['employee_taj'] : null,
                            'employment_type' => !empty($item['employment_type']) ? (string) $item['employment_type'] : null,
                            'quota_limit' => (int) ($item['quota_limit'] ?? 0),
                            'used_days' => (int) ($item['used_days'] ?? 0),
                            'remaining_days' => (int) ($item['remaining_days'] ?? 0),
                            'updated_at' => now(),
                        ]
                    );
                    $counts['efo_quotas']++;
                }
            }

            // 5. Reconciliations
            $recons = $request->input('reconciliations', []);
            if (is_array($recons)) {
                foreach ($recons as $item) {
                    $cid = (int) ($item['client_id'] ?? 0);
                    if (!$cid || !in_array($cid, $allowedClients, true)) {
                        continue;
                    }
                    DB::table('nav_reconciliations')->updateOrInsert(
                        [
                            'office_id' => $u->office_id,
                            'client_id' => $cid,
                            'reconciler_name' => (string) ($item['reconciler_name'] ?? ''),
                            'created_date' => (string) ($item['created_date'] ?? date('Y-m-d')),
                        ],
                        [
                            'status' => (string) ($item['status'] ?? 'Függőben'),
                            'case_number' => !empty($item['case_number']) ? (string) $item['case_number'] : null,
                            'submitted_date' => !empty($item['submitted_date']) ? (string) $item['submitted_date'] : null,
                            'notes' => !empty($item['notes']) ? (string) $item['notes'] : null,
                            'source' => (string) ($item['source'] ?? 'nav_upo'),
                            'fetched_at' => now(),
                            'updated_at' => now(),
                        ]
                    );
                    $counts['reconciliations']++;
                }
            }

            return $counts;
        });

        Audit::log($u->office_id, $u, 'Adózói táblák szinkronizálva', ['counts' => $counts]);

        return response()->json([
            'ok' => true,
            'counts' => $counts,
        ]);
    }
}
