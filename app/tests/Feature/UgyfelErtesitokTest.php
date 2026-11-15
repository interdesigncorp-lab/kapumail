<?php

namespace Tests\Feature;

use App\Iratkapu\ClientMail;
use App\Iratkapu\ClientReminders;
use App\Iratkapu\OfficeMail;
use Carbon\Carbon;
use App\Iratkapu\Scope;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/** Az ügyfélnek menő automatikus levél közös küldője: kinek, mikor és mi marad kihagyva. */
class UgyfelErtesitokTest extends TestCase
{
    use RefreshDatabase;

    protected bool $seed = true;

    private object $client;

    protected function setUp(): void
    {
        parent::setUp();
        $lg = User::where('initials', 'LG')->firstOrFail();
        $this->client = DB::table('clients')->whereIn('id', Scope::clientIds($lg))->orderBy('id')->first();
        DB::table('clients')->where('id', $this->client->id)->update(['active' => true]);
        DB::table('client_contacts')->where('client_id', $this->client->id)->delete();
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function contact(string $name, string $email): int
    {
        return DB::table('client_contacts')->insertGetId(['office_id' => $this->client->office_id, 'client_id' => $this->client->id, 'name' => $name, 'email' => $email, 'role' => 'ügyvezető']);
    }

    private function sent(): array
    {
        return app('mailer')->getSymfonyTransport()->messages()->map(fn ($m) => $m->getOriginalMessage()->toString())->all();
    }

    private function send(string $key = 'arr:1', array $docs = []): array
    {
        return ClientMail::toClient($this->client->office_id, $this->client->id, 'arr', $key, 'Hátralék', 'Tárgyidőszaki hátralék van.', $docs);
    }

    public function test_kuld_minden_kapcsolattartonak(): void
    {
        $this->contact('Kovács Éva', 'eva@pelda.test'); $this->contact('Nagy Béla', 'bela@pelda.test');
        $r = $this->send();
        $this->assertSame(['sent' => 2, 'skipped' => null], $r);
        $this->assertCount(2, $this->sent());
        $rows = DB::table('client_notices')->where('client_id', $this->client->id)->get();
        $this->assertCount(2, $rows);
        $this->assertSame(['arr'], $rows->pluck('kind')->unique()->all());
        $this->assertSame(['sent'], $rows->pluck('status')->unique()->all());
        $this->assertNull($rows[0]->message_id);
        $this->assertNull($rows[0]->created_by);
    }

    public function test_ketszer_ugyanazzal_a_kulccsal_egyszer_megy(): void
    {
        $this->contact('Kovács Éva', 'eva@pelda.test');
        $this->assertSame(1, $this->send()['sent']);
        $this->assertSame(0, $this->send()['sent']);
        $this->assertCount(1, $this->sent());
        $this->assertSame(1, DB::table('client_notices')->count());
    }

    public function test_smtp_nelkul_nem_kuld_es_naploz(): void
    {
        config(['iratkapu.default_mailer_ok' => false]);
        $this->contact('Kovács Éva', 'eva@pelda.test');
        $this->assertSame(['sent' => 0, 'skipped' => 'smtp'], $this->send());
        $this->assertCount(0, $this->sent());
        $this->assertSame(0, DB::table('client_notices')->count());
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', 'Ügyfélnek szánt levél kihagyva%')->exists());
    }

    public function test_inaktiv_ugyfelnek_nem_kuld(): void
    {
        $this->contact('Kovács Éva', 'eva@pelda.test');
        DB::table('clients')->where('id', $this->client->id)->update(['active' => false]);
        $this->assertSame(['sent' => 0, 'skipped' => 'inaktiv'], $this->send());
        $this->assertCount(0, $this->sent());
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', '%inaktív ügyfél%')->exists());
    }

    public function test_kapcsolattarto_nelkul_kihagyja(): void
    {
        $this->assertSame(['sent' => 0, 'skipped' => 'nincs_kapcsolattarto'], $this->send());
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', '%nincs kapcsolattartó%')->exists());
    }

    public function test_mellekletet_csatol(): void
    {
        Storage::fake('local');
        Storage::disk('local')->put('t/hatarozat.txt', 'tartalom');
        $d = DB::table('documents')->insertGetId(['office_id' => $this->client->office_id, 'name' => 'hatarozat.txt', 'mime' => 'text/plain', 'size' => 8, 'sha256' => hash('sha256', 'tartalom'), 'path' => 't/hatarozat.txt', 'created_at' => now(), 'updated_at' => now()]);
        $this->contact('Kovács Éva', 'eva@pelda.test');
        $this->assertSame(1, $this->send('arr:2', [$d])['sent']);
        $mail = $this->sent()[0];
        $this->assertStringContainsString('hatarozat.txt', $mail);
        $this->assertMatchesRegularExpression('~Content-Disposition: attachment~i', $mail);
    }

    public function test_felhasznalonak_kuld_naplo_nelkul_es_smtp_nelkul_nem(): void
    {
        $u = User::where('initials', 'LG')->firstOrFail();
        $this->assertTrue(ClientMail::toUser($u->office_id, $u->id, 'Összesítő', 'Szöveg'));
        $this->assertCount(1, $this->sent());
        $this->assertSame(0, DB::table('client_notices')->count());
        config(['iratkapu.default_mailer_ok' => false]);
        $this->assertFalse(ClientMail::toUser($u->office_id, $u->id, 'Összesítő', 'Szöveg'));
        $this->assertCount(1, $this->sent());
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', 'Felhasználónak szánt levél kihagyva%')->exists());
    }

    public function test_kezi_ertesito_tovabbra_is_mukodik(): void
    {
        $lg = User::where('initials', 'LG')->firstOrFail();
        $m = DB::table('messages')->where('client_id', $this->client->id)->orderBy('id')->first();
        $k = $this->contact('Kovács Éva', 'eva@pelda.test');
        $this->actingAs($lg)->postJson("/api/messages/m{$m->id}/notice", ['contact' => $k, 'subject' => 'Tárgy', 'body' => 'Szöveg'])->assertOk();
        $n = DB::table('client_notices')->first();
        $this->assertSame('kezi', $n->kind);
        $this->assertSame($m->id, (int) $n->message_id);
        $this->assertSame($lg->id, (int) $n->created_by);
        $this->assertSame('sent', $n->status);
    }

    public function test_masik_futas_altal_foglalt_sor_nem_kuld_de_a_tobbi_kapcsolattarto_igen(): void
    {
        $a = $this->contact('Kovács Éva', 'eva@pelda.test'); $this->contact('Nagy Béla', 'bela@pelda.test');
        DB::table('client_notices')->insert(['office_id' => $this->client->office_id, 'client_id' => $this->client->id, 'to_email' => 'eva@pelda.test', 'to_name' => 'Kovács Éva', 'subject' => 'Hátralék', 'body' => 'x', 'status' => 'draft', 'kind' => 'arr', 'idempotency_key' => "arr:1:$a", 'created_at' => now(), 'updated_at' => now()]);
        $this->assertSame(['sent' => 1, 'skipped' => null], $this->send());
        $this->assertCount(1, $this->sent());
        $this->assertStringContainsString('bela@pelda.test', $this->sent()[0]);
        $this->assertSame('draft', DB::table('client_notices')->where('idempotency_key', "arr:1:$a")->value('status'));
    }

    public function test_hianyzo_melleklet_miatt_nem_megy_ki_es_sikertelen(): void
    {
        $d = DB::table('documents')->insertGetId(['office_id' => $this->client->office_id, 'name' => 'nincs.pdf', 'mime' => 'application/pdf', 'size' => 1, 'sha256' => str_repeat('a', 64), 'path' => 't/nincs.pdf', 'created_at' => now(), 'updated_at' => now()]);
        $this->contact('Kovács Éva', 'eva@pelda.test');
        $this->assertSame(0, $this->send('arr:3', [$d])['sent']);
        $this->assertCount(0, $this->sent());
        $n = DB::table('client_notices')->first();
        $this->assertSame('failed', $n->status);
        $this->assertStringContainsString('nincs.pdf', $n->skip_reason);
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', '%fájl hiányzik%')->exists());
    }

    public function test_kuldesi_hiba_utan_ujraprobal_ugyanazon_a_soron(): void
    {
        \Illuminate\Support\Facades\Mail::extend('boom', fn () => new class extends \Symfony\Component\Mailer\Transport\AbstractTransport { protected function doSend(\Symfony\Component\Mailer\SentMessage $m): void { throw new \RuntimeException('Kapcsolat megszakadt'); } public function __toString(): string { return 'boom'; } });
        $orig = config('mail.default');
        config(['mail.mailers.boom' => ['transport' => 'boom'], 'mail.default' => 'boom']); \Illuminate\Support\Facades\Mail::purge();
        $this->contact('Kovács Éva', 'eva@pelda.test');
        $this->assertSame(0, $this->send()['sent']);
        $n = DB::table('client_notices')->first();
        $this->assertSame('failed', $n->status);
        $this->assertStringContainsString('Kapcsolat megszakadt', $n->skip_reason);
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', 'Automatikus levél küldése sikertelen%')->exists());
        config(['mail.default' => $orig]); \Illuminate\Support\Facades\Mail::purge();
        $this->assertSame(1, $this->send()['sent']);
        $this->assertSame(1, DB::table('client_notices')->count());
        $this->assertSame('sent', DB::table('client_notices')->value('status'));
        $this->assertNull(DB::table('client_notices')->value('skip_reason'));
    }

    public function test_ismeretlen_ugyfel_kulon_okkal_kimarad(): void
    {
        $this->assertSame(['sent' => 0, 'skipped' => 'nincs_ugyfel'], ClientMail::toClient($this->client->office_id, 999999, 'arr', 'arr:9', 'T', 'B'));
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', '%nem található%')->exists());
    }

    // ---- Irat továbbítása emailben irattípusonként (DocumentForward) ----

    private const BOX = '24817365 Borostyán Pékség Kft.';
    private const TIPUS_SZOVEG = 'Tájékoztatás bevallásról';

    private function live(): void { Carbon::setTestNow('2026-11-13 10:00'); Storage::fake('local'); config(['iratkapu.live_listing' => true, 'iratkapu.live_download' => true]); }
    private function vezeto(): User { return User::where('initials', 'SN')->firstOrFail(); }
    private function emailTo(string $v, string $type): void { \App\Iratkapu\TypeSettings::flush(); $this->actingAs($this->vezeto())->postJson("/api/types/$type/settings", ['emailTo' => $v])->assertOk(); }

    private function ingest(string $eid, string $type = self::TIPUS_SZOVEG, array $extra = []): object
    {
        $l = $extra + ['eid' => $eid, 'type' => $type, 'mailbox' => self::BOX, 'sender' => 'NAV', 'senderFull' => 'Nemzeti Adó- és Vámhivatal', 'desc' => '', 'receivedAt' => '2026-11-11 08:10'];
        $this->actingAs($this->vezeto())->postJson('/api/live/ingest', ['autoMap' => true, 'letters' => [$l]])->assertOk();
        return DB::table('messages')->where('source_id', "live-$eid")->firstOrFail();
    }

    /** A próbabefogadás megadja a típusazonosítót és az ügyfelet; az ügyfélnek egy kapcsolattartót veszünk fel. */
    private function elokeszit(string $emailTo, string $type = self::TIPUS_SZOVEG): string
    {
        $this->live();
        $probe = $this->ingest('PROBA', $type);
        $cl = DB::table('clients')->find($probe->client_id);
        DB::table('clients')->where('id', $cl->id)->update(['active' => true]);
        DB::table('client_contacts')->where('client_id', $cl->id)->delete();
        DB::table('client_contacts')->insert(['office_id' => $cl->office_id, 'client_id' => $cl->id, 'name' => 'Kovács Éva', 'email' => 'eva@pelda.test', 'role' => 'ügyvezető']);
        $this->emailTo($emailTo, $probe->type_id);
        app('mailer')->getSymfonyTransport()->flush();
        return $probe->type_id;
    }

    private function subjectOf(string $mail): string
    {
        preg_match('~^Subject: (.*?)\r?\n(?!\s)~ms', $mail, $r);
        return mb_decode_mimeheader(preg_replace('~\r?\n\s~', ' ', $r[1]));
    }

    private function kezi(string $eid, string $type = self::TIPUS_SZOVEG)
    {
        $id = DB::table('messages')->where('source_id', "live-$eid")->value('id');
        return $this->actingAs($this->vezeto())->postJson("/api/messages/m$id/live-download", ['fileName' => 'irat.pdf', 'bytesBase64' => base64_encode(\App\Iratkapu\Samples::pdf('Irat'))]);
    }

    public function test_beerkezeskor_ertesites_mellelet_nelkul(): void
    {
        $this->elokeszit('client');
        $m = $this->ingest('FW-1');
        $mails = $this->sent();
        $this->assertCount(1, $mails);
        $this->assertStringContainsString('eva@pelda.test', $mails[0]);
        $dec = quoted_printable_decode(preg_replace('~=\r?\n~', '', $mails[0]));
        $dec = str_replace("=\r\n", '', $dec);
        $this->assertStringContainsString('Tisztelt Ügyfelünk!', $dec);
        $this->assertStringContainsString('Az irat tartalmát könyvelője juttatja el Önnek, illetve a hivatalos tárhelyen érhető el.', $dec);
        $this->assertStringContainsString('Érkezés: 2026. 11. 11. 08:10', $dec);
        $this->assertStringNotContainsString('KapuMail', $dec);
        $this->assertSame('Új irat érkezett: ' . $m->type_label, $this->subjectOf($mails[0]));
        $this->assertDoesNotMatchRegularExpression('~Content-Disposition: attachment~i', $mails[0]);
        $this->assertSame(0, DB::table('documents')->where('message_id', $m->id)->count());
    }

    public function test_letoltes_utan_melleklettel(): void
    {
        $this->elokeszit('client');
        $this->ingest('FW-2');
        $this->kezi('FW-2')->assertOk();
        $mails = $this->sent();
        $this->assertCount(2, $mails);
        $this->assertMatchesRegularExpression('~Content-Disposition: attachment~i', $mails[1]);
        $this->assertStringContainsString('irat.pdf', $mails[1]);
        $this->assertSame('Irat: ' . DB::table('messages')->where('source_id', 'live-FW-2')->value('type_label'), $this->subjectOf($mails[1]));
    }

    public function test_csak_lista_tipusnal_sem_tolt_le(): void
    {
        $this->live();
        $probe = $this->ingest('PROBA', 'Illeték fizetési meghagyás');
        $this->assertSame('csak_lista', \App\Iratkapu\DownloadPolicy::forMessage($probe, DB::table('mailboxes')->find($probe->mailbox_id)));
        $cl = DB::table('clients')->find($probe->client_id);
        DB::table('clients')->where('id', $cl->id)->update(['active' => true]);
        DB::table('client_contacts')->where('client_id', $cl->id)->delete();
        DB::table('client_contacts')->insert(['office_id' => $cl->office_id, 'client_id' => $cl->id, 'name' => 'Kovács Éva', 'email' => 'eva@pelda.test', 'role' => 'ügyvezető']);
        $this->emailTo('both', $probe->type_id);
        app('mailer')->getSymfonyTransport()->flush();
        $m = $this->ingest('FW-3', 'Illeték fizetési meghagyás');
        $this->assertCount(1, $this->sent());
        $this->assertSame(0, DB::table('delivery_events')->where('message_id', $m->id)->where('type', '!=', 'listazva')->count());
        $this->assertSame(0, DB::table('documents')->where('message_id', $m->id)->count());
    }

    public function test_rejtett_tipusnal_nincs_level(): void
    {
        $t = $this->elokeszit('client');
        $this->actingAs($this->vezeto())->postJson("/api/types/$t/settings", ['emailTo' => 'client', 'hidden' => true])->assertOk();
        \App\Iratkapu\TypeSettings::flush();
        $m = $this->ingest('FW-4');
        $this->assertSame(1, (int) $m->hidden);
        $this->assertCount(0, $this->sent());
    }

    public function test_felelosnek(): void
    {
        $t = $this->elokeszit('assignee');
        $v = $this->vezeto();
        DB::table('rules')->where('office_id', $v->office_id)->update(['matcher' => json_encode(['senders' => ['NAV']]), 'assignee_id' => $v->id, 'locked' => false]);
        $m = $this->ingest('FW-5');
        $this->assertSame($v->id, (int) $m->assignee_id);
        $mails = $this->sent();
        $this->assertCount(1, $mails);
        $this->assertStringContainsString($v->email, $mails[0]);
        $this->assertStringNotContainsString('eva@pelda.test', $mails[0]);
    }

    public function test_felelosnek_kulcsonkent_egyszer(): void
    {
        $this->elokeszit('assignee');
        $v = $this->vezeto();
        DB::table('rules')->where('office_id', $v->office_id)->update(['matcher' => json_encode(['senders' => ['NAV']]), 'assignee_id' => $v->id, 'locked' => false]);
        $m = $this->ingest('FW-6');
        $this->assertCount(1, $this->sent());
        \App\Iratkapu\DocumentForward::run($m->id, 'arrival');
        \App\Iratkapu\DocumentForward::run($m->id, 'arrival');
        $this->assertCount(1, $this->sent());
    }

    public function test_nincs_felelos_nincs_level_felelosnek(): void
    {
        $this->elokeszit('assignee');
        DB::table('rules')->where('office_id', $this->vezeto()->office_id)->update(['matcher' => json_encode(['senders' => ['NINCSILYEN']])]);
        $this->ingest('FW-7');
        $this->assertCount(0, $this->sent());
    }

    public function test_regi_es_tartos_tari_irat_nem_megy_beerkezeskor_friss_igen(): void
    {
        $this->elokeszit('client');
        $old = $this->ingest('FW-OLD', self::TIPUS_SZOVEG, ['receivedAt' => '2026-10-14 08:10']);
        $tt = $this->ingest('FW-TT', self::TIPUS_SZOVEG, ['folder' => 'TARTOS_TAR']);
        $this->assertCount(0, $this->sent());
        $this->assertSame(0, DB::table('client_notices')->count());
        foreach ([$old, $tt] as $m) $this->assertTrue(DB::table('audit_events')->where('message_id', $m->id)->where('action', 'like', 'Irat továbbítása kihagyva%')->exists());
        $this->ingest('FW-NEW');
        $this->assertCount(1, $this->sent());
    }

    public function test_automatikus_letoltesnel_regi_irat_nem_megy_kezinel_igen(): void
    {
        $this->elokeszit('client');
        $a = $this->ingest('FW-OLD1', self::TIPUS_SZOVEG, ['receivedAt' => '2026-10-14 08:10']);
        Storage::disk('local')->put('t/a.pdf', 'x');
        DB::table('documents')->insert(['office_id' => $a->office_id, 'message_id' => $a->id, 'name' => 'a.pdf', 'mime' => 'application/pdf', 'size' => 1, 'sha256' => str_repeat('a', 64), 'path' => 't/a.pdf', 'created_at' => now(), 'updated_at' => now()]);
        \App\Iratkapu\DocumentForward::run($a->id, 'downloaded', true);
        $this->assertCount(0, $this->sent());
        $this->assertTrue(DB::table('audit_events')->where('message_id', $a->id)->where('action', 'like', 'Irat továbbítása kihagyva%')->exists());
        $this->ingest('FW-OLD2', self::TIPUS_SZOVEG, ['receivedAt' => '2026-10-14 08:10']);
        $this->kezi('FW-OLD2')->assertOk();
        $this->assertCount(1, $this->sent());
        $this->assertMatchesRegularExpression('~Content-Disposition: attachment~i', $this->sent()[0]);
    }

    public function test_es3_tarolonal_a_benne_levo_iratok_is_mennek(): void
    {
        $this->elokeszit('client');
        $m = $this->ingest('FW-ES3');
        app('mailer')->getSymfonyTransport()->flush();
        Storage::disk('local')->put('t/k.es3', 'es3'); Storage::disk('local')->put('t/hatarozat.pdf', '%PDF-1.4');
        $doc = ['office_id' => $m->office_id, 'message_id' => $m->id, 'size' => 1, 'sha256' => str_repeat('a', 64), 'created_at' => now(), 'updated_at' => now()];
        $root = DB::table('documents')->insertGetId($doc + ['name' => 'kuldemeny.es3', 'mime' => 'application/octet-stream', 'path' => 't/k.es3']);
        DB::table('documents')->insert($doc + ['parent_id' => $root, 'name' => 'hatarozat.pdf', 'mime' => 'application/pdf', 'path' => 't/hatarozat.pdf']);
        \App\Iratkapu\DocumentForward::run($m->id, 'downloaded');
        $this->assertCount(1, $this->sent());
        $this->assertStringContainsString('hatarozat.pdf', $this->sent()[0]);
        $this->assertStringContainsString('kuldemeny.es3', $this->sent()[0]);
    }

    public function test_azonos_cimre_egy_level_megy(): void
    {
        $this->contact('Kovács Éva', 'eva@pelda.test'); $this->contact('Kovács Éva (2)', ' Eva@Pelda.test ');
        $this->assertSame(['sent' => 1, 'skipped' => null], $this->send());
        $this->assertCount(1, $this->sent());
    }

    public function test_helyi_fiok_cimere_nem_kuld(): void
    {
        $u = User::where('initials', 'LG')->firstOrFail();
        DB::table('users')->where('id', $u->id)->update(['email' => \App\Http\Controllers\AppController::LOCAL_EMAIL]);
        $this->assertFalse(ClientMail::toUser($u->office_id, $u->id, 'Összesítő', 'Szöveg'));
        $this->assertCount(0, $this->sent());
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', 'Felhasználónak szánt levél kihagyva (nincs e-mail-cím%')->exists());
    }

    // --- Hátralék-értesítő és fizetési emlékeztető ---

    private function remindersOn(array $office = [], array $client = ['arrears_notice' => true, 'payment_notice' => true]): void
    {
        Carbon::setTestNow('2026-11-13 10:00');
        DB::table('tax_obligations')->delete(); DB::table('nav_client_snapshots')->delete(); // tiszta lap: csak az lesz, amit a teszt beállít
        $this->contact('Kovács Éva', 'eva@pelda.test');
        OfficeMail::put($this->client->office_id, $office);
        DB::table('clients')->where('id', $this->client->id)->update($client);
    }

    private function snapshot(int $debt, string $at = '2026-11-13 08:00'): void
    {
        DB::table('nav_client_snapshots')->updateOrInsert(['client_id' => $this->client->id], ['office_id' => $this->client->office_id, 'portal_connection_id' => 1, 'debt' => $debt, 'fetched_at' => $at, 'created_at' => now(), 'updated_at' => now()]);
    }

    private function obligation(array $x = []): int
    {
        return DB::table('tax_obligations')->insertGetId($x + ['office_id' => $this->client->office_id, 'client_id' => $this->client->id, 'source' => 'nav', 'external_key' => 'k'.uniqid(), 'form_code' => '2665',
            'title' => 'Általános forgalmi adó bevallás', 'period_start' => '2026-10-01', 'period_end' => '2026-10-31', 'due_date' => '2026-11-20', 'status' => 'submittable', 'created_at' => now(), 'updated_at' => now()]);
    }

    private function body(int $i): string { return quoted_printable_decode($this->sent()[$i]); }

    private function sentCount(): int { return app('mailer')->getSymfonyTransport()->messages()->count(); }

    public function test_hatralek_kimegy_es_gyakorisag(): void
    {
        $this->remindersOn(['arrears_days' => 7]); $this->snapshot(125000);
        $this->assertSame(1, ClientReminders::arrears($this->client->office_id, Carbon::now()));
        $this->assertStringContainsString('125 000', $this->body(0));
        $this->assertStringContainsString('Ez a NAV-adatok lekérdezéskori állapota; a NAV-folyószámla az irányadó.', $this->body(0));
        $this->assertStringContainsString('Ha a hátralékot már rendezte, ez a levél tárgytalan. Kérdés esetén keresse könyvelőjét.', $this->body(0));
        $this->assertStringNotContainsString('rendezted', $this->body(0));
        Carbon::setTestNow('2026-11-15 10:00'); $this->snapshot(125000, '2026-11-15 08:00');
        $this->assertSame(0, ClientReminders::arrears($this->client->office_id, Carbon::now()));
        Carbon::setTestNow('2026-11-20 10:00'); $this->snapshot(125000, '2026-11-20 08:00');
        $this->assertSame(1, ClientReminders::arrears($this->client->office_id, Carbon::now()));
        $this->assertSame(2, $this->sentCount());
    }

    public function test_elavult_pillanatkep_nem_megy(): void
    {
        $this->remindersOn(['arrears_days' => 7]); $this->snapshot(125000, '2026-11-05 08:00');
        $this->assertSame(0, ClientReminders::arrears($this->client->office_id, Carbon::now()));
        $this->assertSame(0, $this->sentCount());
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', 'Hátralék-értesítő kihagyva%')->exists());
    }

    public function test_ugyfel_kapcsolo_nelkul_nem_megy(): void
    {
        $this->remindersOn(['arrears_days' => 7, 'payment_days' => [7]], ['arrears_notice' => false, 'payment_notice' => false]); $this->snapshot(125000); $this->obligation(['due_date' => '2026-11-20']);
        $this->assertSame(0, ClientReminders::arrears($this->client->office_id, Carbon::now()));
        $this->assertSame(0, ClientReminders::payments($this->client->office_id, Carbon::now()));
        $this->assertSame(0, $this->sentCount());
    }

    public function test_nulla_vagy_ki_van_kapcsolva_nem_megy(): void
    {
        $this->remindersOn(['arrears_days' => 0]); $this->snapshot(125000);
        $this->assertSame(0, ClientReminders::arrears($this->client->office_id, Carbon::now()));
        OfficeMail::put($this->client->office_id, ['arrears_days' => 7]); $this->snapshot(0);
        $this->assertSame(0, ClientReminders::arrears($this->client->office_id, Carbon::now()));
        $this->assertSame(0, $this->sentCount());
    }

    public function test_fizetesi_kuszob_es_potlas(): void
    {
        $this->remindersOn(['payment_days' => [7, 3, 1]]); $o = $this->obligation(['due_date' => '2026-11-20']); $id = $this->client->office_id;
        $this->assertSame(1, ClientReminders::payments($id, Carbon::now()));
        $b = $this->body(0);
        foreach (['Általános forgalmi adó bevallás', '2026-10-01', '2026-10-31', '2026-11-20', 'NAV Általános forgalmi adó bevételi számla', '10032000-01076868', 'A fizetendő összeget a bevallás tartalmazza; kérdés esetén keresse könyvelőjét.', 'Ha a befizetés már megtörtént, ez a levél tárgytalan.'] as $s) $this->assertStringContainsString($s, $b);
        $this->assertStringContainsString(preg_replace('/\s+/', '', $this->client->tax), $b);
        Carbon::setTestNow('2026-11-15 10:00');
        $this->assertSame(0, ClientReminders::payments($id, Carbon::now()));
        Carbon::setTestNow('2026-11-19 10:00'); // a 17-i futás kimaradt
        $this->assertSame(1, ClientReminders::payments($id, Carbon::now()));
        $this->assertTrue(DB::table('client_notices')->where('idempotency_key', 'like', "pay:$o:1:%")->exists());
        $this->assertFalse(DB::table('client_notices')->where('idempotency_key', 'like', "pay:$o:3:%")->exists());
        Carbon::setTestNow('2026-11-21 10:00');
        $this->assertSame(0, ClientReminders::payments($id, Carbon::now()));
        $this->assertSame(2, $this->sentCount());
    }

    public function test_beadott_bevallasra_is_megy(): void
    {
        $this->remindersOn(['payment_days' => [7]]); $this->obligation(['status' => 'submitted']);
        $this->assertSame(1, ClientReminders::payments($this->client->office_id, Carbon::now()));
        $this->assertStringContainsString('tárgytalan', $this->body(0));
    }

    public function test_feltetelesre_es_fizetes_nelkuli_nyomtatvanyra_nem(): void
    {
        $this->remindersOn(['payment_days' => [7]]); $this->obligation(['conditional' => true]); $this->obligation(['form_code' => 'NAPTAR']);
        $this->assertSame(0, ClientReminders::payments($this->client->office_id, Carbon::now()));
        $this->assertSame(0, $this->sentCount());
    }

    public function test_ketszeri_futas_nem_kuld_duplan(): void
    {
        $this->remindersOn(['arrears_days' => 7, 'payment_days' => [7]]); $this->snapshot(125000); $this->obligation(['due_date' => '2026-11-20']); $id = $this->client->office_id;
        $n = 0;
        for ($i = 0; $i < 2; $i++) $n += ClientReminders::payments($id, Carbon::now()) + ClientReminders::arrears($id, Carbon::now());
        $this->assertSame(2, $n);
        $this->assertSame(2, $this->sentCount());
    }

    public function test_ugyfel_kapcsolok_vegpont(): void
    {
        $this->actingAs(User::where('initials', 'SN')->firstOrFail())->postJson("/api/clients/c{$this->client->id}/notices", ['arrears' => true, 'payment' => false])->assertOk();
        $c = DB::table('clients')->find($this->client->id);
        $this->assertSame([1, 0], [(int) $c->arrears_notice, (int) $c->payment_notice]);
        $this->assertTrue(DB::table('audit_events')->where('action', 'like', 'Ügyfélnek menő értesítők módosítva%')->exists());
        $r = collect($this->actingAs(User::where('initials', 'SN')->firstOrFail())->getJson('/api/state')->assertOk()->json('clients'))->firstWhere('id', "c{$this->client->id}");
        $this->assertSame(['arrears' => true, 'payment' => false], $r['notices']);
        $this->actingAs(User::where('initials', 'LG')->firstOrFail())->postJson("/api/clients/c{$this->client->id}/notices", ['arrears' => false])->assertForbidden();
    }
}
