<?php

namespace App\Iratkapu;

use App\Http\Controllers\AppController;
use Carbon\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Kimenő tárhely-küldemények (ELKÜLDÖTT mappa) és a hozzájuk érkező
 * feladási / érkeztetési / feldolgozási visszaigazolások determinisztikus összepárosítása.
 *
 * Három lépcső:
 *  1. Pontos hivatkozott érkeztetési szám (`ref_eid` vagy tárgy/szöveg kivonat = kimenő `eid`).
 *  2. Pontos vonalkód (`barcode`, legalább 6 karakter).
 *  3. Pontosan 1 jelölt azonos ügyfélnél: `form_code + period_from + period_to` és `incoming.arrived_at >= sent.arrived_at - 1 óra`.
 * Több jelölt esetén a 3. lépcső soha nem találgat.
 */
final class SubmissionPairing
{
    private const EXCLUDED_TYPES = [
        'kulso.fizetesi_felszolitas',
        'nav.bevallas.felszolitas',
        'nav.felszolitas.hianypotlas',
        'nav.igazolas.kiadott',
        'nav.igazolas.hatarozat_vegzes',
        'nav.vh.fizetesi_felhivas',
        'nav.illetek.fizetesi',
    ];

    /** Eldönti, hogy egy bejövő küldemény beküldési / érkeztetési / feldolgozási nyugtának vagy igazolásnak minősül-e. */
    public static function isSubmissionReceipt(object $m): bool
    {
        if (($m->folder ?? null) === 'ELKULDOTT') {
            return false;
        }
        $tid = (string) ($m->type_id ?? '');
        if (in_array($tid, self::EXCLUDED_TYPES, true)) {
            return false;
        }
        if (! empty($m->receipt)) {
            return true;
        }
        if (str_contains($tid, 'nyugta')) {
            return true;
        }
        if (in_array($tid, ['obh.beszamolo', 'nav.bevallas.intezkedes', 'nav.bevallas.tajekoztatas', 'receipt', 'igazolas'], true)) {
            return true;
        }

        $hay = ($m->subject ?? '').' '.($m->live_type ?? '').' '.($m->type_label ?? '');

        return (bool) preg_match(
            '/(nyugta|visszaigazol[aá]s|felad[aá]si\s*igazol[aá]s|let[oö]lt[eé]si\s*igazol[aá]s|[eé]rkeztet[eé]si\s*igazol[aá]s|befogad[aá]si\s*igazol[aá]s|feladasiigazolas|letoltesiigazolas|erkeztetesiigazolas|igazol[aá]s\s+beadv[aá]ny)/iu',
            $hay
        );
    }

    /** Meghatározza, hogy a visszaigazolás elutasítást/hibát jelez-e (`rejected`) vagy befogadást (`confirmed`). */
    public static function evaluateStatus(object $incoming): string
    {
        if (($incoming->type_id ?? '') === 'nav.nyugta.elutasito') {
            return 'rejected';
        }
        $docText = DB::table('documents')->where('message_id', $incoming->id)->pluck('text')->filter()->implode(' ');
        $hay = ($incoming->type_id ?? '').' '.($incoming->type_label ?? '').' '.($incoming->live_type ?? '').' '.($incoming->subject ?? '').' '.$docText;

        return preg_match('/elutas[ií]t|hib[aá]s|sikertelen|[eé]rv[eé]nytelen|visszautas[ií]t/iu', $hay) ? 'rejected' : 'confirmed';
    }

