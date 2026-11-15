<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Szakmai MCP: az iroda automatikus 14 napos próbakulcsa (titkosítva) és a próba vége, a billingtől. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('offices', function (Blueprint $t) {
            $t->text('mcp_trial_key')->nullable();
            $t->date('mcp_trial_ends_at')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('offices', function (Blueprint $t) {
            $t->dropColumn(['mcp_trial_key', 'mcp_trial_ends_at']);
        });
    }
};
