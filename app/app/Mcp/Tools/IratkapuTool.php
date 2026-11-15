<?php

namespace App\Mcp\Tools;

use App\Http\Controllers\AppController;
use App\Iratkapu\Audit;
use App\Mcp\McpAccess;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request as HttpRequest;
use Illuminate\Validation\ValidationException;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tool;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

/**
 * Közös alap az Iratkapu MCP-eszközeinek (ADR-012): hozzáférés és szint ellenőrzése, naplózás, hibák emberi nyelven.
 * Az író eszközök a felület vezérlőmetódusait hívják a kapcsolat gazdájának nevében, így ugyanaz a jogosultság-ellenőrzés fut.
 */
abstract class IratkapuTool extends Tool
{
    /** A futtatáshoz szükséges szint: olvasas | munka | admin. */
    protected string $level = 'olvasas';

    /** Kockázatos művelet: `confirm: true` nélkül csak előnézetet ad. */
    protected bool $needsConfirm = false;

    /** Az olvasó eszközök hívását is naplózzuk, de a napló a felületen ne teljen meg: a gyakori listázók nem kerülnek bele. */
    protected bool $audit = true;

    /**
     * Az eszköz tényleges munkája. Szöveget vagy JSON-ná alakítható tömböt ad vissza.
     *
     * @return array<mixed>|string
     */
    abstract protected function run(Request $request, User $user): array|string;

    public function handle(Request $request): Response
    {
        $access = McpAccess::current();
        if ($access === null) {
            return Response::error('Nincs érvényes MCP-hozzáférés: a token hiányzik, lejárt vagy vissza lett vonva, vagy az irodánál ki van kapcsolva az AI-kapcsolat.');
        }
        if (! $access->allowsTool($this->name(), $this->level)) {
            if ($access->level === 'kapu') {
                return Response::error('Kapu ezt nem teheti meg: csak olvasni, hivatkozni és beállítást módosítani tud.');
            }
            return Response::error('Ehhez az eszközhöz „'.McpAccess::LEVEL_NAMES[$this->level].'” szintű kapcsolat kell; ez a kapcsolat „'.McpAccess::LEVEL_NAMES[$access->level].'” szintű. A szintet admin állíthatja a Beállítások → AI-kapcsolat (MCP) lapon.');
        }
        if ($this->needsConfirm && $request->get('confirm') !== true) {
            return Response::json(['preview' => true, 'message' => 'Ez a művelet módosít. Mutasd meg a felhasználónak, mi fog történni, és csak az ő kifejezett jóváhagyása után hívd újra `confirm: true` értékkel.', 'would_do' => $this->preview($request)]);
        }
        try {
            $out = $this->run($request, $access->user);
        } catch (ValidationException $e) {
            return Response::error('Hibás adat: '.implode(' ', $e->validator->errors()->all()));
        } catch (HttpExceptionInterface $e) {
            $msg = $e->getMessage() !== '' ? $e->getMessage() : match ($e->getStatusCode()) {
                403 => 'Ehhez a felhasználó szerepköre nem ad jogot.',
                404 => 'Nem található, vagy a felhasználó nem láthatja.',
                default => 'A művelet nem hajtható végre.',
            };

            return Response::error($msg);
        }
        if ($this->audit) {
            Audit::log($access->user->office_id, $access->user, "MCP: {$this->name()} ({$access->label})");
        }

        return is_string($out) ? Response::text($out) : Response::json($out);
    }

    /**
     * Mit tenne az eszköz `confirm: true` mellett (a kockázatos műveletek előnézete).
     *
     * @return array<string, mixed>
     */
    protected function preview(Request $request): array
    {
        return array_diff_key($request->all(), ['confirm' => true]);
    }

    /**
     * A felület vezérlőmetódusának hívása a kapcsolat gazdájának nevében.
     *
     * @param  array<string, mixed>|null  $input  null: a metódus nem kap kérést (például a tesztlevél)
     * @return array<mixed>
     */
    protected function controller(string $method, ?array $input = [], mixed ...$args): array
    {
        if ($input !== null) {
            $request = HttpRequest::create('/mcp-call', 'POST', $input);
            $request->setUserResolver(fn () => McpAccess::current()?->user);
            array_unshift($args, $request);
        }
        $out = app(AppController::class)->{$method}(...$args);
        if ($out instanceof JsonResponse) {
            return (array) $out->getData(true);
        }

        return is_array($out) ? $out : ['ok' => true];
    }
}
