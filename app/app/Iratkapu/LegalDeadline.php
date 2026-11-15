<?php

namespace App\Iratkapu;

use Carbon\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Joghatály: az irattípushoz megadott napszám az átvételtől (vagy a kézbesítési vélelem beálltától) számít.
 * A kezdőnapot nem számoljuk; ha a lejárat hétvégére vagy ünnepre esik, a következő munkanap a határidő.
 * Becslés: az évente áthelyezett munkanapokat a WorkCalendar nem ismeri, ezért a határidő nem biztos.
 */
final class LegalDeadline
{
    public static function due(Carbon $receivedAt, int $days): Carbon
    {
        $d = $receivedAt->copy()->startOfDay()->addDays($days);
        while (! WorkCalendar::isWorkday($d)) {
            $d->addDay();
        }

        return $d;
    }

    public static function apply(int $messageId): void
    {
        $m = DB::table('messages')->find($messageId);
        if (! $m || ($m->folder ?? null) === 'ELKULDOTT' || ! in_array($m->official, ['ok', 'fic'], true) || ! $m->official_at) {
            return;
        }
        $days = TypeSettings::for((int) $m->office_id, $m->type_id)['legalDays'];
        if (! $days) {
            return;
        }
        $due = self::due(Carbon::parse($m->official_at), $days)->toDateString();
        $upd = ['legal_date' => $due, 'updated_at' => now()];
        if (! $m->deadline_date) {
            $upd += ['deadline_date' => $due, 'deadline_sure' => false, 'deadline_source' => "Irattípus: $days nap az átvételtől"];
        }
        DB::table('messages')->where('id', $messageId)->update($upd);
    }
}
