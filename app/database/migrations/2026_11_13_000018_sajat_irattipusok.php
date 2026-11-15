<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /** Saját (irodai) irattípus: az iroda maga veszi fel, kulcsszavakkal. Az `office_id` nélküli sor a beépített típuslista. */
    public function up(): void
    {
        Schema::table('document_types', function (Blueprint $t) {
            $t->unsignedBigInteger('office_id')->nullable()->index();
        });
    }

    public function down(): void
    {
        Schema::table('document_types', function (Blueprint $t) {
            $t->dropColumn('office_id');
        });
    }
};
