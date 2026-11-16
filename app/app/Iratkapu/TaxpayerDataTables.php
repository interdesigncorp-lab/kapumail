<?php

namespace App\Iratkapu;

use Illuminate\Support\Facades\DB;

final class TaxpayerDataTables
{
    public const VIEWS = [
        'missing_returns',
        'returns',
        'insured',
        'employers',
        'efo_declarations',
        'efo_quotas',
        'reconciliations',
        'calendar',
    ];

    /**
     * Get paginated table data according to view and filters.
     *
     * @param object $u Authenticated user
     * @param string $view View identifier
     * @param array<string, mixed> $params Query parameters
     * @return array<string, mixed>
     */
    public static function getData(object $u, string $view, array $params = []): array
    {
        $allowedClients = Scope::clientIds($u);
        if (empty($allowedClients)) {
            return [
                'items' => [],
                'total' => 0,
                'page' => 1,
                'per_page' => (int) ($params['per_page'] ?? 50),
                'years' => self::getYears($u),
                'clients' => [],
                'sync_supported' => self::isSyncSupported($view),
            ];
        }

        $page = max(1, (int) ($params['page'] ?? 1));
        $perPage = max(10, min(200, (int) ($params['per_page'] ?? 50)));

        if ($view === 'calendar') {
            return self::getCalendarMatrix($u, $allowedClients, $params, $page, $perPage);
        }

        $query = self::buildQuery($u, $view, $allowedClients, $params);
        $total = $query->count();
        $offset = ($page - 1) * $perPage;

        $sortBy = is_string($params['sort_by'] ?? null) ? trim((string) $params['sort_by']) : '';
        $sortDir = is_string($params['sort_dir'] ?? null) && strtolower(trim((string) $params['sort_dir'])) === 'desc' ? 'desc' : 'asc';
        self::applySorting($query, $view, $sortBy, $sortDir);

        $rows = $query->offset($offset)->limit($perPage)->get();
        if ($view === 'returns') {
            self::enrichReturnsWithReceipts((int) $u->office_id, $rows);
        }
        $items = self::mapRows($view, $rows);

        return [
            'items' => $items,
            'total' => $total,
            'page' => $page,
            'per_page' => $perPage,
            'years' => self::getYears($u),
            'clients' => self::getClients($u, $allowedClients),
            'sync_supported' => self::isSyncSupported($view),
        ];
    }

    public static function isSyncSupported(string $view): bool
    {
        return in_array($view, [
            'missing_returns',
            'returns',
            'insured',
            'employers',
            'efo_declarations',
            'efo_quotas',
            'reconciliations',
            'calendar',
        ], true);
    }

    /**
     * Export dataset as headers and rows for CSV or XLSX generation.
     *
     * @param object $u Authenticated user
     * @param string $view View identifier
     * @param array<string, mixed> $params Query parameters
     * @return array{headers: array<int, string>, rows: array<int, array<int, mixed>>}
     */
    public static function getExportData(object $u, string $view, array $params = []): array
    {
        $allowedClients = Scope::clientIds($u);
        if (empty($allowedClients)) {
            return ['headers' => self::getHeaders($view), 'rows' => []];
        }

        if ($view === 'calendar') {
            return self::getCalendarExport($u, $allowedClients, $params);
        }

        $query = self::buildQuery($u, $view, $allowedClients, $params);
        $sortBy = is_string($params['sort_by'] ?? null) ? trim((string) $params['sort_by']) : '';
        $sortDir = is_string($params['sort_dir'] ?? null) && strtolower(trim((string) $params['sort_dir'])) === 'desc' ? 'desc' : 'asc';
        self::applySorting($query, $view, $sortBy, $sortDir);

        $rows = $query->limit(5000)->get();
        if ($view === 'returns') {
            self::enrichReturnsWithReceipts((int) $u->office_id, $rows);
        }
        $headers = self::getHeaders($view);
        $exportRows = [];

        foreach ($rows as $r) {
            $exportRows[] = self::rowToExportArray($view, $r);
        }

        return [
            'headers' => $headers,
            'rows' => $exportRows,
        ];
    }

    public static function getHeaders(string $view): array
    {
        return match ($view) {
            'missing_returns' => [
                'Adózó neve',
                'Adószám',
                'Bevallás',
                'Bevallás megnevezése',
                'Időszak',
                'Eredeti esedékesség',
            ],
            'returns' => [
                'Vonalkód',
                'Adózó neve',
                'Adószáma',
                'Bevallás',
                'Kezdete',
                'Vége',
                'Befogadás dátuma',
                'Hibaüzenet dátuma',
                'Funkció',
                'Státusz',
            ],
            'insured' => [
                'Adózó',
                'Név',
                'Adóazonosító jel',
                'TAJ szám',
                'Jogviszony kezdete',
                'Jogviszony',
                'Heti óra',
            ],
            'employers' => [
                'Adózó',
                'Foglalkoztató neve',
                'Foglalkoztató adószáma',
                'Foglalkoztató adóazonosítója',
                'Jogviszony kezdete',
                'Jogviszony',
                'Heti óra',
            ],
            'efo_declarations' => [
                'Adózó',
                'Név',
                'Adóazonosító',
                'TAJ',
                'Bejelentés',
                'Foglalkoztatás',
                'Kezdő nap',
                'Záró nap',
                'Ikt. szám',
                'Állapot',
                'Bejelentés típusa',
                'Benyújtva',
                'Sorszám',
            ],
            'efo_quotas' => [
                'Adózó',
                'Év',
                'Munkavállaló neve',
                'Adóazonosító',
                'TAJ',
                'Foglalkoztatás jellege',
                'Összes keret (nap)',
                'Felhasznált napok',
                'Hátralévő napok',
            ],
            'reconciliations' => [
                'Adózó neve',
                'Adószám',
                'Adategyeztető neve',
                'Státusz',
                'Létrehozva',
                'Beküldve',
            ],
            'calendar' => [
                'Adózó neve',
                'Adószám',
                'Január',
                'Február',
                'Március',
                'Április',
                'Május',
                'Június',
                'Július',
                'Augusztus',
                'Szeptember',
                'Október',
                'November',
                'December',
            ],
            default => [],
        };
    }

    private static function buildQuery(object $u, string $view, array $allowedClients, array $params)
    {
        $search = is_string($params['search'] ?? null) ? trim((string) $params['search']) : '';
        $clientId = !empty($params['client_id']) && is_numeric($params['client_id']) ? (int) $params['client_id'] : null;
        $status = is_string($params['status'] ?? null) ? trim((string) $params['status']) : '';
        $year = !empty($params['year']) && is_numeric($params['year']) ? (int) $params['year'] : null;

        return match ($view) {
            'missing_returns' => self::queryMissingReturns($u, $allowedClients, $search, $clientId, $year),
            'returns' => self::queryReturns($u, $allowedClients, $search, $clientId, $status, $year),
            'insured' => self::queryInsured($u, $allowedClients, $search, $clientId, $status),
            'employers' => self::queryEmployers($u, $allowedClients, $search, $clientId, $status),
            'efo_declarations' => self::queryEfoDeclarations($u, $allowedClients, $search, $clientId, $status, $year),
            'efo_quotas' => self::queryEfoQuotas($u, $allowedClients, $search, $clientId, $year),
            'reconciliations' => self::queryReconciliations($u, $allowedClients, $search, $clientId, $status),
            default => self::queryMissingReturns($u, $allowedClients, $search, $clientId, $year),
        };
    }

    private static function queryMissingReturns(object $u, array $allowedClients, string $search, ?int $clientId, ?int $year)
    {
        $q = DB::table('tax_obligations')
            ->join('clients', 'clients.id', '=', 'tax_obligations.client_id')
            ->where('tax_obligations.office_id', $u->office_id)
            ->whereIn('tax_obligations.client_id', $allowedClients)
            ->where('tax_obligations.status', 'missing')
            ->select([
                'tax_obligations.id',
                'tax_obligations.client_id',
                'clients.name as client_name',
                'clients.tax as client_tax',
                'tax_obligations.form_code',
                'tax_obligations.title',
                'tax_obligations.period_start',
                'tax_obligations.period_end',
                'tax_obligations.due_date',
                'tax_obligations.status',
            ]);

        if ($clientId) {
            $q->where('tax_obligations.client_id', $clientId);
        }
        if ($year) {
            $q->whereYear('tax_obligations.due_date', $year);
        }
        if ($search !== '') {
            $q->where(function ($sub) use ($search) {
                $sub->where('clients.name', 'like', "%{$search}%")
                    ->orWhere('clients.tax', 'like', "%{$search}%")
                    ->orWhere('tax_obligations.form_code', 'like', "%{$search}%")
                    ->orWhere('tax_obligations.title', 'like', "%{$search}%");
            });
        }

        return $q;
    }

    private static function queryReturns(object $u, array $allowedClients, string $search, ?int $clientId, string $status, ?int $year)
    {
        $q = DB::table('nav_returns')
            ->join('clients', 'clients.id', '=', 'nav_returns.client_id')
            ->where('nav_returns.office_id', $u->office_id)
            ->whereIn('nav_returns.client_id', $allowedClients)
            ->select([
                'nav_returns.id',
                'nav_returns.client_id',
                'clients.name as client_name',
                'clients.tax as client_tax',
                'nav_returns.reg_no',
                'nav_returns.barcode',
                'nav_returns.form_code',
                'nav_returns.title',
                'nav_returns.period_from',
                'nav_returns.period_to',
                'nav_returns.submitted_at',
                'nav_returns.accepted_at',
                'nav_returns.error_at',
                'nav_returns.state',
                'nav_returns.kind',
            ]);

        if ($clientId) {
            $q->where('nav_returns.client_id', $clientId);
        }
        if ($status !== '') {
            $q->where('nav_returns.state', $status);
        }
        if ($year) {
            $q->where(function ($sub) use ($year) {
                $sub->whereYear('nav_returns.period_from', $year)
                    ->orWhereYear('nav_returns.period_to', $year)
                    ->orWhere('nav_returns.submitted_at', 'like', "{$year}%");
            });
        }
        if ($search !== '') {
            $q->where(function ($sub) use ($search) {
                $sub->where('clients.name', 'like', "%{$search}%")
                    ->orWhere('clients.tax', 'like', "%{$search}%")
                    ->orWhere('nav_returns.reg_no', 'like', "%{$search}%")
                    ->orWhere('nav_returns.barcode', 'like', "%{$search}%")
                    ->orWhere('nav_returns.form_code', 'like', "%{$search}%")
                    ->orWhere('nav_returns.title', 'like', "%{$search}%")
                    ->orWhere('nav_returns.kind', 'like', "%{$search}%")
                    ->orWhere('nav_returns.state', 'like', "%{$search}%");
            });
        }

        return $q;
    }

