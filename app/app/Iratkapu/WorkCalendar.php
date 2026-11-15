<?php
namespace App\Iratkapu;

use Carbon\Carbon;

/**
 * Magyar munkanap-naptár a „munkanapon belül” határidők becsléséhez: hétvége és munkaszüneti nap nem munkanap.
 * Az évente rendelettel áthelyezett munkanapokat (szombati munkanap, hétköznapi pihenőnap) NEM ismeri,
 * ezért az így számolt határidő becslés marad, amelyet embernek kell megerősítenie.
 */
final class WorkCalendar
{
    /** Húsvétvasárnap (Gergely-naptár, névtelen algoritmus). */
    public static function easter(int $year): Carbon
    {
        $a = $year % 19; $b = intdiv($year, 100); $c = $year % 100; $d = intdiv($b, 4); $e = $b % 4;
        $f = intdiv($b + 8, 25); $g = intdiv($b - $f + 1, 3); $h = (19 * $a + $b - $d - $g + 15) % 30;
        $i = intdiv($c, 4); $k = $c % 4; $l = (32 + 2 * $e + 2 * $i - $h - $k) % 7; $m = intdiv($a + 11 * $h + 22 * $l, 451);
        return Carbon::create($year, intdiv($h + $l - 7 * $m + 114, 31), (($h + $l - 7 * $m + 114) % 31) + 1);
    }

    /**
     * A munkaszüneti napok egy évben: a rögzített napok, nagypéntek, húsvéthétfő és pünkösdhétfő.
     *
     * @return array<int, string> ÉÉÉÉ-HH-NN, növekvő sorrendben
     */
    public static function holidays(int $year): array
    {
        $e = self::easter($year);
        $days = array_map(fn ($x) => "$year-$x", ['01-01', '03-15', '05-01', '08-20', '10-23', '11-01', '12-25', '12-26']);
        foreach ([-2, 1, 50] as $offset) {
            $days[] = $e->copy()->addDays($offset)->toDateString();
        }
        sort($days);
        return $days;
    }

    public static function isWorkday(Carbon $day): bool
    {
        return !$day->isWeekend() && !in_array($day->toDateString(), self::holidays($day->year), true);
    }

    /** A kezdőnap utáni n-edik munkanap. */
    public static function addWorkdays(Carbon $from, int $n): Carbon
    {
        $d = $from->copy()->startOfDay();
        while ($n > 0) {
            $d->addDay();
            if (self::isWorkday($d)) {
                $n--;
            }
        }
        return $d;
    }
}
