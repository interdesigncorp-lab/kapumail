<?php
namespace Tests\Feature;

use App\Iratkapu\{DownloadPolicy, LegalDeadline, Samples, TypeActions, TypeSettings};
use Carbon\Carbon;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\{DB, Storage};
use Tests\TestCase;

/** Irattípusonkénti beállítások (e-mail, automatikus archiválás, rejtés, kezdő állapot, Joghatály) – külön tábla, hogy a letöltési szabály törlése ne vigye el. */
class IratipusBeallitasokTest extends TestCase
{
    use RefreshDatabase;
    protected bool $seed = true;

    private const TIPUS = 'nav.felszolitas.hianypotlas';

    protected function setUp(): void { parent::setUp(); TypeSettings::flush(); Storage::fake('local'); config(['iratkapu.live_listing' => true, 'iratkapu.live_download' => true]); }

    private function u(string $k): User { return User::where('initials', $k)->firstOrFail(); }
    private function vezeto(): User { return $this->u('SN'); }
    private function beall(array $d, ?User $u = null, string $t = self::TIPUS) { return $this->actingAs($u ?? $this->vezeto())->postJson("/api/types/$t/settings", $d); }

    public function test_alapertekek_tipusonkent(): void
    {
        $oid = $this->vezeto()->office_id;
        $this->assertSame(TypeSettings::DEFAULTS, TypeSettings::for($oid, self::TIPUS));
        $this->assertSame(TypeSettings::DEFAULTS, TypeSettings::for($oid, 'nincs.ilyen'));
        $this->assertSame(TypeSettings::DEFAULTS, TypeSettings::for($oid, null));
    }

    public function test_beepitett_15_napos_joghataly_alapertekek_es_felulirasuk(): void
    {
        $oid = $this->vezeto()->office_id;
        $joghatalyos = [
            'ceg.cegbirosag.vegzes', 'nav.gepjarmuado', 'nav.folyoszamla.hatarozat_vegzes', 'nav.kezbesitesi_velelem',
            'nav.adoalany.hatarozat', 'nav.birsag.mulasztasi', 'nav.ellenorzes.hatarozat_birsag', 'nav.ellenorzes.eljarasi_vegzes',
            'nav.fizkedv.hatarozat_vegzes', 'nav.igazolas.hatarozat_vegzes', 'nav.illetek.hatarozat_vegzes', 'nav.illetek.fizetesi',
            'nav.jovedek.hatarozat_vegzes', 'nav.rendelkezes.hatarozat', 'nav.beszamolo.hatarozat_vegzes', 'nav.vam.hatarozat_vegzes',
            'nav.vh.vegzes_koltseg',
        ];
        $this->assertSame(17, DB::table('document_types')->whereNotNull('default_legal_days')->count());
        foreach ($joghatalyos as $tid) {
            $this->assertSame(15, TypeSettings::for($oid, $tid)['legalDays'], "Hiányzó 15 napos alapérték: $tid");
        }
        // Részleges módosítás megtartja a beépített 15 napos alapértéket:
        $this->beall(['emailTo' => 'client'], null, 'ceg.cegbirosag.vegzes')->assertOk()
            ->assertJsonPath('settings.emailTo', 'client')
            ->assertJsonPath('settings.legalDays', 15);
        // A 15 napos alapérték üresre (null) is kikapcsolható az irodában, majd 15-re visszaállítva a sor törlődik:
        $this->beall(['emailTo' => 'none', 'legalDays' => null], null, 'ceg.cegbirosag.vegzes')->assertOk()
            ->assertJsonPath('settings.legalDays', null);
        TypeSettings::flush();
        $this->assertNull(TypeSettings::for($oid, 'ceg.cegbirosag.vegzes')['legalDays']);
        $this->assertSame(1, DB::table('document_type_settings')->where('type_id', 'ceg.cegbirosag.vegzes')->count());
        $this->beall(['legalDays' => 15], null, 'ceg.cegbirosag.vegzes')->assertOk()
            ->assertJsonPath('settings.legalDays', 15);
        $this->assertSame(0, DB::table('document_type_settings')->where('type_id', 'ceg.cegbirosag.vegzes')->count());
    }

