<?php

namespace App\Iratkapu;

use Illuminate\Support\Facades\DB;

/**
 * A határidők naptármeghívóként az ügyfél kapcsolattartójának (iMIP, RFC 6047), az iroda saját levelezőjén.
 *
 * Alapból ki van kapcsolva; kapcsolattartónként külön kell kérni. Egy eseményről egy levél megy: új határidőnél
 * meghívó, változásnál frissítés ugyanarra az eseményre, teljesüléskor vagy törléskor lemondás.
 */
final class CalendarInvites
{
    public static function config(int $officeId): array
    {
        $s = OfficeMail::settings($officeId);
        $c = $s['cal_invites'] ?? [];

        return ['on' => ! empty($c['on']), 'estimated' => $c['estimated'] ?? true, 'lastError' => $c['last_error'] ?? null, 'failedAt' => $c['failed_at'] ?? null,
            'mailReady' => ! empty($s['smtp']) || ! in_array(config('mail.default'), ['log', 'null'], true)];
    }

    private static function horizon(): int
    {
        return (int) config('iratkapu.invite_horizon_days', 60);
    }

    /** Mit kellene most kiküldeni. Levelet nem küld, adatot nem ír. */
    public static function plan(int $officeId): array
    {
        $cfg = self::config($officeId);
        $ops = [];
        $today = now()->toDateString();
        $until = now()->addDays(self::horizon())->toDateString();
        $rows = DB::table('calendar_invites')->where('office_id', $officeId)->where('state', 'sent')->get()->groupBy('contact_id');
        $contacts = DB::table('client_contacts')->where('office_id', $officeId)->get()->keyBy('id');
        foreach ($contacts as $k) {
            $mine = ($rows[$k->id] ?? collect())->keyBy('item_key');
            $open = [];
            if ($k->calendar_invites && DB::table('clients')->where('id', $k->client_id)->value('active') !== 0) {
                foreach (DeadlineCalendar::items($officeId, [(int) $k->client_id], ['sure' => $cfg['estimated'] ? 'all' : 'sure']) as $i) {
                    $open[$i['key']] = $i;
                }
            }
            foreach ($open as $key => $i) {
                $row = $mine[$key] ?? null;
                if ($row) {
                    if ($row->fingerprint !== DeadlineCalendar::fingerprint($i)) {
                        $ops[] = ['op' => 'update', 'contact' => $k, 'item' => $i, 'row' => $row];
                    }
                } elseif ($i['date'] >= $today && $i['date'] <= $until) {
                    $ops[] = ['op' => 'send', 'contact' => $k, 'item' => $i, 'row' => null];
                }
            }
            foreach ($mine as $key => $row) {
                if (! isset($open[$key])) {
                    $ops[] = ['op' => substr((string) $row->due_date, 0, 10) >= $today ? 'cancel' : 'close', 'contact' => $k, 'item' => null, 'row' => $row];
                }
            }
        }

        return $ops;
    }

    /** Hány levél vár kiküldésre (a csendben lezárandó lejártak nélkül). */
    public static function pending(int $officeId): int
    {
        return count(array_filter(self::plan($officeId), fn ($o) => $o['op'] !== 'close'));
    }

