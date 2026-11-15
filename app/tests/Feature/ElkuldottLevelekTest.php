<?php

namespace Tests\Feature;

use App\Http\Controllers\AppController;
use App\Iratkapu\Digest;
use App\Iratkapu\DownloadPolicy;
use App\Iratkapu\Notify;
use App\Iratkapu\OfficeMail;
use App\Iratkapu\Samples;
use App\Iratkapu\SignatureCheck;
use App\Mcp\IratkapuServer;
use App\Mcp\McpAccess;
use App\Mcp\Tools;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * Tárhely ELKÜLDÖTT mappa integrációja, source_id ütközésvédelem,
 * joghatás-mentes archiválás és 3 lépcsős érkeztetés-párosítás (SubmissionPairing) tesztjei.
 */
class ElkuldottLevelekTest extends TestCase
{
    use RefreshDatabase;

    protected bool $seed = true;

    private function u(string $k): User
    {
        return User::where('initials', $k)->firstOrFail();
    }

    public function test_elkuldott_es_beerkezett_azonos_eid_nem_utkozik(): void
    {
        config(['iratkapu.live_listing' => true]);
        $sn = $this->u('SN');
        $boxName = '21094478 (Tiszavirág Dental Bt.)';

        $ingest = $this->actingAs($sn)->postJson('/api/live/ingest', [
            'autoMap' => true,
            'letters' => [
                [
                    'eid' => '999000111',
                    'mailbox' => $boxName,
                    'sender' => 'NAV',
                    'senderFull' => 'Nemzeti Adó- és Vámhivatal',
                    'type' => 'NAV - Tájékoztatás bevallásról',
                    'desc' => 'Beérkezett tájékoztatás',
                    'receivedAt' => '2026-11-14 09:00',
                    'folder' => 'BEERKEZETT',
                ],
                [
                    'eid' => '999000111',
                    'mailbox' => $boxName,
                    'sender' => 'Tiszavirág Dental Bt.',
                    'senderFull' => 'Tiszavirág Dental Bt.',
                    'recipient' => 'Nemzeti Adó- és Vámhivatal',
                    'recipientShort' => 'NAV',
                    'type' => 'NAV - 2665 ÁFA bevallás',
                    'desc' => '2665 ÁFA bevallás 2026.10',
                    'receivedAt' => '2026-11-14 08:45',
                    'folder' => 'ELKULDOTT',
                ],
            ],
        ])->assertOk()->json();

        $this->assertSame(2, $ingest['created']);

        $incoming = DB::table('messages')->where('source_id', 'live-999000111')->first();
        $sent = DB::table('messages')->where('source_id', 'live-sent-999000111')->first();

        $this->assertNotNull($incoming);
        $this->assertNotNull($sent);
        $this->assertSame($incoming->mailbox_id, $sent->mailbox_id);
        $this->assertSame('BEERKEZETT', $incoming->folder);

        $this->assertSame('ELKULDOTT', $sent->folder);
        $this->assertSame('listed', $sent->official);
        $this->assertSame('kesz', $sent->internal);
        $this->assertSame('pending', $sent->filing_status);
        $this->assertSame('Nemzeti Adó- és Vámhivatal', $sent->recipient);
        $this->assertSame('NAV', $sent->recipient_short);
        $this->assertNull($sent->expires_at);
    }