    public function test_vezeto_menti(): void
    {
        $uj = ['emailTo' => 'both', 'autoArchive' => true, 'hidden' => false, 'initialState' => 'kesz', 'legalDays' => 15];
        $this->beall($uj)->assertOk()->assertJson(['ok' => true, 'typeId' => self::TIPUS, 'settings' => $uj]);
        TypeSettings::flush();
        $this->assertSame($uj, TypeSettings::for($this->vezeto()->office_id, self::TIPUS));
        $t = collect($this->actingAs($this->vezeto())->getJson('/api/state')->json('types'))->firstWhere('type_id', self::TIPUS);
        $this->assertSame($uj, $t['settings']);
        $this->assertSame(TypeSettings::DEFAULTS, collect($this->getJson('/api/state')->json('types'))->firstWhere('type_id', 'nav.tajekoztatas.altalanos')['settings']);
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', 'Irattípus beállítása módosítva:%')->exists());
    }

    public function test_reszhalmaz_megtartja_a_tobbit(): void
    {
        $this->beall(['emailTo' => 'client', 'legalDays' => 8])->assertOk();
        $this->beall(['hidden' => true])->assertOk()->assertJsonPath('settings.emailTo', 'client')->assertJsonPath('settings.legalDays', 8)->assertJsonPath('settings.hidden', true);
    }

    public function test_alapra_visszaallitva_sor_torlodik(): void
    {
        $this->beall(['emailTo' => 'both', 'legalDays' => 15])->assertOk();
        $this->assertSame(1, DB::table('document_type_settings')->count());
        $this->beall(TypeSettings::DEFAULTS)->assertOk()->assertJson(['settings' => TypeSettings::DEFAULTS]);
        $this->assertSame(0, DB::table('document_type_settings')->count());
    }

    public function test_jogosultsag_es_validacio(): void
    {
        $konyvelo = User::where('role', 'konyvelo')->firstOrFail();
        $this->beall(['hidden' => true], $konyvelo)->assertForbidden();
        $this->beall(['legalDays' => 0])->assertStatus(422);
        $this->beall(['legalDays' => 366])->assertStatus(422);
        $this->beall(['emailTo' => 'x'])->assertStatus(422);
        $this->beall(['initialState' => 'x'])->assertStatus(422);
        $this->beall(['hidden' => 'talan'])->assertStatus(422);
        $this->beall(['hidden' => true], null, 'nincs.ilyen')->assertNotFound();
        $this->assertSame(0, DB::table('document_type_settings')->count());
    }

    public function test_letoltesi_szabaly_alapra_allitasa_nem_torli(): void
    {
        $this->beall(['emailTo' => 'both'])->assertOk();
        $this->actingAs($this->vezeto())->postJson('/api/types/' . self::TIPUS . '/policy', ['policy' => 'csak_lista'])->assertOk();
        $this->actingAs($this->vezeto())->postJson('/api/types/' . self::TIPUS . '/policy', ['policy' => 'default'])->assertOk();
        $this->assertSame('both', DB::table('document_type_settings')->where('type_id', self::TIPUS)->value('email_to'));
    }

    public function test_utolso_nem_alap_ertek_visszaallitasa_torli_a_sort(): void
    {
        $this->beall(['hidden' => true])->assertOk();
        $this->assertSame(1, DB::table('document_type_settings')->count());
        $this->beall(['hidden' => false])->assertOk();
        $this->assertSame(0, DB::table('document_type_settings')->count());
        $this->beall(['legalDays' => 15, 'emailTo' => 'client'])->assertOk();
        $this->beall(['legalDays' => null])->assertOk();
        $this->beall(['emailTo' => 'none'])->assertOk();
        $this->assertSame(0, DB::table('document_type_settings')->count());
    }

