<?php
namespace App\Iratkapu;

use RobRichards\XMLSecLibs\{XMLSecurityDSig, XMLSecEnc};

/**
 * Az XML-aláírások KRIPTOGRÁFIAI SÉRTETLENSÉGÉNEK ellenőrzése (xmlseclibs).
 * Ez nem teljes érvényesítés: tanúsítványláncot, megbízható listát, visszavonást és időbélyeget NEM vizsgál.
 * Ezért a legjobb eredmény is csak „nem ellenőrizhető” – „érvényes” innen soha nem jöhet (ADR-005).
 * Hamis „érvénytelen” elkerülésére mindent, amit nem tudunk biztosan kezelni, „nem ellenőrizhető”-nek veszünk.
 */
class SignatureCheck
{
    const TRANSFORMS = ['http://www.w3.org/TR/2001/REC-xml-c14n-20010315', 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315#WithComments',
        'http://www.w3.org/2001/10/xml-exc-c14n#', 'http://www.w3.org/2001/10/xml-exc-c14n#WithComments', 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'];

    /** @return array{validity:string,note:string,signatures:array} */
    public static function check(string $xml): array
    {
        if (preg_match('/<!DOCTYPE|<!ENTITY/i', $xml)) return self::out('nem_ellenorizheto', 'DOCTYPE-ot tartalmazó fájl nem vizsgálható.', []);
        $doc = new \DOMDocument(); $prev = libxml_use_internal_errors(true);
        $ok = $doc->loadXML($xml, LIBXML_NONET | LIBXML_PARSEHUGE); libxml_clear_errors(); libxml_use_internal_errors($prev);
        if (!$ok) return self::out('nem_ellenorizheto', 'Az XML nem értelmezhető.', []);
        $xp = new \DOMXPath($doc); $xp->registerNamespace('ds', Es3Reader::DS);
        $n = $xp->query('//ds:Signature')->length;
        if ($n === 0) return self::out('nem_ellenorizheto', 'A fájlban nincs elektronikus aláírás.', []);
        $sigs = [];
        for ($i = 0; $i < $n; $i++) $sigs[] = self::one($doc, $xp, $i);
        $bad = count(array_filter($sigs, fn ($s) => $s['result'] === 'hibas'));
        $good = count(array_filter($sigs, fn ($s) => $s['result'] === 'sertetlen'));
        if ($bad) return self::out('ervenytelen', "$n aláírásból $bad kriptográfiailag hibás: a tartalom megváltozott az aláírás óta, vagy az aláírás sérült.", $sigs);
        if ($good === $n) return self::out('nem_ellenorizheto', "$n aláírás kriptográfiailag sértetlen. A tanúsítványlánc, a megbízható lista, a visszavonás és az időbélyeg nincs ellenőrizve, ezért az érvényesség nem állapítható meg.", $sigs);
        return self::out('nem_ellenorizheto', "$n aláírásból $good sértetlen, a többi nem vizsgálható ezzel a komponenssel.", $sigs);
    }

    private static function out(string $v, string $note, array $sigs): array { return ['validity' => $v, 'note' => $note, 'signatures' => $sigs]; }

    private static function one(\DOMDocument $doc, \DOMXPath $xp, int $pos): array
    {
        $r = ['result' => 'nem_vizsgalhato', 'signer' => null, 'why' => null];
        try {
            $node = $xp->query('//ds:Signature')->item($pos);
            foreach ($xp->query('./ds:SignedInfo/ds:Reference', $node) as $ref) {
                $uri = $ref->getAttribute('URI');
                if ($uri === '' ) { /* teljes dokumentum */ }
                elseif ($uri[0] !== '#') { $r['why'] = 'Külső hivatkozás – biztonsági okból nem követjük.'; return $r; }
                else { $id = substr($uri, 1); if (preg_match('/[\'"]/', $id) || $xp->query("//*[@Id='$id' or @ID='$id' or @id='$id']")->length !== 1) { $r['why'] = 'A hivatkozott elem nem azonosítható egyértelműen.'; return $r; } }
                foreach ($xp->query('./ds:Transforms/ds:Transform', $ref) as $t)
                    if (!in_array($t->getAttribute('Algorithm'), self::TRANSFORMS, true)) { $r['why'] = 'Nem támogatott transzformáció: ' . $t->getAttribute('Algorithm'); return $r; }
            }
            $dsig = new XMLSecurityDSig(); $dsig->idKeys = ['Id', 'ID', 'id'];
            if (!$dsig->locateSignature($doc, $pos)) { $r['why'] = 'Az aláírás nem található.'; return $r; }
            $dsig->canonicalizeSignedInfo();
            $key = $dsig->locateKey();
            if (!$key || !XMLSecEnc::staticLocateKeyInfo($key, $node) || !$key->key) { $r['why'] = 'Az aláírás nem tartalmaz tanúsítványt vagy kulcsot.'; return $r; }
            if ($c = $key->getX509Certificate()) { $p = @openssl_x509_parse($c); $r['signer'] = $p['subject']['CN'] ?? ($p['name'] ?? null); }
            try { $dsig->validateReference(); } catch (\Throwable $e) { $r['result'] = 'hibas'; $r['why'] = 'A hivatkozott tartalom lenyomata nem egyezik.'; return $r; }
            $v = $dsig->verify($key);
            if ($v === 1) $r['result'] = 'sertetlen';
            elseif ($v === 0) { $r['result'] = 'hibas'; $r['why'] = 'Az aláírásérték nem egyezik.'; }
            else $r['why'] = 'Az aláírás nem volt kiértékelhető.';
        } catch (\Throwable $e) { $r['why'] = 'Nem vizsgálható: ' . mb_substr($e->getMessage(), 0, 120); }
        return $r;
    }

    /** Mintaaláírás a demóhoz: minden dokumentum ds:Object elemét aláírja egy eldobható, önaláírt tanúsítvánnyal. */
    public static function signSample(string $es3): string
    {
        $doc = new \DOMDocument(); $doc->loadXML($es3, LIBXML_NONET | LIBXML_PARSEHUGE);
        $pk = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        $csr = openssl_csr_new(['commonName' => 'KapuMail demó aláíró (nem hiteles)', 'organizationName' => 'Minta'], $pk, ['digest_alg' => 'sha256']);
        openssl_x509_export(openssl_csr_sign($csr, null, $pk, 30, ['digest_alg' => 'sha256']), $cert); openssl_pkey_export($pk, $pem);
        $xp = new \DOMXPath($doc); $xp->registerNamespace('es', Es3Reader::NS); $xp->registerNamespace('ds', Es3Reader::DS);
        foreach ($xp->query('//es:Document') as $i => $d) {
            $obj = $xp->query('./ds:Object', $d)->item(0); $obj->setAttribute('Id', 'obj-' . ($i + 1));
            $s = new XMLSecurityDSig(); $s->setCanonicalMethod(XMLSecurityDSig::EXC_C14N);
            $s->addReference($obj, XMLSecurityDSig::SHA256, [XMLSecurityDSig::EXC_C14N], ['overwrite' => false, 'id_name' => 'Id']);
            $k = new \RobRichards\XMLSecLibs\XMLSecurityKey(\RobRichards\XMLSecLibs\XMLSecurityKey::RSA_SHA256, ['type' => 'private']); $k->loadKey($pem);
            $s->sign($k); $s->add509Cert($cert); $s->appendSignature($d);
        }
        return $doc->saveXML();
    }
}

/** Irattípus-felismerés a verziózott taxonómiából. A találat mindig „gépi becslés”. */
class Taxonomy
{
    private static ?array $cache = null;
    public static function norm(string $s): string { return trim(preg_replace('/[^a-z0-9]+/', ' ', strtolower(\Illuminate\Support\Str::ascii($s)))); }

