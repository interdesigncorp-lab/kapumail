<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\URL;
use Symfony\Component\HttpFoundation\Response;

/**
 * A KapuMail MCP-közvetítőn át érkező kérések (ADR-013). Ezeket az asztali app továbbítja a saját gépéről, ezért
 * 127.0.0.1-ről jönnek – a program mégsem bízhat bennük úgy, mint a helyi felületben. Ha a kérésen ott a közvetítő
 * fejléce, csak az MCP, az OAuth és a párosítás útvonalai élnek; minden más (a felület, az /api/*, a /local/enter) 403.
 * Az URL-ek a közvetítő nyilvános címére állnak, a munkamenet-süti pedig az adott kapcsolat útvonalára és HTTPS-re.
 */
class RelayGuard
{
    public const HEADER = 'X-KapuMail-Relay-Base';

    /** @var list<array{0: string, 1: list<string>, 2: bool}> útvonal, metódusok, előtag-e (egyezzen a relay/routes.js listájával) */
    private const ALLOWED = [
        ['/mcp', ['POST', 'GET', 'DELETE'], false],
        ['/.well-known/oauth-authorization-server', ['GET'], true],
        ['/.well-known/oauth-protected-resource', ['GET'], true],
        ['/.well-known/openid-configuration', ['GET'], false],
        ['/oauth/register', ['POST'], false],
        ['/oauth/authorize', ['GET', 'POST', 'DELETE'], false],
        ['/oauth/token', ['POST'], false],
        ['/mcp-connect', ['GET', 'POST'], true],
        ['/login', ['GET'], false],
    ];

    public static function allowed(string $method, string $path): bool
    {
        if (str_contains($path, '..') || str_contains($path, '//')) {
            return false;
        }
        foreach (self::ALLOWED as [$p, $methods, $prefix]) {
            $hit = $prefix ? ($path === $p || str_starts_with($path, $p.'/')) : $path === $p;
            if ($hit && in_array($method, $methods, true)) {
                return true;
            }
        }

        return false;
    }

    public static function isRelayed(Request $request): bool
    {
        return (bool) $request->attributes->get('kapumail_relay', false);
    }

    public function handle(Request $request, Closure $next): Response
    {
        $base = $request->headers->get(self::HEADER);
        if ($base === null) {
            return $next($request);
        }
        $pattern = '~^'.preg_quote(rtrim((string) config('mcp.relay_url'), '/'), '~').'/[A-Za-z0-9_-]{22}$~';
        if (! in_array($request->ip(), ['127.0.0.1', '::1'], true) || ! preg_match($pattern, $base)) {
            return response()->json(['error' => 'Érvénytelen közvetített kérés.'], 403);
        }
        $method = $request->getMethod() === 'HEAD' ? 'GET' : $request->getMethod();
        $path = $request->getPathInfo();
        if (! self::allowed($method, $path)) {
            return response()->json(['error' => 'Ez az útvonal a közvetítőn át nem érhető el.'], 403);
        }

        $saved = config()->getMany(['session.secure', 'session.path', 'session.cookie']);
        URL::forceRootUrl($base);
        URL::forceScheme('https');
        config(['session.secure' => true, 'session.path' => (string) parse_url($base, PHP_URL_PATH), 'session.cookie' => 'kapumail_relay_session']);
        $request->attributes->set('kapumail_relay', true);
        try {
            // Jelszó nélküli helyi fiók: a bejelentkezés helyett a párosító oldal jön (kód a KapuMail beállításaiból).
            if ($path === '/login') {
                return redirect()->to(url('/mcp-connect'));
            }

            $response = $next($request);
            // Amit a program a kérés saját (helyi) címéből épít – például a Passport a megszakított engedélyezés címét –,
            // az a helyi gép címére mutatna; a böngészőnek a közvetítő nyilvános címét kell kapnia.
            $local = $request->getSchemeAndHttpHost();
            $location = (string) $response->headers->get('Location', '');
            if ($location !== '' && str_starts_with($location, $local)) {
                $response->headers->set('Location', $base.substr($location, strlen($local)));
            }

            return $response;
        } finally {
            // Hosszan futó folyamatban (és tesztben) a következő, nem közvetített kérés ne örökölje a közvetítő címét.
            URL::forceRootUrl(null);
            URL::forceScheme(null);
            config($saved);
        }
    }
}
