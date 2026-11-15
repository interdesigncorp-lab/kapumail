<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\AppController;
use App\Iratkapu\Scope;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class ListUsers extends IratkapuTool
{
    protected string $name = 'list_users';

    protected string $description = 'Az iroda munkatársai: monogram, név, e-mail, szerepkör (admin, vezeto = vezető, konyvelo = könyvelő), és hogy hány ügyfélnek kezelője. Vezető és admin minden munkatárs ügyfeleit látja.';

    protected bool $audit = false;

    public function schema(JsonSchema $schema): array
    {
        return [];
    }

    protected function run(Request $request, User $user): array
    {
        $counts = DB::table('client_user')->join('clients', 'clients.id', '=', 'client_user.client_id')->where('clients.office_id', $user->office_id)
            ->selectRaw('client_user.user_id, count(*) as n')->groupBy('client_user.user_id')->pluck('n', 'user_id');

        return ['me' => $user->initials, 'roles' => ['admin' => 'mindent lát és beállít, munkatársat vehet fel', 'vezeto' => 'minden ügyfelet lát, beállíthat', 'konyvelo' => 'csak a hozzá rendelt ügyfeleket látja'],
            'users' => DB::table('users')->where('office_id', $user->office_id)->orderBy('id')->get()->map(fn ($p) => ['initials' => $p->initials, 'name' => $p->name,
                'email' => $p->email === AppController::LOCAL_EMAIL ? null : $p->email, 'role' => $p->role,
                'client_count' => Scope::seesAll($user) || $p->id === $user->id ? (int) ($counts[$p->id] ?? 0) : null])->values()];
    }
}
