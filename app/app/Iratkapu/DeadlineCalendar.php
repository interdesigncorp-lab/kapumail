<?php

namespace App\Iratkapu;

use Illuminate\Support\Facades\DB;
use Symfony\Component\Mime\Header\Headers;
use Symfony\Component\Mime\Part\Multipart\AlternativePart;
use Symfony\Component\Mime\Part\TextPart;

/**
 * Határidők szabványos naptárformában (iCalendar, RFC 5545).
 *
 * Két forrás: az iratokból kinyert vagy kézzel rögzített határidők, és a NAV-adónaptár kötelezettségei.
 * Csak NYITOTT határidő kerül ki: a kész irat és a beadott bevallás nem. A becsült határidő a címében is
 * „(becsült)”, mert a naptárban már nem látszik mellette a KapuMail jelölése.
 */
final class DeadlineCalendar
{
    const CATS = ['nav', 'upo', 'onk', 'jog', 'egyeb'];

    const ALARM_DAYS = 3;

    /** Az iroda naptárazonosítója: ettől egyediek az események azonosítói akkor is, ha két telepítés ugyanannak ír. */
    public static function calId(int $officeId): string
    {
        $id = OfficeMail::settings($officeId)['cal_id'] ?? null;
        if (! $id) {
            $id = bin2hex(random_bytes(8));
            OfficeMail::put($officeId, ['cal_id' => $id]);
        }

        return $id;
    }

    /** A felület „Feladó szerint” csoportjai. */
    public static function catOf(string $sender): string
    {
        return $sender === 'NAV' ? 'nav' : ($sender === 'ÖNK' ? 'onk' : (in_array($sender, ['BÍR', 'CÉGB', 'VH'], true) ? 'jog' : 'egyeb'));
    }

    /**
     * A nyitott határidők, dátum szerint.
     * Szűrők: cats (kategóriák listája), sure (all | sure | est), who (felelős azonosítója), client (ügyfél azonosítója).
     */
    public static function items(int $officeId, array $clientIds, array $f = []): array
    {
        $cats = $f['cats'] ?? self::CATS;
        $sure = $f['sure'] ?? 'all';
        $who = $f['who'] ?? null;
        if (! empty($f['client'])) {
            $clientIds = array_values(array_intersect($clientIds, [(int) $f['client']]));
        }
        if (! $clientIds) {
            return [];
        }
        $names = DB::table('clients')->whereIn('id', $clientIds)->pluck('name', 'id');
        $taxes = DB::table('clients')->whereIn('id', $clientIds)->pluck('tax', 'id');
        $cal = self::calId($officeId);
        $out = [];

        $ms = DB::table('messages')->where('office_id', $officeId)->whereIn('client_id', $clientIds)->whereNotNull('deadline_date')
            ->where('archived', false)->where('internal', '!=', 'kesz')->get();
        foreach ($ms as $m) {
            if ($m->past_deadline_warn && ! $m->deadline_sure) {
                continue;
            } // hivatkozott múltbeli dátum, nem határidő
            $out[] = ['key' => "m{$m->id}", 'uid' => "irat-{$m->id}-$cal@kapumail", 'client_id' => (int) $m->client_id, 'client' => $names[$m->client_id] ?? 'Ügyfél',
                'what' => (string) $m->subject, 'date' => substr((string) $m->deadline_date, 0, 10), 'sure' => (bool) $m->deadline_sure, 'note' => $m->deadline_sure ? '' : 'becsült',
                'cat' => self::catOf((string) $m->sender), 'who' => $m->assignee_id ? (int) $m->assignee_id : null,
                'form_code' => $m->form_code ?? null, 'obligation_status' => null, 'receipt_message_id' => null,
                'origin' => 'Feladó: '.($m->sender_full ?: $m->sender), 'source' => (string) ($m->deadline_source ?? ''), 'excerpt' => (string) ($m->deadline_excerpt ?? ''),
                'pay' => [], 'changed' => (string) $m->updated_at];
        }
        $os = DB::table('tax_obligations')->where('office_id', $officeId)->whereIn('client_id', $clientIds)->where('status', '!=', 'submitted')->get();
        foreach ($os as $o) {
            $ost = (string) ($o->status ?? 'submittable');
            $state = ['missing' => 'hiányzó bevallás', 'rejected' => 'hibás vagy elutasított bevallás'][$ost] ?? '';
            $out[] = ['key' => "o{$o->id}", 'uid' => "adonaptar-{$o->id}-$cal@kapumail", 'client_id' => (int) $o->client_id, 'client' => $names[$o->client_id] ?? 'Ügyfél',
                'what' => trim("{$o->form_code} {$o->title}"), 'date' => substr((string) $o->due_date, 0, 10), 'sure' => ! $o->conditional, 'note' => $o->conditional ? 'feltételes' : '',
                'cat' => 'upo', 'who' => null, 'form_code' => $o->form_code ?? null, 'obligation_status' => $ost,
                'receipt_message_id' => ! empty($o->receipt_message_id) ? (int) $o->receipt_message_id : null,
                'origin' => 'Forrás: NAV adónaptár'.($state ? " – $state" : ''),
                'source' => $o->period_start && $o->period_end ? 'Időszak: '.substr((string) $o->period_start, 0, 10).' – '.substr((string) $o->period_end, 0, 10) : '', 'excerpt' => '',
                'pay' => TaxPayment::lines((string) $o->form_code, (string) ($taxes[$o->client_id] ?? '')), 'changed' => (string) $o->updated_at];
        }
        $out = array_values(array_filter($out, fn ($i) => in_array($i['cat'], $cats, true)
            && ($sure === 'all' || ($sure === 'sure') === $i['sure'])
            && (! $who || $i['who'] === (int) $who)));
        usort($out, fn ($a, $b) => [$a['date'], $a['key']] <=> [$b['date'], $b['key']]);

        return $out;
    }

