<?php

namespace App\Iratkapu;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use ZipArchive;

/**
 * „Dokumentumaim exportálása”: a felhasználó által látható összes letöltött hivatalos dokumentum
 * és az `iratok.csv` jegyzék egyetlen hordozható ZIP csomagba gyűjtése.
 *
 * A próbaidőszak vagy az előfizetés lejárta után is korlátozás nélkül elérhető,
 * hogy a könyvelő soha ne veszítse el a hozzáférést a már letöltött dokumentumaihoz.
 */
class DocumentArchiveExport
{
    public static function download(object $user): BinaryFileResponse
    {
        $office = DB::table('offices')->find($user->office_id);
        $cids = Scope::clientIds($user);
        $clients = DB::table('clients')->whereIn('id', $cids)->pluck('name', 'id');
        $initials = DB::table('users')->where('office_id', $user->office_id)->pluck('initials', 'id');

        $messages = DB::table('messages')
            ->where('office_id', $user->office_id)
            ->whereIn('client_id', $cids)
            ->orderByDesc('arrived_at')
            ->orderByDesc('id')
            ->get();

        $msgById = $messages->keyBy('id');
        $mids = $messages->pluck('id')->all();

        $docs = count($mids) > 0
            ? DB::table('documents')
                ->where('office_id', $user->office_id)
                ->whereIn('message_id', $mids)
                ->orderBy('id')
                ->get()
            : collect();

        $aspDocs = DB::table('asp_statements')
            ->where('office_id', $user->office_id)
            ->whereNotNull('pdf_path')
            ->where(function ($q) use ($cids, $user) {
                $q->whereIn('client_id', $cids)
                    ->orWhere(function ($own) use ($user) {
                        $own->whereNull('client_id')->where('user_id', $user->id);
                    });
            })
            ->orderBy('id')
            ->get();

        $tmpDir = storage_path('app/private/tmp');
        if (! is_dir($tmpDir)) {
            @mkdir($tmpDir, 0700, true);
        }
        $tmpZip = $tmpDir.'/kapumail-export-'.$user->id.'-'. bin2hex(random_bytes(6)).'.zip';

        $zip = new ZipArchive;
        abort_if($zip->open($tmpZip, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true, 500, 'Az exportcsomag létrehozása nem sikerült.');

        $csv = "\xEF\xBB\xBFÜgyfél;Feladó;Tárgy;Típus;Érkezett;Hivatalos állapot;Belső állapot;Felelős;Határidő;Határidő bizonyossága\n";
        foreach ($messages as $m) {
            $csv .= implode(';', array_map(
                fn ($v) => '"'.str_replace('"', '""', (string) $v).'"',
                [
                    $clients[$m->client_id] ?? '–',
                    $m->sender,
                    $m->subject,
                    $m->type_label,
                    $m->arrived_at,
                    $m->official,
                    $m->internal,
                    $initials[$m->assignee_id] ?? '',
                    $m->deadline_date,
                    $m->deadline_date ? ($m->deadline_sure ? 'megerősített' : 'becsült') : '',
                ]
            ))."\n";
        }
        $zip->addFromString('iratok.csv', $csv);

        $usedPaths = [];
        $exportedFiles = 0;
        $warnings = [];
        $includedShas = [];

        foreach ($docs as $d) {
            $path = (string) ($d->path ?? '');
            if ($path === '' || ! Storage::disk('local')->exists($path)) {
                $warnings[] = 'Hiányzó fájl a helyi tárban: '.($d->name ?? ('#'.$d->id));

                continue;
            }
            $bytes = Storage::disk('local')->get($path);
            $sha = hash('sha256', $bytes);
            $expectedSha = (string) ($d->sha256 ?? '');
            if ($expectedSha !== '' && $sha !== $expectedSha) {
                $warnings[] = 'SHA-256 eltérés (kihagyva): '.($d->name ?? ('#'.$d->id));

                continue;
            }

            $msg = $msgById[$d->message_id] ?? null;
            $clientName = $msg ? ($clients[$msg->client_id] ?? 'Ismeretlen ugyfel') : 'Egyeb';
            $datePrefix = $msg && ! empty($msg->arrived_at) ? substr((string) $msg->arrived_at, 0, 10) : 'datum-nelkul';
            $folder = self::safeSegment((string) $clientName, 'Ugyfel');
            $baseName = self::safeFileName((string) ($d->name ?? ('dokumentum-'.$d->id)));
            $entryName = self::uniquePath($usedPaths, $folder.'/'.$datePrefix.'_m'.$d->message_id.'_'.$baseName);

            $zip->addFromString($entryName, $bytes);
            $exportedFiles++;
            if ($expectedSha !== '') {
                $includedShas[$expectedSha] = true;
            }
        }

        foreach ($aspDocs as $a) {
            $pdfPath = (string) ($a->pdf_path ?? '');
            $pdfSha = (string) ($a->pdf_sha256 ?? '');
            if ($pdfPath === '' || ($pdfSha !== '' && isset($includedShas[$pdfSha]))) {
                continue;
            }
            if (! Storage::disk('local')->exists($pdfPath)) {
                continue;
            }
            $bytes = Storage::disk('local')->get($pdfPath);
            if ($pdfSha !== '' && hash('sha256', $bytes) !== $pdfSha) {
                $warnings[] = 'SHA-256 eltérés önkormányzati kivonaton (kihagyva): #'.$a->id;

                continue;
            }
            $folder = self::safeSegment(
                ! empty($a->client_id) ? (string) ($clients[$a->client_id] ?? 'Ugyfel') : 'Sajat adatom',
                'Sajat adatom'
            );
            $city = self::safeSegment((string) (($a->tenant_city ?? null) ?: ($a->tenant_name ?? null) ?: 'onkormanyzat'), 'onkormanyzat');
            $year = (int) ($a->year ?? 0) ?: now()->year;
            $entryName = self::uniquePath($usedPaths, "{$folder}/ASP_{$year}_{$city}_adoszamla.pdf");
            $zip->addFromString($entryName, $bytes);
            $exportedFiles++;
        }

        $readme = [
            'KapuMail – Dokumentumexport',
            '===========================',
            'Iroda: '.(($office->name ?? null) ?: 'KapuMail'),
            'Exportálta: '.(($user->name ?? null) ?: 'Felhasználó'),
            'Időpont: '.now()->format('Y-m-d H:i:s'),
            'Iratlista sorok (iratok.csv): '.count($messages),
            'Exportált dokumentumfájlok száma: '.$exportedFiles,
            '',
            'Minden exportált fájl SHA-256 lenyomata ellenőrizve lett a helyi tároló alapján.',
        ];
        if (count($warnings) > 0) {
            $readme[] = '';
            $readme[] = 'Figyelmeztetések:';
            foreach ($warnings as $w) {
                $readme[] = ' - '.$w;
            }
        }
        $zip->addFromString('OLVASS_EL.txt', implode("\r\n", $readme)."\r\n");
        $zip->close();

        Audit::log((int) $user->office_id, $user, "Dokumentumok teljes exportálása ({$exportedFiles} fájl, ".count($messages).' iratsor)', [
            'evidence' => 'ZIP + iratok.csv',
        ]);

        $dlName = 'kapumail-dokumentumok-'.now()->format('Y-m-d').'.zip';

        return response()->download($tmpZip, $dlName, [
            'Content-Type' => 'application/zip',
            'X-Content-Type-Options' => 'nosniff',
        ])->deleteFileAfterSend(true);
    }

    private static function safeSegment(string $raw, string $fallback): string
    {
        $clean = trim((string) preg_replace('/[\\\\\/:\*\?"<>\|]+/u', '-', $raw), " .\t\n\r\0\x0B-");
        $clean = preg_replace('/\s+/u', ' ', (string) $clean);
        if ($clean === '' || $clean === '.' || $clean === '..') {
            return $fallback;
        }

        return mb_substr($clean, 0, 80);
    }

    private static function safeFileName(string $raw): string
    {
        $base = basename(str_replace('\\', '/', $raw));
        $clean = trim((string) preg_replace('/[\\\\\/:\*\?"<>\|]+/u', '_', $base), " .\t\n\r\0\x0B");
        if ($clean === '' || $clean === '.' || $clean === '..') {
            return 'dokumentum.bin';
        }

        return mb_substr($clean, 0, 140);
    }

    private static function uniquePath(array &$used, string $candidate): string
    {
        $key = Str::lower($candidate);
        if (! isset($used[$key])) {
            $used[$key] = true;

            return $candidate;
        }
        $dot = strrpos($candidate, '.');
        $slash = strrpos($candidate, '/');
        $hasExt = $dot !== false && ($slash === false || $dot > $slash + 1);
        $stem = $hasExt ? substr($candidate, 0, $dot) : $candidate;
        $ext = $hasExt ? substr($candidate, $dot) : '';
        $i = 2;
        while (true) {
            $try = "{$stem} ({$i}){$ext}";
            $tryKey = Str::lower($try);
            if (! isset($used[$tryKey])) {
                $used[$tryKey] = true;

                return $try;
            }
            $i++;
        }
    }
}
