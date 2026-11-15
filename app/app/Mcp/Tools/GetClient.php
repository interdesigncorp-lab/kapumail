<?php

namespace App\Mcp\Tools;

use App\Iratkapu\DeadlineCalendar;
use App\Iratkapu\Scope;
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

    protected string $description = 'Egy ügyfél teljes adatlapja: tárhelyek és szinkronállapotuk, meghatalmazás, kapcsolattartók (értesítési címek), kezelő munkatársak, nyitott iratok, közelgő határidők és adónaptár, NAV-adószámla pillanatkép, beadott bevallások és NAV-dokumentumok (a legutóbbiak), helyi adó (ASP) kivonatok.';

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
            'nav_returns' => DB::table('nav_returns')->where('client_id', $c->id)->orderByDesc('submitted_at')->limit(30)->get()
                ->map(fn ($x) => ['reg_no' => $x->reg_no, 'form_code' => $x->form_code, 'title' => $x->title, 'period_from' => $x->period_from,
                    'period_to' => $x->period_to, 'submitted_at' => $x->submitted_at, 'state' => $x->state])->values(),
            'nav_documents' => DB::table('nav_documents')->where('client_id', $c->id)->orderByDesc('arrived_at')->limit(30)->get()
                ->map(fn ($x) => ['subject' => $x->subject, 'doc_type' => $x->doc_type, 'form_code' => $x->form_code, 'case_no' => $x->case_no, 'arrived_at' => $x->arrived_at])->values(),
            'local_tax_statements' => DB::table('asp_statements')->where('client_id', $c->id)->orderByDesc('fetched_at')->limit(20)->get()
                ->map(fn ($x) => ['municipality' => $x->tenant_name, 'year' => $x->year, 'kind' => $x->kind, 'status' => $x->status, 'fetched_at' => $x->fetched_at])->values(),
        ];
    }
}
