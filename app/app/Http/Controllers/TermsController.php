<?php

namespace App\Http\Controllers;

use App\Iratkapu\Audit;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Throwable;

/**
 * Szerződési feltételek: a szövegek megjelenítése, élő szinkronja és az elfogadás naplózása.
 * A közös szerkesztési forrás a resources/legal mappa; ugyanezek a szövegek és a manifest.json kerülnek ki
 * a https://kapumail.hu/jogi/ alá (marketing/landing/jogi-oldalak.sh). A futó program – ha a távoli jegyzék
 * elérhető és újabb/módosított szöveget tartalmaz – SHA-256 ellenőrzéssel letölti és helyben gyorsítótárazza,
 * így új telepítő kiadása nélkül is frissül; offline módban vagy saját nyílt forrású fordításnál a csomagolt
 * szövegek maradnak érvényben.
 */
class TermsController extends Controller
{
    /** Megjeleníthető dokumentumok: URL-név => [fájlnév, cím]. */
    public const DOCS = [
        'aszf' => ['ASZF.md', 'Általános Szerződési Feltételek'],
        'adatkezeles' => ['ADATKEZELESI-TAJEKOZTATO.md', 'Adatkezelési tájékoztató'],
        'adatfeldolgozas' => ['ADATFELDOLGOZASI-FELTETELEK.md', 'Adatfeldolgozási feltételek'],
    ];

    /** A kötelező nyilatkozatok; mindet egyenként be kell pipálni. */
    public const ITEMS = ['aszf', 'uzleti', 'kiemelt', 'meghatalmazas'];

    public const SYNC_CACHE_KEY = 'iratkapu.terms.synced_at';

    public static function version(): string
    {
        return self::activeState()['version'];
    }

    /**
     * A dokumentumok szövegének lenyomata: ezzel bizonyítható, pontosan melyik szöveget fogadta el.
     *
     * @return array<string, string>
     */
    public static function hashes(): array
    {
        return self::activeState()['hashes'];
    }

    /** A bejelentkezett felhasználó elfogadta-e az aktuális verziót. */
    public static function acceptedBy(int $userId): ?object
    {
        return DB::table('terms_acceptances')
            ->where('user_id', $userId)
            ->where('version', self::version())
            ->orderByDesc('id')
            ->first();
    }

    /**
     * @return array{version: string, accepted: bool, acceptedAt: ?string, docs: list<array{key: string, title: string, url: string}>}
     */
    public function show(): array
    {
        $u = Auth::user();
        $version = self::version();
        $a = DB::table('terms_acceptances')
            ->where('user_id', $u->id)
            ->where('version', $version)
            ->orderByDesc('id')
            ->first();

        return [
            'version' => $version,
            'accepted' => (bool) $a,
            'acceptedAt' => $a ? substr($a->accepted_at, 0, 16) : null,
            'docs' => collect(self::DOCS)
                ->map(fn (array $d, string $k): array => ['key' => $k, 'title' => $d[1], 'url' => '/legal/'.$k])
                ->values()
                ->all(),
        ];
    }

    /**
     * @return array{ok: bool, version: string, acceptedAt: string}|JsonResponse
     */
    public function accept(Request $r): array|JsonResponse
    {
        $u = Auth::user();
        $rules = ['version' => 'required|string'];
        foreach (self::ITEMS as $i) {
            $rules["items.$i"] = 'accepted';
        }
        $r->validate($rules, ['items.*.accepted' => 'Minden nyilatkozatot külön be kell jelölni.']);
        if ($r->input('version') !== self::version()) {
            return response()->json(['message' => 'Közben megváltoztak a feltételek. Töltsd újra az oldalt, és olvasd el az új változatot.'], 409);
        }
        if ($a = self::acceptedBy($u->id)) {
            return ['ok' => true, 'version' => self::version(), 'acceptedAt' => substr($a->accepted_at, 0, 16)];
        }
        $now = self::record($r, $u, 'a programban, a négy nyilatkozat egyenként bejelölve');

        return ['ok' => true, 'version' => self::version(), 'acceptedAt' => substr($now, 0, 16)];
    }

