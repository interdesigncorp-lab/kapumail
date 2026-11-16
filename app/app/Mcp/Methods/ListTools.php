<?php

namespace App\Mcp\Methods;

use App\Mcp\McpAccess;
use App\Mcp\Tools\IratkapuTool;
use Laravel\Mcp\Server\Contracts\Method;
use Laravel\Mcp\Server\Pagination\CursorPaginator;
use Laravel\Mcp\Server\ServerContext;
use Laravel\Mcp\Transport\JsonRpcRequest;
use Laravel\Mcp\Transport\JsonRpcResponse;

/**
 * Jogosultság alapú tools/list kezelő (ADR-012, R2).
 *
 * Csak azokat az MCP-eszközöket listázza ki, amelyek meghívására az adott kapcsolat szintje
 * (kapu, olvasas, munka, admin) fel van jogosítva. Ez csökkenti a prompt tokenméretét és
 * megelőzi a sikertelen hívásokat.
 */
class ListTools implements Method
{
    public function handle(JsonRpcRequest $request, ServerContext $context): JsonRpcResponse
    {
        $request->validate([
            'cursor' => ['nullable', 'string'],
            'per_page' => ['nullable', 'integer:strict', 'min:1'],
        ]);

        $tools = $context->tools();
        $access = McpAccess::current();

        if ($access !== null) {
            $tools = $tools->filter(
                fn ($tool) => ! ($tool instanceof IratkapuTool) || $access->allowsTool($tool->name(), $tool->level())
            )->values();
        }

        $paginator = new CursorPaginator(
            items: $tools,
            perPage: $context->perPage($request->get('per_page')),
            cursor: $request->cursor(),
        );

        return JsonRpcResponse::result($request->id, $paginator->paginate('tools'));
    }
}
