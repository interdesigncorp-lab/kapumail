<?php

namespace App\Mcp;

use App\Iratkapu\FormCatalog;
use App\Iratkapu\Scope;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\Process\ExecutableFinder;

/**
 * Az MCP-eszközök közös adatformái. Minden lekérdezés a `Scope`-on megy át: a kapcsolat gazdája
 * csak azt kapja meg, amit a felületen is látna.
 */
class McpData
{
    public const STATUS = ['uj' => 'új', 'oszt' => 'osztályozandó', 'kiosztott' => 'kiosztva', 'folyamatban' => 'folyamatban', 'ell' => 'ellenőrzésre vár', 'kesz' => 'kész'];

    public const OFFICIAL = ['wait' => 'átvételre vár', 'ok' => 'átvett', 'fic' => 'kézbesítési vélelem', 'na' => 'nem átvételköteles', 'listed' => 'élő tárhelyen, letölthető', 'failed' => 'meghiúsult'];

    public const OBLIGATION_STATUS = ['submittable' => 'beadható', 'submitted' => 'beadva', 'conditional' => 'feltételes', 'missing' => 'hiányzó', 'rejected' => 'hibás / elutasított'];

    /** @return array<int, string> */
    public static function initials(int $officeId): array
    {
        return DB::table('users')->where('office_id', $officeId)->pluck('initials', 'id')->all();
    }

    /** @return array<string, mixed> */
    public static function client(object $c): array
    {
        return ['id' => (int) $c->id, 'name' => $c->name, 'tax' => $c->tax, 'active' => (bool) $c->active,
            'authorization_until' => $c->auth_until, 'authorization_basis' => $c->auth_basis,
            'kind' => $c->discovered_via === 'own' ? 'saját tárhely gyűjtője' : 'ügyfél'];
    }

    /** @return array<string, mixed> */
    public static function obligation(object $o): array
    {
        $st = (string) ($o->status ?? 'submittable');

        return ['id' => (int) $o->id, 'form_code' => $o->form_code ?? null, 'title' => $o->title ?? null,
            'due_date' => ! empty($o->due_date) ? substr((string) $o->due_date, 0, 10) : null,
            'period_start' => $o->period_start ?? null, 'period_end' => $o->period_end ?? null,
            'conditional' => ! empty($o->conditional), 'status' => $st, 'status_label' => self::OBLIGATION_STATUS[$st] ?? $st,
            'barcode' => $o->barcode ?? null, 'submitted_at' => $o->submitted_at ?? null,
            'receipt_message_id' => ! empty($o->receipt_message_id) ? (int) $o->receipt_message_id : null];
    }

    /**
     * @param  array<int, string>  $ini
     * @param  array<int, string>  $clientNames
     * @return array<string, mixed>
     */
    public static function message(object $m, array $ini, array $clientNames): array
    {
        return ['id' => (int) $m->id, 'client_id' => (int) $m->client_id, 'client' => $clientNames[$m->client_id] ?? null,
            'folder' => $m->folder ?? 'BEERKEZETT',
            'subject' => $m->subject, 'sender' => $m->sender_full ?: $m->sender, 'recipient' => $m->recipient ?? null,
            'type' => $m->type_label, 'arrived_at' => substr((string) $m->arrived_at, 0, 16),
            'official_state' => self::OFFICIAL[$m->official] ?? $m->official, 'internal_state' => self::STATUS[$m->internal] ?? $m->internal,
            'assignee' => $ini[$m->assignee_id] ?? null, 'urgent' => (bool) $m->urgent, 'archived' => (bool) $m->archived,
            'deadline' => $m->deadline_date ? ['date' => substr((string) $m->deadline_date, 0, 10), 'confirmed' => (bool) $m->deadline_sure, 'source' => $m->deadline_source] : null,
            'form_code' => $m->form_code ?? null, 'form_title' => ! empty($m->form_code) ? (FormCatalog::resolveForm($m->form_code)['title'] ?? null) : null, 'barcode' => $m->barcode, 'ref_eid' => $m->ref_eid ?? null,
            'filing_status' => $m->filing_status ?? null, 'filing_receipt_id' => ! empty($m->filing_receipt_id) ? (int) $m->filing_receipt_id : null,
            'es3' => (bool) $m->es3, 'expires_at' => $m->expires_at];
    }

