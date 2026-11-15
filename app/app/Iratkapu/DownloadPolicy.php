<?php

namespace App\Iratkapu;

use Illuminate\Support\Facades\DB;

/**
 * Irattípusonkénti letöltési szabály (ADR-009).
 *  - auto:       a program magától letöltheti;
 *  - kezi:       csak ember, gombnyomásra;
 *  - csak_lista: a program nem tölti le, kézi parancsra sem.
 * Amit a program nem ismer (ismeretlen vagy a típuslistában nem szereplő azonosító), az mindig `kezi`.
 */
final class DownloadPolicy
{
    public const AUTO = 'auto';

    public const KEZI = 'kezi';

    public const CSAK_LISTA = 'csak_lista';

    /** Szigorúsági sorrend: a nagyobb a szigorúbb. */
    public const RANK = ['auto' => 0, 'kezi' => 1, 'csak_lista' => 2];

    /** A demó mintaadatok régi azonosítói → a típuslista mai azonosítói, hogy a demó is a valódi szabályt mutassa. */
    public const ALIASES = [
        'nav-hianypotlas' => 'nav.felszolitas.hianypotlas', 'nav-felszolitas' => 'nav.bevallas.felszolitas', 'nav-hatarozat' => 'nav.adoalany.hatarozat',
        'nav-ellenorzes' => 'nav.ellenorzes.ertesites', 'nav-tajekoztatas' => 'nav.tajekoztatas.altalanos', 'cegbirosag-vegzes' => 'ceg.cegbirosag.vegzes',
        'onk-egyenlegkozlo' => 'onk.hipa.egyenleg', 'onk-hatarozat' => 'onk.irat.egyeb', 'birosag' => 'birosag.irat',
    ];

    private static ?array $defaults = null;

    private static function canon(?string $typeId): ?string
    {
        return $typeId !== null ? (self::ALIASES[$typeId] ?? $typeId) : null;
    }

    private static array $overrides = [];

    /** A típuslista alapértéke; ismeretlen vagy nem létező típus: KEZI. */
    public static function defaultForType(?string $typeId): string
    {
        self::$defaults ??= DB::table('document_types')->pluck('download_policy', 'type_id')->all();
        $typeId = self::canon($typeId);
        $p = $typeId !== null ? (self::$defaults[$typeId] ?? null) : null;

        return isset(self::RANK[$p]) ? $p : self::KEZI;
    }

    /** Létezik-e a típus a típuslistában (vagyis ismert-e a program számára). */
    public static function knownType(?string $typeId): bool
    {
        self::defaultForType($typeId);
        $typeId = self::canon($typeId);

        return $typeId !== null && isset(self::$defaults[$typeId]);
    }

    /** Irodai felülírás, különben a típus alapértéke. */
    public static function forType(int $officeId, ?string $typeId): string
    {
        self::$overrides[$officeId] ??= DB::table('document_type_overrides')->where('office_id', $officeId)->pluck('policy', 'type_id')->all();
        $o = $typeId !== null ? (self::$overrides[$officeId][self::canon($typeId)] ?? null) : null;

        return self::knownType($typeId) && isset(self::RANK[$o]) ? $o : self::defaultForType($typeId);
    }

    /**
     * A típus szabálya; Hivatali kapu postafiókban az AUTO KEZI-re szigorodik.
     * Tulajdonosi döntés (2026-11-13): a CSAK_LISTA típus KEZI-re enyhül, ha az iratot a hivatalos tárhelyen már átvették:
     * a tartós tárban van, vagy a tárhely megnyitottnak jelzi. Automatikusan így sem tölthető le (lásd autoDecision).
     * Olvasatlan és ismeretlen állapotú iratnál a tiltás marad.
     */
    public static function forMessage(object $message, object $mailbox): string
    {
        if (! empty($message->hidden)) {
            return self::CSAK_LISTA;
        } // „Nem kell” típus: az irat nem töltődik le, kézzel sem
        if (($message->folder ?? null) === 'ELKULDOTT') {
            return TypeSettings::for((int) $message->office_id, $message->type_id ?? null)['hidden'] ? self::CSAK_LISTA : self::AUTO;
        }
        $p = self::forType((int) $message->office_id, $message->type_id ?? null);
        $taken = (! empty($message->durable) && ($message->folder ?? null) === 'TARTOS_TAR') || (($message->portal_opened ?? null) !== null && (bool) $message->portal_opened);
        if ($p === self::CSAK_LISTA && $taken) {
            return self::KEZI;
        }
        if (! empty($message->unknown) && $p === self::AUTO) {
            $p = self::KEZI;
        }

        return $p === self::AUTO && ($mailbox->type ?? null) === 'HK' ? self::KEZI : $p;
    }

    /**
     * Letölthető-e az irat automatikusan. null = nem.
     * Különben ['via' => 'type', 'rule' => null] (a típus szabálya engedi)
     * vagy ['via' => 'rule', 'rule' => object] (ismert, kézi típusra az iroda felülíró szabálya).
     */
    public static function autoDecision(object $message, object $mailbox): ?array
    {
        if (! config('iratkapu.live_download')) {
            return null;
        }
        if ($mailbox->portal_connection_id) {
            $active = DB::table('portal_connections')->where('id', $mailbox->portal_connection_id)->value('download_active');
            if ($active !== null && ! $active) {
                return null;
            }
        }
        if (! empty($message->hidden) || TypeSettings::for((int) $message->office_id, $message->type_id ?? null)['hidden']) {
            return null;
        } // „Nem kell” típus, akkor is, ha később állították be
        if ($message->official !== 'listed') {
            return null;
        }
        // Ha az irathoz már van fájl (például kézzel feltöltötték), nincs mit automatikusan letölteni.
        if (DB::table('documents')->where('message_id', $message->id)->exists()) {
            return null;
        }
        if (($message->folder ?? null) === 'ELKULDOTT') {
            return ['via' => 'type', 'rule' => null];
        }
        // A „csak lista” típus soha nem megy automatikusan, akkor sem, ha a tartós tárban kézzel már letölthető.
        if (self::forType((int) $message->office_id, $message->type_id ?? null) === self::CSAK_LISTA) {
            return null;
        }
        $p = self::forMessage($message, $mailbox);
        if ($p === self::CSAK_LISTA) {
            return null;
        }
        if ($p === self::AUTO) {
            return ['via' => 'type', 'rule' => null];
        }
        if (! empty($message->unknown) || ! self::knownType($message->type_id ?? null)) {
            return null;
        }
        if (($mailbox->type ?? null) === 'HK') {
            return null;
        }
        $rule = RuleEngine::matchedRule($message);

        return $rule && ($rule->download_mode ?? 'manual') === 'auto_override_legal' ? ['via' => 'rule', 'rule' => $rule] : null;
    }

    public static function flush(): void
    {
        self::$defaults = null;
        self::$overrides = [];
    }
}
