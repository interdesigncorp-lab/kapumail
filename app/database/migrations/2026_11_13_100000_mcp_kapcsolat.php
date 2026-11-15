<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * AI-kapcsolat MCP-n át (ADR-012): személyes MCP-tokenek, az OAuth-kliensek (ChatGPT, claude.ai) szintje felhasználónként,
 * és teljes szövegű keresés az iratok kinyert szövegében.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('mcp_tokens', function (Blueprint $t) {
            $t->id();
            $t->foreignId('office_id');
            $t->foreignId('user_id');
            $t->string('name', 80);
            $t->string('token_hash', 64)->unique(); // SHA-256; maga a token csak létrehozáskor látszik
            $t->string('hint', 12); // a token utolsó karakterei, hogy a listában felismerhető legyen
            $t->string('level', 12); // olvasas | munka | admin
            $t->timestamp('expires_at')->nullable();
            $t->timestamp('last_used_at')->nullable();
            $t->timestamp('revoked_at')->nullable();
            $t->timestamps();
        });

        Schema::create('mcp_grants', function (Blueprint $t) {
            $t->id();
            $t->foreignId('office_id');
            $t->foreignId('user_id');
            $t->string('oauth_client_id', 100);
            $t->string('level', 12)->default('olvasas');
            $t->timestamp('last_used_at')->nullable();
            $t->timestamp('revoked_at')->nullable();
            $t->timestamps();
            $t->unique(['oauth_client_id', 'user_id']);
        });

        if (DB::getDriverName() === 'sqlite') {
            // Külső tartalmú FTS5-tábla: a szöveget a `documents` tárolja, a triggerek tartják szinkronban.
            DB::statement("CREATE VIRTUAL TABLE documents_fts USING fts5(name, text, content='documents', content_rowid='id', tokenize='unicode61 remove_diacritics 2')");
            DB::statement("CREATE TRIGGER documents_fts_ai AFTER INSERT ON documents BEGIN INSERT INTO documents_fts(rowid, name, text) VALUES (new.id, new.name, coalesce(new.text, '')); END");
            DB::statement("CREATE TRIGGER documents_fts_ad AFTER DELETE ON documents BEGIN INSERT INTO documents_fts(documents_fts, rowid, name, text) VALUES ('delete', old.id, old.name, coalesce(old.text, '')); END");
            DB::statement("CREATE TRIGGER documents_fts_au AFTER UPDATE OF name, text ON documents BEGIN INSERT INTO documents_fts(documents_fts, rowid, name, text) VALUES ('delete', old.id, old.name, coalesce(old.text, '')); INSERT INTO documents_fts(rowid, name, text) VALUES (new.id, new.name, coalesce(new.text, '')); END");
            DB::statement("INSERT INTO documents_fts(rowid, name, text) SELECT id, name, coalesce(text, '') FROM documents");
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'sqlite') {
            foreach (['ai', 'ad', 'au'] as $s) {
                DB::statement("DROP TRIGGER IF EXISTS documents_fts_$s");
            }
            DB::statement('DROP TABLE IF EXISTS documents_fts');
        }
        Schema::dropIfExists('mcp_grants');
        Schema::dropIfExists('mcp_tokens');
    }
};