    /** Az irat, ha a felhasználó láthatja; különben 404 (a felülettel azonos szabály). */
    public static function document(object $user, int $id): object
    {
        $d = DB::table('documents')->where('office_id', $user->office_id)->find($id);
        abort_if(! $d, 404, 'Nincs ilyen dokumentum, vagy a felhasználó nem láthatja.');
        if ($d->message_id) {
            Scope::message($user, (int) $d->message_id);
        }

        return $d;
    }

    /**
     * A dokumentum teljes szövege. PDF-nél a `pdftotext` újra kinyeri (a tárolt szöveg 20 000 karakternél le van vágva),
     * XML-nél és szövegnél a fájlból olvasunk, ES3- és KRX-csomagnál a kibontott fájlok szövege kerül egymás után.
     *
     * @return array{text: string, source: string}
     */
    public static function documentText(object $d, int $depth = 0): array
    {
        $kids = DB::table('documents')->where('parent_id', $d->id)->orderBy('id')->get();
        if ($kids->isNotEmpty() && $depth < 5) {
            $meta = json_decode((string) $d->meta, true) ?: [];
            $parts = ["[Csomag: {$d->name}".(! empty($meta['title']) ? ", cím: {$meta['title']}" : '').", {$kids->count()} kibontott fájl]"];
            foreach ($kids as $k) {
                $parts[] = "\n===== {$k->name} =====\n".self::documentText($k, $depth + 1)['text'];
            }

            return ['text' => implode("\n", $parts), 'source' => 'csomag'];
        }
        $bytes = Storage::disk('local')->exists($d->path) ? Storage::disk('local')->get($d->path) : null;
        if ($bytes !== null && $d->mime === 'application/pdf' && ($text = self::pdfText($bytes)) !== null) {
            return ['text' => $text, 'source' => 'pdftotext'];
        }
        if ($bytes !== null && $d->mime && (str_starts_with($d->mime, 'text/') || str_contains($d->mime, 'xml')) && ! str_contains($bytes, 'e-szigno30#') && strlen($bytes) < 20 * 1024 * 1024) {
            $text = strip_tags(str_replace('><', ">\n<", mb_convert_encoding($bytes, 'UTF-8', 'UTF-8')));
            $text = trim(preg_replace("/\n\s*\n+/u", "\n", $text));
            if ($text !== '') {
                return ['text' => $text, 'source' => 'fájl'];
            }
        }
        if ($d->text) {
            return ['text' => $d->text, 'source' => $d->text_source === 'ocr' ? 'szövegfelismerés (tárolt)' : 'tárolt kivonat'];
        }

        return ['text' => '', 'source' => 'nincs kinyerhető szöveg (például beolvasott kép szövegfelismerés nélkül)'];
    }

    private static function pdfText(string $bytes): ?string
    {
        $bin = config('iratkapu.ocr.pdftotext') ?: (new ExecutableFinder)->find('pdftotext', null, ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']);
        if (! $bin || strlen($bytes) > 50 * 1024 * 1024) {
            return null;
        }
        $tmp = tempnam(sys_get_temp_dir(), 'kmmcp');
        try {
            file_put_contents($tmp, $bytes);
            $r = Process::timeout(60)->run([$bin, '-l', '300', '-layout', '-enc', 'UTF-8', $tmp, '-']);
            $text = $r->successful() ? trim(preg_replace("/[ \t]+\n/u", "\n", mb_convert_encoding($r->output(), 'UTF-8', 'UTF-8'))) : '';

            return mb_strlen($text) >= 20 ? $text : null;
        } catch (\Throwable) {
            return null;
        } finally {
            @unlink($tmp);
        }
    }
}
