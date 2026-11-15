<?php

use App\Iratkapu\LegalDeadline;
use App\Iratkapu\TypeSettings;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Beépített Joghatály-alapértékek (15 nap a határozat/végzés/bírság/meghagyás/kézbesítési vélelem típusokra)
     * a típuslistából, valamint a már átvett iratok joghatály-dátumának utólagos kiszámítása.
     */
    public function up(): void
    {
        Schema::table('document_types', function (Blueprint $t) {
            $t->unsignedSmallInteger('default_legal_days')->nullable();
        });

        $file = database_path('data/dokumentumtipus-taxonomia-v0.csv');
        if (! is_file($file) || ! DB::table('document_types')->exists()) {
            return;
        }
        $fh = fopen($file, 'r');
        $head = fgetcsv($fh);
        while (($row = fgetcsv($fh)) !== false) {
            $x = array_combine($head, $row);
            $days = trim($x['joghataly_nap'] ?? '') !== '' ? (int) $x['joghataly_nap'] : null;
            DB::table('document_types')->where('type_id', $x['type_id'])->update([
                'default_legal_days' => $days,
                'legal_marked' => $days !== null,
            ]);
        }
        fclose($fh);

        TypeSettings::flush();
        $ids = DB::table('messages')
            ->whereIn('official', ['ok', 'fic'])
            ->whereNotNull('official_at')
            ->whereNull('legal_date')
            ->pluck('id');
        foreach ($ids as $id) {
            LegalDeadline::apply((int) $id);
        }
    }

    public function down(): void
    {
        Schema::table('document_types', function (Blueprint $t) {
            $t->dropColumn('default_legal_days');
        });
        TypeSettings::flush();
    }
};