    /** Az esemény címe: „Ügyfél – teendő”, a becsült és a feltételes jelöléssel. */
    public static function summary(array $i): string
    {
        if (isset($i['fixed'])) {
            return $i['fixed'];
        }

        return mb_substr("{$i['client']} – {$i['what']}".($i['note'] ? " ({$i['note']})" : ''), 0, 250);
    }

    /** Az esemény leírása. Az utalási sorok ($withPay) a változásfigyelésbe nem számítanak bele. */
    public static function description(array $i, bool $withPay = true): string
    {
        if (isset($i['fixed'])) {
            return 'Ez a határidő teljesült vagy már nem érvényes.';
        }
        $l = ["Ügyfél: {$i['client']}", $i['origin']];
        $l[] = $i['key'][0] === 'o' ? ($i['sure'] ? 'A NAV adónaptárából átvett esedékesség.' : 'Feltételes kötelezettség: csak akkor áll fenn, ha a feltétele teljesül.')
            : ($i['sure'] ? 'Megerősített határidő.' : 'BECSÜLT határidő: a program olvasta ki az iratból, ember még nem ellenőrizte. Az irat az irányadó.');
        if ($i['source']) {
            $l[] = $i['source'];
        }
        if ($i['excerpt']) {
            $l[] = "Forrásmondat: „{$i['excerpt']}”";
        }
        if ($withPay && ! empty($i['pay'])) {
            foreach ($i['pay'] as $p) {
                $l[] = "Befizetés – {$p['name']}: {$p['account']}, közlemény: ".($p['reference'] !== '' ? $p['reference'] : 'nincs megadva');
            }
            if (count($i['pay']) > 1) {
                $l[] = TaxPayment::MULTI_NOTE;
            }
            $l[] = TaxPayment::NOTE;
        }
        $l[] = 'Küldte: KapuMail';

        return implode("\n", $l);
    }

    /** Ebből látszik, hogy a már kiküldött eseményhez képest változott-e valami. */
    public static function fingerprint(array $i): string
    {
        return hash('sha256', $i['date']."\n".self::summary($i)."\n".preg_replace('/\nKüldte:.*$/s', '', self::description($i, false)));
    }

    public static function esc(string $s): string
    {
        return str_replace(['\\', ';', ',', "\r\n", "\n", "\r"], ['\\\\', '\\;', '\\,', '\\n', '\\n', ''], $s);
    }

