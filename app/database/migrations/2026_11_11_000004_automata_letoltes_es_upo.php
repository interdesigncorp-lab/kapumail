<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // Ügyfélkapu+ / DÁP portálkapcsolatok fejlécadatai.
        // Titok (jelszó, TOTP-kulcs) SOHA nem kerül ide – kizárólag az asztali gép OS kulcstartójába (`vault_key` hivatkozás).
        Schema::create('portal_connections', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('office_id')->index();
            $t->string('name', 120);
            $t->text('notes')->nullable();
            $t->string('notify_email', 160)->nullable();
            $t->string('auth_mode', 16)->default('totp'); // totp | email | dap
            $t->string('vault_key', 80); // pl. portal-1 (helyi OS kulcstartó hivatkozás, nem URI)
            $t->boolean('download_active')->default(true);
            $t->string('tarhely_state', 16)->default('idle'); // ok | need | idle
            $t->dateTime('tarhely_at')->nullable();
            $t->string('upo_state', 16)->default('idle'); // ok | need | idle
            $t->dateTime('upo_at')->nullable();
            $t->string('last_error', 240)->nullable();
            $t->timestamps();
        });

        Schema::table('mailboxes', function (Blueprint $t) {
            $t->unsignedBigInteger('portal_connection_id')->nullable()->index();
            $t->decimal('quota_pct', 5, 1)->nullable();
        });

        Schema::table('messages', function (Blueprint $t) {
            $t->date('expires_at')->nullable();
            $t->boolean('portal_opened')->nullable();
            $t->boolean('durable')->default(false);
            $t->unsignedBigInteger('file_size')->nullable();
            $t->string('folder', 24)->default('BEERKEZETT');
            $t->string('form_code', 32)->nullable();
            $t->string('barcode', 64)->nullable();
            $t->date('period_from')->nullable();
            $t->date('period_to')->nullable();
        });

        Schema::table('rules', function (Blueprint $t) {
            // manual: csak kézi gombra | auto_safe: csak joghatás nélküli nyugtákra | auto_override_legal: joghatályos iratokra is (felülírás)
            $t->string('download_mode', 32)->default('manual');
        });

        // NAV ÜPO Adónaptár (bevallási kötelezettségek) és beküldött/hiányzó bevallások
        Schema::create('tax_obligations', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('office_id')->index();
            $t->unsignedBigInteger('client_id')->index();
            $t->string('source', 16)->default('upo'); // upo | demo
            $t->string('external_key', 160);
            $t->string('form_code', 32);
            $t->string('title', 200);
            $t->date('period_start')->nullable();
            $t->date('period_end')->nullable();
            $t->date('due_date')->index();
            $t->boolean('conditional')->default(false);
            $t->string('status', 20)->default('submittable'); // submittable | submitted | missing | conditional | rejected
            $t->string('barcode', 64)->nullable();
            $t->date('submitted_at')->nullable();
            $t->date('error_at')->nullable();
            $t->unsignedBigInteger('receipt_message_id')->nullable()->index();
            $t->timestamps();
            $t->unique(['client_id', 'external_key']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('tax_obligations');
        Schema::table('rules', function (Blueprint $t) {
            $t->dropColumn('download_mode');
        });
        Schema::table('messages', function (Blueprint $t) {
            $t->dropColumn(['expires_at', 'portal_opened', 'durable', 'file_size', 'folder', 'form_code', 'barcode', 'period_from', 'period_to']);
        });
        Schema::table('mailboxes', function (Blueprint $t) {
            $t->dropColumn(['portal_connection_id', 'quota_pct']);
        });
        Schema::dropIfExists('portal_connections');
    }
};