    public function test_tipusok_normalizalva_mentodnek(): void
    {
        $this->beall(['hidden' => 1, 'autoArchive' => '1', 'legalDays' => '15'])->assertOk()->assertExactJson(['ok' => true, 'typeId' => self::TIPUS, 'settings' => ['emailTo' => 'none', 'autoArchive' => true, 'hidden' => true, 'initialState' => 'uj', 'legalDays' => 15]]);
        $this->beall(['hidden' => 0, 'autoArchive' => '0', 'legalDays' => null])->assertOk();
        $this->assertSame(0, DB::table('document_type_settings')->count());
    }

    public function test_audit_magyarul(): void
    {
        $this->beall(['emailTo' => 'both', 'initialState' => 'ell', 'legalDays' => 15])->assertOk();
        $a = DB::table('audit_events')->where('action', 'like', 'Irattípus beállítása módosítva:%')->value('action');
        foreach (['Email-ben kiküldés: nincs → mindkettőnek', 'Kezdő állapot: új → ellenőrzésre vár', 'Joghatály: nincs → 15 nap'] as $r) $this->assertStringContainsString($r, $a);
        $this->assertStringNotContainsString('emailTo', $a);
    }

    public function test_admin_menthet(): void
    {
        $admin = User::where('role', 'admin')->where('office_id', $this->vezeto()->office_id)->firstOrFail();
        $this->beall(['hidden' => true], $admin)->assertOk();
    }

    public function test_sajat_tipus_torlese_torli_a_beallitast(): void
    {
        $v = $this->vezeto();
        $id = $this->actingAs($v)->postJson('/api/types', ['label' => 'Teszt típus', 'patterns' => 'tesztkulcs', 'policy' => 'kezi'])->assertOk()->json('typeId');
        $this->beall(['emailTo' => 'both'], $v, $id)->assertOk();
        $this->actingAs($v)->deleteJson("/api/types/$id")->assertOk();
        $this->assertSame(0, DB::table('document_type_settings')->where('type_id', $id)->count());
    }

    private array $resp = [];
    private const BOX = '24817365 Borostyán Pékség Kft.';

    private function ingest(string $eid, string $type): object
    {
        $l = ['eid' => $eid, 'type' => $type, 'mailbox' => self::BOX, 'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal', 'desc' => '', 'receivedAt' => '2026-11-11 08:10'];
        $this->resp = $this->actingAs($this->vezeto())->postJson('/api/live/ingest', ['autoMap' => true, 'letters' => [$l]])->assertOk()->json();
        return DB::table('messages')->where('source_id', "live-$eid")->firstOrFail();
    }

    /** Egy „Tájékoztatás bevallásról” levél típusazonosítója (próbabefogadásból). */
    private function tajTipus(): string { return $this->ingest('PROBA', 'Tájékoztatás bevallásról')->type_id; }

    public function test_nem_kell_tipus_rejtett_es_kesz(): void
    {
        $t = $this->tajTipus();
        $this->beall(['hidden' => true], null, $t)->assertOk();
        $m = $this->ingest('HID-1', 'Tájékoztatás bevallásról');
        $this->assertSame([1, 1, 'kesz'], [(int) $m->hidden, (int) $m->archived, $m->internal]);
        $this->assertTrue(DB::table('audit_events')->where('message_id', $m->id)->where('action', 'like', 'Irattípus szabálya alkalmazva:%')->exists());
        $this->assertSame(true, collect($this->getJson('/api/state')->json('messages'))->firstWhere('id', "m{$m->id}")['hid']);
    }

    public function test_kezdo_allapot(): void
    {
        $t = $this->tajTipus();
        DB::table('rules')->where('office_id', $this->vezeto()->office_id)->update(['matcher' => json_encode(['senders' => ['NINCSILYEN']])]);
        $this->beall(['initialState' => 'folyamatban'], null, $t)->assertOk();
        $m = $this->ingest('KA-1', 'Tájékoztatás bevallásról');
        $this->assertSame('folyamatban', $m->internal);
        $this->assertSame([0, 0], [(int) $m->hidden, (int) $m->archived]);
    }

