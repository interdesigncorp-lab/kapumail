<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // A könyvelő saját tárhelyére érkezett, ügyfélhez sorolt irat eredete és a besorolás indoka.
        Schema::table('messages', function (Blueprint $t) {
            $t->foreignId('routed_from_client_id')->nullable();   // a saját tárhely gyűjtője, ahonnan az irat érkezett
            $t->string('route_basis')->nullable();                // mi alapján sorolta be a program
            $t->foreignId('route_suggest_client_id')->nullable(); // névegyezés: csak javaslat
            $t->boolean('route_manual')->default(false);          // ember döntött: a program többé nem sorolja át
        });
    }

    public function down(): void
    {
        Schema::table('messages', function (Blueprint $t) { $t->dropColumn(['routed_from_client_id', 'route_basis', 'route_suggest_client_id', 'route_manual']); });
    }
};
