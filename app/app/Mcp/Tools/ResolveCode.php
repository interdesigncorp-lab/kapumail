<?php

namespace App\Mcp\Tools;

use App\Iratkapu\FormCatalog;
use App\Iratkapu\OnlineSzamlaCodes;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class ResolveCode extends IratkapuTool
{
    protected string $name = 'resolve_code';

    protected string $description = 'Nyomtatvány- és adókód feloldása: hivatalos NAV Online Számla 3.0 ÁFA- és mentességi kódok (pl. EUFAD37, EUFADE, ATK, HO, KBAET, KBAUK, EAM, NAM_1, NAM_2, AAM, TAM, FAD) jogszabályhellyel és bevallási kapcsolatokkal, valamint hazai nyomtatványkatalógus (FormCatalog, pl. 2608, 26A60, 2665, HIPA, HIPAK).';

    protected string $level = 'olvasas';

    protected bool $audit = false;

    public function schema(JsonSchema $schema): array
    {
        return [
            'code' => $schema->string()->description('A feloldandó nyomtatvány- vagy adókód (pl. EUFAD37, KBAET, FAD, 2608, 26A60, HIPAK).')->required(),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $rawCode = trim((string) $request->get('code', ''));
        $taxCode = OnlineSzamlaCodes::resolve($rawCode);
        $form = FormCatalog::resolveForm($rawCode);

        return [
            'found' => ($taxCode !== null || $form !== null),
            'code' => $rawCode,
            'tax_code' => $taxCode,
            'form' => $form,
        ];
    }
}