    private static function queryInsured(object $u, array $allowedClients, string $search, ?int $clientId, string $status)
    {
        $q = DB::table('nav_insured_persons')
            ->join('clients', 'clients.id', '=', 'nav_insured_persons.client_id')
            ->where('nav_insured_persons.office_id', $u->office_id)
            ->whereIn('nav_insured_persons.client_id', $allowedClients)
            ->select([
                'nav_insured_persons.id',
                'nav_insured_persons.client_id',
                'clients.name as client_name',
                'clients.tax as client_tax',
                'nav_insured_persons.name',
                'nav_insured_persons.tax_id',
                'nav_insured_persons.taj',
                'nav_insured_persons.relationship_start',
                'nav_insured_persons.relationship_end',
                'nav_insured_persons.relationship_type',
                'nav_insured_persons.weekly_hours',
                'nav_insured_persons.status',
            ]);

        if ($clientId) {
            $q->where('nav_insured_persons.client_id', $clientId);
        }
        if ($status !== '') {
            $q->where('nav_insured_persons.status', $status);
        }
        if ($search !== '') {
            $q->where(function ($sub) use ($search) {
                $sub->where('clients.name', 'like', "%{$search}%")
                    ->orWhere('nav_insured_persons.name', 'like', "%{$search}%")
                    ->orWhere('nav_insured_persons.tax_id', 'like', "%{$search}%")
                    ->orWhere('nav_insured_persons.taj', 'like', "%{$search}%")
                    ->orWhere('nav_insured_persons.relationship_type', 'like', "%{$search}%");
            });
        }

        return $q;
    }

    private static function queryEmployers(object $u, array $allowedClients, string $search, ?int $clientId, string $status)
    {
        $q = DB::table('nav_employers')
            ->join('clients', 'clients.id', '=', 'nav_employers.client_id')
            ->where('nav_employers.office_id', $u->office_id)
            ->whereIn('nav_employers.client_id', $allowedClients)
            ->select([
                'nav_employers.id',
                'nav_employers.client_id',
                'clients.name as client_name',
                'clients.tax as client_tax',
                'nav_employers.employer_name',
                'nav_employers.employer_tax_number',
                'nav_employers.employer_tax_id',
                'nav_employers.relationship_start',
                'nav_employers.relationship_end',
                'nav_employers.relationship_type',
                'nav_employers.weekly_hours',
                'nav_employers.status',
            ]);

        if ($clientId) {
            $q->where('nav_employers.client_id', $clientId);
        }
        if ($status !== '') {
            $q->where('nav_employers.status', $status);
        }
        if ($search !== '') {
            $q->where(function ($sub) use ($search) {
                $sub->where('clients.name', 'like', "%{$search}%")
                    ->orWhere('nav_employers.employer_name', 'like', "%{$search}%")
                    ->orWhere('nav_employers.employer_tax_number', 'like', "%{$search}%")
                    ->orWhere('nav_employers.employer_tax_id', 'like', "%{$search}%")
                    ->orWhere('nav_employers.relationship_type', 'like', "%{$search}%");
            });
        }

        return $q;
    }

    private static function queryEfoDeclarations(object $u, array $allowedClients, string $search, ?int $clientId, string $status, ?int $year)
    {
        $q = DB::table('nav_efo_declarations')
            ->join('clients', 'clients.id', '=', 'nav_efo_declarations.client_id')
            ->where('nav_efo_declarations.office_id', $u->office_id)
            ->whereIn('nav_efo_declarations.client_id', $allowedClients)
            ->select([
                'nav_efo_declarations.id',
                'nav_efo_declarations.client_id',
                'clients.name as client_name',
                'clients.tax as client_tax',
                'nav_efo_declarations.employee_name',
                'nav_efo_declarations.employee_tax_id',
                'nav_efo_declarations.employee_taj',
                'nav_efo_declarations.declaration_code',
                'nav_efo_declarations.employment_type',
                'nav_efo_declarations.start_date',
                'nav_efo_declarations.end_date',
                'nav_efo_declarations.days_count',
                'nav_efo_declarations.reg_no',
                'nav_efo_declarations.status',
                'nav_efo_declarations.filing_type',
                'nav_efo_declarations.submitted_at',
                'nav_efo_declarations.seq_no',
            ]);

        if ($clientId) {
            $q->where('nav_efo_declarations.client_id', $clientId);
        }
        if ($status !== '') {
            $q->where('nav_efo_declarations.status', $status);
        }
        if ($year) {
            $q->where(function ($sub) use ($year) {
                $sub->whereYear('nav_efo_declarations.start_date', $year)
                    ->orWhereYear('nav_efo_declarations.end_date', $year);
            });
        }
        if ($search !== '') {
            $q->where(function ($sub) use ($search) {
                $sub->where('clients.name', 'like', "%{$search}%")
                    ->orWhere('nav_efo_declarations.employee_name', 'like', "%{$search}%")
                    ->orWhere('nav_efo_declarations.employee_tax_id', 'like', "%{$search}%")
                    ->orWhere('nav_efo_declarations.employee_taj', 'like', "%{$search}%")
                    ->orWhere('nav_efo_declarations.declaration_code', 'like', "%{$search}%")
                    ->orWhere('nav_efo_declarations.reg_no', 'like', "%{$search}%");
            });
        }

        return $q;
    }

    private static function queryEfoQuotas(object $u, array $allowedClients, string $search, ?int $clientId, ?int $year)
    {
        $q = DB::table('nav_efo_quotas')
            ->join('clients', 'clients.id', '=', 'nav_efo_quotas.client_id')
            ->where('nav_efo_quotas.office_id', $u->office_id)
            ->whereIn('nav_efo_quotas.client_id', $allowedClients)
            ->select([
                'nav_efo_quotas.id',
                'nav_efo_quotas.client_id',
                'clients.name as client_name',
                'clients.tax as client_tax',
                'nav_efo_quotas.year',
                'nav_efo_quotas.employee_name',
                'nav_efo_quotas.employee_tax_id',
                'nav_efo_quotas.employee_taj',
                'nav_efo_quotas.employment_type',
                'nav_efo_quotas.quota_limit',
                'nav_efo_quotas.used_days',
                'nav_efo_quotas.remaining_days',
            ]);

        if ($clientId) {
            $q->where('nav_efo_quotas.client_id', $clientId);
        }
        if ($year) {
            $q->where('nav_efo_quotas.year', $year);
        }
        if ($search !== '') {
            $q->where(function ($sub) use ($search) {
                $sub->where('clients.name', 'like', "%{$search}%")
                    ->orWhere('nav_efo_quotas.employee_name', 'like', "%{$search}%")
                    ->orWhere('nav_efo_quotas.employee_tax_id', 'like', "%{$search}%")
                    ->orWhere('nav_efo_quotas.employee_taj', 'like', "%{$search}%");
            });
        }

        return $q;
    }

    private static function queryReconciliations(object $u, array $allowedClients, string $search, ?int $clientId, string $status)
    {
        $q = DB::table('nav_reconciliations')
            ->join('clients', 'clients.id', '=', 'nav_reconciliations.client_id')
            ->where('nav_reconciliations.office_id', $u->office_id)
            ->whereIn('nav_reconciliations.client_id', $allowedClients)
            ->select([
                'nav_reconciliations.id',
                'nav_reconciliations.client_id',
                'clients.name as client_name',
                'clients.tax as client_tax',
                'nav_reconciliations.reconciler_name',
                'nav_reconciliations.status',
                'nav_reconciliations.case_number',
                'nav_reconciliations.created_date',
                'nav_reconciliations.submitted_date',
                'nav_reconciliations.notes',
            ]);

        if ($clientId) {
            $q->where('nav_reconciliations.client_id', $clientId);
        }
        if ($status !== '') {
            $q->where('nav_reconciliations.status', $status);
        }
        if ($search !== '') {
            $q->where(function ($sub) use ($search) {
                $sub->where('clients.name', 'like', "%{$search}%")
                    ->orWhere('clients.tax', 'like', "%{$search}%")
                    ->orWhere('nav_reconciliations.reconciler_name', 'like', "%{$search}%")
                    ->orWhere('nav_reconciliations.case_number', 'like', "%{$search}%")
                    ->orWhere('nav_reconciliations.notes', 'like', "%{$search}%");
            });
        }

        return $q;
    }

