<?php

namespace App\Mcp\Tools;

use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;

class SetTaskDone extends IratkapuTool
{
    protected string $name = 'set_task_done';

    protected string $description = 'Teendő késznek jelölése vagy újranyitása.';

    protected string $level = 'munka';

    public function schema(JsonSchema $schema): array
    {
        return [
            'task_id' => $schema->integer()->required(),
            'done' => $schema->boolean()->required(),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        return $this->controller('toggleTask', ['done' => (bool) $request->get('done')], (int) $request->get('task_id'));
    }
}
