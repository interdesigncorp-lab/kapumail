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
class ListDeadlines extends IratkapuTool
{
    protected string $name = 'list_deadlines';

    protected string $description = 'Nyitott határidők és naptárbejegyzések dátum szerint: az iratokból kinyert vagy kézzel rögzített határidők és a NAV adónaptár tételei (az utóbbinál az utalási adatokkal: számlaszám, közlemény). Ugyanez megy ki naptárfájlba és naptármeghívóba. A becsült (nem megerősített) határidő `sure: false`.';

    protected bool $audit = false;

    public function schema(JsonSchema $schema): array
    {
        return [
            'client_id' => $schema->integer()->description('Csak ennek az ügyfélnek a határidői.'),
            'from' => $schema->string()->description('Legkorábbi nap (ÉÉÉÉ-HH-NN). Alapból nincs alsó határ, a lejártak is látszanak.'),
            'to' => $schema->string()->description('Legkésőbbi nap (ÉÉÉÉ-HH-NN).'),
            'sure' => $schema->string()->enum(['all', 'sure', 'est'])->description('all: mind, sure: csak megerősített, est: csak becsült.'),
            'assignee' => $schema->string()->description('Felelős monogramja.'),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $who = $request->get('assignee') ? DB::table('users')->where('office_id', $user->office_id)->where('initials', $request->get('assignee'))->value('id') : null;
        abort_if($request->get('assignee') && ! $who, 422, 'Ismeretlen felelős.');
        $items = DeadlineCalendar::items($user->office_id, Scope::clientIds($user), ['client' => $request->get('client_id'), 'sure' => $request->get('sure', 'all'), 'who' => $who]);
        $items = array_values(array_filter($items, fn ($i) => (! $request->get('from') || $i['date'] >= $request->get('from')) && (! $request->get('to') || $i['date'] <= $request->get('to'))));
        $ini = DB::table('users')->where('office_id', $user->office_id)->pluck('initials', 'id')->all();

        return ['today' => now()->toDateString(), 'count' => count($items), 'items' => array_map(function ($i) use ($ini) {
            $ost = $i['obligation_status'] ?? null;

            return [
                'key' => $i['key'], 'date' => $i['date'], 'client_id' => $i['client_id'], 'client' => $i['client'], 'what' => $i['what'], 'sure' => $i['sure'], 'note' => $i['note'],
                'kind' => $i['cat'], 'form_code' => $i['form_code'] ?? null, 'obligation_status' => $ost,
                'obligation_status_label' => $ost !== null ? (McpData::OBLIGATION_STATUS[$ost] ?? $ost) : null,
                'assignee' => $ini[$i['who']] ?? null, 'origin' => $i['origin'], 'source' => $i['source'], 'excerpt' => $i['excerpt'], 'payment' => $i['pay'],
                'message_id' => str_starts_with($i['key'], 'm') ? (int) substr($i['key'], 1) : ($i['receipt_message_id'] ?? null),
            ];
        }, $items)];
    }
}
