<?php
namespace App\Iratkapu;

use Carbon\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Az adózónak menő hátralék-értesítő és fizetési emlékeztető (napi futásra). A levél soha nem állítja, hogy a program fizetett,
 * és összeget a bevallásról nem mond. Nyitott adatbázis-tranzakción belül nem hívható. Mindkettő a kiküldött levelek számát adja.
 */
final class ClientReminders
{
    /** A NAV-pillanatkép legfeljebb ennyi napos lehet. */
    private const MAX_AGE_DAYS = 7;

    public static function arrears(int $officeId, Carbon $today): int
    {
        $days = OfficeMail::office($officeId)['arrearsDays']; $today = $today->copy()->startOfDay(); $n = 0;
        if ($days <= 0) return 0;
        $clients = DB::table('clients')->where('office_id', $officeId)->where('active', true)->where('arrears_notice', true)->orderBy('id')->get();
        foreach ($clients as $c) {
            $s = DB::table('nav_client_snapshots')->where('client_id', $c->id)->first();
            if (!$s || (int) $s->debt <= 0) continue;
            $at = Carbon::parse($s->fetched_at);
            if ($at->copy()->startOfDay()->diffInDays($today) > self::MAX_AGE_DAYS) { Audit::log($officeId, null, "Hátralék-értesítő kihagyva (elavult NAV-adat, lekérdezve: {$at->format('Y-m-d H:i')}): {$c->name}", ['client_id' => $c->id]); continue; }
            $last = DB::table('client_notices')->where('client_id', $c->id)->where('kind', 'arr')->where('status', 'sent')->max('sent_at');
            if ($last && (int) Carbon::parse($last)->startOfDay()->diffInDays($today) < $days) continue;
            $body = "Tisztelt Ügyfelünk!\n\nA NAV adószámláján hátralék látszik: " . number_format((int) $s->debt, 0, ',', ' ') . " Ft (lekérdezve: {$at->format('Y-m-d H:i')}).\n\nEz a NAV-adatok lekérdezéskori állapota; a NAV-folyószámla az irányadó.\nHa a hátralékot már rendezte, ez a levél tárgytalan. Kérdés esetén keresse könyvelőjét.";
            $n += ClientMail::toClient($officeId, (int) $c->id, 'arr', "arr:{$c->id}:{$today->format('Y-m-d')}", "Hátralék a NAV-nál: {$c->name}", $body)['sent'];
        }
        return $n;
    }

    public static function payments(int $officeId, Carbon $today): int
    {
        $thresholds = OfficeMail::office($officeId)['paymentDays']; sort($thresholds); $today = $today->copy()->startOfDay(); $n = 0;
        if (!$thresholds) return 0;
        $clients = DB::table('clients')->where('office_id', $officeId)->where('active', true)->where('payment_notice', true)->get()->keyBy('id');
        if ($clients->isEmpty()) return 0;
        $obls = DB::table('tax_obligations')->where('office_id', $officeId)->whereIn('client_id', $clients->keys())->where('conditional', false)->where('due_date', '>=', $today->format('Y-m-d'))->orderBy('due_date')->orderBy('id')->get();
        foreach ($obls as $o) {
            $left = (int) $today->diffInDays(Carbon::parse($o->due_date)->startOfDay());
            $t = collect($thresholds)->first(fn ($x) => $left <= $x);
            if ($t === null) continue;
            $c = $clients[$o->client_id]; $lines = TaxPayment::lines((string) $o->form_code, (string) $c->tax);
            if (!$lines) continue;
            $period = $o->period_start ? ' (időszak: ' . $o->period_start . ($o->period_end ? ' – ' . $o->period_end : '') . ')' : '';
            $body = "Tisztelt Ügyfelünk!\n\nEmlékeztető a közelgő befizetésről.\n\nNyomtatvány: {$o->title}$period\nEsedékesség: {$o->due_date}\n";
            foreach ($lines as $l) $body .= "\nSzámla neve: {$l['name']}\nSzámlaszám: {$l['account']}\nKözlemény: {$l['reference']}\n";
            $body .= "\nA fizetendő összeget a bevallás tartalmazza; kérdés esetén keresse könyvelőjét.\nHa a befizetés már megtörtént, ez a levél tárgytalan.";
            $n += ClientMail::toClient($officeId, (int) $c->id, 'pay', "pay:{$o->id}:$t", "Fizetési emlékeztető: {$o->title}, esedékes {$o->due_date}", $body)['sent'];
        }
        return $n;
    }
}
