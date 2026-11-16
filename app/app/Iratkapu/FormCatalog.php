<?php

namespace App\Iratkapu;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

/**
 * Nyomtatvány- és beadványtípus-katalógus (kapumail.hu szinkron + telepítőbe csomagolt alaplista + helyi ÜPO tartalék).
 *
 * A program nem küld ki ismeretlen kódot vagy ügyféladatot: csak a nyilvános manifest.json időbélyegét és SHA-256
 * lenyomatát ellenőrzi, és módosulás esetén letölti az új nyomtatvanyok-v1.json állományt, majd helyben gyorsítótárazza.
 */
final class FormCatalog
{
    private const SYNC_CACHE_KEY = 'iratkapu.catalog_synced';

    private const SAFE_ALPHA_CODES = [
        'HIPA', 'HIPAK', 'UJEGYKE', 'EGYKE', 'AUTRESZ', 'OBHIFORM', 'OBHGEPI',
        'OBH_UKE_KIADMANY', 'PTGSZLAH', 'PTGREG', 'ELEKAFA', 'HIPAMEGH',
    ];

    private const EXCLUDED_BARE_LIVE_TYPES = ['HK', '0001', 'LETOLTESIIGAZOLAS', 'FELADASIIGAZOLAS', 'VISSZAIG'];

    private static ?array $memoryCache = null;

    public static function flush(): void
    {
        self::$memoryCache = null;
    }

    public static function bundledPath(): string
    {
        return resource_path('catalog/nyomtatvanyok-v1.json');
    }

    public static function cacheDir(): string
    {
        return storage_path('app/catalog-cache');
    }

    /** Az aktív katalógus adatszerkezete (érvényes távoli gyorsítótár, különben a csomagolt alaplista). */
    public static function data(): array
    {
        if (self::$memoryCache !== null) {
            return self::$memoryCache;
        }
        $cached = self::readCached();
        if ($cached !== null) {
            return self::$memoryCache = $cached['data'];
        }
        $bundled = self::readBundled();

        return self::$memoryCache = ($bundled['data'] ?? ['schema' => 1, 'forms' => [], 'families' => [], 'prefixes' => [], 'upo_doc_types' => [], 'live_types' => []]);
    }

    /** Metaadatok az aktuálisan használt katalógusról (diagnosztikához és tesztekhez). */
    public static function activeMeta(): array
    {
        $cached = self::readCached();
        if ($cached !== null) {
            return ['source' => 'remote', 'version' => $cached['version'], 'updated_at' => $cached['updated_at'], 'sha256' => $cached['sha256']];
        }
        $bundled = self::readBundled();

        return ['source' => 'bundled', 'version' => $bundled['version'] ?? '', 'updated_at' => $bundled['updated_at'] ?? '', 'sha256' => $bundled['sha256'] ?? ''];
    }

