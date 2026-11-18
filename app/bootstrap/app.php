<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

$app = Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // A helyi mód belépését az asztali alkalmazás főfolyamata hívja, űrlap nélkül; a kérést a kulcstartóban őrzött titok hitelesíti.
        $middleware->validateCsrfTokens(except: ['local/enter']);
        // MCP-közvetítő (ADR-013): a közvetített kéréseket minden más előtt szűri, a munkamenet indulása előtt.
        $middleware->prepend(\App\Http\Middleware\RelayGuard::class);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();

// Csomagolt asztali alkalmazásban a programkönyvtár csak olvasható (macOS aláírás, Windows telepítő),
// ezért a helyi környezet (.env) és a tárhely (storage/) a felhasználó saját adatmappájában él.
if (is_string($envDir = getenv('IRATKAPU_ENV_DIR') ?: null) && $envDir !== '') {
    $app->useEnvironmentPath($envDir);
}
if (is_string($storageDir = getenv('IRATKAPU_STORAGE_PATH') ?: null) && $storageDir !== '') {
    $app->useStoragePath($storageDir);
}
// Windowson a meghajtóbetűs útvonalat (C:\...) a Laravel nem tekinti abszolútnak (csak a / és \ kezdetűt),
// ezért az adatmappába irányított gyorsítótárfájlok elé odafűzné a programkönyvtárat, és már a migráció
// előtt elbukna („The C:\...\app-server\C:\...\cache directory must be present and writable”).
foreach (['APP_SERVICES_CACHE', 'APP_PACKAGES_CACHE', 'APP_CONFIG_CACHE', 'APP_ROUTES_CACHE', 'APP_EVENTS_CACHE'] as $cacheKey) {
    if (is_string($cachePath = getenv($cacheKey) ?: null) && preg_match('/^[A-Za-z]:[\\\\\/]/', $cachePath) === 1) {
        $app->addAbsoluteCachePathPrefix(substr($cachePath, 0, 3));
    }
}

return $app;
