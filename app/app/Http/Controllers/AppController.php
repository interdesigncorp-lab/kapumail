<?php

namespace App\Http\Controllers;

use App\Iratkapu\Audit;
use App\Iratkapu\CalendarInvites;
use App\Iratkapu\ClientDiscovery;
use App\Iratkapu\ConnectorGuard;
use App\Iratkapu\DeadlineCalendar;
use App\Iratkapu\DeadlineExtractor;
use App\Iratkapu\DemoConnector;
use App\Iratkapu\DocumentForward;
use App\Iratkapu\Documents;
use App\Iratkapu\DownloadPolicy;
use App\Iratkapu\Es3Exception;
use App\Iratkapu\Es3Reader;
use App\Iratkapu\FormCatalog;
use App\Iratkapu\GateException;
use App\Iratkapu\LegalDeadline;
use App\Iratkapu\Notify;
use App\Iratkapu\OfficeMail;
use App\Iratkapu\OwnMailRouter;
use App\Iratkapu\Receiving;
use App\Iratkapu\RuleEngine;
use App\Iratkapu\Scope;
use App\Iratkapu\SignatureCheck;
use App\Iratkapu\SubmissionPairing;
use App\Iratkapu\SyncService;
use App\Iratkapu\Taxonomy;
use App\Iratkapu\TaxpayerDataTables;
use App\Iratkapu\TaxPayment;
use App\Iratkapu\TypeActions;
use App\Iratkapu\TypeSettings;
use Carbon\Carbon;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\HtmlString;
use Illuminate\Support\Str;

class AppController extends Controller
{
    private function u(): object
    {
        return Auth::user();
    }

    private function ini(): array
    {
        return DB::table('users')->where('office_id', $this->u()->office_id)->pluck('initials', 'id')->all();
    }

    /** Az asztali alkalmazás megjelöli a kéréseit; ebből tudjuk, hogy ott fut-e a felület, és melyik módban ("local" vagy "server"). */
    public static function desktopMode(Request $r): ?string
    {
        return preg_match('~KapuMail-Desktop/[\d.]+ \((local|server)\)~', (string) $r->userAgent(), $m) ? $m[1] : null;
    }

    /** A helyi fiók belső e-mail-címe, amíg a felhasználó meg nem adja a sajátját (a varázsló első lépése). */
    const LOCAL_EMAIL = 'helyi@kapumail.local';

    private static function localOfficeId(): ?int
    {
        $o = DB::table('offices')->get(['id', 'settings'])->first(fn ($o) => ! empty((json_decode($o->settings ?? '{}', true) ?: [])['local']));

        return $o ? (int) $o->id : null;
    }

    public function loginForm(Request $r)
    {
        // Asztali alkalmazásban a mintafelhasználók nem jelennek meg: ott csak zavarnának.
        $demo = config('iratkapu.mode') === 'demo' && ! self::desktopMode($r);

        return view('login', ['demo' => $demo, 'users' => $demo ? DB::table('users')->orderBy('id')->get(['name', 'email', 'role']) : collect()]);
    }

    public function login(Request $r)
    {
        $c = $r->validate(['email' => 'required|email', 'password' => 'required']);
        // Asztali alkalmazásban a gép megjegyzi a belépést: a jelszót egyszer kell megadni, utána a helyi zár (Touch ID / PIN) véd.
        if (! Auth::attempt($c, (bool) self::desktopMode($r))) {
            return back()->withErrors(['email' => 'Hibás e-mail-cím vagy jelszó.'])->onlyInput('email');
        }
        $r->session()->regenerate();
        Audit::log(Auth::user()->office_id, Auth::user(), 'Belépés');

        return redirect()->intended('/'); // az AI-kapcsolat engedélyező oldala (OAuth) ide tér vissza belépés után
    }

    /**
     * Helyi asztali mód: jelszó nélküli belépés. Az asztali alkalmazás egy véletlen titkot küld, amelyet ő generált és a gép
     * kulcstartójában őriz; a felhasználó ezt nem látja. Az első hívás létrehozza a gép egyetlen fiókját (üres, saját irodával),
     * a későbbiek ugyanazzal a titokkal belépnek. Csak a saját gépről (loopback) és csak helyi módú asztali alkalmazásból hívható.
     */
    public function localEnter(Request $r)
    {
        abort_unless(config('iratkapu.local_account') && self::desktopMode($r) === 'local' && in_array($r->ip(), ['127.0.0.1', '::1'], true), 403, 'Helyi fiók csak a saját gépről, a helyi módú asztali alkalmazásból érhető el.');
        $d = $r->validate(['secret' => 'required|string|min:32|max:200', 'terms' => 'sometimes|boolean']);
        $ts = ['created_at' => now(), 'updated_at' => now()];
        $oid = self::localOfficeId();
        $created = false;
        if (! $oid) {
            DB::transaction(function () use ($d, $ts, &$oid) {
                $o = $oid = DB::table('offices')->insertGetId(['name' => 'Saját iroda', 'settings' => json_encode(['reminders' => [5, 2, 1], 'local' => true, 'onboarding' => 'pending', 'mcp' => ['enabled' => true]])] + $ts);
                DB::table('users')->insert(['name' => 'Saját fiók', 'email' => self::LOCAL_EMAIL, 'password' => Hash::make($d['secret']), 'office_id' => $o, 'role' => 'admin', 'initials' => 'ÉN'] + $ts);
                // Kiinduló szabályok: ugyanazok, mint a mintairodában, felelős nélkül.
                foreach ([
                    ['NAV fizetési felszólítás', ['senders' => ['NAV'], 'type' => 'felszólítás'], 'Sürgős', 'Vezetőnek azonnal', 0, 'manual'],
                    ['NAV hiánypótlás és határozat', ['senders' => ['NAV'], 'type' => 'hiánypótl|határozat'], 'Sürgős', 'Felelősnek azonnal', 0, 'manual'],
                    ['Bírósági, cégbírósági és végrehajtói irat', ['senders' => ['BÍR', 'VH', 'CÉGB']], 'Sürgős', 'Vezetőnek azonnal', 0, 'manual'],
                    ['Önkormányzati adó', ['senders' => ['ÖNK']], 'Normál', 'Reggeli összesítő', 0, 'manual'],
                    ['Elfogadó nyugták', ['receipt' => true], 'Alacsony', 'Nincs', 0, 'auto_safe'],
                    ['Ismeretlen típus', ['unknown' => true], 'Normál', 'Vezetőnek azonnal', 1, 'manual'],
                ] as $p => [$n, $mt, $pri, $no, $lock, $dlm]) {
                    DB::table('rules')->insert(['office_id' => $o, 'name' => $n, 'matcher' => json_encode($mt), 'priority' => $pri, 'assignee_id' => null, 'notify' => $no, 'download_mode' => $dlm, 'version' => 1, 'locked' => $lock, 'position' => $lock ? 0 : $p + 1] + $ts);
                }
            });
            $created = true;
        }
        $user = DB::table('users')->where('office_id', $oid)->orderBy('id')->first();
        abort_if(! $user || ! Hash::check($d['secret'], $user->password), 403, 'Ez a gép nem ehhez a helyi fiókhoz tartozik.');
        Auth::loginUsingId($user->id, true);
        $r->session()->regenerate();
        Audit::log($oid, Auth::user(), $created ? 'Helyi fiók létrehozva az asztali alkalmazásban' : 'Belépés (helyi mód, a gép kulcstartójából)');
        // A nyitóképernyőn bejelölt ÁSZF- és adatkezelési elfogadás: az aktuális verzióra, ha még nincs elfogadva.
        if (! empty($d['terms']) && ! TermsController::acceptedBy($user->id)) {
            TermsController::record($r, Auth::user(), 'a nyitóképernyőn, két jelölőnégyzettel');
        }

        return ['ok' => true, 'created' => $created];
    }

    /** Helyi mód: a név, az e-mail-cím és az iroda neve (a varázsló első lépése, később a Beállításokból is). */
    public function saveProfile(Request $r)
    {
        $u = $this->u();
        abort_if(empty(OfficeMail::settings($u->office_id)['local']), 403, 'Ez csak helyi módban állítható így.');
        $d = $r->validate(['name' => 'required|string|max:80', 'email' => 'required|email|max:160|unique:users,email,'.$u->id, 'office' => 'nullable|string|max:120'],
            ['email.unique' => 'Ezzel az e-mail-címmel már van fiók.', 'email.email' => 'Ez nem tűnik érvényes e-mail-címnek.']);
        $ini = mb_strtoupper(implode('', array_map(fn ($p) => mb_substr($p, 0, 1), array_slice(preg_split('/\s+/', trim($d['name'])), 0, 2))));
        DB::table('users')->where('id', $u->id)->update(['name' => trim($d['name']), 'email' => $d['email'], 'initials' => $ini ?: 'ÉN', 'updated_at' => now()]);
        DB::table('offices')->where('id', $u->office_id)->update(['name' => trim($d['office'] ?? '') ?: trim($d['name']), 'updated_at' => now()]);
        Audit::log($u->office_id, $u, 'Saját adatok megadva (név, e-mail-cím)');

        return ['ok' => true];
    }

    /** Az első indítási varázsló lezárása (végigment vagy kihagyta). */
    public function onboardingDone()
    {
        $u = $this->u();
        OfficeMail::put($u->office_id, ['onboarding' => 'done']);

        return ['ok' => true];
    }

    public function logout(Request $r)
    {
        Auth::logout();
        $r->session()->invalidate();
        $r->session()->regenerateToken();

        return redirect('/login');
    }

    /** A Kapu-chat felületének fájljai (resources/ui). Csak a felsoroltak; minden más név 404, így könyvtárból kilépni sem lehet. */
    public function uiAsset(string $f)
    {
        $types = ['kapu.js' => 'application/javascript', 'kapu-settings.js' => 'application/javascript', 'kapu-md.js' => 'application/javascript',
            'kapu-typing.js' => 'application/javascript', 'kapu-voice.js' => 'application/javascript', 'kapu.css' => 'text/css'];
        abort_unless(isset($types[$f]) && is_file($path = resource_path('ui/'.$f)), 404);

        return response((string) file_get_contents($path))->header('Content-Type', $types[$f].'; charset=UTF-8')->header('Cache-Control', 'no-store')->header('X-Content-Type-Options', 'nosniff');
    }

    public function index()
    {
        return response(file_get_contents(resource_path('ui/app.html')))->header('Content-Type', 'text/html; charset=UTF-8')->header('Cache-Control', 'no-store');
    }

    public function state()
    {
        $u = $this->u();
        $ini = $this->ini();
        $cids = Scope::clientIds($u);
        $fmt = fn ($d) => $d ? substr($d, 0, 16) : null;
        $office = DB::table('offices')->find($u->office_id);
        $boxes = DB::table('mailboxes')->whereIn('client_id', $cids)->get();
        // NAV ügyfélportál, B kör: az ügyfél adószámlájának legfrissebb pillanatképe – annak, aki az ügyfelet látja.
        $navClient = DB::table('nav_client_snapshots')->whereIn('client_id', $cids)->get()->keyBy('client_id')->map(fn ($n) => [
            'total' => $n->total, 'debt' => $n->debt, 'surplus' => $n->surplus, 'deposit' => $n->deposit, 'unbooked' => $n->unbooked,
            'missing' => $n->missing_count, 'future' => $n->future_count, 'calendar' => $n->calendar_count, 'at' => substr((string) $n->fetched_at, 0, 16)]);
        $clients = DB::table('clients')->whereIn('id', $cids)->orderBy('name')->get()->map(function ($c) use ($boxes, $ini, $navClient) {
            $b = $boxes->where('client_id', $c->id);
            $bad = $b->firstWhere('sync_state', 'need');
            $last = $b->max('last_ok_at');

            return ['nav' => $navClient[$c->id] ?? null, 'id' => "c{$c->id}", 'name' => $c->name, 'tax' => $c->tax, 'boxes' => $b->pluck('type')->values(), 'auth' => $c->auth_until, 'basis' => $c->auth_basis,
                'active' => (bool) $c->active, 'via' => $c->discovered_via, 'portalId' => $c->portal_connection_id !== null ? (int) $c->portal_connection_id : null,
                'sync' => ['ok' => ! $bad, 'at' => $last ? substr($last, 5, 11) : 'még nem volt', 'why' => $bad->sync_note ?? null],
                'users' => DB::table('client_user')->where('client_id', $c->id)->pluck('user_id')->map(fn ($i) => $ini[$i] ?? null)->filter()->values(),
                'contacts' => DB::table('client_contacts')->where('client_id', $c->id)->get(['id', 'name', 'email', 'role', 'calendar_invites'])->map(fn ($k) => ['id' => $k->id, 'name' => $k->name, 'email' => $k->email, 'role' => $k->role, 'cal' => (bool) $k->calendar_invites]),
                'notices' => ['arrears' => (bool) $c->arrears_notice, 'payment' => (bool) $c->payment_notice]];
        });
        $mids = DB::table('messages')->whereIn('client_id', $cids)->pluck('id');
        $tasks = DB::table('tasks')->whereIn('message_id', $mids)->orderBy('id')->get()->groupBy('message_id');
        $notes = DB::table('notes')->whereIn('message_id', $mids)->orderBy('id')->get()->groupBy('message_id');
        $logs = DB::table('audit_events')->whereIn('message_id', $mids)->orderByDesc('id')->get()->groupBy('message_id');
        $apprs = DB::table('approvals')->whereIn('message_id', $mids)->orderByDesc('id')->get()->groupBy('message_id');
        $docs = DB::table('documents')->whereIn('message_id', $mids)->orderBy('id')->get()->groupBy('message_id');
        $read = DB::table('message_reads')->where('user_id', $u->id)->pluck('message_id')->flip();
        $notices = DB::table('client_notices')->whereIn('message_id', $mids)->orderByDesc('id')->get()->groupBy('message_id');
        $contacts = DB::table('client_contacts')->whereIn('client_id', $cids)->get()->groupBy('client_id');
        $btype = $boxes->pluck('type', 'id');
        $blive = $boxes->pluck('live_ref', 'id');
        $ownIds = DB::table('clients')->whereIn('id', $cids)->where('discovered_via', 'own')->pluck('id')->flip();
        $cnames = DB::table('clients')->whereIn('id', $cids)->pluck('name', 'id');
        $pairedSentByReceipt = DB::table('messages')->whereIn('client_id', $cids)->where('folder', 'ELKULDOTT')->whereNotNull('filing_receipt_id')->pluck('id', 'filing_receipt_id');
        $rawMessages = DB::table('messages')->whereIn('client_id', $cids)->orderByDesc('arrived_at')->get();
        $formTitles = FormCatalog::titlesForCodes($rawMessages->pluck('form_code')->filter()->all(), (array) $cids);
        $messages = $rawMessages->map(function ($m) use ($ini, $tasks, $notes, $logs, $apprs, $docs, $btype, $blive, $fmt, $read, $notices, $ownIds, $cnames, $pairedSentByReceipt, $formTitles) {
            $a = ($apprs[$m->id] ?? collect())->first();
            $eid = self::liveEid($m->source_id);
            $fc = ! empty($m->form_code) ? mb_strtoupper(trim((string) $m->form_code)) : null;
            $ft = $fc ? ($formTitles[$fc] ?? null) : null;

            return ['id' => "m{$m->id}", 'c' => "c{$m->client_id}", 'box' => $btype[$m->mailbox_id] ?? '?', 'liveBox' => $blive[$m->mailbox_id] ?? null, 'eid' => $eid, 'folder' => $m->folder ?? 'BEERKEZETT',
                's' => $m->sender, 'sf' => $m->sender_full, 'sub' => $m->subject,
                'recipient' => $m->recipient ?? null, 'recipientShort' => $m->recipient_short ?? null, 'refEid' => $m->ref_eid ?? null,
                'filingStatus' => $m->filing_status ?? null, 'filingReceiptId' => ! empty($m->filing_receipt_id) ? "m{$m->filing_receipt_id}" : null,
                'pairedSentId' => isset($pairedSentByReceipt[$m->id]) ? 'm'.$pairedSentByReceipt[$m->id] : null,
                'type' => $m->type_label, 'ai' => (bool) $m->type_ai, 'unknown' => (bool) $m->unknown, 'liveType' => $m->live_type ?? null, 'receipt' => (bool) $m->receipt, 'sys' => (bool) $m->system,
                'at' => $fmt($m->arrived_at), 'off' => $m->official, 'offAt' => $fmt($m->official_at), 'offBy' => $ini[$m->official_by] ?? null,
                'int' => $m->internal, 'unread' => ! isset($read[$m->id]), 'group' => $m->type_group, 'risk' => $m->type_risk, 'dlp' => DownloadPolicy::forMessage($m, (object) ['type' => $btype[$m->mailbox_id] ?? null]), 'hid' => (bool) $m->hidden,
                // Saját tárhelyről érkezett irat: hol van most, mi alapján került oda, és van-e (névegyezésen alapuló) javaslat.
                'rt' => isset($ownIds[$m->client_id]) || $m->routed_from_client_id ? ['basis' => $m->route_basis, 'inOwn' => isset($ownIds[$m->client_id]), 'manual' => (bool) $m->route_manual,
                    'suggest' => $m->route_suggest_client_id && isset($cnames[$m->route_suggest_client_id]) ? "c{$m->route_suggest_client_id}" : null,
                    'suggestName' => $m->route_suggest_client_id ? ($cnames[$m->route_suggest_client_id] ?? null) : null] : null, 'urgent' => (bool) $m->urgent, 'arch' => (bool) $m->archived, 'labels' => $m->label,
                'as' => $ini[$m->assignee_id] ?? null, 'legal' => $m->legal_date, 'dl' => $m->deadline_date ? ['d' => $m->deadline_date, 'sure' => (bool) $m->deadline_sure, 'src' => $m->deadline_source, 'excerpt' => $m->deadline_excerpt, 'past' => (bool) $m->past_deadline_warn, 'by' => $ini[$m->deadline_confirmed_by] ?? null] : null,
                'expiresAt' => $m->expires_at, 'portalOpened' => $m->portal_opened === null ? null : (bool) $m->portal_opened, 'durable' => (bool) ($m->durable ?? false), 'size' => $m->file_size !== null ? (int) $m->file_size : null,
                'formCode' => $m->form_code, 'formShort' => $ft['short'] ?? null, 'formTitle' => $ft['title'] ?? null, 'barcode' => $m->barcode,
                'es3' => (bool) $m->es3, 'att' => $m->att,
                'tasks' => ($tasks[$m->id] ?? collect())->map(fn ($t) => ['id' => $t->id, 't' => $t->title, 'who' => $ini[$t->user_id] ?? '?', 'done' => (bool) $t->done])->values(),
                'notes' => ($notes[$m->id] ?? collect())->map(fn ($n) => ['who' => $ini[$n->user_id] ?? '?', 't' => $n->body])->values(),
                'log' => ($logs[$m->id] ?? collect())->take(12)->map(fn ($l) => [substr(Carbon::parse($l->at_utc, 'UTC')->setTimezone(config('app.timezone'))->format('m. d. H:i'), 0), $l->actor_label.': '.$l->action])->values(),
                'appr' => $a && in_array($a->status, ['pending', 'blocked', 'rejected']) ? ['id' => $a->id, 'status' => $a->status, 'by' => $ini[$a->requested_by] ?? '?', 'note' => $a->result_note] : null,
                'docs' => ($docs[$m->id] ?? collect())->map(fn ($d) => ['id' => $d->id, 'parent' => $d->parent_id, 'name' => $d->name, 'mime' => $d->mime, 'size' => $d->size, 'sha' => $d->sha256, 'parse' => $d->parse_state, 'validity' => $d->validity, 'vnote' => $d->validity_note, 'meta' => json_decode($d->meta ?? 'null'), 'sigs' => json_decode($d->signatures ?? '[]'), 'vat' => $d->validated_at ? substr($d->validated_at, 0, 16) : null, 'preview' => ($d->text && $d->mime !== 'application/pdf' && ! self::isSheet($d)) ? mb_substr($d->text, 0, 4000) : null, 'sheet' => ($d->text && self::isSheet($d)) ? self::sheetRows($d->text) : null])->values(),
                'ft' => mb_strtolower(mb_substr(($docs[$m->id] ?? collect())->pluck('text')->filter()->implode(' '), 0, 4000)),
                'notices' => ($notices[$m->id] ?? collect())->map(fn ($n) => ['to' => $n->to_name, 'email' => $n->to_email, 'status' => $n->status, 'at' => $n->sent_at ? substr($n->sent_at, 0, 16) : null, 'by' => $ini[$n->sent_by] ?? null, 'subject' => $n->subject])->values(),
            ];
        });
        $cname = DB::table('clients')->whereIn('id', $cids)->pluck('name', 'id');
        $audit = Scope::seesAll($u)
            ? DB::table('audit_events')->where('office_id', $u->office_id)->where(fn ($q) => $q->whereNull('client_id')->orWhereNotIn('client_id', Scope::foreignOwnClientIds($u)))->orderByDesc('id')->limit(300)->get()
            : DB::table('audit_events')->where('office_id', $u->office_id)->where(fn ($q) => $q->whereIn('client_id', $cids)->orWhere('actor_id', $u->id))->orderByDesc('id')->limit(300)->get();
        // A NAV-portál legfrissebb pillanatképe: a belépő saját adószámlája magánadat, ezért csak a belépő gazdája kapja meg.
        $navSnap = DB::table('nav_snapshots')->where('office_id', $u->office_id)->get()->keyBy('portal_connection_id')->map(fn ($n) => [
            'total' => $n->total, 'debt' => $n->debt, 'surplus' => $n->surplus, 'deposit' => $n->deposit, 'unbooked' => $n->unbooked,
            'missing' => $n->missing_count, 'future' => $n->future_count, 'calendar' => $n->calendar_count, 'profiles' => (int) $n->profiles_count,
            'at' => substr((string) $n->fetched_at, 0, 16)]);
        $portals = DB::table('portal_connections')->where('office_id', $u->office_id)->orderBy('id')->get()->map(fn ($p) => [
            'nav' => (int) $p->owner_user_id === (int) $u->id ? ($navSnap[$p->id] ?? null) : null,
            'id' => $p->id, 'name' => $p->name, 'notes' => $p->notes, 'notifyEmail' => $p->notify_email,
            'authMode' => $p->auth_mode, 'vaultKey' => $p->vault_key, 'dlActive' => (bool) $p->download_active,
            'tarhelyState' => $p->tarhely_state, 'tarhelyAt' => $p->tarhely_at ? substr($p->tarhely_at, 5, 11) : null,
            'upoState' => $p->upo_state, 'upoAt' => $p->upo_at ? substr($p->upo_at, 5, 11) : null,
            'lastError' => $p->last_error,
            'systems' => ClientDiscovery::systemsOf($p), 'subjectScope' => ($p->subject_scope ?? 'all') === 'business' ? 'business' : 'all', 'selfIds' => (int) $p->owner_user_id === (int) $u->id || (! $p->owner_user_id && Scope::seesAll($u)) ? (json_decode((string) $p->self_identifiers, true) ?: []) : null, 'autoCreate' => (bool) $p->auto_create_clients, 'mine' => (int) $p->owner_user_id === (int) $u->id, 'owner' => $ini[$p->owner_user_id] ?? null,
        ])->values();
        // „Besorolásra vár”: a vezető és az admin mindet látja, más csak a saját belépőjéét.
        $discovered = DB::table('discovered_mailboxes')->where('discovered_mailboxes.office_id', $u->office_id)->where('state', 'pending')
            ->when(! Scope::seesAll($u), fn ($q) => $q->whereIn('portal_connection_id', DB::table('portal_connections')->where('owner_user_id', $u->id)->pluck('id')))
            ->orderBy('live_ref')->get()->map(fn ($x) => ['id' => $x->id, 'name' => $x->live_ref, 'tax8' => $x->tax8, 'parsedName' => $x->parsed_name, 'typeCode' => $x->type_code,
                'portalId' => $x->portal_connection_id !== null ? (int) $x->portal_connection_id : null, 'letters' => (int) $x->letters, 'seenAt' => $x->last_seen_at ? substr($x->last_seen_at, 5, 11) : null])->values();
        $payTax = DB::table('clients')->whereIn('id', $cids)->pluck('tax', 'id');
        $obligations = DB::table('tax_obligations')->whereIn('client_id', $cids)->orderBy('due_date')->orderBy('id')->get()->map(fn ($o) => [
            'pay' => $o->status === 'submitted' ? [] : TaxPayment::lines((string) $o->form_code, (string) ($payTax[$o->client_id] ?? '')),
            'id' => $o->id, 'c' => "c{$o->client_id}", 'source' => $o->source, 'formCode' => $o->form_code, 'title' => $o->title,
            'periodStart' => $o->period_start, 'periodEnd' => $o->period_end, 'dueDate' => $o->due_date,
            'conditional' => (bool) $o->conditional, 'status' => $o->status, 'barcode' => $o->barcode,
            'submittedAt' => $o->submitted_at, 'errorAt' => $o->error_at,
            'receiptMid' => $o->receipt_message_id ? "m{$o->receipt_message_id}" : null,
        ])->values();

        return response()->json([
            'today' => now()->toDateString(), 'now' => now()->format('H:i'),
            'cfg' => ['liveSent' => (bool) config('iratkapu.live_sent')],
            'me' => ['k' => $u->initials, 'name' => $u->name, 'role' => $u->role, 'email' => $u->email === self::LOCAL_EMAIL ? '' : $u->email],
            'office' => ['license' => \App\Iratkapu\TrialLicense::status($office), 'live_listing' => (bool) config('iratkapu.live_listing'), 'live_download' => (bool) config('iratkapu.live_download'), 'live_sent' => (bool) config('iratkapu.live_sent'), 'nav_switch' => (bool) config('iratkapu.nav_switch'), 'nav_queries' => (bool) config('iratkapu.nav_queries'), 'nav_exports' => (bool) config('iratkapu.nav_exports'), 'name' => $office->name, 'settings' => ['reminders' => OfficeMail::settings($office->id)['reminders'] ?? [5, 2, 1], 'reminderEmail' => ! empty(OfficeMail::settings($office->id)['reminder_email'])] + OfficeMail::office($office->id), 'mail' => Scope::seesAll($u) ? OfficeMail::summary($office->id) : ['configured' => OfficeMail::summary($office->id)['configured']], 'calendar' => $this->calendarState($u), 'mode' => config('iratkapu.mode'), 'single' => ! empty(OfficeMail::settings($office->id)['local']), 'onboarding' => (OfficeMail::settings($office->id)['onboarding'] ?? null) === 'pending', 'policy' => config('iratkapu.policy_version')],
            'people' => DB::table('users')->where('office_id', $u->office_id)->orderBy('id')->get()->map(fn ($p) => ['k' => $p->initials, 'name' => $p->name, 'role' => $p->role, 'email' => $p->email]),
            'clients' => $clients, 'messages' => $messages, 'portals' => $portals, 'obligations' => $obligations, 'discovered' => $discovered,
            // Önkormányzati portál (ASP): helyi adó adatok – a látott ügyfeleké, és a saját maga által beolvasott saját adat.
            'aspStatements' => AspController::visible($u),
            // NAV, C kör: a NAV szerint beadott bevallások ügyfelenként; `receipt`: megvan-e a tárhelyen a nyugtája. A párosítás
            // elsőként az iktatószám = vonalkód egyezés; élő adaton a nyugtáknak nincs vonalkódjuk, ezért másodikként a nyugta
            // tárgyából kiolvasott nyomtatványkód és időszak („2658, Elfogadó nyugta (…), 2026.09.01-2026.09.30, …”) egyezése.
            // `by`: 'regno' vagy 'period' – az utóbbi gyengébb: ugyanarra az időszakra beadott több bevallást nem különbözteti meg.
            // NAV, C kör: a NAV-nál nyilvántartott dokumentumok ügyfelenként (az elmúlt fél év), a legfrissebbek elöl.
            'navDocuments' => DB::table('nav_documents')->whereIn('client_id', $cids)->orderByDesc('arrived_at')->limit(1000)->get()->map(fn ($x) => ['c' => "c{$x->client_id}",
                'barcode' => $x->barcode, 'regNo' => $x->reg_no, 'subject' => $x->subject, 'docType' => $x->doc_type, 'formCode' => $x->form_code, 'formName' => $x->form_name,
                'caseType' => $x->case_type, 'caseNo' => $x->case_no, 'submittedAt' => $x->submitted_at, 'arrivedAt' => $x->arrived_at, 'files' => (int) $x->files])->values(),
            'navReturns' => (function () use ($cids) {
                $rows = DB::table('nav_returns')->whereIn('client_id', $cids)->orderByDesc('submitted_at')->limit(2000)->get();
                if ($rows->isEmpty()) {
                    return [];
                }
                $byNo = [];
                $byPeriod = [];
                foreach (DB::table('messages')->whereIn('client_id', $rows->pluck('client_id')->unique()->all())->where('receipt', true)->get(['id', 'client_id', 'barcode', 'subject']) as $m) {
                    if ($m->barcode) {
                        $byNo["{$m->client_id}|{$m->barcode}"] ??= $m->id;
                    }
                    if (preg_match('/^\s*([0-9A-Za-z][0-9A-Za-z_-]{1,31})\s*,.*?(\d{4})\.(\d{2})\.(\d{2})\.?\s*-\s*(\d{4})\.(\d{2})\.(\d{2})/u', (string) $m->subject, $x)) {
                        $byPeriod["{$m->client_id}|".strtoupper($x[1])."|$x[2]-$x[3]-$x[4]|$x[5]-$x[6]-$x[7]"] ??= $m->id;
                    }
                }

                return $rows->map(function ($x) use ($byNo, $byPeriod) {
                    // A NAV-nál törölt bevallás nem él: nyugtát nem keresünk hozzá (az időszakos egyezés a helyette beadott bevallásé).
                    $deleted = mb_strtolower((string) $x->state) === 'törölt';
                    $mid = $deleted ? null : ($byNo["{$x->client_id}|{$x->reg_no}"] ?? null);
                    $by = $mid ? 'regno' : null;
                    if (! $mid && ! $deleted && $x->period_from && $x->period_to) {
                        $mid = $byPeriod["{$x->client_id}|".strtoupper($x->form_code).'|'.substr($x->period_from, 0, 10).'|'.substr($x->period_to, 0, 10)] ?? null;
                        $by = $mid ? 'period' : null;
                    }

                    return ['c' => "c{$x->client_id}", 'regNo' => $x->reg_no, 'formCode' => $x->form_code, 'title' => $x->title, 'from' => $x->period_from ? substr($x->period_from, 0, 10) : null, 'to' => $x->period_to ? substr($x->period_to, 0, 10) : null,
                        'at' => $x->submitted_at, 'state' => $x->state, 'deleted' => $deleted, 'receipt' => $mid ? "m$mid" : null, 'by' => $by];
                })->values();
            })(),
            // A saját tárhely leveleiből ajánlott felek: a tárhely magán, ezért csak a belépő gazdája látja.
            'subjects' => DB::table('discovered_subjects')->join('portal_connections', 'portal_connections.id', '=', 'discovered_subjects.portal_connection_id')
                ->where('discovered_subjects.office_id', $u->office_id)->where('discovered_subjects.state', 'pending')->where('portal_connections.owner_user_id', $u->id)
                ->orderByDesc('discovered_subjects.letters')->limit(200)->get(['discovered_subjects.*'])
                ->map(fn ($x) => ['id' => $x->id, 'identifier' => $x->identifier, 'kind' => $x->kind, 'name' => $x->parsed_name, 'letters' => (int) $x->letters, 'portalId' => (int) $x->portal_connection_id, 'source' => $x->source ?? 'mail'])->values(),
            'rules' => DB::table('rules')->where('office_id', $u->office_id)->orderBy('position')->get()->map(fn ($r) => ['id' => $r->id, 'n' => $r->name, 'pri' => $r->priority, 'as' => $ini[$r->assignee_id] ?? '', 'notify' => $r->notify, 'dlMode' => $r->download_mode ?? 'manual', 'v' => $r->version, 'locked' => (bool) $r->locked]),
            'syncs' => $boxes->map(fn ($b) => ['live' => $b->live_ref, 'liveAt' => $b->live_listed_at ? substr($b->live_listed_at, 5, 11) : null, 'portalId' => $b->portal_connection_id, 'quotaPct' => $b->quota_pct !== null ? (float) $b->quota_pct : null, 'id' => $b->id, 'c' => "c{$b->client_id}", 'b' => $b->type, 'st' => $b->sync_state, 'note' => $b->sync_note ?? 'Még nem futott', 'at' => $b->last_ok_at ? substr($b->last_ok_at, 5, 11) : '–'])->values(),
            'audit' => $audit->map(fn ($a) => [Carbon::parse($a->at_utc, 'UTC')->setTimezone(config('app.timezone'))->format('Y-m-d H:i'), $a->actor_label, $a->action, $cname[$a->client_id] ?? 'Iroda', $a->evidence ?? '–', $a->policy ?? '–']),
            'approvals' => DB::table('approvals')->where('office_id', $u->office_id)->where('status', 'pending')->whereIn('message_id', $mids)->get()->map(fn ($a) => ['id' => $a->id, 'mid' => "m{$a->message_id}", 'by' => $ini[$a->requested_by] ?? '?', 'mine' => $a->requested_by === $u->id]),
            'notifications' => DB::table('notifications')->where('user_id', $u->id)->where('kind', '!=', 'osszesito')->orderByDesc('id')->limit(30)->get()->map(fn ($n) => ['id' => $n->id, 'kind' => $n->kind, 'body' => $n->body, 'mid' => $n->message_id ? "m{$n->message_id}" : null, 'at' => substr($n->created_at, 5, 11), 'read' => (bool) $n->read_at]),
            'views' => DB::table('saved_views')->where('office_id', $u->office_id)->where(fn ($q) => $q->where('user_id', $u->id)->orWhere('shared', true))->get()->map(fn ($v) => ['id' => $v->id, 'name' => $v->name, 'f' => json_decode($v->filters), 'shared' => (bool) $v->shared, 'mine' => $v->user_id === $u->id]),
            'policies' => config('iratkapu.operations'),
            'types' => DB::table('document_types')->where(fn ($q) => $q->whereNull('office_id')->orWhere('office_id', $u->office_id))->orderBy('label')->get(['type_id', 'label', 'group', 'priority', 'risk', 'version', 'download_policy', 'office_id', 'patterns'])
                ->map(fn ($t) => ['type_id' => $t->type_id, 'label' => $t->label, 'group' => $t->group, 'priority' => $t->priority, 'risk' => $t->risk, 'version' => $t->version,
                    'custom' => $t->office_id !== null, 'patterns' => $t->office_id !== null ? json_decode($t->patterns, true) : [],
                    'dlp' => DownloadPolicy::forType($u->office_id, $t->type_id), 'dlpDefault' => $t->download_policy, 'settings' => TypeSettings::for($u->office_id, $t->type_id)]),
        ]);
    }

