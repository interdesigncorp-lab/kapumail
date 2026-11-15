<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // Egy élő postafiók az irodán belül csak egy tárhelyhez tartozhat – párhuzamos szinkronok mellett is.
        Schema::table('mailboxes', function (Blueprint $t) { $t->unique(['office_id', 'live_ref']); });
    }

    public function down(): void
    {
        Schema::table('mailboxes', function (Blueprint $t) { $t->dropUnique(['office_id', 'live_ref']); });
    }
};
