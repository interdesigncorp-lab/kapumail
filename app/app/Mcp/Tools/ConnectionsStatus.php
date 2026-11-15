<?php

namespace App\Mcp\Tools;

use App\Iratkapu\CalendarInvites;
use App\Iratkapu\ClientDiscovery;
use App\Iratkapu\OfficeMail;
use App\Iratkapu\Scope;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class ConnectionsStatus extends IratkapuTool
{
    protected string $name = 'connections_status';

    protected string $description = 'Milyen összeköttetések vannak és élnek-e: Ügyfélkapu+/DÁP belépők (Tárhely, NAV, ASP állapota, utolsó hiba), tárhelyek szinkronállapota, a legutóbbi szinkronfutások, NAV- és ASP-adatok frissessége, e-mail küldés (SMTP), naptármeghívók, az asztali alkalmazás ütemezett szinkronja (ha jelentkezett), és az AI-kapcsolatok (MCP-tokenek, OAuth-kliensek). Titkot nem ad ki.';

    protected bool $audit = false;

    public function schema(JsonSchema $schema): array
    {
        return [];
    }

    protected function run(Request $request, User $user): array
    {
        $cids = Scope::clientIds($user);
        $ini = DB::table('users')->where('office_id', $user->office_id)->pluck('initials', 'id');
        $s = OfficeMail::settings($user->office_id);
        $boxes = DB::table('mailboxes')->whereIn('client_id', $cids)->get();
        $names = DB::table('clients')->whereIn('id', $cids)->pluck('name', 'id');
        $cal = CalendarInvites::config($user->office_id);
        $desktop = $s['desktop'] ?? null;

        return [
            'portal_logins' => DB::table('portal_connections')->where('office_id', $user->office_id)->orderBy('id')->get()->map(fn ($p) => [
                'id' => $p->id, 'name' => $p->name, 'login_method' => $p->auth_mode, 'systems' => ClientDiscovery::systemsOf($p), 'owner' => $ini[$p->owner_user_id] ?? null,
                'tarhely' => ['state' => $p->tarhely_state, 'at' => $p->tarhely_at], 'receipts_upo' => ['state' => $p->upo_state, 'at' => $p->upo_at],
                'auto_download' => (bool) $p->download_active, 'last_error' => $p->last_error,
                'clients' => DB::table('clients')->where('portal_connection_id', $p->id)->whereIn('id', $cids)->count(),
                'nav_snapshot_at' => DB::table('nav_snapshots')->where('portal_connection_id', $p->id)->max('fetched_at'),
            ])->values(),
            'state_legend' => ['ok' => 'működik', 'need' => 'újra be kell lépni / jóváhagyás kell', 'idle' => 'még nem futott vagy nincs használatban'],
            'mailboxes' => ['total' => $boxes->count(), 'by_state' => $boxes->groupBy(fn ($b) => $b->sync_state ?? 'nem futott')->map->count(),
                'last_ok_at' => $boxes->max('last_ok_at'),
                'needs_attention' => $boxes->where('sync_state', 'need')->map(fn ($b) => ['client' => $names[$b->client_id] ?? null, 'type' => $b->type, 'note' => $b->sync_note])->values()],
            'recent_sync_runs' => DB::table('sync_runs')->where('office_id', $user->office_id)->whereIn('mailbox_id', $boxes->pluck('id'))->orderByDesc('id')->limit(10)->get()
                ->map(fn ($r) => ['at' => $r->created_at, 'state' => $r->state, 'listed' => $r->listed, 'new' => $r->created, 'note' => $r->note])->values(),
            'nav' => ['client_snapshots' => DB::table('nav_client_snapshots')->whereIn('client_id', $cids)->count(),
                'latest_client_snapshot' => DB::table('nav_client_snapshots')->whereIn('client_id', $cids)->max('fetched_at'),
                'latest_returns_query' => DB::table('nav_returns')->whereIn('client_id', $cids)->max('updated_at')],
            'asp_local_tax' => ['statements' => DB::table('asp_statements')->where('office_id', $user->office_id)->whereIn('client_id', $cids)->count(),
                'latest' => DB::table('asp_statements')->where('office_id', $user->office_id)->whereIn('client_id', $cids)->max('fetched_at')],
            'email_smtp' => ['configured' => OfficeMail::summary($user->office_id)['configured'], 'server' => Scope::seesAll($user) && ! empty($s['smtp']) ? "{$s['smtp']['host']}:{$s['smtp']['port']}" : null,
                'fallback' => empty($s['smtp']) ? config('mail.default') : null],
            'calendar_invites' => ['on' => $cal['on'], 'mail_ready' => $cal['mailReady'], 'pending' => $cal['on'] && $cal['mailReady'] ? CalendarInvites::pending($user->office_id) : 0,
                'last_error' => Scope::seesAll($user) ? $cal['lastError'] : null],
            'desktop_app' => $desktop ? ['last_seen' => $desktop['at'] ?? null, 'scheduled_sync' => $desktop['schedule'] ?? null, 'next_run' => $desktop['next'] ?? null,
                'last_run' => $desktop['last'] ?? null, 'version' => $desktop['version'] ?? null]
                : 'Az asztali alkalmazás még nem jelentkezett; az ütemezett szinkron állapota nem ismert.',
            'ai_connections' => ['enabled' => ! empty($s['mcp']['enabled']),
                'tokens' => DB::table('mcp_tokens')->where('office_id', $user->office_id)->whereNull('revoked_at')->where(fn ($q) => $q->whereNull('expires_at')->orWhere('expires_at', '>', now()))->count(),
                'oauth_clients' => DB::table('mcp_grants')->where('office_id', $user->office_id)->whereNull('revoked_at')->count()],
        ];
    }
}
