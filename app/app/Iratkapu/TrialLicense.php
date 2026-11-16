<?php

namespace App\Iratkapu;

use Carbon\Carbon;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * A hivatalos KapuMail kiadás 14 napos próbaidőszaka és offline ellenőrizhető előfizetési licenckulcsa.
 *
 * Nyílt forráskódú saját fordításnál (`official_build = false`) a próbaidő-kapu inaktív (`state = 'open_source'`, `canSync = true`),
 * így a GNU AGPLv3 alatt saját maguk által fordított példányok korlátozás nélkül működnek.
 */
class TrialLicense
{
    public const PREFIX = 'KM1';

    public static function status(object $office): array
    {
        $official = (bool) config('iratkapu.official_build', false);
        $trialDays = max(1, (int) config('iratkapu.trial_days', 14));
        $startedRaw = ($office->trial_started_at ?? null) ?: ($office->created_at ?? null);
        $started = $startedRaw ? Carbon::parse((string) $startedRaw) : now();

        if (empty($office->trial_started_at) && ! empty($office->id)) {
            DB::table('offices')->where('id', (int) $office->id)->whereNull('trial_started_at')->update([
                'trial_started_at' => $started,
            ]);
        }

        $endsAt = $started->copy()->addDays($trialDays);
        $rawKey = trim((string) ($office->license_key ?? ''));
        $verified = $rawKey !== '' ? self::verifyKey($rawKey) : null;

        $today = now()->toDateString();
        $hasValidLicense = $verified !== null && (empty($verified['exp']) || $verified['exp'] >= $today);
        $expiredLicense = $verified !== null && ! empty($verified['exp']) && $verified['exp'] < $today;

        $now = now();
        $daysLeft = $now->lessThan($endsAt)
            ? max(1, (int) ceil($now->floatDiffInDays($endsAt, false)))
            : 0;

        if (! $official) {
            $state = 'open_source';
            $canSync = true;
        } elseif ($hasValidLicense) {
            $state = 'active';
            $canSync = true;
        } elseif ($daysLeft > 0) {
            $state = 'trial';
            $canSync = true;
        } else {
            $state = 'expired';
            $canSync = false;
        }

        return [
            'officialBuild' => $official,
            'state' => $state,
            'canSync' => $canSync,
            'trialDays' => $trialDays,
            'daysLeft' => $daysLeft,
            'trialStartedAt' => $started->toDateString(),
            'trialEndsAt' => $endsAt->toDateString(),
            'licenseId' => $verified['lic'] ?? null,
            'plan' => $verified['plan'] ?? null,
            'holder' => $verified['sub'] ?? null,
            'validUntil' => $verified['exp'] ?? null,
            'expiredLicense' => $expiredLicense,
            'subscribeUrl' => (string) config('iratkapu.subscribe_url', 'https://kapumail.hu/#elofizetes'),
            'githubUrl' => (string) config('iratkapu.github_url', 'https://github.com/interdesigncorp-lab/kapumail'),
        ];
    }

    public static function canSyncOffice(int $officeId): bool
    {
        if (! config('iratkapu.official_build', false)) {
            return true;
        }
        $office = DB::table('offices')->find($officeId);

        return $office ? self::status($office)['canSync'] : false;
    }

    public static function requireActiveForSync(object $office): void
    {
        $status = self::status($office);
        if ($status['canSync']) {
            return;
        }
        throw new HttpResponseException(response()->json([
            'message' => 'A KapuMail 14 napos próbaidőszaka lejárt.',
            'trialExpired' => true,
            'license' => $status,
        ], 402));
    }

    /**
     * Új kriptográfiailag aláírt licenckulcs kibocsátása (ECDSA P-256 + SHA-256).
     */
    public static function issueKey(array $claims, string $privateKeyPem): string
    {
        $payload = [
            'v' => 1,
            'lic' => trim((string) ($claims['lic'] ?? '')),
            'plan' => trim((string) ($claims['plan'] ?? 'hivatalos')),
            'sub' => isset($claims['sub']) && trim((string) $claims['sub']) !== '' ? trim((string) $claims['sub']) : null,
            'exp' => isset($claims['exp']) && trim((string) $claims['exp']) !== '' ? trim((string) $claims['exp']) : null,
            'iat' => (string) ($claims['iat'] ?? now()->toDateString()),
        ];
        if ($payload['lic'] === '') {
            throw new \InvalidArgumentException('A licencazonosító (lic) megadása kötelező.');
        }
        if ($payload['exp'] !== null && ! preg_match('/^\d{4}-\d{2}-\d{2}$/', $payload['exp'])) {
            throw new \InvalidArgumentException('A lejárati dátum (exp) formátuma YYYY-MM-DD kell legyen.');
        }

        $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $payloadB64 = self::b64uEncode((string) $json);
        $sig = '';
        $pkey = openssl_pkey_get_private($privateKeyPem);
        if (! $pkey || ! openssl_sign($payloadB64, $sig, $pkey, OPENSSL_ALGO_SHA256)) {
            throw new \RuntimeException('A licenckulcs aláírása nem sikerült (érvénytelen privát kulcs).');
        }

        return self::PREFIX.'.'.$payloadB64.'.'.self::b64uEncode($sig);
    }

