<?php
namespace Tests\Feature;

use App\Iratkapu\{Samples, SignatureCheck};
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\{DB, Storage};
use Tests\TestCase;

/**
 * Élő tárhely-letöltés (dedikált gombra és irodai szabállyal, beleértve a joghatályos felülírást),
 * automatikus Cégkapu-összerendelés, kvótakövetés, tartalmi határidő-kinyerés,
 * valamint NAV adónaptár-fogadás és tárhely-nyugta összepárosítás tesztjei.
 */
class EloLetoltesEsUpoTest extends TestCase
{
    use RefreshDatabase;
    protected bool $seed = true;

    private function u(string $k): User
    {
        return User::where('initials', $k)->firstOrFail();
    }

    public function test_egyedi_elo_irat_letoltes_es3_kibontas_hatarido_es_audit(): void
    {
        Storage::fake('local');
        config(['iratkapu.live_listing' => true]);
        $sn = $this->u('SN');

        // 1) Élő lista fogadása automatikus 8 jegyű adószám-összerendeléssel (Tiszavirág Dental Bt. -> 21094478-1-06) + kvóta
        $boxName = '21094478 (Tiszavirág Dental Bt.)';
        $ingest = $this->actingAs($sn)->postJson('/api/live/ingest', [
            'autoMap' => true,
            'quotas' => [$boxName => 42.5],
            'letters' => [[
                'eid' => 'LIVE-DL-1001',
                'mailbox' => $boxName,
                'sender' => 'NAV',
                'senderFull' => 'Nemzeti Adó- és Vámhivatal',
                // kézi letöltésű (ADR-009: `kezi`) típus; a „csak lista” típusokat a LetoltesiSzabalyTest fedi
                'type' => 'NAV - Tájékoztatás bevallásról',
                'desc' => 'Tájékoztatás bevallásról – 2665',
                'receivedAt' => '2026-11-10 09:30',
                'portalOpened' => false,
                'size' => 18420,
                'folder' => 'BEERKEZETT',
            ]],
        ])->assertOk()->json();

        $this->assertSame(1, $ingest['created']);
        $this->assertSame([], $ingest['autoDownload']); // kézi típusú irat alapból nem kerül automatikus letöltésre

        $m = DB::table('messages')->where('source_id', 'live-LIVE-DL-1001')->first();
        $this->assertNotNull($m);
        $this->assertSame('listed', $m->official);
        $this->assertSame('2026-12-10', $m->expires_at); // 30 napos tárhely-megőrzési határidő
        $this->assertSame(0, (int) $m->portal_opened);

        $mb = DB::table('mailboxes')->find($m->mailbox_id);
        $this->assertSame($boxName, $mb->live_ref);
        $this->assertSame(42.5, (float) $mb->quota_pct);

        // 2) Kikapcsolt IRATKAPU_LIVE_DOWNLOAD mellett a dedikált letöltés is 422-vel zárolt
        config(['iratkapu.live_download' => false]);
        $xml = '<?xml version="1.0" encoding="UTF-8"?><Hatarozat><FizetesiHatarido>2026-12-18</FizetesiHatarido><NyomtatvanyAzonosito>2665</NyomtatvanyAzonosito><Vonalkod>9988776655</Vonalkod></Hatarozat>';
        $es3 = SignatureCheck::signSample(Samples::es3('Átvezetés végzés', [
            'vegzes.pdf' => Samples::pdf('Fizetési határidő: 2026.12.18.'),
            'kisero.xml' => $xml,
        ]));
        $this->postJson("/api/messages/m{$m->id}/live-download", [
            'fileName' => 'atvezetes.es3',
            'bytesBase64' => base64_encode($es3),
        ])->assertStatus(422);
        $this->assertSame('listed', DB::table('messages')->find($m->id)->official);

        // 3) Bekapcsolt IRATKAPU_LIVE_DOWNLOAD mellett a dedikált gomb letölti, kibontja, ellenőrzi és kinyeri a határidőt
        config(['iratkapu.live_download' => true]);
        $dl = $this->postJson("/api/messages/m{$m->id}/live-download", [
            'fileName' => 'atvezetes.es3',
            'bytesBase64' => base64_encode($es3),
        ])->assertOk()->json();

        $this->assertTrue($dl['ok']);
        $this->assertSame('ok', $dl['official']);
        $this->assertSame(64, strlen($dl['sha256']));
        $this->assertSame('2026-12-18', $dl['enriched']['deadline']);

        $after = DB::table('messages')->find($m->id);
        $this->assertSame('ok', $after->official);
        $this->assertSame(1, (int) $after->es3);
        $this->assertSame(2, (int) $after->att);
        $this->assertSame(1, (int) $after->portal_opened);
        $this->assertSame('2026-12-18', $after->deadline_date);
        $this->assertSame(0, (int) $after->deadline_sure); // tartalomból kinyert dátum emberi megerősítésig becsült marad
        $this->assertSame('2665', $after->form_code);
        $this->assertSame('9988776655', $after->barcode);

        $ev = DB::table('delivery_events')->where('message_id', $m->id)->where('type', 'atvett')->first();
        $this->assertNotNull($ev);
        $this->assertSame($dl['sha256'], $ev->evidence_sha256);
        $this->assertTrue(DB::table('audit_events')->where('message_id', $m->id)->where('action', 'Élő küldemény letöltve és archiválva (kézi parancs)')->exists());
    }