    /** Bejövő nyugta/igazolás érkezésekor vagy letöltésekor megkeresi és frissíti a hozzá tartozó ELKÜLDÖTT beadványt. */
    public static function pairOnIncoming(int|object $incoming): ?object
    {
        $inc = is_int($incoming) ? DB::table('messages')->find($incoming) : DB::table('messages')->find($incoming->id);
        if (! $inc || ! self::isSubmissionReceipt($inc)) {
            return null;
        }

        $officeId = (int) $inc->office_id;
        $exactClientIds = self::allowedClientIdsForExactMatch($inc);

        $docText = DB::table('documents')->where('message_id', $inc->id)->pluck('text')->filter()->implode(' ');
        $refEid = trim((string) ($inc->ref_eid ?? '')) ?: DeadlineExtractor::extractReferencedEid(($inc->subject ?? '')."\n".$docText);

        $sent = null;
        $basis = null;

        // 1. lépcső: Hivatkozott érkeztetési szám == kimenő küldemény EID
        if ($refEid !== null && $refEid !== '') {
            $sent = DB::table('messages')
                ->where('office_id', $officeId)
                ->where('folder', 'ELKULDOTT')
                ->whereIn('client_id', $exactClientIds)
                ->where('source_id', 'live-sent-'.$refEid)
                ->first();
            if ($sent && self::canPairClients($sent, $inc, true)) {
                $basis = "hivatkozott érkeztetési szám: $refEid";
            } else {
                $sent = null;
            }
        }

        // Ha nincs explicit ref_eid kulcsszó, ellenőrizzük, szerepel-e valamelyik jelölt EID-je közvetlenül a tárgyban/szövegben
        if (! $sent) {
            $hay = ($inc->subject ?? '').' '.$docText;
            $candidates = DB::table('messages')
                ->where('office_id', $officeId)
                ->where('folder', 'ELKULDOTT')
                ->whereIn('client_id', $exactClientIds)
                ->where('source_id', 'like', 'live-sent-%')
                ->get();
            $hits = [];
            foreach ($candidates as $cand) {
                $sEid = AppController::liveEid($cand->source_id);
                if ($sEid && strlen($sEid) >= 6 && str_contains($hay, $sEid) && self::canPairClients($cand, $inc, true)) {
                    $hits[] = [$cand, $sEid];
                }
            }
            if (count($hits) === 1) {
                [$sent, $matchedEid] = $hits[0];
                $refEid = $refEid ?: $matchedEid;
                $basis = "érkeztetési szám egyezés a szövegben: $matchedEid";
            }
        }

        // 2. lépcső: Pontos vonalkód (>= 6 karakter)
        $barcode = trim((string) ($inc->barcode ?? ''));
        if (! $sent && strlen($barcode) >= 6) {
            $bcMatches = DB::table('messages')
                ->where('office_id', $officeId)
                ->where('folder', 'ELKULDOTT')
                ->whereIn('client_id', $exactClientIds)
                ->where('barcode', $barcode)
                ->get()
                ->filter(fn ($cand) => self::canPairClients($cand, $inc, true))
                ->values();
            if ($bcMatches->count() === 1) {
                $sent = $bcMatches[0];
                $basis = "vonalkód egyezés: $barcode";
            }
        }

        // 3. lépcső: Azonos ügyfélnél egyedi form_code + period_from + period_to + időablak (csak ha pontosan 1 jelölt van!)
        if (! $sent && ! empty($inc->form_code) && ! empty($inc->period_from) && ! empty($inc->period_to)) {
            $fpMatches = DB::table('messages')
                ->where('office_id', $officeId)
                ->where('folder', 'ELKULDOTT')
                ->where('client_id', $inc->client_id)
                ->whereRaw('UPPER(form_code) = ?', [mb_strtoupper((string) $inc->form_code)])
                ->where('period_from', $inc->period_from)
                ->where('period_to', $inc->period_to)
                ->get()
                ->filter(fn ($cand) => self::withinArrivalWindow($cand, $inc))
                ->values();
            if ($fpMatches->count() === 1) {
                $sent = $fpMatches[0];
                $basis = "nyomtatvány és időszak ({$inc->form_code}, {$inc->period_from}–{$inc->period_to})";
            }
        }

        if (! $sent) {
            return null;
        }

        return self::applyLink($sent, $inc, $basis, $refEid);
    }

