<?php
namespace Tests\Feature;

use App\Iratkapu\Samples;
use App\Iratkapu\WorkCalendar;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\{DB, Storage};
use Tests\TestCase;

/**
 * Határidő-kinyerés a letöltött iratból: a forrásmondat megmutatása, a múltbeli (hivatkozott) dátum jelzése,
 * és a „munkanapon belül” számítása a magyar munkaszüneti napokkal. Minden kinyert dátum becslés marad.
 */
class HataridoTest extends TestCase
{
    use RefreshDatabase;
    protected bool $seed = true;

    private const BOX = '24817365 Borostyán Pékség Kft.';

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        config(['iratkapu.live_listing' => true, 'iratkapu.live_download' => true]);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function sn(): User
    {
        return User::where('initials', 'SN')->firstOrFail();
    }

    /** Élő levél listázása és a fájl letöltése (kézi parancsra); visszaadja a frissített iratot. */
    private function letterWith(string $eid, string $fileName, string $bytes, string $receivedAt = '2026-11-10 09:30'): object
    {
        $this->actingAs($this->sn())->postJson('/api/live/ingest', ['autoMap' => true, 'letters' => [[
            'eid' => $eid, 'mailbox' => self::BOX, 'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal', 'type' => 'Tájékoztatás bevallásról', 'desc' => '', 'receivedAt' => $receivedAt,
        ]]])->assertOk();
        $m = DB::table('messages')->where('source_id', "live-$eid")->firstOrFail();
        $this->postJson("/api/messages/m{$m->id}/live-download", ['fileName' => $fileName, 'bytesBase64' => base64_encode($bytes)])->assertOk();
        return DB::table('messages')->find($m->id);
    }

    private function stateOf(object $m): array
    {
        return collect($this->actingAs($this->sn())->getJson('/api/state')->json('messages'))->firstWhere('id', "m{$m->id}");
    }

    public function test_a_forrasmondat_megjelenik_a_kinyert_hatarido_mellett(): void
    {
        $text = 'Tisztelt Adózó! Az adószámláján hátralék mutatkozik. Kérjük, a hiányzó összeget rendezze. Fizetési határidő: 2026.12.18. A befizetés elmulasztása esetén késedelmi pótlékot számítunk fel. ' . str_repeat('Töltelék mondat a levél végén. ', 30);
        $m = $this->letterWith('FM-1', 'felszolitas.pdf', Samples::pdf($text));

        $this->assertSame(['2026-12-18', 0, 0], [$m->deadline_date, (int) $m->deadline_sure, (int) $m->past_deadline_warn]);
        $this->assertStringContainsString('Fizetesi hatarido: 2026.12.18', $m->deadline_excerpt);
        $this->assertLessThanOrEqual(320, mb_strlen($m->deadline_excerpt)); // részlet, nem a teljes irat
        $dl = $this->stateOf($m)['dl'];
        $this->assertStringContainsString('Fizetesi hatarido: 2026.12.18', $dl['excerpt']);
        $this->assertFalse($dl['past']);
    }

    public function test_xml_mezobol_kinyert_hataridonel_a_mezo_neve_a_forras(): void
    {
        $xml = '<?xml version="1.0" encoding="UTF-8"?><Hatarozat><PotlasiHatarido>2026-12-03</PotlasiHatarido></Hatarozat>';
        $m = $this->letterWith('XM-1', 'kisero.xml', $xml);

        $this->assertSame('2026-12-03', $m->deadline_date);
        $this->assertStringContainsString('PotlasiHatarido', $m->deadline_excerpt);
    }

    public function test_az_erkezesnel_korabbi_datum_hivatkozas_nem_hatarido(): void
    {
        $m = $this->letterWith('MU-1', 'ertesites.pdf', Samples::pdf('A korábbi felszólításban megadott határidő: 2026.10.01. eredménytelenül telt el.'), '2026-11-10 09:30');

        $this->assertSame(['2026-10-01', 1], [$m->deadline_date, (int) $m->past_deadline_warn]);
        $this->assertTrue($this->stateOf($m)['dl']['past']);
    }

