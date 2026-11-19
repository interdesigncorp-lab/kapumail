<?php

namespace App\Iratkapu;

use Illuminate\Support\Facades\DB;

/**
 * A NAV-portálról újra és újra kiolvasott sorok (beadott bevallások, NAV-dokumentumok) mentése úgy, hogy kiderüljön,
 * mi volt valóban új, mi változott, és mi maradt ugyanaz. A szinkron összesítője így nem az összes visszakapott sort
 * mutatja „átvettnek”. Sort soha nem töröl: a `fetched_at` mindig frissül, ez az „utoljára látva a NAV-nál” időpont.
 */
class NavRowSync
{
    /** @var list<string> A változás megítélésénél figyelmen kívül hagyott oszlopok. */
    private const IGNORED = ['office_id', 'fetched_at', 'updated_at', 'created_at'];

    /**
     * Egy sor beszúrása vagy frissítése. Visszaadja, hogy a sor új volt („new”), tartalmilag változott („changed”),
     * vagy csak újra látta a program („same”).
     *
     * @param  array<string, mixed>  $key
     * @param  array<string, mixed>  $values
     */
    public static function upsert(string $table, array $key, array $values): string
    {
        $existing = DB::table($table)->where($key)->first();
        if (! $existing) {
            DB::table($table)->insert($key + $values + ['created_at' => $values['updated_at'] ?? now()]);

            return 'new';
        }
        $changed = false;
        foreach ($values as $col => $val) {
            if (in_array($col, self::IGNORED, true)) {
                continue;
            }
            $old = $existing->{$col} ?? null;
            if (self::norm($old) !== self::norm($val)) {
                $changed = true;
                break;
            }
        }
        DB::table($table)->where('id', $existing->id)->update($values);

        return $changed ? 'changed' : 'same';
    }

    /** Összehasonlítható alak: a szám és a szöveg ugyanannak számít, az üres szöveg a hiánynak; a dátumból csak a nap. */
    private static function norm(mixed $v): ?string
    {
        if ($v === null) {
            return null;
        }
        if (is_bool($v)) {
            return $v ? '1' : '0';
        }
        $s = trim((string) $v);
        if ($s === '') {
            return null;
        }
        if (preg_match('/^(\d{4}-\d{2}-\d{2}) 00:00:00$/', $s, $m)) {
            return $m[1];
        }

        return $s;
    }
}
