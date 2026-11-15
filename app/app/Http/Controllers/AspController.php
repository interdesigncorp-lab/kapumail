<?php
namespace App\Http\Controllers;

use App\Iratkapu\{Audit, Documents, RuleEngine, Scope, TypeActions};
use Illuminate\Http\Request;
use Illuminate\Support\Facades\{Auth, DB, Storage};

/**
 * E-Önkormányzat Portál (ASP), ablakos út (docs/adr/ADR-011). Az asztali app a látható belépőablak munkamenetéből,
 * kizárólag olvasó kérésekkel kiolvasott adatokat küldi be: önkormányzatonként az adószámla-kivonat (PDF), a benyújtott
 * bevallások listája és a folyamatban lévő ügyek száma.
 *
 * Kié az adat: a portál szerepköre mondja meg. Saját néven (magánszemélyként) a beolvasó saját adata – magánadat, csak
 * ő látja. Más szerepkörben az adószám alapján egy MEGLÉVŐ, a beolvasó által látható, aktív ügyfélhez kerül; ügyfél
 * ebből magától nem jön létre, ismeretlen adószámot a szerver elutasít.
 */
class AspController extends Controller
{
    private const MAX_PDF = 5 * 1024 * 1024;

    public function ingest(Request $r)
    {
        $u = Auth::user();
        $d = $r->validate([
            'subject' => 'required|array', 'subject.own' => 'required|boolean', 'subject.role' => 'nullable|string|max:80',
            'subject.id' => ['nullable', 'string', 'regex:/^(\d{8}|8\d{9})$/'],
            'tenants' => 'required|array|max:50',
            'tenants.*.uid' => ['required', 'string', 'max:64', 'regex:/^[A-Za-z0-9-]+$/'],
            'tenants.*.name' => 'nullable|string|max:200', 'tenants.*.city' => 'nullable|string|max:120',
            'tenants.*.balance' => 'nullable|array',
            'tenants.*.balance.year' => 'required_with:tenants.*.balance|integer|min:2000|max:2100',
            'tenants.*.balance.kind' => 'nullable|in:SIMPLE,DETAILED', 'tenants.*.balance.status' => 'nullable|string|max:40',
            'tenants.*.balance.pdfBase64' => 'required_with:tenants.*.balance|string|max:' . (int) ceil(self::MAX_PDF * 1.4),
            'tenants.*.returns' => 'nullable|array|max:500',
            'tenants.*.returns.*.taxCode' => 'nullable|string|max:20', 'tenants.*.returns.*.taxName' => 'nullable|string|max:200',
            'tenants.*.returns.*.fileName' => 'nullable|string|max:200', 'tenants.*.returns.*.comments' => 'nullable|string|max:500',
            'tenants.*.cases' => 'nullable|integer|min:0|max:100000',
            'tenants.*.notes' => 'nullable|array|max:10', 'tenants.*.notes.*' => 'string|max:200',
            'year' => 'nullable|integer|min:2000|max:2100',
        ]);
        $own = (bool) $d['subject']['own']; $client = null;
        if ($own) {
            abort_if(($d['subject']['role'] ?? null) !== 'SAJAT_NEVEN_TERMESZETES_SZEMELY', 422, 'A saját adat csak a „Saját néven (magánszemélyként)” szerepkörből jöhet.');
            $key = "own:{$u->id}";
        } else {
            $id = $d['subject']['id'] ?? null;
            abort_if(!$id, 422, 'A szerepkörből nem derült ki egyértelműen, kinek az adatai ezek, ezért nem mentettem el.');
            $client = DB::table('clients')->whereIn('id', Scope::clientIds($u))->where(fn ($q) => $q->whereNull('discovered_via')->orWhere('discovered_via', '!=', 'own'))
                ->where(fn ($q) => $q->where('tax', $id)->orWhere('tax', 'like', "$id-%"))->first();
            abort_if(!$client, 422, "Nincs $id azonosítójú ügyfél az általad látott ügyfelek között. Előbb vedd fel ügyfélként, aztán olvasd be újra.");
            abort_if(!$client->active || ($client->auth_until && $client->auth_until < now()->toDateString()), 422, 'Az ügyfél inaktív, vagy lejárt a meghatalmazása; az adatait nem mentettem el.');
            $key = $id;
        }
        $defaultYear = (int) ($d['year'] ?? now()->year); $saved = 0; $pdfs = 0; $filed = 0;
        foreach ($d['tenants'] as $t) {
            $b = $t['balance'] ?? null; $pdf = null;
            if ($b) {
                $bytes = base64_decode($b['pdfBase64'], true);
                abort_if($bytes === false || !str_starts_with($bytes, '%PDF-') || strlen($bytes) > self::MAX_PDF, 422, 'A kivonat nem érvényes PDF, vagy túl nagy.');
                $sha = hash('sha256', $bytes); $path = "asp/{$u->office_id}/$sha.pdf";
                if (!Storage::disk('local')->exists($path)) Storage::disk('local')->put($path, $bytes);
                $pdf = ['pdf_path' => $path, 'pdf_sha256' => $sha, 'pdf_size' => strlen($bytes)]; $pdfs++;
                if ($this->fileAsMessage($u, $client, $own, $t, (int) $b['year'], $bytes)) $filed++;
            }
            $returns = isset($t['returns']) ? array_map(fn ($x) => ['taxCode' => $x['taxCode'] ?? null, 'taxName' => $x['taxName'] ?? null, 'fileName' => $x['fileName'] ?? null, 'comments' => $x['comments'] ?? null], $t['returns']) : null;
            $where = ['office_id' => $u->office_id, 'subject_key' => $key, 'tenant_uid' => $t['uid'], 'year' => (int) ($b['year'] ?? $defaultYear)];
            $row = ['user_id' => $u->id, 'client_id' => $client->id ?? null, 'subject_role' => $d['subject']['role'] ?? null,
                'tenant_name' => $t['name'] ?? null, 'tenant_city' => $t['city'] ?? null, 'kind' => $b['kind'] ?? null, 'status' => $b['status'] ?? null,
                'returns_count' => $returns === null ? null : count($returns), 'returns' => $returns === null ? null : json_encode($returns, JSON_UNESCAPED_UNICODE),
                'cases_count' => $t['cases'] ?? null, 'notes' => !empty($t['notes']) ? json_encode(array_values($t['notes']), JSON_UNESCAPED_UNICODE) : null,
                'fetched_at' => now(), 'updated_at' => now()]
                // ha most nem jött kivonat, a korábbi fájl megmarad a sorban; a jegyzetből látszik, hogy az utolsó beolvasás nem hozott újat
                + ($pdf ?? []);
            DB::table('asp_statements')->where($where)->exists()
                ? DB::table('asp_statements')->where($where)->update($row)
                : DB::table('asp_statements')->insert($where + $row + ['created_at' => now()]);
            $saved++;
        }
        Audit::log($u->office_id, $u, "Önkormányzati portál adatai fogadva: $saved önkormányzat, $pdfs adószámla-kivonat" . ($own ? ' (saját adat)' : ''),
            ['client_id' => $client->id ?? null, 'evidence' => 'csak olvasás, a felhasználó által megnyitott belépőablakból', 'policy' => 'ADR-011, ablakos út']);
        return ['ok' => true, 'saved' => $saved, 'pdfs' => $pdfs, 'filed' => $filed, 'own' => $own, 'client' => $client->name ?? null];
    }