    private static function resolveSortColumn(string $view, string $sortBy): ?string
    {
        $primaryTable = match ($view) {
            'missing_returns' => 'tax_obligations',
            'returns' => 'nav_returns',
            'insured' => 'nav_insured_persons',
            'employers' => 'nav_employers',
            'efo_declarations' => 'nav_efo_declarations',
            'efo_quotas' => 'nav_efo_quotas',
            'reconciliations' => 'nav_reconciliations',
            default => null,
        };

        if ($primaryTable === null) {
            return null;
        }

        $commonMap = [
            'id' => $primaryTable . '.id',
            'client_id' => $primaryTable . '.client_id',
            'client_name' => 'clients.name',
            'client_tax' => 'clients.tax',
        ];

        $viewMaps = [
            'missing_returns' => [
                'form_code' => 'tax_obligations.form_code',
                'title' => 'tax_obligations.title',
                'period_start' => 'tax_obligations.period_start',
                'period_end' => 'tax_obligations.period_end',
                'due_date' => 'tax_obligations.due_date',
                'status' => 'tax_obligations.status',
            ],
            'returns' => [
                'reg_no' => 'nav_returns.reg_no',
                'barcode' => 'nav_returns.barcode',
                'form_code' => 'nav_returns.form_code',
                'title' => 'nav_returns.title',
                'period_from' => 'nav_returns.period_from',
                'period_to' => 'nav_returns.period_to',
                'submitted_at' => 'nav_returns.submitted_at',
                'accepted_at' => 'nav_returns.accepted_at',
                'error_at' => 'nav_returns.error_at',
                'state' => 'nav_returns.state',
                'kind' => 'nav_returns.kind',
            ],
            'insured' => [
                'name' => 'nav_insured_persons.name',
                'tax_id' => 'nav_insured_persons.tax_id',
                'taj' => 'nav_insured_persons.taj',
                'relationship_start' => 'nav_insured_persons.relationship_start',
                'relationship_end' => 'nav_insured_persons.relationship_end',
                'relationship_type' => 'nav_insured_persons.relationship_type',
                'weekly_hours' => 'nav_insured_persons.weekly_hours',
                'status' => 'nav_insured_persons.status',
            ],
            'employers' => [
                'name' => 'nav_employers.employer_name',
                'employer_name' => 'nav_employers.employer_name',
                'employer_tax_number' => 'nav_employers.employer_tax_number',
                'employer_tax_id' => 'nav_employers.employer_tax_id',
                'relationship_start' => 'nav_employers.relationship_start',
                'relationship_end' => 'nav_employers.relationship_end',
                'relationship_type' => 'nav_employers.relationship_type',
                'weekly_hours' => 'nav_employers.weekly_hours',
                'status' => 'nav_employers.status',
            ],
            'efo_declarations' => [
                'name' => 'nav_efo_declarations.employee_name',
                'employee_name' => 'nav_efo_declarations.employee_name',
                'employee_tax_id' => 'nav_efo_declarations.employee_tax_id',
                'employee_taj' => 'nav_efo_declarations.employee_taj',
                'declaration_code' => 'nav_efo_declarations.declaration_code',
                'employment_type' => 'nav_efo_declarations.employment_type',
                'start_date' => 'nav_efo_declarations.start_date',
                'end_date' => 'nav_efo_declarations.end_date',
                'days_count' => 'nav_efo_declarations.days_count',
                'reg_no' => 'nav_efo_declarations.reg_no',
                'status' => 'nav_efo_declarations.status',
                'filing_type' => 'nav_efo_declarations.filing_type',
                'submitted_at' => 'nav_efo_declarations.submitted_at',
                'seq_no' => 'nav_efo_declarations.seq_no',
            ],
            'efo_quotas' => [
                'year' => 'nav_efo_quotas.year',
                'name' => 'nav_efo_quotas.employee_name',
                'employee_name' => 'nav_efo_quotas.employee_name',
                'employee_tax_id' => 'nav_efo_quotas.employee_tax_id',
                'employee_taj' => 'nav_efo_quotas.employee_taj',
                'employment_type' => 'nav_efo_quotas.employment_type',
                'quota_limit' => 'nav_efo_quotas.quota_limit',
                'used_days' => 'nav_efo_quotas.used_days',
                'remaining_days' => 'nav_efo_quotas.remaining_days',
            ],
            'reconciliations' => [
                'name' => 'nav_reconciliations.reconciler_name',
                'reconciler_name' => 'nav_reconciliations.reconciler_name',
                'status' => 'nav_reconciliations.status',
                'case_number' => 'nav_reconciliations.case_number',
                'created_date' => 'nav_reconciliations.created_date',
                'submitted_date' => 'nav_reconciliations.submitted_date',
                'notes' => 'nav_reconciliations.notes',
            ],
        ];

        $map = array_merge($commonMap, $viewMaps[$view] ?? []);
        if (isset($map[$sortBy])) {
            return $map[$sortBy];
        }

        // Support already qualified safe column names (e.g. 'clients.name')
        if (in_array($sortBy, array_values($map), true)) {
            return $sortBy;
        }

        // If simple identifier, safely qualify with primary table
        if (preg_match('/^[a-z0-9_]+$/i', $sortBy)) {
            return $primaryTable . '.' . $sortBy;
        }

        return null;
    }

    private static function applySorting($query, string $view, string $sortBy, string $sortDir): void
    {
        $column = $sortBy !== '' ? self::resolveSortColumn($view, $sortBy) : null;

        if ($column === null) {
            match ($view) {
                'missing_returns' => $query->orderBy('tax_obligations.due_date', 'asc')->orderBy('tax_obligations.id', 'asc'),
                'returns' => $query->orderBy('nav_returns.submitted_at', 'desc')->orderBy('nav_returns.id', 'desc'),
                'insured' => $query->orderBy('clients.name', 'asc')->orderBy('nav_insured_persons.name', 'asc'),
                'employers' => $query->orderBy('clients.name', 'asc')->orderBy('nav_employers.employer_name', 'asc'),
                'efo_declarations' => $query->orderBy('nav_efo_declarations.start_date', 'desc')->orderBy('nav_efo_declarations.id', 'desc'),
                'efo_quotas' => $query->orderBy('nav_efo_quotas.year', 'desc')->orderBy('clients.name', 'asc'),
                'reconciliations' => $query->orderBy('nav_reconciliations.created_date', 'desc')->orderBy('nav_reconciliations.id', 'desc'),
                default => $query->orderBy('id', 'desc'),
            };
            return;
        }

        $query->orderBy($column, $sortDir);
    }

    /**
     * Map database stdClass objects null-safely.
     */
    private static function cleanClientTax(?string $tax): string
    {
        $t = trim((string) ($tax ?? ''));
        return str_starts_with($t, 'sajat-') ? '' : $t;
    }

    private static function mapRows(string $view, iterable $rows): array
    {
        $mapped = [];
        foreach ($rows as $r) {
            $mapped[] = match ($view) {
                'missing_returns' => [
                    'id' => (int) ($r->id ?? 0),
                    'client_id' => (int) ($r->client_id ?? 0),
                    'client_name' => (string) ($r->client_name ?? ''),
                    'client_tax' => self::cleanClientTax($r->client_tax ?? null),
                    'form_code' => (string) ($r->form_code ?? ''),
                    'title' => (string) ($r->title ?? ''),
                    'period' => trim(($r->period_start ?? '') . (!empty($r->period_end) ? ' – ' . $r->period_end : '')),
                    'due_date' => (string) ($r->due_date ?? ''),
                    'status' => (string) ($r->status ?? 'missing'),
                ],
                'returns' => [
                    'id' => (int) ($r->id ?? 0),
                    'client_id' => (int) ($r->client_id ?? 0),
                    'barcode' => (string) (($r->barcode ?? null) ?: ($r->reg_no ?? '')),
                    'reg_no' => (string) ($r->reg_no ?? ''),
                    'client_name' => (string) ($r->client_name ?? ''),
                    'client_tax' => self::cleanClientTax($r->client_tax ?? null),
                    'form_code' => (string) ($r->form_code ?? ''),
                    'period_from' => (string) ($r->period_from ?? ''),
                    'period_to' => (string) ($r->period_to ?? ''),
                    'accepted_at' => (string) (($r->accepted_at ?? null) ?: ($r->submitted_at ?? '')),
                    'error_at' => (string) ($r->error_at ?? ''),
                    'kind' => (string) ($r->kind ?? ''),
                    'state' => (string) ($r->state ?? ''),
                ],
                'insured' => [
                    'id' => (int) ($r->id ?? 0),
                    'client_id' => (int) ($r->client_id ?? 0),
                    'client_name' => (string) ($r->client_name ?? ''),
                    'name' => (string) ($r->name ?? ''),
                    'tax_id' => (string) ($r->tax_id ?? ''),
                    'taj' => (string) ($r->taj ?? ''),
                    'relationship_start' => (string) ($r->relationship_start ?? ''),
                    'relationship_end' => (string) ($r->relationship_end ?? ''),
                    'relationship_type' => (string) ($r->relationship_type ?? ''),
                    'weekly_hours' => ($r->weekly_hours ?? null) !== null ? (float) $r->weekly_hours : null,
                    'status' => (string) ($r->status ?? 'active'),
                ],
                'employers' => [
                    'id' => (int) ($r->id ?? 0),
                    'client_id' => (int) ($r->client_id ?? 0),
                    'client_name' => (string) ($r->client_name ?? ''),
                    'employer_name' => (string) ($r->employer_name ?? ''),
                    'employer_tax_number' => (string) ($r->employer_tax_number ?? ''),
                    'employer_tax_id' => (string) ($r->employer_tax_id ?? ''),
                    'relationship_start' => (string) ($r->relationship_start ?? ''),
                    'relationship_end' => (string) ($r->relationship_end ?? ''),
                    'relationship_type' => (string) ($r->relationship_type ?? ''),
                    'weekly_hours' => ($r->weekly_hours ?? null) !== null ? (float) $r->weekly_hours : null,
                    'status' => (string) ($r->status ?? 'active'),
                ],
                'efo_declarations' => [
                    'id' => (int) ($r->id ?? 0),
                    'client_id' => (int) ($r->client_id ?? 0),
                    'client_name' => (string) ($r->client_name ?? ''),
                    'employee_name' => (string) ($r->employee_name ?? ''),
                    'employee_tax_id' => (string) ($r->employee_tax_id ?? ''),
                    'employee_taj' => (string) ($r->employee_taj ?? ''),
                    'declaration_code' => (string) ($r->declaration_code ?? ''),
                    'employment_type' => (string) ($r->employment_type ?? ''),
                    'start_date' => (string) ($r->start_date ?? ''),
                    'end_date' => (string) ($r->end_date ?? ''),
                    'days_count' => (int) ($r->days_count ?? 1),
                    'reg_no' => (string) ($r->reg_no ?? ''),
                    'status' => (string) ($r->status ?? 'Befogadva'),
                    'filing_type' => (string) ($r->filing_type ?? 'Új'),
                    'submitted_at' => (string) ($r->submitted_at ?? ''),
                    'seq_no' => ($r->seq_no ?? null) !== null ? (int) $r->seq_no : null,
                ],
                'efo_quotas' => [
                    'id' => (int) ($r->id ?? 0),
                    'client_id' => (int) ($r->client_id ?? 0),
                    'client_name' => (string) ($r->client_name ?? ''),
                    'year' => (int) ($r->year ?? 0),
                    'employee_name' => (string) (($r->employee_name ?? null) ?: 'Összesített'),
                    'employee_tax_id' => (string) ($r->employee_tax_id ?? ''),
                    'employee_taj' => (string) ($r->employee_taj ?? ''),
                    'employment_type' => (string) ($r->employment_type ?? ''),
                    'quota_limit' => (int) ($r->quota_limit ?? 0),
                    'used_days' => (int) ($r->used_days ?? 0),
                    'remaining_days' => (int) ($r->remaining_days ?? 0),
                ],
                'reconciliations' => [
                    'id' => (int) ($r->id ?? 0),
                    'client_id' => (int) ($r->client_id ?? 0),
                    'client_name' => (string) ($r->client_name ?? ''),
                    'client_tax' => self::cleanClientTax($r->client_tax ?? null),
                    'reconciler_name' => (string) ($r->reconciler_name ?? ''),
                    'status' => (string) ($r->status ?? 'Függőben'),
                    'case_number' => (string) ($r->case_number ?? ''),
                    'created_date' => (string) ($r->created_date ?? ''),
                    'submitted_date' => (string) ($r->submitted_date ?? ''),
                    'notes' => (string) ($r->notes ?? ''),
                ],
                default => (array) $r,
            };
        }
        return $mapped;
    }

