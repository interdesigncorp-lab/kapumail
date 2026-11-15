<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // A tárhely saját típuskódja a besorolásra váró postafiókon (élő próba, 2026-11-12: AP = saját tárhely, CKP = Cégkapu).
        Schema::table('discovered_mailboxes', function (Blueprint $t) { $t->string('type_code', 16)->nullable(); });
        // Meglévő adatbázis: a típusfelismerés mintáinak frissítése a típuslistából (új, élőben megfigyelt kódok).
        $file = database_path('data/dokumentumtipus-taxonomia-v0.csv');
        if (!is_file($file) || !DB::table('document_types')->exists()) return;
        $fh = fopen($file, 'r'); $head = fgetcsv($fh);
        while (($row = fgetcsv($fh)) !== false) {
            $x = array_combine($head, $row);
            DB::table('document_types')->where('type_id', $x['type_id'])->update([
                'patterns' => json_encode(array_values(array_filter(array_map('trim', explode(';', $x['mintak'])))), JSON_UNESCAPED_UNICODE),
                'version' => $x['taxonomia_verzio'],
            ]);
        }
        fclose($fh);
    }

    public function down(): void
    {
        Schema::table('discovered_mailboxes', function (Blueprint $t) { $t->dropColumn('type_code'); });
    }
};
