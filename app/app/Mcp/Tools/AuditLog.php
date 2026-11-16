<?php

namespace App\Mcp\Tools;

use App\Iratkapu\Scope;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class AuditLog extends IratkapuTool
{
    protected string $name = 'audit_log';

    protected string $description = 'Az iroda csak bővíthető eseménynaplója (ki, mikor, mit csinált), a legfrissebb elöl; ugyanaz, mint a felületen a Beállítások → Auditnapló lapon. Vezető és admin mindent lát, könyvelő a saját ügyfeleiét és a saját lépéseit.';

    protected bool $audit = false;

    public function schema(JsonSchema $schema): array
    {
        return [
            'client_id' => $schema->integer(),
            'contains' => $schema->string()->description('Szövegrészlet az esemény leírásában, például „MCP” vagy „Belépés”.'),
            'limit' => $schema->integer()->description('Alapból 50, max 300.'),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $cids = Scope::clientIds($user);
        $rows = DB::table('audit_events')->where('office_id', $user->office_id)
            ->when(Scope::seesAll($user), fn ($q) => $q->where(fn ($w) => $w->whereNull('client_id')->orWhereNotIn('client_id', Scope::foreignOwnClientIds($user))),
                fn ($q) => $q->where(fn ($w) => $w->whereIn('client_id', $cids)->orWhere('actor_id', $user->id)))
            ->when($request->get('client_id'), fn ($q, $c) => $q->where('client_id', (int) $c))
            ->when($request->get('contains'), fn ($q, $s) => $q->where('action', 'like', "%$s%"))
            ->orderByDesc('id')->limit(min(300, max(1, (int) $request->get('limit', 50))))->get();
        $names = DB::table('clients')->whereIn('id', $rows->pluck('client_id')->filter()->unique())->pluck('name', 'id');

        return ['events' => $rows->map(fn ($a) => ['at' => \Carbon\Carbon::parse($a->at_utc, 'UTC')->setTimezone(config('app.timezone'))->format('Y-m-d H:i'),
            'who' => $a->actor_label, 'what' => $a->action, 'client' => $names[$a->client_id] ?? null, 'message_id' => $a->message_id,
            'evidence' => $a->evidence, 'policy' => $a->policy])->values()];
    }
}
