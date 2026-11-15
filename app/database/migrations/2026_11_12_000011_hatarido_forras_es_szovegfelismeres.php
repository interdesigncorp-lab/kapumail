<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::table('messages', function (Blueprint $t) {
            $t->text('deadline_excerpt')->nullable();              // az a szövegrész, amelyből a határidő származik
            $t->boolean('past_deadline_warn')->default(false);     // a kinyert dátum az érkezésnél korábbi: hivatkozás, nem határidő
        });
        Schema::table('documents', function (Blueprint $t) {
            $t->string('text_source', 16)->nullable();             // 'text' = a fájl szövegrétege | 'ocr' = szövegfelismerés
        });
    }

    public function down(): void
    {
        Schema::table('messages', function (Blueprint $t) { $t->dropColumn(['deadline_excerpt', 'past_deadline_warn']); });
        Schema::table('documents', function (Blueprint $t) { $t->dropColumn('text_source'); });
    }
};