    private static function rowToExportArray(string $view, object $r): array
    {
        return match ($view) {
            'missing_returns' => [
                (string) ($r->client_name ?? ''),
                self::cleanClientTax($r->client_tax ?? null),
                (string) ($r->form_code ?? ''),
                (string) ($r->title ?? ''),
                trim(($r->period_start ?? '') . (!empty($r->period_end) ? ' – ' . $r->period_end : '')),
                (string) ($r->due_date ?? ''),
            ],
            'returns' => [
                (string) (($r->barcode ?? null) ?: ($r->reg_no ?? '')),
                (string) ($r->client_name ?? ''),
                self::cleanClientTax($r->client_tax ?? null),
                (string) ($r->form_code ?? ''),
                (string) ($r->period_from ?? ''),
                (string) ($r->period_to ?? ''),
                (string) (($r->accepted_at ?? null) ?: ($r->submitted_at ?? '')),
                (string) ($r->error_at ?? ''),
                (string) ($r->kind ?? ''),
                (string) ($r->state ?? ''),
            ],
            'insured' => [
                (string) ($r->client_name ?? ''),
                (string) ($r->name ?? ''),
                (string) ($r->tax_id ?? ''),
                (string) ($r->taj ?? ''),
                (string) ($r->relationship_start ?? ''),
                (string) ($r->relationship_type ?? ''),
                ($r->weekly_hours ?? null) !== null ? (float) $r->weekly_hours : '',
            ],
            'employers' => [
                (string) ($r->client_name ?? ''),
                (string) ($r->employer_name ?? ''),
                (string) ($r->employer_tax_number ?? ''),
                (string) ($r->employer_tax_id ?? ''),
                (string) ($r->relationship_start ?? ''),
                (string) ($r->relationship_type ?? ''),
                ($r->weekly_hours ?? null) !== null ? (float) $r->weekly_hours : '',
            ],
            'efo_declarations' => [
                (string) ($r->client_name ?? ''),
                (string) ($r->employee_name ?? ''),
                (string) ($r->employee_tax_id ?? ''),
                (string) ($r->employee_taj ?? ''),
                (string) ($r->declaration_code ?? ''),
                (string) ($r->employment_type ?? ''),
                (string) ($r->start_date ?? ''),
                (string) ($r->end_date ?? ''),
                (string) ($r->reg_no ?? ''),
                (string) ($r->status ?? 'Befogadva'),
                (string) ($r->filing_type ?? 'Új'),
                (string) ($r->submitted_at ?? ''),
                ($r->seq_no ?? null) !== null ? (int) $r->seq_no : '',
            ],
            'efo_quotas' => [
                (string) ($r->client_name ?? ''),
                (int) ($r->year ?? 0),
                (string) (($r->employee_name ?? null) ?: 'Összesített'),
                (string) ($r->employee_tax_id ?? ''),
                (string) ($r->employee_taj ?? ''),
                (string) ($r->employment_type ?? ''),
                (int) ($r->quota_limit ?? 0),
                (int) ($r->used_days ?? 0),
                (int) ($r->remaining_days ?? 0),
            ],
            'reconciliations' => [
                (string) ($r->client_name ?? ''),
                self::cleanClientTax($r->client_tax ?? null),
                (string) ($r->reconciler_name ?? ''),
                (string) ($r->status ?? 'Függőben'),
                (string) ($r->created_date ?? ''),
                (string) ($r->submitted_date ?? ''),
            ],
            default => array_values((array) $r),
        };
    }

    private static function queryCalendarClients(object $u, array $allowedClients, ?int $clientId, string $search, int $year)
    {
        $clientQuery = DB::table('clients')
            ->where('office_id', $u->office_id)
            ->whereIn('id', $allowedClients);

        if ($clientId) {
            $clientQuery->where('id', $clientId);
        }
        if ($search !== '') {
            $like = "%{$search}%";
            $clientQuery->where(function ($sub) use ($u, $like, $year) {
                $sub->where('name', 'like', $like)
                    ->orWhere('tax', 'like', $like)
                    ->orWhereExists(function ($q) use ($u, $like, $year) {
                        $q->selectRaw('1')
                            ->from('tax_obligations')
                            ->whereColumn('tax_obligations.client_id', 'clients.id')
                            ->where('tax_obligations.office_id', $u->office_id)
                            ->whereYear('tax_obligations.due_date', $year)
                            ->where(fn ($w) => $w->where('tax_obligations.form_code', 'like', $like)->orWhere('tax_obligations.title', 'like', $like));
                    })
                    ->orWhereExists(function ($q) use ($u, $like, $year) {
                        $q->selectRaw('1')
                            ->from('nav_returns')
                            ->whereColumn('nav_returns.client_id', 'clients.id')
                            ->where('nav_returns.office_id', $u->office_id)
                            ->where('nav_returns.submitted_at', 'like', "{$year}-%")
                            ->where(fn ($w) => $w->where('nav_returns.form_code', 'like', $like)->orWhere('nav_returns.title', 'like', $like));
                    });
            });
        }

        return $clientQuery;
    }