    /**
     * Ellenőrzi a kapumail.hu/katalogus/manifest.json időbélyegét és SHA-256 lenyomatát.
     * Ha módosult, letölti az új katalógust, ellenőrzi a lenyomatot, helyben elmenti, és újrabesorolja az ismeretlen iratokat.
     */
    public static function syncIfNeeded(bool $force = false, ?object $actor = null): array
    {
        $url = trim((string) config('iratkapu.catalog_remote_url'));
        if ($url === '' || ! Str::startsWith($url, 'https://')) {
            return ['status' => 'disabled'];
        }
        if (! $force && Cache::has(self::SYNC_CACHE_KEY)) {
            return ['status' => 'cached'];
        }

        $ttl = max(1, (int) config('iratkapu.catalog_sync_ttl', 3600));
        $retryTtl = min(300, $ttl);

        try {
            $res = Http::timeout(3)->connectTimeout(2)->acceptJson()->get($url);
            if (! $res->successful()) {
                Cache::put(self::SYNC_CACHE_KEY, time(), $retryTtl);

                return ['status' => 'error'];
            }
            $manifest = $res->json();
            if (! is_array($manifest) || (int) ($manifest['schema'] ?? 0) !== 1) {
                Cache::put(self::SYNC_CACHE_KEY, time(), $retryTtl);

                return ['status' => 'invalid_manifest'];
            }
            $remoteVersion = trim((string) ($manifest['version'] ?? ''));
            $remoteUpdated = trim((string) ($manifest['updated_at'] ?? ''));
            $remoteSha = strtolower(trim((string) ($manifest['sha256'] ?? '')));
            $remoteFile = trim((string) ($manifest['file'] ?? ''));
            if (
                $remoteVersion === '' || strlen($remoteVersion) > 80
                || $remoteUpdated === '' || strlen($remoteUpdated) > 64
                || ! preg_match('/^[0-9a-f]{64}$/', $remoteSha)
                || ! preg_match('/^[a-z0-9_.-]+\.json$/i', $remoteFile)
                || str_contains($remoteFile, '..')
            ) {
                Cache::put(self::SYNC_CACHE_KEY, time(), $retryTtl);

                return ['status' => 'invalid_manifest'];
            }

            $bundled = self::readBundled();
            if ($bundled !== null && $bundled['sha256'] === $remoteSha) {
                if (File::isDirectory(self::cacheDir())) {
                    File::deleteDirectory(self::cacheDir());
                    self::flush();
                    Taxonomy::flush();
                }
                Cache::put(self::SYNC_CACHE_KEY, time(), $ttl);

                return ['status' => 'unchanged', 'version' => $remoteVersion, 'updated_at' => $remoteUpdated];
            }

            $cached = self::readCached();
            if ($cached !== null && $cached['sha256'] === $remoteSha && $cached['updated_at'] === $remoteUpdated) {
                Cache::put(self::SYNC_CACHE_KEY, time(), $ttl);

                return ['status' => 'unchanged', 'version' => $remoteVersion, 'updated_at' => $remoteUpdated];
            }

            $baseUrl = Str::beforeLast($url, '/').'/';
            $catRes = Http::timeout(4)->connectTimeout(2)->get($baseUrl.$remoteFile);
            if (! $catRes->successful()) {
                Cache::put(self::SYNC_CACHE_KEY, time(), $retryTtl);

                return ['status' => 'error'];
            }
            $body = $catRes->body();
            if (strlen($body) > 2 * 1024 * 1024 || hash('sha256', $body) !== $remoteSha) {
                Cache::put(self::SYNC_CACHE_KEY, time(), $retryTtl);

                return ['status' => 'hash_mismatch'];
            }
            $parsed = json_decode($body, true);
            if (! is_array($parsed) || (int) ($parsed['schema'] ?? 0) !== 1 || ! is_array($parsed['forms'] ?? null) || empty($parsed['forms'])) {
                Cache::put(self::SYNC_CACHE_KEY, time(), $retryTtl);

                return ['status' => 'invalid_catalog'];
            }

            $dir = self::cacheDir();
            File::ensureDirectoryExists($dir);
            $tmpCat = $dir.'/.catalog.tmp-'.uniqid('', true);
            $tmpMan = $dir.'/.manifest.tmp-'.uniqid('', true);
            File::put($tmpCat, $body);
            File::move($tmpCat, $dir.'/nyomtatvanyok-v1.json');
            File::put($tmpMan, json_encode([
                'schema' => 1,
                'version' => $remoteVersion,
                'updated_at' => $remoteUpdated,
                'file' => 'nyomtatvanyok-v1.json',
                'sha256' => $remoteSha,
            ], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
            File::move($tmpMan, $dir.'/manifest.json');

            self::flush();
            Taxonomy::flush();
            Cache::put(self::SYNC_CACHE_KEY, time(), $ttl);

            $reclassified = self::reclassifyUnknowns($actor);

            return [
                'status' => 'updated',
                'version' => $remoteVersion,
                'updated_at' => $remoteUpdated,
                'reclassified' => $reclassified,
            ];
        } catch (\Throwable) {
            Cache::put(self::SYNC_CACHE_KEY, time(), $retryTtl);

            return ['status' => 'error'];
        }
    }

    /**
     * Nyomtatványkód feloldása a katalógusból (pontos kód -> részlap nélküli kód -> évszámfüggetlen család -> OSAP -> előtag).
     *
     * @return ?array{code: string, base_code: string, org: string, kind: string, short: string, title: string, sent_type: ?string, incoming_type?: ?string}
     */
    public static function resolveForm(?string $rawCode): ?array
    {
        if ($rawCode === null) {
            return null;
        }
        $code = mb_strtoupper(trim($rawCode));
        if ($code === '' || strlen($code) > 32) {
            return null;
        }
        $cat = self::data();
        $forms = $cat['forms'] ?? [];
        $families = $cat['families'] ?? [];

        if (isset($forms[$code])) {
            $f = $forms[$code];

            return [
                'code' => $code,
                'base_code' => $code,
                'org' => (string) ($f['org'] ?? 'NAV'),
                'kind' => (string) ($f['kind'] ?? 'bevallas'),
                'short' => (string) ($f['short'] ?? $code),
                'title' => (string) ($f['title'] ?? ($f['short'] ?? $code)),
                'sent_type' => $f['sent_type'] ?? null,
            ];
        }

        // Családnév önálló megadása (pl. HIPAK, KIVA, A60)
        if (isset($families[$code])) {
            $fam = $families[$code];

            return [
                'code' => $code,
                'base_code' => $code,
                'org' => (string) ($fam['org'] ?? 'NAV'),
                'kind' => (string) ($fam['kind'] ?? 'bevallas'),
                'short' => (string) ($fam['short'] ?? $code),
                'title' => (string) ($fam['title'] ?? ($fam['short'] ?? $code)),
                'sent_type' => $fam['sent_type'] ?? null,
            ];
        }

        // ÁNYK részlap-utótag (pl. 2608A, 2608M, 2665A, 2665M -> 2608, 2665)
        if (preg_match('/^([0-9]{2}[A-Z0-9]{2,12}?)[AM]$/', $code, $sub) && isset($forms[$sub[1]])) {
            $base = $sub[1];
            $f = $forms[$base];

            return [
                'code' => $code,
                'base_code' => $base,
                'org' => (string) ($f['org'] ?? 'NAV'),
                'kind' => (string) ($f['kind'] ?? 'bevallas'),
                'short' => (string) ($f['short'] ?? $base),
                'title' => (string) ($f['title'] ?? ($f['short'] ?? $base)),
                'sent_type' => $f['sent_type'] ?? null,
            ];
        }

        // Évszámfüggetlen család (pl. 21A60 -> A60, 2708 -> 08, 2765A -> 65, 24KIVA -> KIVA)
        if (! self::isLikelyCalendarYear($code) && preg_match('/^([12]\d)([A-Z0-9_]{2,16})$/', $code, $ym)) {
            $famKey = $ym[2];
            $famBase = isset($families[$famKey]) ? $famKey : (preg_match('/^(.{2,14}?)[AM]$/', $famKey, $sm) && isset($families[$sm[1]]) ? $sm[1] : null);
            if ($famBase !== null) {
                $fam = $families[$famBase];
                $baseCode = $ym[1].$famBase;

                return [
                    'code' => $code,
                    'base_code' => $baseCode,
                    'org' => (string) ($fam['org'] ?? 'NAV'),
                    'kind' => (string) ($fam['kind'] ?? 'bevallas'),
                    'short' => (string) ($fam['short'] ?? $baseCode),
                    'title' => (string) ($fam['title'] ?? ($fam['short'] ?? $baseCode)),
                    'sent_type' => $fam['sent_type'] ?? null,
                ];
            }
        }

        // KSH OSAP 4 jegyű adatgyűjtési számok (pl. OSAP 2010, OSAP-2010)
        if (preg_match('/^OSAP[- ]?(\d{4})$/', $code, $om)) {
            $normOsap = 'OSAP-'.$om[1];
            if (isset($forms[$normOsap])) {
                $f = $forms[$normOsap];

                return [
                    'code' => $normOsap,
                    'base_code' => $normOsap,
                    'org' => (string) ($f['org'] ?? 'KSH'),
                    'kind' => (string) ($f['kind'] ?? 'adatszolgaltatas'),
                    'short' => (string) ($f['short'] ?? $normOsap),
                    'title' => (string) ($f['title'] ?? ($f['short'] ?? $normOsap)),
                    'sent_type' => $f['sent_type'] ?? 'hatosag.beadvany.egyeb',
                ];
            }

            return [
                'code' => $normOsap,
                'base_code' => $normOsap,
                'org' => 'KSH',
                'kind' => 'adatszolgaltatas',
                'short' => "KSH statisztikai adatszolgáltatás (OSAP {$om[1]})",
                'title' => "KSH ELEKTRA statisztikai adatszolgáltatás (OSAP {$om[1]})",
                'sent_type' => 'hatosag.beadvany.egyeb',
            ];
        }

        // Szabványos előtagok (ASP-ADO-*, ASP-IGAZ-*, OBH*, PK-*, NAV_*, VP_*)
        foreach (($cat['prefixes'] ?? []) as $p) {
            $pref = mb_strtoupper((string) ($p['prefix'] ?? ''));
            if ($pref !== '' && str_starts_with($code, $pref) && strlen($code) > strlen($pref)) {
                return [
                    'code' => $code,
                    'base_code' => $code,
                    'org' => (string) ($p['org'] ?? 'HATOSAG'),
                    'kind' => 'urlap',
                    'short' => (string) ($p['short'] ?? $code),
                    'title' => (string) ($p['short'] ?? $code)." ($code)",
                    'sent_type' => $p['sent_type'] ?? null,
                    'incoming_type' => $p['incoming_type'] ?? null,
                ];
            }
        }

        return null;
    }

    /**
     * Nyomtatványkód kinyerése tárhely-típusnévből (live_type) vagy szövegből/tárgyból, hamis pozitívok (évszámok, közszavak) kiszűrésével.
     */
    public static function extractFormCode(?string $haystack, ?string $liveType = null): ?string
    {
        if ($liveType !== null && trim($liveType) !== '') {
            $lt = trim($liveType);
            $ltUp = mb_strtoupper($lt);
            if (! in_array($ltUp, self::EXCLUDED_BARE_LIVE_TYPES, true) && preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/', $lt)) {
                if (! self::isLikelyCalendarYear($ltUp) && ($res = self::resolveForm($ltUp))) {
                    return $res['base_code'];
                }
            }
        }

        $text = (string) ($haystack ?? '');
        if ($text === '') {
            return null;
        }

        if (preg_match('/\bOSAP[- ]?(\d{4})\b/iu', $text, $om)) {
            return 'OSAP-'.$om[1];
        }
        if (preg_match('/\b(ASP-[A-Z]{2,8}-[A-Z0-9]{1,12}|PK-\d{2,4})\b/iu', $text, $pm)) {
            $hit = mb_strtoupper($pm[1]);
            if ($res = self::resolveForm($hit)) {
                return $res['base_code'];
            }
        }

        $hasFormContext = (bool) preg_match('/bevall[aá]s|nyomtatv[aá]ny|[uű]rlap\s+k[oó]dja/iu', $text);

        if (preg_match_all('/(?<![\pL\pN.\-\/])([A-Za-z0-9][A-Za-z0-9_-]{1,28})(?![\pL\pN])/u', $text, $matches, PREG_OFFSET_CAPTURE)) {
            foreach ($matches[1] as [$rawTok, $offset]) {
                // Dátum részeként álló 4 jegyű szám kizárása (pl. 2026.11.15 vagy 2026-11-15)
                $after = substr($text, $offset + strlen($rawTok), 4);
                if (preg_match('/^[.\-\/]\d{1,2}/', $after)) {
                    continue;
                }

                $candidates = [$rawTok];
                if (str_contains($rawTok, '_')) {
                    $firstSeg = explode('_', $rawTok, 2)[0];
                    if ($firstSeg !== '' && $firstSeg !== $rawTok) {
                        $candidates[] = $firstSeg;
                    }
                }

                foreach ($candidates as $cand) {
                    $up = mb_strtoupper($cand);
                    if (strlen($up) < 3 || in_array($up, ['L1', 'L2', 'HK', '0001'], true)) {
                        continue;
                    }
                    // Tiszta betűs szó a szövegben: csak csupa nagybetűsen és az egyértelmű fehérlistából fogadjuk el
                    if (preg_match('/^[A-Z]+$/', $up)) {
                        if ($cand !== $up || ! in_array($up, self::SAFE_ALPHA_CODES, true)) {
                            continue;
                        }
                    } elseif (preg_match('/^\d+$/', $up)) {
                        // Csupasz szám: csak 4 jegyű ÁNYK-év+kód alak lehet, és nem lehet csupasz naptári évszám
                        if (strlen($up) !== 4) {
                            continue;
                        }
                        if (self::isLikelyCalendarYear($up) && ! ($hasFormContext && in_array($up, ['2008', '2029', '2053', '2058', '2065'], true))) {
                            continue;
                        }
                    }

                    $res = self::resolveForm($up);
                    if ($res !== null) {
                        return $res['base_code'];
                    }
                }
            }
        }

        return null;
    }

    /** Technikai live_type kód feloldása (pl. 0001, IGAZOL, SZTNH_SZTE, EPAPIR). */
    public static function resolveLiveType(?string $liveType): ?array
    {
        if ($liveType === null || trim($liveType) === '') {
            return null;
        }
        $lt = trim($liveType);
        $map = self::data()['live_types'] ?? [];
        if (isset($map[$lt])) {
            return $map[$lt];
        }
        foreach ($map as $k => $v) {
            if (mb_strtolower((string) $k) === mb_strtolower($lt)) {
                return $v;
            }
        }

        return null;
    }

    /**
     * Kimenő (ELKULDOTT) küldemény irattípus-azonosítójának meghatározása nyomtatványkód, live_type és címzett alapján.
     */
    public static function inferSentTypeId(?string $liveType, string $subject, string $recipient): ?string
    {
        $ltEntry = self::resolveLiveType($liveType);
        $recipientFamily = self::recipientAuthorityFamily($recipient);

        if ($ltEntry !== null && ! empty($ltEntry['sent_type'])) {
            // Általános e-Papír küldeménynél, ha a címzett NAV/önkormányzat/bíróság, a pontosabb hatósági beadványtípust adjuk
            if (in_array(mb_strtolower(trim((string) $liveType)), ['epapir', 'e-papír', 'e-papir'], true) && $recipientFamily !== null) {
                return $recipientFamily;
            }

            return (string) $ltEntry['sent_type'];
        }

        $code = self::extractFormCode($subject, $liveType);
        if ($code !== null && ($resolved = self::resolveForm($code)) && ! empty($resolved['sent_type'])) {
            return (string) $resolved['sent_type'];
        }

        $hay = ' '.Taxonomy::norm(trim(($liveType ?? '').' '.$subject)).' ';
        $isBatchOrForm = (bool) preg_match('/ (kotegelt nyomtatvany|bevallas|osszesito nyilatkozat|adatszolgaltatas) /', $hay);
        $isEpapir = (bool) preg_match('/ (epapir|e papir) /', $hay);

        if ($recipientFamily === 'nav.beadvany.egyeb' && $isBatchOrForm) {
            return 'nav.beadvany.bevallas';
        }
        if ($recipientFamily !== null) {
            return $recipientFamily;
        }
        if ($isBatchOrForm || $isEpapir) {
            return 'hatosag.beadvany.egyeb';
        }

        return null;
    }

    /** Címzett hatósági családja kimenő beadványokhoz. Magáncégre null-t ad vissza. */
    public static function recipientAuthorityFamily(string $recipient): ?string
    {
        $r = ' '.Taxonomy::norm($recipient).' ';
        if (trim($r) === '') {
            return null;
        }
        $has = fn (string $alt) => (bool) preg_match('/'.$alt.'/', $r);

        return match (true) {
            $has('nemzeti ado es vamhivatal| nav | apeh | vpop ') => 'nav.beadvany.egyeb',
            $has('onkormanyzat|polgarmesteri hivatal|asp kozpont|helyi ado|fovarosi fopolgarmesteri') => 'onk.beadvany',
            $has('torvenyszek|birosag|cegbirosag|ceginformacios| obh|kozjegyzo|vegrehajto|e beszamolo') => 'ceg.beadvany',
            $has('allamkincstar| mak |egeszsegbiztositasi| neak |statisztikai hivatal| ksh |kormanyhivatal|iparkamara| mkik |agrargazdasagi kamara|hirkozlesi hatosag| nmhh | sztnh |szellemi tulajdon| nebih |elelmiszerlanc|rendor|katasztrofavedelem|foldhivatal|lechner|valasztasi iroda') => 'hatosag.beadvany.egyeb',
            default => null,
        };
    }

    /**
     * Tömeges névfeloldás a felület számára: katalógus -> helyi ÜPO táblák (ügyfélhatáron belül).
     *
     * @param  list<string>  $codes
     * @param  list<int>  $clientIds
     * @return array<string, array{short: string, title: string}>
     */
    public static function titlesForCodes(array $codes, array $clientIds = []): array
    {
        $unique = array_values(array_unique(array_filter(array_map(fn ($c) => mb_strtoupper(trim((string) $c)), $codes))));
        if (! $unique) {
            return [];
        }

        $out = [];
        $missing = [];
        foreach ($unique as $code) {
            $res = self::resolveForm($code);
            if ($res !== null) {
                $out[$code] = ['short' => $res['short'], 'title' => $res['title']];
            } else {
                $missing[] = $code;
            }
        }

        if ($missing && $clientIds) {
            foreach ([
                ['tax_obligations', 'form_code', 'title'],
                ['nav_returns', 'form_code', 'title'],
                ['nav_documents', 'form_code', 'form_name'],
            ] as [$table, $codeCol, $titleCol]) {
                if (! $missing) {
                    break;
                }
                $rows = DB::table($table)
                    ->whereIn('client_id', $clientIds)
                    ->whereNotNull($codeCol)
                    ->whereNotNull($titleCol)
                    ->get([$codeCol.' as code', $titleCol.' as title']);
                foreach ($rows as $r) {
                    $c = mb_strtoupper(trim((string) ($r->code ?? '')));
                    $t = trim((string) ($r->title ?? ''));
                    if ($c !== '' && $t !== '' && in_array($c, $missing, true) && ! isset($out[$c])) {
                        $short = mb_strlen($t) > 56 ? mb_substr($t, 0, 53).'…' : $t;
                        $out[$c] = ['short' => $short, 'title' => $t];
                    }
                }
                $missing = array_values(array_diff($missing, array_keys($out)));
            }
        }

        return $out;
    }

    /**
     * Meglévő `unknown = 1` iratok újrabesorolása (migrációkor vagy friss katalógus letöltése után).
     */
    public static function reclassifyUnknowns(?object $actor = null, ?int $officeId = null): int
    {
        if (! DB::getSchemaBuilder()->hasTable('messages') || ! DB::getSchemaBuilder()->hasTable('document_types')) {
            return 0;
        }
        Taxonomy::flush();
        $q = DB::table('messages')->where('unknown', true);
        if ($officeId !== null) {
            $q->where('office_id', $officeId);
        }
        $rows = $q->get();
        $updated = 0;

        foreach ($rows as $m) {
            $isSent = ($m->folder ?? null) === 'ELKULDOTT';
            $liveType = $m->live_type ?? null;
            $recipient = trim((string) ($m->recipient ?? '').' '.(string) ($m->recipient_short ?? ''));
            $sender = trim((string) ($m->sender ?? '').' '.(string) ($m->sender_full ?? ''));
            $subject = (string) ($m->subject ?? '');

            $tax = Taxonomy::classify(
                trim(($liveType ?? '').' '.$subject),
                $sender,
                isset($m->office_id) ? (int) $m->office_id : null,
                $isSent,
                $recipient,
                $liveType
            );
            $newCode = ($m->form_code ?? null) ?: self::extractFormCode($subject, $liveType);

            if (! $tax && ! ($newCode && empty($m->form_code))) {
                continue;
            }

            $fix = ['updated_at' => now()];
            if ($newCode && empty($m->form_code)) {
                $fix['form_code'] = mb_substr($newCode, 0, 32);
            }
            if ($tax) {
                $fix += [
                    'type_id' => $tax->type_id,
                    'type_label' => $tax->label,
                    'type_ai' => true,
                    'type_group' => $tax->group ?? null,
                    'type_risk' => $tax->risk ?? null,
                    'unknown' => false,
                    'internal' => $isSent ? 'kesz' : (($m->internal ?? 'oszt') === 'oszt' ? 'uj' : $m->internal),
                ];
            }

            DB::table('messages')->where('id', $m->id)->update($fix);
            if ($tax && isset($m->office_id)) {
                Audit::log(
                    (int) $m->office_id,
                    $actor,
                    'Irat típusa utólag felismerve: '.$tax->label,
                    ['client_id' => $m->client_id ?? null, 'message_id' => $m->id, 'evidence' => 'nyomtatvány- és típuskatalógus frissítése']
                );
                if (! $isSent && class_exists(RuleEngine::class)) {
                    RuleEngine::apply(DB::table('messages')->find($m->id));
                }
                $updated++;
            }
        }

        return $updated;
    }

    private static function isLikelyCalendarYear(string $code): bool
    {
        if (! preg_match('/^\d{4}$/', $code)) {
            return false;
        }
        $n = (int) $code;

        return $n >= 1990 && $n <= 2039;
    }

    private static function readBundled(): ?array
    {
        $path = self::bundledPath();
        if (! is_file($path)) {
            return null;
        }
        $raw = (string) @file_get_contents($path);
        if ($raw === '') {
            return null;
        }
        $data = json_decode($raw, true);
        if (! is_array($data)) {
            return null;
        }

        return [
            'version' => (string) ($data['version'] ?? ''),
            'updated_at' => (string) ($data['updated_at'] ?? ''),
            'sha256' => hash('sha256', $raw),
            'data' => $data,
        ];
    }

    private static function readCached(): ?array
    {
        $dir = self::cacheDir();
        $manPath = $dir.'/manifest.json';
        $catPath = $dir.'/nyomtatvanyok-v1.json';
        if (! is_file($manPath) || ! is_file($catPath)) {
            return null;
        }
        $man = json_decode((string) @file_get_contents($manPath), true);
        if (! is_array($man)) {
            return null;
        }
        $expectedSha = strtolower(trim((string) ($man['sha256'] ?? '')));
        if (! preg_match('/^[0-9a-f]{64}$/', $expectedSha)) {
            return null;
        }
        $raw = (string) @file_get_contents($catPath);
        if ($raw === '' || hash('sha256', $raw) !== $expectedSha) {
            return null;
        }
        $data = json_decode($raw, true);
        if (! is_array($data) || (int) ($data['schema'] ?? 0) !== 1) {
            return null;
        }

        return [
            'version' => (string) ($man['version'] ?? ($data['version'] ?? '')),
            'updated_at' => (string) ($man['updated_at'] ?? ($data['updated_at'] ?? '')),
            'sha256' => $expectedSha,
            'data' => $data,
        ];
    }
}
