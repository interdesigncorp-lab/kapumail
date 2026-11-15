<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // Irattípusonkénti irodai beállítások: külön tábla, mert a letöltési felülírás sora az alapra állításkor törlődik.
        Schema::create('document_type_settings', function (Blueprint $t) {
            $t->id();
            $t->foreignId('office_id')->constrained()->cascadeOnDelete();
            $t->string('type_id');
            $t->string('email_to', 8)->default('none');
            $t->boolean('auto_archive')->default(false);
            $t->boolean('hidden')->default(false);
            $t->string('initial_state', 12)->default('uj');
            $t->unsignedSmallInteger('legal_days')->nullable();
            $t->foreignId('set_by')->nullable()->constrained('users')->nullOnDelete();
            $t->timestamps();
            $t->unique(['office_id', 'type_id']);
        });
        Schema::table('messages', function (Blueprint $t) {
            $t->boolean('hidden')->default(false);
            $t->date('legal_date')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('messages', function (Blueprint $t) { $t->dropColumn(['hidden', 'legal_date']); });
        Schema::dropIfExists('document_type_settings');
    }
};