    /** Kimenő (ELKÜLDÖTT) beadvány listázásakor vagy letöltésekor megkeresi a már korábban beérkezett igazolásokat. */
    public static function pairOnSent(int|object $sentInput): ?object
    {
        $sent = is_int($sentInput) ? DB::table('messages')->find($sentInput) : DB::table('messages')->find($sentInput->id);
        if (! $sent || ($sent->folder ?? null) !== 'ELKULDOTT') {
            return null;
        }

        $officeId = (int) $sent->office_id;
        $sentEid = AppController::liveEid($sent->source_id);
        $exactClientIds = self::allowedClientIdsForExactMatch($sent);

        $incomings = DB::table('messages')
            ->where('office_id', $officeId)
            ->where(fn ($q) => $q->whereNull('folder')->orWhere('folder', '!=', 'ELKULDOTT'))
            ->whereIn('client_id', $exactClientIds)
            ->orderBy('arrived_at')
            ->orderBy('id')
            ->get()
            ->filter(fn ($m) => self::isSubmissionReceipt($m))
            ->values();

        if ($incomings->isEmpty()) {
            return null;
        }

        $matchedReceipts = [];

        // 1. lépcső: EID alapú illesztés
        if ($sentEid !== null && $sentEid !== '') {
            foreach ($incomings as $inc) {
                if (! self::canPairClients($sent, $inc, true)) {
                    continue;
                }
                $incRef = trim((string) ($inc->ref_eid ?? ''));
                if ($incRef === '') {
                    $docText = DB::table('documents')->where('message_id', $inc->id)->pluck('text')->filter()->implode(' ');
                    $incRef = DeadlineExtractor::extractReferencedEid(($inc->subject ?? '')."\n".$docText) ?? '';
                    if ($incRef === '' && strlen($sentEid) >= 6 && str_contains(($inc->subject ?? '').' '.$docText, $sentEid)) {
                        $incRef = $sentEid;
                    }
                }
                if ($incRef === $sentEid) {
                    $matchedReceipts[] = [$inc, "hivatkozott érkeztetési szám: $sentEid", $sentEid];
                }
            }
        }

        // 2. lépcső: Vonalkód alapú illesztés
        $barcode = trim((string) ($sent->barcode ?? ''));
        if (! $matchedReceipts && strlen($barcode) >= 6) {
            foreach ($incomings as $inc) {
                if (! self::canPairClients($sent, $inc, true)) {
                    continue;
                }
                if (trim((string) ($inc->barcode ?? '')) === $barcode) {
                    $matchedReceipts[] = [$inc, "vonalkód egyezés: $barcode", $sentEid];
                }
            }
        }

        // 3. lépcső: Egyedi form_code + period_from + period_to ugyanannál az ügyfélnél (ha más kimenő jelölt nincs!)
        if (! $matchedReceipts && ! empty($sent->form_code) && ! empty($sent->period_from) && ! empty($sent->period_to)) {
            $siblingCount = DB::table('messages')
                ->where('office_id', $officeId)
                ->where('folder', 'ELKULDOTT')
                ->where('client_id', $sent->client_id)
                ->whereRaw('UPPER(form_code) = ?', [mb_strtoupper((string) $sent->form_code)])
                ->where('period_from', $sent->period_from)
                ->where('period_to', $sent->period_to)
                ->count();
            if ($siblingCount === 1) {
                $fpReceipts = $incomings->filter(fn ($inc) => (int) $inc->client_id === (int) $sent->client_id
                    && ! empty($inc->form_code)
                    && mb_strtoupper((string) $inc->form_code) === mb_strtoupper((string) $sent->form_code)
                    && $inc->period_from === $sent->period_from
                    && $inc->period_to === $sent->period_to
                    && self::withinArrivalWindow($sent, $inc)
                )->values();
                if ($fpReceipts->count() === 1) {
                    $matchedReceipts[] = [$fpReceipts[0], "nyomtatvány és időszak ({$sent->form_code}, {$sent->period_from}–{$sent->period_to})", $sentEid];
                }
            }
        }

        if (! $matchedReceipts) {
            return null;
        }

        $result = null;
        foreach ($matchedReceipts as [$inc, $basis, $ref]) {
            $freshSent = DB::table('messages')->find($sent->id);
            $applied = self::applyLink($freshSent, $inc, $basis, $ref);
            if ($applied) {
                $result = $applied;
            }
        }

        return $result;
    }

    private static function withinArrivalWindow(object $sent, object $inc): bool
    {
        if (empty($sent->arrived_at) || empty($inc->arrived_at)) {
            return true;
        }
        try {
            $sAt = Carbon::parse($sent->arrived_at)->subHour();
            $iAt = Carbon::parse($inc->arrived_at);

            return $iAt->greaterThanOrEqualTo($sAt);
        } catch (\Throwable) {
            return true;
        }
    }

