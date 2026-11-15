<?php

namespace Tests\Feature;

use App\Iratkapu\CalendarInvites;
use App\Iratkapu\DeadlineCalendar;
use App\Iratkapu\Scope;
use App\Iratkapu\TaxPayment;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** Határidők naptárfájlban és naptármeghívóként: mi kerül bele, kinek, és mi történik változáskor. */
class NaptarTest extends TestCase
{
    use RefreshDatabase;

    protected bool $seed = true;

    private object $client;

    private object $irat;

    protected function setUp(): void
    {
        parent::setUp();
        Carbon::setTestNow('2026-11-13 10:00');
        $lg = $this->u('LG');
        $this->client = DB::table('clients')->whereIn('id', Scope::clientIds($lg))->orderBy('id')->first();
        // Tiszta lap: az iroda egyetlen nyitott határideje az lesz, amit a teszt beállít.
        DB::table('messages')->update(['deadline_date' => null]);
        DB::table('tax_obligations')->delete();
        DB::table('client_contacts')->delete();
        $this->irat = DB::table('messages')->where('client_id', $this->client->id)->orderBy('id')->first();
        DB::table('messages')->where('id', $this->irat->id)->update(['deadline_date' => '2026-12-01', 'deadline_sure' => false, 'deadline_excerpt' => 'Fizetési határidő: 2026.12.01., a hátralék; pótlékkal', 'internal' => 'folyamatban', 'archived' => false, 'past_deadline_warn' => false, 'official' => 'ok']);
        $this->irat = DB::table('messages')->find($this->irat->id);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function u(string $k): User
    {
        return User::where('initials', $k)->firstOrFail();
    }

    private function obligation(array $x = []): int
    {
        return DB::table('tax_obligations')->insertGetId($x + ['office_id' => $this->client->office_id, 'client_id' => $this->client->id, 'source' => 'nav', 'external_key' => 'k'.uniqid(), 'form_code' => '2665',
            'title' => 'Általános forgalmi adó bevallás', 'due_date' => '2026-11-20', 'status' => 'submittable', 'created_at' => now(), 'updated_at' => now()]);
    }

    private function contact(bool $invites = true): int
    {
        return DB::table('client_contacts')->insertGetId(['office_id' => $this->client->office_id, 'client_id' => $this->client->id, 'name' => 'Kovács Éva', 'email' => 'eva@pelda.test', 'role' => 'ügyvezető', 'calendar_invites' => $invites]);
    }

    private function turnOn(bool $estimated = true): void
    {
        $this->actingAs($this->u('IA'))->postJson('/api/settings/calendar', ['on' => true, 'estimated' => $estimated])->assertOk();
    }

    /** A kiküldött levelek naptárrésze, sorban. */
    private function sentCalendars(): array
    {
        return app('mailer')->getSymfonyTransport()->messages()->map(fn ($m) => $m->getOriginalMessage()->toString())->all();
    }

    private function unfolded(string $ics): string
    {
        return str_replace("\r\n ", '', $ics);
    }

    public function test_a_naptarfajlban_a_nyitott_hataridok_vannak_mindket_forrasbol_a_becsult_megjelolve(): void
    {
        $this->obligation();
        $this->obligation(['status' => 'submitted', 'form_code' => '2608', 'due_date' => '2026-11-12']);
        $kesz = DB::table('messages')->where('client_id', $this->client->id)->where('id', '!=', $this->irat->id)->first();
        DB::table('messages')->where('id', $kesz->id)->update(['deadline_date' => '2026-11-25', 'deadline_sure' => true, 'internal' => 'kesz', 'subject' => 'Lezárt ügy irata']);

        $r = $this->actingAs($this->u('LG'))->get('/api/calendar.ics')->assertOk();
        $this->assertStringStartsWith('text/calendar', $r->headers->get('Content-Type'));
        $raw = $r->getContent();
        $ics = $this->unfolded($raw);

        $this->assertSame(2, substr_count($ics, 'BEGIN:VEVENT'));
        $this->assertStringContainsString("SUMMARY:{$this->client->name} – {$this->irat->subject} (becsült)", str_replace('\\', '', $ics));
        $this->assertStringContainsString('2665 Általános forgalmi adó bevallás', $ics);
        $this->assertStringNotContainsString('Lezárt ügy irata', $ics);   // kész irat nem megy ki
        $this->assertStringNotContainsString('2608', $ics);               // beadott bevallás sem
        // egész napos esemény, emlékeztető 3 nappal előtte reggel 9-kor, a forrásmondat a leírásban (a ; és , védve)
        $this->assertStringContainsString("DTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261202", $ics);
        $this->assertStringContainsString('TRIGGER:-P2DT15H', $ics);
        $this->assertStringContainsString('Forrásmondat: „Fizetési határidő: 2026.12.01.\\, a hátralék\; pótlékkal”', $ics);
        $this->assertStringContainsString('STATUS:TENTATIVE', $ics);
        // szabványos sorvégek és sorhossz
        foreach (explode("\r\n", $raw) as $line) {
            $this->assertLessThanOrEqual(75, strlen($line));
        }
        $this->assertStringNotContainsString("\n", str_replace("\r\n", '', $raw));
        // az azonosító állandó: az újraolvasás frissít, nem dupláz
        preg_match_all('/UID:(\S+)/', $ics, $a);
        preg_match_all('/UID:(\S+)/', $this->unfolded($this->get('/api/calendar.ics')->getContent()), $b);
        $this->assertSame($a[1], $b[1]);
    }

    public function test_a_naptarfajl_koveti_a_szuroket_es_nem_ad_ki_mas_ugyfelet(): void
    {
        $this->obligation();
        $lg = $this->u('LG');
        $idegen = DB::table('clients')->where('office_id', $lg->office_id)->whereNotIn('id', Scope::clientIds($lg))->first();
        $this->assertNotNull($idegen);
        DB::table('messages')->where('client_id', $idegen->id)->limit(1)->update(['deadline_date' => '2026-12-05', 'deadline_sure' => true, 'internal' => 'folyamatban', 'archived' => false]);

        $all = $this->actingAs($lg)->get('/api/calendar.ics')->getContent();
        $this->assertStringNotContainsString($idegen->name, $this->unfolded($all));
        $this->assertSame(0, substr_count($this->get("/api/calendar.ics?client=c{$idegen->id}")->getContent(), 'BEGIN:VEVENT'));
        $this->assertSame(1, substr_count($this->get('/api/calendar.ics?cats=upo')->getContent(), 'BEGIN:VEVENT'));
        $this->assertSame(1, substr_count($this->get('/api/calendar.ics?sure=est')->getContent(), 'BEGIN:VEVENT'));
        $this->assertSame(2, substr_count($this->get("/api/calendar.ics?client=c{$this->client->id}")->getContent(), 'BEGIN:VEVENT'));
        $this->getJson('/api/calendar.ics?sure=barmi')->assertStatus(422); // érvénytelen szűrő nem megy át
    }

    public function test_meghivo_csak_bekapcsolva_es_csak_annak_megy_aki_keri(): void
    {
        $kid = $this->contact(false);
        $this->assertSame(0, CalendarInvites::sync($this->client->office_id)['sent']); // alapból ki van kapcsolva
        $this->actingAs($this->u('LG'))->postJson('/api/settings/calendar', ['on' => true, 'estimated' => true])->assertForbidden();
        $this->actingAs($this->u('LG'))->postJson("/api/contacts/$kid/calendar", ['on' => true])->assertForbidden();
        $this->turnOn();
        $this->assertSame(0, CalendarInvites::sync($this->client->office_id)['sent']); // a kapcsolattartó nem kérte
        $this->assertCount(0, $this->sentCalendars());

        $this->actingAs($this->u('IA'))->postJson("/api/contacts/$kid/calendar", ['on' => true])->assertOk();
        $this->assertSame(1, $this->getJson('/api/state')->json('office.calendar.pending'));
        $this->postJson('/api/calendar/invites/sync')->assertOk()->assertJson(['sent' => 1, 'failed' => 0]);
        $mail = $this->sentCalendars();
        $this->assertCount(1, $mail);
        $this->assertMatchesRegularExpression('~Content-Type: text/calendar; charset=utf-8; method=REQUEST~i', $mail[0]);
        $this->assertStringContainsString('To: =?utf-8?Q?Kov=C3=A1cs_=C3=89va?= <eva@pelda.test>', $mail[0]);
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', 'Naptármeghívó elküldve: Kovács Éva%')->exists());
        // újrafuttatva nem megy ki még egyszer
        $this->postJson('/api/calendar/invites/sync')->assertOk()->assertJson(['sent' => 0, 'updated' => 0, 'cancelled' => 0]);
        $this->assertCount(1, $this->sentCalendars());
        $this->assertSame(0, $this->getJson('/api/state')->json('office.calendar.pending'));
    }

    public function test_valtozasnal_ugyanaz_az_esemeny_frissul_teljesuleskor_lemondas_megy(): void
    {
        $this->contact();
        $this->turnOn();
        $office = $this->client->office_id;
        $this->assertSame(1, CalendarInvites::sync($office)['sent']);
        $row = DB::table('calendar_invites')->first();
        $this->assertSame(0, (int) $row->sequence);

        // megerősítés új dátummal → frissítés ugyanarra az azonosítóra, magasabb sorszámmal
        $this->actingAs($this->u('IA'))->postJson("/api/messages/m{$this->irat->id}/action", ['action' => 'deadline', 'to' => '2026-12-03'])->assertOk();
        $this->assertSame(['sent' => 0, 'updated' => 1, 'cancelled' => 0], array_intersect_key(CalendarInvites::sync($office), ['sent' => 1, 'updated' => 1, 'cancelled' => 1]));
        $upd = base64_decode(preg_replace('~^.*?method=REQUEST.*?\r\n\r\n(.*?)\r\n--.*$~s', '$1', $this->sentCalendars()[1]), true) ?: quoted_printable_decode($this->sentCalendars()[1]);
        $upd = $this->unfolded($upd);
        $this->assertStringContainsString("UID:{$row->uid}", $upd);
        $this->assertStringContainsString('SEQUENCE:1', $upd);
        $this->assertStringContainsString('DTSTART;VALUE=DATE:20261203', $upd);
        $this->assertStringContainsString('STATUS:CONFIRMED', $upd);
        $this->assertStringNotContainsString('(becsült)', $upd);

        // késznek jelölve → lemondás; utána nincs több levél
        $this->postJson("/api/messages/m{$this->irat->id}/action", ['action' => 'done'])->assertOk();
        $this->assertSame(1, CalendarInvites::sync($office)['cancelled']);
        $this->assertMatchesRegularExpression('~method=CANCEL~', $this->sentCalendars()[2]);
        $after = DB::table('calendar_invites')->first();
        $this->assertSame(['cancelled', 2], [$after->state, (int) $after->sequence]);
        $this->assertSame(0, CalendarInvites::pending($office));

        // újranyitva ismét kimegy, tovább növelt sorszámmal (a naptár így nem veti el)
        $this->postJson("/api/messages/m{$this->irat->id}/action", ['action' => 'done'])->assertOk();
        $this->assertSame(1, CalendarInvites::sync($office)['sent']);
        $this->assertSame(['sent', 3], [DB::table('calendar_invites')->value('state'), (int) DB::table('calendar_invites')->value('sequence')]);
        $this->assertSame(1, DB::table('calendar_invites')->count());
    }

    public function test_becsult_hatarido_kizarhato_es_a_tavoli_vagy_lejart_nem_megy_ki(): void
    {
        $this->contact();
        $this->turnOn(false);
        $office = $this->client->office_id;
        $this->obligation(['due_date' => '2027-03-20']);                    // a 60 napos ablakon túl
        $this->obligation(['due_date' => '2026-11-10', 'status' => 'missing']); // már lejárt
        $this->assertSame(0, CalendarInvites::pending($office));            // az irat határideje becsült → kizárva
        $this->turnOn(true);
        $this->assertSame(1, CalendarInvites::sync($office)['sent']);
        $this->assertSame("m{$this->irat->id}", DB::table('calendar_invites')->value('item_key'));
        // ha a kapcsolattartó lemond róla, a kiküldött eseményre lemondás megy
        $this->actingAs($this->u('IA'))->postJson('/api/contacts/'.DB::table('client_contacts')->value('id').'/calendar', ['on' => false])->assertOk();
        $this->assertSame(1, CalendarInvites::sync($office)['cancelled']);
    }

    /** Az iroda nyitott tételei a teszt ügyfelénél. */
    private function calItems(): array
    {
        return DeadlineCalendar::items($this->client->office_id, [$this->client->id]);
    }

    public function test_az_adonaptar_tetele_utalasi_sorokat_kap_az_irat_nem(): void
    {
        $o = $this->obligation(['form_code' => '2608', 'due_date' => '2026-12-12']);
        $items = collect($this->calItems())->keyBy('key');
        $this->assertSame(TaxPayment::lines('2608', $this->client->tax), $items["o$o"]['pay']);
        $this->assertCount(3, $items["o$o"]['pay']);
        $this->assertSame([], $items["m{$this->irat->id}"]['pay']);
    }

    public function test_a_leiras_tartalmazza_az_utalasi_adatokat_osszeg_nelkul(): void
    {
        $o = $this->obligation(['form_code' => '2608', 'due_date' => '2026-12-12']);
        $i = collect($this->calItems())->firstWhere('key', "o$o");
        $d = DeadlineCalendar::description($i);
        foreach ($i['pay'] as $p) {
            $this->assertStringContainsString("Befizetés – {$p['name']}: {$p['account']}, közlemény: {$this->client->tax}", $d);
        }
        $this->assertSame(1, substr_count($d, TaxPayment::NOTE));
        $this->assertSame(1, substr_count($d, TaxPayment::MULTI_NOTE)); // több adónemnél jelzi, hogy a lista nem teljes
        $this->obligation(['form_code' => '2665']);
        $this->assertStringNotContainsString(TaxPayment::MULTI_NOTE, DeadlineCalendar::description(collect($this->calItems())->first(fn ($x) => count($x['pay']) === 1)));
        $this->assertLessThan(strpos($d, 'Küldte: KapuMail'), strpos($d, TaxPayment::NOTE));
        $none = DeadlineCalendar::description($i, false);
        $this->assertStringNotContainsString('Befizetés', $none);
        $this->assertStringNotContainsString(TaxPayment::NOTE, $none);
        // a naptárfájlban a vessző védve megy ki, a számlaszám benne van
        $ics = $this->unfolded(DeadlineCalendar::ics([$i]));
        $this->assertStringContainsString($i['pay'][0]['account'].'\\, közlemény: '.$this->client->tax, $ics);
        // közlemény nélkül sem marad üres hely
        $this->assertStringContainsString('közlemény: nincs megadva', DeadlineCalendar::description(['pay' => [['reference' => ''] + $i['pay'][0]]] + $i));
    }

    public function test_az_utalasi_sorok_nem_valtoztatjak_az_ujjlenyomatot(): void
    {
        $o = $this->obligation(['form_code' => '2665']);
        $i = collect($this->calItems())->firstWhere('key', "o$o");
        $this->assertNotSame([], $i['pay']);
        $this->assertSame(DeadlineCalendar::fingerprint(['pay' => []] + $i), DeadlineCalendar::fingerprint($i));
    }

    public function test_a_feluletnek_kuldott_kotelezettseg_utalasi_sorokat_kap(): void
    {
        $nyitott = $this->obligation(['form_code' => '2665']);
        $ismeretlen = $this->obligation(['form_code' => 'NAPTAR']);
        $beadott = $this->obligation(['form_code' => '2665', 'status' => 'submitted', 'due_date' => '2026-10-20']);
        $obs = collect($this->actingAs($this->u('LG'))->getJson('/api/state')->assertOk()->json('obligations'))->keyBy('id');
        $this->assertSame(TaxPayment::lines('2665', $this->client->tax), $obs[$nyitott]['pay']);
        $this->assertSame([], $obs[$ismeretlen]['pay']);
        $this->assertSame([], $obs[$beadott]['pay']);
    }

    public function test_naptarkartya_allapotjelzo_nem_utkozik_a_mappagomb_osztallyal_es_buboreksugot_ad(): void
    {
        $html = $this->actingAs($this->u('LG'))->get('/')->assertOk()->getContent();
        $this->assertStringNotContainsString('.ev .f{', $html);
        $this->assertStringContainsString('.ev .ef{', $html);
        $this->assertStringContainsString('function upoStatusTip(o)', $html);
        $this->assertStringContainsString('A többi lehetséges állapot:', $html);
    }
}
