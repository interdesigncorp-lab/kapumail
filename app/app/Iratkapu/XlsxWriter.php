<?php

namespace App\Iratkapu;

use ZipArchive;

final class XlsxWriter
{
    /**
     * Generate OpenXML (.xlsx) bytes from headers and data rows.
     *
     * @param array<int, string> $headers
     * @param array<int, array<int, mixed>> $rows
     */
    public static function createXlsx(array $headers, array $rows): string
    {
        $tmp = tempnam(sys_get_temp_dir(), 'xlsx_out_');
        $zip = new ZipArchive();
        $zip->open($tmp, ZipArchive::CREATE | ZipArchive::OVERWRITE);

        $zip->addFromString('_rels/.rels', self::rootRels());
        $zip->addFromString('[Content_Types].xml', self::contentTypes());
        $zip->addFromString('xl/_rels/workbook.xml.rels', self::workbookRels());
        $zip->addFromString('xl/workbook.xml', self::workbookXml());
        $zip->addFromString('xl/styles.xml', self::stylesXml());
        $zip->addFromString('xl/worksheets/sheet1.xml', self::worksheetXml($headers, $rows));

        $zip->close();
        $bytes = (string) file_get_contents($tmp);
        @unlink($tmp);

        return $bytes;
    }

    /**
     * Generate CSV string with UTF-8 BOM and semicolon delimiter.
     *
     * @param array<int, string> $headers
     * @param array<int, array<int, mixed>> $rows
     */
    public static function createCsv(array $headers, array $rows): string
    {
        $fp = fopen('php://temp', 'r+');
        fwrite($fp, "\xEF\xBB\xBF");
        fputcsv($fp, $headers, ';');
        foreach ($rows as $row) {
            $formatted = array_map(function ($val) {
                if ($val === null) {
                    return '';
                }
                if (is_bool($val)) {
                    return $val ? 'IGEN' : 'NEM';
                }
                return (string) $val;
            }, $row);
            fputcsv($fp, $formatted, ';');
        }
        rewind($fp);
        $csv = stream_get_contents($fp);
        fclose($fp);

        return (string) $csv;
    }

    private static function rootRels(): string
    {
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            . '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            . '</Relationships>';
    }

    private static function contentTypes(): string
    {
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            . '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            . '<Default Extension="xml" ContentType="application/xml"/>'
            . '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            . '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            . '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            . '</Types>';
    }

    private static function workbookRels(): string
    {
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            . '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            . '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            . '</Relationships>';
    }

    private static function workbookXml(): string
    {
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            . '<sheets>'
            . '<sheet name="Adatok" sheetId="1" r:id="rId1"/>'
            . '</sheets>'
            . '</workbook>';
    }

    private static function stylesXml(): string
    {
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            . '<fonts count="2">'
            . '<font><sz val="11"/><name val="Calibri"/></font>'
            . '<font><b/><sz val="11"/><name val="Calibri"/></font>'
            . '</fonts>'
            . '<fills count="2">'
            . '<fill><patternFill patternType="none"/></fill>'
            . '<fill><patternFill patternType="gray125"/></fill>'
            . '</fills>'
            . '<borders count="1">'
            . '<border><left/><right/><top/><bottom/><diagonal/></border>'
            . '</borders>'
            . '<cellStyleXfs count="1">'
            . '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>'
            . '</cellStyleXfs>'
            . '<cellXfs count="2">'
            . '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
            . '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
            . '</cellXfs>'
            . '</styleSheet>';
    }

    /**
     * @param array<int, string> $headers
     * @param array<int, array<int, mixed>> $rows
     */
    private static function worksheetXml(array $headers, array $rows): string
    {
        $xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            . '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            . '<sheetData>';

        $rowIdx = 1;
        // Header row
        if (!empty($headers)) {
            $xml .= '<row r="' . $rowIdx . '">';
            foreach ($headers as $colIdx => $head) {
                $ref = self::cellRef($colIdx, $rowIdx);
                $escaped = htmlspecialchars(self::sanitizeXml((string) $head), ENT_XML1, 'UTF-8');
                $xml .= '<c r="' . $ref . '" s="1" t="inlineStr"><is><t>' . $escaped . '</t></is></c>';
            }
            $xml .= '</row>';
            $rowIdx++;
        }

        // Data rows
        foreach ($rows as $row) {
            $xml .= '<row r="' . $rowIdx . '">';
            $colIdx = 0;
            foreach ($row as $val) {
                $ref = self::cellRef($colIdx, $rowIdx);
                if ($val === null || $val === '') {
                    $xml .= '<c r="' . $ref . '"/>';
                } elseif (is_int($val) || (is_numeric($val) && !preg_match('/^0[0-9]/', (string) $val))) {
                    $xml .= '<c r="' . $ref . '"><v>' . $val . '</v></c>';
                } else {
                    $escaped = htmlspecialchars(self::sanitizeXml((string) $val), ENT_XML1, 'UTF-8');
                    $xml .= '<c r="' . $ref . '" t="inlineStr"><is><t>' . $escaped . '</t></is></c>';
                }
                $colIdx++;
            }
            $xml .= '</row>';
            $rowIdx++;
        }

        $xml .= '</sheetData></worksheet>';

        return $xml;
    }

    private static function sanitizeXml(string $val): string
    {
        return (string) preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/u', '', $val);
    }

    private static function cellRef(int $colIndex, int $rowIndex): string
    {
        $letters = '';
        $temp = $colIndex + 1;
        while ($temp > 0) {
            $modulo = ($temp - 1) % 26;
            $letters = chr(65 + $modulo) . $letters;
            $temp = (int) (($temp - $modulo) / 26);
        }
        return $letters . $rowIndex;
    }
}
