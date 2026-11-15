<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Az ÁSZF, az adatkezelési tájékoztató és az adatfeldolgozási feltételek elfogadásának naplója.
 * Csak bővül: minden elfogadás új sor, a pontos szövegek SHA-256 lenyomatával (Ptk. 6:78. – a kiemelt
 * rendelkezések kifejezett elfogadásának bizonyítása).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('terms_acceptances', function (Blueprint $t) {
            $t->id();
            $t->foreignId('office_id');
            $t->foreignId('user_id');
            $t->string('version', 40);
            $t->json('items');   // az egyenként bepipált nyilatkozatok kulcsai
            $t->json('hashes');  // dokumentum => a szöveg SHA-256 lenyomata az elfogadás pillanatában
            $t->string('ip', 45)->nullable();
            $t->string('user_agent', 255)->nullable();
            $t->timestamp('accepted_at');
            $t->index(['user_id', 'version']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('terms_acceptances');
    }
};