    /** Saját típus kulcsszava ennél rövidebb nem lehet (ékezet és írásjel nélkül számolva). */
    public const OWN_MIN = 3;

    public static function classify(string $subject, string $sender = '', ?int $officeId = null, bool $isSent = false, string $recipient = '', ?string $liveType = null): ?object
    {
        self::$cache ??= \Illuminate\Support\Facades\DB::table('document_types')->get()->all();
        $hay = ' ' . self::norm(($isSent ? "$recipient $sender" : $sender) . " $subject") . ' '; $best = null; $len = 0;
        // Az iroda saját típusai elsőbbséget élveznek: amit az iroda kulcsszóval megnevezett, azt a beépített lista nem írja felül.
        if ($officeId !== null) {
            foreach (self::$cache as $t) if ((int) ($t->office_id ?? 0) === $officeId) foreach (json_decode($t->patterns, true) as $p) {
                $n = self::norm($p);
                if (strlen($n) >= self::OWN_MIN && str_contains($hay, " $n ") && strlen($n) > $len) { $best = $t; $len = strlen($n); }
            }
            if ($best) return $best;
        }
        if ($isSent) {
            $sentPick = FormCatalog::inferSentTypeId($liveType, $subject, $recipient);
            if (!$sentPick) return null;
            foreach (self::$cache as $t) if ($t->type_id === $sentPick) return $t;
            return null;
        }
        $strict = null; $strictLen = 0; // a leghosszabb találat a nem automatikus letöltésű típusok között
        $listOnly = null; $listOnlyLen = 0; // a leghosszabb találat a „csak lista” típusok között
        foreach (self::$cache as $t) foreach (($t->office_id ?? null) === null ? json_decode($t->patterns, true) : [] as $p) {
            $n = self::norm($p);
            if (strlen($n) < 6 || !str_contains($hay, " $n ")) continue;
            if (strlen($n) > $len) { $best = $t; $len = strlen($n); }
            if (($t->download_policy ?? 'kezi') !== 'auto' && strlen($n) > $strictLen) { $strict = $t; $strictLen = strlen($n); }
            if (($t->download_policy ?? 'kezi') === 'csak_lista' && strlen($n) > $listOnlyLen) { $listOnly = $t; $listOnlyLen = strlen($n); }
        }
        // Kétértelmű tárgy (ADR-009): ha egy enyhébb típus (pl. 22 karakteres „adóalany nyilvántartás”) mellett szigorúbb minta
        // (pl. „mulasztási bírság”) is illik, a szigorúbb nyer – a tévedés így a „nem töltjük le” irányba esik.
        if ($best && ($best->download_policy ?? 'kezi') === 'auto' && $strict) $best = $strict;
        if ($best && ($best->download_policy ?? 'kezi') === 'kezi' && $listOnly) $best = $listOnly;
        $inferred = self::infer($hay);
        // Ha a minta csak egy tágabb szakterületi „kézi” gyűjtőt fogott meg, de a tárgy döntést vagy fizetési felhívást jelez,
        // az ügycsoport×fajta mátrix „csak lista” típusa nyer; ugyanígy a szakterületi döntés felülírja az általános
        // „I. fokú határozat” / „eljárást megszüntető végzés” gyűjtőmintát.
        $groupBuckets = ['nav.vam.egyeb', 'nav.jovedek.egyeb', 'nav.adoalany.ertesites', 'nav.megszunes.ertesites', 'nav.penztargep', 'nav.kepviselet'];
        if ($best && in_array($best->type_id, $groupBuckets, true) && ($inferred->download_policy ?? null) === 'csak_lista') return $inferred;
        if ($best && $inferred && ($inferred->download_policy ?? null) === 'csak_lista' && $inferred->type_id !== 'altalanos.hatarozat_vegzes'
            && ($best->type_id === 'nav.eljaras.megszunteto_vegzes' || ($best->type_id === 'nav.adoalany.hatarozat' && !preg_match('/ adoszam torles| kata /', $hay)))) {
            return $inferred;
        }
        if ($hit = $best ?? $inferred) return $hit;
        if ($ltPick = FormCatalog::resolveLiveType($liveType)['incoming_type'] ?? null) {
            foreach (self::$cache as $t) if ($t->type_id === $ltPick) return $t;
        }
        return null; // null → ismeretlen típus, felülvizsgálati sorba
    }

