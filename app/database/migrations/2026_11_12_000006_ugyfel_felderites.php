<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // A belépő gazdája (aki létrehozta) és az automatikus ügyfélfelvétel kapcsolója.
        Schema::table('portal_connections', function (Blueprint $t) {
            $t->boolean('auto_create_clients')->default(true);
            $t->foreignId('owner_user_id')->nullable();
        });
        // Felderített ügyfél: honnan jött, melyik belépő találta; inaktív ügyfél kimarad a napi sávból és a szinkronból.
        Schema::table('clients', function (Blueprint $t) {
            $t->boolean('active')->default(true);
            $t->string('discovered_via', 16)->nullable(); // null = kézzel felvett | cegkapu | own
            $t->foreignId('portal_connection_id')->nullable();
        });
        // „Besorolásra vár”: élő postafiók, amelyet a program nem tudott egyértelműen ügyfélhez kötni.
        Schema::create('discovered_mailboxes', function (Blueprint $t) {
            $t->id();
            $t->foreignId('office_id')->index();
            $t->foreignId('portal_connection_id')->nullable();
            $t->string('live_ref');
            $t->string('tax8', 8)->nullable();
            $t->string('parsed_name')->nullable();
            $t->string('state', 16)->default('pending'); // pending | assigned | ignored
            $t->unsignedInteger('letters')->default(0);
            $t->dateTime('last_seen_at')->nullable();
            $t->timestamps();
            $t->unique(['office_id', 'live_ref']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('discovered_mailboxes');
        Schema::table('clients', function (Blueprint $t) { $t->dropColumn(['active', 'discovered_via', 'portal_connection_id']); });
        Schema::table('portal_connections', function (Blueprint $t) { $t->dropColumn(['auto_create_clients', 'owner_user_id']); });
    }
};
