<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    /** NAV ügyfélportál, „A kör” (ADR-010): a belépő saját nevében kiolvasott adatok tárolása. */
    public function up(): void
    {
        // Az adószámla és a számlálók legfrissebb pillanatképe belépőnként. Összeg csak a lekérdezés pillanatára érvényes.
        Schema::create('nav_snapshots', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('office_id')->index();
            $t->unsignedBigInteger('portal_connection_id')->unique();
            $t->bigInteger('total')->nullable(); $t->bigInteger('debt')->nullable(); $t->bigInteger('surplus')->nullable();
            $t->bigInteger('deposit')->nullable(); $t->bigInteger('unbooked')->nullable();
            $t->unsignedInteger('missing_count')->nullable(); $t->unsignedInteger('future_count')->nullable(); $t->unsignedInteger('calendar_count')->nullable();
            $t->unsignedInteger('profiles_count')->default(0);
            $t->timestamp('fetched_at');
            $t->timestamps();
        });
        // Az ajánlott fél forrása: a saját tárhely levelei ('mail') vagy a NAV képviseleti listája ('nav').
        Schema::table('discovered_subjects', function (Blueprint $t) { $t->string('source', 8)->default('mail'); });
        // Az ügyfélnél rögzül, ha a NAV szerint a belépő képviseli (mikor láttuk utoljára a listán).
        Schema::table('clients', function (Blueprint $t) { $t->timestamp('nav_seen_at')->nullable(); });
    }

    public function down(): void
    {
        Schema::dropIfExists('nav_snapshots');
        Schema::table('discovered_subjects', function (Blueprint $t) { $t->dropColumn('source'); });
        Schema::table('clients', function (Blueprint $t) { $t->dropColumn('nav_seen_at'); });
    }
};
