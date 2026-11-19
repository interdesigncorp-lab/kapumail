<?php

namespace App\Iratkapu;

use App\Mcp\McpAccess;
use Illuminate\Support\Facades\DB;

/**
 * MCP-ből indítható szinkron (ADR-016): az MI-kapcsolatok szinkronkérései.
 * A kérést az MCP-eszköz adja le, az asztali app felülete veszi fel és futtatja le; a lejáratot olvasáskor számoljuk,
 * mert helyi módban a Laravel-szerver csak az app futása alatt él (ütemező nincs).
 */
class McpSyncRequests
{
    /** Két befejezett kérés között legalább ennyi idő teljen el (az állami oldalak kíméletéért). */
    public const MIN_GAP_MINUTES = 15;

    /** Nem futó appnál a függő kérés ennyi idő után lejár (az indítás nem sikerült). */
    public const PENDING_DEAD_SECONDS = 180;

    /** Futó appnál is lejár a függő kérés ennyi idő után (pl. az appban nem admin/vezető van bejelentkezve). */
    public const PENDING_MAX_MINUTES = 60;

    /** A futó kérés ennyi idő után megszakadtnak számít (kilépett vagy összeomlott az app); sok belépőnél egy futás 1–2 óráig is tarthat. */
    public const RUNNING_MAX_MINUTES = 150;

    /**
     * Új kérés, vagy a meglévő függő/futó kérés visszaadása. Ha a legutóbbi befejezett kérés óta nem telt el MIN_GAP_MINUTES, nem nyit újat.
     *
     * @return array{request: array<string, mixed>, created: bool, retry_after: ?string}
     */
    public static function request(McpAccess $a, bool $appAlive): array
    {
        $officeId = (int) $a->user->office_id;
        self::sweep($officeId, $appAlive);
        $open = DB::table('mcp_sync_requests')->where('office_id', $officeId)->whereIn('status', ['pending', 'running'])->orderBy('id')->first();
        if ($open) {
            return ['request' => (array) $open, 'created' => false, 'retry_after' => null];
        }
        // A korlát minden olyan futásra vonatkozik, amely elindult (a sikertelen is beléphetett az állami oldalakra).
        $last = DB::table('mcp_sync_requests')->where('office_id', $officeId)->whereIn('status', ['done', 'failed'])->whereNotNull('started_at')
            ->where('finished_at', '>', now()->subMinutes(self::MIN_GAP_MINUTES))->orderByDesc('id')->first();
        if ($last && ($last->finished_at ?? null)) {
            return ['request' => (array) $last, 'created' => false,
                'retry_after' => now()->parse($last->finished_at ?? null)->addMinutes(self::MIN_GAP_MINUTES)->toIso8601String()];
        }
        $id = DB::table('mcp_sync_requests')->insertGetId(['office_id' => $officeId, 'user_id' => $a->user->id, 'source' => mb_substr($a->label, 0, 120),
            'token_id' => $a->tokenId, 'grant_id' => $a->grantId, 'status' => 'pending', 'created_at' => now()]);

        return ['request' => (array) DB::table('mcp_sync_requests')->find($id), 'created' => true, 'retry_after' => null];
    }

    /**
     * Egy kérés (vagy id nélkül az iroda legutóbbi kérése), a lejárat alkalmazása után.
     *
     * @return array<string, mixed>|null
     */
    public static function find(int $officeId, ?int $id, bool $appAlive): ?array
    {
        self::sweep($officeId, $appAlive);
        $q = DB::table('mcp_sync_requests')->where('office_id', $officeId);
        $row = $id !== null ? $q->where('id', $id)->first() : $q->orderByDesc('id')->first();

        return $row ? (array) $row : null;
    }

    /**
     * A legrégebbi függő kérés: ezt veszi fel az asztali app. A felvevő app él, ezért élő appként sepre.
     *
     * @return array<string, mixed>|null
     */
    public static function next(int $officeId): ?array
    {
        self::sweep($officeId, true);
        $row = DB::table('mcp_sync_requests')->where('office_id', $officeId)->where('status', 'pending')->orderBy('id')->first();

        return $row ? (array) $row : null;
    }

    public static function start(int $officeId, int $id): bool
    {
        return DB::table('mcp_sync_requests')->where('office_id', $officeId)->where('id', $id)->where('status', 'pending')
            ->update(['status' => 'running', 'started_at' => now()]) === 1;
    }

    public static function finish(int $officeId, int $id, bool $ok, ?string $note): bool
    {
        return DB::table('mcp_sync_requests')->where('office_id', $officeId)->where('id', $id)->where('status', 'running')
            ->update(['status' => $ok ? 'done' : 'failed', 'note' => $note !== null ? mb_substr($note, 0, 300) : null, 'finished_at' => now()]) === 1;
    }

    /** Lejárat: függő kérés nem futó appnál PENDING_DEAD_SECONDS, egyébként PENDING_MAX_MINUTES után; futó kérés RUNNING_MAX_MINUTES után. */
    private static function sweep(int $officeId, bool $appAlive): void
    {
        $base = fn () => DB::table('mcp_sync_requests')->where('office_id', $officeId);
        $base()->where('status', 'pending')->where('created_at', '<', $appAlive ? now()->subMinutes(self::PENDING_MAX_MINUTES) : now()->subSeconds(self::PENDING_DEAD_SECONDS))
            ->update(['status' => 'expired', 'finished_at' => now(), 'note' => $appAlive
                ? 'Az asztali app nem vette fel a kérést (nem admin vagy vezető van bejelentkezve, vagy foglalt volt).'
                : 'A KapuMail nem indult el, vagy nem jelentkezett időben.']);
        $base()->where('status', 'running')->where('started_at', '<', now()->subMinutes(self::RUNNING_MAX_MINUTES))
            ->update(['status' => 'failed', 'finished_at' => now(), 'note' => 'A futás megszakadt (a KapuMail kilépett vagy leállt).']);
    }
}
