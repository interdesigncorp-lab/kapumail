<?php

namespace App\Iratkapu;

/**
 * Az asztali app életjele (ADR-016): a főfolyamat 30 mp-enként a `storage/app/desktop-alive.json` fájlba írja, hogy fut,
 * és hogyan indítható. A helyi (stdio) MCP-folyamat ebből tudja, kell-e elindítania az appot a szinkronhoz.
 */
class DesktopAlive
{
    public const FILE = 'app/desktop-alive.json';

    /** Ennél régebbi életjel = az app nem fut. */
    public const STALE_SECONDS = 90;

    /** Tesztekhez: a fájl helye (alapból a storage alatt). */
    public static ?string $path = null;

    /** @var (\Closure(array<int, string>): void)|null Tesztekhez: az indítóparancs futtatója (alapból leválasztott folyamat). */
    public static ?\Closure $runner = null;

    /**
     * @return array{at: int, pid?: int, packaged?: bool, launch?: array{platform: string, path: string}|null}|null
     */
    public static function read(): ?array
    {
        $file = self::$path ?? storage_path(self::FILE);
        if (! is_file($file)) {
            return null;
        }
        $data = json_decode((string) @file_get_contents($file), true);

        return is_array($data) && is_numeric($data['at'] ?? null) ? $data : null;
    }

    /** @param  array<string, mixed>|null  $info */
    public static function isAlive(?array $info): bool
    {
        $at = (int) ($info['at'] ?? 0);

        return $at > 0 && now()->getTimestampMs() - $at <= self::STALE_SECONDS * 1000;
    }

    /**
     * Az app elindítása ablak nélkül (`--mcp-hatter`). Csak a helyi (konzolos, stdio) MCP-folyamatból, csomagolt appnál, ismert útvonallal.
     *
     * @param  array<string, mixed>|null  $info
     * @return array{tried: bool, reason: ?string}
     */
    public static function launch(?array $info): array
    {
        if ($info === null) {
            return ['tried' => false, 'reason' => 'Nem tudom, hol van a KapuMail ezen a gépen: nyisd meg egyszer kézzel, utána már el tudom indítani.'];
        }
        if (! app()->runningInConsole()) {
            return ['tried' => false, 'reason' => 'Távoli kapcsolatból nem indítható az app.'];
        }
        $launch = $info['launch'] ?? null;
        $path = is_array($launch) ? (string) ($launch['path'] ?? '') : '';
        if (($info['packaged'] ?? false) !== true || $path === '' || ! file_exists($path)) {
            return ['tried' => false, 'reason' => 'A KapuMail fejlesztői módban fut, vagy az indítási útvonala nem érvényes: nyisd meg kézzel.'];
        }
        $argv = match ((string) ($launch['platform'] ?? '')) {
            'darwin' => ['open', '-g', '-a', $path, '--args', '--mcp-hatter'],
            'win32' => ['cmd', '/c', 'start', '', '/b', $path, '--mcp-hatter'], // az üres első argumentum a `start` ablakcíme (a PHP ""-ként adja át)
            default => null,
        };
        if ($argv === null) {
            return ['tried' => false, 'reason' => 'Ezen a rendszeren nem tudom elindítani a KapuMailt.'];
        }
        (self::$runner ?? self::detached(...))($argv);

        return ['tried' => true, 'reason' => null];
    }

    /** @param  array<int, string>  $argv */
    private static function detached(array $argv): void
    {
        $null = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
        $p = @proc_open($argv, [0 => ['file', $null, 'r'], 1 => ['file', $null, 'w'], 2 => ['file', $null, 'w']], $pipes);
        if (is_resource($p)) {
            proc_close($p);
        }
    }
}