    /** NAV-ügycsoportok: a tárhely típusneve vagy a tárgy egy szava alapján. A sorrend számít, a szűkebb áll elöl. */
    private const NAV_GROUPS = [
        'fizkedv' => 'fizetesi kedvezmeny|fiz kedv|reszletfizet|fizetesi konnyit',
        'vh' => 'vegrehajt|hatralekkezel',
        'ellenorzes' => 'ellenorz',
        'illetek' => 'illetek',
        'vam' => 'vamigazgat|vamhatos',
        'jovedek' => 'jovedek',
        'penztargep' => 'penztargep|taxameter',
        'megszunes' => 'jogutod nelkuli megszunes',
        'rendelkezes' => 'felajanlas',
        'beszamolo' => 'szamviteli beszamolo',
        'kepviselet' => 'kepviselet|meghatalmaz',
        'folyoszamla' => 'folyoszamla|atvezetes',
        'adoalany' => 'adoalany',
        'bevallas' => 'bevallas',
        'igazolas' => ' igazolas |adoigazolas',
    ];

    /** Ügycsoport × az irat fajtája → típus. A `*` az adott csoport minden más fajtája. */
    private const NAV_MATRIX = [
        'fizkedv' => ['dontes' => 'nav.fizkedv.hatarozat_vegzes', '*' => 'nav.fizkedv.megkereses'],
        'vh' => ['dontes' => 'nav.vh.vegzes_koltseg', 'fizetesi' => 'nav.vh.fizetesi_felhivas', 'felhivas' => 'nav.vh.fizetesi_felhivas', 'jegyzokonyv' => 'nav.vh.foglalas_letiltas', '*' => 'nav.vh.ertesites'],
        'ellenorzes' => ['dontes' => 'nav.ellenorzes.hatarozat_birsag', 'fizetesi' => 'nav.ellenorzes.felhivas', 'felhivas' => 'nav.ellenorzes.felhivas', 'jegyzokonyv' => 'nav.ellenorzes.jegyzokonyv', '*' => 'nav.ellenorzes.ertesites'],
        'illetek' => ['dontes' => 'nav.illetek.hatarozat_vegzes', 'fizetesi' => 'nav.illetek.fizetesi', 'felhivas' => 'nav.illetek.felhivas', '*' => 'nav.illetek.tajekoztatas'],
        'vam' => ['dontes' => 'nav.vam.hatarozat_vegzes', '*' => 'nav.vam.egyeb'],
        'jovedek' => ['dontes' => 'nav.jovedek.hatarozat_vegzes', '*' => 'nav.jovedek.egyeb'],
        'penztargep' => ['dontes' => 'altalanos.hatarozat_vegzes', '*' => 'nav.penztargep'],
        'megszunes' => ['dontes' => 'altalanos.hatarozat_vegzes', 'fizetesi' => 'nav.megszunes.fizetesi_felhivas', '*' => 'nav.megszunes.ertesites'],
        'rendelkezes' => ['dontes' => 'nav.rendelkezes.hatarozat', '*' => 'nav.rendelkezes.tajekoztatas'],
        'beszamolo' => ['dontes' => 'nav.beszamolo.hatarozat_vegzes', '*' => 'nav.felszolitas.hianypotlas'],
        'kepviselet' => ['dontes' => 'altalanos.hatarozat_vegzes', '*' => 'nav.kepviselet'],
        'folyoszamla' => ['dontes' => 'nav.folyoszamla.hatarozat_vegzes', 'fizetesi' => 'nav.folyoszamla.hatralek_ertesito', 'felhivas' => 'nav.felszolitas.hianypotlas', '*' => 'nav.folyoszamla.ertesites'],
        'adoalany' => ['dontes' => 'nav.adoalany.hatarozat', 'fizetesi' => 'nav.felszolitas.hianypotlas', 'felhivas' => 'nav.felszolitas.hianypotlas', '*' => 'nav.adoalany.ertesites'],
        'bevallas' => ['dontes' => 'altalanos.hatarozat_vegzes', 'fizetesi' => 'nav.bevallas.felszolitas', 'felhivas' => 'nav.bevallas.felszolitas', 'intezkedes' => 'nav.bevallas.intezkedes', '*' => 'nav.bevallas.tajekoztatas'],
        'igazolas' => ['dontes' => 'nav.igazolas.hatarozat_vegzes', 'felhivas' => 'nav.felszolitas.hianypotlas', '*' => 'nav.igazolas.kiadott'],
    ];

