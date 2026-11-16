<?php

namespace App\Mcp\Tools;

use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsDestructive;

#[IsDestructive]
class ConfigureSmtp extends IratkapuTool
{
    protected string $name = 'configure_smtp';

    protected string $description = 'Az iroda e-mail küldése (SMTP). Műveletek: save (beállítás mentése; üres jelszónál a korábbi marad), test (tesztlevél a kapcsolat gazdájának címére), delete (beállítás törlése). A jelszót a felhasználónak magának kell beírnia a felületen; ha mégis itt adja meg, titkosítva tárolódik, és válaszban soha nem jön vissza.';

    protected string $level = 'admin';

    protected bool $needsConfirm = true;

    public function schema(JsonSchema $schema): array
    {
        return [
            'action' => $schema->string()->enum(['save', 'test', 'delete'])->required(),
            'host' => $schema->string(), 'port' => $schema->integer(), 'encryption' => $schema->string()->enum(['starttls', 'ssl']),
            'username' => $schema->string(), 'password' => $schema->string(), 'from' => $schema->string()->description('Feladó e-mail-címe.'),
            'from_name' => $schema->string(),
            'confirm' => $schema->boolean()->description('Csak a felhasználó kifejezett jóváhagyása után legyen true.'),
        ];
    }

    protected function preview(Request $request): array
    {
        $p = parent::preview($request);
        if (isset($p['password'])) {
            $p['password'] = '(megadva, nem jelenik meg)';
        }

        return $p;
    }

    protected function run(Request $request, User $user): array
    {
        return match ($request->get('action')) {
            'save' => $this->controller('saveSmtp', ['host' => $request->get('host'), 'port' => $request->get('port'), 'enc' => $request->get('encryption', 'starttls'),
                'username' => $request->get('username'), 'password' => $request->get('password'), 'from' => $request->get('from'), 'fromName' => $request->get('from_name')]),
            'test' => $this->controller('testSmtp', null),
            'delete' => $this->controller('deleteSmtp', null),
            default => abort(422, 'Ismeretlen művelet.'),
        };
    }
}
