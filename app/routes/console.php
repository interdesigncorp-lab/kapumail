<?php
use App\Iratkapu\{CalendarInvites, ClientReminders, Digest, Notify, SyncService, TrialLicense};
use Illuminate\Support\Facades\{Artisan, DB, Schedule};

// Listázó szinkron minden naprakész tárhelyre. A rendszer (actor = null) csak listázhat:
// az őrfüggvény minden joghatású műveletet elutasít tőle.
Artisan::command('iratkapu:szinkron', function () {
    $n = 0;
    foreach (DB::table('mailboxes')->where('sync_state', '!=', 'need')->get() as $mb) {
        if (! TrialLicense::canSyncOffice((int) $mb->office_id)) continue;
        $n += SyncService::run($mb, null)['created'];
    }
    $this->info("Listázás kész, $n új küldemény.");
})->purpose('Tárhelyek listázó szinkronja (átvétel nélkül)');

Artisan::command('kapumail:licenc-kiadas {lic} {--plan=hivatalos} {--exp=} {--sub=} {--key-file=}', function (string $lic) {
    $keyFile = (string) ($this->option('key-file') ?: (getenv('HOME') ? getenv('HOME').'/.config/kapumail/license-signing.pem' : ''));
    $pem = (string) (config('iratkapu.license_private_key') ?: ($keyFile && is_file($keyFile) ? file_get_contents($keyFile) : ''));
    if (trim($pem) === '') {
        $this->error('Nem található privát aláírókulcs (IRATKAPU_LICENSE_PRIVATE_KEY vagy ~/.config/kapumail/license-signing.pem).');
        return 1;
    }
    $token = TrialLicense::issueKey([
        'lic' => $lic,
        'plan' => (string) $this->option('plan'),
        'exp' => $this->option('exp') ? (string) $this->option('exp') : null,
        'sub' => $this->option('sub') ? (string) $this->option('sub') : null,
    ], $pem);
    $this->line($token);
    return 0;
})->purpose('Kriptográfiailag aláírt KapuMail előfizetési licenckulcs (KM1.*) kibocsátása');

Artisan::command('iratkapu:emlekeztetok', function () {
    $this->info(Notify::reminders() . ' emlékeztető létrehozva.');
    $this->info(Notify::authorizations() . ' meghatalmazás-értesítés létrehozva.');
})->purpose('Határidő-emlékeztetők megerősített határidőkre és meghatalmazás-lejárati értesítések');

Artisan::command('iratkapu:naptarmeghivok', function () {
    foreach (DB::table('offices')->pluck('id') as $office) {
        $r = CalendarInvites::sync((int) $office);
        $this->info("Iroda #$office: {$r['sent']} új, {$r['updated']} frissített, {$r['cancelled']} lemondott meghívó".($r['error'] ? " – hiba: {$r['error']}" : '').(isset($r['skipped']) ? " – {$r['skipped']}" : ''));
    }
})->purpose('Határidők naptármeghívóként az ügyfelek kapcsolattartóinak (ha az iroda bekapcsolta)');

Artisan::command('iratkapu:ertesitok', function () {
    $failed = 0;
    foreach (DB::table('offices')->orderBy('id')->pluck('id') as $office) {
        $o = (int) $office; $today = now();
        // Egy iroda hibája nem állíthatja meg a többit; a végén hibakóddal zárunk, hogy az ütemező és az asztali app lássa.
        try { $this->info("Iroda #$o: ".ClientReminders::arrears($o, $today).' hátralék, '.ClientReminders::payments($o, $today).' fizetési, '.Digest::run($o, $today).' összesítő'); }
        catch (\Throwable $e) { $failed++; report($e); $this->error("Iroda #$o: hiba, az értesítők nem futottak le: ".$e->getMessage()); }
    }
    return $failed ? 1 : 0;
})->purpose('Hátralék-értesítők, fizetési emlékeztetők az ügyfeleknek és reggeli összesítő a munkatársaknak (irodánként)');

Schedule::command('iratkapu:szinkron')->everyThirtyMinutes()->withoutOverlapping();
Schedule::command('iratkapu:emlekeztetok')->dailyAt('07:00');
Schedule::command('iratkapu:naptarmeghivok')->everyThirtyMinutes()->withoutOverlapping();
Schedule::command('iratkapu:ertesitok')->dailyAt('07:00')->withoutOverlapping();
