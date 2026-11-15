<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration {
    /** Meglévő adatbázis: a típusfelismerés mintáinak újabb frissítése a típuslistából (élőben látott NAV-megfogalmazások). */
    public function up(): void
    {
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

    public function down(): void {}
};
