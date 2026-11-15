<?php
namespace App\Iratkapu;

/**
 * ES3 (Microsec e-akta) olvasó váz a nyilvános specifikáció alapján (research/R04).
 * CSAK kibont. Hitelességet NEM vizsgál: az eredmény soha nem „érvényes”.
 * Valódi hatósági mintán nincs kipróbálva (BLOKKOLT: M2).
 */
class Es3Exception extends \RuntimeException {}

class Es3Reader
{
    const NS = 'https://www.microsec.hu/ds/e-szigno30#';
    // Az e-akta ugyanazzal a szerkezettel több névtérben is előfordul (valódi cégbírósági mintán igazolva):
    // az elemeket ezért helyi név szerint azonosítjuk, de csak ismert e-akta névtérben.
    const DOSSIER_NS = ['https://www.microsec.hu/ds/e-szigno30#', 'http://www.e-cegjegyzek.hu/2021/e-cegeljaras#'];
    public static function isDossierNs(string $ns): bool { return in_array($ns, self::DOSSIER_NS, true) || (bool) preg_match('~^https?://(www\.)?(e-cegjegyzek\.hu|microsec\.hu|e-szigno\.hu)/~', $ns); }
    const DS = 'http://www.w3.org/2000/09/xmldsig#';

    public function read(string $bytes, int $depth = 1): array
    {
        $lim = config('iratkapu.es3');
        if (trim($bytes) === '') throw new Es3Exception('Üres fájl.');
        if (strlen($bytes) > $lim['max_file']) throw new Es3Exception('A fájl nagyobb a megengedettnél.');
        if ($depth > $lim['max_depth']) throw new Es3Exception('Túl mélyen egymásba ágyazott akta.');
        // DTD/entitás tiltása: DOCTYPE-ot tartalmazó fájlt egyáltalán nem dolgozunk fel (XXE, entitásbomba).
        if (preg_match('/<!DOCTYPE|<!ENTITY/i', $bytes)) throw new Es3Exception('A fájl DOCTYPE vagy ENTITY deklarációt tartalmaz; biztonsági okból elutasítva.');
        $r = new \XMLReader();
        $prev = libxml_use_internal_errors(true);
        try {
            if (!$r->XML($bytes, null, LIBXML_NONET | LIBXML_PARSEHUGE)) throw new Es3Exception('Nem értelmezhető XML.');
            $out = ['title' => null, 'documents' => [], 'signatures' => 0, 'timestamps' => 0, 'nested' => []];
            $doc = null; $total = 0; $rootSeen = false; $inDossierProfile = false; $inDocProfile = false; $dns = self::NS;
            while (@$r->read()) {
                if ($r->nodeType === \XMLReader::DOC_TYPE) throw new Es3Exception('DOCTYPE nem megengedett.');
                if ($r->nodeType === \XMLReader::END_ELEMENT) {
                    if ($r->namespaceURI === $dns && $r->localName === 'Document' && $doc) {
                        $out['documents'][] = $doc; $doc = null;
                    }
                    if ($r->namespaceURI === $dns && $r->localName === 'DossierProfile') $inDossierProfile = false;
                    if ($r->namespaceURI === $dns && $r->localName === 'DocumentProfile') $inDocProfile = false;
                    continue;
                }
                if ($r->nodeType !== \XMLReader::ELEMENT) continue;
                if (!$rootSeen) {
                    if ($r->localName !== 'Dossier' || !self::isDossierNs($r->namespaceURI)) throw new Es3Exception('Nem e-akta: a gyökérelem nem ismert névtérbeli Dossier.');
                    $rootSeen = true; $dns = $r->namespaceURI; $out['namespace'] = $dns; continue;
                }
                $ns = $r->namespaceURI; $n = $r->localName;
                if ($ns === $dns && $n === 'DossierProfile') $inDossierProfile = true;
                elseif ($ns === $dns && $n === 'DocumentProfile') $inDocProfile = true;
                elseif ($ns === $dns && $n === 'MIME-Type' && $doc && $inDocProfile) { $doc['ext'] = preg_replace('/[^a-z0-9]/', '', strtolower((string) $r->getAttribute('extension'))); }
                elseif ($ns === $dns && $n === 'Document') {
                    if (count($out['documents']) >= $lim['max_docs']) throw new Es3Exception('Túl sok dokumentum az aktában.');
                    $doc = ['name' => null, 'ext' => null, 'transforms' => [], 'bytes' => null, 'signed' => false, 'error' => null];
                } elseif ($ns === $dns && $n === 'Title') {
                    $t = trim($r->readString());
                    if ($doc && $inDocProfile && $doc['name'] === null) $doc['name'] = $t; elseif ($inDossierProfile && !$doc) $out['title'] = $t;
                } elseif ($ns === $dns && $n === 'Transform' && $doc && $inDocProfile) {
                    $doc['transforms'][] = strtolower((string) $r->getAttribute('Algorithm'));
                } elseif ($ns === self::DS && $n === 'Object' && $doc && $doc['bytes'] === null) {
                    $b64 = $r->readString();
                    if (strlen($b64) * 0.75 + $total > $lim['max_decoded']) throw new Es3Exception('A kibontott tartalom meghaladja a korlátot.');
                    if (array_filter($doc['transforms'], fn ($t) => str_contains($t, 'encrypt'))) { $doc['error'] = 'Titkosított dokumentum – nem bontható ki.'; $doc['bytes'] = ''; }
                    else {
                        $raw = base64_decode(preg_replace('/\s+/', '', $b64), true);
                        if ($raw === false) throw new Es3Exception('Hibás base64 tartalom.');
                        if (array_filter($doc['transforms'], fn ($t) => str_contains($t, 'zip'))) {
                            $inf = @gzinflate($raw, $lim['max_decoded']) ?: @gzuncompress($raw, $lim['max_decoded']);
                            if ($inf === false) { $doc['error'] = 'Tömörített dokumentum – ez a tömörítés még nem támogatott.'; $raw = ''; } else $raw = $inf;
                        }
                        $total += strlen($raw); $doc['bytes'] = $raw;
                    }
                } elseif ($ns === self::DS && $n === 'Signature') { $out['signatures']++; if ($doc) $doc['signed'] = true; }
                elseif (in_array($n, ['TimeStamp', 'SignatureTimeStamp', 'ArchiveTimeStamp', 'EncapsulatedTimeStamp'], true) && $n !== 'TimeStamp' ? $n === 'EncapsulatedTimeStamp' : ($ns === $dns && $n === 'TimeStamp')) $out['timestamps']++;
            }
            if (libxml_get_last_error() && !$rootSeen) throw new Es3Exception('Nem értelmezhető XML.');
            if ($err = libxml_get_last_error()) throw new Es3Exception('Sérült XML: ' . trim($err->message));
            if (!$rootSeen) throw new Es3Exception('Üres vagy nem e-akta fájl.');
        } finally { $r->close(); libxml_clear_errors(); libxml_use_internal_errors($prev); }

        $fi = new \finfo(FILEINFO_MIME_TYPE);
        foreach ($out['documents'] as $i => &$d) {
            $nm = $d['name'] ?: 'dokumentum-' . ($i + 1);
            if (!empty($d['ext']) && !str_ends_with(strtolower($nm), '.' . $d['ext'])) $nm .= '.' . $d['ext'];
            $d['name'] = self::safeName($nm);
            $d['mime'] = $d['bytes'] !== '' && $d['bytes'] !== null ? $fi->buffer($d['bytes']) : null;
            $d['sha256'] = hash('sha256', (string) $d['bytes']); $d['size'] = strlen((string) $d['bytes']);
            if (str_ends_with(strtolower($d['name']), '.es3') && $d['bytes']) $d['nested'] = $this->read($d['bytes'], $depth + 1);
        }
        return $out;
    }

    /** Az aktabeli név soha nem válik útvonallá: csak megjelenítésre szolgál, normalizálva. */
    public static function safeName(string $n): string
    {
        $n = basename(str_replace('\\', '/', $n));
        $n = preg_replace('/[\x00-\x1f<>:"|?*]+/u', '_', $n);
        $n = ltrim($n, '.');
        return mb_substr($n === '' ? 'dokumentum' : $n, 0, 120);
    }
}