    public function test_szabaly_felulirja_a_kezdo_allapotot(): void
    {
        $t = $this->tajTipus();
        $oid = $this->vezeto()->office_id;
        DB::table('rules')->where('office_id', $oid)->update(['matcher' => json_encode(['senders' => ['NAV']]), 'assignee_id' => $this->vezeto()->id, 'locked' => false, 'priority' => 'Normál']);
        $this->beall(['initialState' => 'folyamatban'], null, $t)->assertOk();
        $this->assertSame('kiosztott', $this->ingest('SZ-1', 'Tájékoztatás bevallásról')->internal);
    }

    public function test_automatikus_archivalas(): void
    {
        $t = $this->tajTipus();
        $this->beall(['autoArchive' => true], null, $t)->assertOk();
        $m = $this->ingest('AA-1', 'Tájékoztatás bevallásról');
        $this->assertSame([1, 'kesz', 0], [(int) $m->archived, $m->internal, (int) $m->hidden]);
    }

    public function test_rejtett_tipus_auto_nyugtanal_sem_tolt_le(): void
    {
        // kontroll: rejtés nélkül a nyugta automatikus letöltésre kerül
        $k = $this->ingest('NY-K', 'Elfogadó nyugta – 2608 bevallás');
        $this->assertCount(1, $this->resp['autoDownload']);
        $this->assertNotNull(DownloadPolicy::autoDecision($k, DB::table('mailboxes')->find($k->mailbox_id)));

        $this->beall(['hidden' => true], null, 'nav.nyugta.elfogado')->assertOk();
        $m = $this->ingest('NY-H', 'Elfogadó nyugta – 2608 bevallás');
        $this->assertSame('nav.nyugta.elfogado', $m->type_id);
        $this->assertSame([], $this->resp['autoDownload']);
        $this->assertSame(0, DB::table('documents')->where('message_id', $m->id)->count());
        $this->assertSame(DownloadPolicy::CSAK_LISTA, DownloadPolicy::forMessage($m, (object) ['type' => 'ÜK', 'portal_connection_id' => null]));
        $this->assertNull(DownloadPolicy::autoDecision($m, DB::table('mailboxes')->find($m->mailbox_id)));
    }

    public function test_kesobb_rejtett_tipusu_irat_sem_tolt_le_automatikusan(): void
    {
        $m = $this->ingest('NY-L', 'Elfogadó nyugta – 2608 bevallás');
        $mb = DB::table('mailboxes')->find($m->mailbox_id);
        DB::table('documents')->where('message_id', $m->id)->delete(); DB::table('messages')->where('id', $m->id)->update(['official' => 'listed']); $m = DB::table('messages')->find($m->id);
        $this->assertNotNull(DownloadPolicy::autoDecision($m, $mb));
        $this->beall(['hidden' => true], null, 'nav.nyugta.elfogado')->assertOk();
        TypeSettings::flush();
        $this->assertSame(0, (int) DB::table('messages')->where('id', $m->id)->value('hidden'));
        $this->assertNull(DownloadPolicy::autoDecision($m, $mb));
    }

    public function test_rejtett_irat_nem_kap_szabalyt(): void
    {
        $t = $this->tajTipus();
        DB::table('rules')->where('office_id', $this->vezeto()->office_id)->update(['matcher' => json_encode(['senders' => ['NAV']]), 'assignee_id' => $this->vezeto()->id, 'locked' => false, 'priority' => 'Sürgős']);
        $this->beall(['hidden' => true], null, $t)->assertOk();
        $m = $this->ingest('HR-1', 'Tájékoztatás bevallásról');
        $this->assertSame([null, 'kesz', 0], [$m->assignee_id, $m->internal, (int) $m->urgent]);
        $this->assertFalse(DB::table('audit_events')->where('message_id', $m->id)->where('action', 'like', 'Szabály alkalmazva:%')->exists());
    }