    public function test_szabaly_alapu_automatikus_letoltes_nyugtara_es_joghatalyos_felulirasra(): void
    {
        Storage::fake('local');
        config(['iratkapu.live_listing' => true, 'iratkapu.live_download' => true]);
        $sn = $this->u('SN');
        $boxName = '24817365 Borostyán Pékség Kft.';

        $safeRule = DB::table('rules')->where('name', 'Elfogadó nyugták')->first();
        $legalRule = DB::table('rules')->where('name', 'NAV hiánypótlás és határozat')->first();
        $this->assertSame('manual', $legalRule->download_mode);

        // 1) Beérkezik egy elfogadó nyugta és egy NAV határozat: csak a nyugta kerül az autoDownload listába (a típus szabálya szerint)
        $r1 = $this->actingAs($sn)->postJson('/api/live/ingest', [
            'autoMap' => true,
            'letters' => [
                ['eid' => 'E-NYUGTA-1', 'mailbox' => $boxName, 'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal', 'type' => 'Elfogadó nyugta – 2608 bevallás', 'desc' => '', 'receivedAt' => '2026-11-11 08:10'],
                ['eid' => 'E-HATAROZAT-1', 'mailbox' => $boxName, 'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal', 'type' => 'Határozat adókülönbözet megállapításáról', 'desc' => '', 'receivedAt' => '2026-11-11 08:12'],
            ],
        ])->assertOk()->json();

        $this->assertCount(1, $r1['autoDownload']);
        $this->assertSame('E-NYUGTA-1', $r1['autoDownload'][0]['eid']);
        $this->assertFalse($r1['autoDownload'][0]['override']);

        // 2) Nem automatikus típusú iratra a szerver őrfüggvénye elutasítja az automatikus letöltést
        $mHat1 = DB::table('messages')->where('source_id', 'live-E-HATAROZAT-1')->first();
        $this->postJson("/api/messages/m{$mHat1->id}/live-download", [
            'fileName' => 'hatarozat.pdf',
            'bytesBase64' => base64_encode(Samples::pdf('Határozat')),
            'viaRuleId' => $safeRule->id,
        ])->assertStatus(422);

        // 3) Vezető felülíró szabályt állít be a joghatályos NAV határozatokra (auto_override_legal)
        $this->postJson("/api/rules/{$legalRule->id}", [
            'pri' => 'Sürgős',
            'as' => 'LG',
            'notify' => 'Felelősnek azonnal',
            'dlMode' => 'auto_override_legal',
        ])->assertOk();
        $this->assertSame('auto_override_legal', DB::table('rules')->find($legalRule->id)->download_mode);
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', 'Szabály mentve:%')->where('evidence', 'like', '%joghatályos automatikus letöltés felülírása%')->exists());

        // 4) A felülíró szabály az ismert, kézi típusú iratot (bevallási tájékoztatás) automatikusra emeli (override: true);
        //    a „csak lista” típusú átvezetési végzést viszont a felülíró szabály sem tölti le (ADR-009).
        $r2 = $this->postJson('/api/live/ingest', [
            'autoMap' => true,
            'letters' => [
                ['eid' => 'E-HATAROZAT-2', 'mailbox' => $boxName, 'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal', 'type' => 'Tájékoztatás bevallásról – határozat előtt', 'desc' => '', 'receivedAt' => '2026-11-11 09:00'],
                ['eid' => 'E-VEGZES-3', 'mailbox' => $boxName, 'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal', 'type' => 'NAV - Átvezetés végzés', 'desc' => 'Adószámla határozat', 'receivedAt' => '2026-11-11 09:01'],
            ],
        ])->assertOk()->json();

        $this->assertCount(1, $r2['autoDownload']);
        $this->assertSame('E-HATAROZAT-2', $r2['autoDownload'][0]['eid']);
        $this->assertTrue($r2['autoDownload'][0]['override']);

        $mHat2 = DB::table('messages')->where('source_id', 'live-E-HATAROZAT-2')->first();
        $this->postJson("/api/messages/m{$mHat2->id}/live-download", [
            'fileName' => 'potlek.pdf',
            'bytesBase64' => base64_encode(Samples::pdf('Pótlék határozat')),
            'viaRuleId' => $legalRule->id,
        ])->assertOk()->assertJson(['official' => 'ok']);

        $this->assertTrue(DB::table('audit_events')
            ->where('message_id', $mHat2->id)
            ->where('action', 'like', 'Élő küldemény automatikusan letöltve joghatályos felülíró szabállyal:%')
            ->exists());
    }

