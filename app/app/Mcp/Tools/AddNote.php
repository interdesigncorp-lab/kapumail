<?php

namespace App\Mcp\Tools;

use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;

class AddNote extends IratkapuTool
{
    protected string $name = 'add_note';

    protected string $description = 'Belső jegyzet egy irathoz a kapcsolat gazdájának nevében (munka szint). Az ügyfél nem látja.';

    protected string $level = 'munka';

    public function schema(JsonSchema $schema): array
    {
        return [
            'message_id' => $schema->integer()->required(),
            'text' => $schema->string()->description('Legfeljebb 2000 karakter.')->required(),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        return $this->controller('addNote', ['body' => $request->get('text')], 'm'.(int) $request->get('message_id'));
    }
}
