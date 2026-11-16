<?php

namespace App\Mcp\Tools;

use App\Iratkapu\CalendarInvites;
use App\Iratkapu\OfficeMail;
use App\Iratkapu\Scope;
use App\Iratkapu\TypeSettings;
use App\Mcp\KapuConfirm;
use App\Mcp\McpAccess;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;

/**
 * Iroda-beállítások módosítása a felület vezérlőmetódusain át (ugyanaz a jogosultság: vezető vagy admin).
 * A `kapu` szinten (ADR-014) a módosítás csak a felhasználó jóváhagyása után fut: az első hívás jóváhagyási kérést ad
 * (`needs_approval`, `confirm_id`, régi → új összefoglaló), a felület jóváhagyó kártyát tesz ki, és csak a jóváhagyott
 * `confirm_id`-val, pontosan ugyanazokkal az adatokkal hívva hajtódik végre.
 */
class UpdateSettings extends IratkapuTool
{
    protected string $name = 'update_settings';

    protected string $description = 'Iroda-beállítások módosítása (vezető vagy admin felhasználó). Határidő-emlékeztetők: hány nappal előtte (1, 2, 5), e-mailben is menjen-e; naptármeghívók az ügyfelek kapcsolattartóinak (be/ki, becsült határidő is menjen-e); válaszcím, feladónév; új ügyfelek alapértelmezett aktivitása; összesítő és hátralék-értesítő gyakorisága; fizetési emlékeztető napjai; irattípusonkénti beállítások. Kapu-kapcsolatnál az első hívás nem módosít, hanem jóváhagyást kér: mutasd meg a felhasználónak az összefoglalót, és a jóváhagyás után hívd újra ugyanezekkel az adatokkal és a kapott confirm_id-val.';

    protected string $level = 'admin';

    /** Az eszköz által ismert mezők; a többi bemenetet figyelmen kívül hagyjuk (a jóváhagyás is csak ezekre szól). */
    private const FIELDS = ['reminders', 'reminder_email', 'calendar_invites', 'calendar_estimated', 'reply_to', 'from_name', 'default_active',
        'digest_days', 'arrears_days', 'payment_days', 'type_settings'];

    /** Az `AppController::settings` kulcsai. */
    private const OFFICE_KEYS = ['reminders' => 'reminders', 'reminder_email' => 'reminderEmail', 'reply_to' => 'replyTo', 'default_active' => 'defaultActive',
        'digest_days' => 'digestDays', 'arrears_days' => 'arrearsDays', 'payment_days' => 'paymentDays'];

    /** Az `AppController::setTypeSettings` kulcsai. */
    private const TYPE_KEYS = ['email_to' => 'emailTo', 'auto_archive' => 'autoArchive', 'hidden' => 'hidden', 'initial_state' => 'initialState', 'legal_days' => 'legalDays'];

