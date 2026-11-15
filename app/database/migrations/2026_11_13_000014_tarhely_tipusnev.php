<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // A tárhely saját típusneve (a feladó által adott szabad szöveg): megőrizzük, hogy a besorolatlan iratnál is látsszon,
        // és hogy a típuslista bővülésekor a már bent lévő iratot újra be lehessen sorolni.
        Schema::table('messages', function (Blueprint $t) { $t->string('live_type', 200)->nullable(); });
        // Meglévő adatbázis: a típusfelismerés mintáinak frissítése a típuslistából (élőben megfigyelt megfogalmazások, 2026-11-13).
        $file = database_path('data/dokumentumtipus-taxonomia-v0.csv');
        if (!is_file($file) || !DB::table('document_types')->exists()) return;
        $fh = fopen($file, 'r'); $head = fgetcsv($fh);
        while (($row = fgetcsv($fh)) !== false) {
            $x = array_combine($head, $row);
            DB::table('document_types')->where('type_id', $x['type_id'])->update([
                'patterns' => json_encode(array_values(array_filter(array_map('trim', explode(';', $x['mintak'])))), JSON_UNESCAPED_UNICODE),
            ]);
        }
        fclose($fh);
    }

    public function down(): void
    {
        Schema::table('messages', function (Blueprint $t) { $t->dropColumn('live_type'); });
    }
};
