<?php

namespace App\Mcp\Tools;

use App\Iratkapu\DeadlineCalendar;
use App\Iratkapu\Scope;
use App\Iratkapu\TaxpayerDataTables;
use App\Mcp\McpData;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class GetClient extends IratkapuTool
{
    protected string $name = 'get_client';

    protected string $description = 'Egy ügyfél teljes adatlapja: tárhelyek és szinkronállapotuk, meghatalmazás, kapcsolattartók (értesítési címek), kezelő munkatársak, nyitott iratok, közelgő határidők és adónaptár, NAV-adószámla pillanatkép, beadott bevallások (nyugta-vonalkóddal), bejelentett biztosítottak, saját foglalkoztatók, EFO-bejelentések és napkeret, NAV adategyeztetések, NAV-dokumentumok és helyi adó (ASP) kivonatok.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'client_id' => $schema->integer()->description('Az ügyfél azonosítója (a search_clients adja).')->required(),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $c = Scope::client($user, (int) $request->get('client_id'));
        $ini = McpData::initials($user->office_id);
        $names = [$c->id => $c->name];
        $nav = DB::table('nav_client_snapshots')->where('client_id', $c->id)->orderByDesc('fetched_at')->first();

        $returnsRows = DB::table('nav_returns')->where('client_id', $c->id)->orderByDesc('submitted_at')->limit(30)->get();
        TaxpayerDataTables::enrichReturnsWithReceipts((int) $user->office_id, $returnsRows);
        $curYear = (int) date('Y');

        return McpData::client($c) + [
            'mailboxes' => DB::table('mailboxes')->where('client_id', $c->id)->get()->map(fn ($b) => ['type' => $b->type, 'live_name' => $b->live_ref,
                'sync_state' => $b->sync_state, 'sync_note' => $b->sync_note, 'last_ok_at' => $b->last_ok_at, 'quota_pct' => $b->quota_pct])->values(),
            'contacts' => DB::table('client_contacts')->where('client_id', $c->id)->get()->map(fn ($k) => ['id' => $k->id, 'name' => $k->name, 'email' => $k->email,
                'role' => $k->role, 'calendar_invites' => (bool) $k->calendar_invites])->values(),
            'handlers' => DB::table('client_user')->where('client_id', $c->id)->pluck('user_id')->map(fn ($i) => $ini[$i] ?? null)->filter()->values(),
            'open_messages' => DB::table('messages')->where('client_id', $c->id)->where('archived', false)->where('internal', '!=', 'kesz')
                ->orderByDesc('arrived_at')->limit(50)->get()->map(fn ($m) => McpData::message($m, $ini, $names))->values(),
            'deadlines' => array_slice(DeadlineCalendar::items($user->office_id, Scope::clientIds($user), ['client' => $c->id]), 0, 50),
            'tax_obligations' => DB::table('tax_obligations')->where('client_id', $c->id)->orderBy('due_date')->orderBy('id')->limit(100)->get()
                ->map(fn ($o) => McpData::obligation($o))->values(),
            'nav_tax_account' => $nav ? ['total' => $nav->total, 'debt' => $nav->debt, 'surplus' => $nav->surplus, 'deposit' => $nav->deposit,
                'missing_returns' => $nav->missing_count, 'fetched_at' => $nav->fetched_at] : null,
            'nav_returns' => $returnsRows->map(fn ($x) => ['reg_no' => $x->reg_no ?? null, 'barcode' => ($x->barcode ?? null) ?: ($x->reg_no ?? null),
                'form_code' => $x->form_code ?? null, 'title' => $x->title ?? null, 'period_from' => $x->period_from ?? null,
                'period_to' => $x->period_to ?? null, 'submitted_at' => $x->submitted_at ?? null,
                'accepted_at' => ($x->accepted_at ?? null) ?: ($x->submitted_at ?? null), 'error_at' => $x->error_at ?? null,
                'kind' => $x->kind ?? null, 'state' => $x->state ?? null])->values(),
            'insured_persons_total' => DB::table('nav_insured_persons')->where('office_id', $user->office_id)->where('client_id', $c->id)->count(),
            'insured_persons' => DB::table('nav_insured_persons')->where('office_id', $user->office_id)->where('client_id', $c->id)
                ->orderBy('name')->limit(50)->get()
                ->map(fn ($x) => ['name' => $x->name ?? null, 'tax_id' => $x->tax_id ?? null, 'taj' => $x->taj ?? null,
                    'relationship_start' => $x->relationship_start ?? null, 'relationship_end' => $x->relationship_end ?? null,
                    'relationship_type' => $x->relationship_type ?? null,
                    'weekly_hours' => ($x->weekly_hours ?? null) !== null ? (float) $x->weekly_hours : null,
                    'status' => $x->status ?? 'active'])->values(),
            'own_employers' => DB::table('nav_employers')->where('office_id', $user->office_id)->where('client_id', $c->id)
                ->orderBy('employer_name')->limit(20)->get()
                ->map(fn ($x) => ['employer_name' => $x->employer_name ?? null, 'employer_tax_number' => $x->employer_tax_number ?? null,
                    'employer_tax_id' => $x->employer_tax_id ?? null, 'relationship_start' => $x->relationship_start ?? null,
                    'relationship_type' => $x->relationship_type ?? null,
                    'weekly_hours' => ($x->weekly_hours ?? null) !== null ? (float) $x->weekly_hours : null,
                    'status' => $x->status ?? 'active'])->values(),
            'efo' => [
                'declarations' => DB::table('nav_efo_declarations')->where('office_id', $user->office_id)->where('client_id', $c->id)
                    ->orderByDesc('start_date')->limit(30)->get()
                    ->map(fn ($x) => ['employee_name' => $x->employee_name ?? null, 'employee_tax_id' => $x->employee_tax_id ?? null,
                        'employee_taj' => $x->employee_taj ?? null, 'declaration_code' => $x->declaration_code ?? null,
                        'employment_type' => $x->employment_type ?? null, 'start_date' => $x->start_date ?? null,
                        'end_date' => $x->end_date ?? null, 'days_count' => (int) ($x->days_count ?? 1),
                        'reg_no' => $x->reg_no ?? null, 'status' => $x->status ?? null, 'filing_type' => $x->filing_type ?? null,
                        'submitted_at' => $x->submitted_at ?? null])->values(),
                'quotas_this_year' => DB::table('nav_efo_quotas')->where('office_id', $user->office_id)->where('client_id', $c->id)
                    ->where('year', $curYear)->orderBy('employee_name')->limit(30)->get()
                    ->map(fn ($x) => ['year' => (int) ($x->year ?? $curYear), 'employee_name' => ($x->employee_name ?? null) ?: 'Összesített',
                        'employee_tax_id' => $x->employee_tax_id ?? null, 'employee_taj' => $x->employee_taj ?? null,
                        'employment_type' => $x->employment_type ?? null, 'quota_limit' => (int) ($x->quota_limit ?? 0),
                        'used_days' => (int) ($x->used_days ?? 0), 'remaining_days' => (int) ($x->remaining_days ?? 0)])->values(),
            ],
            'nav_reconciliations' => DB::table('nav_reconciliations')->where('office_id', $user->office_id)->where('client_id', $c->id)
                ->orderByDesc('created_date')->limit(20)->get()
                ->map(fn ($x) => ['reconciler_name' => $x->reconciler_name ?? null, 'status' => $x->status ?? null,
                    'case_number' => $x->case_number ?? null, 'created_date' => $x->created_date ?? null,
                    'submitted_date' => $x->submitted_date ?? null, 'notes' => $x->notes ?? null])->values(),
            'nav_documents' => DB::table('nav_documents')->where('client_id', $c->id)->orderByDesc('arrived_at')->limit(30)->get()
                ->map(fn ($x) => ['subject' => $x->subject, 'doc_type' => $x->doc_type, 'form_code' => $x->form_code, 'case_no' => $x->case_no, 'arrived_at' => $x->arrived_at])->values(),
            'local_tax_statements' => DB::table('asp_statements')->where('client_id', $c->id)->orderByDesc('fetched_at')->limit(20)->get()
                ->map(fn ($x) => ['municipality' => $x->tenant_name, 'year' => $x->year, 'kind' => $x->kind, 'status' => $x->status, 'fetched_at' => $x->fetched_at])->values(),
        ];
    }
}
