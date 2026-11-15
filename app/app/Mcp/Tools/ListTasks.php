<?php

namespace App\Mcp\Tools;

use App\Iratkapu\Scope;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class ListTasks extends IratkapuTool
{
    protected string $name = 'list_tasks';

    protected string $description = 'Teendők (az iratokhoz felvett feladatok) listája: alapból a nyitottak, ügyfélre vagy felelősre szűrhetően.';

    protected bool $audit = false;

    public function schema(JsonSchema $schema): array
    {
        return [
            'client_id' => $schema->integer(),
            'assignee' => $schema->string()->description('A teendőt felvevő munkatárs monogramja.'),
            'include_done' => $schema->boolean()->description('A kész teendők is kellenek-e.'),
            'limit' => $schema->integer()->description('Alapból 100, max 500.'),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $cids = Scope::clientIds($user);
        if ($request->get('client_id')) {
            $cids = array_values(array_intersect($cids, [(int) $request->get('client_id')]));
        }
        $ini = DB::table('users')->where('office_id', $user->office_id)->pluck('initials', 'id')->all();
        $rows = DB::table('tasks')->join('messages', 'messages.id', '=', 'tasks.message_id')->join('clients', 'clients.id', '=', 'messages.client_id')
            ->whereIn('messages.client_id', $cids)
            ->when(! $request->get('include_done'), fn ($q) => $q->where('tasks.done', false))
            ->when($request->get('assignee'), fn ($q, $k) => $q->where('tasks.user_id', array_search($k, $ini, true) ?: 0))
            ->orderBy('tasks.done')->orderByDesc('tasks.id')->limit(min(500, max(1, (int) $request->get('limit', 100))))
            ->get(['tasks.*', 'messages.subject', 'messages.deadline_date', 'clients.name as client', 'clients.id as client_id']);

        return ['count' => $rows->count(), 'tasks' => $rows->map(fn ($t) => ['id' => (int) $t->id, 'title' => $t->title, 'done' => (bool) $t->done, 'who' => $ini[$t->user_id] ?? null,
            'message_id' => (int) $t->message_id, 'subject' => $t->subject, 'client_id' => (int) $t->client_id, 'client' => $t->client,
            'deadline' => $t->deadline_date ? substr((string) $t->deadline_date, 0, 10) : null, 'created_at' => $t->created_at])->values()];
    }
}
