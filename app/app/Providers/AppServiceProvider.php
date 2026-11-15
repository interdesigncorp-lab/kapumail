<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use Laravel\Passport\Passport;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        // AI-kapcsolat OAuth-on át (ADR-012): magyar engedélyező oldal, rövid életű hozzáférési token, hosszabb frissítő token.
        Passport::authorizationView('mcp-authorize');
        Passport::tokensExpireIn(now()->addHour());
        Passport::refreshTokensExpireIn(now()->addDays(30));
        // MCP-közvetítő (ADR-013): a párosításkor választott szint a frissen csatlakozott kliensre kerül.
        \Illuminate\Support\Facades\Event::listen(\Laravel\Passport\Events\AccessTokenCreated::class,
            fn ($e) => \App\Mcp\McpPairing::applyToClient($e->userId, $e->clientId));
    }
}
