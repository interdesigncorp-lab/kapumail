<?php

namespace App\Mcp\Tools;

use App\Iratkapu\Scope;
use App\Mcp\McpData;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class SearchDocuments extends IratkapuTool
{
    protected string $name = 'search_documents';

    protected string $description = 'Teljes szövegű keresés az iratok dokumentumaiban (PDF, XML, ES3-ből kibontott fájlok szövege és fájlneve) és az iratok tárgyában. Ékezet és kis-nagybetű nem számít; több szó esetén mindegyiknek szerepelnie kell. Visszaadja a találat környezetét, a dokumentum és az irat azonosítóját.';

    protected bool $audit = false;

    public function schema(JsonSchema $schema): array
    {
        return [
            'query' => $schema->string()->description('Keresett szavak, például „végzés 2025 áfa” vagy egy vonalkód.')->required(),
            'client_id' => $schema->integer()->description('Csak ennek az ügyfélnek az irataiban.'),
            'limit' => $schema->integer()->description('Alapból 20, max 100.'),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $cids = Scope::clientIds($user);
        if ($request->get('client_id')) {
            $cids = array_values(array_intersect($cids, [(int) $request->get('client_id')]));
        }
        $limit = min(100, max(1, (int) $request->get('limit', 20)));
        $words = array_values(array_filter(preg_split('/\s+/u', trim((string) $request->get('query'))), fn ($w) => $w !== ''));
        abort_if(! $words, 422, 'Adj meg legalább egy keresőszót.');
        $mids = DB::table('messages')->whereIn('client_id', $cids)->pluck('id');
        // Szókezdet-egyezés: a magyar szavak toldalékolnak („meghagyás” → „meghagyásban”), és a kinyert szövegben
        // a szomszédos mezők néha egybeolvadnak.
        $match = implode(' ', array_map(fn ($w) => '"'.str_replace('"', '""', $w).'"*', $words));
        $docs = DB::table('documents_fts')->join('documents', 'documents.id', '=', 'documents_fts.rowid')
            ->whereRaw('documents_fts MATCH ?', [$match])->whereIn('documents.message_id', $mids)
            ->orderByRaw('rank')->limit($limit)
            ->get(['documents.id', 'documents.name', 'documents.message_id', DB::raw("snippet(documents_fts, 1, '[', ']', ' … ', 24) as excerpt")]);
        $subjects = DB::table('messages')->whereIn('client_id', $cids)
            ->where(function ($q) use ($words) {
                foreach ($words as $w) {
                    $q->where(fn ($x) => $x->where('subject', 'like', "%$w%")->orWhere('barcode', 'like', "%$w%")->orWhere('form_code', 'like', "%$w%"));
                }
            })->orderByDesc('arrived_at')->limit($limit)->get();
        $names = DB::table('clients')->whereIn('id', $cids)->pluck('name', 'id')->all();
        $msg = DB::table('messages')->whereIn('id', $docs->pluck('message_id'))->get()->keyBy('id');
        $ini = McpData::initials($user->office_id);

        return [
            'document_hits' => $docs->map(fn ($d) => ['document_id' => (int) $d->id, 'name' => $d->name, 'message_id' => (int) $d->message_id,
                'subject' => $msg[$d->message_id]->subject ?? null, 'client' => $names[$msg[$d->message_id]->client_id ?? 0] ?? null, 'excerpt' => $d->excerpt])->values(),
            'message_hits' => $subjects->map(fn ($m) => McpData::message($m, $ini, $names))->values(),
        ];
    }
}