    public function schema(JsonSchema $schema): array
    {
        return [
            'reminders' => $schema->array()->items($schema->integer()->enum([1, 2, 5]))->description('Emlékeztető napok a határidő előtt, például [5, 1].'),
            'reminder_email' => $schema->boolean()->description('Az emlékeztető e-mailben is kimegy-e.'),
            'calendar_invites' => $schema->boolean()->description('Naptármeghívók küldése az ügyfelek kapcsolattartóinak (SMTP kell hozzá).'),
            'calendar_estimated' => $schema->boolean()->description('A becsült (nem megerősített) határidő is kimegy-e meghívóban, jelöléssel.'),
            'reply_to' => $schema->string()->nullable()->description('Válaszcím az ügyfeleknek menő levelekhez (e-mail cím); null: nincs külön válaszcím.'),
            'from_name' => $schema->string()->description('A kimenő levelek feladóneve (legfeljebb 120 karakter). A többi SMTP-beállítás nem változik; SMTP nélkül nem állítható.'),
            'default_active' => $schema->object([
                'mail' => $schema->boolean(), 'nav' => $schema->boolean(), 'cegkapu' => $schema->boolean(),
            ])->description('Új ügyfél alapból aktív-e: e-mail, NAV, Cégkapu. Csak a megadott kulcsok változnak.'),
            'digest_days' => $schema->integer()->description('Összesítő e-mail a munkatársaknak ennyi naponta (0–30, 0 = nem megy).'),
            'arrears_days' => $schema->integer()->description('Hátralék-értesítő az adózónak legalább ennyi naponta (0–30, 0 = nem megy).'),
            'payment_days' => $schema->array()->items($schema->integer())->description('Fizetési emlékeztető ennyi nappal a fizetési határidő előtt (1–30), például [7, 2].'),
            'type_settings' => $schema->array()->items($schema->object([
                'type_id' => $schema->string()->required(),
                'email_to' => $schema->string()->enum(TypeSettings::EMAIL_TO),
                'auto_archive' => $schema->boolean(),
                'hidden' => $schema->boolean(),
                'initial_state' => $schema->string()->enum(TypeSettings::STATES),
                'legal_days' => $schema->integer()->nullable(),
            ]))->description('Irattípusonkénti beállítások (a type_id a get_settings document_types listájából). email_to: none | client | assignee | both; hidden: „Nem kell”; legal_days: Joghatály napban (1–365) vagy null.'),
            'confirm_id' => $schema->string()->description('Csak Kapu-kapcsolatnál: a jóváhagyott kérés azonosítója az első hívás válaszából.'),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $all = $request->all();
        $in = array_filter(array_intersect_key($all, array_flip(self::FIELDS)), fn ($v, $k) => $v !== null || $k === 'reply_to', ARRAY_FILTER_USE_BOTH);
        Validator::make($in, [
            'reminders' => 'array', 'reminders.*' => 'integer|in:1,2,5', 'reminder_email' => 'boolean', 'calendar_invites' => 'boolean', 'calendar_estimated' => 'boolean',
            'reply_to' => 'nullable|email|max:190', 'from_name' => 'string|max:120',
            'default_active' => 'array:mail,nav,cegkapu', 'default_active.mail' => 'boolean', 'default_active.nav' => 'boolean', 'default_active.cegkapu' => 'boolean',
            'digest_days' => 'integer|between:0,30', 'arrears_days' => 'integer|between:0,30', 'payment_days' => 'array|max:30', 'payment_days.*' => 'integer|between:1,30|distinct',
            'type_settings' => 'array', 'type_settings.*.type_id' => 'required|string|distinct', 'type_settings.*.email_to' => 'in:'.implode(',', TypeSettings::EMAIL_TO),
            'type_settings.*.auto_archive' => 'boolean', 'type_settings.*.hidden' => 'boolean', 'type_settings.*.initial_state' => 'in:'.implode(',', TypeSettings::STATES),
            'type_settings.*.legal_days' => 'nullable|integer|min:1|max:365',
        ])->validate();
        abort_if(! $in, 422, 'Nem adtál meg módosítandó beállítást.');

        $access = McpAccess::current();
        if ($access?->level !== 'kapu') {
            return $this->apply($in, $user);
        }

        abort_unless(Scope::seesAll($user), 403, 'Az iroda beállításait csak vezető vagy admin módosíthatja, a te szerepköröd ezt nem engedi. Kérd meg az iroda vezetőjét vagy adminját.');
        abort_if(array_key_exists('from_name', $in) && empty(OfficeMail::settings($user->office_id)['smtp']), 422, 'Előbb az e-mail küldést kell beállítani.');
        $summary = $this->summary($in, $user);
        $confirmId = $all['confirm_id'] ?? null;
        if (! is_string($confirmId) || $confirmId === '') {
            return ['needs_approval' => true, 'confirm_id' => KapuConfirm::request($access, $in, $summary), 'summary' => $summary,
                'message' => 'Mutasd meg a felhasználónak; a felület jóváhagyó kártyát tesz ki. Jóváhagyás után hívd újra ugyanezekkel az adatokkal és a confirm_id-val.'];
        }

        // A felhasználás és a módosítás egy tranzakcióban: ha a végrehajtás elbukik, a jóváhagyás nem vész el.
        return DB::transaction(function () use ($access, $confirmId, $in, $user) {
            abort_unless(KapuConfirm::consume($access, $confirmId, $in), 409, 'Ez a jóváhagyás nem használható: még nincs jóváhagyva, lejárt (10 perc), már felhasználták, vagy más módosításra szól. Hívd újra confirm_id nélkül, és kérj új jóváhagyást.');

            return $this->apply($in, $user);
        });
    }

    /** A módosítás végrehajtása a felület vezérlőmetódusaival, a kapcsolat gazdájának jogosultságával. */
    private function apply(array $in, User $user): array
    {
        $done = [];
        $office = [];
        foreach (self::OFFICE_KEYS as $k => $c) {
            if (array_key_exists($k, $in)) {
                $office[$c] = in_array($k, ['reminders', 'payment_days'], true) ? array_values((array) $in[$k]) : $in[$k];
            }
        }
        if ($office) {
            $this->controller('settings', $office);
            if (array_intersect_key($office, ['reminders' => 1, 'reminderEmail' => 1])) {
                $done[] = 'emlékeztetők';
            }
            if (array_diff_key($office, ['reminders' => 1, 'reminderEmail' => 1])) {
                $done[] = 'értesítések';
            }
        }
        if (array_key_exists('from_name', $in)) {
            $smtp = OfficeMail::settings($user->office_id)['smtp'] ?? null;
            abort_if(! $smtp, 422, 'Előbb az e-mail küldést kell beállítani.');
            // A többi SMTP-mező változatlan; üres jelszóval a mentés a korábbit tartja meg.
            $this->controller('saveSmtp', ['host' => $smtp['host'], 'port' => $smtp['port'], 'enc' => $smtp['enc'], 'username' => $smtp['username'] ?? '',
                'password' => '', 'from' => $smtp['from'], 'fromName' => (string) $in['from_name']]);
            $done[] = 'feladónév';
        }
        if (array_key_exists('calendar_invites', $in) || array_key_exists('calendar_estimated', $in)) {
            $cur = CalendarInvites::config($user->office_id);
            $this->controller('calendarSettings', ['on' => (bool) ($in['calendar_invites'] ?? $cur['on']), 'estimated' => (bool) ($in['calendar_estimated'] ?? $cur['estimated'])]);
            $done[] = 'naptármeghívók';
        }
        foreach ($in['type_settings'] ?? [] as $t) {
            $body = [];
            foreach (self::TYPE_KEYS as $k => $c) {
                if (array_key_exists($k, $t)) {
                    $body[$c] = $t[$k];
                }
            }
            $this->controller('setTypeSettings', $body, (string) $t['type_id']);
            $done[] = "irattípus: {$t['type_id']}";
        }

        return ['ok' => true, 'changed' => $done];
    }

    /**
     * A jóváhagyó kártya sorai: emberi címke, régi → új érték, a get_settings adataiból számolva.
     *
     * @return array<int, array{label: string, from: string, to: string}>
     */
    private function summary(array $in, User $user): array
    {
        $cur = app(GetSettings::class)->data($user);
        $list = fn ($a) => $a ? implode(', ', array_map('intval', (array) $a)) : 'nincs';
        $yes = fn ($v) => $v ? 'igen' : 'nem';
        $text = fn ($v) => ($v ?? '') !== '' ? (string) $v : 'nincs';
        $every = fn ($n) => (int) $n > 0 ? ((int) $n).' naponta' : 'nem megy';
        $rows = [];
        $row = function (string $label, string $from, string $to) use (&$rows) {
            $rows[] = ['label' => $label, 'from' => $from, 'to' => $to];
        };

        if (array_key_exists('reminders', $in)) {
            $row('Emlékeztető napok', $list($cur['reminders_days_before']), $list($in['reminders']));
        }
        if (array_key_exists('reminder_email', $in)) {
            $row('Emlékeztető e-mailben is', $yes($cur['reminder_email']), $yes($in['reminder_email']));
        }
        if (array_key_exists('calendar_invites', $in)) {
            $row('Naptármeghívók', $yes($cur['calendar_invites']['on']), $yes($in['calendar_invites']));
        }
        if (array_key_exists('calendar_estimated', $in)) {
            $row('Becsült határidő is megy meghívóban', $yes($cur['calendar_invites']['estimated_deadlines_too']), $yes($in['calendar_estimated']));
        }
        if (array_key_exists('reply_to', $in)) {
            $row('Válaszcím', $text($cur['reply_to']), $text($in['reply_to']));
        }
        if (array_key_exists('from_name', $in)) {
            $row('Feladó neve', $text($cur['from_name']), $text($in['from_name']));
        }
        foreach (['mail' => 'e-mail', 'nav' => 'NAV', 'cegkapu' => 'Cégkapu'] as $k => $l) {
            if (array_key_exists($k, $in['default_active'] ?? [])) {
                $row("Új ügyfél alapból aktív – {$l}", $yes($cur['default_active'][$k]), $yes($in['default_active'][$k]));
            }
        }
        if (array_key_exists('digest_days', $in)) {
            $row('Összesítő e-mail gyakorisága', $every($cur['digest_days']), $every($in['digest_days']));
        }
        if (array_key_exists('arrears_days', $in)) {
            $row('Hátralék-értesítő gyakorisága', $every($cur['arrears_days']), $every($in['arrears_days']));
        }
        if (array_key_exists('payment_days', $in)) {
            $row('Fizetési emlékeztető napjai', $list($cur['payment_days']), $list($in['payment_days']));
        }
        $types = collect($cur['document_types'])->keyBy('type_id');
        foreach ($in['type_settings'] ?? [] as $t) {
            $type = $types[$t['type_id']] ?? null;
            abort_if(! $type, 404, "Nincs ilyen irattípus: {$t['type_id']}.");
            foreach (self::TYPE_KEYS as $k => $c) {
                if (array_key_exists($k, $t)) {
                    $row("{$type['label']}: ".TypeSettings::LABELS[$c], TypeSettings::show($c, $type['settings'][$c]), TypeSettings::show($c, $t[$k]));
                }
            }
        }

        return $rows;
    }
}
