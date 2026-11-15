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

return $app;
