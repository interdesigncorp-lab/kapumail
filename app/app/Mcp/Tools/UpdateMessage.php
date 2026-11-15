<?php

namespace App\Mcp\Tools;

use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;

class UpdateMessage extends IratkapuTool
{
    protected string $name = 'update_message';

    protected string $description = 'Irat belső kezelése, ugyanúgy, mint a felületen (munka szint). Műveletek:
- assign: felelős kijelölése (`to`: monogram);
- status: belső állapot (`to`: uj, oszt, kiosztott, folyamatban, ell, kesz);
- done: kész / újranyitás;
- urgent: sürgős jelölés ki-be;
- archive: belső archívum ki-be;
- label: címke (`to`: szöveg, üres = törlés);
- type: irattípus (`to`: a típus neve a get_settings listájából);
- confirm_deadline: a kinyert határidő megerősítése;
- set_deadline: határidő rögzítése (`to`: ÉÉÉÉ-HH-NN).
Átvételt és letöltést nem indít: az állami oldal felé menő lépéseket ember végzi a felületen.';

    protected string $level = 'munka';

    private const ACTIONS = ['assign' => 'assign', 'status' => 'status', 'done' => 'done', 'urgent' => 'urgent', 'archive' => 'arch', 'label' => 'label',
        'type' => 'type', 'confirm_deadline' => 'confirm', 'set_deadline' => 'deadline'];

    public function schema(JsonSchema $schema): array
    {
        return [
            'message_id' => $schema->integer()->required(),
            'action' => $schema->string()->enum(array_keys(self::ACTIONS))->required(),
            'to' => $schema->string()->description('A művelet értéke, ahol kell.'),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $action = self::ACTIONS[$request->get('action')] ?? null;
        abort_if($action === null, 422, 'Ismeretlen művelet.');

        return $this->controller('messageAction', ['action' => $action, 'to' => $request->get('to')], 'm'.(int) $request->get('message_id'));
    }
}
