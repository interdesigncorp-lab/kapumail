<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Kapu-chat (ADR-014): a beállítás-módosítás jóváhagyási kérései. Egy kérés egy konkrét módosításra szól, egyszer használható, és lejár. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('kapu_confirmations', function (Blueprint $t) {
            $t->uuid('id')->primary();
            $t->foreignId('office_id');
            $t->foreignId('user_id');
            $t->unsignedBigInteger('token_id')->nullable(); // a kérő MCP-token; OAuth- vagy helyi kapcsolatnál üres
            $t->string('payload_hash', 64);
            $t->json('payload');
            $t->json('summary');
            $t->timestamp('approved_at')->nullable();
            $t->timestamp('used_at')->nullable();
            $t->timestamp('expires_at');
            $t->timestamps();
            $t->index(['user_id', 'expires_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('kapu_confirmations');
    }
};