    private function mid(string $id): int
    {
        return (int) ltrim($id, 'mc');
    }

    private function uid(?string $k): ?int
    {
        return $k ? DB::table('users')->where('office_id', $this->u()->office_id)->where('initials', $k)->value('id') : null;
    }

    public function messageAction(Request $r, string $id)
    {
        $u = $this->u();
        $m = Scope::message($u, $this->mid($id));
        $a = $r->input('action');
        $upd = [];
        $log = null;
        switch ($a) {
            case 'me': $upd = ['assignee_id' => $u->id];
                if (in_array($m->internal, ['uj', 'oszt']) && ! $m->unknown) {
                    $upd['internal'] = 'kiosztott';
                } $log = "Kiosztva: {$u->name}";
                break;
            case 'assign': $to = $this->uid($r->input('to'));
                abort_if(! $to, 422);
                abort_if(! in_array($m->client_id, Scope::clientIds(DB::table('users')->find($to))), 422, 'Ez a munkatárs nem fér hozzá ehhez az ügyfélhez.');
                $upd = ['assignee_id' => $to];
                if ($m->internal === 'uj') {
                    $upd['internal'] = 'kiosztott';
                } $log = 'Kiosztva: '.DB::table('users')->where('id', $to)->value('name');
                break;
            case 'read': // saját, belső jelölés; a hivatalos állapothoz nem nyúl
                if (DB::table('message_reads')->where(['message_id' => $m->id, 'user_id' => $u->id])->delete() === 0) {
                    DB::table('message_reads')->insert(['message_id' => $m->id, 'user_id' => $u->id, 'read_at' => now()]);
                }

                return ['ok' => true];
            case 'markread': DB::table('message_reads')->insertOrIgnore(['message_id' => $m->id, 'user_id' => $u->id, 'read_at' => now()]);

                return ['ok' => true];
            case 'urgent': $upd = ['urgent' => ! $m->urgent];
                $log = $m->urgent ? 'Sürgős jelölés levéve' : 'Sürgősnek jelölve';
                break;
            case 'done':
                if ($m->internal === 'kesz') {
                    $upd = ['internal' => 'folyamatban'];
                    $log = 'Újranyitva';
                } else {
                    abort_if($m->official === 'wait', 422, 'Átvételre váró irat nem zárható le készként.');
                    $upd = ['internal' => 'kesz'];
                    DB::table('message_reads')->insertOrIgnore(['message_id' => $m->id, 'user_id' => $u->id, 'read_at' => now()]);
                    $log = 'Késznek jelölve';
                }
                break;
            case 'status': $s = $r->input('to');
                abort_if(! in_array($s, ['uj', 'oszt', 'kiosztott', 'folyamatban', 'ell', 'kesz']), 422);
                abort_if($s === 'kesz' && $m->official === 'wait', 422, 'Átvételre váró irat nem zárható le készként.');
                $upd = ['internal' => $s];
                $log = "Belső állapot: $s";
                break;
            case 'arch': $upd = ['archived' => ! $m->archived];
                $log = $m->archived ? 'Visszaállítva az archívumból' : 'Belső archívumba helyezve';
                break;
            case 'label': $upd = ['label' => $r->input('to') ?: null];
                break;
            case 'type': $tt = DB::table('document_types')->where('label', $r->input('to'))->where(fn ($q) => $q->whereNull('office_id')->orWhere('office_id', $m->office_id))->first();
                abort_if(trim((string) $r->input('to')) === '', 422);
                // Az átsorolás a letöltési szabályt is átállítja (ADR-009): lazább szabályú típusra csak vezető vagy admin sorolhat át.
                $pOld = DownloadPolicy::forType($m->office_id, $m->type_id);
                $pNew = DownloadPolicy::forType($m->office_id, $tt->type_id ?? null);
                abort_if(DownloadPolicy::RANK[$pNew] < DownloadPolicy::RANK[$pOld] && ! Scope::seesAll($u), 403, 'Lazább letöltési szabályú típusra csak vezető vagy admin sorolhat át.');
                $upd = ['type_label' => (string) $r->input('to'), 'type_id' => $tt->type_id ?? Str::slug($r->input('to')), 'type_group' => $tt->group ?? null, 'type_risk' => $tt->risk ?? null, 'unknown' => false, 'type_ai' => false];
                if ($m->internal === 'oszt') {
                    $upd['internal'] = 'uj';
                } $log = 'Irattípus besorolva: '.$r->input('to').($pOld !== $pNew ? " (letöltési szabály: $pOld → $pNew)" : '');
                break;
            case 'confirm': abort_if(! $m->deadline_date, 422);
                $upd = ['deadline_sure' => true, 'deadline_confirmed_by' => $u->id, 'assignee_id' => $m->assignee_id ?? $u->id];
                $log = 'Határidő megerősítve';
                break;
            case 'deadline': $d = $r->validate(['to' => 'required|date'])['to'];
                abort_if($m->official === 'wait', 422, 'Át nem vett iratnak nem adható határidő.');
                $upd = ['deadline_date' => $d, 'deadline_sure' => true, 'deadline_confirmed_by' => $u->id, 'deadline_source' => 'Kézzel rögzítve az irat alapján'];
                $log = "Határidő rögzítve: $d";
                break;
            default: abort(422, 'Ismeretlen művelet.');
        }
        DB::table('messages')->where('id', $m->id)->update($upd + ['updated_at' => now()]);
        if ($log) {
            Audit::log($u->office_id, $u, $log, ['client_id' => $m->client_id, 'message_id' => $m->id]);
        }

        return ['ok' => true];
    }

    public function bulk(Request $r)
    {
        $skipped = 0;
        foreach ((array) $r->input('ids') as $id) {
            $m = Scope::message($this->u(), $this->mid($id));
            $a = $r->input('action');
            abort_if(! in_array($a, ['me', 'markread', 'done']), 422, 'Tömegesen csak belső művelet végezhető.');
            if ($a === 'done' && ($m->official === 'wait' || $m->internal === 'kesz')) {
                $skipped++;

                continue;
            }
            $this->messageAction(new Request(['action' => $a]), $id);
        }

        return ['ok' => true, 'skipped' => $skipped];
    }

    public function addTask(Request $r, string $id)
    {
        $u = $this->u();
        $m = Scope::message($u, $this->mid($id));
        $t = $r->validate(['title' => 'required|string|max:200'])['title'];
        DB::table('tasks')->insert(['office_id' => $u->office_id, 'message_id' => $m->id, 'title' => $t, 'user_id' => $u->id, 'created_at' => now(), 'updated_at' => now()]);
        if ($m->internal === 'kiosztott') {
            DB::table('messages')->where('id', $m->id)->update(['internal' => 'folyamatban']);
        }
        Audit::log($u->office_id, $u, "Teendő felvéve: $t", ['client_id' => $m->client_id, 'message_id' => $m->id]);

        return ['ok' => true];
    }

    public function toggleTask(Request $r, int $id)
    {
        $t = DB::table('tasks')->where('office_id', $this->u()->office_id)->find($id);
        abort_if(! $t, 404);
        Scope::message($this->u(), $t->message_id);
        DB::table('tasks')->where('id', $id)->update(['done' => (bool) $r->input('done')]);

        return ['ok' => true];
    }

    public function addNote(Request $r, string $id)
    {
        $u = $this->u();
        $m = Scope::message($u, $this->mid($id));
        DB::table('notes')->insert(['office_id' => $u->office_id, 'message_id' => $m->id, 'user_id' => $u->id, 'body' => $r->validate(['body' => 'required|string|max:2000'])['body'], 'created_at' => now(), 'updated_at' => now()]);

        return ['ok' => true];
    }

    /** Átvétel KÉRÉSE. Maga a kérés semmit nem vesz át. */
    public function requestReceive(string $id)
    {
        $u = $this->u();
        $m = Scope::message($u, $this->mid($id));
        abort_if($m->official === 'listed', 422, 'Élő listából érkezett iratot ez az alkalmazás nem vesz át: a hivatalos tárhelyen nyisd meg.');
        abort_if($m->official !== 'wait', 422, 'Ez az irat nem vár átvételre.');
        abort_if(($au = DB::table('clients')->where('id', $m->client_id)->value('auth_until')) && $au < now()->toDateString(), 422, 'A meghatalmazás lejárt ennél az ügyfélnél.');
        abort_if(DB::table('mailboxes')->where('id', $m->mailbox_id)->value('sync_state') === 'need', 422, 'A tárhely hitelesítése lejárt; előbb újrahitelesítés kell.');
        abort_if(DB::table('approvals')->where('message_id', $m->id)->where('status', 'pending')->exists(), 422, 'Már van függő kérés.');
        $aid = DB::table('approvals')->insertGetId(['office_id' => $u->office_id, 'message_id' => $m->id, 'operation' => 'download', 'requested_by' => $u->id, 'created_at' => now(), 'updated_at' => now()]);
        if (! $m->assignee_id) {
            DB::table('messages')->where('id', $m->id)->update(['assignee_id' => $u->id]);
        }
        Audit::log($u->office_id, $u, 'Átvétel kérve', ['client_id' => $m->client_id, 'message_id' => $m->id, 'evidence' => "jóváhagyás #$aid", 'policy' => config('iratkapu.policy_version')]);
        foreach (DB::table('users')->where('office_id', $u->office_id)->whereIn('role', ['vezeto', 'admin'])->where('id', '!=', $u->id)->pluck('id') as $uid) {
            Notify::once($u->office_id, $uid, $m->id, 'jovahagyas', "Átvételi kérés jóváhagyásra vár: {$m->subject}", "appr-$aid-$uid");
        }

        return ['ok' => true];
    }

    public function decide(Request $r, int $id)
    {
        $u = $this->u();
        $a = DB::table('approvals')->where('office_id', $u->office_id)->find($id);
        abort_if(! $a || $a->status !== 'pending', 404);
        $m = Scope::message($u, $a->message_id);
        abort_if(! Scope::seesAll($u), 403, 'Átvételt csak vezető vagy admin hagyhat jóvá.');
        abort_if($a->requested_by === $u->id, 403, 'A saját kérésedet nem hagyhatod jóvá.');
        $ok = (bool) $r->input('approve');
        DB::table('approvals')->where('id', $id)->update(['status' => $ok ? 'approved' : 'rejected', 'decided_by' => $u->id, 'decided_at' => now(), 'updated_at' => now()]);
        Audit::log($u->office_id, $u, $ok ? 'Átvétel jóváhagyva' : 'Átvételi kérés elutasítva', ['client_id' => $m->client_id, 'message_id' => $m->id, 'evidence' => "jóváhagyás #$id", 'policy' => config('iratkapu.policy_version')]);
        $note = $ok ? Receiving::execute(DB::table('approvals')->find($id), $u) : 'Elutasítva.';
        Notify::once($u->office_id, $a->requested_by, $m->id, 'jovahagyas', ($ok ? 'Jóváhagyva' : 'Elutasítva').": {$m->subject} – $note", "apprres-$id");

        return ['ok' => true, 'note' => $note];
    }

    public function syncNow(Request $r)
    {
        $u = $this->u();
        $out = ['created' => 0, 'need' => 0];
        $q = DB::table('mailboxes')->whereIn('client_id', Scope::clientIds($u));
        if ($r->filled('mailbox')) {
            $q->where('id', (int) $r->input('mailbox'));
        }
        foreach ($q->get() as $mb) {
            $res = SyncService::run($mb, $u, (bool) $r->input('advance', true));
            $out['created'] += $res['created'];
            $out['need'] += $res['state'] === 'need' ? 1 : 0;
        }
        Notify::reminders($u->office_id);

        return $out;
    }

