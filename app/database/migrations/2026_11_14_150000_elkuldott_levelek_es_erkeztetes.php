<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('messages', function (Blueprint $t) {
            $t->string('recipient', 255)->nullable();
            $t->string('recipient_short', 64)->nullable();
            $t->string('ref_eid', 64)->nullable()->index();
            $t->string('filing_status', 24)->nullable()->index(); // pending | confirmed | rejected
            $t->unsignedBigInteger('filing_receipt_id')->nullable()->index();
            $t->foreign('filing_receipt_id')->references('id')->on('messages')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('messages', function (Blueprint $t) {
            $t->dropForeign(['filing_receipt_id']);
            $t->dropColumn([
                'recipient',
                'recipient_short',
                'ref_eid',
                'filing_status',
                'filing_receipt_id',
            ]);
        });
    }
};
