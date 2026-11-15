<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('document_types', function (Blueprint $t) {
            $t->id(); $t->string('type_id')->unique(); $t->string('label'); $t->string('group'); $t->string('priority'); $t->string('risk');
            $t->string('version'); $t->json('patterns'); $t->boolean('legal_marked')->default(false);
        });
        Schema::create('message_reads', function (Blueprint $t) { // saját olvasottság, felhasználónként
            $t->foreignId('message_id'); $t->foreignId('user_id'); $t->timestamp('read_at')->nullable(); $t->primary(['message_id', 'user_id']);
        });
        Schema::create('client_contacts', function (Blueprint $t) {
            $t->id(); $t->foreignId('office_id'); $t->foreignId('client_id')->index(); $t->string('name'); $t->string('email'); $t->string('role')->default('ügyvezető');
        });
        Schema::create('client_notices', function (Blueprint $t) { // ügyfélnek menő értesítés: előnézet → jóváhagyás → küldés
            $t->id(); $t->foreignId('office_id')->index(); $t->foreignId('client_id'); $t->foreignId('message_id')->index();
            $t->string('to_email'); $t->string('to_name'); $t->string('subject'); $t->text('body');
            $t->string('status')->default('draft'); // draft | sent | failed
            $t->string('idempotency_key')->unique(); $t->foreignId('created_by'); $t->foreignId('sent_by')->nullable(); $t->dateTime('sent_at')->nullable();
            $t->string('skip_reason')->nullable(); $t->timestamps();
        });
        Schema::table('documents', function (Blueprint $t) { $t->json('signatures')->nullable(); $t->dateTime('validated_at')->nullable(); $t->longText('text')->nullable(); });
        Schema::table('messages', function (Blueprint $t) { $t->string('type_group')->nullable(); $t->string('type_risk')->nullable(); });
    }
    public function down(): void
    {
        foreach (['client_notices', 'client_contacts', 'message_reads', 'document_types'] as $t) Schema::dropIfExists($t);
    }
};
