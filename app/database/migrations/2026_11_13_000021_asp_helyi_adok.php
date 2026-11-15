<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    /**
     * E-Önkormányzat Portál (ASP), ablakos út (ADR-011): az önkormányzatonként beolvasott helyi adó adatok.
     * Egy sor: egy alany (ügyfél, vagy a beolvasó saját maga) egy önkormányzatnál egy évre. Az adószámla-kivonat PDF-ben
     * jön, ezért a fájlt tesszük el; összeget nem tárolunk. Minden adat csak a lekérdezés pillanatára érvényes.
     */
    public function up(): void
    {
        Schema::create('asp_statements', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('office_id')->index();
            $t->unsignedBigInteger('user_id');               // aki beolvasta
            $t->unsignedBigInteger('client_id')->nullable()->index(); // null: a beolvasó saját adata – csak ő látja
            $t->string('subject_key', 24);                   // adószám törzse / adóazonosító jel, vagy „own:<user>”
            $t->string('subject_role', 80)->nullable();
            $t->string('tenant_uid', 64);
            $t->string('tenant_name', 200)->nullable();
            $t->string('tenant_city', 120)->nullable();
            $t->unsignedSmallInteger('year');
            $t->string('kind', 10)->nullable();
            $t->string('status', 40)->nullable();
            $t->string('pdf_path')->nullable(); $t->char('pdf_sha256', 64)->nullable(); $t->unsignedInteger('pdf_size')->nullable();
            $t->unsignedInteger('returns_count')->nullable(); $t->text('returns')->nullable();
            $t->unsignedInteger('cases_count')->nullable();
            $t->text('notes')->nullable();
            $t->timestamp('fetched_at');
            $t->timestamps();
            $t->unique(['office_id', 'subject_key', 'tenant_uid', 'year']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('asp_statements');
    }
};
