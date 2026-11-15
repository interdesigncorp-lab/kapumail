<?php

namespace App\Http\Middleware;

use App\Mcp\McpAccess;
use App\Models\User;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Server\Registrar;
use Symfony\Component\HttpFoundation\Response;

/**
 * Az MCP HTTP-végpont hitelesítése (ADR-012): személyes MCP-token (`ik_…`) vagy Passport OAuth-hozzáférési token
 * `mcp:use` hatókörrel. Siker esetén a kérés a token gazdájának nevében fut, a token szintjén.
 */
class McpAuthenticate
{
    public function handle(Request $request, Closure $next): Response
    {
        McpAccess::forget();
        $bearer = (string) $request->bearerToken();
        $access = null;
        if (str_starts_with($bearer, 'ik_')) {
            $access = McpAccess::fromToken($bearer);
        } elseif ($bearer !== '') {
            $user = Auth::guard('api')->user();
            if ($user instanceof User && $user->tokenCan(Registrar::OAUTH_SCOPE)) {
                $clientId = (string) $user->token()->oauth_client_id;
                $clientName = (string) (DB::table('oauth_clients')->where('id', $clientId)->value('name') ?? 'OAuth-kliens');
                $access = McpAccess::fromOAuth($user, $clientId, $clientName);
            }
        }
        if ($access === null) {
            return response()->json(['error' => 'unauthorized', 'error_description' => 'Érvényes MCP-token vagy OAuth-bejelentkezés kell, és az irodánál be kell kapcsolni az AI-kapcsolatot.'], 401);
        }
        McpAccess::activate($access);

        return $next($request);
    }
}
