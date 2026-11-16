<?php

namespace App\Mcp\Tools;

use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsDestructive;

#[IsDestructive]
class ManageClient extends IratkapuTool
{
    protected string $name = 'manage_client';

    protected string $description = 'Ügyfél adatainak kezelése (vezető vagy admin felhasználó). Műveletek:
- set_handlers: kezelő könyvelők (`users`: monogramok listája; a lista a teljes új állapot);
- set_active: aktív / inaktív (`active`);
- add_contact: kapcsolattartó / értesítési cím (`name`, `email`, `role`);
- contact_calendar: kapjon-e a kapcsolattartó naptármeghívót (`contact_id`, `on`).
Új ügyfél és tárhely felvétele a felületen történik, mert szinkront indít.';

    protected string $level = 'admin';

    protected bool $needsConfirm = true;

    public function schema(JsonSchema $schema): array
    {
        return [
            'action' => $schema->string()->enum(['set_handlers', 'set_active', 'add_contact', 'contact_calendar'])->required(),
            'client_id' => $schema->integer()->required(),
            'users' => $schema->array()->items($schema->string()),
            'active' => $schema->boolean(),
            'name' => $schema->string(), 'email' => $schema->string(), 'role' => $schema->string()->description('Például ügyvezető, pénzügy.'),
            'contact_id' => $schema->integer(), 'on' => $schema->boolean(),
            'confirm' => $schema->boolean()->description('Csak a felhasználó kifejezett jóváhagyása után legyen true.'),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $cid = 'c'.(int) $request->get('client_id');

        return match ($request->get('action')) {
            'set_handlers' => $this->controller('clientUsers', ['users' => (array) $request->get('users', [])], $cid),
            'set_active' => $this->controller('setClientActive', ['active' => (bool) $request->get('active')], $cid),
            'add_contact' => $this->controller('addContact', ['name' => $request->get('name'), 'email' => $request->get('email'), 'role' => $request->get('role')], $cid),
            'contact_calendar' => $this->contactCalendar($request, $user),
            default => abort(422, 'Ismeretlen művelet.'),
        };
    }

    /** @return array<mixed> */
    private function contactCalendar(Request $request, User $user): array
    {
        $ok = \Illuminate\Support\Facades\DB::table('client_contacts')->where('id', (int) $request->get('contact_id'))->where('client_id', (int) $request->get('client_id'))->exists();
        abort_if(! $ok, 404, 'Ennél az ügyfélnél nincs ilyen kapcsolattartó.');

        return $this->controller('contactCalendar', ['on' => (bool) $request->get('on')], (int) $request->get('contact_id'));
    }
}
