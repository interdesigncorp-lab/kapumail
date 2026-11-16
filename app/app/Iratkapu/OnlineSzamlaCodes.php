<?php

namespace App\Iratkapu;

/**
 * Hivatalos NAV Online Számla 3.0 ÁFA- és mentességi technikai kódok (ADR-012, R2).
 *
 * A 13 hivatalos technikai adókód az Online Számla 3.0 XML sémában (vatOutOfScope, vatExempt,
 * domesticReverseCharge) szereplő jogcímekhez kapcsolódó törvényi hivatkozásokkal, bevallási és
 * összesítő nyilatkozati kapcsolatokkal, valamint partneri követelményekkel.
 */
final class OnlineSzamlaCodes
{
    /** @var array<string, array{code: string, category: string, title: string, legal_citation: string, tax_return_relations: string, partner_requirements: string, rules: string}> */
    private const CODES = [
        'EUFAD37' => [
            'code' => 'EUFAD37',
            'category' => 'vatOutOfScope',
            'title' => 'Másik tagállamban teljesített fordított adózású szolgáltatás (főszabály)',
            'legal_citation' => 'Áfa tv. 37. § (1) bek.',
            'tax_return_relations' => 'A60 összesítő nyilatkozat (02-es lap – Szolgáltatás) és havi ÁFA bevallás (pl. 2665) 91. sora (Tájékoztató adatként)',
            'partner_requirements' => 'Vevő másik EU tagállambeli adóalany, érvényes közösségi adószáma (EU adószám) kötelező',
            'rules' => 'Szolgáltatásnyújtás másik tagállambeli adóalany részére, ahol a teljesítés helye a megrendelő székhelye/telephelye (B2B főszabály). A számlán áthárított adó nem szerepelhet, a „fordított adózás” kifejezés kötelező.',
        ],
        'EUFADE' => [
            'code' => 'EUFADE',
            'category' => 'vatOutOfScope',
            'title' => 'Másik tagállamban teljesített egyéb fordított adózású ügylet (különös szabályok)',
            'legal_citation' => 'Áfa tv. 39–49. § (pl. ingatlanhoz kapcsolódó szolgáltatás: 39. §; szerelés: 32. §)',
            'tax_return_relations' => 'Havi ÁFA bevallás (pl. 2665) 91. sora. Az A60 összesítő nyilatkozatban NEM szerepel.',
            'partner_requirements' => 'Vevő adóalany',
            'rules' => 'Különös teljesítési helyi szabályok alá eső, másik tagállamban teljesített fordított adózású ügylet (pl. ingatlan fekvése szerinti szolgáltatás). Nem az A60-ban jelentendő általános 37. § szerinti szolgáltatás.',
        ],
        'ATK' => [
            'code' => 'ATK',
            'category' => 'vatOutOfScope',
            'title' => 'ÁFA tárgyi hatályán kívüli ügylet',
            'legal_citation' => 'Áfa tv. 2–3. §',
            'tax_return_relations' => 'ÁFA bevallásban főszabály szerint nem szerepel',
            'partner_requirements' => 'Nincs különös partnerkövetelmény',
            'rules' => 'Nem minősül az Áfa tv. szerint ellenérték fejében teljesített termékértékesítésnek vagy szolgáltatásnyújtásnak (pl. kártérítés, kötbér, pénzeszköz-átadás, támogatás, közhatalmi tevékenység).',
        ],
        'HO' => [
            'code' => 'HO',
            'category' => 'vatOutOfScope',
            'title' => 'Harmadik országban (EU-n kívül) teljesített ügylet',
            'legal_citation' => 'Áfa tv. 37. § (1) bek. vagy egyéb harmadik országbeli teljesítési hely szabály',
            'tax_return_relations' => 'Havi ÁFA bevallás (pl. 2665) 92. sora. Az A60 összesítő nyilatkozatban NEM szerepel.',
            'partner_requirements' => 'Harmadik országbeli (nem EU tagállami) partner',
            'rules' => 'A teljesítés helye az Európai Közösség területén kívül van (pl. harmadik országbeli megrendelőnek nyújtott B2B szolgáltatás). A magyar ÁFA hatályán kívül esik.',
        ],
        'EUE' => [
            'code' => 'EUE',
            'category' => 'vatOutOfScope',
            'title' => 'Másik tagállamban teljesített egyéb ügylet (nem fordított adózás)',
            'legal_citation' => 'Áfa tv. 45/A. § és XIX/A. fejezet (OSS / távértékesítés)',
            'tax_return_relations' => 'Egyablakos rendszer (OSS) szerinti bevallás vagy rendeltetési tagállam szerinti helyi bevallás',
            'partner_requirements' => 'Nem adóalany vevő (B2C) másik EU tagállamban',
            'rules' => 'Másik EU tagállamban teljesített, nem fordított adózású ügylet, különösen Közösségen belüli távértékesítés nem adóalanyok részére (OSS hatálya alá tartozó vagy célországban megfizetendő adó).',
        ],
        'KBAET' => [
            'code' => 'KBAET',
            'category' => 'vatExempt',
            'title' => 'Közösségen belüli adómentes termékértékesítés (új közlekedési eszköz nélkül)',
            'legal_citation' => 'Áfa tv. 89. § (1) bek.',
            'tax_return_relations' => 'Havi ÁFA bevallás (pl. 2665) 01. sora és A60 összesítő nyilatkozat 01-es lap (Termékértékesítés)',
            'partner_requirements' => 'Vevő másik EU tagállambeli adóalany, érvényes közösségi adószáma kötelező',
            'rules' => 'A terméket igazoltan másik EU tagállamba fuvarozták vagy szállították el (fuvarokmány, CMR, feladási igazolás). Számlán az adómentességre való hivatkozás kötelező.',
        ],
        'KBAUK' => [
            'code' => 'KBAUK',
            'category' => 'vatExempt',
            'title' => 'Közösségen belüli adómentes új közlekedési eszköz értékesítés',
            'legal_citation' => 'Áfa tv. 89. § (2) bek.',
            'tax_return_relations' => 'Havi ÁFA bevallás (pl. 2665) 02. sora és A60 összesítő nyilatkozat',
            'partner_requirements' => 'Vevő lehet nem adóalany (magánszemély) is másik EU tagállamban',
            'rules' => 'Új közlekedési eszköz (gépjármű, vízi jármű, légi jármű) értékesítése másik tagállamba, amely a célországban adózik. Jármű technikai adatait a számlán fel kell tüntetni.',
        ],
        'EAM' => [
            'code' => 'EAM',
            'category' => 'vatExempt',
            'title' => 'Termékexport az Európai Unió területén kívülre',
            'legal_citation' => 'Áfa tv. 98–109. § (különösen 98. § (1) bek.)',
            'tax_return_relations' => 'Havi ÁFA bevallás (pl. 2665) 03. sora. Az A60 összesítő nyilatkozatban NEM szerepel.',
            'partner_requirements' => 'Harmadik országbeli vevő vagy rendeltetési hely',
            'rules' => 'A termék igazoltan elhagyta a Közösség vámterületét. Vámhatósági kiléptetési igazolás (IE599 üzenet) szükséges az adómentesség jogszerűségéhez.',
        ],
        'NAM_1' => [
            'code' => 'NAM_1',
            'category' => 'vatExempt',
            'title' => 'Nemzetközi forgalomhoz kapcsolódó adómentes közvetítői tevékenység',
            'legal_citation' => 'Áfa tv. 110. §',
            'tax_return_relations' => 'Havi ÁFA bevallás (pl. 2665) 04. sora',
            'partner_requirements' => 'Más nevében és javára eljáró közvetítő',
            'rules' => 'Adómentes közvetítői tevékenység termékexport vagy nemzetközi teherközlekedés kapcsán.',
        ],
        'NAM_2' => [
            'code' => 'NAM_2',
            'category' => 'vatExempt',
            'title' => 'Termékek nemzetközi forgalmához közvetlenül kapcsolódó adómentes ügylet',
            'legal_citation' => 'Áfa tv. 111–118. §',
            'tax_return_relations' => 'Havi ÁFA bevallás (pl. 2665) 04. sora',
            'partner_requirements' => 'Vámjogi vagy adóraktározási eljárásban részt vevő felek',
            'rules' => 'Vámraktározási, adóraktározási, átmeneti megőrzési vagy egyéb nemzetközi forgalmi eljárás alá vont termék értékesítése vagy szolgáltatásnyújtás.',
        ],
        'AAM' => [
            'code' => 'AAM',
            'category' => 'vatExempt',
            'title' => 'Alanyi adómentes értékesítés',
            'legal_citation' => 'Áfa tv. XIII. fejezet (187–196. §, különösen 188. §)',
            'tax_return_relations' => 'Főszabály szerint nem keletkeztet rendszeres áfabevallási kötelezettséget (ha mégis adnak, pl. 2665 07. sora)',
            'partner_requirements' => 'Az eladó alanyi adómentességet választott adóalany (értékhatár: 12/18 millió Ft)',
            'rules' => 'Az alanyi adómentes adóalany adót nem számíthat fel, adólevonási joggal nem élhet. Számlán kötelező feltüntetni az „Alanyi adómentes” záradékot.',
        ],
        'TAM' => [
            'code' => 'TAM',
            'category' => 'vatExempt',
            'title' => 'Tevékenység közérdekű vagy sajátos jellegére tekintettel adómentes ügylet (tárgyi mentesség)',
            'legal_citation' => 'Áfa tv. 85–86. § (pl. egészségügy, közoktatás, humánszolgáltatás, ingatlan-bérbeadás főszabályként, pénzügyi szolgáltatások)',
            'tax_return_relations' => 'Havi ÁFA bevallás (pl. 2665) 05. sora',
            'partner_requirements' => 'Jogszabályban meghatározott mentes tevékenység végzése',
            'rules' => 'Tárgyi adómentes (tevékenységhez kötött mentesség). Levonási jog az ilyen beszerzésekre nem érvényesíthető. Számlán kötelező a mentesség jogszabályi hivatkozása.',
        ],
        'FAD' => [
            'code' => 'FAD',
            'category' => 'domesticReverseCharge',
            'title' => 'Belföldi fordított adózású ügylet',
            'legal_citation' => 'Áfa tv. 142. §',
            'tax_return_relations' => 'Eladónál: ÁFA bevallás (pl. 2665) 04. sora. Vevőnél: ÁFA bevallás 29–33. és 64–68. sorai, valamint 2665M belföldi összesítő jelentés',
            'partner_requirements' => 'Mindkét fél (eladó és vevő is) belföldi nyilvántartásba vett adóalany, adószámuk a számlán kötelező',
            'rules' => 'Az adót a vevő köteles megfizetni. Számlán az áthárított adó mértéke és összege nem szerepelhet, és kötelező a „fordított adózás” kifejezés feltüntetése.',
        ],
    ];

