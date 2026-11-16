<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasTable('nav_returns') || ! Schema::hasColumn('nav_returns', 'barcode')) {
            return;
        }

        // A korábbi demó-seeder által a valós iktatószámok elé ragasztott „BC-” előtag eltávolítása adatvesztés nélkül.
        DB::table('nav_returns')
            ->whereNotNull('reg_no')
            ->where('barcode', 'like', 'BC-%')
            ->whereRaw("barcode = 'BC-' || reg_no")
            ->update([
                'barcode' => DB::raw('reg_no'),
                'updated_at' => now(),
            ]);
    }

    public function down(): void
    {
        // Adattisztító migráció – visszavonás nem szükséges.
    }
};
