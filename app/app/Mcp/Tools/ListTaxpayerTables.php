<?php

namespace App\Mcp\Tools;

use App\Iratkapu\Scope;
use App\Iratkapu\TaxpayerDataTables;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class ListTaxpayerTables extends IratkapuTool
{
    protected string $name = 'list_taxpayer_tables';

    protected string $description = 'Az Adózói táblák összes nézetének lekérdezése és szűrése (ugyanazzal a jogosultsággal, mint a felületen): '
        .'`overview` (gyors ügyfelenkénti összesítő darabszámok egy hívásban), '
        .'`missing_returns` (ÜPO szerinti hiányzó bevallások), '
        .'`returns` (beadott bevallások tárhelyi nyugta-vonalkóddal és befogadási/hiba dátummal), '
        .'`insured` (bejelentett biztosítottak és T1041 jogviszonyaik, TAJ, heti óra), '
        .'`employers` (természetes személy / EV saját foglalkoztatói), '
        .'`efo_declarations` (egyszerűsített foglalkoztatás T1042E bejelentések), '
        .'`efo_quotas` (éves összevont EFO-napkeret dolgozónként), '
        .'`reconciliations` (NAV adategyeztetések és állapotuk), '
        .'`calendar` (12 hónapos adónaptár-mátrix a beadott bevallásokkal és jövőbeli esedékességekkel).';

    protected bool $audit = false;

    public function schema(JsonSchema $schema): array
    {
        return [
            'view' => $schema->string()
                ->enum(['overview', ...TaxpayerDataTables::VIEWS])
                ->description('Melyik táblanézetet kéred le (`overview` a gyors összesítőhöz, vagy a konkrét tábla kulcsa). Alapértelmezés: `overview`.'),
            'client_id' => $schema->integer()
                ->description('Szűrés egyetlen ügyfélre (a `search_clients` által adott azonosító).'),
            'search' => $schema->string()
                ->description('Szabad szöveges keresés (név, adószám, adóazonosító, TAJ, nyomtatványkód, vonalkód, adategyeztető).'),
            'year' => $schema->integer()
                ->description('Tárgyév (pl. 2026) az `overview`, `returns`, `missing_returns`, `efo_declarations`, `efo_quotas` és `calendar` nézetekhez.'),
            'status' => $schema->string()
                ->description('Állapot-szűrő (pl. `calendar` nézetben: `submittable`, `submitted`, `missing`, `conditional`, `unknown`; `insured`/`employers` nézetben: `active`, `closed`).'),
            'sort_by' => $schema->string()
                ->description('Rendezési mező (pl. `due_date`, `submitted_at`, `name`, `relationship_start`, `start_date`, `created_date`).'),
            'sort_dir' => $schema->string()
                ->enum(['asc', 'desc'])
                ->description('Rendezés iránya (`asc` vagy `desc`).'),
            'page' => $schema->integer()
                ->description('Oldalszám (1-től).'),
            'per_page' => $schema->integer()
                ->description('Oldalméret (1–100, alapértelmezés: 50).'),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $view = trim((string) $request->get('view', 'overview')) ?: 'overview';
        $clientId = $request->get('client_id') !== null ? (int) $request->get('client_id') : null;
        if ($clientId !== null) {
            Scope::client($user, $clientId);
        }

        $year = $request->get('year') !== null ? (int) $request->get('year') : (int) date('Y');

        if ($view === 'overview') {
            return $this->overview($user, $clientId, $year);
        }

        abort_if(! in_array($view, TaxpayerDataTables::VIEWS, true), 422, 'Ismeretlen táblanézet.');

        $data = TaxpayerDataTables::getData($user, $view, [
            'client_id' => $clientId,
            'search' => $request->get('search', ''),
            'year' => $request->get('year'),
            'status' => $request->get('status', ''),
            'sort_by' => $request->get('sort_by', ''),
            'sort_dir' => $request->get('sort_dir', ''),
            'page' => max(1, (int) $request->get('page', 1)),
            'per_page' => max(1, min(100, (int) $request->get('per_page', 50))),
        ]);

        return [
            'view' => $view,
            'total' => $data['total'] ?? 0,
            'page' => $data['page'] ?? 1,
            'per_page' => $data['per_page'] ?? 50,
            'year' => $data['year'] ?? $year,
            'sync_supported' => (bool) ($data['sync_supported'] ?? true),
            'items' => $data['items'] ?? [],
        ];
    }

    /** @return array<string, mixed> */
    private function overview(User $user, ?int $clientId, int $year): array
    {
        $cids = $clientId !== null ? [$clientId] : Scope::clientIds($user);
        if (empty($cids)) {
            return ['view' => 'overview', 'year' => $year, 'totals' => [], 'clients' => []];
        }

        $clients = DB::table('clients')
            ->where('office_id', $user->office_id)
            ->whereIn('id', $cids)
            ->orderBy('name')
            ->get(['id', 'name', 'tax', 'discovered_via']);

        $countBy = fn (string $table, \Closure $filter) => $filter(
            DB::table($table)->where('office_id', $user->office_id)->whereIn('client_id', $cids)
        )->selectRaw('client_id, count(*) as c')->groupBy('client_id')->pluck('c', 'client_id')->all();

        $missing = $countBy('tax_obligations', fn ($q) => $q->where('status', 'missing'));
        $submittable = $countBy('tax_obligations', fn ($q) => $q->whereIn('status', ['submittable', 'conditional'])->whereYear('due_date', $year));
        $returns = $countBy('nav_returns', fn ($q) => $q->where('submitted_at', 'like', "{$year}-%"));
        $insured = $countBy('nav_insured_persons', fn ($q) => $q->where('status', 'active'));
        $employers = $countBy('nav_employers', fn ($q) => $q->where('status', 'active'));
        $efoDecl = $countBy('nav_efo_declarations', fn ($q) => $q->whereYear('start_date', $year));
        $efoQuota = $countBy('nav_efo_quotas', fn ($q) => $q->where('year', $year));
        $reconcil = $countBy('nav_reconciliations', fn ($q) => $q);

        $rows = [];
        $totals = [
            'missing_returns' => 0,
            'upcoming_obligations_in_year' => 0,
            'submitted_returns_in_year' => 0,
            'active_insured_persons' => 0,
            'active_own_employers' => 0,
            'efo_declarations_in_year' => 0,
            'efo_quota_rows_in_year' => 0,
            'reconciliations' => 0,
        ];

        foreach ($clients as $c) {
            $cid = (int) ($c->id ?? 0);
            $taxRaw = trim((string) ($c->tax ?? ''));
            $item = [
                'client_id' => $cid,
                'client_name' => (string) ($c->name ?? ''),
                'client_tax' => str_starts_with($taxRaw, 'sajat-') ? null : ($taxRaw ?: null),
                'kind' => ($c->discovered_via ?? null) === 'own' ? 'saját tárhely' : 'ügyfél',
                'missing_returns' => (int) ($missing[$cid] ?? 0),
                'upcoming_obligations_in_year' => (int) ($submittable[$cid] ?? 0),
                'submitted_returns_in_year' => (int) ($returns[$cid] ?? 0),
                'active_insured_persons' => (int) ($insured[$cid] ?? 0),
                'active_own_employers' => (int) ($employers[$cid] ?? 0),
                'efo_declarations_in_year' => (int) ($efoDecl[$cid] ?? 0),
                'efo_quota_rows_in_year' => (int) ($efoQuota[$cid] ?? 0),
                'reconciliations' => (int) ($reconcil[$cid] ?? 0),
            ];
            foreach ($totals as $k => $_) {
                $totals[$k] += $item[$k];
            }
            $rows[] = $item;
        }

        return [
            'view' => 'overview',
            'year' => $year,
            'totals' => $totals,
            'clients' => $rows,
        ];
    }
}
