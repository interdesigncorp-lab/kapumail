<?php

namespace App\Http\Controllers;

use App\Iratkapu\Audit;
use App\Iratkapu\OfficeMail;
use App\Mcp\McpAccess;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

/**
 * A Beállítások → AI-kapcsolat (MCP) lap végpontjai (ADR-012): be/ki kapcsolás, személyes tokenek, OAuth-kapcsolatok szintje
 * és visszavonása. Csak admin. Ide jelentkezik az asztali alkalmazás is az ütemezett szinkron állapotával (heartbeat).
 */
class McpController extends Controller
{
    private function admin(): object
    {
        $u = Auth::user();
        abort_if($u->role !== 'admin', 403, 'Az AI-kapcsolatot csak admin kezelheti.');

        return $u;
    }

    public function show(Request $r)
    {
        $u = $this->admin();
        $ini = DB::table('users')->where('office_id', $u->office_id)->pluck('initials', 'id');
        $local = ! empty(OfficeMail::settings($u->office_id)['local']);

        return [
            'enabled' => McpAccess::enabled($u->office_id),
            'local' => $local,
            'url' => url('/mcp'),
            'https' => str_starts_with(url('/'), 'https://'),
            'artisan' => getenv('IRATKAPU_ARTISAN_PATH') ?: base_path('artisan'),
            'php' => PHP_BINARY,
            'tokens' => DB::table('mcp_tokens')->where('office_id', $u->office_id)->whereNull('revoked_at')->orderByDesc('id')->get()->map(fn ($t) => [
                'id' => $t->id, 'name' => $t->name, 'level' => $t->level, 'user' => $ini[$t->user_id] ?? '?', 'hint' => $t->hint,
                'expires' => $t->expires_at ? substr($t->expires_at, 0, 10) : null, 'expired' => $t->expires_at && now()->greaterThan($t->expires_at),
                'used' => $t->last_used_at ? substr($t->last_used_at, 0, 16) : null, 'created' => substr((string) $t->created_at, 0, 10)])->values(),
            'grants' => DB::table('mcp_grants')->where('mcp_grants.office_id', $u->office_id)->whereNull('mcp_grants.revoked_at')
                ->leftJoin('oauth_clients', 'oauth_clients.id', '=', 'mcp_grants.oauth_client_id')->orderByDesc('mcp_grants.id')
                ->get(['mcp_grants.*', 'oauth_clients.name as client'])->map(fn ($g) => ['id' => $g->id, 'client' => $g->client ?? 'OAuth-kliens',
                    'user' => $ini[$g->user_id] ?? '?', 'level' => $g->level, 'used' => $g->last_used_at ? substr($g->last_used_at, 0, 16) : null])->values(),
            'calls' => DB::table('audit_events')->where('office_id', $u->office_id)->where('action', 'like', 'MCP:%')->orderByDesc('id')->limit(15)->get()
                ->map(fn ($a) => [\Carbon\Carbon::parse($a->at_utc, 'UTC')->setTimezone(config('app.timezone'))->format('m. d. H:i'), $a->actor_label, $a->action])->values(),
        ];
    }

    public function setEnabled(Request $r)
    {
        $u = $this->admin();
        $on = (bool) $r->validate(['enabled' => 'required|boolean'])['enabled'];
        OfficeMail::put($u->office_id, ['mcp' => ['enabled' => $on] + (OfficeMail::settings($u->office_id)['mcp'] ?? [])]);
        Audit::log($u->office_id, $u, $on ? 'AI-kapcsolat (MCP) bekapcsolva, saját felelősségre (ÁSZF 10. pont)' : 'AI-kapcsolat (MCP) kikapcsolva');

        return ['ok' => true];
    }

    public function issue(Request $r)
    {
        $u = $this->admin();
        $d = $r->validate(['name' => 'required|string|max:80', 'level' => 'required|in:olvasas,munka,admin', 'user' => 'nullable|string|max:8', 'days' => 'nullable|integer|min:1|max:730']);
        $owner = ! empty($d['user']) ? DB::table('users')->where('office_id', $u->office_id)->where('initials', $d['user'])->first() : $u;
        abort_if(! $owner, 422, 'Ismeretlen munkatárs.');
        $t = McpAccess::issue($owner, $d['name'], $d['level'], isset($d['days']) ? now()->addDays($d['days'])->toDateTimeString() : null);
        Audit::log($u->office_id, $u, "MCP-token létrehozva: {$d['name']} ({$owner->name} nevében, ".McpAccess::LEVEL_NAMES[$d['level']].' szint'.(isset($d['days']) ? ", {$d['days']} napig" : '').')');

        return ['ok' => true, 'token' => $t['token']];
    }