    /** Nem NAV feladók: a feladó nevéből felismert szervezetcsalád gyűjtőtípusa. */
    private const SENDER_FAMILIES = [
        'birosag.irat' => 'torvenyszek|birosag|ugyeszseg|kozjegyzo|vegrehajto',
        'onk.irat.egyeb' => 'polgarmesteri hivatal|onkormanyzat',
        'hatosag.kormanyhivatal' => 'kormanyhivatal',
        'hatosag.mak_tamogatas' => 'allamkincstar',
        'hatosag.neak' => 'egeszsegbiztositasi',
        'kozmu.egyeb' => ' mvm |elmu|vizmuvek|csatornazasi|aramszolgaltat|gazszolgaltat|energiakeresked',
        'hatosag.egyeb' => 'iparkamara|agrargazdasagi kamara|statisztikai hivatal| ksh |hirkozlesi hatosag| nmhh | sztnh |szellemi tulajdon| nebih |elelmiszerlanc|valasztasi iroda|rendor|idegenrendeszet',
    ];

    /** Az irat fajtája a tárgy (és a tárhely típusneve) szavaiból; a szigorúbb fajta áll elöl. */
    private static function kind(string $hay): ?string
    {
        $has = fn (string $alt) => (bool) preg_match('/' . $alt . '/', $hay);
        return match (true) {
            $has(' hatarozat| vegzes|birsag|meghagyas| hat |koltsegatalany|koltsegminimum|felosztasi terv') => 'dontes',
            $has('fizetesi felhiv|fizetesi felszolit') => 'fizetesi',
            $has('felszolit|felhivas|hianypotl') => 'felhivas',
            $has('jegyzokonyv') => 'jegyzokonyv',
            $has('intezkedes') => 'intezkedes',
            $has('ertesit|tajekoztat|igazolas|visszaigazol') => 'info',
            default => null,
        };
    }

