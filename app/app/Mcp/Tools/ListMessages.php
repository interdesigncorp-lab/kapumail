<?php

namespace App\Mcp\Tools;

use App\Iratkapu\Scope;
use App\Mcp\McpData;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class ListMessages extends IratkapuTool
{
    protected string $name = 'list_messages';

    protected string $description = 'Bejövő iratok (tárhelyküldemények) listája szűrőkkel: ügyfél, belső állapot, érkezési időszak, felelős, csak nyitott / sürgős / átvételre váró. A legfrissebbek elöl.';

    protected bool $audit = false;

    public function schema(JsonSchema $schema): array
    {
        return [
            'client_id' => $schema->integer()->description('Csak ennek az ügyfélnek az iratai.'),
            'folder' => $schema->string()->enum(['BEERKEZETT', 'TARTOS_TAR', 'ELKULDOTT', 'all'])->description('Tárhely-mappa: alapértelmezésben az ELKULDOTT kimenő küldemények kimaradnak; megadható BEERKEZETT, TARTOS_TAR, ELKULDOTT vagy all.'),
            'status' => $schema->string()->enum(array_keys(McpData::STATUS))->description('Belső állapot: uj, oszt, kiosztott, folyamatban, ell, kesz.'),
            'open_only' => $schema->boolean()->description('Csak a nem kész és nem archivált iratok.'),
            'urgent_only' => $schema->boolean(),
            'waiting_for_receipt' => $schema->boolean()->description('Csak az átvételre váró iratok.'),
            'assignee' => $schema->string()->description('Felelős monogramja (list_users adja).'),
            'from' => $schema->string()->description('Érkezés legkorábbi napja (ÉÉÉÉ-HH-NN).'),
            'to' => $schema->string()->description('Érkezés legkésőbbi napja (ÉÉÉÉ-HH-NN).'),
            'limit' => $schema->integer()->description('Alapból 50, max 500.'),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $cids = Scope::clientIds($user);
        if ($request->get('client_id')) {
            $cids = array_values(array_intersect($cids, [(int) $request->get('client_id')]));
        }
        $assignee = $request->get('assignee') ? DB::table('users')->where('office_id', $user->office_id)->where('initials', $request->get('assignee'))->value('id') : null;
        $folder = $request->get('folder');
        $rows = DB::table('messages')->whereIn('client_id', $cids)
            ->when(! $folder, fn ($q) => $q->where(fn ($w) => $w->whereNull('folder')->orWhere('folder', '!=', 'ELKULDOTT')))
            ->when($folder && $folder !== 'all', fn ($q) => $q->where('folder', $folder))
            ->when($request->get('status'), fn ($q, $s) => $q->where('internal', $s))
            ->when($request->get('open_only'), fn ($q) => $q->where('archived', false)->where('internal', '!=', 'kesz'))
            ->when($request->get('urgent_only'), fn ($q) => $q->where('urgent', true))
            ->when($request->get('waiting_for_receipt'), fn ($q) => $q->where('official', 'wait'))
            ->when($request->get('assignee'), fn ($q) => $q->where('assignee_id', $assignee ?? 0))
            ->when($request->get('from'), fn ($q, $d) => $q->where('arrived_at', '>=', $d))
            ->when($request->get('to'), fn ($q, $d) => $q->where('arrived_at', '<', date('Y-m-d', strtotime("$d +1 day"))))
            ->orderByDesc('arrived_at')->limit(min(500, max(1, (int) $request->get('limit', 50))))->get();
        $names = DB::table('clients')->whereIn('id', $rows->pluck('client_id')->unique())->pluck('name', 'id')->all();
        $ini = McpData::initials($user->office_id);

        return ['count' => $rows->count(), 'messages' => $rows->map(fn ($m) => McpData::message($m, $ini, $names))->values()];
    }
}