    /**
     * A kivonat iratként is bekerül az ügyfél iratai közé, hogy kereshető, kiosztható és megnyitható legyen – de úgy, hogy
     * NE keveredjen a tárhelyre érkezett levelekkel: a feladója „ASP”, a tárgya azzal kezdődik, hogy a portálról lekérdezett
     * kivonat, a hivatalos állapota „nem átvételköteles” (kézbesítési joghatása nincs).
     * Önkormányzatonként, évenként és naponta legfeljebb egy irat jön létre; az újabb aznapi beolvasás nem kettőz.
     * A saját adat a beolvasó „Saját tárhely” gyűjtőjébe kerül (azt csak ő látja); ha nincs ilyen gyűjtő vagy az ügyfélnek
     * nincs tárhelye, irat nem jön létre – a kivonat akkor is megmarad a „Helyi adók” táblázatban.
     */
    private function fileAsMessage(object $u, ?object $client, bool $own, array $tenant, int $year, string $bytes): bool
    {
        if ($own) {
            $client = DB::table('clients')->join('portal_connections', 'portal_connections.id', '=', 'clients.portal_connection_id')
                ->where('clients.office_id', $u->office_id)->where('clients.discovered_via', 'own')->where('portal_connections.owner_user_id', $u->id)
                ->orderBy('clients.id')->first(['clients.id', 'clients.name']);
        }
        if (!$client) return false;
        $box = DB::table('mailboxes')->where('office_id', $u->office_id)->where('client_id', $client->id)->orderByRaw("case type when 'CK' then 0 when 'ÜK' then 1 else 2 end")->orderBy('id')->first();
        if (!$box) return false;
        $source = 'asp:' . $tenant['uid'] . ":$year:" . now()->toDateString();
        if (DB::table('messages')->where('mailbox_id', $box->id)->where('source_id', $source)->exists()) return false;
        $city = trim((string) ($tenant['city'] ?? '')) ?: 'önkormányzat';
        $id = DB::table('messages')->insertGetId([
            'office_id' => $u->office_id, 'client_id' => $client->id, 'mailbox_id' => $box->id, 'source_id' => $source,
            'sender' => 'ASP', 'sender_full' => mb_substr(($tenant['name'] ?? $city) . ' – önkormányzati portál', 0, 200),
            'subject' => "Portálról lekérdezve: helyi adószámla-kivonat – $city, $year",
            'type_id' => 'asp-adoszamla-kivonat', 'type_label' => 'Helyi adószámla-kivonat (portál)', 'type_ai' => false, 'unknown' => false, 'receipt' => false,
            'arrived_at' => now(), 'official' => 'na', 'internal' => 'uj', 'es3' => false, 'att' => 1, 'file_size' => strlen($bytes), 'created_at' => now(), 'updated_at' => now(),
        ]);
        Documents::store($u->office_id, $id, 'adoszamla-kivonat-' . (preg_replace('/[^a-z0-9]+/i', '-', \Illuminate\Support\Str::ascii($city)) ?: 'onkormanyzat') . "-$year.pdf", $bytes, $u->id);
        Audit::log($u->office_id, $u, 'Helyi adószámla-kivonat iratként rögzítve – a portálról lekérdezve, joghatás nélkül', ['client_id' => $client->id, 'message_id' => $id, 'evidence' => 'önkormányzati portál, olvasó lekérdezés', 'policy' => 'ADR-011, ablakos út']);
        if (TypeActions::onArrival($id)) RuleEngine::apply(DB::table('messages')->find($id));
        TypeActions::autoArchive($id); \App\Iratkapu\DocumentForward::afterResponse($id, 'downloaded');
        return true;
    }

