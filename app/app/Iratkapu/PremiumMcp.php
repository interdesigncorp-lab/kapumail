<?php

namespace App\Iratkapu;

use App\Http\Controllers\TermsController;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

/**
 * A szakmai MCP (jogi és könyvelői eszközök) 1 órás hozzáférési tokenje a billing-szervertől.
 * Előfizetésnél a licenckulccsal kéri, különben az iroda automatikus 14 napos próbakulcsával; ha még nincs
 * próba, a felhasználó megkérdezése nélkül indít egyet. A kulcsok és a token soha nem kerülnek naplóba.
 */
class PremiumMcp
{
    private static ?string $reason = null;

    /** Az utolsó token-kérés HTTP-állapota (0: kapcsolati hiba). */
    private static int $lastStatus = 0;

    /** Az utolsó sikertelen `token()` oka: not_official, terms, trial_limit, no_entitlement, revoked, device_limit, unavailable. */
    public static function lastReason(): ?string
    {
        return self::$reason;
    }

    /** @return array{url: string, token: string, exp: int, ent: list<string>, plan: string, ends_at: ?string}|null */
    public static function token(object $office, int $userId, string $deviceId): ?array
    {
        self::$reason = null;
        if (! config('iratkapu.official_build')) {
            return self::fail('not_official');
        }
        if (TermsController::acceptedBy($userId) === null) {
            return self::fail('terms');
        }
        $useLicense = (TrialLicense::status($office)['state'] ?? null) === 'active';
        $cacheKey = 'kapu-premium:'.$office->id.':'.$deviceId.':'.($useLicense ? 'licenc' : 'proba');
        $cached = Cache::get($cacheKey);
        if (is_array($cached)) {
            return $cached;
        }

        if ($useLicense) {
            $res = self::request(['license_key' => trim((string) $office->license_key), 'device_id' => $deviceId]);
        } else {
            $trialKey = self::trialKey($office, $deviceId);
            if ($trialKey === null) {
                return null;
            }
            $res = self::request(['trial_key' => $trialKey, 'device_id' => $deviceId]);
            // A billing nem ismeri a mentett próbakulcsot (pl. ugyanarra az eszközre máshonnan újat kértek, vagy
            // adatbázis-visszaállítás után): egyszer új kulcsot kérünk (a billing ugyanazt a próbát adja vissza), és újrapróbáljuk.
            if ($res === null && self::$lastStatus === 401) {
                DB::table('offices')->where('id', $office->id)->update(['mcp_trial_key' => null]);
                $trialKey = self::trialKey($office, $deviceId);
                if ($trialKey === null) {
                    return null;
                }
                $res = self::request(['trial_key' => $trialKey, 'device_id' => $deviceId]);
            }
        }
        if ($res === null) {
            return null;
        }
        $ttl = $res['exp'] - 300 - now()->timestamp;
        if ($ttl > 0) {
            Cache::put($cacheKey, $res, $ttl);
        }

        return $res;
    }

    /** A token-kérés a billingtől; hiba esetén `null`, és az ok a `lastReason()`-ban. */
    private static function request(array $body): ?array
    {
        self::$lastStatus = 0;
        try {
            $r = Http::timeout(5)->acceptJson()->post(self::base().'/api/billing/mcp/token', $body);
        } catch (\Throwable) {
            return self::fail('unavailable');
        }
        self::$lastStatus = $r->status();
        $reason = match ($r->status()) {
            200 => null,
            402 => 'no_entitlement',
            403 => 'revoked',
            409 => 'device_limit',
            default => 'unavailable',
        };
        if ($reason !== null) {
            return self::fail($reason);
        }
        $j = $r->json();
        if (! is_array($j) || ! is_string($j['token'] ?? null) || ! is_string($j['url'] ?? null) || ! is_int($j['exp'] ?? null)) {
            return self::fail('unavailable');
        }

        return [
            'url' => $j['url'],
            'token' => $j['token'],
            'exp' => $j['exp'],
            'ent' => array_values(array_filter((array) ($j['ent'] ?? []), 'is_string')),
            'plan' => (string) ($j['plan'] ?? ''),
            'ends_at' => is_string($j['ends_at'] ?? null) ? $j['ends_at'] : null,
        ];
    }

    /** Az iroda próbakulcsa; ha még nincs, egyet kér (iroda szintű zárral, hogy két egyidejű kérés ne indítson kettőt). */
    private static function trialKey(object $office, string $deviceId): ?string
    {
        $stored = self::storedTrialKey((int) $office->id);
        if ($stored !== null) {
            return $stored;
        }

        return Cache::lock('kapu-trial:'.$office->id, 10)->block(6, function () use ($office, $deviceId) {
            $stored = self::storedTrialKey((int) $office->id);
            if ($stored !== null) {
                return $stored;
            }
            try {
                $r = Http::timeout(5)->acceptJson()->post(self::base().'/api/billing/mcp/trial', ['device_id' => $deviceId]);
            } catch (\Throwable) {
                return self::fail('unavailable');
            }
            if ($r->status() === 429 && ($r->json('error') === 'trial_limit')) {
                return self::fail('trial_limit');
            }
            $key = $r->json('trial_key');
            if ($r->status() !== 200 || ! is_string($key) || ! str_starts_with($key, 'KTR1_')) {
                return self::fail('unavailable');
            }
            $endsAt = $r->json('ends_at');
            DB::table('offices')->where('id', $office->id)->update([
                'mcp_trial_key' => Crypt::encryptString($key),
                'mcp_trial_ends_at' => is_string($endsAt) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $endsAt) ? $endsAt : null,
            ]);

            return $key;
        });
    }

    private static function storedTrialKey(int $officeId): ?string
    {
        $raw = DB::table('offices')->where('id', $officeId)->value('mcp_trial_key');
        if (! is_string($raw) || $raw === '') {
            return null;
        }
        try {
            return Crypt::decryptString($raw);
        } catch (\Throwable) {
            return null; // más APP_KEY-jel titkosított: új próbát kérünk (a billing az eszközre ugyanazt adja vissza)
        }
    }

    private static function base(): string
    {
        return rtrim((string) config('iratkapu.billing_url', 'https://kapumail.hu'), '/');
    }

    private static function fail(string $reason): null
    {
        self::$reason = $reason;

        return null;
    }
}
