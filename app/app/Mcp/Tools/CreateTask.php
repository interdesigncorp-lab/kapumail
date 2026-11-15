<?php

namespace App\Mcp\Tools;

use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;

class CreateTask extends IratkapuTool
{
    protected string $name = 'create_task';

    protected string $description = 'Teendő felvétele egy irathoz a kapcsolat gazdájának nevében (munka szint).';

    protected string $level = 'munka';

    public function schema(JsonSchema $schema): array
    {
        return [
            'message_id' => $schema->integer()->required(),
            'title' => $schema->string()->description('A teendő, legfeljebb 200 karakter.')->required(),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        return $this->controller('addTask', ['title' => $request->get('title')], 'm'.(int) $request->get('message_id'));
    }
}
