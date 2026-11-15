<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /** Meglévő adatbázis: a típuslista új sorainak felvétele (a tárgy szavaiból kikövetkeztetett „határozat vagy végzés” gyűjtőtípus). */
    public function up(): void
    {
        $file = database_path('data/dokumentumtipus-taxonomia-v0.csv');
        if (! is_file($file) || ! DB::table('document_types')->exists()) {
            return;
        }
        $fh = fopen($file, 'r');
        $head = fgetcsv($fh);
        while (($row = fgetcsv($fh)) !== false) {
            $x = array_combine($head, $row);
            if (DB::table('document_types')->where('type_id', $x['type_id'])->exists()) {
                continue;
            }
            DB::table('document_types')->insert([
                'type_id' => $x['type_id'], 'label' => $x['type_cimke'], 'group' => $x['csoport'], 'priority' => $x['javasolt_alap_prioritas'],
                'risk' => $x['atveteli_kockazat_becsles'], 'version' => $x['taxonomia_verzio'], 'download_policy' => $x['letoltesi_szabaly'], 'legal_marked' => false,
                'patterns' => json_encode(array_values(array_filter(array_map('trim', explode(';', $x['mintak'])))), JSON_UNESCAPED_UNICODE),
            ]);
        }
        fclose($fh);
    }

    public function down(): void {}
};
