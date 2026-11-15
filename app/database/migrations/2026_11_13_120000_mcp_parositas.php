<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** MCP-közvetítő (ADR-013): egyszer használható párosító kódok a ChatGPT / claude.ai OAuth-bejelentkezéséhez helyi módban. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('mcp_pairings', function (Blueprint $t) {
            $t->id();
            $t->foreignId('office_id');
            $t->foreignId('user_id');
            $t->string('code_hash', 64);
            $t->string('level', 12);
            $t->timestamp('expires_at');
            $t->unsignedTinyInteger('attempts')->default(0);
            $t->timestamp('used_at')->nullable();
            $t->string('oauth_client_id', 100)->nullable(); // melyik kliens kapta meg a szintet
            $t->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('mcp_pairings');
    }
};
