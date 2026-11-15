<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // A meghatalmazás lejárata nem kötelező: az üres érték határozatlan idejű meghatalmazást jelent.
        Schema::table('clients', function (Blueprint $t) { $t->date('auth_until')->nullable()->change(); });
    }
    public function down(): void { Schema::table('clients', function (Blueprint $t) { $t->date('auth_until')->nullable(false)->change(); }); }
};