    /** Egy személyes token szintjének utólagos módosítása (a token maga nem változik, a kliensben nem kell átírni). */
    public function tokenLevel(Request $r, int $id)
    {
        $u = $this->admin();
        $t = DB::table('mcp_tokens')->where('office_id', $u->office_id)->whereNull('revoked_at')->find($id);
        abort_if(! $t, 404);
        // A Kapu-token (ADR-014) szintje rögzített: a Kapu-chat saját, szűk szintje, nem emelhető. Visszavonni lehet.
        abort_if($t->level === 'kapu', 422, 'A Kapu-token szintje nem módosítható. Ha nem kell, vond vissza.');
        $level = $r->validate(['level' => 'required|in:olvasas,munka,admin'])['level'];
        DB::table('mcp_tokens')->where('id', $id)->update(['level' => $level, 'updated_at' => now()]);
        Audit::log($u->office_id, $u, "MCP-token szintje: {$t->name} – ".McpAccess::LEVEL_NAMES[$t->level].' → '.McpAccess::LEVEL_NAMES[$level]);

        return ['ok' => true];
    }

    public function revoke(int $id)
    {
        $u = $this->admin();
        $t = DB::table('mcp_tokens')->where('office_id', $u->office_id)->find($id);
        abort_if(! $t, 404);
        DB::table('mcp_tokens')->where('id', $id)->update(['revoked_at' => now(), 'updated_at' => now()]);
        Audit::log($u->office_id, $u, "MCP-token visszavonva: {$t->name}");

        return ['ok' => true];
    }

    public function grantLevel(Request $r, int $id)
    {
        $u = $this->admin();
        $g = DB::table('mcp_grants')->where('office_id', $u->office_id)->whereNull('revoked_at')->find($id);
        abort_if(! $g, 404);
        $level = $r->validate(['level' => 'required|in:olvasas,munka,admin'])['level'];
        DB::table('mcp_grants')->where('id', $id)->update(['level' => $level, 'updated_at' => now()]);
        Audit::log($u->office_id, $u, 'OAuth AI-kapcsolat szintje: '.McpAccess::LEVEL_NAMES[$g->level].' → '.McpAccess::LEVEL_NAMES[$level]);

        return ['ok' => true];
    }

    /** OAuth-kapcsolat visszavonása: a kliens ennél a felhasználónál kiadott tokenjei is érvénytelenek lesznek. */
    public function revokeGrant(int $id)
    {
        $u = $this->admin();
        $g = DB::table('mcp_grants')->where('office_id', $u->office_id)->find($id);
        abort_if(! $g, 404);
        DB::table('mcp_grants')->where('id', $id)->update(['revoked_at' => now(), 'updated_at' => now()]);
        $tokenIds = DB::table('oauth_access_tokens')->where('client_id', $g->oauth_client_id)->where('user_id', $g->user_id)->pluck('id');
        DB::table('oauth_access_tokens')->whereIn('id', $tokenIds)->update(['revoked' => true]);
        DB::table('oauth_refresh_tokens')->whereIn('access_token_id', $tokenIds)->update(['revoked' => true]);
        Audit::log($u->office_id, $u, 'OAuth AI-kapcsolat visszavonva');

        return ['ok' => true];
    }

    /** Csatlakozási kód a közvetítőn át csatlakozó ChatGPT / claude.ai számára (ADR-013); a szintet itt választja ki az admin. */
    public function pairing(Request $r)
    {
        $u = $this->admin();
        abort_if(! McpAccess::enabled($u->office_id), 422, 'Előbb kapcsold be az AI-kapcsolatot.');
        $level = $r->validate(['level' => 'required|in:olvasas,munka,admin'])['level'];
        // Az OAuth-tokenek aláíró kulcsa telepítésenként készül, az első csatlakozás előtt (a gépen marad, a gitből kizárt).
        if (! file_exists(\Laravel\Passport\Passport::keyPath('oauth-private.key'))) {
            \Illuminate\Support\Facades\Artisan::call('passport:keys', ['--force' => true]);
        }
        $p = \App\Mcp\McpPairing::create($u, $level);
        Audit::log($u->office_id, $u, 'MCP: csatlakozási kód kérve ('.McpAccess::LEVEL_NAMES[$level].' szint, '.\App\Mcp\McpPairing::TTL_MINUTES.' percig érvényes)');

        return ['ok' => true] + $p;
    }

    /** Az asztali alkalmazás jelentkezése: az ütemezett szinkron állapota, hogy a szerver (és az MCP) is lássa. */
    public function heartbeat(Request $r)
    {
        $u = Auth::user();
        $d = $r->validate(['version' => 'nullable|string|max:20', 'schedule' => 'nullable|string|max:120', 'next' => 'nullable|string|max:40', 'last' => 'nullable|string|max:40']);
        OfficeMail::put($u->office_id, ['desktop' => ['at' => now()->format('Y-m-d H:i'), 'by' => $u->initials] + array_filter($d, fn ($v) => $v !== null)]);

        return ['ok' => true];
    }
}
