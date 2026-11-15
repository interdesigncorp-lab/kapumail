<?php
namespace App\Iratkapu;

/**
 * XLSX-munkafüzet kiolvasása előnézethez és kereséshez: az első munkalap celláinak szöveges értéke, sorokba rendezve.
 * Képleteket nem számol (a fájlban tárolt utolsó értéket veszi), formázást nem visz át. A dátumként formázott
 * számokat a stílusuk alapján ÉÉÉÉ.HH.NN alakra írja. Korlátok: kibontott méret, sor- és oszlopszám.
 */
final class XlsxReader
{
    private const MAX_PART = 20 * 1024 * 1024;

    public static function isXlsx(?string $mime, string $bytes): bool
    {
        return str_starts_with($bytes, "PK\x03\x04") && (str_contains((string) $mime, 'spreadsheetml') || self::hasPart($bytes, 'xl/workbook.xml'));
    }

    /** @return array<int, array<int, string>>|null  null, ha a fájl nem olvasható munkafüzet */
    public static function rows(string $bytes, int $maxRows = 2000, int $maxCols = 40): ?array
    {
        $tmp = tempnam(sys_get_temp_dir(), 'xlsx');
        try {
            file_put_contents($tmp, $bytes);
            $zip = new \ZipArchive();
            if ($zip->open($tmp, \ZipArchive::RDONLY) !== true) return null;
            $part = fn (string $n) => (($st = $zip->statName($n)) && $st['size'] <= self::MAX_PART) ? $zip->getFromName($n) : null;
            $shared = [];
            if ($xml = self::xml($part('xl/sharedStrings.xml'))) {
                foreach ($xml->si as $si) $shared[] = self::richText($si);
            }
            $dateStyles = self::dateStyles(self::xml($part('xl/styles.xml')));
            $sheet = self::xml($part(self::firstSheetPath($zip, $part)));
            $zip->close();
            if (!$sheet || !isset($sheet->sheetData)) return null;
            $out = [];
            foreach ($sheet->sheetData->row as $row) {
                $r = (int) $row['r'] ?: count($out) + 1;
                if ($r > $maxRows) break;
                $cells = [];
                foreach ($row->c as $c) {
                    $col = self::colIndex((string) $c['r']) ?? count($cells);
                    if ($col >= $maxCols) continue;
                    $t = (string) $c['t']; $v = isset($c->v) ? (string) $c->v : '';
                    $val = match ($t) {
                        's' => $shared[(int) $v] ?? '',
                        'inlineStr' => isset($c->is) ? self::richText($c->is) : '',
                        'b' => $v === '1' ? 'IGAZ' : 'HAMIS',
                        default => ($v !== '' && is_numeric($v) && isset($dateStyles[(int) $c['s']])) ? self::serialDate((float) $v) : $v,
                    };
                    $cells[$col] = trim(preg_replace('/[\t\r\n]+/', ' ', $val));
                }
                if (!array_filter($cells, fn ($x) => $x !== '')) continue;
                $line = array_fill(0, max(array_keys($cells)) + 1, '');
                foreach ($cells as $i => $x) $line[$i] = $x;
                $out[] = $line;
            }
            return $out;
        } catch (\Throwable) {
            return null;
        } finally {
            @unlink($tmp);
        }
    }

    /** Tabulátorral tagolt szöveg (sor = sor, cella = tabulátor): ez kerül a keresőbe és az előnézetbe. */
    public static function text(string $bytes): ?string
    {
        $rows = self::rows($bytes);
        if (!$rows) return null;
        return implode("\n", array_map(fn ($r) => rtrim(implode("\t", $r)), $rows));
    }

    private static function hasPart(string $bytes, string $name): bool
    {
        return str_contains($bytes, $name);
    }

    private static function xml(?string $s): ?\SimpleXMLElement
    {
        if (!$s) return null;
        $x = @simplexml_load_string($s, \SimpleXMLElement::class, LIBXML_NONET | LIBXML_NOCDATA);
        return $x ?: null;
    }

    private static function richText(\SimpleXMLElement $si): string
    {
        if (isset($si->t)) return (string) $si->t;
        $s = ''; foreach ($si->r as $r) $s .= (string) $r->t; return $s;
    }

    private static function firstSheetPath(\ZipArchive $zip, \Closure $part): string
    {
        $wb = self::xml($part('xl/workbook.xml')); $rels = self::xml($part('xl/_rels/workbook.xml.rels'));
        if ($wb && $rels && isset($wb->sheets->sheet[0])) {
            $rid = (string) $wb->sheets->sheet[0]->attributes('http://schemas.openxmlformats.org/officeDocument/2006/relationships')['id'];
            foreach ($rels->Relationship as $rel) {
                if ((string) $rel['Id'] === $rid) { $t = ltrim((string) $rel['Target'], '/'); return str_starts_with($t, 'xl/') ? $t : 'xl/' . $t; }
            }
        }
        return 'xl/worksheets/sheet1.xml';
    }

    /** @return array<int, true>  a dátumként formázott cellastílusok sorszámai */
    private static function dateStyles(?\SimpleXMLElement $st): array
    {
        if (!$st || !isset($st->cellXfs)) return [];
        $custom = [];
        foreach ($st->numFmts->numFmt ?? [] as $f) {
            $code = preg_replace('/"[^"]*"|\[[^\]]*\]/', '', strtolower((string) $f['formatCode']));
            if (preg_match('/[dy]|m{1,2}[^a-z]*d|é|nn/u', $code)) $custom[(int) $f['numFmtId']] = true;
        }
        $out = []; $i = 0;
        foreach ($st->cellXfs->xf as $xf) {
            $id = (int) $xf['numFmtId'];
            if (($id >= 14 && $id <= 22) || ($id >= 45 && $id <= 47) || isset($custom[$id])) $out[$i] = true;
            $i++;
        }
        return $out;
    }

    private static function serialDate(float $v): string
    {
        if ($v < 1 || $v > 2958465) return (string) $v;
        $ts = (int) round(($v - 25569) * 86400);
        return gmdate(fmod($v, 1) > 0 ? 'Y.m.d. H:i' : 'Y.m.d.', $ts);
    }

    private static function colIndex(string $ref): ?int
    {
        if (!preg_match('/^([A-Z]+)/', $ref, $m)) return null;
        $n = 0; foreach (str_split($m[1]) as $ch) $n = $n * 26 + (ord($ch) - 64);
        return $n - 1;
    }
}
