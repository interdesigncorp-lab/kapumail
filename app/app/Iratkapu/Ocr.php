<?php
namespace App\Iratkapu;

use Illuminate\Support\Facades\Process;
use Symfony\Component\Process\ExecutableFinder;

/**
 * Szövegfelismerés szkennelt iratokra, a gépre telepített `tesseract` (és PDF-hez `pdftoppm`) programmal.
 * Alapból KI van kapcsolva (IRATKAPU_OCR=true kapcsolja be): idegen eredetű fájlt külső programmal dolgoz fel.
 * A felismert szöveg tévedhet; a belőle kinyert határidő mindig becslés, az eredetin ellenőrizendő.
 * Korlátok: legfeljebb `ocr.max_pages` oldal, programonként `ocr.timeout` másodperc, 20 MB-nál nem nagyobb fájl,
 * túl nagy felbontású kép kizárva; egy kérésen belül legfeljebb `ocr.max_docs` fájl és összesen `ocr.max_seconds` másodperc.
 * A feldolgozás ma a kérésen belül fut; nagy forgalomnál háttérfeladatba kell tenni.
 */
final class Ocr
{
    private const DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
    /** Egy kérésen belüli keret: hány fájl és összesen mennyi idő mehet szövegfelismerésre. */
    private static int $docs = 0;
    private static float $seconds = 0.0;
    private static ?string $langs = null;

    public static function resetBudget(): void
    {
        self::$docs = 0;
        self::$seconds = 0.0;
    }

    private static function budgetLeft(): bool
    {
        return self::$docs < (int) config('iratkapu.ocr.max_docs', 5) && self::$seconds < (float) config('iratkapu.ocr.max_seconds', 60);
    }

    /** Túl nagy felbontású kép (kibontva több száz MB lenne) vagy nem értelmezhető fejléc: nem dolgozzuk fel. */
    private static function imageTooBig(string $bytes): bool
    {
        $info = @getimagesizefromstring($bytes);
        return !$info || $info[0] * $info[1] > 40_000_000;
    }

    /**
     * PDF szövegrétege a `pdftotext` programmal (a tömörített szövegű PDF-eket is olvassa). Null, ha nincs szövegréteg,
     * a program nincs telepítve, vagy a szövegfelismerés nincs bekapcsolva.
     */
    public static function pdfText(string $bytes): ?string
    {
        if (!self::enabled() || self::bin('pdftotext') === null || strlen($bytes) > 20 * 1024 * 1024 || !self::budgetLeft()) {
            return null;
        }
        $tmp = tempnam(sys_get_temp_dir(), 'kmpdf');
        $t0 = microtime(true);
        try {
            file_put_contents($tmp, $bytes);
            $r = Process::timeout(20)->run([self::bin('pdftotext'), '-l', '20', '-enc', 'UTF-8', $tmp, '-']);
            $text = $r->successful() ? trim(preg_replace('/\s+/u', ' ', mb_convert_encoding($r->output(), 'UTF-8', 'UTF-8'))) : '';
            return mb_strlen($text) >= 20 ? mb_substr($text, 0, 20000) : null;
        } catch (\Throwable) {
            return null;
        } finally {
            self::$seconds += microtime(true) - $t0;
            @unlink($tmp);
        }
    }

    private static function bin(string $name): ?string
    {
        return config("iratkapu.ocr.$name") ?: (new ExecutableFinder())->find($name, null, self::DIRS);
    }

    /** Telepítve van-e a szövegfelismerő ezen a gépen. */
    public static function available(): bool
    {
        return self::bin('tesseract') !== null;
    }

    public static function enabled(): bool
    {
        return (bool) config('iratkapu.ocr.enabled') && self::available();
    }

    /** Magyar nyelvi adat, ha telepítve van; különben csak angol (az ékezetes betűket ilyenkor rosszabbul ismeri fel). */
    public static function languages(): string
    {
        if (self::$langs === null) {
            $out = Process::timeout(10)->run([self::bin('tesseract'), '--list-langs'])->output();
            self::$langs = preg_match('/^hun$/m', $out) ? 'hun+eng' : 'eng';
        }
        return self::$langs;
    }

    /** A fájl felismert szövege, vagy null, ha nem kép / PDF, vagy a felismerés nem sikerült. */
    public static function text(string $bytes, ?string $mime): ?string
    {
        $isPdf = $mime === 'application/pdf';
        $isImage = in_array($mime, ['image/png', 'image/jpeg', 'image/tiff'], true);
        if (!self::enabled() || (!$isPdf && !$isImage) || strlen($bytes) > 20 * 1024 * 1024) {
            return null;
        }
        if ($isPdf && self::bin('pdftoppm') === null) {
            return null;
        }
        if (!self::budgetLeft() || ($isImage && (strlen($bytes) > 8 * 1024 * 1024 || self::imageTooBig($bytes)))) {
            return null; // elfogyott a kérés kerete, vagy a kép túl nagy
        }
        self::$docs++;
        $t0 = microtime(true);
        $dir = sys_get_temp_dir() . '/kapumail-ocr-' . bin2hex(random_bytes(8));
        if (!@mkdir($dir, 0700)) {
            return null;
        }
        $timeout = (int) config('iratkapu.ocr.timeout', 20);
        try {
            $pages = [];
            if ($isPdf) {
                file_put_contents("$dir/in.pdf", $bytes);
                Process::timeout($timeout)->run([self::bin('pdftoppm'), '-scale-to', '2200', '-png', '-f', '1', '-l', (string) config('iratkapu.ocr.max_pages', 3), "$dir/in.pdf", "$dir/p"]);
                $pages = glob("$dir/p*.png") ?: [];
                sort($pages);
            } else {
                file_put_contents("$dir/in.img", $bytes);
                $pages = ["$dir/in.img"];
            }
            $lang = self::languages();
            $text = '';
            foreach ($pages as $page) {
                if (microtime(true) - $t0 > (float) config('iratkapu.ocr.max_seconds', 60)) {
                    break;
                }
                $r = Process::timeout($timeout)->run([self::bin('tesseract'), $page, 'stdout', '-l', $lang]);
                if ($r->successful()) {
                    $text .= "\n" . $r->output();
                }
            }
            $text = trim(preg_replace('/\s+/u', ' ', mb_convert_encoding($text, 'UTF-8', 'UTF-8')));
            return $text === '' ? null : mb_substr($text, 0, 20000);
        } catch (\Throwable) {
            return null; // időtúllépés vagy hibás fájl: a szövegfelismerés elmarad, az irat ettől még megvan
        } finally {
            self::$seconds += microtime(true) - $t0;
            foreach (glob("$dir/*") ?: [] as $f) {
                @unlink($f);
            }
            @rmdir($dir);
        }
    }
}