    /**
     * Összefésüli az adónaptár-kötelezettségeket (`tax_obligations`) és a ténylegesen benyújtott bevallásokat (`nav_returns`)
     * tárgyév és hónap (1..12) szerint, hogy a múltbeli hónapok beadott bevallásai és a jövőbeli esedékességek együtt látsszanak.
     *
     * @param array<int, object> $clients
     * @return array<int, array<int, array<int, array<string, mixed>>>>
     */
    private static function collectCalendarItems(int $officeId, array $clients, int $year, string $statusFilter, string $search): array
    {
        $raw = [];
        $clientMatchedDirect = [];
        $needle = mb_strtolower($search);

        foreach ($clients as $c) {
            $cid = (int) ($c->id ?? 0);
            $raw[$cid] = array_fill(1, 12, []);
            if ($needle === '') {
                $clientMatchedDirect[$cid] = true;
            } else {
                $hay = mb_strtolower((string) ($c->name ?? '') . ' ' . (string) ($c->tax ?? ''));
                $clientMatchedDirect[$cid] = str_contains($hay, $needle);
            }
        }

        if (empty($raw)) {
            return [];
        }

        $cids = array_keys($raw);

        $obligations = DB::table('tax_obligations')
            ->where('office_id', $officeId)
            ->whereIn('client_id', $cids)
            ->whereYear('due_date', $year)
            ->orderBy('due_date')
            ->orderBy('id')
            ->get();

        foreach ($obligations as $ob) {
            $cid = (int) ($ob->client_id ?? 0);
            if (!isset($raw[$cid])) {
                continue;
            }
            $due = (string) ($ob->due_date ?? '');
            $month = (int) substr($due, 5, 2);
            if ($month < 1 || $month > 12) {
                continue;
            }
            $stRaw = (string) ($ob->status ?? 'unknown');
            $st = $stRaw === 'rejected' ? 'missing' : (in_array($stRaw, ['submittable', 'missing', 'submitted', 'conditional', 'unknown'], true) ? $stRaw : 'unknown');
            $period = trim((string) ($ob->period_start ?? '') . (!empty($ob->period_end) ? ' – ' . $ob->period_end : ''));
            $raw[$cid][$month][] = [
                'id' => (int) ($ob->id ?? 0),
                'source' => 'obligation',
                'form_code' => (string) ($ob->form_code ?? ''),
                'title' => (string) ($ob->title ?? ''),
                'period' => $period,
                'due_date' => $due,
                'submitted_at' => (string) ($ob->submitted_at ?? ''),
                'reg_no' => (string) ($ob->barcode ?? ''),
                'kind' => '',
                'status' => $st,
                '_consumed' => false,
            ];
        }

        if (\Illuminate\Support\Facades\Schema::hasTable('nav_returns')) {
            $returns = DB::table('nav_returns')
                ->where('office_id', $officeId)
                ->whereIn('client_id', $cids)
                ->where(function ($q) use ($year) {
                    $q->where('submitted_at', 'like', "{$year}-%")
                        ->orWhere(function ($q2) use ($year) {
                            $q2->where(fn ($w) => $w->whereNull('submitted_at')->orWhere('submitted_at', ''))
                                ->where('period_to', 'like', "{$year}-%");
                        });
                })
                ->orderBy('submitted_at')
                ->orderBy('id')
                ->get();

            foreach ($returns as $ret) {
                $cid = (int) ($ret->client_id ?? 0);
                if (!isset($raw[$cid])) {
                    continue;
                }
                $stateStr = (string) ($ret->state ?? '');
                if (preg_match('/törölt|torolt/iu', $stateStr)) {
                    continue;
                }
                $dateRef = trim((string) (($ret->submitted_at ?? null) ?: ($ret->period_to ?? '')));
                if ((int) substr($dateRef, 0, 4) !== $year) {
                    continue;
                }
                $month = (int) substr($dateRef, 5, 2);
                if ($month < 1 || $month > 12) {
                    continue;
                }

                $code = (string) ($ret->form_code ?? '');
                $codeUp = mb_strtoupper(trim($code));
                $retSt = preg_match('/hib[aá]s|elutas[ií]t/iu', $stateStr) ? 'missing' : 'submitted';
                $period = trim((string) ($ret->period_from ?? '') . (!empty($ret->period_to) ? ' – ' . $ret->period_to : ''));
                $subAt = substr((string) ($ret->submitted_at ?? ''), 0, 16);
                $regNo = (string) (($ret->barcode ?? null) ?: ($ret->reg_no ?? ''));
                $kind = (string) ($ret->kind ?? '');

                $merged = false;
                foreach ($raw[$cid][$month] as &$existing) {
                    if ($existing['source'] === 'obligation' && !$existing['_consumed'] && $codeUp !== '' && mb_strtoupper($existing['form_code']) === $codeUp) {
                        if ($retSt === 'submitted') {
                            $existing['status'] = 'submitted';
                        }
                        if ($existing['submitted_at'] === '' && $subAt !== '') {
                            $existing['submitted_at'] = $subAt;
                        }
                        if ($existing['period'] === '' && $period !== '') {
                            $existing['period'] = $period;
                        }
                        if ($existing['reg_no'] === '' && $regNo !== '') {
                            $existing['reg_no'] = $regNo;
                        }
                        if ($existing['title'] === '' && !empty($ret->title)) {
                            $existing['title'] = (string) $ret->title;
                        }
                        $existing['kind'] = $kind;
                        $existing['_consumed'] = true;
                        $merged = true;
                        break;
                    }
                }
                unset($existing);

                if (!$merged) {
                    $raw[$cid][$month][] = [
                        'id' => 'r' . (int) ($ret->id ?? 0),
                        'source' => 'return',
                        'form_code' => $code,
                        'title' => (string) ($ret->title ?? ''),
                        'period' => $period,
                        'due_date' => '',
                        'submitted_at' => $subAt,
                        'reg_no' => $regNo,
                        'kind' => $kind,
                        'status' => $retSt,
                        '_consumed' => true,
                    ];
                }
            }
        }

        $filtered = [];
        foreach ($raw as $cid => $months) {
            $filtered[$cid] = array_fill(1, 12, []);
            $matchAllItems = $clientMatchedDirect[$cid] ?? true;
            for ($m = 1; $m <= 12; $m++) {
                foreach ($months[$m] as $it) {
                    unset($it['_consumed']);
                    if ($statusFilter !== '' && $it['status'] !== $statusFilter) {
                        continue;
                    }
                    if (!$matchAllItems && $needle !== '') {
                        $ih = mb_strtolower($it['form_code'] . ' ' . $it['title']);
                        if (!str_contains($ih, $needle)) {
                            continue;
                        }
                    }
                    $filtered[$cid][$m][] = $it;
                }
            }
        }

        return $filtered;
    }

    private static function getCalendarMatrix(object $u, array $allowedClients, array $params, int $page, int $perPage): array
    {
        $year = !empty($params['year']) && is_numeric($params['year']) ? (int) $params['year'] : (int) date('Y');
        $search = is_string($params['search'] ?? null) ? trim((string) $params['search']) : '';
        $clientId = !empty($params['client_id']) && is_numeric($params['client_id']) ? (int) $params['client_id'] : null;
        $statusFilter = is_string($params['status'] ?? null) ? trim((string) $params['status']) : '';

        $clientQuery = self::queryCalendarClients($u, $allowedClients, $clientId, $search, $year);
        $totalClients = $clientQuery->count();
        $offset = ($page - 1) * $perPage;
        $clients = $clientQuery->orderBy('name')->offset($offset)->limit($perPage)->get()->all();
        $calItems = self::collectCalendarItems((int) $u->office_id, $clients, $year, $statusFilter, $search);

        $clientMap = [];
        foreach ($clients as $c) {
            $cid = (int) ($c->id ?? 0);
            $monthsOut = [];
            for ($m = 1; $m <= 12; $m++) {
                $summary = [
                    'submittable' => 0,
                    'missing' => 0,
                    'submitted' => 0,
                    'conditional' => 0,
                    'unknown' => 0,
                ];
                $mItems = $calItems[$cid][$m] ?? [];
                foreach ($mItems as $it) {
                    $st = $it['status'] ?? 'unknown';
                    if (!isset($summary[$st])) {
                        $st = 'unknown';
                    }
                    $summary[$st]++;
                }
                $monthsOut[$m] = [
                    'items' => $mItems,
                    'summary' => $summary,
                ];
            }
            $clientMap[$cid] = [
                'client_id' => $cid,
                'client_name' => (string) ($c->name ?? ''),
                'client_tax' => self::cleanClientTax($c->tax ?? null),
                'months' => $monthsOut,
            ];
        }

        return [
            'items' => array_values($clientMap),
            'total' => $totalClients,
            'page' => $page,
            'per_page' => $perPage,
            'year' => $year,
            'years' => self::getYears($u),
            'clients' => self::getClients($u, $allowedClients),
            'sync_supported' => true,
        ];
    }

    private static function getCalendarExport(object $u, array $allowedClients, array $params): array
    {
        $year = !empty($params['year']) && is_numeric($params['year']) ? (int) $params['year'] : (int) date('Y');
        $search = is_string($params['search'] ?? null) ? trim((string) $params['search']) : '';
        $clientId = !empty($params['client_id']) && is_numeric($params['client_id']) ? (int) $params['client_id'] : null;
        $statusFilter = is_string($params['status'] ?? null) ? trim((string) $params['status']) : '';

        $clients = self::queryCalendarClients($u, $allowedClients, $clientId, $search, $year)
            ->orderBy('name')
            ->limit(500)
            ->get()
            ->all();
        $calItems = self::collectCalendarItems((int) $u->office_id, $clients, $year, $statusFilter, $search);

        $exportRows = [];
        foreach ($clients as $c) {
            $cid = (int) ($c->id ?? 0);
            $row = [
                (string) ($c->name ?? ''),
                self::cleanClientTax($c->tax ?? null),
            ];
            for ($m = 1; $m <= 12; $m++) {
                $labels = [];
                foreach ($calItems[$cid][$m] ?? [] as $it) {
                    $stBadge = match ($it['status'] ?? '') {
                        'submitted' => 'Beadva',
                        'missing' => 'Hiányzó',
                        'submittable' => 'Beadható',
                        'conditional' => 'Feltételes',
                        default => 'Ismeretlen',
                    };
                    $labels[] = ($it['form_code'] ?: '–') . ' (' . $stBadge . ')';
                }
                $row[] = !empty($labels) ? implode(', ', $labels) : '-';
            }
            $exportRows[] = $row;
        }

        return [
            'headers' => self::getHeaders('calendar'),
            'rows' => $exportRows,
        ];
    }

    public static function getYears(object $u): array
    {
        $allowed = Scope::clientIds($u);
        if (empty($allowed)) {
            return [(int) date('Y')];
        }

        $y1 = DB::table('tax_obligations')
            ->where('office_id', $u->office_id)
            ->whereIn('client_id', $allowed)
            ->whereNotNull('due_date')
            ->selectRaw('distinct cast(strftime("%Y", due_date) as integer) as yr')
            ->pluck('yr')
            ->filter()
            ->all();

        $y2 = DB::table('nav_efo_quotas')
            ->where('office_id', $u->office_id)
            ->whereIn('client_id', $allowed)
            ->distinct()
            ->pluck('year')
            ->filter()
            ->all();

        $y3 = \Illuminate\Support\Facades\Schema::hasTable('nav_returns')
            ? DB::table('nav_returns')
                ->where('office_id', $u->office_id)
                ->whereIn('client_id', $allowed)
                ->whereNotNull('submitted_at')
                ->where('submitted_at', '!=', '')
                ->selectRaw('distinct cast(substr(submitted_at, 1, 4) as integer) as yr')
                ->pluck('yr')
                ->filter(fn ($y) => $y >= 2000 && $y <= 2100)
                ->all()
            : [];

        $allYears = array_unique(array_merge($y1, $y2, $y3, [(int) date('Y'), (int) date('Y') - 1]));
        rsort($allYears);
        return array_values($allYears);
    }

    public static function getClients(object $u, array $allowedClients): array
    {
        return DB::table('clients')
            ->where('office_id', $u->office_id)
            ->whereIn('id', $allowedClients)
            ->orderBy('name')
            ->get(['id', 'name', 'tax'])
            ->map(fn ($c) => [
                'id' => (int) ($c->id ?? 0),
                'name' => (string) ($c->name ?? ''),
                'tax' => (string) ($c->tax ?? ''),
            ])
            ->all();
    }