    /** A felhasználó által látható sorok: a látott ügyfeleké, és a saját maga által beolvasott saját adat. */
    private static function visibleQuery(object $u)
    {
        return DB::table('asp_statements')->where('office_id', $u->office_id)
            ->where(fn ($q) => $q->whereIn('client_id', Scope::clientIds($u))->orWhere(fn ($x) => $x->whereNull('client_id')->where('user_id', $u->id)));
    }

    public static function visible(object $u): array
    {
        return self::visibleQuery($u)->orderByDesc('fetched_at')->orderBy('tenant_city')->limit(500)->get()->map(fn ($s) => [
            'id' => $s->id, 'c' => $s->client_id === null ? null : "c{$s->client_id}", 'own' => $s->client_id === null, // az ügyfél azonosítója a felület alakjában 'role' => $s->subject_role,
            'tenant' => $s->tenant_name, 'city' => $s->tenant_city, 'year' => (int) $s->year, 'kind' => $s->kind, 'status' => $s->status,
            'pdf' => $s->pdf_path !== null, 'pdfSize' => $s->pdf_size, 'returns' => $s->returns_count, 'cases' => $s->cases_count,
            'returnList' => $s->returns ? (json_decode($s->returns, true) ?: []) : [],
            'notes' => $s->notes ? (json_decode($s->notes, true) ?: []) : [], 'at' => substr((string) $s->fetched_at, 0, 16),
        ])->all();
    }

    public function pdf(int $id)
    {
        $u = Auth::user();
        $s = self::visibleQuery($u)->where('id', $id)->first();
        abort_if(!$s || !$s->pdf_path, 404);
        $bytes = Storage::disk('local')->get($s->pdf_path);
        abort_if(hash('sha256', (string) $bytes) !== $s->pdf_sha256, 500, 'Az eltett kivonat hash-e nem egyezik – a fájl sérült.');
        Audit::log($u->office_id, $u, "Helyi adószámla-kivonat megnyitva: {$s->tenant_city} {$s->year}", ['client_id' => $s->client_id, 'evidence' => "SHA-256 {$s->pdf_sha256}"]);
        $name = 'adoszamla-kivonat-' . preg_replace('/[^a-z0-9]+/i', '-', (string) ($s->tenant_city ?: $s->tenant_uid)) . "-{$s->year}.pdf";
        return response($bytes, 200, ['Content-Type' => 'application/pdf', 'X-Content-Type-Options' => 'nosniff', 'Cache-Control' => 'no-store',
            'Content-Security-Policy' => "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; object-src 'self'; frame-ancestors 'self'",
            'Content-Disposition' => 'inline; filename="' . rawurlencode($name) . '"']);
    }
}
