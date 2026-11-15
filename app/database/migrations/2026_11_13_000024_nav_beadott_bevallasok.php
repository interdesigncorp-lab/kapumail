<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * NAV ügyfélportál, „C kör” (ADR-010): a NAV szerint beadott bevallások, ügyfelenként. Az iktatószám köti össze a
     * tárhelyre érkezett nyugtával (az irat vonalkódjával) – a párosítás olvasáskor történik, itt nem tároljuk.
     */
    public function up(): void
    {
        Schema::create('nav_returns', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('office_id')->index();
            $t->unsignedBigInteger('client_id')->index();
            $t->string('reg_no', 20);
            $t->string('form_code', 32);
            $t->string('title', 200)->nullable();
            $t->date('period_from')->nullable();
            $t->date('period_to')->nullable();
            $t->string('submitted_at', 16)->nullable();
            $t->string('state', 60)->nullable();
            $t->string('kind', 40)->nullable();
            $t->timestamp('fetched_at');
            $t->timestamps();
            $t->unique(['client_id', 'reg_no']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('nav_returns');
    }
};
