<?php

namespace App\Iratkapu;

use Carbon\Carbon;
use Illuminate\Support\Facades\DB;

/** A munkatársaknak menő összesítő email (napi futásra): csak a felhasználó által látott ügyfelekről, üresen nem megy. Nyitott tranzakción belül nem hívható. */
final class Digest
{
    /** A kiküldött levelek száma. */
    public static function run(int $officeId, Carbon $today): int
    {
        $days = OfficeMail::office($officeId)['digestDays'];
        $today = $today->copy()->startOfDay();
        $n = 0;
        if ($days <= 0) {
            return 0;
        }
        $office = DB::table('offices')->find($officeId);
        foreach (DB::table('users')->where('office_id', $officeId)->orderBy('id')->get() as $u) {
            $last = DB::table('digest_runs')->where('user_id', $u->id)->orderByDesc('sent_on')->orderByDesc('id')->first();
            if ($last && (int) Carbon::parse($last->sent_on)->startOfDay()->diffInDays($today) < $days) {
                continue;
            }
            $since = $last ? Carbon::parse($last->created_at) : $today->copy()->subDays($days);
            $at = now(); // az ablak ettől a pillanattól indul újra, így a törzs összeállítása közben keletkező tétel sem vész el
            $body = self::body($officeId, $u, $since, (bool) $last);
            if ($body === null) {
                continue;
            }
            // Atomikus foglalás: két átfedő futásból csak az küld, aki a sort beszúrta; sikertelen küldésnél a foglalás törlődik, így később újrapróbálható.
            $claimed = DB::table('digest_runs')->insertOrIgnore(['office_id' => $officeId, 'user_id' => $u->id, 'sent_on' => $today->format('Y-m-d'), 'created_at' => $at, 'updated_at' => $at]);
            if (! $claimed) {
                continue;
            }
            if (ClientMail::toUser($officeId, (int) $u->id, "KapuMail összesítő – {$office->name}, {$today->format('Y. m. d.')}", $body)) {
                $n++;
            } else {
                DB::table('digest_runs')->where('user_id', $u->id)->where('sent_on', $today->format('Y-m-d'))->delete();
            }
        }

        return $n;
    }

    /** Az összesítő szövege, vagy null, ha nincs mit mondani. */
    private static function body(int $officeId, object $u, Carbon $since, bool $strict): ?string
    {
        $ids = Scope::clientIds($u);
        if (! $ids) {
            return null;
        }
        $after = fn ($q, string $col) => $strict ? $q->where($col, '>', $since) : $q->where($col, '>=', $since);
        $names = DB::table('clients')->where('office_id', $officeId)->whereIn('id', $ids)->pluck('name', 'id');
        $sec = [];
        $obl = $after(DB::table('tax_obligations')->where('office_id', $officeId)->whereIn('client_id', $ids)->whereIn('status', ['missing', 'rejected']), 'updated_at')->orderBy('client_id')->orderBy('due_date')->get();
        if ($obl->isNotEmpty()) {
            $sec['Hiányzó vagy elutasított bevallások'] = $obl->map(fn ($o) => "{$names[$o->client_id]}: {$o->title} (".($o->status === 'rejected' ? 'elutasítva' : 'hiányzik').", esedékes: {$o->due_date})")->all();
        }
        $debt = $after(DB::table('nav_client_snapshots')->where('office_id', $officeId)->whereIn('client_id', $ids)->where('debt', '>', 0), 'fetched_at')->orderBy('client_id')->get();
        if ($debt->isNotEmpty()) {
            $sec['Tartozás a NAV-nál'] = $debt->map(fn ($s) => "{$names[$s->client_id]}: ".number_format((int) $s->debt, 0, ',', ' ').' Ft (lekérdezve: '.Carbon::parse($s->fetched_at)->format('Y-m-d H:i').')')->all();
        }
        $new = $after(DB::table('clients')->where('office_id', $officeId)->whereIn('id', $ids), 'created_at')->orderBy('id')->pluck('name')->all();
        if ($new) {
            $sec['Új ügyfelek'] = $new;
        }
        $docs = $after(DB::table('notifications')->where('office_id', $officeId)->where('user_id', $u->id)->where('kind', 'osszesito'), 'created_at')->orderBy('id')->pluck('message_id')->filter()->unique()->all();
        $msgs = $docs ? DB::table('messages')->where('office_id', $officeId)->whereIn('id', $docs)->whereIn('client_id', $ids)->where(fn ($q) => $q->whereNull('folder')->orWhere('folder', '!=', 'ELKULDOTT'))->orderBy('id')->get() : collect();
        if ($msgs->isNotEmpty()) {
            $sec['Új iratok'] = $msgs->map(fn ($m) => "{$names[$m->client_id]}: {$m->subject}")->all();
        }
        if (! $sec) {
            return null;
        }
        $out = "Kedves {$u->name}!\n\nÖsszesítő a legutóbbi óta történtekről.\n";
        foreach ($sec as $title => $lines) {
            $out .= "\n$title\n".implode("\n", array_map(fn ($l) => "- $l", $lines))."\n";
        }

        return $out."\nEz automatikus levél a KapuMail programból.";
    }
}