    public function test_automatikus_archivalas_biztos_hataridonel_kimarad(): void
    {
        $t = $this->tajTipus();
        $this->beall(['autoArchive' => true], null, $t)->assertOk();
        $m = $this->ingest('AB-1', 'Tájékoztatás bevallásról');
        DB::table('messages')->where('id', $m->id)->update(['archived' => false, 'internal' => 'uj', 'deadline_date' => '2026-12-01', 'deadline_sure' => true]);
        TypeActions::autoArchive($m->id);
        $this->assertSame([0, 'uj'], [(int) DB::table('messages')->find($m->id)->archived, DB::table('messages')->find($m->id)->internal]);
        DB::table('messages')->where('id', $m->id)->update(['deadline_sure' => false]);
        TypeActions::autoArchive($m->id);
        $this->assertSame([1, 'kesz'], [(int) DB::table('messages')->find($m->id)->archived, DB::table('messages')->find($m->id)->internal]);
    }

    public function test_ujratipizalas_nem_futtatja_ujra(): void
    {
        $t = $this->tajTipus();
        $m = $this->ingest('RT-1', 'Tájékoztatás bevallásról');
        $this->assertSame('uj', $m->internal);
        $masik = DB::table('document_types')->whereNull('office_id')->where('type_id', '!=', $t)->where('download_policy', 'kezi')->first();
        $this->beall(['initialState' => 'kesz', 'autoArchive' => true], null, $masik->type_id)->assertOk();
        $this->actingAs($this->vezeto())->postJson("/api/messages/m{$m->id}/action", ['action' => 'type', 'to' => $masik->label])->assertOk();
        $after = DB::table('messages')->find($m->id);
        $this->assertSame($masik->type_id, $after->type_id);
        $this->assertSame(['uj', 0], [$after->internal, (int) $after->archived]);
    }

    private function letolt(int $id) { return $this->actingAs($this->vezeto())->postJson("/api/messages/m$id/live-download", ['fileName' => 'irat.pdf', 'bytesBase64' => base64_encode(Samples::pdf('Irat'))]); }

    public function test_due_munkanap(): void
    {
        $this->assertSame('2026-11-26', LegalDeadline::due(Carbon::parse('2026-11-11 09:30'), 15)->toDateString());
    }

    public function test_hetvegere_eso_hatarido_munkanapra_tolodik(): void
    {
        $this->assertSame('2026-11-23', LegalDeadline::due(Carbon::parse('2026-11-06'), 15)->toDateString()); // 21-e szombat
    }

    public function test_letolteskor_beall_becsult_hatarido(): void
    {
        $t = $this->tajTipus();
        $this->beall(['legalDays' => 15], null, $t)->assertOk();
        $m = $this->ingest('LJ-1', 'Tájékoztatás bevallásról');
        $this->assertNull($m->legal_date);
        $this->letolt($m->id)->assertOk();
        $a = DB::table('messages')->find($m->id);
        $this->assertSame(LegalDeadline::due(Carbon::parse($a->official_at), 15)->toDateString(), $a->legal_date);
        $this->assertSame($a->legal_date, $a->deadline_date);
        $this->assertSame([0, 'Irattípus: 15 nap az átvételtől'], [(int) $a->deadline_sure, $a->deadline_source]);
    }

    public function test_meglevo_hataridot_nem_irja_felul(): void
    {
        $t = $this->tajTipus();
        $this->beall(['legalDays' => 15], null, $t)->assertOk();
        $m = $this->ingest('LJ-2', 'Tájékoztatás bevallásról');
        DB::table('messages')->where('id', $m->id)->update(['deadline_date' => '2026-12-01', 'deadline_sure' => true, 'deadline_source' => 'Kézzel']);
        $this->letolt($m->id)->assertOk();
        $a = DB::table('messages')->find($m->id);
        $this->assertSame(['2026-12-01', 1, 'Kézzel'], [$a->deadline_date, (int) $a->deadline_sure, $a->deadline_source]);
        $this->assertNotNull($a->legal_date);
    }

    public function test_atvetel_elott_nincs_datum(): void
    {
        $t = $this->tajTipus();
        $this->beall(['legalDays' => 15], null, $t)->assertOk();
        $m = $this->ingest('LJ-3', 'Tájékoztatás bevallásról');
        LegalDeadline::apply($m->id);
        $a = DB::table('messages')->find($m->id);
        $this->assertSame([null, null], [$a->legal_date, $a->deadline_date]);
    }
}
