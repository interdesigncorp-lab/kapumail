<?php
namespace App\Iratkapu;

use Illuminate\Support\Facades\DB;

/**
 * Irattípusonkénti irodai beállítások: kinek menjen e-mail, automatikus archiválás, rejtés, kezdő állapot, Joghatály (nap).
 * Ami nincs eltárolva (vagy ismeretlen típus), annak az értéke a típus alapértéke (DEFAULTS + a típuslista joghatálya); az alapértékre állított sor törlődik.
 */
final class TypeSettings
{
    public const DEFAULTS = ['emailTo' => 'none', 'autoArchive' => false, 'hidden' => false, 'initialState' => 'uj', 'legalDays' => null];
    public const EMAIL_TO = ['none', 'client', 'assignee', 'both'];
    public const STATES = ['uj', 'kiosztott', 'folyamatban', 'ell', 'kesz'];
    public const LABELS = ['emailTo' => 'Email-ben kiküldés', 'autoArchive' => 'Archiválás', 'hidden' => 'Nem kell', 'initialState' => 'Kezdő állapot', 'legalDays' => 'Joghatály'];
    private static array $cache = [];
    private static ?array $typeDefaults = null;

    /** Egy beállítás értéke emberi nyelven (audit, Kapu jóváhagyó kártyája). */
    public static function show(string $key, mixed $v): string
    {
        return match (true) {
            $key === 'emailTo' => ['none' => 'nincs', 'client' => 'ügyfélnek', 'assignee' => 'felelősnek', 'both' => 'mindkettőnek'][$v] ?? (string) $v,
            $key === 'initialState' => ['uj' => 'új', 'kiosztott' => 'kiosztott', 'folyamatban' => 'folyamatban', 'ell' => 'ellenőrzésre vár', 'kesz' => 'kész'][$v] ?? (string) $v,
            $key === 'legalDays' => $v === null ? 'nincs' : "$v nap",
            default => $v ? 'igen' : 'nem',
        };
    }

    /** A típus beépített alapértékei (a Joghatály a típuslista default_legal_days mezőjéből jön, ha van). */
    public static function defaultsFor(?string $typeId): array
    {
        if ($typeId === null) {
            return self::DEFAULTS;
        }
        self::$typeDefaults ??= DB::table('document_types')->get()
            ->mapWithKeys(fn ($r) => [$r->type_id => ($r->default_legal_days ?? null) !== null ? (int) $r->default_legal_days : null])
            ->all();
        $canon = DownloadPolicy::ALIASES[$typeId] ?? $typeId;

        return array_replace(self::DEFAULTS, ['legalDays' => self::$typeDefaults[$canon] ?? null]);
    }

    public static function for(int $officeId, ?string $typeId): array
    {
        self::$cache[$officeId] ??= DB::table('document_type_settings')->where('office_id', $officeId)->get()->keyBy('type_id')->map(fn ($r) => [
            'emailTo' => $r->email_to, 'autoArchive' => (bool) $r->auto_archive, 'hidden' => (bool) $r->hidden, 'initialState' => $r->initial_state, 'legalDays' => ($r->legal_days ?? null) !== null ? (int) $r->legal_days : null,
        ])->all();
        if ($typeId === null) {
            return self::DEFAULTS;
        }
        $canon = DownloadPolicy::ALIASES[$typeId] ?? $typeId;

        return self::$cache[$officeId][$typeId] ?? self::$cache[$officeId][$canon] ?? self::defaultsFor($canon);
    }

    public static function flush(): void
    {
        self::$cache = [];
        self::$typeDefaults = null;
    }
}
