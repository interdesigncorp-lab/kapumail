<?php

namespace App\Mcp\Tools;

use App\Iratkapu\Audit;
use App\Iratkapu\OfficeMail;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsDestructive;

#[IsDestructive]
class ManageUsers extends IratkapuTool
{
    protected string $name = 'manage_users';

    protected string $description = 'Munkatársak kezelése (admin szerepkörű felhasználó). Műveletek: invite (új munkatárs: név, e-mail, szerepkör; jelszót a belépési oldalon állít be), set_role (szerepkör módosítása monogram alapján). Szerepkörök: admin, vezeto, konyvelo. Helyi (egygépes) módban nincs több munkatárs. Ügyfelek kezelőit a set_client_handlers állítja.';

    protected string $level = 'admin';

    protected bool $needsConfirm = true;

    public function schema(JsonSchema $schema): array
    {
        return [
            'action' => $schema->string()->enum(['invite', 'set_role'])->required(),
            'name' => $schema->string()->description('invite: teljes név.'),
            'email' => $schema->string()->description('invite: e-mail-cím.'),
            'initials' => $schema->string()->description('set_role: a munkatárs monogramja (list_users adja).'),
            'role' => $schema->string()->enum(['admin', 'vezeto', 'konyvelo'])->required(),
            'confirm' => $schema->boolean()->description('Csak a felhasználó kifejezett jóváhagyása után legyen true.'),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        if ($request->get('action') === 'invite') {
            return $this->controller('invite', ['name' => $request->get('name'), 'email' => $request->get('email'), 'role' => $request->get('role')]);
        }
        abort_if($user->role !== 'admin', 403, 'Szerepkört csak admin módosíthat.');
        abort_if(! empty(OfficeMail::settings($user->office_id)['local']), 403, 'A helyi (egygépes) módban nincs több munkatárs.');
        $role = (string) $request->get('role');
        abort_if(! in_array($role, ['admin', 'vezeto', 'konyvelo'], true), 422, 'Ismeretlen szerepkör.');
        $target = DB::table('users')->where('office_id', $user->office_id)->where('initials', $request->get('initials'))->first();
        abort_if(! $target, 404, 'Nincs ilyen monogramú munkatárs.');
        $admins = DB::table('users')->where('office_id', $user->office_id)->where('role', 'admin')->count();
        abort_if($target->role === 'admin' && $role !== 'admin' && $admins <= 1, 422, 'Az iroda utolsó adminjának szerepköre nem vehető el.');
        DB::table('users')->where('id', $target->id)->update(['role' => $role, 'updated_at' => now()]);
        Audit::log($user->office_id, $user, "Szerepkör módosítva: {$target->name} ({$target->role} → $role)", ['before' => $target->role, 'after' => $role]);

        return ['ok' => true, 'user' => $target->initials, 'role' => $role];
    }
}