    public function test_nav_upo_adonaptar_fogadas_nyugta_parositas_es_iroda_szeparacio(): void
    {
        config(['iratkapu.live_listing' => true, 'iratkapu.live_download' => true]);
        $sn = $this->u('SN');
        // A NAV-adatot a belépő gazdája küldi be, adózónként (a NAV-munkamenet egyszerre egy kiválasztott adózó tételeit adja).
        $portalId = DB::table('portal_connections')->insertGetId(['office_id' => $sn->office_id, 'name' => 'SN NAV-belépője', 'auth_mode' => 'totp', 'vault_key' => 'portal-sn-nav',
            'download_active' => true, 'owner_user_id' => $sn->id, 'created_at' => now(), 'updated_at' => now()]);
        $send = fn (string $stem, array $ob) => $this->actingAs($sn)->postJson('/api/nav/ingest', ['portalId' => $portalId, 'subject' => ['stem' => $stem, 'taxId' => null, 'own' => false], 'obligations' => [$ob]])->assertOk()->json('calendar');

        // Borostyán Pékség Kft. (24817365-2-13, LG kezeli) + Tiszavirág Dental Bt. (21094478-1-06, BT kezeli, már van seedelt elutasító 2608 nyugtája!)
        $a = $send('24817365', ['formCode' => '2665', 'title' => 'Általános forgalmi adó bevallás', 'periodStart' => '2026-10-01', 'periodEnd' => '2026-10-31', 'dueDate' => '2026-11-20', 'status' => 'submittable']);
        $b = $send('21094478', ['formCode' => '2608', 'title' => 'Havi járulékbevallás', 'periodStart' => '2026-10-01', 'periodEnd' => '2026-10-31', 'dueDate' => '2026-11-12', 'status' => 'submittable']);
        $c = $send('88888888', ['formCode' => '2665', 'title' => 'Ismeretlen adózó', 'dueDate' => '2026-11-20']);

        $this->assertSame([1, 1, 0], [$a['upserted'], $b['upserted'], $c['upserted']]);
        $this->assertSame([false, 'unknown'], [$c['matched'], $c['reason']]);
        $this->assertGreaterThanOrEqual(1, $b['paired']); // a Tiszavirág 2608 elutasító nyugta automatikusan összepárosodott!

        $tiszavirag = DB::table('clients')->where('tax', '21094478-1-06')->first();
        $ob2608 = DB::table('tax_obligations')->where('client_id', $tiszavirag->id)->where('form_code', '2608')->where('due_date', '2026-11-12')->first();
        $this->assertNotNull($ob2608);
        $this->assertSame('rejected', $ob2608->status);
        $this->assertNotNull($ob2608->receipt_message_id);

        // Beérkező új elfogadó nyugta a Borostyán 2665-re automatikusan 'submitted'-re váltja a kötelezettséget
        $this->postJson('/api/live/ingest', [
            'autoMap' => true,
            'letters' => [[
                'eid' => 'E-BOROSTYAN-2665',
                'mailbox' => '24817365 Borostyán Pékség Kft.',
                'sender' => 'NAV',
                'senderFull' => 'Nemzeti Adó- és Vámhivatal',
                'type' => 'Elfogadó nyugta – 2665 bevallás',
                'desc' => '',
                'receivedAt' => '2026-11-11 10:15',
            ]],
        ])->assertOk();

        $borostyan = DB::table('clients')->where('tax', '24817365-2-13')->first();
        $ob2665 = DB::table('tax_obligations')->where('client_id', $borostyan->id)->where('form_code', '2665')->where('due_date', '2026-11-20')->first();
        $this->assertSame('submitted', $ob2665->status);
        $this->assertNotNull($ob2665->receipt_message_id);

        // Jogosultsági szeparáció: LG nem látja Tiszavirág adónaptár-tételeit, KK (másik iroda) pedig az 1. iroda egyetlen belépőjét vagy tételét sem látja
        $lgState = $this->actingAs($this->u('LG'))->getJson('/api/state')->assertOk()->json();
        $lgOblClients = array_unique(array_column($lgState['obligations'], 'c'));
        $this->assertNotContains("c{$tiszavirag->id}", $lgOblClients);

        $kkState = $this->actingAs($this->u('KK'))->getJson('/api/state')->assertOk()->json();
        $kkVaultKeys = array_column($kkState['portals'], 'vaultKey');
        $this->assertSame(['portal-other'], $kkVaultKeys);
        $this->assertNotContains('portal-sn-ukp', $kkVaultKeys);
        foreach ($kkState['obligations'] as $ko) {
            $this->assertNotEquals("c{$borostyan->id}", $ko['c']);
        }
    }

