<?php

namespace App\Mcp\Tools;

use App\Iratkapu\Audit;
use App\Iratkapu\Scope;
use App\Mcp\McpData;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class IratTeendokElemzese extends IratkapuTool
{
    protected string $name = 'irat_teendok_elemzese';

    protected string $description = 'Egy irat és mellékletei szövegének 100%-ban helyi könyvelői és adójogi elemzése: határidők, eljárási szakasz, kötelezettségek, teendők, jogorvoslati lehetőségek és kapcsolódó jogszabályok külső hálózati hívás nélkül.';

    protected string $level = 'olvasas';

    protected bool $audit = true;

    public function schema(JsonSchema $schema): array
    {
        return [
            'message_id' => $schema->integer()->description('Az irat azonosítója (kötelező).')->required(),
            'document_id' => $schema->integer()->description('Opcionális: egy konkrét dokumentum azonosítója. Ha nincs megadva, az irat összes csatolt dokumentumát elemzi.'),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $messageId = (int) $request->get('message_id');
        $m = Scope::message($user, $messageId);

        $docId = $request->get('document_id') ? (int) $request->get('document_id') : null;
        $docs = collect();
        $combinedText = '';

        if ($docId) {
            $d = McpData::document($user, $docId);
            if ((int) ($d->message_id ?? 0) !== (int) $m->id) {
                abort(404, 'A megadott dokumentum nem ehhez az irathoz tartozik.');
            }
            $ext = McpData::documentText($d);
            $combinedText = $ext['text'] ?? '';
            $docs->push($d);
        } else {
            $docs = DB::table('documents')
                ->where('office_id', $user->office_id)
                ->where('message_id', $m->id)
                ->orderBy('id')
                ->get();

            $parts = [];
            foreach ($docs as $doc) {
                $ext = McpData::documentText($doc);
                $txt = trim($ext['text'] ?? '');
                if ($txt !== '') {
                    $parts[] = "=== {$doc->name} ===\n".$txt;
                }
            }
            $combinedText = implode("\n\n", $parts);
        }

        $analysisText = trim(($m->subject ?? '')."\n".($m->deadline_excerpt ?? '')."\n".$combinedText);

        $irattipus = $this->detectDocumentType($m, $analysisText);
        $eljarasiSzakasz = $this->detectProceduralStage($analysisText);
        $hataridok = $this->extractDeadlines($m, $analysisText);
        $jogorvoslat = $this->extractRemedies($analysisText);
        $jogszabalyok = $this->extractStatutes($analysisText);
        $osszegek = $this->extractAmounts($analysisText);
        $teendok = $this->compileTasks($m, $irattipus, $hataridok, $jogorvoslat, $osszegek);

        Audit::log(
            $user->office_id,
            $user,
            "MCP: irat teendőinek helyi elemzése (id: {$m->id}, tárgy: {$m->subject})",
            ['message_id' => $m->id, 'client_id' => ($m->client_id ?? null)]
        );

        return [
            'success' => true,
            'message_id' => (int) $m->id,
            'subject' => ($m->subject ?? null),
            'irattipus' => $irattipus,
            'eljarasi_szakasz' => $eljarasiSzakasz,
            'hataridok' => $hataridok,
            'teendok' => $teendok,
            'jogorvoslat' => $jogorvoslat,
            'kapcsolodo_jogszabalyok' => $jogszabalyok,
            'osszegek' => $osszegek,
            'dokumentumok_szama' => $docs->count(),
            'helyi_elemzes' => true,
        ];
    }

    private function detectDocumentType(object $m, string $text): string
    {
        $subject = mb_strtolower($m->subject ?? '');
        $lower = mb_strtolower($text);

        if (preg_match('/(?:fizetési\s+felszólítás|felszólítás\s+fizetésre|végrehajtói\s+felhívás|tartozás\s+megfizetésére)/iu', $subject) ||
            preg_match('/(?:fizetési\s+felszólítás|felszólítás\s+fizetésre|végrehajtói\s+felhívás)\b/iu', $lower)) {
            return 'fizetesi_felszolitas';
        }
        if (preg_match('/határozat\b/iu', $subject) || preg_match('/\b(?:határozat|adómegállapítás)\b/iu', $lower)) {
            return 'hatarozat';
        }
        if (preg_match('/végzés\b/iu', $subject) || preg_match('/\bvégzés\b/iu', $lower)) {
            return 'vegzes';
        }
        if (preg_match('/jegyzőkönyv\b/iu', $subject) || preg_match('/\bjegyzőkönyv\b/iu', $lower)) {
            return 'jegyzokonyv';
        }
        if (preg_match('/(?:megkeresés|adatkérés|felhívás)/iu', $subject) || preg_match('/\b(?:megkeresés|adatkérés|felhívás\s+nyilatkozattételre)\b/iu', $lower)) {
            return 'megkereses';
        }
        if (preg_match('/(?:igazolás|hatósági\s+bizonyítvány)/iu', $subject) || preg_match('/\b(?:nullás\s+igazolás|adóigazolás|hatósági\s+bizonyítvány)\b/iu', $lower)) {
            return 'igazolas';
        }
        if (preg_match('/(?:tájékoztatás|értesítés|kivonat)/iu', $subject) || preg_match('/\b(?:tájékoztatás|folyószámla-kivonat|értesítés)\b/iu', $lower)) {
            return 'tajekoztatas';
        }

        return 'egyeb_irat';
    }

    private function detectProceduralStage(string $text): string
    {
        if (preg_match('/(?:végrehajtás|inkasszó|hatósági\s+átutalási\s+megbízás|letiltás|lefoglalás)\b/iu', $text)) {
            return 'vegrehajtasi_szakasz';
        }
        if (preg_match('/(?:másodfokú\s+határozat|fellebbezés\s+(?:elbírálása|tárgyában)|felülvizsgálati\s+kérelem|felügyeleti\s+intézkedés)\b/iu', $text)) {
            return 'jogorvoslati_szakasz';
        }
        if (preg_match('/(?:adóellenőrzés|jogkövetési\s+vizsgálat|ellenőrzés\s+megindítása|megállapítások\s+jegyzőkönyve)\b/iu', $text)) {
            return 'ellenorzesi_szakasz';
        }
        if (preg_match('/(?:határozat|végzés|érdemi\s+döntés)\b/iu', $text)) {
            return 'elsofoku_eljaras';
        }

        return 'elsofoku_eljaras';
    }

    private function extractDeadlines(object $m, string $text): array
    {
        $deadlines = [];

        // Rögzített határidő az irat rekordból
        $recDate = ($m->deadline_date ?? null) ?: ($m->deadline_at ?? null);
        if (! empty($recDate)) {
            $deadlines[] = [
                'tipus' => 'rogzitett_hatarido',
                'datum' => substr((string) $recDate, 0, 10),
                'forras' => ($m->deadline_source ?? 'adatbazis'),
                'leiras' => ($m->deadline_excerpt ?? 'Rögzített határidő'),
            ];
        }

        // Relatív határidők szövegben (pl. "15 napon belül", "8 nap")
        if (preg_match_all('/\b(\d+)\s*nap(?:on\s+belül)?\b/iu', $text, $matches, PREG_OFFSET_CAPTURE)) {
            foreach ($matches[1] as $idx => $match) {
                $days = (int) $match[0];
                $offset = $match[1];
                $charOffset = mb_strlen(substr($text, 0, $offset), 'UTF-8');
                $context = mb_substr($text, max(0, $charOffset - 60), 120, 'UTF-8');

                $tipus = 'egyeb_hatarido';
                if (preg_match('/(?:fellebbez|jogorvoslat)/iu', $context)) {
                    $tipus = 'fellebbezesi_hatarido';
                } elseif (preg_match('/(?:fizet|teljesít|átutal)/iu', $context)) {
                    $tipus = 'fizetesi_hatarido';
                } elseif (preg_match('/(?:hiánypótl)/iu', $context)) {
                    $tipus = 'hianypotlasi_hatarido';
                } elseif (preg_match('/(?:észrevétel)/iu', $context)) {
                    $tipus = 'eszreveteli_hatarido';
                }

                $becsultDatum = null;
                if (! empty($m->arrived_at)) {
                    try {
                        $becsultDatum = Carbon::parse($m->arrived_at)->addDays($days)->format('Y-m-d');
                    } catch (\Throwable) {
                        // ignore parsing error
                    }
                }

                $deadlines[] = [
                    'tipus' => $tipus,
                    'napok_szama' => $days,
                    'becsult_datum' => $becsultDatum,
                    'szovegkornyezet' => trim($context),
                ];
            }
        }

        // Naptári dátumok szövegben
        if (preg_match_all('/\b(20\d{2})[.\-\/]\s*(0?[1-9]|1[0-2])[.\-\/]\s*(0?[1-9]|[12]\d|3[01])\.?\b/u', $text, $dateMatches, PREG_OFFSET_CAPTURE)) {
            foreach ($dateMatches[0] as $dm) {
                $raw = $dm[0];
                $offset = $dm[1];
                $charOffset = mb_strlen(substr($text, 0, $offset), 'UTF-8');
                $ctx = mb_substr($text, max(0, $charOffset - 40), 100, 'UTF-8');
                if (preg_match('/(?:határidő|esedék|legkésőbb|napjáig|teljesítés)/iu', $ctx)) {
                    $cleanDate = preg_replace('/[.\-\/]\s*/', '-', rtrim($raw, '.'));
                    $deadlines[] = [
                        'tipus' => 'naptari_hatarido',
                        'datum' => $cleanDate,
                        'szovegkornyezet' => trim($ctx),
                    ];
                }
            }
        }

        return $deadlines;
    }

    private function extractRemedies(string $text): array
    {
        // 1. Kifejezett pozitív fellebbezési / jogorvoslati jog keresése
        // Elsőbbséget élvez: összetett határozatokban az érdemi döntés fellebbezhető,
        // még ha egy járulékos végzési záradék szerint önálló fellebbezésnek nincs is helye.
        $hasAffirmative = (bool) preg_match('/(?:fellebbezésnek\s+(?:van\s+helye|helye\s+van)|fellebbezhető|fellebbez(?:és|éssel|ést)\s+(?:terjeszthető|nyújtható|lehet\s+élni|élhet|adható|\w+\s+elő|\w+\s+be)|(?:\d+)\s*nap(?:on\s+belül)?\s+(?:[a-záéíóöőúüű]+\s+){0,4}fellebbez|jogorvoslattal\s+(?:élhet|lehet\s+élni)|fellebbezési\s+(?:határidő|jog)|bírósági\s+felülvizsgálat(?:a\s+kérhető)?)/iu', $text);

        if ($hasAffirmative) {
            $days = 15;
            if (preg_match('/(\d+)\s*nap(?:on\s+belül)?\s+lehet\s+fellebbez/iu', $text, $m)) {
                $days = (int) $m[1];
            } elseif (preg_match('/fellebbez(?:és|éssel|hető|ést).*?(\d+)\s*nap/iu', $text, $m)) {
                $days = (int) $m[1];
            } elseif (preg_match('/(\d+)\s*nap(?:on\s+belül)?/iu', $text, $m)) {
                $days = (int) $m[1];
            }

            $forum = 'Felettes hatóság / Bíróság';
            if (preg_match('/(?:NAV\s+Fellebbviteli\s+Igazgatóság(?:ához|a)?|Fővárosi\s+Törvényszék)/iu', $text, $fm)) {
                $forum = $fm[0];
            }

            return [
                'van_helye' => true,
                'jogorvoslat_tipusa' => 'fellebbezes',
                'hatarido_nap' => $days,
                'forum' => $forum,
                'leiras' => "A döntés ellen {$days} napon belül fellebbezés terjeszthető elő.",
            ];
        }

        // 2. Ha nincs pozitív fellebbezési jog, de kizáró nyilatkozat szerepel
        if (preg_match('/(?:fellebbezésnek\s+helye\s+nincs|önálló\s+jogorvoslatnak\s+helye\s+nincs|önálló\s+fellebbezésnek\s+helye\s+nincs)/iu', $text)) {
            return [
                'van_helye' => false,
                'jogorvoslat_tipusa' => 'nincs_onallo_fellebbezes',
                'leiras' => 'A döntés ellen önálló fellebbezésnek helye nincs (a döntés csak az érdemi határozat elleni jogorvoslatban támadható meg).',
            ];
        }

        return [
            'van_helye' => false,
            'jogorvoslat_tipusa' => 'nem_relevans',
            'leiras' => 'Az irat nem tartalmaz jogorvoslati vagy fellebbezési záradékot.',
        ];
    }

    private function extractStatutes(string $text): array
    {
        $statutes = [];

        $abbrevs = [
            'Art.' => '2017. évi CL. törvény az adózás rendjéről (Art.)',
            'Air.' => '2017. évi CLI. törvény az adóigazgatási rendtartásról (Air.)',
            'Ákr.' => '2016. évi CL. törvény az általános közigazgatási rendtartásról (Ákr.)',
            'Áfa tv.' => '2007. évi CXXVII. törvény az általános forgalmi adóról (Áfa tv.)',
            'Szja tv.' => '1995. évi CXVII. törvény a személyi jövedelemadóról (Szja tv.)',
            'Tao tv.' => '1996. évi LXXXI. törvény a társasági adóról (Tao tv.)',
            'Vht.' => '1994. évi LIII. törvény a bírósági végrehajtásról (Vht.)',
            'Számv. tv.' => '2000. évi C. törvény a számvitelről (Számv. tv.)',
        ];

        foreach ($abbrevs as $abbr => $desc) {
            if (preg_match_all('/'.preg_quote($abbr, '/').'\s*(\d+\.?\s*(?:§|\(\d+\)\s*bekezdés)?)/iu', $text, $m)) {
                foreach ($m[0] as $hit) {
                    $statutes[] = [
                        'torveny' => $abbr,
                        'hivatkozas' => trim($hit),
                        'megnevezes' => $desc,
                    ];
                }
            } elseif (stripos($text, $abbr) !== false) {
                $statutes[] = [
                    'torveny' => $abbr,
                    'hivatkozas' => $abbr,
                    'megnevezes' => $desc,
                ];
            }
        }

        // Általános törvényi hivatkozások: pl. 2017. évi CL. törvény
        if (preg_match_all('/\b(20\d{2}\.\s*évi\s+[A-ZLCDMVX]+\.\s*törvény(?:\s*\d+\.?\s*§)?)\b/u', $text, $genMatches)) {
            foreach ($genMatches[1] as $gm) {
                $statutes[] = [
                    'torveny' => trim($gm),
                    'hivatkozas' => trim($gm),
                    'megnevezes' => trim($gm),
                ];
            }
        }

        return $statutes;
    }

    private function extractAmounts(string $text): array
    {
        $amounts = [];
        if (preg_match_all('/\b(\d{1,3}(?:[ .]\d{3})+|\d+)\s*(?:Ft|forint)\b/iu', $text, $matches, PREG_OFFSET_CAPTURE)) {
            foreach ($matches[1] as $idx => $m) {
                $raw = $m[0];
                $val = (int) preg_replace('/[ .]/', '', $raw);
                if ($val > 0) {
                    $fullMatchStr = $matches[0][$idx][0];
                    $fullMatchOffset = $matches[0][$idx][1];
                    $charOffset = mb_strlen(substr($text, 0, $fullMatchOffset), 'UTF-8');
                    $matchCharLen = mb_strlen($fullMatchStr, 'UTF-8');
                    $beforeStartChar = max(0, $charOffset - 50);
                    $beforeCtx = mb_substr($text, $beforeStartChar, $charOffset - $beforeStartChar, 'UTF-8');
                    $afterCtx = mb_substr($text, $charOffset + $matchCharLen, 50, 'UTF-8');

                    $cimke = 'egyeb_osszeg';
                    if (preg_match('/adóbírság/iu', $afterCtx)) {
                        $cimke = 'adobirsag';
                    } elseif (preg_match('/késedelmi\s+pótlék/iu', $afterCtx)) {
                        $cimke = 'kesedelmi_potlek';
                    } elseif (preg_match('/mulasztási\s+bírság/iu', $afterCtx)) {
                        $cimke = 'mulasztasi_birsag';
                    } elseif (preg_match('/adóhiány/iu', $afterCtx)) {
                        $cimke = 'adohiany';
                    } elseif (preg_match('/(?:fizetendő|tartozás)/iu', $afterCtx)) {
                        $cimke = 'fizetendo_tartozas';
                    } elseif (preg_match('/adóbírság/iu', $beforeCtx)) {
                        $cimke = 'adobirsag';
                    } elseif (preg_match('/késedelmi\s+pótlék/iu', $beforeCtx)) {
                        $cimke = 'kesedelmi_potlek';
                    } elseif (preg_match('/mulasztási\s+bírság/iu', $beforeCtx)) {
                        $cimke = 'mulasztasi_birsag';
                    } elseif (preg_match('/adóhiány/iu', $beforeCtx)) {
                        $cimke = 'adohiany';
                    } elseif (preg_match('/(?:fizetendő|tartozás)/iu', $beforeCtx)) {
                        $cimke = 'fizetendo_tartozas';
                    }

                    $amounts[] = [
                        'osszeg_ft' => $val,
                        'cimke' => $cimke,
                        'szovegkornyezet' => trim($beforeCtx.' '.$fullMatchStr.' '.$afterCtx),
                    ];
                }
            }
        }

        return $amounts;
    }

    private function compileTasks(object $m, string $irattipus, array $hataridok, array $jogorvoslat, array $osszegek): array
    {
        $tasks = [];

        // Meglévő feladatok az adatbázisból
        $existing = DB::table('tasks')->where('message_id', $m->id)->orderBy('id')->get();
        foreach ($existing as $t) {
            $tasks[] = [
                'forras' => 'adatbazis',
                'id' => (int) $t->id,
                'feladat' => ($t->title ?? ''),
                'kesz' => (bool) ($t->done ?? false),
            ];
        }

        // Javasolt szakmai teendők
        if (! empty($osszegek)) {
            $tasks[] = [
                'forras' => 'javasolt',
                'feladat' => 'Fizetési kötelezettség és folyószámla egyeztetése az ügyféllel',
                'prioritas' => 'magas',
            ];
        }

        if (! empty($hataridok)) {
            $tasks[] = [
                'forras' => 'javasolt',
                'feladat' => 'Határidő rögzítése a naptárban és ellenőrzése',
                'prioritas' => 'magas',
            ];
        }

        if (($jogorvoslat['van_helye'] ?? false)) {
            $tasks[] = [
                'forras' => 'javasolt',
                'feladat' => 'Jogorvoslati lehetőség (fellebbezés / észrevétel) megfontolása a jogorvoslati határidőn belül',
                'prioritas' => 'kozepes',
            ];
        }

        if ($irattipus === 'megkereses' || $irattipus === 'jegyzokonyv') {
            $tasks[] = [
                'forras' => 'javasolt',
                'feladat' => 'Kért iratok, számlák és analitikák összeállítása a hatósági megkeresésre',
                'prioritas' => 'magas',
            ];
        }

        $tasks[] = [
            'forras' => 'javasolt',
            'feladat' => 'Ügyfél tájékoztatása az irat érkezéséről és a határidőkről',
            'prioritas' => 'normal',
        ];

        return $tasks;
    }
}
