<?php

namespace Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * A csomagolt asztali alkalmazás a gyorsítótárfájlokat a felhasználó adatmappájába irányítja (APP_*_CACHE).
 * Windowson ez meghajtóbetűs útvonal, amelyet a Laravel magától nem tekint abszolútnak – emiatt a helyi
 * szerver egyetlen Windows-gépen sem indult el („Az adatbázis előkészítése nem sikerült.”).
 */
class WindowsCachePathTest extends TestCase
{
    private function cachedPaths(array $env): array
    {
        $root = dirname(__DIR__, 2);
        $code = 'require '.var_export($root.'/vendor/autoload.php', true).';'
            .'$app = require '.var_export($root.'/bootstrap/app.php', true).';'
            .'echo json_encode([$app->getCachedConfigPath(), $app->getCachedPackagesPath(), $app->getCachedServicesPath(), $app->getCachedRoutesPath(), $app->getCachedEventsPath()]);';
        $proc = proc_open([PHP_BINARY, '-r', $code], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $root, $env + ['PATH' => (string) getenv('PATH')]);
        $out = stream_get_contents($pipes[1]);
        $err = stream_get_contents($pipes[2]);
        $this->assertSame(0, proc_close($proc), $err);

        return json_decode($out, true);
    }

    public function test_meghajtobetus_gyorsitotar_utvonal_abszolut_marad(): void
    {
        $dir = 'C:\\Users\\Kovács Éva\\AppData\\Roaming\\KapuMail\\local-server\\cache\\';
        $paths = $this->cachedPaths([
            'APP_CONFIG_CACHE' => $dir.'config.php',
            'APP_PACKAGES_CACHE' => $dir.'packages.php',
            'APP_SERVICES_CACHE' => $dir.'services.php',
            'APP_ROUTES_CACHE' => $dir.'routes-v7.php',
            'APP_EVENTS_CACHE' => 'D:/adat/cache/events.php',
        ]);

        $this->assertSame([$dir.'config.php', $dir.'packages.php', $dir.'services.php', $dir.'routes-v7.php', 'D:/adat/cache/events.php'], $paths);
    }

    public function test_relativ_gyorsitotar_utvonal_tovabbra_is_a_programkonyvtarhoz_kepest_ertendo(): void
    {
        $paths = $this->cachedPaths(['APP_CONFIG_CACHE' => 'bootstrap/cache/sajat.php']);

        $this->assertSame(dirname(__DIR__, 2).DIRECTORY_SEPARATOR.'bootstrap/cache/sajat.php', $paths[0]);
    }
}