    public function test_tartos_tar_athelyezes_tovabbra_is_frissul(): void
    {
        config(['iratkapu.live_listing' => true]);
        $sn = $this->u('SN');
        $boxName = '21094478 (Tiszavirág Dental Bt.)';

        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'autoMap' => true,
            'letters' => [[
                'eid' => '555000222',
                'mailbox' => $boxName,
                'sender' => 'NAV',
                'senderFull' => 'Nemzeti Adó- és Vámhivatal',
                'type' => 'NAV - Értesítés',
                'desc' => 'Értesítés tartós tárba helyezés előtt',
                'receivedAt' => '2026-11-12 10:00',
                'folder' => 'BEERKEZETT',
            ]],
        ])->assertOk();

        $first = DB::table('messages')->where('source_id', 'live-555000222')->first();
        $this->assertNotNull($first);
        $this->assertSame('BEERKEZETT', $first->folder);
        $this->assertFalse((bool) $first->durable);

        // Áthelyezés TARTOS_TAR mappába: frissíti a meglévő live-555000222 sort, nem hoz létre újat
        $res = $this->actingAs($sn)->postJson('/api/live/ingest', [
            'letters' => [[
                'eid' => '555000222',
                'mailbox' => $boxName,
                'sender' => 'NAV',
                'senderFull' => 'Nemzeti Adó- és Vámhivatal',
                'type' => 'NAV - Értesítés',
                'desc' => 'Értesítés tartós tárba helyezés előtt',
                'receivedAt' => '2026-11-12 10:00',
                'durable' => true,
                'folder' => 'TARTOS_TAR',
            ]],
        ])->assertOk()->json();

        $this->assertSame(0, $res['created']);
        $this->assertSame(1, $res['known']);
        $this->assertSame(1, DB::table('messages')->where('mailbox_id', $first->mailbox_id)->where('source_id', 'like', '%555000222')->count());

        $updated = DB::table('messages')->find($first->id);
        $this->assertSame('TARTOS_TAR', $updated->folder);
        $this->assertTrue((bool) $updated->durable);
        $this->assertNull($updated->expires_at);
    }

    public function test_live_eid_helyesen_bontja_le_a_live_sent_prefixet(): void
    {
        $this->assertSame('12345', AppController::liveEid('live-sent-12345'));
        $this->assertSame('12345', AppController::liveEid('live-12345'));
        $this->assertNull(AppController::liveEid('demo-1-1'));
        $this->assertNull(AppController::liveEid(null));

        config(['iratkapu.live_listing' => true, 'iratkapu.live_download' => true]);
        $sn = $this->u('SN');
        $boxName = '21094478 (Tiszavirág Dental Bt.)';

        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'autoMap' => true,
            'letters' => [[
                'eid' => '888777666',
                'mailbox' => $boxName,
                'sender' => 'Tiszavirág Dental Bt.',
                'recipient' => 'Nemzeti Adó- és Vámhivatal',
                'recipientShort' => 'NAV',
                'type' => 'e-Papír beadvány',
                'desc' => 'Méltányossági kérelem',
                'receivedAt' => '2026-11-14 11:00',
                'folder' => 'ELKULDOTT',
            ]],
        ])->assertOk();

        $sent = DB::table('messages')->where('source_id', 'live-sent-888777666')->first();
        $this->assertNotNull($sent);

        $state = $this->actingAs($sn)->getJson('/api/state')->assertOk()->json();
        $stateMsg = collect($state['messages'])->firstWhere('id', 'm'.$sent->id);
        $this->assertNotNull($stateMsg);
        $this->assertSame('888777666', $stateMsg['eid']);

        $check = $this->actingAs($sn)->postJson("/api/messages/m{$sent->id}/live-download-check", [])->assertOk()->json();
        $this->assertSame('888777666', $check['eid']);
        $this->assertSame('ELKULDOTT', $check['folder']);
    }

    public function test_elkuldott_letoltes_nem_ad_joghatast_es_nem_indit_hataridot_tovabbitast(): void
    {
        Storage::fake('local');
        Mail::fake();
        config(['iratkapu.live_listing' => true, 'iratkapu.live_download' => true, 'iratkapu.default_mailer_ok' => true]);
        $sn = $this->u('SN');
        $boxName = '21094478 (Tiszavirág Dental Bt.)';

        // Legyen az ügyfélnek értesítési címzettje és olyan típussal küldjük, aminek van továbbítási / joghatályos nap beállítása
        $client = DB::table('clients')->where('tax', '21094478-1-06')->firstOrFail();
        DB::table('client_contacts')->insert([
            'office_id' => $sn->office_id, 'client_id' => $client->id,
            'name' => 'Ügyvezető', 'email' => 'ugyvezeto@tiszavirag.test', 'role' => 'ügyvezető',
        ]);
        $this->actingAs($sn)->postJson('/api/types/nav.adoalany.hatarozat/settings', [
            'emailTo' => 'both', 'legalDays' => 15,
        ])->assertOk();

        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'autoMap' => true,
            'letters' => [[
                'eid' => 'SENT-DL-4001',
                'mailbox' => $boxName,
                'sender' => 'Tiszavirág Dental Bt.',
                'recipient' => 'Nemzeti Adó- és Vámhivatal',
                'recipientShort' => 'NAV',
                'type' => 'NAV adóalany - I. fokú határozat',
                'desc' => 'Fellebbezés I. fokú határozat ellen',
                'receivedAt' => now()->format('Y-m-d H:i'),
                'folder' => 'ELKULDOTT',
            ]],
        ])->assertOk();

        $sent = DB::table('messages')->where('source_id', 'live-sent-SENT-DL-4001')->firstOrFail();

        $xml = '<?xml version="1.0" encoding="UTF-8"?><Bevallas><NyomtatvanyAzonosito>2665</NyomtatvanyAzonosito><Vonalkod>1122334455</Vonalkod><IdoszakTol>2026-10-01</IdoszakTol><IdoszakIg>2026-10-31</IdoszakIg><FizetesiHatarido>2026-12-20</FizetesiHatarido><HivatkozottErkeztetesiSzam>REF-998877</HivatkozottErkeztetesiSzam></Bevallas>';
        $es3 = SignatureCheck::signSample(Samples::es3('2665 bevallás', [
            'bevallas.pdf' => Samples::pdf('Fizetési határidő: 2026.12.20. 15 munkanapon belül'),
            'bevallas.xml' => $xml,
        ]));

        $dl = $this->actingAs($sn)->postJson("/api/messages/m{$sent->id}/live-download", [
            'fileName' => '2665_bevallas.es3',
            'bytesBase64' => base64_encode($es3),
        ])->assertOk()->json();

        $this->assertTrue($dl['ok']);
        $this->assertSame('na', $dl['official']);

        $after = DB::table('messages')->find($sent->id);
        $this->assertSame('na', $after->official);
        $this->assertNull($after->official_at);
        $this->assertNull($after->deadline_date);
        $this->assertNull($after->legal_date);
        $this->assertSame('2665', $after->form_code);
        $this->assertSame('1122334455', $after->barcode);
        $this->assertSame('2026-10-01', $after->period_from);
        $this->assertSame('2026-10-31', $after->period_to);
        $this->assertSame('REF-998877', $after->ref_eid);

        $ev = DB::table('delivery_events')->where('message_id', $sent->id)->orderByDesc('id')->first();
        $this->assertNotNull($ev);
        $this->assertSame('archivalt', $ev->type);

        // Nincs ügyfél-értesítő továbbítás, nincs emlékeztető és nincs összesítő sor
        $this->assertSame(0, DB::table('client_notices')->where('message_id', $sent->id)->count());
        $this->assertSame(0, DB::table('notifications')->where('message_id', $sent->id)->count());
        $this->assertSame(0, Notify::reminders($sn->office_id));

        DB::table('offices')->where('id', $sn->office_id)->update(['settings' => json_encode(['digest_days' => 1])]);
        DB::table('notifications')->insert([
            'office_id' => $sn->office_id, 'user_id' => $sn->id, 'message_id' => $sent->id,
            'kind' => 'osszesito', 'body' => 'Teszt', 'dedupe_key' => 'test-digest-sent',
            'created_at' => now(), 'updated_at' => now(),
        ]);
        $this->assertSame(0, Digest::run($sn->office_id, now()->addDays(2)));
    }

    public function test_sajat_tarhely_gyujto_nem_veszi_at_az_elkuldott_hatosagi_cimzettet(): void
    {
        config(['iratkapu.live_listing' => true]);
        $lg = $this->u('LG');
        $pid = DB::table('portal_connections')->insertGetId([
            'office_id' => $lg->office_id, 'name' => 'LG saját belépője', 'auth_mode' => 'totp',
            'vault_key' => 'portal-lg-sent-'.uniqid(), 'download_active' => true, 'owner_user_id' => $lg->id,
            'created_at' => now(), 'updated_at' => now(),
        ]);

        $this->actingAs($lg)->postJson('/api/live/ingest', [
            'autoMap' => true, 'portalId' => $pid,
            'letters' => [[
                'eid' => 'INIT-1', 'mailbox' => 'Értesítési tárhely',
                'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal',
                'type' => 'Értesítés', 'desc' => 'Kezdő levél', 'receivedAt' => '2026-11-11 08:10',
            ]],
        ])->assertOk();
        $discId = DB::table('discovered_mailboxes')->where('live_ref', 'Értesítési tárhely')->value('id');
        $this->actingAs($lg)->postJson("/api/discovered/{$discId}", ['action' => 'own'])->assertOk();
        $collector = DB::table('clients')->where('discovered_via', 'own')->firstOrFail();
        $origName = $collector->name;

        // 3 kimenő levél, mindnek a címzettje „Nemzeti Adó És Vámhivatal” — a gyűjtő neve NEM változhat meg NAV-ra!
        $this->actingAs($lg)->postJson('/api/live/ingest', [
            'portalId' => $pid,
            'letters' => [
                ['eid' => 'S-1', 'mailbox' => 'Értesítési tárhely', 'sender' => 'Lakatos Gergő', 'recipient' => 'Nemzeti Adó És Vámhivatal', 'type' => '2665', 'desc' => 'Saját bevallás 1', 'receivedAt' => '2026-11-14 09:00', 'folder' => 'ELKULDOTT'],
                ['eid' => 'S-2', 'mailbox' => 'Értesítési tárhely', 'sender' => 'Lakatos Gergő', 'recipient' => 'Nemzeti Adó És Vámhivatal', 'type' => '2608', 'desc' => 'Saját bevallás 2', 'receivedAt' => '2026-11-14 09:05', 'folder' => 'ELKULDOTT'],
                ['eid' => 'S-3', 'mailbox' => 'Értesítési tárhely', 'sender' => 'Lakatos Gergő', 'recipient' => 'Nemzeti Adó És Vámhivatal', 'type' => '2658', 'desc' => 'Saját bevallás 3', 'receivedAt' => '2026-11-14 09:10', 'folder' => 'ELKULDOTT'],
            ],
        ])->assertOk();

        $afterCollector = DB::table('clients')->find($collector->id);
        $this->assertSame($origName, $afterCollector->name);
        $this->assertStringNotContainsString('Nemzeti Adó', $afterCollector->name);
    }

    public function test_own_mail_router_nem_hatosagi_cimzett_alapjan_iranyit_elkuldott_esetben(): void
    {
        Storage::fake('local');
        config(['iratkapu.live_listing' => true, 'iratkapu.live_download' => true]);
        $lg = $this->u('LG');

        // Hozzunk létre egy ügyfelet, akinek a neve szerepelne a hatósági címzettben, hogy kizárjuk a téves javaslatot
        $fakeAuthClient = DB::table('clients')->insertGetId([
            'office_id' => $lg->office_id, 'name' => 'Vámhivatal Kft', 'tax' => '99887766-1-41', 'active' => true,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        DB::table('client_user')->insert(['client_id' => $fakeAuthClient, 'user_id' => $lg->id]);

        $pid = DB::table('portal_connections')->insertGetId([
            'office_id' => $lg->office_id, 'name' => 'LG saját belépője 2', 'auth_mode' => 'totp',
            'vault_key' => 'portal-lg-rt-'.uniqid(), 'download_active' => true, 'owner_user_id' => $lg->id,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        $this->actingAs($lg)->postJson('/api/live/ingest', [
            'autoMap' => true, 'portalId' => $pid,
            'letters' => [['eid' => 'INIT-2', 'mailbox' => 'Értesítési tárhely', 'sender' => 'NAV', 'type' => 'Értesítés', 'desc' => 'Alap', 'receivedAt' => '2026-11-11 08:10']],
        ])->assertOk();
        $discId = DB::table('discovered_mailboxes')->where('live_ref', 'Értesítési tárhely')->value('id');
        $this->actingAs($lg)->postJson("/api/discovered/{$discId}", ['action' => 'own'])->assertOk();
        $collectorId = (int) DB::table('clients')->where('discovered_via', 'own')->value('id');
        $borostyan = DB::table('clients')->where('tax', '24817365-2-13')->firstOrFail();

        // 1) Tárgyban nincs adószám, a recipient-ben ott a „Vámhivatal Kft” — ELKULDOTT-nál a recipient-et figyelmen kívül kell hagynia!
        $this->actingAs($lg)->postJson('/api/live/ingest', [
            'portalId' => $pid,
            'letters' => [[
                'eid' => 'SENT-OWN-1',
                'mailbox' => 'Értesítési tárhely',
                'sender' => 'Lakatos Gergő',
                'recipient' => 'Nemzeti Adó és Vámhivatal Kft (99887766-1-41)',
                'type' => 'Általános nyomtatvány (ÁNYK)',
                'desc' => 'ÁNYK beküldött nyomtatvány',
                'receivedAt' => '2026-11-14 10:00',
                'folder' => 'ELKULDOTT',
            ]],
        ])->assertOk();

        $m = DB::table('messages')->where('source_id', 'live-sent-SENT-OWN-1')->firstOrFail();
        $this->assertSame($collectorId, (int) $m->client_id);
        $this->assertNull($m->route_suggest_client_id);

        // 2) Letöltéskor a kicsomagolt XML/szöveg tartalmazza a Borostyán Pékség (24817365-2-13) adószámát -> átirányítja Borostyánhoz!
        $zipPath = tempnam(sys_get_temp_dir(), 'krx');
        $zip = new \ZipArchive;
        $zip->open($zipPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE);
        $zip->addFromString('nyomtatvany.xml', '<?xml version="1.0" encoding="UTF-8"?><Anyk><Adoszam>24817365-2-13</Adoszam><NyomtatvanyAzonosito>2665</NyomtatvanyAzonosito></Anyk>');
        $zip->close();
        $krxBytes = file_get_contents($zipPath);
        @unlink($zipPath);

        $this->actingAs($lg)->postJson("/api/messages/m{$m->id}/live-download", [
            'fileName' => 'bekuldott_2665.krx',
            'bytesBase64' => base64_encode($krxBytes),
        ])->assertOk();

        $routed = DB::table('messages')->find($m->id);
        $this->assertSame((int) $borostyan->id, (int) $routed->client_id);
        $this->assertSame($collectorId, (int) $routed->routed_from_client_id);
    }

    public function test_download_policy_bejovo_elony_es_elkuldott_prioritas(): void
    {
        config(['iratkapu.live_listing' => true, 'iratkapu.live_download' => true]);
        $sn = $this->u('SN');
        $boxName = '21094478 (Tiszavirág Dental Bt.)';

        // Előbb egy ismeretlen típusú (magáncéges Cégkapu-küldemény) ELKULDOTT tételt, majd egy bejövő elfogadó nyugtát küldünk be ugyanabban az ingestben
        $ingest = $this->actingAs($sn)->postJson('/api/live/ingest', [
            'autoMap' => true,
            'letters' => [
                [
                    'eid' => 'SENT-PRIO-1',
                    'mailbox' => $boxName,
                    'sender' => 'Tiszavirág Dental Bt.',
                    'recipient' => 'Ismeretlen Üzleti Partner Kft.',
                    'type' => 'Egyedi üzleti küldemény',
                    'desc' => 'Szerződésmelléklet megküldése',
                    'receivedAt' => '2026-11-14 08:00',
                    'folder' => 'ELKULDOTT',
                ],
                [
                    'eid' => 'IN-PRIO-1',
                    'mailbox' => $boxName,
                    'sender' => 'NAV',
                    'senderFull' => 'Nemzeti Adó- és Vámhivatal',
                    'type' => 'NAV - Elfogadó nyugta',
                    'desc' => 'Elfogadó nyugta – 2665 bevallás',
                    'receivedAt' => '2026-11-14 08:05',
                    'folder' => 'BEERKEZETT',
                ],
            ],
        ])->assertOk()->json();

        $sent = DB::table('messages')->where('source_id', 'live-sent-SENT-PRIO-1')->firstOrFail();
        $mb = DB::table('mailboxes')->find($sent->mailbox_id);
        $this->assertTrue((bool) $sent->unknown);
        $this->assertSame(DownloadPolicy::AUTO, DownloadPolicy::forMessage($sent, $mb));

        // Mindkettő bekerült az autoDownload listába, DE a bejövő nyugta (priority = 10) megelőzi az elküldöttet (priority = 50)!
        $this->assertCount(2, $ingest['autoDownload']);
        $this->assertSame('IN-PRIO-1', $ingest['autoDownload'][0]['eid']);
        $this->assertSame(10, $ingest['autoDownload'][0]['priority']);
        $this->assertSame('SENT-PRIO-1', $ingest['autoDownload'][1]['eid']);
        $this->assertSame(50, $ingest['autoDownload'][1]['priority']);
    }

    public function test_parositas_hivatkozott_eid_alapjan(): void
    {
        config(['iratkapu.live_listing' => true]);
        $sn = $this->u('SN');
        $boxName = '21094478 (Tiszavirág Dental Bt.)';

        // 1) Elküldött e-Papír beadvány
        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'autoMap' => true,
            'letters' => [[
                'eid' => 'SENT-EPAPIR-8001',
                'mailbox' => $boxName,
                'sender' => 'Tiszavirág Dental Bt.',
                'recipient' => 'Nemzeti Adó- és Vámhivatal',
                'recipientShort' => 'NAV',
                'type' => 'EPAPIR',
                'desc' => 'Részletfizetési kérelem 2026',
                'receivedAt' => '2026-11-14 09:00',
                'folder' => 'ELKULDOTT',
            ]],
        ])->assertOk();

        $sent = DB::table('messages')->where('source_id', 'live-sent-SENT-EPAPIR-8001')->firstOrFail();
        $this->assertSame('pending', $sent->filing_status);

        // 2) Nem nyugta/igazolás típusú levél (fizetési felszólítás) hivatkozási számmal NEM párosíthat!
        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'letters' => [[
                'eid' => 'IN-DEMAND-8002',
                'mailbox' => $boxName,
                'sender' => 'MVM',
                'senderFull' => 'MVM Next Zrt.',
                'type' => 'Fizetési felszólítás',
                'desc' => 'Fizetési felszólítás tartozás rendezése – hivatkozási szám: SENT-EPAPIR-8001',
                'refEid' => 'SENT-EPAPIR-8001',
                'receivedAt' => '2026-11-14 09:10',
                'folder' => 'BEERKEZETT',
            ]],
        ])->assertOk();

        $sentAfterDemand = DB::table('messages')->find($sent->id);
        $this->assertSame('pending', $sentAfterDemand->filing_status);
        $this->assertNull($sentAfterDemand->filing_receipt_id);

        // 3) Valódi érkeztetési / feldolgozási visszaigazolás ugyanahhoz az EID-hez -> összekapcsolja!
        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'letters' => [[
                'eid' => 'IN-RECEIPT-8003',
                'mailbox' => $boxName,
                'sender' => 'NAV',
                'senderFull' => 'Nemzeti Adó- és Vámhivatal',
                'type' => 'e-Papír visszaigazolás',
                'desc' => 'Érkeztetési igazolás – Hivatkozott érkeztetési szám: SENT-EPAPIR-8001',
                'receivedAt' => '2026-11-14 09:15',
                'folder' => 'BEERKEZETT',
            ]],
        ])->assertOk();

        $receipt = DB::table('messages')->where('source_id', 'live-IN-RECEIPT-8003')->firstOrFail();
        $sentPaired = DB::table('messages')->find($sent->id);
        $this->assertSame('confirmed', $sentPaired->filing_status);
        $this->assertSame((int) $receipt->id, (int) $sentPaired->filing_receipt_id);
        $this->assertSame('SENT-EPAPIR-8001', $receipt->ref_eid);
        $this->assertTrue(
            DB::table('audit_events')->where('message_id', $sent->id)->where('after', 'confirmed')->exists()
        );
    }

    public function test_parositas_vonalkod_es_egyedi_nyomtatvany_idoszak_alapjan(): void
    {
        Storage::fake('local');
        config(['iratkapu.live_listing' => true, 'iratkapu.live_download' => true]);
        $sn = $this->u('SN');
        $boxName = '21094478 (Tiszavirág Dental Bt.)';

        // (a) Vonalkód alapú párosítás
        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'autoMap' => true,
            'letters' => [
                [
                    'eid' => 'SENT-BC-1', 'mailbox' => $boxName, 'sender' => 'Tiszavirág Dental Bt.',
                    'recipient' => 'NAV', 'type' => '2665', 'desc' => '2665 ÁFA bevallás',
                    'receivedAt' => '2026-11-14 08:00', 'folder' => 'ELKULDOTT',
                ],
                [
                    'eid' => 'IN-BC-1', 'mailbox' => $boxName, 'sender' => 'NAV',
                    'type' => 'NAV - Elfogadó nyugta', 'desc' => 'Elfogadó nyugta',
                    'receivedAt' => '2026-11-14 08:04', 'folder' => 'BEERKEZETT',
                ],
            ],
        ])->assertOk();

        $sentBc = DB::table('messages')->where('source_id', 'live-sent-SENT-BC-1')->firstOrFail();
        $inBc = DB::table('messages')->where('source_id', 'live-IN-BC-1')->firstOrFail();

        $es3Sent = SignatureCheck::signSample(Samples::es3('2665', ['b.xml' => '<B><Vonalkod>BC99887766</Vonalkod></B>']));
        $es3In = SignatureCheck::signSample(Samples::es3('Nyugta', ['n.xml' => '<N><Vonalkod>BC99887766</Vonalkod></N>']));

        $this->actingAs($sn)->postJson("/api/messages/m{$sentBc->id}/live-download", ['fileName' => 's.es3', 'bytesBase64' => base64_encode($es3Sent)])->assertOk();
        $this->actingAs($sn)->postJson("/api/messages/m{$inBc->id}/live-download", ['fileName' => 'n.es3', 'bytesBase64' => base64_encode($es3In)])->assertOk();

        $sentBcAfter = DB::table('messages')->find($sentBc->id);
        $this->assertSame('confirmed', $sentBcAfter->filing_status);
        $this->assertSame((int) $inBc->id, (int) $sentBcAfter->filing_receipt_id);

        // (b) Egyedi form_code + period_from + period_to alapján (pontosan 1 jelölt)
        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'letters' => [
                [
                    'eid' => 'SENT-FP-1', 'mailbox' => $boxName, 'sender' => 'Tiszavirág Dental Bt.',
                    'recipient' => 'NAV', 'type' => '2608', 'desc' => '2608 járulékbevallás',
                    'receivedAt' => '2026-11-14 10:00', 'folder' => 'ELKULDOTT',
                ],
                [
                    'eid' => 'IN-FP-1', 'mailbox' => $boxName, 'sender' => 'NAV',
                    'type' => 'NAV - Elfogadó nyugta', 'desc' => 'Elfogadó nyugta – 2608',
                    'receivedAt' => '2026-11-14 10:15', 'folder' => 'BEERKEZETT',
                ],
            ],
        ])->assertOk();

        $sentFp = DB::table('messages')->where('source_id', 'live-sent-SENT-FP-1')->firstOrFail();
        $inFp = DB::table('messages')->where('source_id', 'live-IN-FP-1')->firstOrFail();
        $xmlFp = '<B><NyomtatvanyAzonosito>2608</NyomtatvanyAzonosito><IdoszakTol>2026-10-01</IdoszakTol><IdoszakIg>2026-10-31</IdoszakIg></B>';
        $es3Fp = SignatureCheck::signSample(Samples::es3('2608', ['f.xml' => $xmlFp]));

        $this->actingAs($sn)->postJson("/api/messages/m{$sentFp->id}/live-download", ['fileName' => 's2.es3', 'bytesBase64' => base64_encode($es3Fp)])->assertOk();
        $this->actingAs($sn)->postJson("/api/messages/m{$inFp->id}/live-download", ['fileName' => 'n2.es3', 'bytesBase64' => base64_encode($es3Fp)])->assertOk();

        $this->assertSame('confirmed', DB::table('messages')->find($sentFp->id)->filing_status);

        // (c) Két azonos form_code + időszak jelölt (pl. önellenőrzés vonalkód és EID nélkül): NEM találgat!
        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'letters' => [
                ['eid' => 'SENT-AMB-1', 'mailbox' => $boxName, 'sender' => 'Tiszavirág', 'recipient' => 'NAV', 'type' => '2658', 'desc' => '2658 alap', 'receivedAt' => '2026-11-14 11:00', 'folder' => 'ELKULDOTT'],
                ['eid' => 'SENT-AMB-2', 'mailbox' => $boxName, 'sender' => 'Tiszavirág', 'recipient' => 'NAV', 'type' => '2658', 'desc' => '2658 önellenőrzés', 'receivedAt' => '2026-11-14 11:05', 'folder' => 'ELKULDOTT'],
                ['eid' => 'IN-AMB-1', 'mailbox' => $boxName, 'sender' => 'NAV', 'type' => 'NAV - Elfogadó nyugta', 'desc' => 'Elfogadó nyugta – 2658', 'receivedAt' => '2026-11-14 11:20', 'folder' => 'BEERKEZETT'],
            ],
        ])->assertOk();

        $sAmb1 = DB::table('messages')->where('source_id', 'live-sent-SENT-AMB-1')->firstOrFail();
        $sAmb2 = DB::table('messages')->where('source_id', 'live-sent-SENT-AMB-2')->firstOrFail();
        $inAmb = DB::table('messages')->where('source_id', 'live-IN-AMB-1')->firstOrFail();
        $es3Amb = SignatureCheck::signSample(Samples::es3('2658', ['a.xml' => '<B><NyomtatvanyAzonosito>2658</NyomtatvanyAzonosito><IdoszakTol>2026-09-01</IdoszakTol><IdoszakIg>2026-09-30</IdoszakIg></B>']));

        $this->actingAs($sn)->postJson("/api/messages/m{$sAmb1->id}/live-download", ['fileName' => 'a1.es3', 'bytesBase64' => base64_encode($es3Amb)])->assertOk();
        $this->actingAs($sn)->postJson("/api/messages/m{$sAmb2->id}/live-download", ['fileName' => 'a2.es3', 'bytesBase64' => base64_encode($es3Amb)])->assertOk();
        $this->actingAs($sn)->postJson("/api/messages/m{$inAmb->id}/live-download", ['fileName' => 'an.es3', 'bytesBase64' => base64_encode($es3Amb)])->assertOk();

        $this->assertSame('pending', DB::table('messages')->find($sAmb1->id)->filing_status);
        $this->assertSame('pending', DB::table('messages')->find($sAmb2->id)->filing_status);
    }

    public function test_elutasitas_felulirja_a_korabbi_allapotot_es_forditott_sorrendben_is_mukodik(): void
    {
        config(['iratkapu.live_listing' => true]);
        $sn = $this->u('SN');
        $boxName = '21094478 (Tiszavirág Dental Bt.)';

        // 1) Előbb feladási igazolás (confirmed), majd elutasító nyugta (rejected), végül egy későn befutó feladási nyugta (marad rejected!)
        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'autoMap' => true,
            'letters' => [
                ['eid' => 'SENT-REJ-1', 'mailbox' => $boxName, 'sender' => 'Tiszavirág', 'recipient' => 'NAV', 'type' => '2665', 'desc' => '2665 ÁFA', 'receivedAt' => '2026-11-14 08:00', 'folder' => 'ELKULDOTT'],
                ['eid' => 'IN-ACK-1', 'mailbox' => $boxName, 'sender' => 'BKSZ', 'type' => 'FeladasiIgazolas', 'desc' => 'Feladási igazolás', 'refEid' => 'SENT-REJ-1', 'receivedAt' => '2026-11-14 08:01', 'folder' => 'BEERKEZETT'],
            ],
        ])->assertOk();

        $sent1 = DB::table('messages')->where('source_id', 'live-sent-SENT-REJ-1')->firstOrFail();
        $this->assertSame('confirmed', $sent1->filing_status);

        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'letters' => [[
                'eid' => 'IN-ERR-1', 'mailbox' => $boxName, 'sender' => 'NAV',
                'type' => 'NAV - Elutasító nyugta', 'desc' => 'Elutasító nyugta – hibás XML séma',
                'refEid' => 'SENT-REJ-1', 'receivedAt' => '2026-11-14 08:10', 'folder' => 'BEERKEZETT',
            ]],
        ])->assertOk();

        $errMsg = DB::table('messages')->where('source_id', 'live-IN-ERR-1')->firstOrFail();
        $sent1AfterErr = DB::table('messages')->find($sent1->id);
        $this->assertSame('rejected', $sent1AfterErr->filing_status);
        $this->assertSame((int) $errMsg->id, (int) $sent1AfterErr->filing_receipt_id);

        // Későbbi sima visszaigazolás NEM írhatja vissza rejected -> confirmed-re
        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'letters' => [[
                'eid' => 'IN-LATE-ACK', 'mailbox' => $boxName, 'sender' => 'BKSZ',
                'type' => 'LetoltesiIgazolas', 'desc' => 'Letöltési igazolás',
                'refEid' => 'SENT-REJ-1', 'receivedAt' => '2026-11-14 08:15', 'folder' => 'BEERKEZETT',
            ]],
        ])->assertOk();
        $this->assertSame('rejected', DB::table('messages')->find($sent1->id)->filing_status);

        // 2) Fordított sorrend: előbb érkezik be a nyugta, utána olvassuk be az ELKULDOTT mappát
        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'letters' => [[
                'eid' => 'IN-FIRST-1', 'mailbox' => $boxName, 'sender' => 'NAV',
                'type' => 'NAV - Elfogadó nyugta', 'desc' => 'Elfogadó nyugta – Hivatkozott érkeztetési szám: SENT-SECOND-1',
                'receivedAt' => '2026-11-14 09:05', 'folder' => 'BEERKEZETT',
            ]],
        ])->assertOk();
        $inFirst = DB::table('messages')->where('source_id', 'live-IN-FIRST-1')->firstOrFail();

        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'letters' => [[
                'eid' => 'SENT-SECOND-1', 'mailbox' => $boxName, 'sender' => 'Tiszavirág',
                'recipient' => 'NAV', 'type' => '2665', 'desc' => '2665 bevallás',
                'receivedAt' => '2026-11-14 09:00', 'folder' => 'ELKULDOTT',
            ]],
        ])->assertOk();

        $sentSecond = DB::table('messages')->where('source_id', 'live-sent-SENT-SECOND-1')->firstOrFail();
        $this->assertSame('confirmed', $sentSecond->filing_status);
        $this->assertSame((int) $inFirst->id, (int) $sentSecond->filing_receipt_id);
    }

    public function test_gyujto_fiok_kozotti_parositas_csak_azonos_portal_tulajdonosnal(): void
    {
        config(['iratkapu.live_listing' => true]);
        $lg = $this->u('LG');
        $kk = User::where('initials', 'KK')->firstOrFail(); // Másik iroda!

        // LG saját tárhelye
        $pid = DB::table('portal_connections')->insertGetId([
            'office_id' => $lg->office_id, 'name' => 'LG saját belépője 3', 'auth_mode' => 'totp',
            'vault_key' => 'portal-lg-pair-'.uniqid(), 'download_active' => true, 'owner_user_id' => $lg->id,
            'created_at' => now(), 'updated_at' => now(),
        ]);
        $this->actingAs($lg)->postJson('/api/live/ingest', [
            'autoMap' => true, 'portalId' => $pid,
            'letters' => [['eid' => 'INIT-3', 'mailbox' => 'Értesítési tárhely', 'sender' => 'NAV', 'type' => 'Értesítés', 'desc' => 'Alap', 'receivedAt' => '2026-11-11 08:10']],
        ])->assertOk();
        $discId = DB::table('discovered_mailboxes')->where('live_ref', 'Értesítési tárhely')->value('id');
        $this->actingAs($lg)->postJson("/api/discovered/{$discId}", ['action' => 'own'])->assertOk();

        // 1) Másik iroda (KK) azonos refEid-ű nyugtája SOHA nem párosodhat LG irodájának levelével
        $otherCid = DB::table('clients')->insertGetId(['office_id' => $kk->office_id, 'name' => 'Idegen Kft.', 'tax' => '77665544-1-42', 'active' => true, 'created_at' => now(), 'updated_at' => now()]);
        DB::table('mailboxes')->insert(['office_id' => $kk->office_id, 'client_id' => $otherCid, 'type' => 'CK', 'live_ref' => '77665544 (Idegen Kft.)', 'sync_state' => 'ok', 'created_at' => now(), 'updated_at' => now()]);

        $this->actingAs($lg)->postJson('/api/live/ingest', [
            'portalId' => $pid,
            'letters' => [[
                'eid' => 'SENT-COLL-901', 'mailbox' => 'Értesítési tárhely', 'sender' => 'Lakatos Gergő',
                'recipient' => 'NAV', 'type' => '2665', 'desc' => 'ÁNYK beküldés (tárgyban még nincs adószám)',
                'receivedAt' => '2026-11-14 09:00', 'folder' => 'ELKULDOTT',
            ]],
        ])->assertOk();
        $sentColl = DB::table('messages')->where('source_id', 'live-sent-SENT-COLL-901')->firstOrFail();

        $this->actingAs($kk)->postJson('/api/live/ingest', [
            'letters' => [[
                'eid' => 'IN-FOREIGN-901', 'mailbox' => '77665544 (Idegen Kft.)', 'sender' => 'NAV',
                'type' => 'NAV - Elfogadó nyugta', 'desc' => 'Elfogadó nyugta', 'refEid' => 'SENT-COLL-901',
                'receivedAt' => '2026-11-14 09:05', 'folder' => 'BEERKEZETT',
            ]],
        ])->assertOk();
        $this->assertSame('pending', DB::table('messages')->find($sentColl->id)->filing_status);

        // 2) Két különböző rendes cég között sincs keresztpárosítás (Tiszavirág vs Borostyán)
        $tiszavirag = DB::table('clients')->where('tax', '21094478-1-06')->firstOrFail();
        DB::table('mailboxes')->where('client_id', $tiszavirag->id)->update(['live_ref' => '21094478 (Tiszavirág Dental Bt.)']);
        $this->actingAs($this->u('SN'))->postJson('/api/live/ingest', [
            'letters' => [[
                'eid' => 'SENT-TV-1', 'mailbox' => '21094478 (Tiszavirág Dental Bt.)', 'sender' => 'Tiszavirág',
                'recipient' => 'NAV', 'type' => '2665', 'desc' => 'Tiszavirág bevallás',
                'receivedAt' => '2026-11-14 09:10', 'folder' => 'ELKULDOTT',
            ]],
        ])->assertOk();
        $sentTv = DB::table('messages')->where('source_id', 'live-sent-SENT-TV-1')->firstOrFail();

        // Borostyán nyugtája ugyanazzal a refEid-del NEM párosodhat Tiszavirág küldeményével
        $this->actingAs($lg)->postJson('/api/live/ingest', [
            'portalId' => $pid,
            'letters' => [[
                'eid' => 'IN-BOR-TV', 'mailbox' => 'Értesítési tárhely', 'sender' => 'NAV',
                'type' => 'NAV - Elfogadó nyugta', 'desc' => 'Elfogadó nyugta – 24817365-2-13',
                'refEid' => 'SENT-TV-1', 'receivedAt' => '2026-11-14 09:12', 'folder' => 'BEERKEZETT',
            ]],
        ])->assertOk();
        $this->assertSame('pending', DB::table('messages')->find($sentTv->id)->filing_status);

        // 3) Viszont LG saját gyűjtőjén (own) maradt ELKULDOTT küldemény ÉS az LG által látott Borostyánhoz besorolt nyugta pontos refEid-del összekapcsolódik!
        $this->actingAs($lg)->postJson('/api/live/ingest', [
            'portalId' => $pid,
            'letters' => [[
                'eid' => 'IN-BOR-COLL-901', 'mailbox' => 'Értesítési tárhely', 'sender' => 'NAV',
                'type' => 'NAV - Elfogadó nyugta', 'desc' => 'Elfogadó nyugta – adózó: 24817365-2-13',
                'refEid' => 'SENT-COLL-901', 'receivedAt' => '2026-11-14 09:15', 'folder' => 'BEERKEZETT',
            ]],
        ])->assertOk();

        $inBor = DB::table('messages')->where('source_id', 'live-IN-BOR-COLL-901')->firstOrFail();
        $sentCollAfter = DB::table('messages')->find($sentColl->id);
        $this->assertSame('confirmed', $sentCollAfter->filing_status);
        $this->assertSame((int) $inBor->id, (int) $sentCollAfter->filing_receipt_id);
    }

    public function test_api_state_es_mcp_list_elkuldott_szures_es_ui_elemek(): void
    {
        config(['iratkapu.live_listing' => true, 'iratkapu.live_sent' => true]);
        $sn = $this->u('SN');
        OfficeMail::put($sn->office_id, ['mcp' => ['enabled' => true]]);
        $boxName = '21094478 (Tiszavirág Dental Bt.)';

        $this->actingAs($sn)->postJson('/api/live/ingest', [
            'autoMap' => true,
            'letters' => [
                [
                    'eid' => 'SENT-UI-1',
                    'mailbox' => $boxName,
                    'sender' => 'Tiszavirág Dental Bt.',
                    'recipient' => 'Nemzeti Adó- és Vámhivatal',
                    'recipientShort' => 'NAV',
                    'type' => '2665',
                    'desc' => '2665 ÁFA bevallás – UI teszt',
                    'receivedAt' => '2026-11-14 09:00',
                    'folder' => 'ELKULDOTT',
                ],
                [
                    'eid' => 'IN-UI-RCPT-1',
                    'mailbox' => $boxName,
                    'sender' => 'NAV',
                    'senderFull' => 'Nemzeti Adó- és Vámhivatal',
                    'type' => 'NAV - Elfogadó nyugta',
                    'desc' => 'Elfogadó nyugta – UI teszt',
                    'refEid' => 'SENT-UI-1',
                    'receivedAt' => '2026-11-14 09:05',
                    'folder' => 'BEERKEZETT',
                ],
            ],
        ])->assertOk();

        $sent = DB::table('messages')->where('source_id', 'live-sent-SENT-UI-1')->firstOrFail();
        $rcpt = DB::table('messages')->where('source_id', 'live-IN-UI-RCPT-1')->firstOrFail();
        $clientId = (int) $sent->client_id;

        // 1) /api/state ellenőrzi a cfg.liveSent / office.live_sent és a párosítási mezőket
        $state = $this->actingAs($sn)->getJson('/api/state')->assertOk()->json();
        $this->assertTrue($state['cfg']['liveSent']);
        $this->assertTrue($state['office']['live_sent']);

        $stSent = collect($state['messages'])->firstWhere('id', 'm'.$sent->id);
        $stRcpt = collect($state['messages'])->firstWhere('id', 'm'.$rcpt->id);
        $this->assertNotNull($stSent);
        $this->assertSame('ELKULDOTT', $stSent['folder']);
        $this->assertSame('Nemzeti Adó- és Vámhivatal', $stSent['recipient']);
        $this->assertSame('NAV', $stSent['recipientShort']);
        $this->assertSame('confirmed', $stSent['filingStatus']);
        $this->assertSame('m'.$rcpt->id, $stSent['filingReceiptId']);
        $this->assertSame('m'.$sent->id, $stRcpt['pairedSentId']);

        // 2) MCP ListMessages alapból kihagyja az ELKULDOTT mappát; folder='ELKULDOTT' esetén visszaadja; GetMessage mutatja a párt
        McpAccess::activate(new McpAccess($sn, 'olvasas', 'teszt'));
        try {
            IratkapuServer::tool(Tools\ListMessages::class, ['client_id' => $clientId])
                ->assertHasNoErrors()
                ->assertSee('Elfogadó nyugta – UI teszt')
                ->assertDontSee('2665 ÁFA bevallás – UI teszt');

            IratkapuServer::tool(Tools\ListMessages::class, ['client_id' => $clientId, 'folder' => 'ELKULDOTT'])
                ->assertHasNoErrors()
                ->assertSee('2665 ÁFA bevallás – UI teszt')
                ->assertDontSee('Elfogadó nyugta – UI teszt');

            IratkapuServer::tool(Tools\GetMessage::class, ['message_id' => $sent->id])
                ->assertHasNoErrors()
                ->assertSee('ELKULDOTT')
                ->assertSee('confirmed')
                ->assertSee('Elfogadó nyugta – UI teszt');

            IratkapuServer::tool(Tools\GetMessage::class, ['message_id' => $rcpt->id])
                ->assertHasNoErrors()
                ->assertSee('2665 ÁFA bevallás – UI teszt');
        } finally {
            McpAccess::forget();
        }

        // 3) UI HTML tartalmazza az Elküldött mappát, az isSent szűrőt és a kétoldali ugrógombokat
        $html = $this->actingAs($sn)->get('/')->assertOk()->getContent();
        $this->assertStringContainsString("['sent','Elküldött','send'", $html);
        $this->assertStringContainsString('const isSent=', $html);
        $this->assertStringContainsString('Ugrás az igazoláshoz', $html);
        $this->assertStringContainsString('Ugrás a beküldött beadványhoz', $html);
    }
}