    /**
     * Licenckulcs kriptográfiai aláírásának és szerkezetének offline ellenőrzése.
     */
    public static function verifyKey(?string $rawKey, ?string $publicKeyPem = null): ?array
    {
        $clean = preg_replace('/\s+/', '', (string) $rawKey);
        if ($clean === '') {
            return null;
        }
        $parts = explode('.', $clean);
        if (count($parts) !== 3 || $parts[0] !== self::PREFIX) {
            return null;
        }
        [, $payloadB64, $sigB64] = $parts;
        if ($payloadB64 === '' || $sigB64 === '' || strlen($clean) > 2048) {
            return null;
        }

        $sig = self::b64uDecode($sigB64);
        $payloadJson = self::b64uDecode($payloadB64);
        if ($sig === null || $payloadJson === null) {
            return null;
        }

        $pubPem = $publicKeyPem ?? (string) config('iratkapu.license_public_key', '');
        if (trim($pubPem) === '') {
            return null;
        }
        $pub = @openssl_pkey_get_public($pubPem);
        if (! $pub || @openssl_verify($payloadB64, $sig, $pub, OPENSSL_ALGO_SHA256) !== 1) {
            return null;
        }

        $data = json_decode($payloadJson, true);
        if (! is_array($data) || ($data['v'] ?? null) !== 1) {
            return null;
        }
        $lic = isset($data['lic']) && is_string($data['lic']) ? trim($data['lic']) : '';
        $plan = isset($data['plan']) && is_string($data['plan']) ? trim($data['plan']) : '';
        if ($lic === '' || $plan === '') {
            return null;
        }
        $exp = isset($data['exp']) && is_string($data['exp']) && $data['exp'] !== '' ? trim($data['exp']) : null;
        if ($exp !== null && (! preg_match('/^\d{4}-\d{2}-\d{2}$/', $exp) || strtotime($exp) === false)) {
            return null;
        }
        $sub = isset($data['sub']) && is_string($data['sub']) && trim($data['sub']) !== '' ? trim($data['sub']) : null;

        return [
            'v' => 1,
            'lic' => mb_substr($lic, 0, 80),
            'plan' => mb_substr($plan, 0, 60),
            'sub' => $sub !== null ? mb_substr($sub, 0, 160) : null,
            'exp' => $exp,
            'iat' => isset($data['iat']) && is_string($data['iat']) ? $data['iat'] : null,
        ];
    }

    public static function activate(object $office, object $actor, string $rawKey): array
    {
        $clean = preg_replace('/\s+/', '', $rawKey);
        $verified = self::verifyKey($clean);
        if ($verified === null) {
            throw ValidationException::withMessages([
                'key' => ['Érvénytelen licenckulcs. Ellenőrizd, hogy a teljes KM1. kezdetű kulcsot másoltad-e be.'],
            ]);
        }
        if (! empty($verified['exp']) && $verified['exp'] < now()->toDateString()) {
            throw ValidationException::withMessages([
                'key' => ['Ez a licenckulcs már lejárt ('.$verified['exp'].').'],
            ]);
        }

        DB::table('offices')->where('id', (int) $office->id)->update([
            'license_key' => $clean,
            'license_id' => $verified['lic'],
            'license_plan' => $verified['plan'],
            'license_holder' => $verified['sub'],
            'license_valid_until' => $verified['exp'],
            'license_activated_at' => now(),
            'updated_at' => now(),
        ]);

        Audit::log((int) $office->id, $actor, 'Előfizetési licenckulcs aktiválva: '.$verified['lic'].' ('.$verified['plan'].($verified['exp'] ? ', érvényes: '.$verified['exp'] : '').')', [
            'evidence' => 'ECDSA P-256 offline aláírás-ellenőrzés sikeres',
        ]);

        $fresh = DB::table('offices')->find((int) $office->id);

        return self::status($fresh);
    }

    public static function deactivate(object $office, object $actor): array
    {
        $prev = ($office->license_id ?? null) ?: 'nincs';
        DB::table('offices')->where('id', (int) $office->id)->update([
            'license_key' => null,
            'license_id' => null,
            'license_plan' => null,
            'license_holder' => null,
            'license_valid_until' => null,
            'license_activated_at' => null,
            'updated_at' => now(),
        ]);

        Audit::log((int) $office->id, $actor, 'Előfizetési licenckulcs eltávolítva (korábbi: '.$prev.')');

        $fresh = DB::table('offices')->find((int) $office->id);

        return self::status($fresh);
    }

    private static function b64uEncode(string $bin): string
    {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    }

    private static function b64uDecode(string $str): ?string
    {
        if (! preg_match('/^[A-Za-z0-9_-]+$/', $str)) {
            return null;
        }
        $pad = strlen($str) % 4;
        if ($pad > 0) {
            $str .= str_repeat('=', 4 - $pad);
        }
        $dec = base64_decode(strtr($str, '-_', '+/'), true);

        return $dec === false ? null : $dec;
    }
}
