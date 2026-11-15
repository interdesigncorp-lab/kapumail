<?php

namespace App\Mcp\Tools;

use App\Iratkapu\CalendarInvites;
use App\Iratkapu\DownloadPolicy;
use App\Iratkapu\OfficeMail;
use App\Iratkapu\Scope;
use App\Iratkapu\TypeSettings;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class GetSettings extends IratkapuTool
{
    protected string $name = 'get_settings';

    protected string $description = 'Az iroda beállításai titkok nélkül: határidő-emlékeztetők, e-mail küldés (SMTP, jelszó nélkül), naptármeghívók, szabályok (prioritás, felelős, értesítés, letöltési mód), irattípusok letöltési szabálya, a bekapcsolt funkciók (élő listázás, letöltés, NAV, szövegfelismerés) és a mód (helyi vagy szerver). Az irodai értesítők is: válaszcím, feladónév, új ügyfelek alapértelmezett aktivitása, összesítő és hátralék-értesítő gyakorisága (nap, 0 = nem megy), fizetési emlékeztető napjai, irattípusonként az e-mail küldés, archiválás, rejtés, kezdő állapot és Joghatály.';

    protected bool $audit = false;

    public function schema(JsonSchema $schema): array
    {
        return [];
    }

    protected function run(Request $request, User $user): array
    {
        return $this->data($user);
    }

    /** A beállítások a felhasználó szemével; az update_settings jóváhagyó kártyája is ebből számolja a régi értékeket. */
    public function data(User $user): array
    {
        $s = OfficeMail::settings($user->office_id);
        $o = OfficeMail::office($user->office_id);
        $ini = DB::table('users')->where('office_id', $user->office_id)->pluck('initials', 'id');
        $cal = CalendarInvites::config($user->office_id);

        return [
            'office' => DB::table('offices')->where('id', $user->office_id)->value('name'),
            'mode' => ! empty($s['local']) ? 'helyi (egy gép, egy fiók)' : 'szerver (több munkatárs)',
            'reminders_days_before' => $s['reminders'] ?? [5, 2, 1], 'reminder_email' => ! empty($s['reminder_email']),
            'reply_to' => $o['replyTo'], 'from_name' => isset($s['smtp']) ? (($s['smtp']['from_name'] ?? '') ?: null) : null,
            'default_active' => $o['defaultActive'], 'digest_days' => $o['digestDays'], 'arrears_days' => $o['arrearsDays'], 'payment_days' => $o['paymentDays'],
            'smtp' => Scope::seesAll($user) ? OfficeMail::summary($user->office_id) : ['configured' => OfficeMail::summary($user->office_id)['configured']],
            'calendar_invites' => ['on' => $cal['on'], 'estimated_deadlines_too' => (bool) $cal['estimated'], 'mail_ready' => $cal['mailReady'], 'last_error' => Scope::seesAll($user) ? $cal['lastError'] : null],
            'features' => ['live_listing' => (bool) config('iratkapu.live_listing'), 'live_download' => (bool) config('iratkapu.live_download'),
                'nav_switch' => (bool) config('iratkapu.nav_switch'), 'nav_queries' => (bool) config('iratkapu.nav_queries'), 'nav_exports' => (bool) config('iratkapu.nav_exports'),
                'ocr' => (bool) config('iratkapu.ocr.enabled', false), 'connector_mode' => config('iratkapu.mode')],
            'rules' => DB::table('rules')->where('office_id', $user->office_id)->orderBy('position')->get()->map(fn ($r) => ['id' => $r->id, 'name' => $r->name,
                'priority' => $r->priority, 'assignee' => $ini[$r->assignee_id] ?? null, 'notify' => $r->notify, 'download_mode' => $r->download_mode ?? 'manual',
                'version' => $r->version, 'locked' => (bool) $r->locked])->values(),
            'document_types' => DB::table('document_types')->where(fn ($q) => $q->whereNull('office_id')->orWhere('office_id', $user->office_id))->orderBy('label')->get()
                ->map(fn ($t) => ['type_id' => $t->type_id, 'label' => $t->label, 'group' => $t->group, 'risk' => $t->risk, 'custom' => $t->office_id !== null,
                    'download_policy' => DownloadPolicy::forType($user->office_id, $t->type_id), 'settings' => TypeSettings::for($user->office_id, $t->type_id)])->values(),
            'ai_connection' => ['enabled' => ! empty($s['mcp']['enabled'])],
        ];
    }
}