    public function reauth(int $id)
    {
        $u = $this->u();
        $mb = DB::table('mailboxes')->where('office_id', $u->office_id)->whereIn('client_id', Scope::clientIds($u))->find($id);
        abort_if(! $mb, 404);
        abort_if(config('iratkapu.mode') !== 'demo', 422, 'Élő hitelesítés nincs bekötve.');
        DB::table('mailboxes')->where('id', $id)->update(['sync_state' => 'queue', 'sync_note' => 'Újrahitelesítve (demó) – szinkronra vár']);
        Audit::log($u->office_id, $u, 'Tárhely újrahitelesítve (demó)', ['client_id' => $mb->client_id]);
        SyncService::run(DB::table('mailboxes')->find($id), $u);

        return ['ok' => true];
    }

    public function ruleDry(Request $r, int $id)
    {
        $u = $this->u();
        $rule = DB::table('rules')->where('office_id', $u->office_id)->find($id);
        abort_if(! $rule, 404);
        $hits = DB::table('messages')->whereIn('client_id', Scope::clientIds($u))->where('archived', false)->get()->filter(fn ($m) => RuleEngine::matches($rule, $m))->pluck('id')->map(fn ($i) => "m$i")->values();

        return ['hits' => $hits]; // csak olvas: semmit nem ír, értesítést nem küld
    }