    /**
     * Okos besorolás, ha egyetlen minta sem illik: a feladó, a tárhely típusneve (ügycsoport) és a tárgy fajtát jelölő szava
     * (határozat, felszólítás, értesítés…) együtt adja a típust. A döntés jellegű iratok mindig szigorú („csak lista”) típusba
     * kerülnek, a tévedés így a „nem töltjük le” irányba esik. Ha a feladó sem ismerhető fel, marad az ismeretlen típus.
     */
    private static function infer(string $hay): ?object
    {
        $has = fn (string $alt) => (bool) preg_match('/' . $alt . '/', $hay);
        $kind = self::kind($hay); $pick = null;
        if ($has('nemzeti ado es vamhivatal| nav ')) {
            $group = null;
            foreach (self::NAV_GROUPS as $g => $alt) if ($has($alt)) { $group = $g; break; }
            if ($group === 'ellenorzes' && $kind === 'dontes' && $has('megszunteto vegzes|hatarido hosszabbit|hatarido meghosszab')) {
                $pick = 'nav.ellenorzes.eljarasi_vegzes';
            } elseif ($group) $pick = self::NAV_MATRIX[$group][$kind ?? '*'] ?? self::NAV_MATRIX[$group]['*'];
            else $pick = match ($kind) {
                'dontes' => 'altalanos.hatarozat_vegzes',
                'fizetesi', 'felhivas' => 'nav.felszolitas.hianypotlas',
                'intezkedes', 'info' => 'nav.tajekoztatas.altalanos',
                // Csak egy azonosító áll a tárgyban (pl. „Nyu6207…”): feloldatlan kódú küldemény.
                // Ha semmilyen jel nincs (se ügycsoport, se fajta), az irat ismeretlen marad, és embernek kell megnéznie.
                default => $has(' [a-z]{0,6}[0-9]{12,} ') ? 'nav.azonositatlan_kod' : null,
            };
        } else {
            foreach (self::SENDER_FAMILIES as $type => $alt) if ($has($alt)) { $pick = $type; break; }
            if ($pick && $kind === 'dontes') $pick = 'altalanos.hatarozat_vegzes';
            elseif ($pick && $kind === 'fizetesi' && $pick !== 'birosag.irat') $pick = 'kulso.fizetesi_felszolitas';
        }
        if (!$pick) return null;
        foreach (self::$cache as $t) if ($t->type_id === $pick) return $t;
        return null;
    }
    public static function flush(): void { self::$cache = null; }
}
