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
class SearchClients extends IratkapuTool
{
    protected string $name = 'search_clients';

    protected string $description = 'Ügyfelek keresése név vagy adószám szerint (csak azok, akiket a felhasználó láthat). Visszaadja az azonosítót, nevet, adószámot, meghatalmazást, aktív állapotot, a tárhelyeket és a nyitott iratok számát.';

    protected bool $audit = false;

    public function schema(JsonSchema $schema): array
    {
        return [
            'query' => $schema->string()->description('Névrészlet vagy adószám-részlet. Üresen minden látható ügyfél.'),
            'include_inactive' => $schema->boolean()->description('Az inaktív ügyfelek is kellenek-e (alapból nem).'),
            'limit' => $schema->integer()->description('Legfeljebb ennyi találat (alapból 50, max 500).'),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $q = trim((string) $request->get('query', ''));
        $rows = DB::table('clients')->whereIn('id', Scope::clientIds($user))
            ->when(! $request->get('include_inactive'), fn ($x) => $x->where('active', true))
            ->when($q !== '', fn ($x) => $x->where(fn ($w) => $w->where('name', 'like', "%$q%")->orWhere('tax', 'like', "%$q%")))
            ->orderBy('name')->limit(min(500, max(1, (int) $request->get('limit', 50))))->get();
        $boxes = DB::table('mailboxes')->whereIn('client_id', $rows->pluck('id'))->get()->groupBy('client_id');
        $open = DB::table('messages')->whereIn('client_id', $rows->pluck('id'))->where('archived', false)->where('internal', '!=', 'kesz')
            ->selectRaw('client_id, count(*) as n')->groupBy('client_id')->pluck('n', 'client_id');

        return ['count' => $rows->count(), 'clients' => $rows->map(fn ($c) => McpData::client($c) + [
            'mailboxes' => ($boxes[$c->id] ?? collect())->pluck('type')->values(),
            'open_messages' => (int) ($open[$c->id] ?? 0),
        ])->values()];
    }
}