    /**
     * Összekapcsolja a NAV ÜPO bevallás-sorokat (`nav_returns`) a tárhelyi elfogadó/elutasító nyugtákkal (`messages`)
     * és a NAV-dokumentumok vonalkódjaival (`nav_documents`), hogy a Vonalkód, Befogadás dátuma és Hibaüzenet dátuma
     * mezők élő szinkronból is pontosan kitöltődjenek. Törölt bevalláshoz nem párosít nyugtát.
     */
    public static function enrichReturnsWithReceipts(int $officeId, iterable $rows): void
    {
        $clientIds = [];
        foreach ($rows as $r) {
            $cid = (int) ($r->client_id ?? 0);
            if ($cid > 0) {
                $clientIds[$cid] = $cid;
            }
        }
        if (empty($clientIds)) {
            return;
        }
        $cids = array_values($clientIds);

        $docBarcodeByReg = [];
        foreach (DB::table('nav_documents')
            ->where('office_id', $officeId)
            ->whereIn('client_id', $cids)
            ->whereNotNull('barcode')
            ->whereNotNull('reg_no')
            ->get(['client_id', 'barcode', 'reg_no']) as $doc) {
            $dcid = (int) ($doc->client_id ?? 0);
            $dreg = trim((string) ($doc->reg_no ?? ''));
            $dbc = trim((string) ($doc->barcode ?? ''));
            if ($dcid > 0 && $dreg !== '' && $dbc !== '') {
                $docBarcodeByReg["{$dcid}|{$dreg}"] ??= $dbc;
            }
        }

        $byBarcode = [];
        $byPeriod = [];
        $byPeriodEnd = [];

        $receipts = DB::table('messages')
            ->where('office_id', $officeId)
            ->whereIn('client_id', $cids)
            ->where(fn ($q) => $q->whereNull('folder')->orWhere('folder', '!=', 'ELKULDOTT'))
            ->where(fn ($q) => $q->where('receipt', true)->orWhereIn('type_id', ['nav.nyugta.elfogado', 'nav.nyugta.elutasito']))
            ->orderBy('arrived_at')
            ->get(['id', 'client_id', 'barcode', 'form_code', 'period_from', 'period_to', 'subject', 'type_id', 'arrived_at']);

        foreach ($receipts as $m) {
            $mcid = (int) ($m->client_id ?? 0);
            if ($mcid <= 0) {
                continue;
            }
            $bc = trim((string) ($m->barcode ?? ''));
            $subj = (string) ($m->subject ?? '');
            $typeId = (string) ($m->type_id ?? '');
            $rejected = $typeId === 'nav.nyugta.elutasito'
                || (bool) preg_match('/elutas[ií]t|hiba[üu]zenet|hib[aá]s/iu', $subj);
            $at = substr(trim((string) ($m->arrived_at ?? '')), 0, 16);

            $entry = [
                'barcode' => $bc,
                'rejected' => $rejected,
                'at' => $at,
            ];

            if ($bc !== '') {
                $byBarcode["{$mcid}|{$bc}"][] = $entry;
            }

            $form = mb_strtoupper(trim((string) ($m->form_code ?? '')));
            $pFrom = substr(trim((string) ($m->period_from ?? '')), 0, 10);
            $pTo = substr(trim((string) ($m->period_to ?? '')), 0, 10);

            if (preg_match('/^\s*([0-9A-Za-z][0-9A-Za-z_-]{1,31})\s*,.*?(\d{4})\.(\d{2})\.(\d{2})\.?\s*-\s*(\d{4})\.(\d{2})\.(\d{2})/u', $subj, $x)) {
                if ($form === '') {
                    $form = mb_strtoupper($x[1]);
                }
                if ($pFrom === '') {
                    $pFrom = "{$x[2]}-{$x[3]}-{$x[4]}";
                }
                if ($pTo === '') {
                    $pTo = "{$x[5]}-{$x[6]}-{$x[7]}";
                }
            } elseif ($form === '') {
                $extracted = DeadlineExtractor::extractFormCode($subj);
                if ($extracted) {
                    $form = mb_strtoupper($extracted);
                }
            }

            if ($form !== '' && $pFrom !== '' && $pTo !== '') {
                $byPeriod["{$mcid}|{$form}|{$pFrom}|{$pTo}"][] = $entry;
            }
            if ($form !== '' && $pTo !== '') {
                $byPeriodEnd["{$mcid}|{$form}|{$pTo}"][] = $entry;
            }
        }

        foreach ($rows as $r) {
            if (mb_strtolower(trim((string) ($r->state ?? ''))) === 'törölt') {
                continue;
            }
            $cid = (int) ($r->client_id ?? 0);
            $regNo = trim((string) ($r->reg_no ?? ''));
            $curBc = trim((string) ($r->barcode ?? ''));

            if ($curBc === '' && $regNo !== '' && isset($docBarcodeByReg["{$cid}|{$regNo}"])) {
                $curBc = $docBarcodeByReg["{$cid}|{$regNo}"];
                $r->barcode = $curBc;
            }

            $hits = null;
            if ($curBc !== '' && isset($byBarcode["{$cid}|{$curBc}"])) {
                $hits = $byBarcode["{$cid}|{$curBc}"];
            } elseif ($regNo !== '' && isset($byBarcode["{$cid}|{$regNo}"])) {
                $hits = $byBarcode["{$cid}|{$regNo}"];
            } else {
                $form = mb_strtoupper(trim((string) ($r->form_code ?? '')));
                $pFrom = substr(trim((string) ($r->period_from ?? '')), 0, 10);
                $pTo = substr(trim((string) ($r->period_to ?? '')), 0, 10);
                if ($form !== '' && $pFrom !== '' && $pTo !== '' && isset($byPeriod["{$cid}|{$form}|{$pFrom}|{$pTo}"])) {
                    $hits = $byPeriod["{$cid}|{$form}|{$pFrom}|{$pTo}"];
                } elseif ($form !== '' && $pTo !== '' && isset($byPeriodEnd["{$cid}|{$form}|{$pTo}"])) {
                    $hits = $byPeriodEnd["{$cid}|{$form}|{$pTo}"];
                }
            }

            if ($hits) {
                foreach ($hits as $h) {
                    if (empty($r->barcode) && $h['barcode'] !== '') {
                        $r->barcode = $h['barcode'];
                    }
                    if ($h['rejected']) {
                        if (empty($r->error_at) && $h['at'] !== '') {
                            $r->error_at = $h['at'];
                        }
                    } else {
                        if (empty($r->accepted_at) && $h['at'] !== '') {
                            $r->accepted_at = $h['at'];
                        }
                    }
                }
            }
        }
    }

