<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // Az élő tárhely postafiókjának neve, ahogy a tarhely-cli visszaadja. Ehhez rendeljük a leveleket.
        Schema::table('mailboxes', function (Blueprint $t) { $t->string('live_ref')->nullable(); $t->dateTime('live_listed_at')->nullable(); });
    }
    public function down(): void { Schema::table('mailboxes', function (Blueprint $t) { $t->dropColumn(['live_ref', 'live_listed_at']); }); }
};
