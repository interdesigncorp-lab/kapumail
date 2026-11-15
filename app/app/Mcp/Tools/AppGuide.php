<?php

namespace App\Mcp\Tools;

use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class AppGuide extends IratkapuTool
{
    protected string $name = 'app_guide';

    protected string $description = 'Súgó a programhoz: melyik menü mire való, mit csinálnak a gombok és funkciók, mik a fogalmak (átvétel, ES3, meghatalmazás, adónaptár stb.), és mit tud az AI-kapcsolat. Téma nélkül a tartalomjegyzéket adja; téma kulccsal vagy szóval a részleteket.';

    protected bool $audit = false;

    public function schema(JsonSchema $schema): array
    {
        return [
            'topic' => $schema->string()->description('Téma kulcsa a tartalomjegyzékből (például „cal”, „settings.portals”), vagy keresett szó (például „átvétel”).'),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $guide = json_decode((string) file_get_contents(resource_path('mcp/ui-guide.json')), true) ?: ['topics' => []];
        $topics = $guide['topics'];
        $topic = trim((string) $request->get('topic', ''));
        if ($topic === '') {
            return ['intro' => $guide['intro'] ?? '', 'topics' => array_map(fn ($t) => ['key' => $t['key'], 'title' => $t['title'], 'summary' => $t['summary']], $topics)];
        }
        foreach ($topics as $t) {
            if ($t['key'] === $topic) {
                return $t;
            }
        }
        $needle = mb_strtolower($topic);
        $hits = array_values(array_filter($topics, fn ($t) => str_contains(mb_strtolower(json_encode($t, JSON_UNESCAPED_UNICODE)), $needle)));

        return $hits ? ['matches' => $hits] : ['matches' => [], 'hint' => 'Nincs ilyen téma. Hívd téma nélkül a tartalomjegyzékért.'];
    }
}
