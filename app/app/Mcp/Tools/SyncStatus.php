<?php

namespace App\Mcp\Tools;

use App\Iratkapu\DesktopAlive;
use App\Iratkapu\McpSyncRequests;
use App\Iratkapu\Scope;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;

/** Az MI-ből indított szinkron állapota (ADR-016): függő, fut, kész, sikertelen vagy lejárt, a megjegyzéssel. */
class SyncStatus extends IratkapuTool
{
    protected string $name = 'sync_status';

    protected string $description = 'Az MI-ből (`start_sync`) indított szinkronkérés állapota: pending (vár az asztali appra), running, done, failed vagy expired, rövid megjegyzéssel (pl. hány belépő, hiba oka). `request_id` nélkül az iroda legutóbbi kérését adja.';

    protected bool $audit = false;

    public function schema(JsonSchema $schema): array
    {
        return ['request_id' => $schema->integer()];
    }

    protected function run(Request $request, User $user): array|string
    {
        $alive = DesktopAlive::isAlive(DesktopAlive::read());
        $id = $request->get('request_id');
        $r = McpSyncRequests::find((int) $user->office_id, $id !== null ? (int) $id : null, $alive);
        if ($r === null) {
            return 'Még nem volt MI-ből indított szinkronkérés.';
        }

        return ['request_id' => (int) $r['id'], 'status' => $r['status'], 'note' => Scope::seesAll($user) ? ($r['note'] ?? null) : null, // a megjegyzés ügyfélneveket tartalmazhat 'created_at' => $r['created_at'] ?? null,
            'started_at' => $r['started_at'] ?? null, 'finished_at' => $r['finished_at'] ?? null, 'app_running' => $alive];
    }
}
