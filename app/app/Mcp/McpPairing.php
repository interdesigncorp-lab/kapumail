<?php

namespace App\Mcp;

use App\Iratkapu\Audit;
use Illuminate\Support\Facades\DB;

/**
 * Párosító kód a közvetítőn át csatlakozó ChatGPT / claude.ai számára (ADR-013). A helyi fióknak nincs jelszava, ezért
 * az OAuth-bejelentkezés egy, a KapuMail beállításaiban kért, 10 percig érvényes, egyszer használható kóddal történik.
 * Öt rossz próbálkozás után minden függő kód érvénytelen.
 */
class McpPairing
{
    public const TTL_MINUTES = 10;

    public const MAX_ATTEMPTS = 5;

    private static function hash(string $code): string
    {
        return hash_hmac('sha256', preg_replace('/\D/', '', $code), (string) config('app.key'));
    }

    /** @return array{code: string, expires_at: string} */
    public static function create(object $user, string $level): array
    {
        DB::table('mcp_pairings')->where('office_id', $user->office_id)->whereNull('used_at')->update(['expires_at' => now()]);
        $code = str_pad((string) random_int(0, 99_999_999), 8, '0', STR_PAD_LEFT);
        $expires = now()->addMinutes(self::TTL_MINUTES);
        DB::table('mcp_pairings')->insert(['office_id' => $user->office_id, 'user_id' => $user->id, 'code_hash' => self::hash($code),
            'level' => $level, 'expires_at' => $expires, 'created_at' => now(), 'updated_at' => now()]);

        return ['code' => substr($code, 0, 4).' '.substr($code, 4), 'expires_at' => $expires->toIso8601String()];
    }

    /** A beírt kód beváltása. Siker esetén a párosítás sora; rossz kódnál a függő kódok próbálkozásszáma nő. */
    public static function redeem(string $code): ?object
    {
        $active = DB::table('mcp_pairings')->whereNull('used_at')->where('expires_at', '>', now())->where('attempts', '<', self::MAX_ATTEMPTS)->get();
        $hash = self::hash($code);
        foreach ($active as $p) {
            if (hash_equals($p->code_hash, $hash)) {
                DB::table('mcp_pairings')->where('id', $p->id)->update(['used_at' => now(), 'updated_at' => now()]);

                return DB::table('mcp_pairings')->find($p->id);
            }
        }
        if ($active->isNotEmpty()) {
            DB::table('mcp_pairings')->whereIn('id', $active->pluck('id'))->increment('attempts');
        }

        return null;
    }

    /**
     * Az OAuth-token kiadásakor (Passport AccessTokenCreated): a frissen beváltott párosítás szintje az adott kliensre.
     * Csak a még nem alkalmazott, 30 percen belül beváltott párosítás számít; a token frissítése nem módosít semmit.
     */
    public static function applyToClient(?string $userId, string $clientId): void
    {
        if ($userId === null) {
            return;
        }
        $p = DB::table('mcp_pairings')->where('user_id', $userId)->whereNotNull('used_at')->whereNull('oauth_client_id')
            ->where('used_at', '>', now()->subMinutes(30))->orderByDesc('id')->first();
        if (! $p) {
            return;
        }
        DB::table('mcp_pairings')->where('id', $p->id)->update(['oauth_client_id' => $clientId, 'updated_at' => now()]);
        DB::table('mcp_grants')->updateOrInsert(['oauth_client_id' => $clientId, 'user_id' => $p->user_id],
            ['office_id' => $p->office_id, 'level' => $p->level, 'revoked_at' => null, 'updated_at' => now(), 'created_at' => now()]);
        $user = DB::table('users')->find($p->user_id);
        $name = DB::table('oauth_clients')->where('id', $clientId)->value('name') ?? 'OAuth-kliens';
        Audit::log((int) $p->office_id, $user, "MCP: {$name} csatlakozott a közvetítőn át (".McpAccess::LEVEL_NAMES[$p->level].' szint)');
    }
}