    public function ruleSave(Request $r, int $id)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403, 'Szabályt csak vezető vagy admin menthet.');
        $rule = DB::table('rules')->where('office_id', $u->office_id)->find($id);
        abort_if(! $rule, 404);
        $d = $r->validate([
            'pri' => 'required|in:Sürgős,Normál,Alacsony',
            'as' => 'nullable|string',
            'notify' => 'required|in:Nincs,Felelősnek azonnal,Vezetőnek azonnal,Reggeli összesítő',
            'dlMode' => 'nullable|in:manual,auto_safe,auto_override_legal',
        ]);
        $dlMode = $d['dlMode'] ?? ($rule->download_mode ?? 'manual');
        $upd = ['notify' => $d['notify'], 'download_mode' => $dlMode, 'version' => $rule->version + 1, 'updated_at' => now()];
        if (! $rule->locked) {
            $upd += ['priority' => $d['pri'], 'assignee_id' => $this->uid($d['as'] ?? null)];
        }
        DB::table('rules')->where('id', $id)->update($upd);
        DB::table('rule_versions')->insert(['rule_id' => $id, 'version' => $upd['version'], 'data' => json_encode($upd), 'saved_by' => $u->id, 'created_at' => now(), 'updated_at' => now()]);
        $ev = $dlMode === 'auto_override_legal' ? 'joghatályos automatikus letöltés felülírása engedélyezve' : null;
        Audit::log($u->office_id, $u, "Szabály mentve: {$rule->name}, {$upd['version']}. verzió", ['policy' => "szabály #$id v{$upd['version']}", 'evidence' => $ev]);

        return ['ok' => true, 'version' => $upd['version']];
    }

    /** Magánszemély adóazonosító jele: 10 jegy, 8-assal kezdődik, a 10. jegy az első kilenc helyiértékkel súlyozott összegének 11-es maradéka. */
    private static function validTaxId(string $v): bool
    {
        if (! preg_match('/^8\d{9}$/', $v)) {
            return false;
        }
        $sum = 0;
        for ($i = 0; $i < 9; $i++) {
            $sum += (int) $v[$i] * ($i + 1);
        }

        return $sum % 11 === (int) $v[9];
    }

    /** Ügyfelek a 8 jegyű adószám-törzs szerint. Az adóazonosító jellel felvett magánszemély kimarad: az ő azonosítójának eleje nem adószám-törzs. */
    public function addClient(Request $r)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403, 'Tárhelyet csak vezető vagy admin csatlakoztathat.');
        $d = $r->validate(['name' => ['required', 'string', 'max:120', 'not_regex:/[<>]/'], 'tax' => 'required|string|max:16', 'type' => 'required|in:ÜK,CK,HK', 'auth_until' => 'nullable|date|after:today', 'authorized' => 'accepted']);
        // Ügyfélkapunál a magánszemélynek nincs adószáma: ott a 10 jegyű adóazonosító jel is elfogadott
        $isTaxNumber = (bool) preg_match('/^\d{8}-\d-\d{2}$/', $d['tax']);
        if ($d['type'] === 'ÜK') {
            abort_if(! $isTaxNumber && ! self::validTaxId($d['tax']), 422, 'Adószámot (12345678-1-12) vagy érvényes, 10 jegyű adóazonosító jelet adj meg.');
        } else {
            abort_if(! $isTaxNumber, 422, 'Az adószám formátuma: 12345678-1-12.');
        }
        abort_if(DB::table('clients')->where('office_id', $u->office_id)->where('tax', $d['tax'])->exists(), 422, $isTaxNumber ? 'Ezzel az adószámmal már van ügyfél.' : 'Ezzel az adóazonosító jellel már van ügyfél.');
        $cid = DB::table('clients')->insertGetId(['office_id' => $u->office_id, 'name' => $d['name'], 'tax' => $d['tax'], 'auth_until' => $d['auth_until'] ?? null, 'created_at' => now(), 'updated_at' => now()]);
        $mid = DB::table('mailboxes')->insertGetId(['office_id' => $u->office_id, 'client_id' => $cid, 'type' => $d['type'], 'credential_ref' => 'os-vault://iratkapu/mailbox-pending', 'created_at' => now(), 'updated_at' => now()]);
        Audit::log($u->office_id, $u, "Ügyfél és tárhely felvéve: {$d['name']} ({$d['type']})", ['client_id' => $cid, 'evidence' => 'meghatalmazás megerősítve a varázslóban']);
        $res = SyncService::run(DB::table('mailboxes')->find($mid), $u);

        return ['ok' => true, 'id' => "c$cid", 'listed' => $res['listed']];
    }

    /**
     * A saját tárhelyről érkezett irat kézi átsorolása másik ügyfélhez, vagy visszatétele a saját tárhelyre (`to: own`).
     * Amit ember egyszer besorolt, azt a program többé nem sorolja át. Visszatétel után az iratot csak a belépő gazdája látja.
     */
    public function reassignMessage(Request $r, string $id)
    {
        $u = $this->u();
        $m = Scope::message($u, $this->mid($id));
        $to = $r->validate(['to' => ['required', 'string', 'regex:/^(own|c\d+)$/']])['to'];
        $current = DB::table('clients')->find($m->client_id);
        $originId = $m->routed_from_client_id ?: ($current->discovered_via === 'own' ? $current->id : null);
        abort_if(! $originId, 422, 'Csak a saját tárhelyről érkezett irat sorolható át.');
        $origin = DB::table('clients')->where('office_id', $u->office_id)->find($originId);
        $ownerId = $origin && $origin->portal_connection_id ? (int) DB::table('portal_connections')->where('id', $origin->portal_connection_id)->value('owner_user_id') : 0;
        if ($to === 'own') {
            abort_if((int) $m->client_id === (int) $originId, 422, 'Az irat most is a saját tárhelyen van.');
            // Visszatétel után az iratot csak a tárhely gazdája látja: ezt csak a gazda, vezető vagy admin teheti meg.
            abort_if(! Scope::seesAll($u) && $ownerId !== (int) $u->id, 403, 'A saját tárhelyre csak a tárhely gazdája, vezető vagy admin tehet vissza iratot.');
            $target = $origin;
            abort_if(! $target, 404);
        } else {
            $target = Scope::client($u, $this->mid($to));
            abort_if($target->discovered_via === 'own', 422, 'Saját tárhely gyűjtője nem lehet az átsorolás célja.');
            abort_if(! $target->active, 422, 'Inaktív ügyfélhez nem sorolható irat.');
        }
        $upd = ['client_id' => $target->id, 'routed_from_client_id' => $to === 'own' ? null : $originId, 'route_basis' => $to === 'own' ? null : 'kézi besorolás',
            'route_suggest_client_id' => null, 'route_manual' => true, 'updated_at' => now()];
        // A felelős csak olyan lehet, aki az új helyén is látja az iratot.
        if ($m->assignee_id && ! Scope::userSeesClient((int) $m->assignee_id, (int) $target->id)) {
            $upd['assignee_id'] = null;
            $upd['internal'] = 'uj';
        }
        DB::table('messages')->where('id', $m->id)->update($upd);
        $fromName = $current->discovered_via === 'own' ? 'saját tárhely' : $current->name;
        $toName = $to === 'own' ? 'saját tárhely' : $target->name;
        Audit::log($u->office_id, $u, "Irat átsorolva: $fromName → $toName (kézi)", ['client_id' => $target->id, 'message_id' => $m->id, 'before' => "c{$current->id}", 'after' => "c{$target->id}"]);
        // Aki az új helyén már nem látja az iratot, annak a róla szóló értesítése is eltűnik (a tárgy ne maradjon nála).
        foreach (DB::table('notifications')->where('message_id', $m->id)->pluck('user_id', 'id') as $nid => $uid) {
            if (! Scope::userSeesClient((int) $uid, (int) $target->id)) {
                DB::table('notifications')->where('id', $nid)->delete();
            }
        }
        // A nyugtapárosítás az ügyfélhez kötött: a régi helyén megszűnik, az új helyén (ha ügyfél) újra megpróbáljuk.
        DB::table('tax_obligations')->where('receipt_message_id', $m->id)->where('client_id', '!=', $target->id)->update(['receipt_message_id' => null, 'updated_at' => now()]);
        if ($to !== 'own') {
            DeadlineExtractor::pairObligation(DB::table('messages')->find($m->id));
        }
        if ($to === 'own' && $ownerId && $ownerId !== (int) $u->id) {
            Notify::once($u->office_id, $ownerId, $m->id, 'szabaly', "Egy irat visszakerült a saját tárhelyedre: {$m->subject}", "own-back-{$m->id}-".now()->timestamp);
        }

        return ['ok' => true, 'clientId' => "c{$target->id}"];
    }

    /** Az ügyfélnek menő hátralék-értesítő és fizetési emlékeztető ki- és bekapcsolása (vezető vagy admin). */
    public function setClientNotices(Request $r, string $id)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403, 'Az ügyfélnek menő értesítőket csak vezető vagy admin kapcsolhatja.');
        $c = Scope::client($u, $this->mid($id));
        $d = $r->validate(['arrears' => 'boolean', 'payment' => 'boolean']);
        $patch = [];
        $names = [];
        if ($r->has('arrears')) {
            $patch['arrears_notice'] = (bool) $d['arrears'];
            $names[] = 'hátralék-értesítő '.($d['arrears'] ? 'be' : 'ki');
        }
        if ($r->has('payment')) {
            $patch['payment_notice'] = (bool) $d['payment'];
            $names[] = 'fizetési emlékeztető '.($d['payment'] ? 'be' : 'ki');
        }
        if ($patch) {
            DB::table('clients')->where('id', $c->id)->update($patch + ['updated_at' => now()]);
        }
        Audit::log($u->office_id, $u, "Ügyfélnek menő értesítők módosítva: {$c->name}, ".($names ? implode(', ', $names) : 'nincs változás'), ['client_id' => $c->id]);
        $c = DB::table('clients')->find($c->id);

        return ['ok' => true, 'notices' => ['arrears' => (bool) $c->arrears_notice, 'payment' => (bool) $c->payment_notice]];
    }

    /** Ügyfél inaktívvá tétele vagy visszakapcsolása. Az inaktív ügyfél nem törlődik, de a szinkron kihagyja. */
    public function setClientActive(Request $r, string $id)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403, 'Ügyfelet csak vezető vagy admin tehet inaktívvá.');
        $c = Scope::client($u, $this->mid($id));
        $active = (bool) $r->validate(['active' => 'required|boolean'])['active'];
        DB::table('clients')->where('id', $c->id)->update(['active' => $active, 'updated_at' => now()]);
        Audit::log($u->office_id, $u, $active ? "Ügyfél újra aktív: {$c->name}" : "Ügyfél inaktívvá téve: {$c->name}", ['client_id' => $c->id]);

        return ['ok' => true, 'active' => $active];
    }

    /**
     * „Besorolásra vár” postafiók elintézése: meglévő ügyfélhez rendelés, a belépő saját tárhelyének jelölése,
     * új ügyfél felvétele vagy kihagyás. A korábban kimaradt levelek a következő listázással jönnek be.
     */
    public function resolveDiscovered(Request $r, int $id)
    {
        $u = $this->u();
        $row = DB::table('discovered_mailboxes')->where('office_id', $u->office_id)->where('state', 'pending')->find($id);
        abort_if(! $row, 404);
        $portal = $row->portal_connection_id ? DB::table('portal_connections')->where('office_id', $u->office_id)->find($row->portal_connection_id) : null;
        abort_if(! ClientDiscovery::canDiscover($u, $portal), 403, 'Ezt a postafiókot csak vezető, admin vagy a belépő gazdája sorolhatja be.');
        $d = $r->validate(['action' => 'required|in:assign,own,create,ignore', 'clientId' => 'nullable|string', 'name' => 'nullable|string|max:120',
            'tax' => 'nullable|string|max:16', 'type' => 'nullable|in:ÜK,CK,HK', 'authorized' => 'nullable|boolean']);
        $taken = DB::table('mailboxes')->where('office_id', $u->office_id)->where('live_ref', $row->live_ref)->exists();
        if ($taken) {
            ClientDiscovery::settle($u->office_id, $row->live_ref);
        }
        abort_if($taken && $d['action'] !== 'ignore', 422, 'Ez az élő postafiók már hozzá van rendelve egy tárhelyhez.');
        if ($taken) {
            return ['ok' => true, 'clientId' => null];
        }
        $safeRef = ClientDiscovery::clean($row->live_ref);
        $client = null;
        $log = 'Élő postafiók kihagyva a besorolásból';
        switch ($d['action']) {
            case 'assign':
                $client = Scope::client($u, $this->mid((string) ($d['clientId'] ?? '')));
                abort_if($client->discovered_via === 'own', 422, 'A saját tárhely gyűjtőjéhez nem rendelhető másik postafiók.');
                ClientDiscovery::newMailbox($client, $portal, $row->live_ref, $d['type'] ?? 'CK');
                $log = "Élő postafiók ügyfélhez rendelve: $safeRef";
                break;
            case 'own':
                abort_if(! $portal, 422, 'Ehhez a postafiókhoz nem tartozik belépő.');
                abort_if($portal->owner_user_id ? (int) $portal->owner_user_id !== (int) $u->id : ! Scope::seesAll($u), 403, 'A belépő saját tárhelyét csak a belépő gazdája jelölheti meg.');
                if (! $portal->owner_user_id) { // régi, gazda nélküli belépő: aki saját tárhelyként jelöli meg, az lesz a gazdája
                    DB::table('portal_connections')->where('id', $portal->id)->update(['owner_user_id' => $u->id, 'updated_at' => now()]);
                    $portal->owner_user_id = $u->id;
                }
                $client = ClientDiscovery::ownCollector($u, $portal);
                ClientDiscovery::newMailbox($client, $portal, $row->live_ref, 'ÜK');
                $log = "Élő postafiók megjelölve a belépő saját tárhelyeként: $safeRef";
                break;
            case 'create':
                abort_if(empty($d['authorized']), 422, 'Új ügyfél felvételéhez meg kell erősíteni a meghatalmazást.');
                $name = ClientDiscovery::clean((string) ($d['name'] ?? ''));
                $tax = trim((string) ($d['tax'] ?? ''));
                $type = $d['type'] ?? 'CK';
                abort_if($name === '', 422, 'Add meg az ügyfél nevét.');
                $isTaxNumber = (bool) preg_match('/^\d{8}-\d-\d{2}$/', $tax);
                abort_if(! $isTaxNumber && ! ($type === 'ÜK' && self::validTaxId($tax)), 422, 'Az adószám formátuma: 12345678-1-12.');
                abort_if(DB::table('clients')->where('office_id', $u->office_id)->where('tax', $tax)->exists(), 422, 'Ezzel az azonosítóval már van ügyfél.');
                // Azonos adószám-törzzsel nem lehet két ügyfél: a párosítás (postafiók, NAV-kötelezettség) a törzsre épül.
                abort_if($isTaxNumber && DB::table('clients')->where('office_id', $u->office_id)->where('tax', 'like', substr($tax, 0, 8).'%')->where('tax', 'not like', '8_________')->exists(), 422, 'Ezzel az adószám-törzzsel már van ügyfél az irodában. Ha nem látod, kérd a vezetőt, hogy rendelje hozzád vagy sorolja be a postafiókot.');
                $cid = DB::table('clients')->insertGetId(['office_id' => $u->office_id, 'name' => $name, 'tax' => $tax, 'auth_until' => null,
                    'portal_connection_id' => $portal->id ?? null, 'created_at' => now(), 'updated_at' => now()]);
                $client = DB::table('clients')->find($cid);
                if (! Scope::seesAll($u)) {
                    DB::table('client_user')->insertOrIgnore(['client_id' => $cid, 'user_id' => $u->id]);
                }
                ClientDiscovery::newMailbox($client, $portal, $row->live_ref, $type);
                $log = "Ügyfél felvéve besorolásra váró postafiókból: $name";
                break;
        }
        DB::table('discovered_mailboxes')->where('id', $row->id)->update(['state' => $d['action'] === 'ignore' ? 'ignored' : 'assigned', 'updated_at' => now()]);
        Audit::log($u->office_id, $u, $log, ['client_id' => $client->id ?? null, 'evidence' => "postafiók: $safeRef"]);

        return ['ok' => true, 'clientId' => $client ? "c{$client->id}" : null];
    }

    /**
     * NAV ügyfélportál, „A kör” (ADR-010): az asztali app által a belépő SAJÁT nevében, csak olvasással kiolvasott adatok.
     * A belépő saját adószámlája magánadat, ezért csak a belépő gazdája küldheti be és láthatja. A képviselt adózókból
     * ügyfél magától nem jön létre: az ismertnél rögzül, hogy a NAV szerint képviselt, az ismeretlen ajánlat lesz.
     * Az adónaptár és a hiányzó bevallások tételei (`obligations`) ahhoz az adózóhoz kerülnek, akit a NAV-munkamenet
     * kiválasztottnak mutatott (`subject`): ismert ügyfélhez, vagy – ha a belépő maga az – a saját tárhelye gyűjtőjéhez,
     * amelyet csak ő lát. Ismeretlen adózó tételeit nem mentjük el.
     */
    public function navIngest(Request $r)
    {
        $u = $this->u();
        $d = $r->validate([
            'portalId' => 'required|integer',
            'user' => 'nullable|array', 'user.taxId' => 'nullable|string|max:10',
            'profiles' => 'nullable|array|max:1000',
            'profiles.*.name' => 'nullable|string|max:200', 'profiles.*.stem' => 'nullable|string|max:8', 'profiles.*.taxId' => 'nullable|string|max:10', 'profiles.*.kind' => 'nullable|string|max:40',
            'account' => 'nullable|array',
            'account.total' => 'nullable|integer', 'account.debt' => 'nullable|integer', 'account.surplus' => 'nullable|integer', 'account.deposit' => 'nullable|integer', 'account.unbooked' => 'nullable|integer',
            'missingCount' => 'nullable|integer|min:0', 'futureCount' => 'nullable|integer|min:0', 'calendarCount' => 'nullable|integer|min:0',
            'subject' => 'nullable|array', 'subject.stem' => 'nullable|string|max:8', 'subject.taxId' => 'nullable|string|max:10', 'subject.own' => 'nullable|boolean',
            'obligations' => 'nullable|array|max:2000',
            'obligations.*.formCode' => ['required', 'string', 'max:32', 'regex:/^[0-9A-Za-z][0-9A-Za-z_-]*$/'],
            'obligations.*.title' => 'nullable|string|max:200',
            'obligations.*.dueDate' => 'required|date_format:Y-m-d',
            'obligations.*.periodStart' => 'nullable|date_format:Y-m-d', 'obligations.*.periodEnd' => 'nullable|date_format:Y-m-d',
            'obligations.*.status' => 'nullable|in:submittable,submitted,missing',
            'obligations.*.conditional' => 'nullable|boolean',
            'returns' => 'nullable|array|max:500',
            'returns.*.regNo' => ['required', 'string', 'regex:/^\\d{6,20}$/'], 'returns.*.formCode' => ['required', 'string', 'max:32', 'regex:/^[0-9A-Za-z][0-9A-Za-z_-]*$/'],
            'returns.*.title' => 'nullable|string|max:200', 'returns.*.periodStart' => 'nullable|date_format:Y-m-d', 'returns.*.periodEnd' => 'nullable|date_format:Y-m-d',
            'returns.*.submittedAt' => ['nullable', 'string', 'regex:/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$/'], 'returns.*.state' => 'nullable|string|max:60', 'returns.*.kind' => 'nullable|string|max:40',
            'documents' => 'nullable|array|max:500',
            'documents.*.barcode' => ['nullable', 'string', 'regex:/^\\d{6,20}$/'], 'documents.*.regNo' => ['nullable', 'string', 'regex:/^[0-9A-Za-z\\/_-]{4,40}$/'],
            'documents.*.subject' => 'nullable|string|max:300', 'documents.*.docType' => 'nullable|string|max:20', 'documents.*.formCode' => 'nullable|string|max:32', 'documents.*.formName' => 'nullable|string|max:200',
            'documents.*.caseType' => 'nullable|string|max:200', 'documents.*.caseNo' => 'nullable|string|max:40', 'documents.*.krNo' => 'nullable|string|max:60',
            'documents.*.submittedAt' => ['nullable', 'string', 'regex:/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$/'], 'documents.*.arrivedAt' => ['nullable', 'string', 'regex:/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$/'],
            'documents.*.downloadedAt' => ['nullable', 'string', 'regex:/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$/'], 'documents.*.files' => 'nullable|integer|min:0|max:1000',
            'taxpayerTables' => 'nullable|array',
        ]);
        $portal = DB::table('portal_connections')->where('office_id', $u->office_id)->find((int) $d['portalId']);
        abort_if(! $portal, 404);
        abort_if((int) $portal->owner_user_id !== (int) $u->id, 403, 'A NAV-portál adatait csak a belépő gazdája küldheti be.');
        abort_if(! ClientDiscovery::allows($portal, 'upo'), 422, 'A NAV ügyfélportál ki van kapcsolva ennél a belépőnél.');

        $self = array_map('strval', $portal->self_identifiers ? (json_decode($portal->self_identifiers, true) ?: []) : []);
        if (preg_match('/^8\d{9}$/', (string) ($d['user']['taxId'] ?? ''))) {
            $self[] = (string) $d['user']['taxId'];
        } // a bejelentkezett személy maga nem ügyfél
        $collector = DB::table('clients')->where('office_id', $u->office_id)->where('discovered_via', 'own')->where('portal_connection_id', $portal->id)->value('id');
        $known = 0;
        $suggested = 0;
        $seen = [];
        foreach ($d['profiles'] ?? [] as $p) {
            $id = preg_match('/^\d{8}$/', (string) ($p['stem'] ?? '')) ? (string) $p['stem'] : (preg_match('/^8\d{9}$/', (string) ($p['taxId'] ?? '')) ? (string) $p['taxId'] : null);
            if ($id === null || isset($seen[$id]) || in_array($id, $self, true)) {
                continue;
            }
            $seen[$id] = true;
            $client = DB::table('clients')->where('office_id', $u->office_id)->where(fn ($q) => $q->where('tax', $id)->orWhere('tax', 'like', "$id-%"))->first();
            if ($client) {
                DB::table('clients')->where('id', $client->id)->update(['nav_seen_at' => now()]);
                $known++;

                continue;
            }
            $party = ClientDiscovery::parseSubjectParty("$id - ".($p['name'] ?? ''));
            $kind = $party['kind'] ?? (strlen($id) === 10 ? 'person' : 'sole');
            if (strlen($id) === 8 && stripos((string) ($p['kind'] ?? ''), 'SZERVEZET') !== false) {
                $kind = 'business';
            } // a NAV maga mondja meg, hogy szervezet
            if (! ClientDiscovery::scopeAllows($portal, $kind)) {
                continue;
            }
            $name = $party['name'] ?? (ClientDiscovery::clean((string) ($p['name'] ?? '')) ?: $id);
            $row = DB::table('discovered_subjects')->where('office_id', $u->office_id)->where('portal_connection_id', $portal->id)->where('identifier', $id)->first();
            if ($row) {
                DB::table('discovered_subjects')->where('id', $row->id)->update(['last_seen_at' => now(), 'updated_at' => now()] + ($row->state === 'pending' ? ['kind' => $kind] : []));
                if ($row->state === 'pending') {
                    $suggested++;
                }
            } else {
                DB::table('discovered_subjects')->insert(['office_id' => $u->office_id, 'portal_connection_id' => $portal->id, 'collector_client_id' => (int) $collector, 'identifier' => $id,
                    'kind' => $kind, 'parsed_name' => $name, 'letters' => 0, 'state' => 'pending', 'source' => 'nav', 'last_seen_at' => now(), 'created_at' => now(), 'updated_at' => now()]);
                $suggested++;
            }
        }
        $a = $d['account'] ?? [];
        DB::table('nav_snapshots')->updateOrInsert(['portal_connection_id' => $portal->id], ['office_id' => $u->office_id,
            'total' => $a['total'] ?? null, 'debt' => $a['debt'] ?? null, 'surplus' => $a['surplus'] ?? null, 'deposit' => $a['deposit'] ?? null, 'unbooked' => $a['unbooked'] ?? null,
            'missing_count' => $d['missingCount'] ?? null, 'future_count' => $d['futureCount'] ?? null, 'calendar_count' => $d['calendarCount'] ?? null,
            'profiles_count' => count($seen), 'fetched_at' => now(), 'updated_at' => now()]);
        $cal = array_key_exists('obligations', $d) ? $this->navObligations($u, $portal, $d['subject'] ?? null, $d['obligations'] ?? [], $self) : null;
        $subjectClient = $this->navSubjectClient($u, $portal, $d['subject'] ?? null, $self);
        $ret = array_key_exists('returns', $d) && $d['returns'] !== null ? $this->navReturns($u, $subjectClient, $d['returns']) : null;
        $docs = array_key_exists('documents', $d) && $d['documents'] !== null ? $this->navDocuments($u, $subjectClient, $d['documents']) : null;
        $tt = (config('iratkapu.nav_queries') && $subjectClient && is_array($d['taxpayerTables'] ?? null))
            ? TaxpayerDataTables::syncClientSnapshot((int) $u->office_id, (int) $subjectClient->id, $d['taxpayerTables'])
            : null;
        DB::table('portal_connections')->where('id', $portal->id)->update(['upo_state' => 'ok', 'upo_at' => now(), 'updated_at' => now()]);
        Audit::log($u->office_id, $u, 'NAV-portál adatai fogadva: '.count($seen)." képviselt adózó, ebből $suggested ajánlat".($cal ? ", {$cal['upserted']} adónaptár-tétel" : ''), ['evidence' => 'csak olvasás, a belépő saját nevében', 'policy' => 'ADR-010, A kör']);

        return ['ok' => true, 'known' => $known, 'suggested' => $suggested, 'total' => count($seen), 'calendar' => $cal, 'returns' => $ret, 'documents' => $docs] + ($tt !== null ? ['taxpayerTables' => $tt] : []);
    }

    /** A NAV-nál kiválasztott adózóhoz tartozó ügyfél: látott, aktív ügyfél; a belépő saját adatainál a saját gyűjtője. Különben null. */
    private function navSubjectClient(object $u, object $portal, ?array $subject, array $self): ?object
    {
        $stem = preg_match('/^\d{8}$/', (string) ($subject['stem'] ?? '')) ? (string) $subject['stem'] : null;
        $taxId = preg_match('/^8\d{9}$/', (string) ($subject['taxId'] ?? '')) ? (string) $subject['taxId'] : null;
        $id = $stem ?? $taxId;
        if ($id === null) {
            return null;
        }
        $client = $this->navSwitchClients($u)->where(fn ($q) => $q->where('tax', $id)->orWhere('tax', 'like', "$id-%"))->first();
        if (! $client && (($taxId && in_array($taxId, $self, true)) || ($stem && in_array($stem, $self, true)))) {
            $client = ClientDiscovery::ownCollector($u, $portal);
        }

        return $client ?: null;
    }

    /**
     * NAV ügyfélportál, „C kör”: a NAV szerint beadott bevallások mentése az ügyfélhez. Kikapcsolt lekérdezésnél (vagy ügyfél
     * nélkül) semmit nem tárol. Visszaadja a tárolt sorok számát, vagy nullt, ha nem tárolt.
     */
    private function navReturns(object $u, ?object $client, array $rows): ?int
    {
        if (! config('iratkapu.nav_queries') || ! $client) {
            return null;
        }
        $n = 0;
        foreach ($rows as $x) {
            DB::table('nav_returns')->updateOrInsert(['client_id' => $client->id, 'reg_no' => $x['regNo']], ['office_id' => $u->office_id, 'form_code' => $x['formCode'],
                'title' => isset($x['title']) ? ClientDiscovery::clean((string) $x['title'], 200) : null, 'period_from' => $x['periodStart'] ?? null, 'period_to' => $x['periodEnd'] ?? null,
                'submitted_at' => $x['submittedAt'] ?? null, 'state' => $x['state'] ?? null, 'kind' => $x['kind'] ?? null, 'fetched_at' => now(), 'updated_at' => now()]);
            $n++;
        }

        return $n;
    }

    /** NAV ügyfélportál, „C kör”: a NAV-dokumentumok mentése az ügyfélhez (csak bekapcsolt lekérdezésnél és ismert ügyfélnél). */
    private function navDocuments(object $u, ?object $client, array $rows): ?int
    {
        if (! config('iratkapu.nav_queries') || ! $client) {
            return null;
        }
        $clean = fn ($v, $len = 200) => isset($v) ? ClientDiscovery::clean((string) $v, $len) : null;
        $n = 0;
        foreach ($rows as $x) {
            $key = $x['barcode'] ?? ($x['regNo'] ?? null);
            if ($key === null) {
                continue;
            }
            DB::table('nav_documents')->updateOrInsert(['client_id' => $client->id, 'doc_key' => $key], ['office_id' => $u->office_id, 'barcode' => $x['barcode'] ?? null, 'reg_no' => $x['regNo'] ?? null,
                'subject' => $clean($x['subject'] ?? null, 300), 'doc_type' => $x['docType'] ?? null, 'form_code' => $x['formCode'] ?? null, 'form_name' => $clean($x['formName'] ?? null),
                'case_type' => $clean($x['caseType'] ?? null), 'case_no' => $x['caseNo'] ?? null, 'kr_no' => $x['krNo'] ?? null,
                'submitted_at' => $x['submittedAt'] ?? null, 'arrived_at' => $x['arrivedAt'] ?? null, 'downloaded_at' => $x['downloadedAt'] ?? null, 'files' => (int) ($x['files'] ?? 0),
                'fetched_at' => now(), 'updated_at' => now()]);
            $n++;
        }

        return $n;
    }

    private const NAV_EXPORT_KINDS = ['adoszamla' => 'adószámla-kivonat', 'torzsadat' => 'törzsadat-kivonat', 'biztositottak' => 'biztosítotti bejelentések'];

    /**
     * NAV ügyfélportál, letölthető kimutatások: az asztali app által letöltött fájlok iratként kerülnek az adózóhoz tartozó
     * ügyfélhez (saját adatnál a belépő „Saját tárhely” gyűjtőjébe). Megkülönböztetve a tárhelyre érkezett levelektől:
     * feladó „NAV”, tárgy „Portálról lekérdezve: …”, hivatalos állapot „nem átvételköteles”. Naponta fajtánként és
     * formátumonként egy irat; az aznapi újabb lekérés nem kettőz.
     */
    public function navExports(Request $r)
    {
        $u = $this->u();
        abort_if(! config('iratkapu.nav_exports'), 422, 'A NAV-kimutatások letöltése ki van kapcsolva (tulajdonosi döntés, ADR-010).');
        $d = $r->validate([
            'portalId' => 'required|integer', 'restored' => 'required|boolean',
            'subject' => 'required|array', 'subject.stem' => ['nullable', 'string', 'regex:/^\d{8}$/'], 'subject.taxId' => ['nullable', 'string', 'regex:/^8\d{9}$/'],
            'files' => 'required|array|min:1|max:8',
            'files.*.kind' => 'required|in:'.implode(',', array_keys(self::NAV_EXPORT_KINDS)), 'files.*.format' => 'required|in:PDF,PDF_HITELESITETT,XLSX',
            'files.*.from' => 'nullable|date_format:Y-m-d', 'files.*.to' => 'nullable|date_format:Y-m-d',
            'files.*.base64' => 'required|string|max:'.(int) ceil(10 * 1024 * 1024 * 1.4),
        ]);
        $portal = $this->navPortalOf($u, (int) $d['portalId']);
        $self = array_map('strval', $portal->self_identifiers ? (json_decode($portal->self_identifiers, true) ?: []) : []);
        $client = $this->navSubjectClient($u, $portal, $d['subject'], $self);
        abort_if(! $client, 422, 'Ez az adózó nincs az általad látott, aktív ügyfelek között; a kimutatásokat nem mentettem el.');
        $box = DB::table('mailboxes')->where('office_id', $u->office_id)->where('client_id', $client->id)->orderByRaw("case type when 'CK' then 0 when 'ÜK' then 1 else 2 end")->orderBy('id')->first();
        abort_if(! $box, 422, 'Az ügyfélnek nincs tárhelye az alkalmazásban, ezért a kimutatás nem tehető az iratai közé.');
        $saved = 0;
        $skipped = 0;
        foreach ($d['files'] as $f) {
            $bytes = base64_decode($f['base64'], true);
            $ok = $bytes !== false && strlen($bytes) <= 10 * 1024 * 1024 && (str_contains($f['format'], 'PDF') ? str_starts_with($bytes, '%PDF-') : str_starts_with($bytes, 'PK'));
            abort_if(! $ok, 422, 'A kimutatás nem a megadott formátumú fájl.');
            $ext = str_contains($f['format'], 'PDF') ? 'pdf' : 'xlsx';
            $source = "navexp:{$f['kind']}:{$f['format']}:".now()->toDateString();
            if (DB::table('messages')->where('mailbox_id', $box->id)->where('source_id', $source)->exists()) {
                $skipped++;

                continue;
            }
            $period = ! empty($f['from']) && ! empty($f['to']) ? ' ('.str_replace('-', '.', $f['from']).'–'.str_replace('-', '.', $f['to']).')' : '';
            $label = self::NAV_EXPORT_KINDS[$f['kind']];
            $id = DB::table('messages')->insertGetId([
                'office_id' => $u->office_id, 'client_id' => $client->id, 'mailbox_id' => $box->id, 'source_id' => $source,
                'sender' => 'NAV', 'sender_full' => 'Nemzeti Adó- és Vámhivatal – ügyfélportál',
                'subject' => "Portálról lekérdezve: NAV $label$period, ".($ext === 'pdf' ? ($f['format'] === 'PDF_HITELESITETT' ? 'hitelesített PDF' : 'PDF') : 'XLSX'),
                'type_id' => "nav-kimutatas-{$f['kind']}", 'type_label' => 'NAV '.$label.' (portál)', 'type_ai' => false, 'unknown' => false, 'receipt' => false,
                'arrived_at' => now(), 'official' => 'na', 'internal' => 'uj', 'es3' => false, 'att' => 1, 'file_size' => strlen($bytes), 'created_at' => now(), 'updated_at' => now(),
            ]);
            Documents::store($u->office_id, $id, "nav-{$f['kind']}-".now()->toDateString().".$ext", $bytes, $u->id);
            if (TypeActions::onArrival($id)) {
                RuleEngine::apply(DB::table('messages')->find($id));
            }
            TypeActions::autoArchive($id);
            DocumentForward::afterResponse($id, 'downloaded');
            $saved++;
        }
        Audit::log($u->office_id, $u, "NAV-portál: $saved kimutatás iratként rögzítve".($skipped ? ", $skipped ma már megvolt" : '').($d['restored'] ? '' : ' – A VISSZAVÁLTÁS A SAJÁT PROFILRA NEM VOLT IGAZOLHATÓ'),
            ['client_id' => $client->id, 'evidence' => 'a NAV ügyfélportálról kérésre letöltött kimutatás', 'policy' => 'ADR-010, kimutatások']);

        return ['ok' => true, 'saved' => $saved, 'skipped' => $skipped, 'client' => $client->name];
    }

    /** A belépő gazdájának NAV-portálja: közös ellenőrzés a B kör két végpontjához. */
    private function navPortalOf(object $u, int $portalId): object
    {
        $portal = DB::table('portal_connections')->where('office_id', $u->office_id)->find($portalId);
        abort_if(! $portal, 404);
        abort_if((int) $portal->owner_user_id !== (int) $u->id, 403, 'A NAV-portál adatait csak a belépő gazdája olvashatja ki.');
        abort_if(! ClientDiscovery::allows($portal, 'upo'), 422, 'A NAV ügyfélportál ki van kapcsolva ennél a belépőnél.');

        return $portal;
    }

    /** Az ügyfelek, akiknek az adatait a NAV-portálon képviselet-váltással ki lehet olvasni: aktívak, érvényes meghatalmazással, a hívó látja őket. */
    private function navSwitchClients(object $u)
    {
        return DB::table('clients')->whereIn('id', Scope::clientIds($u))->where('active', true)
            ->where(fn ($q) => $q->whereNull('discovered_via')->orWhere('discovered_via', '!=', 'own'))
            ->where(fn ($q) => $q->whereNull('auth_until')->orWhere('auth_until', '>=', now()->toDateString()));
    }

    /** XLSX-irat: az előnézet táblázatként jelenik meg (a `text` mezőben tabulátorral tagolt sorok vannak, XlsxReader). */
    private static function isSheet(object $d): bool
    {
        return str_contains((string) $d->mime, 'spreadsheetml') || str_ends_with(strtolower($d->name), '.xlsx');
    }

    /** @return array{rows: array<int, array<int, string>>, more: int} az első 300 sor, és hány sor maradt ki */
    private static function sheetRows(string $text): array
    {
        $lines = explode("\n", $text);

        return ['rows' => array_map(fn ($l) => explode("\t", $l), array_slice($lines, 0, 300)), 'more' => max(0, count($lines) - 300)];
    }

    private static function navIdOf(?string $tax): ?string
    {
        $tax = trim((string) $tax);
        if (preg_match('/^(\d{8})(-\d-\d{2})?$/', $tax, $m)) {
            return $m[1];
        }

        return preg_match('/^8\d{9}$/', $tax) ? $tax : null;
    }

    /**
     * NAV ügyfélportál, „B kör”: mely adózókra váltson át az asztali app. Csak bekapcsolt képviselet-váltásnál ad listát
     * (`iratkapu.nav_switch`), és csak azokat, akiket ma még nem olvastunk ki. Az asztali app ezek közül is csak arra vált,
     * akit a NAV a belépő képviselt adózói között felsorol.
     */
    public function navTargets(Request $r)
    {
        $u = $this->u();
        $portal = $this->navPortalOf($u, (int) $r->query('portalId'));
        if (! config('iratkapu.nav_switch')) {
            return ['enabled' => false, 'ids' => []];
        }
        $today = $r->boolean('force')
            ? []
            : DB::table('nav_client_snapshots')->where('office_id', $u->office_id)->where('fetched_at', '>=', now()->startOfDay())->pluck('client_id')->all();
        $ids = $this->navSwitchClients($u)->whereNotIn('id', $today)->orderBy('name')->pluck('tax')->map(fn ($t) => self::navIdOf($t))->filter()->unique()->values()->take(15)->all();

        return ['enabled' => true, 'ids' => $ids];
    }

    /** NAV ügyfélportál, „B kör”: a képviselet-váltással kiolvasott ügyféladatok fogadása. Ügyfél ebből nem jön létre. */
    public function navIngestClients(Request $r)
    {
        $u = $this->u();
        abort_if(! config('iratkapu.nav_switch'), 422, 'A NAV-portál képviselet-váltása ki van kapcsolva (tulajdonosi döntés, ADR-010).');
        $d = $r->validate([
            'portalId' => 'required|integer', 'restored' => 'required|boolean',
            'clients' => 'present|array|max:50',
            'clients.*.stem' => ['nullable', 'string', 'regex:/^\d{8}$/'], 'clients.*.taxId' => ['nullable', 'string', 'regex:/^8\d{9}$/'],
            'clients.*.account' => 'nullable|array',
            'clients.*.account.total' => 'nullable|integer', 'clients.*.account.debt' => 'nullable|integer', 'clients.*.account.surplus' => 'nullable|integer',
            'clients.*.account.deposit' => 'nullable|integer', 'clients.*.account.unbooked' => 'nullable|integer',
            'clients.*.missingCount' => 'nullable|integer|min:0', 'clients.*.futureCount' => 'nullable|integer|min:0', 'clients.*.calendarCount' => 'nullable|integer|min:0',
            'clients.*.obligations' => 'nullable|array|max:2000',
            'clients.*.obligations.*.formCode' => ['required', 'string', 'max:32', 'regex:/^[0-9A-Za-z][0-9A-Za-z_-]*$/'],
            'clients.*.obligations.*.title' => 'nullable|string|max:200',
            'clients.*.obligations.*.dueDate' => 'required|date_format:Y-m-d',
            'clients.*.obligations.*.periodStart' => 'nullable|date_format:Y-m-d', 'clients.*.obligations.*.periodEnd' => 'nullable|date_format:Y-m-d',
            'clients.*.obligations.*.status' => 'nullable|in:submittable,submitted,missing',
            'clients.*.obligations.*.conditional' => 'nullable|boolean',
            'clients.*.returns' => 'nullable|array|max:500',
            'clients.*.returns.*.regNo' => ['required', 'string', 'regex:/^\\d{6,20}$/'], 'clients.*.returns.*.formCode' => ['required', 'string', 'max:32', 'regex:/^[0-9A-Za-z][0-9A-Za-z_-]*$/'],
            'clients.*.returns.*.title' => 'nullable|string|max:200', 'clients.*.returns.*.periodStart' => 'nullable|date_format:Y-m-d', 'clients.*.returns.*.periodEnd' => 'nullable|date_format:Y-m-d',
            'clients.*.returns.*.submittedAt' => ['nullable', 'string', 'regex:/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$/'], 'clients.*.returns.*.state' => 'nullable|string|max:60', 'clients.*.returns.*.kind' => 'nullable|string|max:40',
            'clients.*.documents' => 'nullable|array|max:500',
            'clients.*.documents.*.barcode' => ['nullable', 'string', 'regex:/^\\d{6,20}$/'], 'clients.*.documents.*.regNo' => ['nullable', 'string', 'regex:/^[0-9A-Za-z\\/_-]{4,40}$/'],
            'clients.*.documents.*.subject' => 'nullable|string|max:300', 'clients.*.documents.*.docType' => 'nullable|string|max:20', 'clients.*.documents.*.formCode' => 'nullable|string|max:32', 'clients.*.documents.*.formName' => 'nullable|string|max:200',
            'clients.*.documents.*.caseType' => 'nullable|string|max:200', 'clients.*.documents.*.caseNo' => 'nullable|string|max:40', 'clients.*.documents.*.krNo' => 'nullable|string|max:60',
            'clients.*.documents.*.submittedAt' => ['nullable', 'string', 'regex:/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$/'], 'clients.*.documents.*.arrivedAt' => ['nullable', 'string', 'regex:/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$/'],
            'clients.*.documents.*.downloadedAt' => ['nullable', 'string', 'regex:/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$/'], 'clients.*.documents.*.files' => 'nullable|integer|min:0|max:1000',
            'clients.*.taxpayerTables' => 'nullable|array',
        ]);
        $portal = $this->navPortalOf($u, (int) $d['portalId']);
        $self = array_map('strval', $portal->self_identifiers ? (json_decode($portal->self_identifiers, true) ?: []) : []);
        $saved = 0;
        $skipped = 0;
        $obligations = 0;
        $returns = 0;
        $documents = 0;
        $hasTt = false;
        $ttTotals = ['insured_persons' => 0, 'employers' => 0, 'efo_declarations' => 0, 'efo_quotas' => 0, 'reconciliations' => 0];
        $names = [];
        foreach ($d['clients'] as $c) {
            $id = $c['stem'] ?? ($c['taxId'] ?? null);
            $client = $id === null ? null : $this->navSwitchClients($u)->where(fn ($q) => $q->where('tax', $id)->orWhere('tax', 'like', "$id-%"))->first();
            if (! $client) {
                $skipped++;

                continue;
            } // ismeretlen, inaktív vagy nem látott adózó adata nem kerül tárolásra
            $a = $c['account'] ?? [];
            DB::table('nav_client_snapshots')->updateOrInsert(['client_id' => $client->id], ['office_id' => $u->office_id, 'portal_connection_id' => $portal->id,
                'total' => $a['total'] ?? null, 'debt' => $a['debt'] ?? null, 'surplus' => $a['surplus'] ?? null, 'deposit' => $a['deposit'] ?? null, 'unbooked' => $a['unbooked'] ?? null,
                'missing_count' => $c['missingCount'] ?? null, 'future_count' => $c['futureCount'] ?? null, 'calendar_count' => $c['calendarCount'] ?? null,
                'fetched_at' => now(), 'updated_at' => now()]);
            DB::table('clients')->where('id', $client->id)->update(['nav_seen_at' => now()]);
            if (array_key_exists('obligations', $c)) {
                $cal = $this->navObligations($u, $portal, ['stem' => $c['stem'] ?? null, 'taxId' => $c['taxId'] ?? null], $c['obligations'] ?? [], $self);
                $obligations += $cal['upserted'] ?? 0;
            }
            if (isset($c['returns'])) {
                $returns += $this->navReturns($u, $client, $c['returns']) ?? 0;
            }
            if (isset($c['documents'])) {
                $documents += $this->navDocuments($u, $client, $c['documents']) ?? 0;
            }
            if (config('iratkapu.nav_queries') && is_array($c['taxpayerTables'] ?? null)) {
                $hasTt = true;
                $sc = TaxpayerDataTables::syncClientSnapshot((int) $u->office_id, (int) $client->id, $c['taxpayerTables']);
                foreach ($ttTotals as $tk => $tv) {
                    $ttTotals[$tk] += (int) ($sc[$tk] ?? 0);
                }
            }
            $saved++;
            $names[] = $client->name;
        }
        Audit::log($u->office_id, $u, "NAV-portál: $saved ügyfél adatai fogadva képviselet-váltással".($skipped ? ", $skipped kihagyva" : '').($d['restored'] ? '' : ' – A VISSZAVÁLTÁS A SAJÁT PROFILRA NEM VOLT IGAZOLHATÓ'),
            ['evidence' => 'képviselet-váltás a belépő munkamenetében, utána csak olvasás', 'policy' => 'ADR-010, B kör']);

        return ['ok' => true, 'saved' => $saved, 'skipped' => $skipped, 'obligations' => $obligations, 'returns' => $returns, 'documents' => $documents, 'restored' => (bool) $d['restored'], 'clients' => $names] + ($hasTt ? ['taxpayerTables' => $ttTotals] : []);
    }

    /**
     * A NAV-portálról tételesen kiolvasott adónaptár-bejegyzések és hiányzó bevallások mentése a kötelezettség-tárolóba
     * (ugyanoda, ahonnan a határidőnaptár és az „Adónaptár és bevallások” nézet olvas). A már nyugtával párosított
     * (beadott vagy elutasított) tétel állapotát az újabb beolvasás nem írja vissza.
     */
    private function navObligations(object $u, object $portal, ?array $subject, array $rows, array $self): array
    {
        $none = fn (string $why) => ['upserted' => 0, 'paired' => 0, 'received' => count($rows), 'matched' => false, 'reason' => $why, 'client' => null];
        $stem = preg_match('/^\d{8}$/', (string) ($subject['stem'] ?? '')) ? (string) $subject['stem'] : null;
        $taxId = preg_match('/^8\d{9}$/', (string) ($subject['taxId'] ?? '')) ? (string) $subject['taxId'] : null;
        if (! $stem && ! $taxId) {
            return $none('nosubject');
        }
        $clients = DB::table('clients')->whereIn('id', Scope::clientIds($u))->where(fn ($q) => $q->whereNull('discovered_via')->orWhere('discovered_via', '!=', 'own'));
        $client = $stem ? (clone $clients)->where(fn ($q) => $q->where('tax', $stem)->orWhere('tax', 'like', "$stem-%"))->first() : null;
        if (! $client && $taxId) {
            $client = (clone $clients)->where('tax', $taxId)->first();
        }
        if ($client && (! $client->active || ($client->auth_until && $client->auth_until < now()->toDateString()))) {
            return $none('inactive');
        }
        // A belépő saját adatai: nem ügyfél, a saját tárhelye gyűjtőjébe kerülnek (azt csak a gazdája látja).
        if (! $client && $taxId && in_array($taxId, $self, true)) {
            if (! $rows) {
                return ['matched' => true] + $none('empty');
            } // tétel nélkül nem hozunk létre gyűjtőt
            $client = ClientDiscovery::ownCollector($u, $portal);
        }
        if (! $client) {
            return $none('unknown');
        }

        $upserted = 0;
        foreach ($rows as $ob) {
            $formCode = mb_strtoupper($ob['formCode']);
            $title = ClientDiscovery::clean((string) ($ob['title'] ?? ''), 200) ?: "$formCode – adónaptár-bejegyzés";
            $key = implode('|', ['nav', $formCode, $ob['periodStart'] ?? '', $ob['periodEnd'] ?? '', $ob['dueDate'], substr(sha1($title), 0, 10)]);
            $status = $ob['status'] ?? 'submittable';
            // A NAV sárgán jelölt (feltételes) kötelezettsége a meglévő modell szerint „feltételes” állapotú, amíg nincs beadva.
            if (! empty($ob['conditional']) && $status === 'submittable') {
                $status = 'conditional';
            }
            $row = DB::table('tax_obligations')->where('client_id', $client->id)->where('external_key', $key)->first();
            if ($row) {
                $stalePair = empty($row->period_end) && ! empty($row->submitted_at) && ! empty($row->due_date)
                    && substr((string) $row->submitted_at, 0, 7) < substr((string) $row->due_date, 0, 7);
                $settled = ! $stalePair && in_array($row->status, ['submitted', 'rejected'], true);
                $upd = ['title' => $title, 'conditional' => (bool) ($ob['conditional'] ?? false), 'status' => $settled ? $row->status : $status, 'updated_at' => now()];
                if ($stalePair) {
                    $upd['receipt_message_id'] = null;
                    $upd['submitted_at'] = null;
                    $upd['error_at'] = null;
                }
                DB::table('tax_obligations')->where('id', $row->id)->update($upd);
            } else {
                DB::table('tax_obligations')->insert(['office_id' => $u->office_id, 'client_id' => $client->id, 'source' => 'nav', 'external_key' => $key, 'form_code' => $formCode, 'title' => $title,
                    'period_start' => $ob['periodStart'] ?? null, 'period_end' => $ob['periodEnd'] ?? null, 'due_date' => $ob['dueDate'], 'conditional' => (bool) ($ob['conditional'] ?? false), 'status' => $status,
                    'created_at' => now(), 'updated_at' => now()]);
            }
            $upserted++;
        }
        $paired = 0;
        if ($upserted) {
            $receipts = DB::table('messages')->where('client_id', $client->id)
                ->where(fn ($q) => $q->where('receipt', true)->orWhereIn('type_id', ['nav.nyugta.elfogado', 'nav.nyugta.elutasito']))->orderBy('arrived_at')->get();
            foreach ($receipts as $rm) {
                if (DeadlineExtractor::pairObligation($rm)) {
                    $paired++;
                }
            }
        }

        return ['upserted' => $upserted, 'paired' => $paired, 'received' => count($rows), 'matched' => true, 'reason' => null, 'client' => "c{$client->id}"];
    }

    /** A saját tárhely leveleiből ajánlott fél elbírálása: felvétel ügyfélként, „ez én vagyok”, vagy kihagyás. Csak a belépő gazdája teheti. */
    public function resolveSubject(Request $r, int $id)
    {
        $u = $this->u();
        $row = DB::table('discovered_subjects')->where('office_id', $u->office_id)->where('state', 'pending')->find($id);
        abort_if(! $row, 404);
        $portal = DB::table('portal_connections')->where('office_id', $u->office_id)->find($row->portal_connection_id);
        abort_if(! $portal || (int) $portal->owner_user_id !== (int) $u->id, 403, 'A saját tárhely leveleiből ajánlott felet csak a belépő gazdája bírálhatja el.');
        $d = $r->validate(['action' => 'required|in:create,self,ignore', 'name' => 'nullable|string|max:120', 'authorized' => 'nullable|boolean']);
        $client = null;
        $state = 'ignored';
        $log = 'Ajánlott fél kihagyva';
        if ($d['action'] === 'self') {
            abort_if($row->kind === 'business', 422, 'Egy cég nem lehet a belépő saját azonosítója.');
            $self = $portal->self_identifiers ? (json_decode($portal->self_identifiers, true) ?: []) : [];
            DB::table('portal_connections')->where('id', $portal->id)->update(['self_identifiers' => json_encode(array_values(array_unique([...array_map('strval', $self), $row->identifier]))), 'updated_at' => now()]);
            $state = 'self';
            $log = 'Azonosító megjelölve a belépő gazdájának sajátjaként';
        } elseif ($d['action'] === 'create') {
            abort_if(empty($d['authorized']), 422, 'Új ügyfél felvételéhez meg kell erősíteni a meghatalmazást.');
            abort_if(! ClientDiscovery::scopeAllows($portal, $row->kind), 422, 'Ennél a belépőnél csak vállalkozások feldolgozása van bekapcsolva.');
            $name = ClientDiscovery::clean((string) ($d['name'] ?? '')) ?: $row->parsed_name;
            abort_if(DB::table('clients')->where('office_id', $u->office_id)->where(fn ($q) => $q->where('tax', $row->identifier)->orWhere('tax', 'like', "{$row->identifier}-%"))->exists(), 422, 'Ezzel az azonosítóval már van ügyfél.');
            $nav = ($row->source ?? 'mail') === 'nav';
            $cid = DB::table('clients')->insertGetId(['office_id' => $u->office_id, 'name' => $name, 'tax' => $row->identifier, 'auth_until' => null,
                'auth_basis' => $nav ? 'A NAV ügyfélportál képviseleti listájából felvéve' : 'A saját tárhely leveleiből felvéve', 'active' => OfficeMail::office((int) $u->office_id)['defaultActive'][$nav ? 'nav' : 'mail'],
                'portal_connection_id' => $portal->id, 'created_at' => now(), 'updated_at' => now()]);
            if (! Scope::seesAll($u)) {
                DB::table('client_user')->insertOrIgnore(['client_id' => $cid, 'user_id' => $u->id]);
            }
            $client = DB::table('clients')->find($cid);
            $state = 'created';
            $log = "Ügyfél felvéve a saját tárhely leveleiből: $name";
            // A gyűjtőben lévő, ember által még nem érintett levelei most már besorolhatók (azonosító alapján, a szokásos úton).
            $collector = DB::table('clients')->find($row->collector_client_id);
            $waiting = $collector ? DB::table('messages')->where('office_id', $u->office_id)->where('client_id', $collector->id)
                ->where(fn ($q) => $q->where('subject', 'like', "{$row->identifier} - %")->orWhere('subject', 'like', "{$row->identifier}-%"))->get() : collect();
            foreach ($waiting as $m) {
                if (OwnMailRouter::route($m, $collector, trim($m->subject.' '.($m->live_type ?? '')), '', $u)) {
                    $moved = DB::table('messages')->find($m->id);
                    RuleEngine::apply($moved);
                    DeadlineExtractor::pairObligation(DB::table('messages')->find($m->id));
                }
            }
        }
        DB::table('discovered_subjects')->where('id', $row->id)->update(['state' => $state, 'updated_at' => now()]);
        Audit::log($u->office_id, $u, $log, ['client_id' => $client->id ?? null, 'evidence' => strlen($row->identifier) === 10 ? 'adóazonosító jel (…'.substr($row->identifier, -3).')' : "adószám-törzs ({$row->identifier})"]);

        return ['ok' => true, 'clientId' => $client ? "c{$client->id}" : null];
    }

    public function clientUsers(Request $r, string $id)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403);
        $c = Scope::client($u, $this->mid($id));
        abort_if($c->discovered_via === 'own', 422, 'A saját tárhely gyűjtőjét csak a gazdája látja; kezelők nem rendelhetők hozzá.');
        $ids = DB::table('users')->where('office_id', $u->office_id)->whereIn('initials', (array) $r->input('users'))->pluck('id');
        DB::table('client_user')->where('client_id', $c->id)->delete();
        foreach ($ids as $i) {
            DB::table('client_user')->insert(['client_id' => $c->id, 'user_id' => $i]);
        }
        Audit::log($u->office_id, $u, 'Ügyfél kezelői módosítva', ['client_id' => $c->id]);

        return ['ok' => true];
    }

    public function invite(Request $r)
    {
        $u = $this->u();
        abort_if($u->role !== 'admin', 403, 'Munkatársat csak admin vehet fel.');
        abort_if(! empty(OfficeMail::settings($u->office_id)['local']), 403, 'A helyi (egygépes) módban nincs több munkatárs. Ehhez a szerveres mód kell.');
        $d = $r->validate(['name' => 'required|string|max:80', 'email' => 'required|email|unique:users,email', 'role' => 'required|in:admin,vezeto,konyvelo']);
        $ini = mb_strtoupper(implode('', array_map(fn ($p) => mb_substr($p, 0, 1), array_slice(preg_split('/\s+/', trim($d['name'])), 0, 2))));
        while (DB::table('users')->where('office_id', $u->office_id)->where('initials', $ini)->exists()) {
            $ini = mb_substr($ini, 0, 1).chr(rand(65, 90));
        }
        DB::table('users')->insert($d + ['office_id' => $u->office_id, 'initials' => $ini, 'password' => Hash::make(Str::random(32)), 'created_at' => now(), 'updated_at' => now()]);
        Audit::log($u->office_id, $u, "Munkatárs felvéve: {$d['name']} ({$d['role']})");

        return ['ok' => true];
    }

    public function settings(Request $r)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403);
        $d = $r->validate(['reminders' => 'array', 'reminders.*' => 'integer|in:1,2,5', 'reminderEmail' => 'boolean', 'replyTo' => 'nullable|email|max:190',
            'defaultActive' => 'array:mail,nav,cegkapu', 'defaultActive.mail' => 'boolean', 'defaultActive.nav' => 'boolean', 'defaultActive.cegkapu' => 'boolean',
            'digestDays' => 'integer|between:0,30', 'arrearsDays' => 'integer|between:0,30', 'paymentDays' => 'array|max:30', 'paymentDays.*' => 'integer|between:1,30|distinct']);
        $patch = [];
        $names = [];
        if ($r->has('reminders')) {
            $patch['reminders'] = array_values(array_map('intval', $d['reminders'] ?? []));
            $names[] = 'emlékeztető napok';
        }
        if ($r->has('reminderEmail')) {
            $patch['reminder_email'] = (bool) $d['reminderEmail'];
            $names[] = 'emlékeztető e-mail';
        }
        if ($r->has('replyTo')) {
            $patch['reply_to'] = ($d['replyTo'] ?? '') ?: null;
            $names[] = 'válaszcím';
        }
        if ($r->has('defaultActive')) {
            $patch['default_active'] = array_map('boolval', ($d['defaultActive'] ?? []) + OfficeMail::office($u->office_id)['defaultActive']);
            $names[] = 'új ügyfelek alapértelmezett aktivitása';
        }
        if ($r->has('digestDays')) {
            $patch['digest_days'] = (int) $d['digestDays'];
            $names[] = 'összesítő email gyakorisága';
        }
        if ($r->has('arrearsDays')) {
            $patch['arrears_days'] = (int) $d['arrearsDays'];
            $names[] = 'hátralék-értesítő gyakorisága';
        }
        if ($r->has('paymentDays')) {
            $patch['payment_days'] = array_map('intval', $d['paymentDays'] ?? []);
            $names[] = 'fizetési emlékeztető napjai';
        }
        OfficeMail::put($u->office_id, $patch);
        Audit::log($u->office_id, $u, 'Iroda beállításai módosítva: '.($names ? implode(', ', $names) : 'nincs változás'));

        return ['ok' => true];
    }

    /** Az iroda SMTP-kiszolgálója. Üres jelszó mentéskor a korábbi marad. */
    public function saveSmtp(Request $r)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403);
        $d = $r->validate(['host' => ['required', 'string', 'max:190', 'regex:/^[A-Za-z0-9.\-]+$/'], 'port' => 'required|integer|between:1,65535', 'enc' => 'required|in:starttls,ssl',
            'username' => 'nullable|string|max:190', 'password' => 'nullable|string|max:500', 'from' => 'required|email|max:190', 'fromName' => 'nullable|string|max:120']);
        $old = OfficeMail::settings($u->office_id)['smtp'] ?? [];
        $pw = ($d['password'] ?? '') !== '' ? Crypt::encryptString($d['password']) : (($d['username'] ?? '') !== '' ? ($old['password'] ?? null) : null);
        OfficeMail::put($u->office_id, ['smtp' => ['host' => $d['host'], 'port' => (int) $d['port'], 'enc' => $d['enc'], 'username' => $d['username'] ?? '', 'password' => $pw, 'from' => $d['from'], 'from_name' => $d['fromName'] ?? '']]);
        Audit::log($u->office_id, $u, "E-mail küldés (SMTP) beállítva: {$d['host']}:{$d['port']}, feladó: {$d['from']}");

        return ['ok' => true];
    }

    public function deleteSmtp()
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403);
        OfficeMail::put($u->office_id, ['smtp' => null]);
        Audit::log($u->office_id, $u, 'E-mail küldés (SMTP) beállítása törölve');

        return ['ok' => true];
    }

    /** Tesztlevél a bejelentkezett felhasználó saját címére, a mentett beállítással. */
    public function testSmtp()
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403);
        abort_if(! OfficeMail::summary($u->office_id)['configured'], 422, 'Előbb mentsd el az SMTP-beállítást.');
        try {
            OfficeMail::mailer($u->office_id)->raw("Ez egy tesztlevél a KapuMail beállításaiból.\n\nHa megkaptad, az iroda e-mail küldése működik.", fn ($mail) => $mail->to($u->email, $u->name)->subject('KapuMail – tesztlevél'));
        } catch (\Throwable $e) {
            Audit::log($u->office_id, $u, 'SMTP-tesztlevél sikertelen');
            abort(422, 'A tesztlevél nem ment ki: '.mb_substr(preg_replace('/\s+/', ' ', $e->getMessage()), 0, 240));
        }
        Audit::log($u->office_id, $u, "SMTP-tesztlevél elküldve: {$u->email}");

        return ['ok' => true, 'to' => $u->email];
    }

    public function saveView(Request $r)
    {
        $u = $this->u();
        $d = $r->validate(['name' => 'required|string|max:60', 'filters' => 'required|array', 'shared' => 'boolean']);
        DB::table('saved_views')->insert(['office_id' => $u->office_id, 'user_id' => $u->id, 'name' => $d['name'], 'filters' => json_encode($d['filters']), 'shared' => (bool) ($d['shared'] ?? false), 'created_at' => now(), 'updated_at' => now()]);

        return ['ok' => true];
    }

    public function deleteView(int $id)
    {
        DB::table('saved_views')->where('user_id', $this->u()->id)->where('id', $id)->delete();

        return ['ok' => true];
    }

    /** Könnyű lekérdezés a rendszerértesítésekhez: a felhasználó legutolsó értesítésének sorszáma. */
    public function notificationsLast()
    {
        return ['last' => (int) DB::table('notifications')->where('user_id', $this->u()->id)->where('kind', '!=', 'osszesito')->max('id')];
    }

    public function readNotifications(Request $r)
    {
        DB::table('notifications')->where('user_id', $this->u()->id)->where('kind', '!=', 'osszesito')->whereNull('read_at')->when($r->filled('id'), fn ($q) => $q->where('id', (int) $r->input('id')))->update(['read_at' => now()]);

        return ['ok' => true];
    }

    /** Saját fájl feltöltése egy már ÁTVETT irathoz (pl. a hivatalos tárhelyről kézzel letöltött es3). */
    public function upload(Request $r, string $id)
    {
        $u = $this->u();
        $m = Scope::message($u, $this->mid($id));
        abort_if($m->official === 'wait', 422, 'Át nem vett irathoz nem tölthető fel fájl.');
        $f = $r->file('file');
        abort_if(! $f || ! $f->isValid(), 422, 'Hiányzó vagy hibás fájl.');
        abort_if($f->getSize() > config('iratkapu.es3.max_file'), 422, 'A fájl nagyobb a megengedettnél (20 MB).');
        $doc = Documents::store($u->office_id, $m->id, $f->getClientOriginalName(), file_get_contents($f->getRealPath()), $u->id);
        Audit::log($u->office_id, $u, 'Fájl feltöltve és archiválva: '.DB::table('documents')->where('id', $doc)->value('name'), ['client_id' => $m->client_id, 'message_id' => $m->id, 'evidence' => 'SHA-256 '.DB::table('documents')->where('id', $doc)->value('sha256')]);

        return ['ok' => true];
    }

    /** ES3-megnyitó: egy helyi akta kibontása megtekintésre. Semmit nem tárol és nem köt irathoz – a tartalom csak a válaszban megy vissza. */
    public function openEs3(Request $r)
    {
        $u = $this->u();
        $f = $r->file('file');
        abort_if(! $f || ! $f->isValid(), 422, 'Hiányzó vagy hibás fájl.');
        abort_if($f->getSize() > config('iratkapu.es3.max_file'), 422, 'A fájl nagyobb a megengedettnél (20 MB).');
        $bytes = file_get_contents($f->getRealPath());
        try {
            $p = (new Es3Reader)->read($bytes);
        } catch (Es3Exception $e) {
            abort(422, 'Nem bontható ki: '.$e->getMessage());
        }
        $tree = function (array $docs) use (&$tree) {
            return array_map(fn ($d) => ['name' => $d['name'], 'mime' => $d['mime'], 'size' => $d['size'], 'sha' => $d['sha256'], 'error' => $d['error'],
                'data' => $d['bytes'] !== null && $d['bytes'] !== '' ? base64_encode($d['bytes']) : null,
                'nested' => isset($d['nested']) ? ['title' => $d['nested']['title'], 'signatures' => $d['nested']['signatures'], 'docs' => $tree($d['nested']['documents'])] : null], $docs);
        };
        $sig = SignatureCheck::check($bytes);
        $sha = hash('sha256', $bytes);
        Audit::log($u->office_id, $u, 'ES3 megnyitva megtekintésre (nem archiválva): '.Es3Reader::safeName($f->getClientOriginalName()), ['evidence' => "SHA-256 $sha"]);

        return ['name' => Es3Reader::safeName($f->getClientOriginalName()), 'size' => strlen($bytes), 'sha' => $sha, 'title' => $p['title'], 'timestamps' => $p['timestamps'],
            'validity' => $sig['validity'], 'note' => $sig['note'], 'sigs' => $sig['signatures'], 'docs' => $tree($p['documents'])];
    }

    public function document(Request $r, int $id)
    {
        $u = $this->u();
        $d = DB::table('documents')->where('office_id', $u->office_id)->find($id);
        abort_if(! $d, 404);
        if ($d->message_id) {
            Scope::message($u, $d->message_id);
        }
        $bytes = Storage::disk('local')->get($d->path);
        abort_if(hash('sha256', $bytes) !== $d->sha256, 500, 'Az archivált fájl hash-e nem egyezik – a fájl sérült.');
        Audit::log($u->office_id, $u, "Dokumentum megnyitva: {$d->name}", ['client_id' => DB::table('messages')->where('id', $d->message_id)->value('client_id'), 'message_id' => $d->message_id, 'evidence' => "SHA-256 {$d->sha256}"]);
        $inline = $d->mime === 'application/pdf' && ! $r->boolean('dl');

        return response($bytes, 200, ['Content-Type' => $inline ? 'application/pdf' : 'application/octet-stream', 'X-Content-Type-Options' => 'nosniff',
            'Content-Security-Policy' => $inline ? "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; object-src 'self'; frame-ancestors 'self'" : "default-src 'none'; sandbox", 'Content-Disposition' => ($inline ? 'inline' : 'attachment').'; filename="'.rawurlencode($d->name).'"']);
    }

    /** Élő postafiók hozzárendelése egy tárhelyhez (a név a tarhely-cli `mailboxes` kimenetéből jön). */
    public function mapLive(Request $r, int $id)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403, 'Élő postafiókot csak vezető vagy admin rendelhet hozzá.');
        $mb = DB::table('mailboxes')->where('office_id', $u->office_id)->find($id);
        abort_if(! $mb, 404);
        $name = trim((string) $r->input('name')) ?: null;
        abort_if($name !== null && mb_strlen($name) > 200, 422);
        abort_if($name && DB::table('mailboxes')->where('office_id', $u->office_id)->where('live_ref', $name)->where('id', '!=', $id)->exists(), 422, 'Ez az élő postafiók már másik tárhelyhez van rendelve.');
        DB::table('mailboxes')->where('id', $id)->update(['live_ref' => $name]);
        Audit::log($u->office_id, $u, $name ? "Élő postafiók hozzárendelve: $name" : 'Élő postafiók hozzárendelése törölve', ['client_id' => $mb->client_id]);

        return ['ok' => true];
    }

    /**
     * Élő levéllista fogadása az asztali apptól. Csak metaadat érkezik; iratot itt nem tölt le senki,
     * de visszaadja az irodai szabály alapján automatikus letöltésre kijelölt tételeket (`autoDownload`).
     * Idempotens. A lista nem mondja meg, át van-e véve az irat, ezért a hivatalos állapot „listed” (nem ismert).
     */
    public function liveIngest(Request $r)
    {
        $u = $this->u();
        $d = $r->validate([
            'letters' => 'present|array|max:2000',
            'letters.*.eid' => 'required|string|max:80',
            'letters.*.mailbox' => 'required|string|max:200',
            'letters.*.sender' => 'nullable|string|max:120',
            'letters.*.senderFull' => 'nullable|string|max:200',
            'letters.*.recipient' => 'nullable|string|max:200',
            'letters.*.recipientShort' => 'nullable|string|max:64',
            'letters.*.refEid' => 'nullable|string|max:64',
            'letters.*.type' => 'nullable|string|max:200',
            'letters.*.desc' => 'nullable|string|max:300',
            'letters.*.receivedAt' => ['nullable', 'regex:/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/'],
            'letters.*.size' => 'nullable|integer|min:0',
            'letters.*.portalOpened' => 'nullable|boolean',
            'letters.*.expiresAt' => 'nullable|date',
            'letters.*.durable' => 'nullable|boolean',
            'letters.*.folder' => 'nullable|in:BEERKEZETT,TARTOS_TAR,ELKULDOTT',
            'quotas' => 'nullable|array',
            'autoMap' => 'nullable|boolean',
            'portalId' => 'nullable|integer',
            'mailboxes' => 'nullable|array|max:500', // elemei: postafióknév, vagy {name, displayName, type, isDefault} a tárhely postafiók-listájából
            'source' => 'nullable|in:manual,scheduled',
        ]);
        $cids = Scope::clientIds($u);
        $portalId = ! empty($d['portalId']) ? DB::table('portal_connections')->where('office_id', $u->office_id)->where('id', (int) $d['portalId'])->value('id') : null;

        // Kérésre (`autoMap: true`) felderítés: az élő Cégkapu a meglévő ügyfélhez kötődik, az új ügyfélként jön létre,
        // az azonosíthatatlan postafiók „Besorolásra vár” listába kerül (ClientDiscovery).
        $portal = $portalId ? DB::table('portal_connections')->find($portalId) : null;
        // Rendszerválasztó: a kérésben megjelölt belépőn kikapcsolt fajtájú postafiók minden adata kimarad.
        // Ha a kérés nem jelöl meg belépőt (pl. újrahitelesítés), a postafiók saját belépőjének beállítása dönt.
        // A postafiókok adatai a tárhely listájából: megjelenített név (a cég neve), típuskód, a belépő saját postafiókja-e.
        $mbMeta = [];
        $mbNames = [];
        foreach (($d['mailboxes'] ?? []) as $mbItem) {
            $nm = is_array($mbItem) ? ($mbItem['name'] ?? null) : $mbItem;
            if (! is_string($nm) || $nm === '' || mb_strlen($nm) > 200) {
                continue;
            }
            $mbNames[] = $nm;
            if (is_array($mbItem)) {
                $tc = $mbItem['type'] ?? null;
                $mbMeta[$nm] = ['raw' => is_string($mbItem['rawName'] ?? null) ? mb_substr($mbItem['rawName'], 0, 200) : null,
                    'display' => is_string($mbItem['displayName'] ?? null) ? mb_substr($mbItem['displayName'], 0, 200) : null,
                    'type' => is_string($tc) && preg_match('/^[A-Za-z0-9_-]{1,16}$/', $tc) ? $tc : null, 'default' => ($mbItem['isDefault'] ?? false) === true];
            }
        }
        // Frissítés régi adatról: a postafiók kulcsa korábban a puszta név volt, most „név · azonosító eleje”. A már
        // összerendelt postafiókot helyben írjuk át az új kulcsra, hogy az első szinkron ne kettőzze meg a postafiókot és a leveleit.
        // Ugyanígy követjük, ha a tárhely az általános nevet megváltoztatja (az azonosító eleje ugyanaz marad).
        if ($portalId && ClientDiscovery::canDiscover($u, $portal)) {
            foreach ($mbMeta as $newKey => $mm) {
                if (! preg_match('/ · ([^ ·]{8})$/u', $newKey, $sx) || DB::table('mailboxes')->where('office_id', $u->office_id)->where('live_ref', $newKey)->exists()) {
                    continue;
                }
                $old = DB::table('mailboxes')->where('office_id', $u->office_id)->where('live_ref', 'like', '% · '.$sx[1])->get();
                if ($old->isEmpty() && $mm['raw']) {
                    $old = DB::table('mailboxes')->where('office_id', $u->office_id)->where('live_ref', $mm['raw'])
                        ->where(fn ($q) => $q->whereNull('portal_connection_id')->orWhere('portal_connection_id', $portalId))->get();
                }
                if ($old->count() !== 1) {
                    continue;
                }
                DB::table('mailboxes')->where('id', $old[0]->id)->update(['live_ref' => $newKey, 'portal_connection_id' => $old[0]->portal_connection_id ?: $portalId, 'updated_at' => now()]);
                Audit::log($u->office_id, $u, 'Élő postafiók kulcsa frissítve: '.ClientDiscovery::clean($newKey), ['client_id' => $old[0]->client_id, 'evidence' => 'korábbi kulcs: '.ClientDiscovery::clean((string) $old[0]->live_ref)]);
            }
        }
        $offCache = [];
        $systemOff = function (string $name) use (&$offCache, $portal, $u, $mbMeta): bool {
            if (isset($offCache[$name])) {
                return $offCache[$name];
            }
            $via = $portal;
            if ($via === null) {
                $own = DB::table('mailboxes')->where('office_id', $u->office_id)->where('live_ref', $name)->value('portal_connection_id');
                $via = $own ? DB::table('portal_connections')->where('office_id', $u->office_id)->find($own) : null;
            }

            return $offCache[$name] = $via !== null && ! ClientDiscovery::allows($via, ClientDiscovery::kindOf($u->office_id, $name, $mbMeta[$name]['type'] ?? null));
        };
        $discovery = ['created' => 0, 'attached' => 0, 'pending' => 0, 'own' => 0];
        if (! empty($d['autoMap']) && config('iratkapu.live_listing')) {
            // A postafiókok neve a külön listából, a kvótákból és a levelekből áll össze, hogy az üres postafiók is felderüljön.
            $names = array_fill_keys(array_map('strval', array_merge($mbNames, array_keys($d['quotas'] ?? []))), 0);
            foreach ($d['letters'] as $l) {
                $names[$l['mailbox']] = ($names[$l['mailbox']] ?? 0) + 1;
            }
            // A belépőn kikapcsolt rendszer postafiókjáról a felderítés sem tud: se ügyfél, se függő sor nem lesz belőle.
            foreach (array_keys($names) as $n) {
                if ($systemOff((string) $n)) {
                    unset($names[$n]);
                }
            }
            $discovery = ClientDiscovery::discover($u, $portal, $names, $mbMeta);
            $cids = Scope::clientIds($u);
        }
        $boxes = DB::table('mailboxes')->where('office_id', $u->office_id)->whereIn('client_id', $cids)->whereNotNull('live_ref')->get()->keyBy('live_ref');
        foreach (($d['quotas'] ?? []) as $qName => $pct) {
            if (isset($boxes[$qName]) && is_numeric($pct) && ! $systemOff((string) $qName)) {
                DB::table('mailboxes')->where('id', $boxes[$qName]->id)->update(['quota_pct' => max(0, min(100, round((float) $pct, 1)))]);
            }
        }

        $inactiveClients = DB::table('clients')->whereIn('id', $cids)->where('active', false)->pluck('id')->flip();
        // A saját tárhely gyűjtői: az ide érkező ügyfélirat azonosító alapján az ügyfél alá kerül (OwnMailRouter).
        $collectors = DB::table('clients')->whereIn('id', $cids)->where('discovered_via', 'own')->get()->keyBy('id');
        // A címzett külön megy: abból a szétválogató csak javasol, nem sorol be (ott a gazda saját azonosítója állhat).
        $routeText = fn (array $l) => trim(($l['desc'] ?? '').' '.($l['type'] ?? ''));
        $stat = []; // postafiókonként: hány levél volt a listán, ebből hány új – a szinkronnaplóhoz
        $out = ['created' => 0, 'known' => 0, 'unmapped' => 0, 'blocked' => 0, 'inactive' => 0, 'systemOff' => 0, 'routed' => 0, 'autoDownloadDeferred' => 0, 'unmappedNames' => [], 'autoDownload' => [], 'discovery' => $discovery];
        FormCatalog::syncIfNeeded(false, $u);
        $allowed = [];
        foreach ($d['letters'] as $l) {
            if ($systemOff($l['mailbox'])) {
                $out['systemOff']++;

                continue;
            }
            $mb = $boxes[$l['mailbox']] ?? null;
            if (! $mb) {
                $out['unmapped']++;
                $out['unmappedNames'][$l['mailbox']] = true;

                continue;
            }
            if (isset($inactiveClients[$mb->client_id])) {
                $out['inactive']++;

                continue;
            }
            if (! isset($allowed[$mb->id])) {
                try {
                    ConnectorGuard::authorizeLiveListing($mb, $u);
                    $allowed[$mb->id] = true;
                } catch (GateException $e) {
                    $allowed[$mb->id] = false;
                    $out['reason'] = $e->getMessage();
                }
            }
            if (! $allowed[$mb->id]) {
                $out['blocked']++;

                continue;
            }
            $stat[$mb->id] ??= ['listed' => 0, 'created' => 0];
            $stat[$mb->id]['listed']++;
            $folder = $l['folder'] ?? 'BEERKEZETT';
            $isSent = $folder === 'ELKULDOTT';
            if (isset($collectors[$mb->client_id])) {
                if (! $isSent) {
                    $ownRecipients[$mb->client_id][] = trim((string) ($l['recipient'] ?? ''));
                }
                $ownSubjects[$mb->client_id][] = (string) ($l['desc'] ?? '');
            }
            $sid = ($isSent ? 'live-sent-' : 'live-').$l['eid'];
            if ($existing = DB::table('messages')->where('mailbox_id', $mb->id)->where('source_id', $sid)->first()) {
                $out['known']++;
                // A gyűjtőben maradt, ember által még nem érintett irat újra megnézve (pl. az ügyfelet azóta vették fel).
                if (isset($collectors[$existing->client_id]) && OwnMailRouter::route($existing, $collectors[$existing->client_id], $routeText($l), $isSent ? '' : (string) ($l['recipient'] ?? ''), $u)) {
                    $out['routed']++;
                    $existing = DB::table('messages')->find($existing->id);
                    if (! $isSent) {
                        RuleEngine::apply($existing);
                        DeadlineExtractor::pairObligation($existing);
                    } // az új helyén is fusson le, ami új iratnál lefut
                    $existing = DB::table('messages')->find($existing->id);
                }
                // A tárhely típusnevének pótlása, tartós tárba áthelyezés követése, és a még besorolatlan irat újrabesorolása.
                $fix = [];
                if (! $isSent && $folder === 'TARTOS_TAR' && ($existing->folder !== 'TARTOS_TAR' || ! $existing->durable)) {
                    $fix['folder'] = 'TARTOS_TAR';
                    $fix['durable'] = true;
                    $fix['expires_at'] = null;
                }
                if (($existing->live_type ?? null) === null && trim((string) ($l['type'] ?? '')) !== '') {
                    $fix['live_type'] = mb_substr(trim($l['type']), 0, 200);
                }
                if (($existing->ref_eid ?? null) === null && ! empty($l['refEid'])) {
                    $fix['ref_eid'] = mb_substr(trim((string) $l['refEid']), 0, 64);
                }
                $effLiveType = $fix['live_type'] ?? ($existing->live_type ?? null);
                $effRecipient = trim(($l['recipient'] ?? ($existing->recipient ?? '')).' '.($l['recipientShort'] ?? ($existing->recipient_short ?? '')));
                if (empty($existing->form_code) && ($backfilledCode = DeadlineExtractor::extractFormCode($existing->subject, $effLiveType))) {
                    $fix['form_code'] = mb_substr($backfilledCode, 0, 32);
                }
                $retyped = $existing->unknown ? Taxonomy::classify(($l['type'] ?? ($existing->live_type ?? '')).' '.($l['desc'] ?? $existing->subject), trim(($l['sender'] ?? '').' '.($l['senderFull'] ?? '')), (int) $u->office_id, $isSent, $effRecipient, $effLiveType) : null;
                if ($retyped) {
                    $fix += ['type_id' => $retyped->type_id, 'type_label' => $retyped->label, 'type_ai' => true, 'type_group' => $retyped->group ?? null, 'type_risk' => $retyped->risk ?? null,
                        'unknown' => false, 'internal' => $isSent ? 'kesz' : ($existing->internal === 'oszt' ? 'uj' : $existing->internal)];
                }
                if ($fix) {
                    DB::table('messages')->where('id', $existing->id)->update($fix + ['updated_at' => now()]);
                    $existing = DB::table('messages')->find($existing->id);
                    if ($retyped) {
                        Audit::log($u->office_id, $u, 'Irat típusa utólag felismerve: '.$retyped->label, ['client_id' => $existing->client_id, 'message_id' => $existing->id, 'evidence' => 'a típuslista frissítése után, élő lista alapján']);
                        if (! $isSent) {
                            RuleEngine::apply($existing);
                            $existing = DB::table('messages')->find($existing->id);
                        }
                    }
                }
                if (($existing->folder ?? $folder) === 'ELKULDOTT') {
                    SubmissionPairing::pairOnSent($existing);
                } else {
                    SubmissionPairing::pairOnIncoming($existing);
                }
                $existing = DB::table('messages')->find($existing->id);
                if ($auto = DownloadPolicy::autoDecision($existing, $mb)) {
                    $out['autoDownload'][] = self::autoDownloadRow($existing->id, $l, $existing->folder ?? $folder, $auto, $existing);
                }

                continue;
            }
            $subject = trim(($l['desc'] ?? '') ?: ($l['type'] ?? '')) ?: 'Tárgy nélküli küldemény';
            $full = trim(($l['senderFull'] ?? '') ?: ($l['sender'] ?? '')) ?: 'Ismeretlen feladó';
            $short = mb_strtoupper(mb_substr(preg_replace('/[^\pL\pN]/u', '', ($l['sender'] ?? '') ?: $full), 0, 4)) ?: 'ISM';
            $recipientFull = trim((string) ($l['recipient'] ?? '')) ?: null;
            $recipientShort = trim((string) ($l['recipientShort'] ?? '')) ?: ($recipientFull ? (mb_strtoupper(mb_substr(preg_replace('/[^\pL\pN]/u', '', $recipientFull), 0, 12)) ?: null) : null);
            $refEid = trim((string) ($l['refEid'] ?? '')) ?: DeadlineExtractor::extractReferencedEid($subject);
            $liveTypeRaw = trim((string) ($l['type'] ?? '')) !== '' ? mb_substr(trim($l['type']), 0, 200) : null;
            $tax = Taxonomy::classify(($l['type'] ?? '').' '.($l['desc'] ?? ''), trim(($l['sender'] ?? '').' '.($l['senderFull'] ?? '')), (int) $u->office_id, $isSent, trim(($recipientFull ?? '').' '.($recipientShort ?? '')), $liveTypeRaw);
            $durable = (bool) ($l['durable'] ?? ($folder === 'TARTOS_TAR'));
            $arrived = strlen($l['receivedAt'] ?? '') >= 10 ? $l['receivedAt'] : now()->format('Y-m-d H:i');
            $expiresAt = $l['expiresAt'] ?? (! $isSent && ! $durable && strlen((string) $arrived) >= 10 ? Carbon::parse(substr((string) $arrived, 0, 10))->addDays(30)->toDateString() : null);
            $id = DB::table('messages')->insertGetId([
                'office_id' => $u->office_id, 'client_id' => $mb->client_id, 'mailbox_id' => $mb->id, 'source_id' => $sid,
                'sender' => $short, 'sender_full' => $full, 'subject' => $subject, 'type_id' => $tax->type_id ?? 'ismeretlen', 'type_label' => $tax->label ?? 'Ismeretlen típus',
                'type_ai' => (bool) $tax, 'type_group' => $tax->group ?? null, 'type_risk' => $tax->risk ?? null, 'unknown' => ! $tax, 'receipt' => ! $isSent && (bool) preg_match('/nyugta|igazol[aá]s/iu', $subject),
                'arrived_at' => $arrived, 'official' => 'listed', 'internal' => $isSent ? 'kesz' : ($tax ? 'uj' : 'oszt'), 'es3' => false, 'att' => 0,
                'expires_at' => $expiresAt, 'portal_opened' => array_key_exists('portalOpened', $l) ? $l['portalOpened'] : null,
                'durable' => $durable, 'file_size' => $l['size'] ?? null, 'folder' => $folder,
                'live_type' => $liveTypeRaw,
                'form_code' => DeadlineExtractor::extractFormCode($subject, $liveTypeRaw),
                'recipient' => $recipientFull ? mb_substr($recipientFull, 0, 255) : null,
                'recipient_short' => $isSent && $recipientShort ? mb_substr($recipientShort, 0, 64) : null,
                'ref_eid' => $refEid ? mb_substr($refEid, 0, 64) : null,
                'filing_status' => $isSent ? 'pending' : null,
                'created_at' => now(), 'updated_at' => now(),
            ]);
            DB::table('delivery_events')->insert(['office_id' => $u->office_id, 'message_id' => $id, 'type' => 'listazva', 'at' => now(), 'actor_id' => $u->id, 'evidence_ref' => ($isSent ? 'élő ELKÜLDÖTT lista, érkeztetési szám ' : 'élő lista, érkeztetési szám ').$l['eid'], 'created_at' => now(), 'updated_at' => now()]);
            Audit::log($u->office_id, $u, $isSent ? 'Élő elküldött beadvány listázva (nincs átvételi joghatás)' : 'Élő küldemény listázva – az átvétel állapota nem ismert', ['client_id' => $mb->client_id, 'message_id' => $id, 'evidence' => 'tarhely-live list, '.($isSent ? 'ELKULDOTT/' : '').$l['eid'], 'policy' => config('iratkapu.policy_version')]);
            $fresh = DB::table('messages')->find($id);
            if (isset($collectors[$mb->client_id]) && OwnMailRouter::route($fresh, $collectors[$mb->client_id], $routeText($l), $isSent ? '' : (string) ($l['recipient'] ?? ''), $u)) {
                $out['routed']++;
                $fresh = DB::table('messages')->find($id);
            }
            if (! $isSent) {
                $rules = TypeActions::onArrival($id);
                $fresh = DB::table('messages')->find($id);
                if ($rules) {
                    RuleEngine::apply($fresh);
                }
                DeadlineExtractor::pairObligation($fresh);
                TypeActions::autoArchive($id);
                DocumentForward::afterResponse($id, 'arrival');
                SubmissionPairing::pairOnIncoming($id);
            } else {
                TypeActions::autoArchive($id);
                SubmissionPairing::pairOnSent($id);
            }
            $fresh = DB::table('messages')->find($id);
            if ($auto = DownloadPolicy::autoDecision($fresh, $mb)) {
                $out['autoDownload'][] = self::autoDownloadRow($id, $l, $folder, $auto, $fresh);
            }
            $out['created']++;
            $stat[$mb->id]['created']++;
        }
        // Ajánlat a saját tárhely leveleiből: a tárgy elején álló, még ismeretlen azonosító a nevével („azonosító - NÉV - …”).
        // Ügyfelet nem hozunk létre belőle: a gazda dönt (felvétel, „ez én vagyok”, kihagyás). A belépő beállítása szűri a fajtát.
        foreach ($ownSubjects ?? [] as $cid => $subjects) {
            $col = $collectors[$cid];
            $p = $col->portal_connection_id ? DB::table('portal_connections')->find($col->portal_connection_id) : null;
            if (! $p) {
                continue;
            }
            $self = array_map('strval', $p->self_identifiers ? (json_decode($p->self_identifiers, true) ?: []) : []);
            $seen = [];
            foreach ($subjects as $sj) {
                $party = ClientDiscovery::parseSubjectParty($sj);
                if (! $party || isset($seen[$party['identifier']]) || in_array($party['identifier'], $self, true) || ! ClientDiscovery::scopeAllows($p, $party['kind'])) {
                    continue;
                }
                $seen[$party['identifier']] = $party;
            }
            foreach ($seen as $id => $party) {
                $known = DB::table('clients')->where('office_id', $u->office_id)->where(fn ($q) => $q->where('tax', $id)->orWhere('tax', 'like', "$id-%"))->exists();
                if ($known) {
                    continue;
                }
                $letters = DB::table('messages')->where('office_id', $u->office_id)->where('client_id', $cid)->where(fn ($q) => $q->where('subject', 'like', "$id - %")->orWhere('subject', 'like', "$id-%"))->count();
                $row = DB::table('discovered_subjects')->where('office_id', $u->office_id)->where('portal_connection_id', $p->id)->where('identifier', $id)->first();
                if ($row) {
                    DB::table('discovered_subjects')->where('id', $row->id)->update(['letters' => $letters, 'last_seen_at' => now(), 'updated_at' => now()]);
                } else {
                    DB::table('discovered_subjects')->insert(['office_id' => $u->office_id, 'portal_connection_id' => $p->id, 'collector_client_id' => $cid, 'identifier' => $id,
                        'kind' => $party['kind'], 'parsed_name' => $party['name'], 'letters' => $letters, 'state' => 'pending', 'last_seen_at' => now(), 'created_at' => now(), 'updated_at' => now()]);
                }
            }
        }
        // A saját tárhely a tárhely listájában csak általános nevet visel; a tulajdonos nevét a levelek címzettje hordozza.
        // Ha a mostani levelek döntő többsége ugyanannak a személynek szól, a gyűjtő az ő nevét kapja – de csak amíg a neve
        // a program által adott alapnév, kézzel átírt nevet nem írunk felül.
        foreach ($ownRecipients ?? [] as $cid => $names) {
            $col = $collectors[$cid];
            $p = $col->portal_connection_id ? DB::table('portal_connections')->find($col->portal_connection_id) : null;
            if (! $p || $col->name !== ClientDiscovery::clean("Saját tárhely – {$p->name}")) {
                continue;
            }
            $count = array_count_values(array_map(fn ($n) => mb_strtolower($n), array_filter($names, fn ($n) => preg_match('/^[\pL][\pL .\'-]{3,79}$/u', $n))));
            arsort($count);
            $top = array_key_first($count);
            if ($top === null || $count[$top] < 2 || $count[$top] < 0.6 * count($names)) {
                continue;
            }
            DB::table('clients')->where('id', $cid)->update(['name' => ClientDiscovery::clean('Saját tárhely – '.mb_convert_case($top, MB_CASE_TITLE, 'UTF-8')), 'updated_at' => now()]);
        }
        // Hátralék: ami korábban automatikusan letölthető lett volna, de nem került sorra (korlát, megszakadt futás), az a
        // belépő következő szinkronjánál újra sorba áll – akkor is, ha a mostani (növekményes) lista már nem tartalmazza.
        // Az asztali app csak azt tölti le közülük, amit ebben a futásában maga is listázott.
        if ($portalId) {
            $queued = array_flip(array_column($out['autoDownload'], 'id'));
            $backlog = DB::table('messages')->join('mailboxes', 'mailboxes.id', '=', 'messages.mailbox_id')
                ->join('clients', 'clients.id', '=', 'mailboxes.client_id')
                ->where('mailboxes.office_id', $u->office_id)->where('mailboxes.portal_connection_id', $portalId)->whereNotNull('mailboxes.live_ref')
                ->where('clients.active', true)->where('messages.official', 'listed')->where('messages.source_id', 'like', 'live-%')
                ->whereNotExists(fn ($q) => $q->selectRaw('1')->from('documents')->whereColumn('documents.message_id', 'messages.id'))
                ->orderBy('messages.id')->limit(500)->get(['messages.*']);
            $boxes = [];
            foreach ($backlog as $m) {
                if (isset($queued["m{$m->id}"])) {
                    continue;
                }
                $box = $boxes[$m->mailbox_id] ??= DB::table('mailboxes')->find($m->mailbox_id);
                if ($systemOff((string) $box->live_ref)) {
                    continue;
                }
                if ($auto = DownloadPolicy::autoDecision($m, $box)) {
                    $out['autoDownload'][] = self::autoDownloadRow($m->id, ['eid' => self::liveEid($m->source_id), 'mailbox' => $box->live_ref], $m->folder ?: 'BEERKEZETT', $auto, $m);
                }
            }
        }
        // A bejövő tételek (priority = 10) mindig megelőzik az elküldött beadványok archiválását (priority = 50).
        usort($out['autoDownload'], fn ($a, $b) => ($a['priority'] ?? 10) <=> ($b['priority'] ?? 10));
        // Egy futásban legfeljebb 50 automatikus letöltés; a többi a következő szinkronra marad.
        $out['autoDownloadDeferred'] = max(0, count($out['autoDownload']) - 50);
        $out['autoDownload'] = array_slice($out['autoDownload'], 0, 50);
        $actorLabel = ($d['source'] ?? 'manual') === 'scheduled' ? "ütemezett, {$u->name} nevében" : $u->name;
        foreach ($stat as $mid => $st) {
            DB::table('sync_runs')->insert(['office_id' => $u->office_id, 'mailbox_id' => $mid, 'state' => 'ok', 'listed' => $st['listed'], 'created' => $st['created'],
                'note' => 'Élő lista: '.($st['created'] ? "{$st['created']} új" : 'nincs új'), 'actor' => $actorLabel, 'created_at' => now(), 'updated_at' => now()]);
        }
        foreach (array_keys(array_filter($allowed)) as $mid) {
            $mbUpd = ['live_listed_at' => now(), 'sync_state' => 'ok', 'sync_note' => 'Élő lista fogadva', 'last_ok_at' => now()];
            if ($portalId) {
                $mbUpd['portal_connection_id'] = $portalId;
            }
            DB::table('mailboxes')->where('id', $mid)->update($mbUpd);
        }
        if ($portalId) {
            DB::table('portal_connections')->where('id', $portalId)->update(['tarhely_state' => 'ok', 'tarhely_at' => now(), 'last_error' => null, 'updated_at' => now()]);
        }
        $out['unmappedNames'] = array_slice(array_keys($out['unmappedNames']), 0, 20);
        Audit::log($u->office_id, $u, "Élő levéllista fogadva: {$out['created']} új, {$out['known']} ismert, {$out['unmapped']} hozzárendelés nélküli, {$out['blocked']} elutasított", ['evidence' => 'tarhely-live list']);

        return $out;
    }

    /**
     * Irattípus letöltési szabályának irodai felülírása (ADR-009).
     * A vezető csak az alapértéknél nem lazább értéket állíthat; lazítani az admin tud. `default` törli a felülírást.
     */
    public function setTypePolicy(Request $r, string $typeId)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403, 'Letöltési szabályt csak vezető vagy admin módosíthat.');
        $d = $r->validate(['policy' => 'required|in:auto,kezi,csak_lista,default']);
        $type = DB::table('document_types')->where('type_id', $typeId)->first();
        abort_if(! $type, 404, 'Nincs ilyen irattípus.');
        $default = DownloadPolicy::defaultForType($typeId);
        $before = DownloadPolicy::forType($u->office_id, $typeId);
        $new = $d['policy'] === 'default' ? $default : $d['policy'];
        abort_if($u->role !== 'admin' && DownloadPolicy::RANK[$new] < DownloadPolicy::RANK[$default], 403, 'Az alapértéknél lazább letöltési szabályt csak admin állíthat be.');
        if ($new === $default) {
            DB::table('document_type_overrides')->where(['office_id' => $u->office_id, 'type_id' => $typeId])->delete();
        } else {
            DB::table('document_type_overrides')->updateOrInsert(['office_id' => $u->office_id, 'type_id' => $typeId], ['policy' => $new, 'set_by' => $u->id, 'updated_at' => now(), 'created_at' => now()]);
        }
        DownloadPolicy::flush();
        if ($before !== $new) {
            Audit::log($u->office_id, $u, "Letöltési szabály módosítva: {$type->label} – $before → $new", ['policy' => 'ADR-009', 'evidence' => "típus: $typeId, alapérték: $default"]);
        }

        return ['ok' => true, 'typeId' => $typeId, 'dlp' => $new, 'dlpDefault' => $default];
    }

    /**
     * Irattípus irodai beállításai (e-mail, automatikus archiválás, rejtés, kezdő állapot, Joghatály). Bármely kulcs részhalmaza küldhető;
     * ha minden érték az alapértékre esik vissza, a sor törlődik. Vezető vagy admin állíthatja.
     */
    public function setTypeSettings(Request $r, string $typeId)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403, 'Irattípus beállítását csak vezető vagy admin módosíthatja.');
        $d = $r->validate(['emailTo' => 'sometimes|in:'.implode(',', TypeSettings::EMAIL_TO), 'autoArchive' => 'sometimes|boolean', 'hidden' => 'sometimes|boolean',
            'initialState' => 'sometimes|in:'.implode(',', TypeSettings::STATES), 'legalDays' => 'sometimes|nullable|integer|min:1|max:365']);
        $type = DB::table('document_types')->where('type_id', $typeId)->where(fn ($q) => $q->whereNull('office_id')->orWhere('office_id', $u->office_id))->first();
        abort_if(! $type, 404, 'Nincs ilyen irattípus.');
        $defaults = TypeSettings::defaultsFor($typeId);
        $before = TypeSettings::for($u->office_id, $typeId);
        $in = array_intersect_key($d, $defaults) + $before;
        $new = [];
        foreach ($defaults as $k => $def) {
            $new[$k] = is_bool($def) ? (bool) $in[$k] : ($k === 'legalDays' ? ($in[$k] !== null ? (int) $in[$k] : null) : (string) $in[$k]);
        }
        if ($new === $defaults) {
            DB::table('document_type_settings')->where(['office_id' => $u->office_id, 'type_id' => $typeId])->delete();
        } else {
            DB::table('document_type_settings')->updateOrInsert(['office_id' => $u->office_id, 'type_id' => $typeId], ['email_to' => $new['emailTo'], 'auto_archive' => $new['autoArchive'], 'hidden' => $new['hidden'],
                'initial_state' => $new['initialState'], 'legal_days' => $new['legalDays'], 'set_by' => $u->id, 'updated_at' => now(), 'created_at' => now()]);
        }
        TypeSettings::flush();
        $changed = array_keys(array_filter($new, fn ($v, $k) => $v !== $before[$k], ARRAY_FILTER_USE_BOTH));
        if ($changed) {
            $lab = TypeSettings::LABELS;
            $val = TypeSettings::show(...);
            Audit::log($u->office_id, $u, "Irattípus beállítása módosítva: {$type->label} – ".implode(', ', array_map(fn ($k) => "{$lab[$k]}: {$val($k, $before[$k])} → {$val($k, $new[$k])}", $changed)), ['evidence' => "típus: $typeId"]);
        }

        return ['ok' => true, 'typeId' => $typeId, 'settings' => $new];
    }

    /** A beépített és az iroda saját típusai közül a megadott saját típus, vagy 404. */
    private function ownType(object $u, string $typeId): object
    {
        $t = DB::table('document_types')->where('type_id', $typeId)->where('office_id', $u->office_id)->first();
        abort_if(! $t, 404, 'Nincs ilyen saját irattípus.');

        return $t;
    }

    /**
     * Saját irattípus felvétele vagy módosítása: név, kulcsszavak, letöltési szabály. A kulcsszó a feladó nevében, a tárhely
     * típusnevében vagy a tárgyban egész szóként keresve talál. Mentés után a még ember által be nem sorolt iratok újra besorolódnak.
     * Automatikus letöltés itt nem választható: azt utólag, a letöltési szabálynál csak admin állíthatja be (ADR-009).
     */
    public function saveCustomType(Request $r)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403, 'Irattípust csak vezető vagy admin vehet fel.');
        $d = $r->validate(['typeId' => 'nullable|string', 'label' => 'required|string|max:80', 'patterns' => 'required|string|max:2000', 'policy' => 'required|in:kezi,csak_lista']);
        $label = trim($d['label']);
        $patterns = array_values(array_unique(array_filter(array_map('trim', preg_split('/[;,\n]+/u', $d['patterns'])), fn ($p) => $p !== '')));
        abort_if(! $patterns, 422, 'Adj meg legalább egy kulcsszót.');
        foreach ($patterns as $p) {
            abort_if(strlen(Taxonomy::norm($p)) < Taxonomy::OWN_MIN, 422, "Túl rövid kulcsszó: „{$p}”. Legalább ".Taxonomy::OWN_MIN.' betű vagy szám kell.');
        }
        $existing = ! empty($d['typeId']) ? $this->ownType($u, $d['typeId']) : null;
        $clash = DB::table('document_types')->where('label', $label)->where(fn ($q) => $q->whereNull('office_id')->orWhere('office_id', $u->office_id))->when($existing, fn ($q) => $q->where('id', '!=', $existing->id))->exists();
        abort_if($clash, 422, 'Ilyen nevű irattípus már van.');
        $row = ['label' => $label, 'patterns' => json_encode($patterns, JSON_UNESCAPED_UNICODE), 'download_policy' => $d['policy']];
        if ($existing) {
            DB::table('document_types')->where('id', $existing->id)->update($row);
            DB::table('messages')->where('office_id', $u->office_id)->where('type_id', $existing->type_id)->update(['type_label' => $label]);
            $typeId = $existing->type_id;
        } else {
            $typeId = 'sajat.o'.$u->office_id.'.'.(Str::slug($label, '_') ?: 'tipus').'_'.substr(bin2hex(random_bytes(3)), 0, 5);
            DB::table('document_types')->insert($row + ['type_id' => $typeId, 'office_id' => $u->office_id, 'group' => 'Saját típusok', 'priority' => 'P3 – normál', 'risk' => 'ismeretlen', 'version' => 'saját', 'legal_marked' => false]);
        }
        Taxonomy::flush();
        DownloadPolicy::flush();
        Audit::log($u->office_id, $u, ($existing ? 'Saját irattípus módosítva: ' : 'Saját irattípus felvéve: ').$label, ['policy' => 'ADR-009', 'evidence' => 'kulcsszavak: '.implode('; ', $patterns)."; letöltés: {$d['policy']}"]);

        return ['ok' => true, 'typeId' => $typeId, 'retyped' => $this->retypeOffice($u, $typeId)];
    }

    /** Saját irattípus törlése. Az ilyen típusú iratok a többi típus szerint újra besorolódnak, vagy ismeretlenné válnak. */
    public function deleteCustomType(string $typeId)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403, 'Irattípust csak vezető vagy admin törölhet.');
        $t = $this->ownType($u, $typeId);
        DB::table('document_types')->where('id', $t->id)->delete();
        DB::table('document_type_overrides')->where(['office_id' => $u->office_id, 'type_id' => $typeId])->delete();
        DB::table('document_type_settings')->where(['office_id' => $u->office_id, 'type_id' => $typeId])->delete();
        Taxonomy::flush();
        DownloadPolicy::flush();
        TypeSettings::flush();
        Audit::log($u->office_id, $u, 'Saját irattípus törölve: '.$t->label, ['policy' => 'ADR-009', 'evidence' => "típus: $typeId"]);

        return ['ok' => true, 'retyped' => $this->retypeOffice($u, $typeId)];
    }

    /**
     * A saját típus változása után az iroda iratainak újrabesorolása. Csak a gép által besorolt vagy ismeretlen irathoz nyúl
     * (amit ember sorolt be, az marad), kivéve a megszűnt típus iratait: azok mind újra besorolódnak.
     */
    private function retypeOffice(object $u, string $typeId): int
    {
        $gone = ! DB::table('document_types')->where('type_id', $typeId)->exists();
        $rows = DB::table('messages')->where('office_id', $u->office_id)
            ->where(fn ($q) => $q->where('unknown', true)->orWhere('type_ai', true)->orWhere(fn ($q2) => $gone ? $q2->where('type_id', $typeId) : $q2->whereRaw('0 = 1')))->get();
        $n = 0;
        foreach ($rows as $m) {
            $isSent = ($m->folder ?? null) === 'ELKULDOTT';
            $t = Taxonomy::classify(trim(($m->live_type ?? '').' '.$m->subject), trim($m->sender.' '.$m->sender_full), (int) $u->office_id, $isSent, trim(($m->recipient ?? '').' '.($m->recipient_short ?? '')), $m->live_type ?? null);
            $new = $t->type_id ?? 'ismeretlen';
            // Csak az változik, amit a saját típus érint: ami most kerül bele, vagy ami eddig benne volt.
            if ($new === $m->type_id || ($new !== $typeId && $m->type_id !== $typeId)) {
                continue;
            }
            DB::table('messages')->where('id', $m->id)->update(['type_id' => $new, 'type_label' => $t->label ?? 'Ismeretlen típus', 'type_ai' => (bool) $t, 'type_group' => $t->group ?? null, 'type_risk' => $t->risk ?? null,
                'unknown' => ! $t, 'internal' => $isSent ? 'kesz' : ($t && $m->internal === 'oszt' ? 'uj' : $m->internal), 'updated_at' => now()]);
            Audit::log($u->office_id, $u, 'Irat típusa újra besorolva: '.($t->label ?? 'Ismeretlen típus'), ['client_id' => $m->client_id, 'message_id' => $m->id, 'evidence' => 'saját irattípus változása után']);
            if ($t && ! $isSent) {
                RuleEngine::apply(DB::table('messages')->find($m->id));
            }
            $n++;
        }

        return $n;
    }

    /**
     * Az élő letöltés közös kapuja: a letöltés előtti engedélykérés és a fájl fogadása is ezen megy át.
     * A felülíró szabályt csak akkor tartja meg, ha a döntés tényleg arra épül – a típus szerinti
     * automatikus letöltés nem tulajdonítható szabálynak.
     */
    private function gateLiveDownload(string $id, array $d): array
    {
        $u = $this->u();
        $m = Scope::message($u, $this->mid($id));
        $mb = DB::table('mailboxes')->find($m->mailbox_id);
        abort_if(! $mb, 404);
        $rule = ! empty($d['viaRuleId']) ? DB::table('rules')->where('office_id', $u->office_id)->find((int) $d['viaRuleId']) : null;
        $auto = ! empty($d['auto']) || $rule !== null;
        try {
            ConnectorGuard::authorizeLiveDownload($mb, $u, $m, $rule, $auto);
        } catch (GateException $e) {
            abort(422, $e->getMessage());
        }
        if ($auto && (DownloadPolicy::autoDecision($m, $mb)['via'] ?? null) !== 'rule') {
            $rule = null;
        }

        return [$u, $m, $mb, $rule, $auto];
    }

    /**
     * Engedélykérés a tárhelyről való letöltés ELŐTT. Az asztali app csak ennek sikere után nyúlhat a tárhelyhez:
     * a letöltés maga számíthat átvételnek, ezért a tiltásnak azt kell megelőznie, nem az archiválást. Semmit nem módosít.
     */
    public function liveDownloadCheck(Request $r, string $id)
    {
        $d = $r->validate(['viaRuleId' => 'nullable|integer', 'auto' => 'nullable|boolean', 'portalKey' => 'nullable|string|max:80']);
        [$u, $m, $mb, , $auto] = $this->gateLiveDownload($id, $d);
        // Felügyelet nélküli letöltésnél az asztali app megnevezi, melyik belépő munkamenetével töltene le: csak azzal mehet,
        // amelyikhez a postafiók tartozik (ugyanaz a céges postafiók több belépőből is elérhető lehet).
        if (isset($d['portalKey'])) {
            $pid = DB::table('portal_connections')->where('office_id', $u->office_id)->where('vault_key', $d['portalKey'])->value('id');
            abort_if(! $pid || (int) $mb->portal_connection_id !== (int) $pid, 422, 'Ez a postafiók nem ehhez a belépőhöz tartozik; a letöltés nem indul el.');
        }
        // Az `auto` itt a kérés jelzőjének visszhangja: azért megbízható, mert a kapu fent már ellenőrizte, hogy az irat automatikusan letölthető.
        $eid = self::liveEid($m->source_id);
        abort_if(! $mb->live_ref || $eid === null, 422, 'Ez az irat nem élő tárhely-listából érkezett, a tárhelyről nem tölthető le.');

        // Az engedély megnevezi a letöltendő iratot: az asztali főfolyamat ebből dolgozik, nem a felület által adott adatból.
        return ['ok' => true, 'dlp' => DownloadPolicy::forMessage($m, $mb), 'auto' => $auto,
            'eid' => $eid, 'mailbox' => $mb->live_ref, 'folder' => $m->folder ?: 'BEERKEZETT',
            'subject' => $m->subject]; // a főfolyamat ezt összeveti azzal, amit maga listázott a tárhelyről
    }

    /** Élő `source_id` ('live-sent-<eid>' vagy 'live-<eid>') tiszta érkeztetési számmá bontása. */
    public static function liveEid(?string $sourceId): ?string
    {
        $s = (string) ($sourceId ?? '');
        if (str_starts_with($s, 'live-sent-')) {
            return substr($s, 10) !== '' ? substr($s, 10) : null;
        }
        if (str_starts_with($s, 'live-')) {
            return substr($s, 5) !== '' ? substr($s, 5) : null;
        }

        return null;
    }

    /** Az automatikus letöltési sor egy eleme: `via` = 'type' (a típus szabálya) vagy 'rule' (felülíró szabály). */
    private static function autoDownloadRow(int $messageId, array $l, string $folder, array $auto, ?object $msg = null): array
    {
        $subj = trim((string) (($msg->subject ?? null) ?: ($l['desc'] ?? '') ?: ($l['type'] ?? '')));
        $snd = trim((string) (($msg->sender_full ?? null) ?: ($msg->sender ?? null) ?: ($l['senderFull'] ?? '') ?: ($l['sender'] ?? '')));

        return ['id' => "m$messageId", 'eid' => $l['eid'], 'mailbox' => $l['mailbox'], 'folder' => $folder, 'via' => $auto['via'],
            'subject' => $subj !== '' ? mb_substr($subj, 0, 120) : null,
            'sender' => $snd !== '' ? mb_substr($snd, 0, 80) : null,
            'priority' => $folder === 'ELKULDOTT' ? 50 : 10,
            'ruleId' => $auto['rule']->id ?? null, 'ruleName' => $auto['rule']->name ?? null, 'override' => $auto['via'] === 'rule'];
    }

    /**
     * Egyetlen élőben listázott küldemény eredeti fájljának (`.es3` / `.pdf` / `.xml`) fogadása és archiválása
     * dedikált Letöltés gombra vagy az iroda kifejezett letöltési szabálya alapján.
     */
    public function liveDownload(Request $r, string $id)
    {
        $d = $r->validate([
            'fileName' => 'nullable|string|max:160',
            'bytesBase64' => 'nullable|string|max:28000000',
            'viaRuleId' => 'nullable|integer',
            'auto' => 'nullable|boolean',
            'demoSimulate' => 'nullable|boolean',
            'refEid' => 'nullable|string|max:64',
        ]);
        [$u, $m, $mb, $rule, $auto] = $this->gateLiveDownload($id, $d);
        if (! empty($d['demoSimulate']) && config('iratkapu.mode') === 'demo' && empty($d['bytesBase64'])) {
            $sample = (new DemoConnector)->download((object) array_merge((array) $m, ['es3' => true]));
            $fileName = $sample['name'];
            $bytes = $sample['bytes'];
        } else {
            abort_if(empty($d['fileName']) || empty($d['bytesBase64']), 422, 'Hiányzó fájlnév vagy fájltartalom.');
            $fileName = $d['fileName'];
            $bytes = base64_decode($d['bytesBase64'], true);
        }
        abort_if($bytes === false || $bytes === '', 422, 'Érvénytelen vagy üres letöltött fájl.');
        abort_if(strlen($bytes) > config('iratkapu.es3.max_file'), 422, 'A fájl nagyobb a megengedettnél (20 MB).');

        $docId = Documents::store($u->office_id, $m->id, $fileName, $bytes, $u->id);
        $sha = DB::table('documents')->where('id', $docId)->value('sha256');
        $isEs3 = str_ends_with(strtolower($fileName), '.es3');
        $isSent = ($m->folder ?? null) === 'ELKULDOTT';
        $newOff = ($isSent || $m->receipt) ? 'na' : 'ok';
        $childCount = DB::table('documents')->where('message_id', $m->id)->whereNotNull('parent_id')->count();

        DB::transaction(function () use ($u, $m, $docId, $sha, $isEs3, $isSent, $newOff, $childCount, $rule, $auto, $d) {
            DB::table('delivery_events')->insert([
                'office_id' => $u->office_id, 'message_id' => $m->id, 'type' => $isSent ? 'archivalt' : 'atvett', 'at' => now(),
                'actor_id' => $u->id, 'evidence_ref' => ($isSent ? ($auto ? 'automatikus kimenő archiválás' : 'kézi kimenő archiválás') : ($rule ? "automatikus letöltés (szabály #{$rule->id})" : ($auto ? 'automatikus letöltés (az irattípus szabálya)' : 'kézi letöltés a tárhelyről'))).", dokumentum #$docId",
                'evidence_sha256' => $sha, 'created_at' => now(), 'updated_at' => now(),
            ]);
            $msgUpd = [
                'official' => $newOff,
                'official_at' => $isSent ? $m->official_at : ($m->official_at ?? now()),
                'official_by' => $isSent ? $m->official_by : ($m->official_by ?? $u->id),
                'es3' => $isEs3 || (bool) $m->es3,
                'file_size' => strlen(Storage::disk('local')->get(DB::table('documents')->where('id', $docId)->value('path'))),
                'att' => $childCount,
                'portal_opened' => true,
                'updated_at' => now(),
            ];
            if (! empty($d['refEid']) && empty($m->ref_eid)) {
                $msgUpd['ref_eid'] = mb_substr(trim((string) $d['refEid']), 0, 64);
            }
            DB::table('messages')->where('id', $m->id)->update($msgUpd);
            $how = $isSent
                ? ($auto ? 'Élő elküldött beadvány automatikusan archiválva (nincs átvételi joghatás)' : 'Élő elküldött beadvány letöltve és archiválva (nincs átvételi joghatás)')
                : ($rule
                    ? "Élő küldemény automatikusan letöltve joghatályos felülíró szabállyal: {$rule->name}"
                    : ($auto ? 'Élő nyugta automatikusan letöltve az irattípus szabálya szerint' : 'Élő küldemény letöltve és archiválva (kézi parancs)'));
            Audit::log($u->office_id, $u, $how, [
                'client_id' => $m->client_id,
                'message_id' => $m->id,
                'before' => $m->official,
                'after' => $newOff,
                'evidence' => "dokumentum #$docId, SHA-256 $sha",
                'policy' => $rule ? "szabály #{$rule->id} ({$rule->download_mode})" : ($auto ? 'irattípus szabálya: auto' : config('iratkapu.policy_version')),
            ]);
        });

        $enriched = DeadlineExtractor::enrich($m->id);
        if ($isSent) {
            $fresh = DB::table('messages')->find($m->id);
            if ($fresh && ($col = DB::table('clients')->where('id', $fresh->client_id)->where('discovered_via', 'own')->first())) {
                $docText = DB::table('documents')->where('message_id', $m->id)->pluck('text')->filter()->implode(' ');
                OwnMailRouter::route($fresh, $col, trim($fresh->subject.' '.$docText), '', $u);
            }
            SubmissionPairing::pairOnSent($m->id);
        } else {
            LegalDeadline::apply($m->id);
            DocumentForward::afterResponse($m->id, 'downloaded', $auto); // automatikus letöltésnél régi iratról nem megy levél
            SubmissionPairing::pairOnIncoming($m->id);
        }

        return ['ok' => true, 'docId' => $docId, 'sha256' => $sha, 'official' => $newOff, 'enriched' => $enriched];
    }

    /** Ügyfélkapu+ / DÁP portálkapcsolat létrehozása vagy frissítése (titok nélkül: a titok az OS kulcstartójában marad). */
    public function savePortal(Request $r)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403, 'Ügyfélkaput csak vezető vagy admin kezelhet.');
        $d = $r->validate([
            'id' => 'nullable|integer',
            'name' => 'required|string|max:120',
            'notes' => 'nullable|string|max:1000',
            'notifyEmail' => 'nullable|email|max:160',
            'authMode' => 'required|in:totp,email,dap',
            'dlActive' => 'boolean',
            'autoCreate' => 'boolean',
            'systems' => 'nullable|array',
            'systems.*' => 'string|in:'.implode(',', ClientDiscovery::SYSTEMS),
            'selfIds' => 'nullable|string|max:500',
            'subjectScope' => 'nullable|in:business,all',
        ]);
        // A gazda saját azonosítói: adóazonosító jel (10 jegy) vagy adószám (a 8 jegyű törzse tárolódik). A mező elhagyása nem változtat.
        $selfJson = null;
        if (array_key_exists('selfIds', $d)) {
            preg_match_all('/(?<!\d)(?:(8\d{9})|(\d{8})(?:-?\d-?\d{2})?)(?!\d)/', (string) $d['selfIds'], $mm, PREG_SET_ORDER);
            $selfJson = json_encode(array_values(array_unique(array_map(fn ($x) => $x[1] !== '' ? $x[1] : $x[2], $mm))));
        }
        // Mind a négy rendszer = „minden rendszer”, üresen tárolva; a mező elhagyása nem változtat.
        $systems = array_key_exists('systems', $d) && $d['systems'] !== null ? array_values(array_intersect(ClientDiscovery::SYSTEMS, $d['systems'])) : null;
        $systemsJson = $systems === null || count($systems) === count(ClientDiscovery::SYSTEMS) ? null : json_encode($systems);
        if (! empty($d['id'])) {
            $p = DB::table('portal_connections')->where('office_id', $u->office_id)->find((int) $d['id']);
            abort_if(! $p, 404);
            DB::table('portal_connections')->where('id', $p->id)->update([
                'name' => $d['name'], 'notes' => $d['notes'] ?? null, 'notify_email' => $d['notifyEmail'] ?? null,
                'auth_mode' => $d['authMode'], 'download_active' => (bool) ($d['dlActive'] ?? true), 'auto_create_clients' => (bool) ($d['autoCreate'] ?? $p->auto_create_clients), 'subject_scope' => $d['subjectScope'] ?? ($p->subject_scope ?? 'all'), 'enabled_systems' => $systems === null ? $p->enabled_systems : $systemsJson, 'self_identifiers' => $selfJson ?? $p->self_identifiers, 'updated_at' => now(),
            ]);
            Audit::log($u->office_id, $u, "Ügyfélkapu-kapcsolat módosítva: {$d['name']} ({$d['authMode']})");

            return ['ok' => true, 'id' => $p->id, 'vaultKey' => $p->vault_key];
        }
        $vaultKey = 'portal-'.strtolower(Str::random(10));
        $id = DB::table('portal_connections')->insertGetId([
            'office_id' => $u->office_id, 'name' => $d['name'], 'notes' => $d['notes'] ?? null,
            'notify_email' => $d['notifyEmail'] ?? null, 'auth_mode' => $d['authMode'],
            'vault_key' => $vaultKey, 'download_active' => (bool) ($d['dlActive'] ?? true),
            'auto_create_clients' => (bool) ($d['autoCreate'] ?? true), 'subject_scope' => $d['subjectScope'] ?? 'all', 'owner_user_id' => $u->id, 'enabled_systems' => $systemsJson, 'self_identifiers' => $selfJson,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        Audit::log($u->office_id, $u, "Ügyfélkapu-kapcsolat felvéve: {$d['name']} ({$d['authMode']})");

        return ['ok' => true, 'id' => $id, 'vaultKey' => $vaultKey];
    }

    public function portalStatus(Request $r, int $id)
    {
        $u = $this->u();
        $p = DB::table('portal_connections')->where('office_id', $u->office_id)->find($id);
        abort_if(! $p, 404);
        $d = $r->validate([
            'tarhelyState' => 'nullable|in:ok,need,idle',
            'upoState' => 'nullable|in:ok,need,idle',
            'lastError' => 'nullable|string|max:240',
        ]);
        $upd = ['updated_at' => now()];
        if (isset($d['tarhelyState'])) {
            $upd['tarhely_state'] = $d['tarhelyState'];
            if ($d['tarhelyState'] === 'ok') {
                $upd['tarhely_at'] = now();
            }
        }
        if (isset($d['upoState'])) {
            $upd['upo_state'] = $d['upoState'];
            if ($d['upoState'] === 'ok') {
                $upd['upo_at'] = now();
            }
        }
        if (array_key_exists('lastError', $d)) {
            $upd['last_error'] = $d['lastError'];
        }
        DB::table('portal_connections')->where('id', $id)->update($upd);

        return ['ok' => true];
    }

    public function deletePortal(int $id)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403, 'Ügyfélkaput csak vezető vagy admin törölhet.');
        $p = DB::table('portal_connections')->where('office_id', $u->office_id)->find($id);
        abort_if(! $p, 404);
        DB::table('mailboxes')->where('portal_connection_id', $id)->update(['portal_connection_id' => null]);
        DB::table('portal_connections')->where('id', $id)->delete();
        Audit::log($u->office_id, $u, "Ügyfélkapu-kapcsolat törölve: {$p->name}");

        return ['ok' => true, 'vaultKey' => $p->vault_key];
    }

    /** Ügyfélnek menő értesítés ELŐNÉZETE. Semmit nem küld és nem ment. Megmondja azt is, miért nem küldhető. */
    public function noticePreview(string $id)
    {
        $u = $this->u();
        $m = Scope::message($u, $this->mid($id));
        $c = DB::table('clients')->find($m->client_id);
        $contacts = DB::table('client_contacts')->where('client_id', $c->id)->get();
        $sent = DB::table('client_notices')->where('message_id', $m->id)->where('status', 'sent')->pluck('to_email')->all();
        $state = ['wait' => 'még nincs átvéve', 'listed' => 'élő listán látható (még nincs letöltve)', 'ok' => 'átvettük', 'fic' => 'kézbesítési vélelem állt be', 'na' => 'tájékoztató küldemény', 'failed' => 'kézbesítése meghiúsult'][$m->official] ?? 'ismeretlen állapot';
        $body = "Tisztelt Ügyfelünk!\n\nÉrtesítjük, hogy a(z) {$c->name} tárhelyére küldemény érkezett.\n\nFeladó: {$m->sender_full}\nTárgy: {$m->subject}\nÉrkezett: ".substr($m->arrived_at, 0, 16)."\nÁllapot: $state"
            .($m->deadline_date ? "\nHatáridő: {$m->deadline_date}".($m->deadline_sure ? '' : ' (becsült, nem megerősített)') : '')."\n\nAz iratot irodánk kezeli; kérdés esetén keressen minket.\n\nÜdvözlettel:\n{$u->name}\n".DB::table('offices')->where('id', $u->office_id)->value('name');
        $files = DB::table('documents')->where('office_id', $u->office_id)->where('message_id', $m->id)->whereNull('parent_id')->orderBy('id')->get();

        return ['subject' => "Hivatalos küldemény érkezett – {$m->subject}", 'body' => $body,
            'attachments' => $files->map(fn ($f) => ['name' => $f->name, 'size' => (int) $f->size])->values(), 'attachLimit' => self::ATTACH_LIMIT,
            'contacts' => $contacts->map(fn ($k) => ['id' => $k->id, 'name' => $k->name, 'email' => $k->email, 'role' => $k->role, 'already' => in_array($k->email, $sent, true)]),
            'blocked' => $contacts->isEmpty() ? 'Ennél az ügyfélnél nincs értesítési cím. Vegyél fel kapcsolattartót az ügyféladatlapon.' : null];
    }

    private const ATTACH_LIMIT = 15 * 1048576;

    /** A szerkesztőből jövő HTML-ből csak az egyszerű formázás marad; attribútum egyedül a link címe lehet (http, https, mailto). */
    private static function cleanHtml(string $h): string
    {
        $h = strip_tags($h, '<b><strong><i><em><u><p><br><div><ul><ol><li><a>');

        return preg_replace_callback('/<(\/?)([a-z0-9]+)\b([^>]*)>/i', function ($x) {
            $tag = strtolower($x[2]);
            if ($tag === 'a' && $x[1] === '' && preg_match('/href\s*=\s*"((?:https?:\/\/|mailto:)[^"\s<>]+)"/i', $x[3], $h)) {
                return '<a href="'.htmlspecialchars(html_entity_decode($h[1]), ENT_QUOTES).'">';
            }

            return "<{$x[1]}$tag>";
        }, $h);
    }

    /** Küldés: csak előnézetből, emberi kérésre. Ugyanarra az iratra ugyanannak a címzettnek másodszor csak kifejezett megerősítéssel megy. */
    public function noticeSend(Request $r, string $id)
    {
        $u = $this->u();
        $m = Scope::message($u, $this->mid($id));
        $d = $r->validate(['contact' => 'required|integer', 'subject' => 'required|string|max:200', 'body' => 'required|string|max:5000', 'again' => 'boolean', 'html' => 'nullable|string|max:40000', 'attach' => 'boolean']);
        $html = trim(self::cleanHtml($d['html'] ?? '')) ?: null;
        $files = [];
        if (! empty($d['attach'])) { // csak kifejezett kérésre: az irat archivált eredeti fájljai, hash-ellenőrzéssel
            $docs = DB::table('documents')->where('office_id', $u->office_id)->where('message_id', $m->id)->whereNull('parent_id')->orderBy('id')->get();
            abort_if($docs->isEmpty(), 422, 'Ehhez az irathoz nincs csatolható fájl.');
            abort_if($docs->sum('size') > self::ATTACH_LIMIT, 422, 'A csatolmányok együtt meghaladják a 15 MB-ot.');
            foreach ($docs as $f) {
                $bytes = Storage::disk('local')->get($f->path);
                abort_if(hash('sha256', (string) $bytes) !== $f->sha256, 500, 'Az archivált fájl hash-e nem egyezik – a fájl sérült.');
                $files[] = [$f->name, $bytes, $f->mime ?: 'application/octet-stream', $f->sha256];
            }
        }
        $k = DB::table('client_contacts')->where('client_id', $m->client_id)->find($d['contact']);
        abort_if(! $k, 422, 'A címzett nem ehhez az ügyfélhez tartozik.');
        $dup = DB::table('client_notices')->where('message_id', $m->id)->where('to_email', $k->email)->where('status', 'sent')->count();
        abort_if($dup && empty($d['again']), 409, 'Erről az iratról ez a címzett már kapott értesítést.');
        $key = hash('sha256', "{$m->id}|{$k->email}|$dup");
        if (DB::table('client_notices')->where('idempotency_key', $key)->exists()) {
            return ['ok' => true, 'duplicate' => true];
        }
        $nid = DB::table('client_notices')->insertGetId(['office_id' => $u->office_id, 'client_id' => $m->client_id, 'message_id' => $m->id, 'to_email' => $k->email, 'to_name' => $k->name, 'subject' => $d['subject'], 'body' => $d['body'], 'idempotency_key' => $key, 'created_by' => $u->id, 'created_at' => now(), 'updated_at' => now()]);
        try {
            $build = function ($mail) use ($k, $d, $html, $files) {
                $mail->to($k->email, $k->name)->subject($d['subject']);
                if ($html) {
                    $mail->text($d['body']);
                } foreach ($files as $f) {
                    $mail->attachData($f[1], $f[0], ['mime' => $f[2]]);
                }
            };
            $mailer = OfficeMail::mailer($u->office_id);
            $html ? $mailer->send(['html' => new HtmlString($html)], [], $build) : $mailer->raw($d['body'], $build);
            DB::table('client_notices')->where('id', $nid)->update(['status' => 'sent', 'sent_by' => $u->id, 'sent_at' => now()]);
            Audit::log($u->office_id, $u, "Ügyfélértesítés elküldve: {$k->name} ({$k->email})".($files ? ', '.count($files).' csatolmánnyal' : ''), ['client_id' => $m->client_id, 'message_id' => $m->id, 'evidence' => "értesítés #$nid, levelező: ".OfficeMail::label($u->office_id).($files ? ', csatolva: '.implode(', ', array_map(fn ($f) => "{$f[0]} (SHA-256 {$f[3]})", $files)) : ', csatolmány nélkül')]);
        } catch (\Throwable $e) {
            DB::table('client_notices')->where('id', $nid)->update(['status' => 'failed', 'skip_reason' => mb_substr($e->getMessage(), 0, 200)]);
            Audit::log($u->office_id, $u, "Ügyfélértesítés küldése sikertelen: {$k->name}", ['client_id' => $m->client_id, 'message_id' => $m->id]);
            abort(502, 'A levél küldése nem sikerült.');
        }

        return ['ok' => true, 'mailer' => OfficeMail::label($u->office_id), 'attached' => count($files)];
    }

    public function addContact(Request $r, string $id)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403, 'Kapcsolattartót csak vezető vagy admin vehet fel.');
        $c = Scope::client($u, $this->mid($id));
        $d = $r->validate(['name' => 'required|string|max:80', 'email' => 'required|email', 'role' => 'required|string|max:40']);
        DB::table('client_contacts')->insert($d + ['office_id' => $u->office_id, 'client_id' => $c->id]);
        Audit::log($u->office_id, $u, "Kapcsolattartó felvéve: {$d['name']}", ['client_id' => $c->id]);

        return ['ok' => true];
    }

    /** Hitelesség újraellenőrzése az archivált eredetin. */
    public function revalidate(int $id)
    {
        $u = $this->u();
        $d = DB::table('documents')->where('office_id', $u->office_id)->find($id);
        abort_if(! $d || $d->parse_state !== 'kibontva', 404);
        if ($d->message_id) {
            Scope::message($u, $d->message_id);
        }
        $sig = SignatureCheck::check(Storage::disk('local')->get($d->path));
        DB::table('documents')->where('id', $id)->update(['validity' => $sig['validity'], 'validity_note' => $sig['note'], 'signatures' => json_encode($sig['signatures']), 'validated_at' => now()]);
        Audit::log($u->office_id, $u, "Hitelesség újraellenőrizve: {$d->name} → {$sig['validity']}", ['message_id' => $d->message_id, 'evidence' => "SHA-256 {$d->sha256}"]);

        return ['ok' => true, 'validity' => $sig['validity']];
    }

    /** A naptármeghívók állapota a felületnek: be van-e kapcsolva, és hány levél vár kiküldésre. */
    private function calendarState(object $u): array
    {
        $c = CalendarInvites::config($u->office_id);
        // Friss levelezési hiba után fél óráig nem próbálkozik magától; kézzel bármikor indítható.
        $backoff = $c['failedAt'] && now()->diffInMinutes($c['failedAt'], true) < 30;

        return ['on' => $c['on'], 'estimated' => (bool) $c['estimated'], 'mailReady' => $c['mailReady'], 'lastError' => Scope::seesAll($u) ? $c['lastError'] : null,
            'pending' => $c['on'] && $c['mailReady'] ? CalendarInvites::pending($u->office_id) : 0, 'backoff' => $backoff,
            'horizon' => (int) config('iratkapu.invite_horizon_days', 60)];
    }

    /** Naptárfájl (.ics) a számodra látható nyitott határidőkről, a Határidők nézet szűrőivel. */
    public function calendarFile(Request $r)
    {
        $u = $this->u();
        $d = $r->validate(['cats' => 'nullable|string|max:60', 'sure' => 'nullable|in:all,sure,est', 'who' => 'nullable|string|max:8', 'client' => ['nullable', 'regex:/^c?\d+$/']]);
        $f = ['sure' => $d['sure'] ?? 'all', 'client' => isset($d['client']) ? $this->mid($d['client']) : null, 'who' => $this->uid($d['who'] ?? null)];
        if (isset($d['cats'])) {
            $f['cats'] = array_values(array_intersect(DeadlineCalendar::CATS, explode(',', $d['cats'])));
        }
        abort_if(! empty($d['who']) && ! $f['who'], 422, 'Ismeretlen felelős.');
        $items = DeadlineCalendar::items($u->office_id, Scope::clientIds($u), $f);
        $one = $f['client'] ? DB::table('clients')->where('office_id', $u->office_id)->whereIn('id', Scope::clientIds($u))->where('id', $f['client'])->value('name') : null;
        Audit::log($u->office_id, $u, 'Határidők naptárfájlba exportálva ('.count($items).' esemény'.($one ? ", ügyfél: $one" : '').')', ['client_id' => $one ? $f['client'] : null]);

        return response(DeadlineCalendar::ics($items, 'PUBLISH', ['name' => 'KapuMail határidők'.($one ? " – $one" : '')]), 200,
            ['Content-Type' => 'text/calendar; charset=UTF-8', 'Content-Disposition' => 'attachment; filename="kapumail-hataridok.ics"', 'Cache-Control' => 'no-store']);
    }

    /** Naptármeghívók küldése az ügyfelek kapcsolattartóinak: ki/be, és mehet-e becsült határidő. */
    public function calendarSettings(Request $r)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403);
        $d = $r->validate(['on' => 'required|boolean', 'estimated' => 'required|boolean']);
        abort_if($d['on'] && ! CalendarInvites::config($u->office_id)['mailReady'], 422, 'Ehhez előbb az e-mail küldést (SMTP) kell beállítani.');
        CalendarInvites::remember($u->office_id, ['on' => (bool) $d['on'], 'estimated' => (bool) $d['estimated']]);
        Audit::log($u->office_id, $u, 'Naptármeghívók: '.($d['on'] ? 'bekapcsolva' : 'kikapcsolva').', becsült határidő '.($d['estimated'] ? 'jelöléssel kimegy' : 'nem megy ki'));

        return ['ok' => true];
    }

    /** Kapjon-e ez a kapcsolattartó naptármeghívót az ügyfele határidőiről. */
    public function contactCalendar(Request $r, int $id)
    {
        $u = $this->u();
        abort_if(! Scope::seesAll($u), 403, 'Ezt csak vezető vagy admin állíthatja.');
        $k = DB::table('client_contacts')->where('office_id', $u->office_id)->find($id);
        abort_if(! $k, 404);
        Scope::client($u, (int) $k->client_id);
        $on = (bool) $r->validate(['on' => 'required|boolean'])['on'];
        DB::table('client_contacts')->where('id', $k->id)->update(['calendar_invites' => $on]);
        Audit::log($u->office_id, $u, "Naptármeghívó a határidőkről: {$k->name} ({$k->email}) – ".($on ? 'kéri' : 'nem kéri'), ['client_id' => $k->client_id]);

        return ['ok' => true];
    }

    /** Az esedékes naptármeghívók kiküldése most. A beállított szabály szerint megy, ezért bármelyik munkatárs felülete indíthatja. */
    public function calendarSync()
    {
        $u = $this->u();

        return ['ok' => true] + CalendarInvites::sync($u->office_id, $u);
    }

    public function export()
    {
        $u = $this->u();
        $ini = $this->ini();
        $cn = DB::table('clients')->pluck('name', 'id');
        $rows = DB::table('messages')->whereIn('client_id', Scope::clientIds($u))->orderByDesc('arrived_at')->get();
        Audit::log($u->office_id, $u, 'Iratlista exportálva ('.count($rows).' sor)');
        $out = "\xEF\xBB\xBFÜgyfél;Feladó;Tárgy;Típus;Érkezett;Hivatalos állapot;Belső állapot;Felelős;Határidő;Határidő bizonyossága\n";
        foreach ($rows as $m) {
            $out .= implode(';', array_map(fn ($v) => '"'.str_replace('"', '""', (string) $v).'"', [$cn[$m->client_id], $m->sender, $m->subject, $m->type_label, $m->arrived_at, $m->official, $m->internal, $ini[$m->assignee_id] ?? '', $m->deadline_date, $m->deadline_date ? ($m->deadline_sure ? 'megerősített' : 'becsült') : '']))."\n";
        }

        return response($out, 200, ['Content-Type' => 'text/csv; charset=UTF-8', 'Content-Disposition' => 'attachment; filename="iratok.csv"']);
    }
}
