<?php
namespace App\Iratkapu;

class KrxException extends \RuntimeException {}

/**
 * KRX-boríték kibontása – óvatosan.
 * A KRX belső könyvtárszerkezetére a nyilvános források eltérő leírást adnak, és valódi mintacsomagunk nincs,
 * ezért a program a borítékot egyszerű ZIP-tárolóként bontja ki: a benne lévő fájlokat megmutatja, de a
 * szerkezetet (melyik fájl az űrlap, melyik a melléklet) nem értelmezi és nem ellenőrzi.
 * Korlátok: fájlszám, kibontott összméret, titkosított bejegyzés kihagyva, a nevek megtisztítva.
 */
final class KrxReader
{
    /**
     * @return array{documents: array<int, array{name: string, bytes: string}>, skipped: int}
     */
    public function read(string $bytes): array
    {
        if (!str_starts_with($bytes, "PK\x03\x04")) {
            throw new KrxException('A fájl nem ZIP-tároló, a boríték nem bontható ki.');
        }
        $tmp = tempnam(sys_get_temp_dir(), 'krx');
        try {
            file_put_contents($tmp, $bytes);
            $zip = new \ZipArchive();
            if ($zip->open($tmp, \ZipArchive::RDONLY) !== true) {
                throw new KrxException('A boríték sérült, nem nyitható meg.');
            }
            $limits = config('iratkapu.es3');
            if ($zip->numFiles > $limits['max_docs']) {
                throw new KrxException("A borítékban túl sok fájl van ({$zip->numFiles}), a kibontás elmarad.");
            }
            $docs = []; $total = 0; $skipped = 0;
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $st = $zip->statIndex($i);
                if ($st === false || str_ends_with($st['name'], '/')) {
                    continue;
                }
                if (($st['encryption_method'] ?? 0) !== 0) { // titkosított bejegyzést nem tudunk és nem is próbálunk kibontani
                    $skipped++;
                    continue;
                }
                $total += (int) $st['size'];
                if ($st['size'] > $limits['max_file'] || $total > $limits['max_decoded']) {
                    throw new KrxException('A boríték kibontva túl nagy lenne, a kibontás elmarad.');
                }
                $content = $zip->getFromIndex($i, (int) $st['size'] + 1);
                if ($content === false || strlen($content) !== (int) $st['size']) {
                    throw new KrxException('A boríték egyik fájlja nem olvasható ki épségben.');
                }
                $docs[] = ['name' => Es3Reader::safeName($st['name']), 'bytes' => $content];
            }
            $zip->close();
            return ['documents' => $docs, 'skipped' => $skipped];
        } finally {
            @unlink($tmp);
        }
    }
}
