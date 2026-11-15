<?php

namespace App\Mcp\Tools;

use App\Iratkapu\Audit;
use App\Mcp\McpData;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class GetDocumentText extends IratkapuTool
{
    protected string $name = 'get_document_text';

    protected string $description = 'Egy dokumentum teljes szövege: PDF-ből (szövegrétegből), XML-ből és szöveges fájlból; ES3 e-aktánál és KRX-csomagnál a kibontott fájlok szövege egymás után. Hosszú szöveg lapozva jön: a válasz `next_offset` értékével kérd a folytatást. Beolvasott (kép) PDF-nél csak akkor van szöveg, ha a szövegfelismerés be van kapcsolva.';

    protected bool $audit = false;

    public function schema(JsonSchema $schema): array
    {
        return [
            'document_id' => $schema->integer()->description('A dokumentum azonosítója (get_message vagy search_documents adja).')->required(),
            'offset' => $schema->integer()->description('Ettől a karaktertől (alapból 0).'),
            'limit' => $schema->integer()->description('Legfeljebb ennyi karakter (alapból 20 000, max 60 000).'),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $d = McpData::document($user, (int) $request->get('document_id'));
        $out = McpData::documentText($d);
        $offset = max(0, (int) $request->get('offset', 0));
        $limit = min(60000, max(500, (int) $request->get('limit', 20000)));
        $total = mb_strlen($out['text']);
        $chunk = mb_substr($out['text'], $offset, $limit);
        if ($offset === 0) {
            // Ugyanaz a nyom, mint a felületen a dokumentum megnyitásakor.
            Audit::log($user->office_id, $user, "MCP: dokumentum szövege kiolvasva: {$d->name}", ['client_id' => DB::table('messages')->where('id', $d->message_id)->value('client_id'),
                'message_id' => $d->message_id, 'evidence' => "SHA-256 {$d->sha256}"]);
        }

        return ['document_id' => (int) $d->id, 'name' => $d->name, 'mime' => $d->mime, 'source' => $out['source'],
            'total_length' => $total, 'offset' => $offset, 'next_offset' => $offset + mb_strlen($chunk) < $total ? $offset + mb_strlen($chunk) : null,
            'text' => $chunk];
    }
}
