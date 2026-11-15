<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // A belépő gazdájának saját azonosítói (adóazonosító jel, saját cég adószám-törzse): ezekre a saját tárhely
        // szétválogatója nem sorol be és nem javasol, hogy a magánlevelek ne kerüljenek ügyfél alá.
        Schema::table('portal_connections', function (Blueprint $t) { $t->text('self_identifiers')->nullable(); });
    }

    public function down(): void
    {
        Schema::table('portal_connections', function (Blueprint $t) { $t->dropColumn('self_identifiers'); });
    }
};