    /**
     * Az aktuális verzió elfogadásának rögzítése a szövegek lenyomatával és auditbejegyzéssel.
     * A helyi mód nyitóképernyője a /local/enter hívással ide jut (ott két jelölőnégyzet fedi le a négy nyilatkozatot).
     */
    public static function record(Request $r, object $u, string $how): string
    {
        $state = self::activeState();
        $now = now();
        DB::table('terms_acceptances')->insert([
            'office_id' => $u->office_id,
            'user_id' => $u->id,
            'version' => $state['version'],
            'items' => json_encode(self::ITEMS),
            'hashes' => json_encode($state['hashes']),
            'ip' => $r->ip(),
            'user_agent' => Str::limit((string) $r->userAgent(), 250, ''),
            'accepted_at' => $now,
        ]);
        Audit::log($u->office_id, $u, 'Szerződési feltételek elfogadva ('.$state['version'].')', [
            'evidence' => 'ÁSZF, üzleti felhasználás, kiemelt rendelkezések (K1–K12), meghatalmazás – '.$how,
            'policy' => 'ÁSZF '.$state['version'],
        ]);

        return (string) $now;
    }

    /** A dokumentum HTML-ként, a programon belüli olvasóhoz (bejelentkezés nélkül is olvasható). */
    public function page(string $doc): Response
    {
        abort_unless(isset(self::DOCS[$doc]), 404);
        [, $title] = self::DOCS[$doc];
        $state = self::activeState();
        $md = (string) file_get_contents($state['paths'][$doc]);
        foreach (self::DOCS as $k => [$f]) {
            $md = str_replace(']('.$f.')', '](/legal/'.$k.')', $md);
        }
        $body = Str::markdown($md, ['html_input' => 'escape', 'allow_unsafe_links' => false]);
        $html = '<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'.e($title).'</title><style>'
            .'body{font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d1a2e;background:#fff;margin:0;padding:24px 28px 48px;max-width:860px}'
            .'h1{font-size:24px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 8px}h3{font-size:16px}table{border-collapse:collapse;width:100%;font-size:14px;margin:10px 0}'
            .'th,td{border:1px solid #e3e0ef;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f6f4fc}blockquote{margin:12px 0;padding:8px 14px;background:#fff8e6;border-left:3px solid #e0a800}'
            .'a{color:#5b3fd6}code{background:#f3f1fa;padding:1px 4px;border-radius:4px}</style></head><body>'.$body.'</body></html>';

        return response($html)
            ->header('Content-Type', 'text/html; charset=UTF-8')
            ->header('Cache-Control', 'no-store')
            ->header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'");
    }

    /**
     * Az aktív jogi csomag feloldása: előbb szükség esetén szinkronizál a kapumail.hu-val, majd a letöltött
     * (ellenőrzött) gyorsítótárat, annak hiányában a telepítőbe csomagolt resources/legal fájlokat adja vissza.
     *
     * @return array{version: string, hashes: array<string, string>, paths: array<string, string>}
     */
    private static function activeState(): array
    {
        self::syncIfNeeded();

        return self::cachedState() ?? self::bundledState();
    }

    /**
     * @return array{version: string, hashes: array<string, string>, paths: array<string, string>}
     */
    private static function bundledState(): array
    {
        $hashes = [];
        $paths = [];
        foreach (self::DOCS as $key => [$file]) {
            $path = resource_path('legal/'.$file);
            $paths[$key] = $path;
            $hashes[$key] = hash_file('sha256', $path);
        }

        return [
            'version' => (string) config('iratkapu.terms_version'),
            'hashes' => $hashes,
            'paths' => $paths,
        ];
    }

    /**
     * @return ?array{version: string, hashes: array<string, string>, paths: array<string, string>}
     */
    private static function cachedState(): ?array
    {
        $dir = self::cacheDir();
        $manifestPath = $dir.'/manifest.json';
        if (! is_file($manifestPath)) {
            return null;
        }
        $meta = json_decode((string) file_get_contents($manifestPath), true);
        if (! is_array($meta)) {
            return null;
        }
        // Ha a telepített programot közben frissítették újabb csomagolt feltételverzióra, a korábbi gyorsítótár elavult.
        if (($meta['bundled_version'] ?? null) !== (string) config('iratkapu.terms_version')) {
            return null;
        }
        $version = trim((string) ($meta['version'] ?? ''));
        if ($version === '' || strlen($version) > 80) {
            return null;
        }
        $hashes = [];
        $paths = [];
        foreach (self::DOCS as $key => [$file]) {
            $expected = $meta['hashes'][$key] ?? '';
            $path = $dir.'/'.$file;
            if (! is_string($expected) || ! preg_match('/^[0-9a-f]{64}$/', $expected) || ! is_file($path)) {
                return null;
            }
            if (hash_file('sha256', $path) !== $expected) {
                return null;
            }
            $paths[$key] = $path;
            $hashes[$key] = $expected;
        }

        return [
            'version' => $version,
            'hashes' => $hashes,
            'paths' => $paths,
        ];
    }