    public function test_portal_kapcsolat_crud_jogosultsag_es_nulla_titok_invarians(): void
    {
        $lg = $this->u('LG');
        $sn = $this->u('SN');

        // Könyvelő nem vehet fel és nem törölhet Ügyfélkapu-kapcsolatot
        $this->actingAs($lg)->postJson('/api/portals', [
            'name' => 'Teszt ÜK+',
            'authMode' => 'totp',
            'dlActive' => true,
        ])->assertForbidden();

        // Vezető felveheti, állapotát frissítheti, módosíthatja és törölheti
        $created = $this->actingAs($sn)->postJson('/api/portals', [
            'name' => 'Irodai központi ÜK+',
            'notes' => 'Meghatalmazotti kulcs',
            'notifyEmail' => 'sn@iratkapu.test',
            'authMode' => 'totp',
            'dlActive' => true,
        ])->assertOk()->json();

        $this->assertTrue($created['ok']);
        $this->assertStringStartsWith('portal-', $created['vaultKey']);

        $pid = $created['id'];
        $this->postJson("/api/portals/$pid/status", [
            'tarhelyState' => 'ok',
            'upoState' => 'need',
            'lastError' => 'NAV munkamenet lejárt',
        ])->assertOk();

        $pRow = DB::table('portal_connections')->find($pid);
        $this->assertSame('ok', $pRow->tarhely_state);
        $this->assertSame('need', $pRow->upo_state);

        // Állapotban és auditnaplóban soha nem szerepelhet titok
        $stateBody = $this->actingAs($this->u('IA'))->getJson('/api/state')->assertOk()->getContent();
        foreach (['password', 'totpSeed', 'os-vault://', 'remember_token', \Database\Seeders\DatabaseSeeder::DEMO_PASSWORD] as $secretMarker) {
            $this->assertStringNotContainsString($secretMarker, $stateBody);
        }

        $this->actingAs($lg)->deleteJson("/api/portals/$pid")->assertForbidden();
        $del = $this->actingAs($sn)->deleteJson("/api/portals/$pid")->assertOk()->json();
        $this->assertSame($created['vaultKey'], $del['vaultKey']);
        $this->assertNull(DB::table('portal_connections')->find($pid));
    }
}
