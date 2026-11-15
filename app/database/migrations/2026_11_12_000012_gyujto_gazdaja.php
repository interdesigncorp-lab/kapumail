<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // A saját tárhely gyűjtőjének gazdája magán az ügyfélen: a belépő törlése vagy a kezelők szerkesztése sem viheti át másra.
        Schema::table('clients', function (Blueprint $t) { $t->foreignId('owner_user_id')->nullable(); });
        foreach (DB::table('clients')->where('discovered_via', 'own')->get() as $c) {
            $owner = $c->portal_connection_id ? DB::table('portal_connections')->where('id', $c->portal_connection_id)->value('owner_user_id') : null;
            $owner ??= DB::table('client_user')->where('client_id', $c->id)->orderBy('user_id')->value('user_id');
            if ($owner) DB::table('clients')->where('id', $c->id)->update(['owner_user_id' => $owner]);
        }
    }

    public function down(): void
    {
        Schema::table('clients', function (Blueprint $t) { $t->dropColumn('owner_user_id'); });
    }
};
