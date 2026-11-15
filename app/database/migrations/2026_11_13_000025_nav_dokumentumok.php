<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    /**
     * NAV ügyfélportál, „C kör” (ADR-010): a NAV-nál nyilvántartott dokumentumok, ügyfelenként (az elmúlt fél év).
     * A vonalkód köti össze a beadott bevallással (`nav_returns.reg_no`). Letöltési tokent nem tárolunk.
     */
    public function up(): void
    {
        Schema::create('nav_documents', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('office_id')->index();
            $t->unsignedBigInteger('client_id')->index();
            $t->string('doc_key', 60);            // vonalkód, vagy ha nincs, az iktatószám
            $t->string('barcode', 20)->nullable(); $t->string('reg_no', 40)->nullable();
            $t->string('subject', 300)->nullable();
            $t->string('doc_type', 20)->nullable(); $t->string('form_code', 32)->nullable(); $t->string('form_name', 200)->nullable();
            $t->string('case_type', 200)->nullable(); $t->string('case_no', 40)->nullable(); $t->string('kr_no', 60)->nullable();
            $t->string('submitted_at', 16)->nullable(); $t->string('arrived_at', 16)->nullable(); $t->string('downloaded_at', 16)->nullable();
            $t->unsignedSmallInteger('files')->default(0);
            $t->timestamp('fetched_at');
            $t->timestamps();
            $t->unique(['client_id', 'doc_key']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('nav_documents');
    }
};
