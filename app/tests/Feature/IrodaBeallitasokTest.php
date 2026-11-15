<?php
namespace Tests\Feature;

use App\Iratkapu\OfficeMail;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\{Crypt, DB, Mail};
use Tests\TestCase;

/** Az iroda levelezési és értesítési beállításai: Reply-To, új ügyfelek alapértelmezése, gyakoriságok. */
class IrodaBeallitasokTest extends TestCase
{
    use RefreshDatabase;
    protected bool $seed = true;

    private function u(string $k): User { return User::where('initials', $k)->firstOrFail(); }

    public function test_alapertekek(): void
    {
        $o = OfficeMail::office($this->u('SN')->office_id);
        $this->assertNull($o['replyTo']);
        $this->assertSame(['mail' => true, 'nav' => true, 'cegkapu' => true], $o['defaultActive']);
        $this->assertSame(0, $o['digestDays']);
        $this->assertSame(0, $o['arrearsDays']);
        $this->assertSame([], $o['paymentDays']);
    }

    public function test_vezeto_menti_a_beallitasokat(): void
    {
        $u = $this->u('SN');
        $this->actingAs($u)->postJson('/api/settings', ['replyTo' => 'iroda@pelda.test', 'defaultActive' => ['nav' => false], 'digestDays' => 3, 'arrearsDays' => 7, 'paymentDays' => [7, 3, 1]])->assertOk();
        $o = OfficeMail::office($u->office_id);
        $this->assertSame('iroda@pelda.test', $o['replyTo']);
        $this->assertSame(['mail' => true, 'nav' => false, 'cegkapu' => true], $o['defaultActive']);
        $this->assertSame(3, $o['digestDays']);
        $this->assertSame(7, $o['arrearsDays']);
        $this->assertSame([7, 3, 1], $o['paymentDays']);
        $this->assertSame([5, 2, 1], OfficeMail::settings($u->office_id)['reminders'] ?? [5, 2, 1]); // a meglévő kulcsok érintetlenek
        $this->assertSame('iroda@pelda.test', $this->getJson('/api/state')->json('office.settings.replyTo'));
        $this->postJson('/api/settings', ['replyTo' => ''])->assertOk(); // üres = törlés
        $this->assertNull(OfficeMail::office($u->office_id)['replyTo']);
    }

    public function test_konyvelo_nem_menthet(): void
    {
        $this->actingAs($this->u('LG'))->postJson('/api/settings', ['digestDays' => 3])->assertForbidden();
    }

    public function test_ervenytelen_ertekek(): void
    {
        $this->actingAs($this->u('SN'));
        $this->postJson('/api/settings', ['digestDays' => 31])->assertStatus(422);
        $this->postJson('/api/settings', ['paymentDays' => [0]])->assertStatus(422);
        $this->postJson('/api/settings', ['replyTo' => 'nem-email'])->assertStatus(422);
        $this->postJson('/api/settings', ['defaultActive' => ['ismeretlen' => true]])->assertStatus(422);
    }

    public function test_reply_to_es_feladonev_a_levelen(): void
    {
        $u = $this->u('SN');
        $name = DB::table('offices')->where('id', $u->office_id)->value('name');
        OfficeMail::put($u->office_id, ['reply_to' => 'iroda@pelda.test']);
        OfficeMail::mailer($u->office_id)->raw('Teszt', fn ($m) => $m->to('x@pelda.test')->subject('Teszt'));
        $msg = Mail::mailer()->getSymfonyTransport()->messages()->last()->getOriginalMessage();
        $this->assertSame('iroda@pelda.test', $msg->getReplyTo()[0]->getAddress());
        $this->assertSame($name, $msg->getFrom()[0]->getName());
        // másik iroda beállítása nem szivároghat át a megosztott levelezőn
        OfficeMail::put($u->office_id, ['reply_to' => null]);
        OfficeMail::mailer($u->office_id)->raw('Teszt', fn ($m) => $m->to('x@pelda.test')->subject('Teszt 2'));
        $this->assertSame([], Mail::mailer()->getSymfonyTransport()->messages()->last()->getOriginalMessage()->getReplyTo());
    }

    public function test_ready(): void
    {
        $id = $this->u('SN')->office_id;
        config(['iratkapu.default_mailer_ok' => false]);
        $this->assertFalse(OfficeMail::ready($id));
        config(['iratkapu.default_mailer_ok' => true]);
        $this->assertTrue(OfficeMail::ready($id));
        config(['iratkapu.default_mailer_ok' => false]);
        OfficeMail::put($id, ['smtp' => ['host' => 'smtp.pelda.test', 'port' => 587, 'enc' => 'starttls', 'username' => '', 'password' => Crypt::encryptString('x'), 'from' => 'a@pelda.test']]);
        $this->assertTrue(OfficeMail::ready($id));
    }
}
