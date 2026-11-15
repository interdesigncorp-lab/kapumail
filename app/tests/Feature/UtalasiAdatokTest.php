<?php

namespace Tests\Feature;

use App\Iratkapu\TaxPayment;
use Tests\TestCase;

/** Utalási adatok az adónaptár tételeihez: a rögzített táblázat épsége és a nyomtatványkód feloldása. */
class UtalasiAdatokTest extends TestCase
{
    public function test_a_tablazat_ep(): void
    {
        foreach (TaxPayment::TAX_TYPES as $code => $t) {
            $this->assertMatchesRegularExpression('/^\d{1,4}$/', (string) $code);
            $this->assertNotSame('', $t['name']);
            $this->assertMatchesRegularExpression('/^\d{8}-\d{8}(-\d{8})?$/', $t['account']);
            $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}$/', $t['checked']);
        }
        foreach (TaxPayment::FORMS as $codes) {
            foreach ($codes as $c) {
                $this->assertArrayHasKey($c, TaxPayment::TAX_TYPES);
            }
        }
    }

    public function test_nyomtatvanykodbol_utalasi_sorok(): void
    {
        $afa = TaxPayment::FORMS['65'][0];
        $sorok = TaxPayment::lines('2665', '12345678-2-42');
        $this->assertCount(1, $sorok);
        $this->assertSame(['taxType' => (string) $afa, 'name' => TaxPayment::TAX_TYPES[$afa]['name'], 'account' => TaxPayment::TAX_TYPES[$afa]['account'], 'reference' => '12345678-2-42'], $sorok[0]);
        $this->assertCount(count(TaxPayment::FORMS['08']), TaxPayment::lines('2608', '12345678-2-42'));
        $this->assertGreaterThan(1, count(TaxPayment::lines('2608', '12345678-2-42')));
        $this->assertSame(TaxPayment::lines('2608', 'x'), TaxPayment::lines('2608A', 'x'));
        $this->assertSame(TaxPayment::lines('2665', 'x'), TaxPayment::lines('2765', 'x')); // másik év, ugyanaz a nyomtatvány
        $this->assertSame(TaxPayment::lines('26KATA', 'x'), TaxPayment::lines('26kata', 'x'));
        $this->assertCount(1, TaxPayment::lines('26KATA', 'x'));
    }

    public function test_adonemkodbol_es_ismeretlenbol(): void
    {
        $afa = TaxPayment::FORMS['65'][0];
        $this->assertSame((string) $afa, TaxPayment::lines("ADONEM-$afa", '8123456789')[0]['taxType']);
        $this->assertSame('8123456789', TaxPayment::lines("ADONEM-$afa", ' 8123456789 ')[0]['reference']);
        $this->assertSame([], TaxPayment::lines('ADONEM-9999', 'x'));
        $this->assertSame([], TaxPayment::lines('NAPTAR', 'x'));
        $this->assertSame([], TaxPayment::lines('26ISMERETLEN', 'x'));
        $this->assertSame([], TaxPayment::lines('', 'x'));
        $this->assertSame([], TaxPayment::lines('9965', 'x')); // csak a 2-vel kezdődő évjelölés válik le
        $this->assertSame([], TaxPayment::lines('1108', 'x'));
    }
}