    /** Kiküldi, ami esedékes. Az első levelezési hibánál megáll: a maradék a következő futásra marad. */
    public static function sync(int $officeId, ?object $actor = null): array
    {
        $cfg = self::config($officeId);
        $res = ['sent' => 0, 'updated' => 0, 'cancelled' => 0, 'failed' => 0, 'error' => null];
        if (! $cfg['on']) {
            return $res + ['skipped' => 'A naptármeghívók küldése ki van kapcsolva.'];
        }
        if (! $cfg['mailReady']) {
            return $res + ['skipped' => 'Nincs beállítva e-mail küldés (SMTP).'];
        }
        $smtp = OfficeMail::settings($officeId)['smtp'] ?? null;
        $office = DB::table('offices')->find($officeId);
        $from = [$smtp['from'] ?? config('mail.from.address'), ($smtp['from_name'] ?? '') ?: $office->name];
        $mailer = null;
        foreach (self::plan($officeId) as $o) {
            $k = $o['contact'];
            $row = $o['row'];
            $i = $o['item'];
            if ($o['op'] === 'close') {
                DB::table('calendar_invites')->where('id', $row->id)->update(['state' => 'closed', 'updated_at' => now()]);

                continue;
            }
            $prev = $row ?: DB::table('calendar_invites')->where('contact_id', $k->id)->where('item_key', $i['key'])->first(); // korábban lemondott, újra megnyílt
            $seq = $prev ? $prev->sequence + 1 : 0;
            if ($o['op'] === 'cancel') {
                $summary = $row->summary; // a lemondás a kiküldött címmel megy, nem a mai adatokkal
                $i = ['key' => $row->item_key, 'uid' => $row->uid, 'date' => substr((string) $row->due_date, 0, 10), 'sure' => true, 'fixed' => $summary, 'changed' => ''];
                $ics = DeadlineCalendar::ics([$i], 'CANCEL', ['seq' => [$i['key'] => $seq], 'organizer' => $from, 'attendee' => [$k->email, $k->name]]);
                $subject = "Törölve: $summary";
                $plain = "Kedves {$k->name}!\n\nEz a határidő lekerült a naptárból, mert teljesült vagy már nem érvényes:\n\n$summary\nEredeti dátum: {$i['date']}\n\nÜdvözlettel:\n{$office->name}";
            } else {
                $summary = DeadlineCalendar::summary($i);
                $ics = DeadlineCalendar::ics([$i], 'REQUEST', ['seq' => [$i['key'] => $seq], 'organizer' => $from, 'attendee' => [$k->email, $k->name]]);
                $subject = ($o['op'] === 'update' ? 'Módosult határidő: ' : 'Határidő: ').$summary;
                $plain = "Kedves {$k->name}!\n\n".($o['op'] === 'update' ? 'Módosult egy határidő; a naptárában ugyanaz az esemény frissül.' : 'Új határidő került a naptárba.')
                    ."\n\n$summary\nHatáridő: {$i['date']}\n\n".DeadlineCalendar::description($i)."\n\nA levélhez tartozó naptáreseményt a levelezője a naptárába teszi. Emlékeztető: ".DeadlineCalendar::ALARM_DAYS." nappal előtte.\n\nÜdvözlettel:\n{$office->name}";
            }
            try {
                $mailer ??= OfficeMail::mailer($officeId);
                $method = $o['op'] === 'cancel' ? 'CANCEL' : 'REQUEST';
                $mailer->raw($plain, function ($mail) use ($k, $subject, $plain, $ics, $method) {
                    $mail->to($k->email, $k->name)->subject($subject);
                    $mail->getSymfonyMessage()->setBody(DeadlineCalendar::mimeBody($plain, $ics, $method));
                });
            } catch (\Throwable $e) {
                $res['failed']++;
                $res['error'] = mb_substr(preg_replace('/\s+/', ' ', $e->getMessage()), 0, 240);
                self::remember($officeId, ['last_error' => $res['error'], 'failed_at' => now()->toDateTimeString()]);
                Audit::log($officeId, $actor, "Naptármeghívó küldése sikertelen: {$k->name}", ['client_id' => $k->client_id]);

                return $res;
            }
            $data = ['sequence' => $seq, 'state' => $o['op'] === 'cancel' ? 'cancelled' : 'sent', 'to_email' => $k->email, 'updated_at' => now()]
                + ($o['op'] === 'cancel' ? [] : ['due_date' => $i['date'], 'summary' => $summary, 'fingerprint' => DeadlineCalendar::fingerprint($i), 'uid' => $i['uid']]);
            if ($prev) {
                DB::table('calendar_invites')->where('id', $prev->id)->update($data);
            } else {
                DB::table('calendar_invites')->insert($data + ['office_id' => $officeId, 'client_id' => $k->client_id, 'contact_id' => $k->id, 'item_key' => $i['key'], 'created_at' => now()]);
            }
            $res[['send' => 'sent', 'update' => 'updated', 'cancel' => 'cancelled'][$o['op']]]++;
            Audit::log($officeId, $actor, ['send' => 'Naptármeghívó elküldve', 'update' => 'Naptármeghívó frissítve', 'cancel' => 'Naptármeghívó lemondva'][$o['op']].": {$k->name} ({$k->email}) – $summary",
                ['client_id' => $k->client_id, 'message_id' => $i['key'][0] === 'm' ? (int) substr($i['key'], 1) : null, 'evidence' => "esemény {$i['uid']}, sorszám $seq, levelező: ".OfficeMail::label($officeId)]);
        }
        if ($cfg['lastError']) {
            self::remember($officeId, ['last_error' => null, 'failed_at' => null]);
        }

        return $res;
    }

    public static function remember(int $officeId, array $patch): void
    {
        $c = OfficeMail::settings($officeId)['cal_invites'] ?? [];
        OfficeMail::put($officeId, ['cal_invites' => array_filter(array_merge($c, $patch), fn ($v) => $v !== null)]);
    }
}