    /**
     * Pillanatkép-alapú élő NAV ÜPO szinkron mentése egy adott adózóhoz (`client_id`).
     * Ha egy szekció nem-null tömbként érkezik (akár üres `[]`, amikor a NAV szerint 0 tétel van),
     * az adott adózó korábbi `source = 'nav_upo'` sorait lecseréli az élő pillanatképre.
     * Ha egy szekció `null` vagy hiányzik (pl. átmeneti hálózati hiba), a meglévő adatokat érintetlenül hagyja.
     *
     * @param array<string, mixed> $tables
     * @return array{insured_persons: int, employers: int, efo_declarations: int, efo_quotas: int, reconciliations: int}
     */
    public static function syncClientSnapshot(int $officeId, int $clientId, array $tables): array
    {
        if (!isset($tables['insured_persons']) && !empty($tables['insured_xlsx_base64']) && is_string($tables['insured_xlsx_base64'])) {
            $xlsxRows = self::decodeXlsxRows($tables['insured_xlsx_base64']);
            if ($xlsxRows !== null) {
                $tables['insured_persons'] = self::parseInsuredXlsxRows($xlsxRows);
            }
        }

        if (!isset($tables['employers']) && !isset($tables['own_employers']) && !empty($tables['employers_xlsx_base64']) && is_string($tables['employers_xlsx_base64'])) {
            $xlsxRows = self::decodeXlsxRows($tables['employers_xlsx_base64']);
            if ($xlsxRows !== null) {
                $tables['employers'] = self::parseEmployersXlsxRows($xlsxRows);
            }
        }

        if (!isset($tables['efo_quotas']) && !empty($tables['efo_quotas_xlsx_base64']) && is_string($tables['efo_quotas_xlsx_base64'])) {
            $xlsxRows = self::decodeXlsxRows($tables['efo_quotas_xlsx_base64']);
            if ($xlsxRows !== null) {
                $tables['efo_quotas'] = self::parseEfoQuotasXlsxRows($xlsxRows, (int) date('Y'));
            }
        }

        return DB::transaction(function () use ($officeId, $clientId, $tables) {
            $now = now();
            $clean = static function ($v, int $max = 200): ?string {
                if (!is_scalar($v)) {
                    return null;
                }
                $s = ClientDiscovery::clean((string) $v, $max);
                return $s !== '' ? $s : null;
            };
            $normDate = static function ($v): ?string {
                if (!is_scalar($v)) {
                    return null;
                }
                return DeadlineExtractor::normalizeDate((string) $v);
            };

            $counts = [
                'insured_persons' => 0,
                'employers' => 0,
                'efo_declarations' => 0,
                'efo_quotas' => 0,
                'reconciliations' => 0,
            ];

            // 1. Biztosítottak
            if (array_key_exists('insured_persons', $tables) && is_array($tables['insured_persons'])) {
                DB::table('nav_insured_persons')
                    ->where('office_id', $officeId)
                    ->where('client_id', $clientId)
                    ->whereIn('source', ['nav_upo', 'demo'])
                    ->delete();

                foreach (array_slice($tables['insured_persons'], 0, 2000) as $item) {
                    if (!is_array($item)) {
                        continue;
                    }
                    $name = $clean($item['name'] ?? null, 200);
                    if ($name === null) {
                        continue;
                    }
                    $status = in_array($item['status'] ?? '', ['active', 'closed'], true) ? (string) $item['status'] : 'active';
                    DB::table('nav_insured_persons')->insert([
                        'office_id' => $officeId,
                        'client_id' => $clientId,
                        'name' => $name,
                        'tax_id' => $clean($item['tax_id'] ?? null, 10),
                        'taj' => $clean($item['taj'] ?? null, 16),
                        'relationship_start' => $normDate($item['relationship_start'] ?? null),
                        'relationship_end' => $normDate($item['relationship_end'] ?? null),
                        'relationship_type' => $clean($item['relationship_type'] ?? null, 120),
                        'weekly_hours' => isset($item['weekly_hours']) && is_numeric($item['weekly_hours']) ? round((float) $item['weekly_hours'], 2) : null,
                        'status' => $status,
                        'source' => 'nav_upo',
                        'fetched_at' => $now,
                        'created_at' => $now,
                        'updated_at' => $now,
                    ]);
                    $counts['insured_persons']++;
                }
            }

            // 2. Saját foglalkoztatók
            $empList = $tables['employers'] ?? ($tables['own_employers'] ?? null);
            if ((array_key_exists('employers', $tables) || array_key_exists('own_employers', $tables)) && is_array($empList)) {
                DB::table('nav_employers')
                    ->where('office_id', $officeId)
                    ->where('client_id', $clientId)
                    ->whereIn('source', ['nav_upo', 'demo'])
                    ->delete();

                foreach (array_slice($empList, 0, 2000) as $item) {
                    if (!is_array($item)) {
                        continue;
                    }
                    $empName = $clean($item['employer_name'] ?? null, 200);
                    if ($empName === null) {
                        continue;
                    }
                    $status = in_array($item['status'] ?? '', ['active', 'closed'], true) ? (string) $item['status'] : 'active';
                    DB::table('nav_employers')->insert([
                        'office_id' => $officeId,
                        'client_id' => $clientId,
                        'employer_name' => $empName,
                        'employer_tax_number' => $clean($item['employer_tax_number'] ?? null, 16),
                        'employer_tax_id' => $clean($item['employer_tax_id'] ?? null, 10),
                        'relationship_start' => $normDate($item['relationship_start'] ?? null),
                        'relationship_end' => $normDate($item['relationship_end'] ?? null),
                        'relationship_type' => $clean($item['relationship_type'] ?? null, 120),
                        'weekly_hours' => isset($item['weekly_hours']) && is_numeric($item['weekly_hours']) ? round((float) $item['weekly_hours'], 2) : null,
                        'status' => $status,
                        'source' => 'nav_upo',
                        'fetched_at' => $now,
                        'created_at' => $now,
                        'updated_at' => $now,
                    ]);
                    $counts['employers']++;
                }
            }

            // 3. Egyszerűsített foglalkoztatottak – Bejelentések
            if (array_key_exists('efo_declarations', $tables) && is_array($tables['efo_declarations'])) {
                DB::table('nav_efo_declarations')
                    ->where('office_id', $officeId)
                    ->where('client_id', $clientId)
                    ->whereIn('source', ['nav_upo', 'demo'])
                    ->delete();

                foreach (array_slice($tables['efo_declarations'], 0, 2000) as $item) {
                    if (!is_array($item)) {
                        continue;
                    }
                    $empName = $clean($item['employee_name'] ?? null, 200);
                    $startDate = $normDate($item['start_date'] ?? null);
                    if ($empName === null || $startDate === null) {
                        continue;
                    }
                    $endDate = $normDate($item['end_date'] ?? null) ?: $startDate;
                    DB::table('nav_efo_declarations')->insert([
                        'office_id' => $officeId,
                        'client_id' => $clientId,
                        'employee_name' => $empName,
                        'employee_tax_id' => $clean($item['employee_tax_id'] ?? null, 10),
                        'employee_taj' => $clean($item['employee_taj'] ?? null, 16),
                        'declaration_code' => $clean($item['declaration_code'] ?? null, 40),
                        'employment_type' => $clean($item['employment_type'] ?? null, 80),
                        'start_date' => $startDate,
                        'end_date' => $endDate,
                        'days_count' => max(1, (int) ($item['days_count'] ?? 1)),
                        'reg_no' => $clean($item['reg_no'] ?? null, 40),
                        'status' => $clean($item['status'] ?? null, 40) ?: 'Befogadva',
                        'filing_type' => $clean($item['filing_type'] ?? null, 40) ?: 'Új',
                        'submitted_at' => $clean($item['submitted_at'] ?? null, 24),
                        'seq_no' => isset($item['seq_no']) && is_numeric($item['seq_no']) ? (int) $item['seq_no'] : null,
                        'source' => 'nav_upo',
                        'fetched_at' => $now,
                        'created_at' => $now,
                        'updated_at' => $now,
                    ]);
                    $counts['efo_declarations']++;
                }
            }

            // 4. Egyszerűsített foglalkoztatottak – Napkeret
            if (array_key_exists('efo_quotas', $tables) && is_array($tables['efo_quotas'])) {
                $curYear = (int) date('Y');
                $targetYears = [$curYear => $curYear];
                foreach ($tables['efo_quotas'] as $item) {
                    if (is_array($item) && !empty($item['year']) && is_numeric($item['year'])) {
                        $yr = (int) $item['year'];
                        if ($yr >= 2000 && $yr <= 2100) {
                            $targetYears[$yr] = $yr;
                        }
                    }
                }
                DB::table('nav_efo_quotas')
                    ->where('office_id', $officeId)
                    ->where('client_id', $clientId)
                    ->whereIn('year', array_values($targetYears))
                    ->delete();

                foreach (array_slice($tables['efo_quotas'], 0, 2000) as $item) {
                    if (!is_array($item)) {
                        continue;
                    }
                    $yr = !empty($item['year']) && is_numeric($item['year']) ? (int) $item['year'] : $curYear;
                    $empName = $clean($item['employee_name'] ?? null, 200);
                    $empTaxId = $clean($item['employee_tax_id'] ?? null, 10);
                    if ($empName === null && $empTaxId === null && empty($item['employment_type'])) {
                        continue;
                    }
                    DB::table('nav_efo_quotas')->insert([
                        'office_id' => $officeId,
                        'client_id' => $clientId,
                        'year' => $yr,
                        'employee_name' => $empName,
                        'employee_tax_id' => $empTaxId,
                        'employee_taj' => $clean($item['employee_taj'] ?? null, 16),
                        'employment_type' => $clean($item['employment_type'] ?? null, 80),
                        'quota_limit' => max(0, (int) ($item['quota_limit'] ?? 0)),
                        'used_days' => max(0, (int) ($item['used_days'] ?? 0)),
                        'remaining_days' => max(0, (int) ($item['remaining_days'] ?? 0)),
                        'created_at' => $now,
                        'updated_at' => $now,
                    ]);
                    $counts['efo_quotas']++;
                }
            }

            // 5. Adategyeztetések
            if (array_key_exists('reconciliations', $tables) && is_array($tables['reconciliations'])) {
                DB::table('nav_reconciliations')
                    ->where('office_id', $officeId)
                    ->where('client_id', $clientId)
                    ->whereIn('source', ['nav_upo', 'demo'])
                    ->delete();

                foreach (array_slice($tables['reconciliations'], 0, 2000) as $item) {
                    if (!is_array($item)) {
                        continue;
                    }
                    $recName = $clean($item['reconciler_name'] ?? null, 200);
                    if ($recName === null) {
                        continue;
                    }
                    $createdDate = $normDate($item['created_date'] ?? null) ?: date('Y-m-d');
                    $submittedDate = $normDate($item['submitted_date'] ?? null);
                    DB::table('nav_reconciliations')->insert([
                        'office_id' => $officeId,
                        'client_id' => $clientId,
                        'reconciler_name' => $recName,
                        'status' => $clean($item['status'] ?? null, 40) ?: 'Függőben',
                        'case_number' => $clean($item['case_number'] ?? null, 60),
                        'created_date' => $createdDate,
                        'submitted_date' => $submittedDate,
                        'notes' => $clean($item['notes'] ?? null, 500),
                        'source' => 'nav_upo',
                        'fetched_at' => $now,
                        'created_at' => $now,
                        'updated_at' => $now,
                    ]);
                    $counts['reconciliations']++;
                }
            }

            return $counts;
        });
    }

    /** @return array<int, array<int, string>>|null */
    private static function decodeXlsxRows(?string $base64): ?array
    {
        if (!$base64 || strlen($base64) > 15 * 1024 * 1024) {
            return null;
        }
        $bytes = base64_decode($base64, true);
        if (!is_string($bytes) || !XlsxReader::isXlsx(null, $bytes)) {
            return null;
        }
        return XlsxReader::rows($bytes, 2000, 30);
    }

    private static function normHeader(string $h): string
    {
        $map = [
            'á' => 'a', 'é' => 'e', 'í' => 'i', 'ó' => 'o', 'ö' => 'o', 'ő' => 'o', 'ú' => 'u', 'ü' => 'u', 'ű' => 'u',
            'Á' => 'a', 'É' => 'e', 'Í' => 'i', 'Ó' => 'o', 'Ö' => 'o', 'Ő' => 'o', 'Ú' => 'u', 'Ü' => 'u', 'Ű' => 'u',
        ];
        $s = mb_strtolower(strtr(trim($h), $map));
        return trim((string) preg_replace('/[^a-z0-9]+/', ' ', $s));
    }

    private static function formatTaj(?string $raw): ?string
    {
        $d = preg_replace('/\D+/', '', (string) $raw);
        return strlen($d) === 9 ? substr($d, 0, 3) . '-' . substr($d, 3, 3) . '-' . substr($d, 6, 3) : null;
    }