    private static function syncIfNeeded(): void
    {
        $url = trim((string) config('iratkapu.terms_remote_url'));
        if ($url === '' || ! Str::startsWith($url, 'https://')) {
            return;
        }
        if (Cache::has(self::SYNC_CACHE_KEY)) {
            return;
        }

        $ttl = max(1, (int) config('iratkapu.terms_sync_ttl', 3600));
        $retryTtl = min(300, $ttl);

        try {
            $res = Http::timeout(3)->connectTimeout(2)->acceptJson()->get($url);
            if (! $res->successful()) {
                Cache::put(self::SYNC_CACHE_KEY, time(), $retryTtl);

                return;
            }
            $manifest = $res->json();
            if (! is_array($manifest)) {
                Cache::put(self::SYNC_CACHE_KEY, time(), $retryTtl);

                return;
            }
            $remoteVersion = trim((string) ($manifest['version'] ?? ''));
            if ($remoteVersion === '' || strlen($remoteVersion) > 80) {
                Cache::put(self::SYNC_CACHE_KEY, time(), $retryTtl);

                return;
            }

            $remoteHashes = [];
            $remoteFiles = [];
            foreach (self::DOCS as $key => [$localFile]) {
                $sha = $manifest['docs'][$key]['sha256'] ?? '';
                $rFile = $manifest['docs'][$key]['file'] ?? '';
                if (! is_string($sha) || ! preg_match('/^[0-9a-f]{64}$/', $sha)) {
                    Cache::put(self::SYNC_CACHE_KEY, time(), $retryTtl);

                    return;
                }
                if (! is_string($rFile) || ! preg_match('/^[a-z0-9_-]+\.md$/i', $rFile)) {
                    Cache::put(self::SYNC_CACHE_KEY, time(), $retryTtl);

                    return;
                }
                $remoteHashes[$key] = $sha;
                $remoteFiles[$key] = $rFile;
            }

            $bundled = self::bundledState();
            if ($bundled['version'] === $remoteVersion && $bundled['hashes'] === $remoteHashes) {
                File::deleteDirectory(self::cacheDir());
                Cache::put(self::SYNC_CACHE_KEY, time(), $ttl);

                return;
            }

            $cached = self::cachedState();
            if ($cached !== null && $cached['version'] === $remoteVersion && $cached['hashes'] === $remoteHashes) {
                Cache::put(self::SYNC_CACHE_KEY, time(), $ttl);

                return;
            }

            $baseUrl = Str::beforeLast($url, '/').'/';
            $bodies = [];
            foreach (self::DOCS as $key => [$localFile]) {
                $docRes = Http::timeout(4)->connectTimeout(2)->get($baseUrl.$remoteFiles[$key]);
                if (! $docRes->successful()) {
                    Cache::put(self::SYNC_CACHE_KEY, time(), $retryTtl);

                    return;
                }
                $body = $docRes->body();
                if (hash('sha256', $body) !== $remoteHashes[$key]) {
                    Cache::put(self::SYNC_CACHE_KEY, time(), $retryTtl);

                    return;
                }
                $bodies[$key] = $body;
            }

            $dir = self::cacheDir();
            File::ensureDirectoryExists($dir);
            foreach (self::DOCS as $key => [$localFile]) {
                File::put($dir.'/'.$localFile, $bodies[$key]);
            }
            File::put($dir.'/manifest.json', json_encode([
                'version' => $remoteVersion,
                'bundled_version' => (string) config('iratkapu.terms_version'),
                'hashes' => $remoteHashes,
                'synced_at' => now()->toIso8601String(),
            ], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)."\n");

            Cache::put(self::SYNC_CACHE_KEY, time(), $ttl);
        } catch (Throwable) {
            Cache::put(self::SYNC_CACHE_KEY, time(), $retryTtl);
        }
    }

    private static function cacheDir(): string
    {
        $custom = config('iratkapu.terms_cache_dir');

        return is_string($custom) && $custom !== '' ? $custom : storage_path('app/legal');
    }
}
