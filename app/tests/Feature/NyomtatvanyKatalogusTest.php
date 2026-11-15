<?php

namespace Tests\Feature;

use App\Iratkapu\FormCatalog;
use App\Iratkapu\Taxonomy;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class NyomtatvanyKatalogusTest extends TestCase
{
    use RefreshDatabase;

    protected bool $seed = true;

    protected function setUp(): void
    {
        parent::setUp();
        $this->cleanCatalogCache();
    }

    protected function tearDown(): void
    {
        $this->cleanCatalogCache();
        parent::tearDown();
    }

    private function cleanCatalogCache(): void
    {
        if (File::isDirectory(FormCatalog::cacheDir())) {
            File::deleteDirectory(FormCatalog::cacheDir());
        }
        Cache::forget('iratkapu.catalog_synced');
        FormCatalog::flush();
        Taxonomy::flush();
    }

    private function u(string $k): User
    {
        return User::where('initials', $k)->firstOrFail();
    }

    public function test_kimeno_nyomtatvanyok_es_hatosagi_beadvanyok_felismerese_es_magyar_neve(): void
    {
        config(['iratkapu.live_listing' => true]);
        $sn = $this->u('SN');
        $boxName = '21094478 (Tiszavirág Dental Bt.)';

        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'autoMap' => true,
            'letters' => [
                [
                    'eid' => 'CAT-2608',
                    'mailbox' => $boxName,
                    'sender' => 'Tiszavirág Dental Bt.',
                    'recipient' => 'Nemzeti Adó- és Vámhivatal',
                    'recipientShort' => 'NAV',
                    'type' => '2608',
                    'desc' => '2608 kötegelt nyomtatvány',
                    'receivedAt' => '2026-11-04 10:15',
                    'folder' => 'ELKULDOTT',
                ],
                [
                    'eid' => 'CAT-26A60',
                    'mailbox' => $boxName,
                    'sender' => 'Tiszavirág Dental Bt.',
                    'recipient' => 'Nemzeti Adó- és Vámhivatal',
                    'recipientShort' => 'NAV',
                    'type' => '26A60',
                    'desc' => '26A60',
                    'receivedAt' => '2026-10-20 09:30',
                    'folder' => 'ELKULDOTT',
                ],
                [
                    'eid' => 'CAT-2665',
                    'mailbox' => $boxName,
                    'sender' => 'Tiszavirág Dental Bt.',
                    'recipient' => 'Nemzeti Adó- és Vámhivatal',
                    'recipientShort' => 'NAV',
                    'type' => '2665',
                    'desc' => '2665 kötegelt nyomtatvány',
                    'receivedAt' => '2026-10-20 09:20',
                    'folder' => 'ELKULDOTT',
                ],
                [
                    'eid' => 'CAT-HIPAK',
                    'mailbox' => $boxName,
                    'sender' => 'Tiszavirág Dental Bt.',
                    'recipient' => 'Nemzeti Adó- és Vámhivatal',
                    'recipientShort' => 'NAV',
                    'type' => '26HIPAK',
                    'desc' => '26HIPAK helyi iparűzési adóbevallás',
                    'receivedAt' => '2026-05-25 14:00',
                    'folder' => 'ELKULDOTT',
                ],
                [
                    'eid' => 'CAT-ASP',
                    'mailbox' => $boxName,
                    'sender' => 'Tiszavirág Dental Bt.',
                    'recipient' => 'Szeged Megyei Jogú Város Polgármesteri Hivatala',
                    'recipientShort' => 'ÖNK',
                    'type' => 'ASP-ADO-035',
                    'desc' => 'ASP-ADO-035 helyi iparűzési adó bejelentkezés',
                    'receivedAt' => '2026-06-10 11:00',
                    'folder' => 'ELKULDOTT',
                ],
                [
                    'eid' => 'CAT-OBH',
                    'mailbox' => $boxName,
                    'sender' => 'Tiszavirág Dental Bt.',
                    'recipient' => 'Szegedi Törvényszék Cégbírósága',
                    'recipientShort' => 'CÉGB',
                    'type' => 'OBHIFORM',
                    'desc' => 'OBHIFORM beadvány',
                    'receivedAt' => '2026-07-02 15:10',
                    'folder' => 'ELKULDOTT',
                ],
                [
                    'eid' => 'CAT-2708',
                    'mailbox' => $boxName,
                    'sender' => 'Tiszavirág Dental Bt.',
                    'recipient' => 'Nemzeti Adó- és Vámhivatal',
                    'recipientShort' => 'NAV',
                    'type' => '2708',
                    'desc' => '2708 kötegelt nyomtatvány',
                    'receivedAt' => '2027-02-10 08:40',
                    'folder' => 'ELKULDOTT',
                ],
                [
                    'eid' => 'CAT-PRIV',
                    'mailbox' => $boxName,
                    'sender' => 'Tiszavirág Dental Bt.',
                    'recipient' => 'Magán Szállító Partner Kft.',
                    'type' => 'EGYEDI_DOK',
                    'desc' => 'Teljesítési igazolás megküldése',
                    'receivedAt' => '2026-11-10 16:00',
                    'folder' => 'ELKULDOTT',
                ],
            ],
        ])->assertOk();

        $m2608 = DB::table('messages')->where('source_id', 'live-sent-CAT-2608')->firstOrFail();
        $this->assertFalse((bool) $m2608->unknown);
        $this->assertSame('nav.beadvany.bevallas', $m2608->type_id);
        $this->assertSame('2608', $m2608->form_code);

        $m26a60 = DB::table('messages')->where('source_id', 'live-sent-CAT-26A60')->firstOrFail();
        $this->assertFalse((bool) $m26a60->unknown);
        $this->assertSame('nav.beadvany.bevallas', $m26a60->type_id);
        $this->assertSame('26A60', $m26a60->form_code);

        $m2665 = DB::table('messages')->where('source_id', 'live-sent-CAT-2665')->firstOrFail();
        $this->assertFalse((bool) $m2665->unknown);
        $this->assertSame('nav.beadvany.bevallas', $m2665->type_id);
        $this->assertSame('2665', $m2665->form_code);

        $mHipak = DB::table('messages')->where('source_id', 'live-sent-CAT-HIPAK')->firstOrFail();
        $this->assertSame('onk.beadvany', $mHipak->type_id);
        $this->assertSame('26HIPAK', $mHipak->form_code);

        $mAsp = DB::table('messages')->where('source_id', 'live-sent-CAT-ASP')->firstOrFail();
        $this->assertSame('onk.beadvany', $mAsp->type_id);
        $this->assertSame('ASP-ADO-035', $mAsp->form_code);

        $mObh = DB::table('messages')->where('source_id', 'live-sent-CAT-OBH')->firstOrFail();
        $this->assertSame('ceg.beadvany', $mObh->type_id);
        $this->assertSame('OBHIFORM', $mObh->form_code);

        // Évszámfüggetlen család-felismerés (jövő évi 2708 még nincs az ÁNYK XML-ben, de a 08 családból feloldódik)
        $m2708 = DB::table('messages')->where('source_id', 'live-sent-CAT-2708')->firstOrFail();
        $this->assertFalse((bool) $m2708->unknown);
        $this->assertSame('nav.beadvany.bevallas', $m2708->type_id);
        $this->assertSame('2708', $m2708->form_code);

        // Magáncéges egyedi küldemény továbbra is ismeretlen marad
        $mPriv = DB::table('messages')->where('source_id', 'live-sent-CAT-PRIV')->firstOrFail();
        $this->assertTrue((bool) $mPriv->unknown);

        // A state API visszaadja a magyar nyomtatványneveket a felületnek
        $state = $this->actingAs($sn)->getJson('/api/state')->assertOk()->json();
        $byId = collect($state['messages'])->keyBy('id');

        $row2608 = $byId->get("m{$m2608->id}");
        $this->assertNotNull($row2608['formShort']);
        $this->assertStringContainsString('járulék', mb_strtolower($row2608['formShort']));

        $rowA60 = $byId->get("m{$m26a60->id}");
        $this->assertNotNull($rowA60['formShort']);
        $this->assertStringContainsString('összesítő nyilatkozat', mb_strtolower($rowA60['formShort']));
    }

    public function test_tavoli_katalogus_szinkron_idobelyeg_sha256_ellenorzes_es_utolagos_besorolas(): void
    {
        config([
            'iratkapu.live_listing' => true,
            'iratkapu.catalog_remote_url' => 'https://kapumail.hu/katalogus/manifest.json',
            'iratkapu.catalog_sync_ttl' => 3600,
        ]);
        $sn = $this->u('SN');
        $boxName = '21094478 (Tiszavirág Dental Bt.)';

        // 1. Először egy még teljesen ismeretlen új nyomtatványkód érkezik (pl. NAV_UJ_2027), amikor még a csomagolt katalógus él
        $bundledRaw = file_get_contents(FormCatalog::bundledPath());
        $bundledSha = hash('sha256', $bundledRaw);
        $bundledArr = json_decode($bundledRaw, true);

        $updatedCatalog = $bundledArr;
        $updatedCatalog['version'] = '2026.11.16-1';
        $updatedCatalog['updated_at'] = '2026-11-16T04:15:00Z';
        $updatedCatalog['forms']['Z999X'] = [
            'org' => 'NAV',
            'kind' => 'bevallas',
            'short' => 'Kísérleti új adóbevallás',
            'title' => 'Kísérleti új adóbevallás (Z999X)',
            'sent_type' => 'nav.beadvany.bevallas',
        ];
        $updatedBody = json_encode($updatedCatalog, JSON_UNESCAPED_UNICODE);
        $validSha = hash('sha256', $updatedBody);

        Http::fake([
            'https://kapumail.hu/katalogus/manifest.json' => Http::sequence()
                ->push([
                    'schema' => 1,
                    'version' => $bundledArr['version'],
                    'updated_at' => $bundledArr['updated_at'],
                    'file' => 'nyomtatvanyok-v1.json',
                    'sha256' => $bundledSha,
                ], 200)
                ->push([
                    'schema' => 1,
                    'version' => '2026.11.16-1',
                    'updated_at' => '2026-11-16T04:15:00Z',
                    'file' => 'nyomtatvanyok-v1.json',
                    'sha256' => str_repeat('a', 64),
                ], 200)
                ->push([
                    'schema' => 1,
                    'version' => '2026.11.16-1',
                    'updated_at' => '2026-11-16T04:15:00Z',
                    'file' => 'nyomtatvanyok-v1.json',
                    'sha256' => $validSha,
                ], 200),
            'https://kapumail.hu/katalogus/nyomtatvanyok-v1.json' => Http::sequence()
                ->push($updatedBody, 200)
                ->push($updatedBody, 200),
        ]);

        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'autoMap' => true,
            'letters' => [[
                'eid' => 'CAT-FUTURE-1',
                'mailbox' => $boxName,
                'sender' => 'Tiszavirág Dental Bt.',
                'recipient' => 'Ismeretlen Hatósági Kapu',
                'type' => 'UJBEV99',
                'desc' => 'UJBEV99 adatszolgáltatás',
                'receivedAt' => '2026-11-14 12:00',
                'folder' => 'ELKULDOTT',
            ]],
        ])->assertOk();

        // Változatlan SHA-256 esetén nem töltötte le a nagy JSON fájlt
        Http::assertSentCount(1);

        // Hozzunk létre egy jelenleg ismeretlen (unknown = 1) üzenetet egy teljesen új kóddal
        $unknownId = DB::table('messages')->insertGetId([
            'office_id' => $sn->office_id,
            'client_id' => DB::table('clients')->where('office_id', $sn->office_id)->value('id'),
            'mailbox_id' => DB::table('mailboxes')->where('office_id', $sn->office_id)->value('id'),
            'source_id' => 'live-sent-CAT-NEWCODE',
            'sender' => 'TISZ',
            'sender_full' => 'Tiszavirág Dental Bt.',
            'recipient' => 'Új Szakhatóság',
            'subject' => 'Z999X nyomtatvány',
            'live_type' => 'Z999X',
            'type_id' => 'ismeretlen',
            'type_label' => 'Ismeretlen típus',
            'unknown' => true,
            'official' => 'listed',
            'internal' => 'kesz',
            'folder' => 'ELKULDOTT',
            'arrived_at' => '2026-11-14 13:00',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // 2. Hamis / sérült SHA-256 elutasítása: nem írja felül a katalógust
        $badSync = FormCatalog::syncIfNeeded(true, $sn);
        $this->assertSame('hash_mismatch', $badSync['status']);
        $this->assertSame('bundled', FormCatalog::activeMeta()['source']);
        $this->assertTrue((bool) DB::table('messages')->where('id', $unknownId)->value('unknown'));

        // 3. Érvényes új időbélyeg + egyező SHA-256 esetén letölti, elmenti és utólag újrabesorolja az ismeretlen tételt
        $goodSync = FormCatalog::syncIfNeeded(true, $sn);
        $this->assertSame('updated', $goodSync['status']);
        $this->assertGreaterThanOrEqual(1, $goodSync['reclassified']);
        $this->assertSame('remote', FormCatalog::activeMeta()['source']);
        $this->assertSame('2026.11.16-1', FormCatalog::activeMeta()['version']);

        $reclassified = DB::table('messages')->find($unknownId);
        $this->assertFalse((bool) $reclassified->unknown);
        $this->assertSame('nav.beadvany.bevallas', $reclassified->type_id);
        $this->assertSame('Z999X', $reclassified->form_code);
        $this->assertSame('Kísérleti új adóbevallás', FormCatalog::resolveForm('Z999X')['short']);
    }

    public function test_hamis_pozitiv_evszamok_es_magyar_kozszavak_kiszurese(): void
    {
        // A NAV ÁNYK listában léteznek VALOS, OKO, SZAMLAZO, JEGYZOI, HK és évszámszerű kódok:
        // szabad szövegből ezek nem válhatnak téves nyomtatványkóddá.
        $this->assertNull(FormCatalog::extractFormCode('Valós adatok közlése a 2026. évre, számlázó program használata és jegyzői tájékoztatás'));
        $this->assertNull(FormCatalog::extractFormCode('Határidő: 2026.11.20, hivatkozás: 2025-10-15'));
        $this->assertNull(FormCatalog::extractFormCode('Hivatali kapu üzenet', 'HK'));

        // Valódi nyomtatványkódokat viszont pontosan kinyeri
        $this->assertSame('2608', FormCatalog::extractFormCode('2608 kötegelt nyomtatvány', '2608'));
        $this->assertSame('26A60', FormCatalog::extractFormCode('Elfogadó nyugta – 26A60 összesítő nyilatkozat'));
        $this->assertSame('2665', FormCatalog::extractFormCode('2665M részlap összesítés'));
        $this->assertSame('OSAP-2010', FormCatalog::extractFormCode('KSH OSAP 2010 havi jelentés'));
    }
}
