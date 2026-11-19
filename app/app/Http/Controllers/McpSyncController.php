<?php

namespace App\Http\Controllers;

use App\Iratkapu\Audit;
use App\Iratkapu\McpSyncRequests;
use App\Iratkapu\Scope;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

/** MCP-ből indítható szinkron (ADR-016): az asztali app felülete itt veszi fel, indítja és zárja le az MI-kéréseket. */
class McpSyncController extends Controller
{
    public function next(): array
    {
        $u = Auth::user();
        abort_unless(Scope::seesAll($u), 403, 'Az MI-ből indított szinkront csak admin vagy vezető felhasználó futtathatja.');
        $r = McpSyncRequests::next((int) $u->office_id);

        return ['request' => $r ? ['id' => (int) $r['id'], 'source' => $r['source'], 'created_at' => $r['created_at']] : null];
    }

    /** A főfolyamat ellenőrzi, hogy a kérés valóban létezik és függő/futó, mielőtt zárolt appnál átengedi a szinkront. */
    public function show(int $id): array
    {
        $u = Auth::user();
        abort_unless(Scope::seesAll($u), 403);
        $status = DB::table('mcp_sync_requests')->where('office_id', $u->office_id)->where('id', $id)->value('status');

        return ['status' => $status];
    }

    public function start(int $id): array
    {
        $u = Auth::user();
        abort_unless(Scope::seesAll($u), 403);

        return ['ok' => McpSyncRequests::start((int) $u->office_id, $id)];
    }

    public function finish(Request $r, int $id): array
    {
        $u = Auth::user();
        abort_unless(Scope::seesAll($u), 403);
        $d = $r->validate(['ok' => 'required|boolean', 'note' => 'nullable|string|max:300']);
        $ok = McpSyncRequests::finish((int) $u->office_id, $id, (bool) $d['ok'], $d['note'] ?? null);
        if ($ok) {
            $source = DB::table('mcp_sync_requests')->where('id', $id)->value('source');
            Audit::log($u->office_id, $u, 'MCP-szinkron '.($d['ok'] ? 'lefutott' : 'sikertelen')." ({$source})");
        }

        return ['ok' => $ok];
    }
}