    /** Visszaadja azon ügyfél-azonosítókat az irodán belül, amelyekkel pontos EID / vonalkód alapon párosodhat az üzenet. */
    private static function allowedClientIdsForExactMatch(object $m): array
    {
        $officeId = (int) $m->office_id;
        $cid = (int) $m->client_id;
        $client = DB::table('clients')->where('office_id', $officeId)->find($cid);
        if (! $client) {
            return [$cid];
        }

        // Ha az üzenet egy saját tárhely gyűjtőn (own) ül, a gyűjtő tulajdonosa által látott ügyfelek jöhetnek szóba
        if (($client->discovered_via ?? null) === 'own') {
            $ownerId = self::collectorOwnerId($client);
            if (! $ownerId) {
                return [$cid];
            }
            $owner = DB::table('users')->find($ownerId);

            return $owner ? array_values(array_unique(array_merge([$cid], Scope::clientIds($owner)))) : [$cid];
        }

        // Ha az üzenet már egy rendes ügyfélnél ül, csak saját maga + azok az own gyűjtők jöhetnek szóba, amelyek gazdája látja ezt az ügyfelet
        $ownCollectors = DB::table('clients')->where('office_id', $officeId)->where('discovered_via', 'own')->get();
        $allowed = [$cid];
        foreach ($ownCollectors as $col) {
            $ownerId = self::collectorOwnerId($col);
            if ($ownerId && Scope::userSeesClient($ownerId, $cid)) {
                $allowed[] = (int) $col->id;
            }
        }

        return array_values(array_unique($allowed));
    }

    private static function canPairClients(object $sent, object $inc, bool $allowOwnCollectorBridge): bool
    {
        if ((int) $sent->office_id !== (int) $inc->office_id) {
            return false;
        }
        if ((int) $sent->client_id === (int) $inc->client_id) {
            return true;
        }
        if (! $allowOwnCollectorBridge) {
            return false;
        }

        $sClient = DB::table('clients')->find($sent->client_id);
        $iClient = DB::table('clients')->find($inc->client_id);
        if (! $sClient || ! $iClient) {
            return false;
        }

        $sOwn = ($sClient->discovered_via ?? null) === 'own';
        $iOwn = ($iClient->discovered_via ?? null) === 'own';
        // Két különböző rendes ügyfél között soha nem párosítunk
        if ($sOwn === $iOwn) {
            return false;
        }

        $collector = $sOwn ? $sClient : $iClient;
        $regularId = (int) ($sOwn ? $iClient->id : $sClient->id);
        $ownerId = self::collectorOwnerId($collector);

        return $ownerId !== null && Scope::userSeesClient($ownerId, $regularId);
    }

    private static function collectorOwnerId(object $collector): ?int
    {
        if (! empty($collector->owner_user_id)) {
            return (int) $collector->owner_user_id;
        }
        if (! empty($collector->portal_connection_id)) {
            $pidOwner = DB::table('portal_connections')->where('id', $collector->portal_connection_id)->value('owner_user_id');

            return $pidOwner ? (int) $pidOwner : null;
        }

        return null;
    }

    private static function applyLink(object $sent, object $inc, string $basis, ?string $refEid): ?object
    {
        $newStatus = self::evaluateStatus($inc);
        $curStatus = ($sent->filing_status ?? null) ?: 'pending';

        $effectiveEid = $refEid ?: AppController::liveEid($sent->source_id);
        if ($effectiveEid && empty($inc->ref_eid)) {
            DB::table('messages')->where('id', $inc->id)->update(['ref_eid' => mb_substr($effectiveEid, 0, 64), 'updated_at' => now()]);
        }

        // Elutasított státuszt egy későbbi sima feladási/letöltési igazolás nem írhat felül confirmed-re
        if ($curStatus === 'rejected' && $newStatus !== 'rejected') {
            return DB::table('messages')->find($sent->id);
        }
        if ($curStatus === $newStatus && (int) ($sent->filing_receipt_id ?? 0) === (int) $inc->id) {
            return DB::table('messages')->find($sent->id);
        }

        $upd = [
            'filing_status' => $newStatus,
            'filing_receipt_id' => $inc->id,
            'updated_at' => now(),
        ];
        if ($effectiveEid && empty($sent->ref_eid)) {
            $upd['ref_eid'] = mb_substr($effectiveEid, 0, 64);
        }
        DB::table('messages')->where('id', $sent->id)->update($upd);

        Audit::log(
            (int) $sent->office_id,
            null,
            $newStatus === 'rejected'
                ? 'Elküldött beadvány elutasítva (érkeztetés párosítva)'
                : 'Elküldött beadvány befogadása visszaigazolva (érkeztetés párosítva)',
            [
                'client_id' => $sent->client_id,
                'message_id' => $sent->id,
                'before' => $curStatus,
                'after' => $newStatus,
                'evidence' => "igazolás #{$inc->id} ($basis)",
                'policy' => 'pairing.'.$newStatus,
            ]
        );

        return DB::table('messages')->find($sent->id);
    }
}
