<?php

namespace App\Mcp\Tools;

use App\Iratkapu\DesktopAlive;
use App\Iratkapu\McpSyncRequests;
use App\Iratkapu\Scope;
use App\Mcp\McpAccess;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;

/** Szinkron indítása MI-ből (ADR-016): kérést ad le, amelyet az asztali app futtat le; ha az app nem fut, ablak nélkül elindítja. */
class StartSync extends IratkapuTool
{
    protected string $name = 'start_sync';

    protected string $description = 'Elindítja a tárhelyek szinkronját (belépés és listázás belépőnként, a letöltési szabályok szerint, naponta egyszer a saját NAV- és ASP-olvasással), pontosan úgy, mint az ütemezett futás. A szinkront az asztali KapuMail futtatja le: zárolt appnál is (a zárolóképernyő fent marad), és ha nem fut, ablak nélkül elindítja. Csak admin vagy vezető felhasználó munka/admin szintű kapcsolata hívhatja. Egyszerre egy kérés lehet, két futás között legalább 15 perc. Az eredmény: `sync_status`.';

    protected string $level = 'munka';

    public function schema(JsonSchema $schema): array
    {
        return [];
    }

    protected function run(Request $request, User $user): array
    {
        if (! Scope::seesAll($user)) {
            abort(403, 'Szinkront csak admin vagy vezető felhasználó kapcsolata indíthat.');
        }
        $info = DesktopAlive::read();
        $alive = DesktopAlive::isAlive($info);
        $res = McpSyncRequests::request(McpAccess::current(), $alive);
        $req = $res['request'];
        $launch = ['tried' => false, 'reason' => null];
        if (! $alive && ($req['status'] ?? null) === 'pending') {
            $launch = DesktopAlive::launch($info);
        }
        $message = match (true) {
            $res['retry_after'] !== null => 'A legutóbbi szinkron nemrég futott le; új kérés ekkortól adható: '.$res['retry_after'].'.',
            ! $res['created'] => 'Már van folyamatban lévő szinkronkérés; ezt figyeld a `sync_status` eszközzel.',
            $alive => 'A kérést leadtam; a futó KapuMail egy percen belül elindítja a szinkront.',
            $launch['tried'] => 'Elindítottam a KapuMailt a háttérben (ablak nélkül); a szinkron pár percen belül indul.',
            default => 'A kérést leadtam, de a KapuMailt nem tudtam elindítani: '.$launch['reason'],
        };

        return ['request_id' => (int) $req['id'], 'status' => $req['status'], 'created' => $res['created'], 'retry_after' => $res['retry_after'],
            'app_running' => $alive, 'launch' => $launch, 'message' => $message];
    }
}