    /** Sortörés 75 bájtnál, karakterhatáron (az ékezetes betű több bájt). */
    public static function fold(string $line): string
    {
        $out = '';
        $cur = '';
        $limit = 75;
        foreach (mb_str_split($line) as $ch) {
            if (strlen($cur) + strlen($ch) > $limit) {
                $out .= $cur."\r\n";
                $cur = ' ';
            }
            $cur .= $ch;
        }

        return $out.$cur;
    }

    /**
     * Naptárfájl. $method: PUBLISH (letöltött fájl), REQUEST (meghívó), CANCEL (törlés).
     * $opt: seq (item_key => sorszám), organizer [email, név], attendee [email, név], name (a naptár neve).
     */
    public static function ics(array $items, string $method = 'PUBLISH', array $opt = []): string
    {
        $now = gmdate('Ymd\THis\Z');
        $L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//KapuMail//Hataridok//HU', 'CALSCALE:GREGORIAN', "METHOD:$method"];
        if ($method === 'PUBLISH') {
            $L[] = 'X-WR-CALNAME:'.self::esc($opt['name'] ?? 'KapuMail határidők');
        }
        foreach ($items as $i) {
            $start = str_replace('-', '', $i['date']);
            $end = date('Ymd', strtotime($i['date'].' +1 day'));
            // Letöltött fájlnál a sorszám az utolsó módosítás idejéből jön, hogy az újraolvasás a frissebbet tartsa meg.
            $seq = $opt['seq'][$i['key']] ?? max(0, intdiv((int) strtotime($i['changed'] ?: 'now') - 1767225600, 60));
            array_push($L, 'BEGIN:VEVENT', "UID:{$i['uid']}", "DTSTAMP:$now", "LAST-MODIFIED:$now", "SEQUENCE:$seq",
                "DTSTART;VALUE=DATE:$start", "DTEND;VALUE=DATE:$end", 'SUMMARY:'.self::esc(self::summary($i)), 'DESCRIPTION:'.self::esc(self::description($i)),
                'TRANSP:TRANSPARENT', 'CATEGORIES:'.self::esc($i['key'][0] === 'o' ? 'Adónaptár' : 'Irat határideje'),
                'STATUS:'.($method === 'CANCEL' ? 'CANCELLED' : ($i['sure'] ? 'CONFIRMED' : 'TENTATIVE')));
            if ($method !== 'PUBLISH') {
                [$oe, $on] = $opt['organizer'];
                [$ae, $an] = $opt['attendee'];
                $L[] = 'ORGANIZER;CN="'.self::cn($on ?: $oe)."\":mailto:$oe";
                $L[] = 'ATTENDEE;CN="'.self::cn($an ?: $ae)."\";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:$ae";
            }
            if ($method !== 'CANCEL') { // egész napos eseménynél a kezdet éjfél: 3 nappal előtte, reggel 9-kor szól
                array_push($L, 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:'.self::esc(self::summary($i)), 'TRIGGER:-P'.(self::ALARM_DAYS - 1).'DT15H', 'END:VALARM');
            }
            $L[] = 'END:VEVENT';
        }
        $L[] = 'END:VCALENDAR';

        return implode("\r\n", array_map([self::class, 'fold'], $L))."\r\n";
    }

    private static function cn(string $s): string
    {
        return trim(str_replace(['"', "\r", "\n", ';', ':', ','], ' ', $s));
    }

    /** Levéltörzs, amelyet a levelezők naptármeghívóként ismernek fel: sima szöveg + text/calendar rész a METHOD megjelölésével. */
    public static function mimeBody(string $plain, string $ics, string $method): AlternativePart
    {
        $cal = new class($ics, 'utf-8', 'calendar') extends TextPart
        {
            public string $method = 'REQUEST';

            public function getPreparedHeaders(): Headers
            {
                $h = parent::getPreparedHeaders();
                $h->setHeaderParameter('Content-Type', 'method', $this->method);

                return $h;
            }
        };
        $cal->method = $method;

        return new AlternativePart(new TextPart($plain, 'utf-8', 'plain'), $cal);
    }
}
