<?php

namespace Tests\Feature;

use App\Iratkapu\Digest;
use App\Iratkapu\RuleEngine;
use App\Iratkapu\Scope;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** Az összesítő email a munkatársaknak és a „Reggeli összesítő” szabály. */
class OsszesitoTest extends TestCase
{
    use RefreshDatabase;

    protected bool $seed = true;

    private int $oid;
    private object $lgClient;   // LG látja
    private object $btClient;   // csak BT látja

    protected function setUp(): void
    {
        parent::setUp();
        Carbon::setTestNow('2026-11-13 08:00:00');
        $lg = User::where('initials', 'LG')->firstOrFail(); $bt = User::where('initials', 'BT')->firstOrFail(); $this->oid = $lg->office_id;
        $this->lgClient = DB::table('clients')->find(Scope::clientIds($lg)[0]);
        $this->btClient = DB::table('clients')->find(array_values(array_diff(Scope::clientIds($bt), Scope::clientIds($lg)))[0]);
        DB::table('tax_obligations')->delete(); DB::table('nav_client_snapshots')->delete(); DB::table('notifications')->delete();
        DB::table('clients')->where('office_id', $this->oid)->update(['created_at' => '2020-01-01 00:00:00']); // a seed-ügyfelek ne legyenek „újak”
        $this->days(1);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function days(int $d): void
    {
        $o = DB::table('offices')->find($this->oid); $s = json_decode($o->settings, true) ?: []; $s['digest_days'] = $d;
        DB::table('offices')->where('id', $this->oid)->update(['settings' => json_encode($s)]);
    }

    private function obl(object $c, string $status = 'missing', string $title = 'ÁFA bevallás'): void
    {
        DB::table('tax_obligations')->insert(['office_id' => $this->oid, 'client_id' => $c->id, 'external_key' => "k-{$c->id}-$title", 'form_code' => '2565', 'title' => $title, 'due_date' => '2026-11-20', 'status' => $status, 'created_at' => now(), 'updated_at' => now()]);
    }

    private function debt(object $c, int $amount = 120000): void
    {
        DB::table('nav_client_snapshots')->insert(['office_id' => $this->oid, 'client_id' => $c->id, 'portal_connection_id' => 1, 'debt' => $amount, 'fetched_at' => now(), 'created_at' => now(), 'updated_at' => now()]);
    }

    private function newDoc(string $subject = 'Önkormányzati értesítés', ?object $c = null): object
    {
        $c ??= $this->btClient; $box = DB::table('mailboxes')->where('client_id', $c->id)->first();
        $id = DB::table('messages')->insertGetId(['office_id' => $this->oid, 'client_id' => $c->id, 'mailbox_id' => $box->id, 'source_id' => 'D-' . $subject, 'sender' => 'ÖNK', 'sender_full' => 'Önkormányzat', 'subject' => $subject, 'type_id' => 'egyeb', 'type_label' => 'Egyéb', 'arrived_at' => now(), 'created_at' => now(), 'updated_at' => now()]);
        $m = DB::table('messages')->find($id); RuleEngine::apply($m);
        return $m;
    }

    private function mails(): array
    {
        return app('mailer')->getSymfonyTransport()->messages()->map(fn ($m) => quoted_printable_decode($m->getOriginalMessage()->toString()))->all();
    }

    private function to(string $email): array { return array_values(array_filter($this->mails(), fn ($m) => str_contains($m, "To: ") && str_contains($m, $email))); }

    public function test_reggeli_osszesito_szabaly_rogziti_az_iratot(): void
    {
        $m = $this->newDoc();
        $n = DB::table('notifications')->where('message_id', $m->id)->get();
        $this->assertCount(1, $n);
        $this->assertSame('osszesito', $n[0]->kind);
        $this->assertSame(User::where('initials', 'BT')->value('id'), (int) $n[0]->user_id); // a szabály felelőse
        $this->assertSame("digest-rule-" . DB::table('rules')->where('name', 'Önkormányzati adó')->value('id') . "-{$m->id}-{$n[0]->user_id}", $n[0]->dedupe_key);
        RuleEngine::apply($m);
        $this->assertSame(1, DB::table('notifications')->where('message_id', $m->id)->count());
    }

    public function test_felelos_nelkul_a_vezetoknek_megy(): void
    {
        DB::table('rules')->where('name', 'Önkormányzati adó')->update(['assignee_id' => null]);
        $m = $this->newDoc('Vezetőnek szóló', $this->lgClient);
        $this->assertSame(['osszesito'], DB::table('notifications')->where('message_id', $m->id)->pluck('kind')->unique()->all());
        $this->assertSame([User::where('initials', 'SN')->value('id')], DB::table('notifications')->where('message_id', $m->id)->pluck('user_id')->map(fn ($x) => (int) $x)->all());
    }

    public function test_osszesito_tartalma(): void
    {
        $this->obl($this->btClient); $this->debt($this->btClient, 120000); $this->newDoc('Helyi adó határozat');
        $this->assertSame(1, $this->runFor('BT'));
        $m = $this->to('bt@iratkapu.test');
        $this->assertCount(1, $m);
        $subj = app('mailer')->getSymfonyTransport()->messages()->map(fn ($x) => $x->getOriginalMessage()->getSubject())->first();
        $this->assertSame('KapuMail összesítő – Lakatos és Társa Könyvelőiroda, 2026. 11. 13.', $subj);
        foreach (['ÁFA bevallás', '120 000 Ft', 'Helyi adó határozat', $this->btClient->name] as $x) $this->assertStringContainsString($x, $m[0]);
    }

    /** A teljes iroda futtatása; BT levelét adja vissza darabszámban. */
    private function runFor(string $ini): int { Digest::run($this->oid, now()); return count($this->to(strtolower($ini) . '@iratkapu.test')); }

    public function test_ures_osszesito_nem_megy(): void
    {
        $this->assertSame(0, Digest::run($this->oid, now()));
        $this->assertCount(0, $this->mails());
        $this->assertSame(0, DB::table('digest_runs')->count());
    }

    public function test_csak_a_latott_ugyfelek(): void
    {
        $this->obl($this->btClient, 'missing', 'BT-bevallás'); $this->obl($this->lgClient, 'rejected', 'LG-bevallás');
        Digest::run($this->oid, now());
        $lg = $this->to('lg@iratkapu.test'); $bt = $this->to('bt@iratkapu.test');
        $this->assertCount(1, $lg);
        $this->assertStringContainsString($this->lgClient->name, $lg[0]); $this->assertStringContainsString('LG-bevallás', $lg[0]);
        $this->assertStringNotContainsString($this->btClient->name, $lg[0]); $this->assertStringNotContainsString('BT-bevallás', $lg[0]);
        $this->assertStringContainsString('BT-bevallás', $bt[0]); $this->assertStringNotContainsString('LG-bevallás', $bt[0]);
    }

    public function test_osszesito_naponta_egyszer(): void
    {
        $this->obl($this->lgClient);
        $first = Digest::run($this->oid, now());
        $this->assertGreaterThan(0, $first);
        $total = count($this->mails());
        $this->assertSame(0, Digest::run($this->oid, now()));
        $this->assertCount($total, $this->mails());
        $this->assertSame($first, DB::table('digest_runs')->count());
    }

    public function test_sikertelen_kuldes_foglalasa_visszavonodik(): void
    {
        $this->obl($this->lgClient);
        config(['iratkapu.default_mailer_ok' => false]);
        $this->assertSame(0, Digest::run($this->oid, now()));
        $this->assertSame(0, DB::table('digest_runs')->count());
        config(['iratkapu.default_mailer_ok' => true]);
        $this->assertGreaterThan(0, Digest::run($this->oid, now()));
    }

    public function test_kikapcsolva_nem_megy(): void
    {
        $this->days(0); $this->obl($this->lgClient);
        $this->assertSame(0, Digest::run($this->oid, now()));
    }

    public function test_gyakorisag(): void
    {
        $this->days(3);
        $this->obl($this->lgClient, 'missing', 'Egy');
        $this->assertGreaterThan(0, Digest::run($this->oid, now()));
        Carbon::setTestNow('2026-11-14 08:00:00'); $this->obl($this->lgClient, 'missing', 'Ketto');
        $this->assertSame(0, Digest::run($this->oid, now()));
        Carbon::setTestNow('2026-11-16 08:00:00'); $this->obl($this->lgClient, 'missing', 'Harom');
        $this->assertGreaterThan(0, Digest::run($this->oid, now()));
        $lg = $this->to('lg@iratkapu.test');
        $this->assertCount(2, $lg);
        $this->assertStringContainsString('Ketto', $lg[1]); $this->assertStringNotContainsString('Egy', $lg[1]); // az utolsó küldés óta
    }

    public function test_osszesito_ertesites_nem_jelenik_meg_a_harangban(): void
    {
        $m = $this->newDoc(); $bt = User::where('initials', 'BT')->firstOrFail();
        $this->assertSame(1, DB::table('notifications')->where('message_id', $m->id)->where('kind', 'osszesito')->count());
        $this->actingAs($bt);
        $this->assertSame([], collect($this->getJson('/api/state')->json('notifications'))->where('kind', 'osszesito')->all());
        $this->assertSame(0, $this->getJson('/api/notifications/last')->json('last'));
        $this->postJson('/api/notifications/read')->assertOk();
        $this->assertNull(DB::table('notifications')->where('message_id', $m->id)->value('read_at'));
    }

    public function test_parancs_fut_es_osszegez(): void
    {
        \App\Iratkapu\OfficeMail::put($this->oid, ['arrears_days' => 7]);
        DB::table('clients')->where('id', $this->lgClient->id)->update(['active' => true, 'arrears_notice' => true]);
        DB::table('client_contacts')->where('client_id', $this->lgClient->id)->delete();
        DB::table('client_contacts')->insert(['office_id' => $this->oid, 'client_id' => $this->lgClient->id, 'name' => 'Kovács Éva', 'email' => 'eva@pelda.test', 'role' => 'ügyvezető']);
        DB::table('nav_client_snapshots')->insert(['client_id' => $this->lgClient->id, 'office_id' => $this->oid, 'portal_connection_id' => 1, 'debt' => 125000, 'fetched_at' => '2026-11-13 07:00', 'created_at' => now(), 'updated_at' => now()]);
        $this->artisan('iratkapu:ertesitok')->expectsOutputToContain('hátralék')->assertSuccessful();
        $this->assertSame(1, DB::table('client_notices')->where('kind', 'arr')->count());
    }

    public function test_parancs_egy_iroda_hibaja_utan_folytatja_es_hibaval_zar(): void
    {
        DB::table('offices')->insert(['id' => 0, 'name' => 'Hibás iroda', 'settings' => json_encode(['payment_days' => 'x']), 'created_at' => now(), 'updated_at' => now()]);
        \App\Iratkapu\OfficeMail::put($this->oid, ['arrears_days' => 7]);
        DB::table('clients')->where('id', $this->lgClient->id)->update(['active' => true, 'arrears_notice' => true]);
        DB::table('client_contacts')->where('client_id', $this->lgClient->id)->delete();
        DB::table('client_contacts')->insert(['office_id' => $this->oid, 'client_id' => $this->lgClient->id, 'name' => 'Kovács Éva', 'email' => 'eva@pelda.test', 'role' => 'ügyvezető']);
        DB::table('nav_client_snapshots')->insert(['client_id' => $this->lgClient->id, 'office_id' => $this->oid, 'portal_connection_id' => 1, 'debt' => 125000, 'fetched_at' => '2026-11-13 07:00', 'created_at' => now(), 'updated_at' => now()]);
        $this->artisan('iratkapu:ertesitok')->expectsOutputToContain('Iroda #0: hiba')->assertFailed();
        $this->assertSame(1, DB::table('client_notices')->where('kind', 'arr')->count());
    }
}