    public function test_munkanapon_belul_a_munkaszuneti_napokat_kihagyja_a_napon_belul_naptari(): void
    {
        Carbon::setTestNow('2026-12-18 10:00:00'); // péntek; előtte karácsony és hétvégék
        $m = $this->letterWith('MN-1', 'vegzes.pdf', Samples::pdf('A hiánypótlást a kézbesítéstől számított 8 munkanapon belül teljesítse.'), '2026-12-17 09:00');
        $this->assertSame('2026-12-31', $m->deadline_date); // dec. 21, 22, 23, 24, 28, 29, 30, 31
        $this->assertStringContainsString('8 munkanap', $m->deadline_source);
        $this->assertStringContainsString('8 munkanapon belul', $m->deadline_excerpt);

        $n = $this->letterWith('MN-2', 'vegzes2.pdf', Samples::pdf('A fellebbezést 15 napon belül nyújthatja be.'), '2026-12-17 09:00');
        $this->assertSame('2027-01-02', $n->deadline_date); // naptári napok
    }

    public function test_munkanap_naptar(): void
    {
        $this->assertSame(['2026-01-01', '2026-03-15', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-25', '2026-08-20', '2026-10-23', '2026-11-01', '2026-12-25', '2026-12-26'], WorkCalendar::holidays(2026));
        $this->assertFalse(WorkCalendar::isWorkday(Carbon::parse('2026-10-23')));
        $this->assertFalse(WorkCalendar::isWorkday(Carbon::parse('2026-11-14'))); // szombat
        $this->assertTrue(WorkCalendar::isWorkday(Carbon::parse('2026-11-13')));
        $this->assertSame('2026-10-26', WorkCalendar::addWorkdays(Carbon::parse('2026-10-22'), 1)->toDateString()); // csüt. → hétfő (péntek ünnep)
    }

    public function test_ekezetes_szovegbol_is_pontos_a_forrasmondat_es_nem_vag_bele_a_talalatba(): void
    {
        $m = $this->letterWith('EK-1', 'level.txt', 'Tisztelt Ügyfelünk! Kérjük, hogy a hátralékot szíveskedjék rendezni. Fizetési határidő: 2026.12.18. Üdvözlettel: az ügyintéző.');
        $this->assertSame('2026-12-18', $m->deadline_date);
        $this->assertStringContainsString('Fizetési határidő: 2026.12.18', $m->deadline_excerpt);

        // Szóköz nélküli hosszú előzmény: a részlet akkor sem vághat bele magába a találatba.
        $n = $this->letterWith('EK-2', 'hosszu.txt', str_repeat('x', 400) . 'határidő: 2026.12.19. vége');
        $this->assertStringContainsString('határidő: 2026.12.19', $n->deadline_excerpt);
    }

    public function test_tobb_kifejezes_kozul_a_legrovidebb_szamit_es_a_haromjegyu_szam_nem_csonkul(): void
    {
        Carbon::setTestNow('2026-11-09 10:00:00'); // hétfő
        $m = $this->letterWith('TK-1', 'vegzes.txt', 'A végzés ellen 15 napon belül fellebbezésnek van helye. A hiánypótlást 8 napon belül teljesítse.', '2026-11-06 09:00');
        $this->assertSame('2026-11-17', $m->deadline_date);
        $this->assertStringContainsString('8 napon belül', $m->deadline_excerpt);
        $this->assertStringContainsString('több határidő', $m->deadline_source);

        $n = $this->letterWith('TK-2', 'hosszu.txt', 'Az elévülés 115 napon belül következik be.', '2026-11-06 09:00');
        $this->assertNull($n->deadline_date); // a 115-ből nem lesz 15
    }
}