    /**
     * @param array<int, array<int, string>> $rows
     * @return array<int, array<string, mixed>>
     */
    private static function parseInsuredXlsxRows(array $rows): array
    {
        $hdrIdx = null;
        $cols = [];
        foreach (array_slice($rows, 0, 10, true) as $idx => $r) {
            $norm = array_map([self::class, 'normHeader'], $r);
            $joined = implode(' | ', $norm);
            if (str_contains($joined, 'nev') && (str_contains($joined, 'adoazonosito') || str_contains($joined, 'taj') || str_contains($joined, 'jogviszony'))) {
                $hdrIdx = $idx;
                foreach ($norm as $ci => $h) {
                    if (!isset($cols['name']) && (str_contains($h, 'munkavallalo nev') || str_contains($h, 'biztositott nev') || ($h === 'nev' || (str_contains($h, 'nev') && !str_contains($h, 'foglalkoztato') && !str_contains($h, 'megnevezes'))))) {
                        $cols['name'] = $ci;
                    } elseif (!isset($cols['tax_id']) && str_contains($h, 'adoazonosito')) {
                        $cols['tax_id'] = $ci;
                    } elseif (!isset($cols['taj']) && str_contains($h, 'taj')) {
                        $cols['taj'] = $ci;
                    } elseif (!isset($cols['start']) && (str_contains($h, 'kezdet') || str_contains($h, 'kezdo'))) {
                        $cols['start'] = $ci;
                    } elseif (!isset($cols['end']) && (str_contains($h, 'vege') || str_contains($h, 'zaro'))) {
                        $cols['end'] = $ci;
                    } elseif (!isset($cols['hours']) && (str_contains($h, 'ora') || str_contains($h, 'munkaora'))) {
                        $cols['hours'] = $ci;
                    } elseif (!isset($cols['type']) && str_contains($h, 'jogviszony')) {
                        $cols['type'] = $ci;
                    }
                }
                break;
            }
        }
        if ($hdrIdx === null || !isset($cols['name'])) {
            return [];
        }

        $out = [];
        $today = date('Y-m-d');
        foreach (array_slice($rows, $hdrIdx + 1) as $r) {
            $name = trim((string) ($r[$cols['name']] ?? ''));
            if ($name === '') {
                continue;
            }
            $taxRaw = preg_replace('/\D+/', '', (string) ($r[$cols['tax_id'] ?? -1] ?? ''));
            $end = isset($cols['end']) ? DeadlineExtractor::normalizeDate($r[$cols['end']] ?? null) : null;
            $hoursRaw = isset($cols['hours']) ? str_replace(',', '.', preg_replace('/[^0-9.,]/', '', (string) ($r[$cols['hours']] ?? ''))) : '';
            $out[] = [
                'name' => $name,
                'tax_id' => preg_match('/^8\d{9}$/', $taxRaw) ? $taxRaw : null,
                'taj' => isset($cols['taj']) ? self::formatTaj($r[$cols['taj']] ?? null) : null,
                'relationship_start' => isset($cols['start']) ? DeadlineExtractor::normalizeDate($r[$cols['start']] ?? null) : null,
                'relationship_end' => $end,
                'relationship_type' => isset($cols['type']) ? trim((string) ($r[$cols['type']] ?? '')) : null,
                'weekly_hours' => $hoursRaw !== '' && is_numeric($hoursRaw) ? (float) $hoursRaw : null,
                'status' => ($end && $end < $today) ? 'closed' : 'active',
            ];
        }
        return $out;
    }

    /**
     * @param array<int, array<int, string>> $rows
     * @return array<int, array<string, mixed>>
     */
    private static function parseEmployersXlsxRows(array $rows): array
    {
        $hdrIdx = null;
        $cols = [];
        foreach (array_slice($rows, 0, 10, true) as $idx => $r) {
            $norm = array_map([self::class, 'normHeader'], $r);
            $joined = implode(' | ', $norm);
            if ((str_contains($joined, 'foglalkoztato') || str_contains($joined, 'munkaltato') || str_contains($joined, 'adoszam')) && str_contains($joined, 'jogviszony')) {
                $hdrIdx = $idx;
                foreach ($norm as $ci => $h) {
                    if (!isset($cols['name']) && (str_contains($h, 'foglalkoztato nev') || str_contains($h, 'munkaltato nev') || $h === 'nev')) {
                        $cols['name'] = $ci;
                    } elseif (!isset($cols['tax_no']) && str_contains($h, 'adoszam')) {
                        $cols['tax_no'] = $ci;
                    } elseif (!isset($cols['tax_id']) && str_contains($h, 'adoazonosito')) {
                        $cols['tax_id'] = $ci;
                    } elseif (!isset($cols['start']) && (str_contains($h, 'kezdet') || str_contains($h, 'kezdo'))) {
                        $cols['start'] = $ci;
                    } elseif (!isset($cols['end']) && (str_contains($h, 'vege') || str_contains($h, 'zaro'))) {
                        $cols['end'] = $ci;
                    } elseif (!isset($cols['hours']) && (str_contains($h, 'ora') || str_contains($h, 'munkaora'))) {
                        $cols['hours'] = $ci;
                    } elseif (!isset($cols['type']) && str_contains($h, 'jogviszony')) {
                        $cols['type'] = $ci;
                    }
                }
                break;
            }
        }
        if ($hdrIdx === null || !isset($cols['name'])) {
            return [];
        }

        $out = [];
        $today = date('Y-m-d');
        foreach (array_slice($rows, $hdrIdx + 1) as $r) {
            $name = trim((string) ($r[$cols['name']] ?? ''));
            if ($name === '') {
                continue;
            }
            $taxNo = isset($cols['tax_no']) ? trim((string) ($r[$cols['tax_no']] ?? '')) : '';
            $taxIdRaw = preg_replace('/\D+/', '', (string) ($r[$cols['tax_id'] ?? -1] ?? ''));
            $end = isset($cols['end']) ? DeadlineExtractor::normalizeDate($r[$cols['end']] ?? null) : null;
            $hoursRaw = isset($cols['hours']) ? str_replace(',', '.', preg_replace('/[^0-9.,]/', '', (string) ($r[$cols['hours']] ?? ''))) : '';
            $out[] = [
                'employer_name' => $name,
                'employer_tax_number' => $taxNo !== '' ? $taxNo : null,
                'employer_tax_id' => preg_match('/^8\d{9}$/', $taxIdRaw) ? $taxIdRaw : null,
                'relationship_start' => isset($cols['start']) ? DeadlineExtractor::normalizeDate($r[$cols['start']] ?? null) : null,
                'relationship_end' => $end,
                'relationship_type' => isset($cols['type']) ? trim((string) ($r[$cols['type']] ?? '')) : null,
                'weekly_hours' => $hoursRaw !== '' && is_numeric($hoursRaw) ? (float) $hoursRaw : null,
                'status' => ($end && $end < $today) ? 'closed' : 'active',
            ];
        }
        return $out;
    }

    /**
     * @param array<int, array<int, string>> $rows
     * @return array<int, array<string, mixed>>
     */
    private static function parseEfoQuotasXlsxRows(array $rows, int $defaultYear): array
    {
        $hdrIdx = null;
        $cols = [];
        foreach (array_slice($rows, 0, 10, true) as $idx => $r) {
            $norm = array_map([self::class, 'normHeader'], $r);
            $joined = implode(' | ', $norm);
            if ((str_contains($joined, 'nev') || str_contains($joined, 'adoazonosito')) && (str_contains($joined, 'nap') || str_contains($joined, 'keret') || str_contains($joined, 'felhasznal'))) {
                $hdrIdx = $idx;
                foreach ($norm as $ci => $h) {
                    if (!isset($cols['name']) && (str_contains($h, 'munkavallalo') || str_contains($h, 'nev'))) {
                        $cols['name'] = $ci;
                    } elseif (!isset($cols['tax_id']) && str_contains($h, 'adoazonosito')) {
                        $cols['tax_id'] = $ci;
                    } elseif (!isset($cols['taj']) && str_contains($h, 'taj')) {
                        $cols['taj'] = $ci;
                    } elseif (!isset($cols['year']) && ($h === 'ev' || str_contains($h, 'targyev'))) {
                        $cols['year'] = $ci;
                    } elseif (!isset($cols['used']) && str_contains($h, 'felhasznalt')) {
                        $cols['used'] = $ci;
                    } elseif (!isset($cols['rem']) && (str_contains($h, 'felhasznalhato') || str_contains($h, 'hatralevo') || str_contains($h, 'maradek'))) {
                        $cols['rem'] = $ci;
                    } elseif (!isset($cols['limit']) && str_contains($h, 'keret')) {
                        $cols['limit'] = $ci;
                    } elseif (!isset($cols['type']) && (str_contains($h, 'foglalkoztatas') || str_contains($h, 'jelleg'))) {
                        $cols['type'] = $ci;
                    }
                }
                break;
            }
        }
        if ($hdrIdx === null) {
            return [];
        }

        $out = [];
        foreach (array_slice($rows, $hdrIdx + 1) as $r) {
            $name = isset($cols['name']) ? trim((string) ($r[$cols['name']] ?? '')) : '';
            $taxRaw = isset($cols['tax_id']) ? preg_replace('/\D+/', '', (string) ($r[$cols['tax_id']] ?? '')) : '';
            $taxId = preg_match('/^8\d{9}$/', $taxRaw) ? $taxRaw : null;
            if ($name === '' && $taxId === null) {
                continue;
            }
            $yrRaw = isset($cols['year']) ? (int) ($r[$cols['year']] ?? 0) : 0;
            $used = isset($cols['used']) ? max(0, (int) preg_replace('/\D+/', '', (string) ($r[$cols['used']] ?? '0'))) : 0;
            $rem = isset($cols['rem']) && ($r[$cols['rem']] ?? '') !== '' ? max(0, (int) preg_replace('/\D+/', '', (string) $r[$cols['rem']])) : null;
            $limit = isset($cols['limit']) && ($r[$cols['limit']] ?? '') !== '' ? max(0, (int) preg_replace('/\D+/', '', (string) $r[$cols['limit']])) : null;
            if ($limit === null && $rem !== null) {
                $limit = $used + $rem;
            }
            if ($limit === null) {
                $limit = 120;
            }
            if ($rem === null) {
                $rem = max(0, $limit - $used);
            }
            $out[] = [
                'year' => ($yrRaw >= 2000 && $yrRaw <= 2100) ? $yrRaw : $defaultYear,
                'employee_name' => $name !== '' ? $name : null,
                'employee_tax_id' => $taxId,
                'employee_taj' => isset($cols['taj']) ? self::formatTaj($r[$cols['taj']] ?? null) : null,
                'employment_type' => isset($cols['type']) && trim((string) ($r[$cols['type']] ?? '')) !== '' ? trim((string) $r[$cols['type']]) : 'Egyszerűsített foglalkoztatás (összevont)',
                'quota_limit' => $limit,
                'used_days' => $used,
                'remaining_days' => $rem,
            ];
        }
        return $out;
    }
}
