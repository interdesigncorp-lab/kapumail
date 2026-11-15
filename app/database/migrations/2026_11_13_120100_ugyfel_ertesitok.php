<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // Az automatikus levélnek nincs irata és nincs felhasználója, ezért e két mező elhagyható; a kind mondja meg, honnan jött.
        Schema::table('client_notices', function (Blueprint $t) {
            $t->unsignedBigInteger('message_id')->nullable()->change();
            $t->unsignedBigInteger('created_by')->nullable()->change();
            $t->string('kind', 8)->default('kezi'); // kezi | fwd | arr | pay
        });
        Schema::table('clients', function (Blueprint $t) {
            $t->boolean('arrears_notice')->default(false);
            $t->boolean('payment_notice')->default(false);
        });
    }

    public function down(): void
    {
        Schema::table('clients', function (Blueprint $t) { $t->dropColumn(['arrears_notice', 'payment_notice']); });
        Schema::table('client_notices', function (Blueprint $t) { $t->dropColumn('kind'); });
    }
};
