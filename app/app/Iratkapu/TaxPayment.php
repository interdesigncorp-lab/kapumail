<?php

namespace App\Iratkapu;

/**
 * Utalási adatok az adónaptár tételeihez: melyik NAV-számlára, milyen közleménnyel kell fizetni.
 *
 * A program nem utal és összeget nem mond: csak a számlaszámot és a közleményt adja. A táblázat a NAV hivatalos
 * jegyzékéből készült („Adóztatási számlaszámok, IBAN-számlaszámok és adónemek jegyzéke”, a 2026. november 1-jétől
 * érvényes állapot); a `checked` az a nap, amikor a sort a jegyzékkel összevetettük. Amit a táblázat nem ismer,
 * ahhoz nincs utalási adat – a program nem találgat.
 */
final class TaxPayment
{
    public const NOTE = 'Az összeget a bevallásból írd be. A program nem utal.';

    /** Több adónemes nyomtatványnál: a felsorolás a szokásos adónemeket adja, nem a bevallás teljes tartalmát. */
    public const MULTI_NOTE = 'A felsorolás a nyomtatvány szokásos adónemeit mutatja. Ha a bevallásban más adónem is szerepel, a bevallás az irányadó.';

    /**
     * Adónemkód → a beszedési számla neve és száma.
     *
     * @var array<int, array{name: string, account: string, checked: string}>
     */
    public const TAX_TYPES = [
        101 => ['name' => 'NAV Társasági adó bevételi számla', 'account' => '10032000-01076019', 'checked' => '2026-11-13'],
        103 => ['name' => 'NAV Személyi jövedelemadó magánszemélyt, őstermelőt, egyéni vállalkozót, kifizetőt terhelő kötelezettség beszedési számla', 'account' => '10032000-06056353', 'checked' => '2026-11-13'],
        104 => ['name' => 'NAV Általános forgalmi adó bevételi számla', 'account' => '10032000-01076868', 'checked' => '2026-11-13'],
        258 => ['name' => 'NAV Szociális hozzájárulási adó beszedési számla', 'account' => '10032000-06055912', 'checked' => '2026-11-13'],
        288 => ['name' => 'NAV Kisadózó vállalkozások adója bevételi számla', 'account' => '10032000-01076349', 'checked' => '2026-11-13'],
        289 => ['name' => 'NAV Kisvállalati adó bevételi számla', 'account' => '10032000-01076356', 'checked' => '2026-11-13'],
        290 => ['name' => 'NAV Személyi jövedelemadó magánszemélyektől levont adó, adóelőleg beszedési számla', 'account' => '10032000-06055950', 'checked' => '2026-11-13'],
        406 => ['name' => 'NAV Társadalombiztosítási járulék magánszemélyt, őstermelőt, egyéni vállalkozót, kifizetőt terhelő kötelezettség beszedési számla', 'account' => '10032000-06055802', 'checked' => '2026-11-13'],
        407 => ['name' => 'NAV Biztosítottaktól levont társadalombiztosítási járulék beszedési számla', 'account' => '10032000-06055819', 'checked' => '2026-11-13'],
    ];

    /**
     * Nyomtatvány (évjelölés nélkül) → a hozzá tartozó adónemek.
     *
     * @var array<string, list<int>>
     */
    public const FORMS = [
        '65' => [104],
        '08' => [290, 258, 407],
        '29' => [101],
        'KATA' => [288],
        'KIVA' => [289],
    ];

    /**
     * A tétel nyomtatványkódjából (például `2665`, `2608A`, `ADONEM-104`) az utalási sorok.
     *
     * @return list<array{taxType: string, name: string, account: string, reference: string}>
     */
    public static function lines(string $formCode, string $clientTax): array
    {
        $code = mb_strtoupper(trim($formCode));
        if (preg_match('/^ADONEM-(\d{1,4})$/', $code, $hit)) {
            $types = [(int) $hit[1]];
        } else {
            $key = preg_replace('/^2\d(?=.)/', '', $code);
            $types = self::FORMS[$key] ?? self::FORMS[preg_replace('/(?<=\d)[A-Z]+$/', '', $key)] ?? [];
        }
        $reference = preg_replace('/\s+/', '', $clientTax);
        $out = [];
        foreach ($types as $type) {
            if (isset(self::TAX_TYPES[$type])) {
                $out[] = ['taxType' => (string) $type, 'name' => self::TAX_TYPES[$type]['name'], 'account' => self::TAX_TYPES[$type]['account'], 'reference' => $reference];
            }
        }

        return $out;
    }
}
