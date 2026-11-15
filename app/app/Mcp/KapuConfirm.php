<?php

namespace App\Mcp;

use App\Iratkapu\Audit;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Kapu-chat (ADR-014): a `kapu` szintű beállítás-módosítás csak a felhasználó jóváhagyása után fut.
 * Az első hívás kérést ment (mi változna, régi → új), a felület ezt jóváhagyó kártyán mutatja; a jóváhagyott kérés
 * egyszer használható, 10 percig él, és csak pontosan ugyanarra a módosításra (payload_hash), ugyanattól a kapcsolattól.
 * Az egy napnál régebbi sorokat minden új kérés törli.
 */
class KapuConfirm
{
    public const TTL_MINUTES = 10;

    /** A kérés azonosítója a bemenetből: a `confirm_id` nélküli, kulcs szerint rendezett adatok SHA-256-ja. */
    public static function hash(array $payload): string
    {
        unset($payload['confirm_id']);

        return hash('sha256', json_encode(self::sorted($payload)));
    }

    /**
     * Új jóváhagyási kérés. A summary sorai: [label, from, to].
     *
     * @param  array<int, array{label: string, from: string, to: string}>  $summary
     */
    public static function request(McpAccess $a, array $payload, array $summary): string
    {
        unset($payload['confirm_id']);
        // Takarítás: az egy napnál régebbi kérések (lejártak, felhasználták vagy elhagyták) már semmire nem kellenek.
        DB::table('kapu_confirmations')->where('created_at', '<', now()->subDay())->delete();
        $id = (string) Str::uuid();
        DB::table('kapu_confirmations')->insert(['id' => $id, 'office_id' => $a->user->office_id, 'user_id' => $a->user->id, 'token_id' => $a->tokenId,
            'payload_hash' => self::hash($payload), 'payload' => json_encode($payload, JSON_UNESCAPED_UNICODE), 'summary' => json_encode(array_values($summary), JSON_UNESCAPED_UNICODE),
            'expires_at' => now()->addMinutes(self::TTL_MINUTES), 'created_at' => now(), 'updated_at' => now()]);

        return $id;
    }

    /** A jóváhagyott, le nem járt, még fel nem használt kérés felhasználása. Atomikus: két párhuzamos hívásból csak egy kap igazat. */
    public static function consume(McpAccess $a, string $id, array $payload): bool
    {
        if (! Str::isUuid($id)) {
            return false;
        }

        return DB::table('kapu_confirmations')->where('id', $id)->where('office_id', $a->user->office_id)->where('user_id', $a->user->id)
            ->where(fn ($q) => $a->tokenId === null ? $q->whereNull('token_id') : $q->where('token_id', $a->tokenId))
            ->where('payload_hash', self::hash($payload))->whereNotNull('approved_at')->whereNull('used_at')->where('expires_at', '>', now())
            ->update(['used_at' => now(), 'updated_at' => now()]) === 1;
    }

    /**
     * A jóváhagyó kártya adatai. Csak a kérés gazdája láthatja (más felhasználónak 403, ismeretlen azonosítóra 404).
     *
     * @return array{id: string, summary: array<int, array{label: string, from: string, to: string}>, expires_at: string, approved: bool}
     */
    public static function card(User $u, string $id): array
    {
        return self::view(self::own($u, $id));
    }

    /** Jóváhagyás a felületről, a kérés gazdájának munkamenetével. Lejárt kérésre 410, felhasználtra 409. */
    public static function approve(User $u, string $id): array
    {
        $row = self::own($u, $id);
        abort_if($row->used_at !== null, 409, 'Ezt a módosítást már végrehajtották.');
        abort_if(now()->greaterThanOrEqualTo($row->expires_at), 410, 'A jóváhagyási kérés lejárt. Kérd meg Kaput, hogy kérdezzen újra.');
        if ($row->approved_at === null) {
            DB::table('kapu_confirmations')->where('id', $row->id)->update(['approved_at' => now(), 'updated_at' => now()]);
            $labels = implode(', ', array_map(fn ($s) => "{$s['label']}: {$s['from']} → {$s['to']}", json_decode($row->summary, true)));
            Audit::log($u->office_id, $u, "Kapu: beállítás jóváhagyva – {$labels}");
            $row = DB::table('kapu_confirmations')->find($row->id);
        }

        return self::view($row);
    }

    private static function own(User $u, string $id): object
    {
        $row = Str::isUuid($id) ? DB::table('kapu_confirmations')->where('office_id', $u->office_id)->find($id) : null;
        abort_if(! $row, 404, 'Nincs ilyen jóváhagyási kérés.');
        abort_if((int) $row->user_id !== (int) $u->id, 403, 'Ezt a módosítást csak az hagyhatja jóvá, aki Kapuval beszélget.');

        return $row;
    }

    private static function view(object $row): array
    {
        return ['id' => $row->id, 'summary' => json_decode($row->summary, true), 'expires_at' => \Illuminate\Support\Carbon::parse($row->expires_at)->toIso8601String(),
            'approved' => $row->approved_at !== null];
    }

    /** Asszociatív tömbök kulcs szerint rendezve, rekurzívan; a listák sorrendje megmarad (az [5, 1] és az [1, 5] más kérés). */
    private static function sorted(mixed $v): mixed
    {
        if (! is_array($v)) {
            return $v;
        }
        $v = array_map(self::sorted(...), $v);
        if (! array_is_list($v)) {
            ksort($v);
        }

        return $v;
    }
}
