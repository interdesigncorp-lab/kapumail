<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** MCP-ből indítható szinkron (ADR-016): az MI-kapcsolatok szinkronkérései, amelyeket az asztali app vesz fel és futtat le. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('mcp_sync_requests', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('office_id')->index();
            $t->unsignedBigInteger('user_id');
            $t->string('source', 120);
            $t->unsignedBigInteger('token_id')->nullable();
            $t->unsignedBigInteger('grant_id')->nullable();
            $t->string('status', 12)->default('pending');
            $t->string('note', 300)->nullable();
            $t->timestamp('created_at')->nullable();
            $t->timestamp('started_at')->nullable();
            $t->timestamp('finished_at')->nullable();
            $t->index(['office_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('mcp_sync_requests');
    }
};
