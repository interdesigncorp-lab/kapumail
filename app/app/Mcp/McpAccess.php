<?php

namespace App\Mcp;

use App\Iratkapu\Audit;
use App\Iratkapu\OfficeMail;
use App\Models\User;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Egy MCP-kapcsolat hozzáférése (ADR-012): kinek a nevében fut, és milyen szinten.
 * A szint a token vagy az OAuth-kliens beállítása; a felhasználó szerepkörénél többet nem ad,
 * mert az eszközök ugyanazokat a vezérlőmetódusokat hívják, mint a felület.
 */
class McpAccess
{
    /** A `kapu` szint (ADR-014) az olvasóval azonos rangú, de a KAPU_EXTRA eszközöket is hívhatja; ezt az `allowsTool` kezeli. */
    public const LEVELS = ['olvasas' => 1, 'munka' => 2, 'admin' => 3, 'kapu' => 1];

    public const LEVEL_NAMES = ['olvasas' => 'olvasás', 'munka' => 'munka', 'admin' => 'admin', 'kapu' => 'Kapu'];

    /** Az olvasó eszközökön felül ezeket hívhatja a Kapu-chat: a beállítások lekérése és módosítása (a módosítás jóváhagyáshoz kötött). */
    public const KAPU_EXTRA = ['get_settings', 'update_settings'];

    private static ?self $current = null;

    public function __construct(
        public User $user,
        public string $level,
        public string $label,
        public ?int $tokenId = null,
        public ?int $grantId = null,
    ) {}

    public static function current(): ?self
    {
        if (self::$current === null && app()->runningInConsole() && ($token = self::envToken()) !== null) {
            // Helyi (stdio) indítás: a token a Claude Desktop / Claude Code beállításából jön, környezeti változóban.
            $access = self::fromToken($token);
            if ($access !== null) {
                self::activate($access);
            }
        }

        return self::$current;
    }

    public static function activate(self $access): void
    {
        self::$current = $access;
        Auth::setUser($access->user);
    }

    public static function forget(): void
    {
        self::$current = null;
    }

    public function allows(string $required): bool
    {
        return self::LEVELS[$this->level] >= self::LEVELS[$required];
    }

    /** Eszköz hívhatósága: a `kapu` szint csak olvasó eszközt és a KAPU_EXTRA beállító eszközöket engedi, a többi szint a rangsor szerint. */
    public function allowsTool(string $toolName, string $required): bool
    {
        if ($this->level === 'kapu') {
            return $required === 'olvasas' || in_array($toolName, self::KAPU_EXTRA, true);
        }

        return $this->allows($required);
    }

    public static function enabled(int $officeId): bool
    {
        return (bool) (OfficeMail::settings($officeId)['mcp']['enabled'] ?? false);
    }

    /** Személyes MCP-token feloldása. Null, ha ismeretlen, visszavont, lejárt, vagy az irodánál ki van kapcsolva az MCP. */
    public static function fromToken(string $plain): ?self
    {
        if (! str_starts_with($plain, 'ik_')) {
            return null;
        }
        $row = DB::table('mcp_tokens')->where('token_hash', hash('sha256', $plain))->whereNull('revoked_at')->first();
        if (! $row || ($row->expires_at && now()->greaterThan($row->expires_at))) {
            return null;
        }
        $user = User::query()->where('office_id', $row->office_id)->find($row->user_id);
        if (! $user || ! self::enabled((int) $row->office_id)) {
            return null;
        }
        DB::table('mcp_tokens')->where('id', $row->id)->update(['last_used_at' => now()]);

        return new self($user, $row->level, "token: {$row->name}", tokenId: (int) $row->id);
    }

    /** OAuth-kapcsolat (ChatGPT, claude.ai): a szint a kliens és a felhasználó párosához tartozik; új kliens olvasási szintet kap. */
    public static function fromOAuth(User $user, string $clientId, string $clientName): ?self
    {
        if (! self::enabled((int) $user->office_id)) {
            return null;
        }
        $grant = DB::table('mcp_grants')->where('oauth_client_id', $clientId)->where('user_id', $user->id)->first();
        if (! $grant) {
            $id = DB::table('mcp_grants')->insertGetId(['office_id' => $user->office_id, 'user_id' => $user->id, 'oauth_client_id' => $clientId,
                'level' => 'olvasas', 'created_at' => now(), 'updated_at' => now()]);
            Audit::log($user->office_id, $user, "MCP: új OAuth-kapcsolat ({$clientName}), olvasási szinttel");
            $grant = DB::table('mcp_grants')->find($id);
        }
        if ($grant->revoked_at) {
            return null;
        }
        DB::table('mcp_grants')->where('id', $grant->id)->update(['last_used_at' => now()]);

        return new self($user, $grant->level, "OAuth: {$clientName}", grantId: (int) $grant->id);
    }

    /**
     * Új személyes token. A nyers értéket csak most adjuk vissza, tároláskor csak a hash-e marad meg.
     *
     * @return array{id: int, token: string}
     */
    public static function issue(object $user, string $name, string $level, ?string $expiresAt): array
    {
        $plain = 'ik_'.Str::random(40);
        $id = DB::table('mcp_tokens')->insertGetId(['office_id' => $user->office_id, 'user_id' => $user->id, 'name' => $name,
            'token_hash' => hash('sha256', $plain), 'hint' => substr($plain, -4), 'level' => $level, 'expires_at' => $expiresAt,
            'created_at' => now(), 'updated_at' => now()]);

        return ['id' => $id, 'token' => $plain];
    }

    private static function envToken(): ?string
    {
        $token = $_SERVER['IRATKAPU_MCP_TOKEN'] ?? $_ENV['IRATKAPU_MCP_TOKEN'] ?? getenv('IRATKAPU_MCP_TOKEN');

        return is_string($token) && $token !== '' ? trim($token) : null;
    }
}
