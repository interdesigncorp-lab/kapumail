<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('offices', function (Blueprint $t) {
            $t->id(); $t->string('name'); $t->json('settings')->nullable(); $t->timestamps();
        });
        Schema::table('users', function (Blueprint $t) {
            $t->foreignId('office_id')->nullable()->index();
            $t->string('role')->default('konyvelo'); // admin | vezeto | konyvelo
            $t->string('initials', 4)->default('');
        });
        Schema::create('clients', function (Blueprint $t) {
            $t->id(); $t->foreignId('office_id')->index(); $t->string('name'); $t->string('tax');
            $t->date('auth_until'); $t->string('auth_basis')->default('Állandó meghatalmazás'); $t->timestamps();
            $t->unique(['office_id', 'tax']);
        });
        Schema::create('client_user', function (Blueprint $t) {
            $t->foreignId('client_id'); $t->foreignId('user_id'); $t->primary(['client_id', 'user_id']);
        });
        Schema::create('mailboxes', function (Blueprint $t) {
            $t->id(); $t->foreignId('office_id')->index(); $t->foreignId('client_id')->index();
            $t->string('type', 4); // ÜK | CK | HK
            $t->string('credential_ref')->nullable(); // csak hivatkozás az OS titoktárra, titok soha
            $t->string('sync_state')->default('queue'); // ok | part | need | run | queue
            $t->string('sync_note')->nullable(); $t->dateTime('last_ok_at')->nullable();
            $t->unsignedInteger('demo_cursor')->default(0); $t->timestamps();
        });
        Schema::create('messages', function (Blueprint $t) {
            $t->id(); $t->foreignId('office_id')->index(); $t->foreignId('client_id')->index(); $t->foreignId('mailbox_id');
            $t->string('source_id'); $t->unique(['mailbox_id', 'source_id']);
            $t->string('sender', 8); $t->string('sender_full'); $t->string('subject');
            $t->string('type_id')->default('ismeretlen'); $t->string('type_label');
            $t->boolean('type_ai')->default(false); $t->boolean('unknown')->default(false);
            $t->boolean('receipt')->default(false); $t->boolean('system')->default(false);
            $t->dateTime('arrived_at');
            $t->string('official')->default('wait'); // wait | ok | fic | na | failed
            $t->dateTime('official_at')->nullable(); $t->foreignId('official_by')->nullable();
            $t->string('internal')->default('uj'); // uj | oszt | kiosztott | folyamatban | ell | kesz
            $t->boolean('unread')->default(true); $t->boolean('urgent')->default(false);
            $t->boolean('archived')->default(false); $t->string('label')->nullable();
            $t->foreignId('assignee_id')->nullable();
            $t->date('deadline_date')->nullable(); $t->boolean('deadline_sure')->default(false);
            $t->string('deadline_source')->nullable(); $t->foreignId('deadline_confirmed_by')->nullable();
            $t->boolean('es3')->default(false); $t->unsignedInteger('att')->default(1);
            $t->timestamps();
        });
        Schema::create('delivery_events', function (Blueprint $t) {
            $t->id(); $t->foreignId('office_id'); $t->foreignId('message_id')->index();
            $t->string('type'); $t->dateTime('at'); $t->foreignId('actor_id')->nullable();
            $t->string('evidence_ref'); $t->string('evidence_sha256', 64)->nullable(); $t->timestamps();
        });
        Schema::create('documents', function (Blueprint $t) {
            $t->id(); $t->foreignId('office_id')->index(); $t->foreignId('message_id')->nullable()->index();
            $t->foreignId('parent_id')->nullable(); $t->string('name'); $t->string('mime')->nullable();
            $t->unsignedBigInteger('size'); $t->string('sha256', 64); $t->string('path');
            $t->string('parse_state')->nullable(); // kibontva | nem_bonthato | null
            $t->string('validity')->default('nem_ellenorizheto'); // ervenyes | ervenytelen | nem_ellenorizheto | folyamatban
            $t->string('validity_note')->nullable(); $t->json('meta')->nullable(); $t->foreignId('uploaded_by')->nullable();
            $t->timestamps();
        });
        Schema::create('tasks', function (Blueprint $t) {
            $t->id(); $t->foreignId('office_id'); $t->foreignId('message_id')->index();
            $t->string('title'); $t->foreignId('user_id'); $t->boolean('done')->default(false); $t->timestamps();
        });
        Schema::create('notes', function (Blueprint $t) {
            $t->id(); $t->foreignId('office_id'); $t->foreignId('message_id')->index();
            $t->foreignId('user_id'); $t->text('body'); $t->timestamps();
        });
        Schema::create('approvals', function (Blueprint $t) {
            $t->id(); $t->foreignId('office_id')->index(); $t->foreignId('message_id')->index();
            $t->string('operation'); $t->foreignId('requested_by'); $t->foreignId('decided_by')->nullable();
            $t->string('status')->default('pending'); // pending | approved | rejected | executed | blocked
            $t->string('result_note')->nullable(); $t->dateTime('decided_at')->nullable(); $t->timestamps();
        });
        Schema::create('rules', function (Blueprint $t) {
            $t->id(); $t->foreignId('office_id')->index(); $t->string('name'); $t->json('matcher');
            $t->string('priority')->default('Normál'); $t->foreignId('assignee_id')->nullable();
            $t->string('notify')->default('Nincs'); $t->unsignedInteger('version')->default(1);
            $t->boolean('locked')->default(false); $t->unsignedInteger('position')->default(0); $t->timestamps();
        });
        Schema::create('rule_versions', function (Blueprint $t) {
            $t->id(); $t->foreignId('rule_id')->index(); $t->unsignedInteger('version'); $t->json('data');
            $t->foreignId('saved_by')->nullable(); $t->timestamps();
        });
        Schema::create('sync_runs', function (Blueprint $t) {
            $t->id(); $t->foreignId('office_id')->index(); $t->foreignId('mailbox_id')->index();
            $t->string('state'); $t->unsignedInteger('listed')->default(0); $t->unsignedInteger('created')->default(0);
            $t->string('note')->nullable(); $t->string('actor')->default('system'); $t->timestamps();
        });
        Schema::create('notifications', function (Blueprint $t) {
            $t->id(); $t->foreignId('office_id'); $t->foreignId('user_id')->index(); $t->foreignId('message_id')->nullable();
            $t->string('kind'); $t->string('body'); $t->string('dedupe_key')->unique(); $t->dateTime('read_at')->nullable(); $t->timestamps();
        });
        Schema::create('saved_views', function (Blueprint $t) {
            $t->id(); $t->foreignId('office_id'); $t->foreignId('user_id')->index(); $t->string('name'); $t->json('filters');
            $t->boolean('shared')->default(false); $t->timestamps();
        });
        Schema::create('audit_events', function (Blueprint $t) {
            $t->id(); $t->foreignId('office_id')->index(); $t->dateTime('at_utc');
            $t->foreignId('actor_id')->nullable(); $t->string('actor_label'); $t->string('action');
            $t->foreignId('client_id')->nullable(); $t->foreignId('message_id')->nullable();
            $t->string('before')->nullable(); $t->string('after')->nullable();
            $t->string('evidence')->nullable(); $t->string('policy')->nullable();
        });
        // Az auditnapló csak bővíthető: módosítás és törlés adatbázis-szinten tiltva.
        if (DB::getDriverName() === 'sqlite') {
            DB::unprepared("CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events csak bovitheto'); END;");
            DB::unprepared("CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events csak bovitheto'); END;");
        }
    }
    public function down(): void
    {
        foreach (['audit_events','saved_views','notifications','sync_runs','rule_versions','rules','approvals','notes','tasks','documents','delivery_events','messages','mailboxes','client_user','clients','offices'] as $t) Schema::dropIfExists($t);
    }
};
