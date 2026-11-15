<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // Irattípusonkénti letöltési szabály (ADR-009): auto | kezi | csak_lista. Az alapérték a szigorúbb középső.
        Schema::table('document_types', function (Blueprint $t) { $t->string('download_policy', 16)->default('kezi'); });
        // Irodánkénti felülírás: a vezető szigoríthat, lazítani az admin tud.
        Schema::create('document_type_overrides', function (Blueprint $t) {
            $t->id();
            $t->foreignId('office_id')->constrained()->cascadeOnDelete();
            $t->string('type_id');
            $t->string('policy', 16);
            $t->foreignId('set_by')->nullable()->constrained('users')->nullOnDelete();
            $t->timestamps();
            $t->unique(['office_id', 'type_id']);
        });
        // Meglévő adatbázis: a típuslistából töltjük fel a szabályt, hogy ne kelljen újraseedelni.
        $file = database_path('data/dokumentumtipus-taxonomia-v0.csv');
        if (!is_file($file) || !DB::table('document_types')->exists()) return;
        $fh = fopen($file, 'r'); $head = fgetcsv($fh);
        while (($row = fgetcsv($fh)) !== false) {
            $x = array_combine($head, $row);
            if (in_array($x['letoltesi_szabaly'] ?? '', ['auto', 'kezi', 'csak_lista'], true)) {
                DB::table('document_types')->where('type_id', $x['type_id'])->update(['download_policy' => $x['letoltesi_szabaly']]);
            }
        }
        fclose($fh);
    }

    public function down(): void
    {
        Schema::dropIfExists('document_type_overrides');
        Schema::table('document_types', function (Blueprint $t) { $t->dropColumn('download_policy'); });
    }
};
