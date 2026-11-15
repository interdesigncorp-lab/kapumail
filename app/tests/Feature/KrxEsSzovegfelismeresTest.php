<?php
namespace Tests\Feature;

use App\Iratkapu\Ocr;
use App\Iratkapu\Samples;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\{DB, Storage};
use Tests\TestCase;

/**
 * KRX-boríték kibontása (óvatosan: ZIP-tárolóként, a belső szerkezet értelmezése nélkül) és a szkennelt iratok
 * szövegfelismerése (külön bekapcsolható; a gépre telepített tesseract és pdftoppm kell hozzá).
 */
class KrxEsSzovegfelismeresTest extends TestCase
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

    private function sn(): User
    {
        return User::where('initials', 'SN')->firstOrFail();
    }

    private function letterWith(string $eid, string $fileName, string $bytes): object
    {
        $this->actingAs($this->sn())->postJson('/api/live/ingest', ['autoMap' => true, 'letters' => [[
            'eid' => $eid, 'mailbox' => self::BOX, 'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal', 'type' => 'Tájékoztatás bevallásról', 'desc' => '', 'receivedAt' => '2026-11-10 09:30',
        ]]])->assertOk();
        $m = DB::table('messages')->where('source_id', "live-$eid")->firstOrFail();
        $this->postJson("/api/messages/m{$m->id}/live-download", ['fileName' => $fileName, 'bytesBase64' => base64_encode($bytes)])->assertOk();
        return DB::table('messages')->find($m->id);
    }

    /** @param array<string, string> $files név => tartalom */
    private function zip(array $files): string
    {
        $tmp = tempnam(sys_get_temp_dir(), 'krx');
        $z = new \ZipArchive();
        $z->open($tmp, \ZipArchive::OVERWRITE);
        foreach ($files as $name => $content) {
            $z->addFromString($name, $content);
        }
        $z->close();
        $bytes = file_get_contents($tmp);
        unlink($tmp);
        return $bytes;
    }

    public function test_krx_boritek_kibontasa_es_a_benne_levo_hatarido(): void
    {
        $krx = $this->zip([
            'adatok/urlap.xml' => '<?xml version="1.0" encoding="UTF-8"?><Level><FizetesiHatarido>2026-12-18</FizetesiHatarido></Level>',
            'mellekletek/irat.pdf' => Samples::pdf('Melleklet'),
            '../../../kivulre.txt' => 'nem juthat ki a tarolobol',
        ]);
        $m = $this->letterWith('KRX-1', 'kuldemeny.krx', $krx);

        $parent = DB::table('documents')->where('message_id', $m->id)->whereNull('parent_id')->first();
        $this->assertSame('kibontva', $parent->parse_state);
        $this->assertStringContainsString('szerkezetét a program nem értelmezi', $parent->validity_note);
        $kids = DB::table('documents')->where('parent_id', $parent->id)->orderBy('name')->pluck('name')->all();
        $this->assertCount(3, $kids);
        foreach ($kids as $k) {
            $this->assertStringNotContainsString('/', $k);
            $this->assertStringNotContainsString('..', $k);
        }
        $this->assertSame('2026-12-18', $m->deadline_date);
        $this->assertSame(3, (int) $m->att);
    }

    public function test_hibas_vagy_tul_nagy_krx_nem_bomlik_ki_de_megorzodik(): void
    {
        $nemZip = $this->letterWith('KRX-2', 'hibas.krx', 'ez nem tomoritett tarolo');
        $d = DB::table('documents')->where('message_id', $nemZip->id)->first();
        $this->assertSame('nem_bonthato', $d->parse_state);
        $this->assertSame(0, DB::table('documents')->where('parent_id', $d->id)->count());
        $this->assertSame(hash('sha256', 'ez nem tomoritett tarolo'), $d->sha256); // az eredeti bájtok megvannak

        config(['iratkapu.es3.max_docs' => 3]);
        $sok = $this->letterWith('KRX-3', 'sok.krx', $this->zip(['a.txt' => '1', 'b.txt' => '2', 'c.txt' => '3', 'd.txt' => '4']));
        $d2 = DB::table('documents')->where('message_id', $sok->id)->whereNull('parent_id')->first();
        $this->assertSame('nem_bonthato', $d2->parse_state);
        $this->assertSame(0, DB::table('documents')->where('parent_id', $d2->id)->count());

        config(['iratkapu.es3.max_docs' => 200, 'iratkapu.es3.max_decoded' => 1000]);
        $nagy = $this->letterWith('KRX-4', 'nagy.krx', $this->zip(['nagy.txt' => str_repeat('A', 5000)]));
        $this->assertSame('nem_bonthato', DB::table('documents')->where('message_id', $nagy->id)->whereNull('parent_id')->value('parse_state'));
    }

    /** „Beolvasott” irat: rendes betűtípussal rajzolt kép, szövegréteg nélkül. Betűtípus híján null (a próba kimarad). */
    private function scannedPng(string $text): ?string
    {
        $font = collect(['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf'])->first(fn ($f) => is_file($f));
        if (!$font || !function_exists('imagettftext')) {
            return null;
        }
        $img = imagecreatetruecolor(1400, 220);
        imagefill($img, 0, 0, imagecolorallocate($img, 255, 255, 255));
        imagettftext($img, 44, 0, 40, 130, imagecolorallocate($img, 0, 0, 0), $font, $text);
        ob_start(); imagepng($img); $png = ob_get_clean();
        return $png;
    }

    public function test_szovegfelismeres_alapbol_ki_van_kapcsolva(): void
    {
        $png = $this->scannedPng('Fizetesi hatarido: 2026.12.18.');
        if ($png === null) {
            $this->markTestSkipped('Nincs betűtípus a mintakép rajzolásához.');
        }
        $m = $this->letterWith('OCR-0', 'beolvasott.png', $png);
        $d = DB::table('documents')->where('message_id', $m->id)->first();
        $this->assertNull($d->text);
        $this->assertNull($m->deadline_date);
    }

    public function test_szkennelt_kepbol_szovegfelismeressel_jon_a_hatarido(): void
    {
        if (!Ocr::available()) {
            $this->markTestSkipped('Ezen a gépen nincs tesseract; a szövegfelismerés próbája kimarad.');
        }
        $png = $this->scannedPng('Fizetesi hatarido: 2026.12.18.');
        if ($png === null) {
            $this->markTestSkipped('Nincs betűtípus a mintakép rajzolásához.');
        }
        config(['iratkapu.ocr.enabled' => true]);
        $m = $this->letterWith('OCR-1', 'beolvasott.png', $png);

        $d = DB::table('documents')->where('message_id', $m->id)->first();
        $this->assertSame('ocr', $d->text_source);
        $this->assertStringContainsString('2026.12.18', (string) $d->text);
        $this->assertSame('2026-12-18', $m->deadline_date);
        $this->assertSame(0, (int) $m->deadline_sure);
        $this->assertStringContainsString('szövegfelismerés', $m->deadline_source);
    }

    public function test_szoveges_pdf_nem_megy_szovegfelismeresre(): void
    {
        config(['iratkapu.ocr.enabled' => true]);
        $m = $this->letterWith('OCR-2', 'szoveges.pdf', Samples::pdf('Fizetesi hatarido: 2026.12.18.'));
        $this->assertSame('text', DB::table('documents')->where('message_id', $m->id)->value('text_source'));
        $this->assertStringNotContainsString('szövegfelismerés', (string) $m->deadline_source);
    }

    /** Csak képet tartalmazó (szövegréteg nélküli) egyoldalas PDF a megadott JPEG-ből. */
    private function imageOnlyPdf(string $jpeg, int $w, int $h): string
    {
        $objs = [
            '<< /Type /Catalog /Pages 2 0 R >>',
            '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 $w $h] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
            "<< /Type /XObject /Subtype /Image /Width $w /Height $h /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " . strlen($jpeg) . " >>\nstream\n$jpeg\nendstream",
        ];
        $content = "q $w 0 0 $h 0 0 cm /Im0 Do Q";
        $objs[] = '<< /Length ' . strlen($content) . " >>\nstream\n$content\nendstream";
        $pdf = "%PDF-1.4\n"; $offsets = [];
        foreach ($objs as $i => $o) { $offsets[] = strlen($pdf); $pdf .= ($i + 1) . " 0 obj\n$o\nendobj\n"; }
        $xref = strlen($pdf);
        $pdf .= "xref\n0 " . (count($objs) + 1) . "\n0000000000 65535 f \n";
        foreach ($offsets as $off) { $pdf .= sprintf("%010d 00000 n \n", $off); }
        return $pdf . "trailer\n<< /Size " . (count($objs) + 1) . " /Root 1 0 R >>\nstartxref\n$xref\n%%EOF";
    }

    public function test_szkennelt_pdf_oldalabol_is_megy_a_szovegfelismeres(): void
    {
        $png = $this->scannedPng('Fizetesi hatarido: 2026.12.18.');
        if (!Ocr::available() || $png === null || !(new \Symfony\Component\Process\ExecutableFinder())->find('pdftoppm', null, ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])) {
            $this->markTestSkipped('Ezen a gépen nincs tesseract, pdftoppm vagy betűtípus; a próba kimarad.');
        }
        ob_start(); imagejpeg(imagecreatefromstring($png), null, 92); $jpeg = ob_get_clean();
        config(['iratkapu.ocr.enabled' => true]);
        $m = $this->letterWith('OCR-3', 'beolvasott.pdf', $this->imageOnlyPdf($jpeg, 1400, 220));

        $d = DB::table('documents')->where('message_id', $m->id)->first();
        $this->assertSame(['application/pdf', 'ocr'], [$d->mime, $d->text_source]);
        $this->assertSame('2026-12-18', $m->deadline_date);
    }

    /** Az egymásba ágyazott csomagok együtt sem léphetik át a fájlszám-korlátot. */
    public function test_egymasba_agyazott_boritekok_egyutt_sem_lephetik_at_a_korlatot(): void
    {
        config(['iratkapu.es3.max_docs' => 6]);
        $inner = fn (string $p) => $this->zip(["$p-1.txt" => 'a', "$p-2.txt" => 'b', "$p-3.txt" => 'c']);
        $m = $this->letterWith('KRX-5', 'kulso.krx', $this->zip(['a.krx' => $inner('a'), 'b.krx' => $inner('b'), 'c.krx' => $inner('c')]));

        $this->assertLessThanOrEqual(1 + 6, DB::table('documents')->where('message_id', $m->id)->count());
        $this->assertTrue(DB::table('documents')->where('message_id', $m->id)->where('parse_state', 'nem_bonthato')->exists());
    }

    public function test_szovegfelismeres_korlatai(): void
    {
        config(['iratkapu.ocr.enabled' => true, 'iratkapu.ocr.max_docs' => 2]);
        if (!Ocr::available()) {
            $this->markTestSkipped('Ezen a gépen nincs tesseract.');
        }
        // Irreálisan nagy felbontású kép (csak a fejléce): a program meg sem próbálja feldolgozni.
        $hugePng = "\x89PNG\r\n\x1a\n" . pack('N', 13) . 'IHDR' . pack('NN', 30000, 30000) . "\x08\x02\x00\x00\x00" . pack('N', 0);
        $this->assertNull(Ocr::text($hugePng, 'image/png'));

        // Egy kérésben legfeljebb ennyi fájl megy szövegfelismerésre.
        $png = $this->scannedPng('Fizetesi hatarido: 2026.12.18.');
        if ($png === null) {
            $this->markTestSkipped('Nincs betűtípus a mintakép rajzolásához.');
        }
        Ocr::resetBudget();
        $this->assertNotNull(Ocr::text($png, 'image/png'));
        $this->assertNotNull(Ocr::text($png, 'image/png'));
        $this->assertNull(Ocr::text($png, 'image/png'), 'a harmadik már nem megy');
    }
}