    /** @var array<string, string> */
    private const ALIASES = [
        'NAM-1' => 'NAM_1',
        'NAM1' => 'NAM_1',
        'NAM-2' => 'NAM_2',
        'NAM2' => 'NAM_2',
    ];

    /**
     * Az összes NAV Online Számla 3.0 adókód listája.
     *
     * @return array<string, array{code: string, category: string, title: string, legal_citation: string, tax_return_relations: string, partner_requirements: string, rules: string}>
     */
    public static function all(): array
    {
        return self::CODES;
    }

    /**
     * Kód feloldása normalizálással (kis- és nagybetű független, szóközök és elválasztók kezelése).
     *
     * @return ?array{code: string, category: string, title: string, legal_citation: string, tax_return_relations: string, partner_requirements: string, rules: string}
     */
    public static function resolve(?string $rawCode): ?array
    {
        if ($rawCode === null) {
            return null;
        }
        $code = mb_strtoupper(trim($rawCode));
        if ($code === '' || strlen($code) > 32) {
            return null;
        }

        if (isset(self::CODES[$code])) {
            return self::CODES[$code];
        }

        if (isset(self::ALIASES[$code])) {
            $target = self::ALIASES[$code];
            if (isset(self::CODES[$target])) {
                return self::CODES[$target];
            }
        }

        return null;
    }
}
