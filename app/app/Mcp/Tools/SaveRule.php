<?php

namespace App\Mcp\Tools;

use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsDestructive;

#[IsDestructive]
class SaveRule extends IratkapuTool
{
    protected string $name = 'save_rule';

    protected string $description = 'Iratkezelési szabály módosítása (új verzió, a régi megmarad) – admin szint, vezető vagy admin felhasználó, `confirm: true`. Állítható: prioritás (Sürgős, Normál, Alacsony), felelős (monogram), értesítés (Nincs, Felelősnek azonnal, Vezetőnek azonnal, Reggeli összesítő). A zárolt szabálynak csak az értesítése módosítható. A letöltési módot (automatikus letöltés) az MCP nem állítja: annak joghatása miatt a felületen kell dönteni róla.';

    protected string $level = 'admin';

    protected bool $needsConfirm = true;

    public function schema(JsonSchema $schema): array
    {
        return [
            'rule_id' => $schema->integer()->description('A get_settings „rules” listájából.')->required(),
            'priority' => $schema->string()->enum(['Sürgős', 'Normál', 'Alacsony']),
            'assignee' => $schema->string()->description('Monogram; üres = nincs felelős.'),
            'notify' => $schema->string()->enum(['Nincs', 'Felelősnek azonnal', 'Vezetőnek azonnal', 'Reggeli összesítő']),
            'confirm' => $schema->boolean()->description('Csak a felhasználó kifejezett jóváhagyása után legyen true.'),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $rule = DB::table('rules')->where('office_id', $user->office_id)->find((int) $request->get('rule_id'));
        abort_if(! $rule, 404, 'Nincs ilyen szabály.');
        $ini = DB::table('users')->where('office_id', $user->office_id)->pluck('initials', 'id');

        return $this->controller('ruleSave', [
            'pri' => $request->get('priority', $rule->priority),
            'as' => $request->has('assignee') ? $request->get('assignee') : ($ini[$rule->assignee_id] ?? null),
            'notify' => $request->get('notify', $rule->notify),
            'dlMode' => $rule->download_mode ?? 'manual',
        ], (int) $rule->id);
    }
}
