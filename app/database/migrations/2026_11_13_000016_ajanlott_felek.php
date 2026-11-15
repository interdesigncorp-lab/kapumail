<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // A saját tárhely leveleinek tárgyából kiolvasott, még ismeretlen felek („azonosító - NÉV - …”): ajánlat ügyfélnek.
        Schema::create('discovered_subjects', function (Blueprint $t) {
            $t->id();
            $t->unsignedBigInteger('office_id')->index();
            $t->unsignedBigInteger('portal_connection_id');
            $t->unsignedBigInteger('collector_client_id');
            $t->string('identifier', 10);          // adóazonosító jel (10 jegy) vagy adószám-törzs (8 jegy)
            $t->string('kind', 12);                // business | sole | person (a névből és az azonosítóból becsülve)
            $t->string('parsed_name', 120);
            $t->unsignedInteger('letters')->default(0);
            $t->string('state', 12)->default('pending'); // pending | created | self | ignored
            $t->timestamp('last_seen_at')->nullable();
            $t->timestamps();
            $t->unique(['office_id', 'portal_connection_id', 'identifier']);
        });
        // Kiket dolgozzon fel a program a belépő saját tárhelyének leveleiből: csak vállalkozásokat, vagy egyéni vállalkozókat és magánszemélyeket is.
        Schema::table('portal_connections', function (Blueprint $t) { $t->string('subject_scope', 12)->default('all'); });
    }

    public function down(): void
    {
        Schema::dropIfExists('discovered_subjects');
        Schema::table('portal_connections', function (Blueprint $t) { $t->dropColumn('subject_scope'); });
    }
};
