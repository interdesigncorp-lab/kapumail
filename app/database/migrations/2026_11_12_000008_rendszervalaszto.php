<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // Mely állami rendszerekbe léphet be a program ezzel a belépővel. Üres = mind (ClientDiscovery::SYSTEMS).
        Schema::table('portal_connections', function (Blueprint $t) { $t->text('enabled_systems')->nullable(); });
    }

    public function down(): void
    {
        Schema::table('portal_connections', function (Blueprint $t) { $t->dropColumn('enabled_systems'); });
    }
};
