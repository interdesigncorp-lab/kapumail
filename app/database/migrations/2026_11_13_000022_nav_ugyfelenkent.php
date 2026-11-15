<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    /**
     * NAV ügyfélportál, „B kör” (ADR-010): a képviselt adózók (ügyfelek) adószámlájának és számlálóinak legfrissebb
     * pillanatképe, ügyfelenként. Összeg csak a lekérdezés pillanatára érvényes. Az adónaptár tételei a meglévő
     * kötelezettség-tárolóba (`tax_obligations`) kerülnek.
     */
    public function up(): void
    {
        Schema::create('nav_client_snapshots', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('office_id')->index();
            $t->unsignedBigInteger('client_id')->unique();
            $t->unsignedBigInteger('portal_connection_id');
            $t->bigInteger('total')->nullable(); $t->bigInteger('debt')->nullable(); $t->bigInteger('surplus')->nullable();
            $t->bigInteger('deposit')->nullable(); $t->bigInteger('unbooked')->nullable();
            $t->unsignedInteger('missing_count')->nullable(); $t->unsignedInteger('future_count')->nullable(); $t->unsignedInteger('calendar_count')->nullable();
            $t->timestamp('fetched_at');
            $t->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('nav_client_snapshots');
    }
};
