<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        // Felhasználónként naponta legfeljebb egy összesítő: a sor egyben a küldés foglalása is.
        Schema::create('digest_runs', function (Blueprint $t) {
            $t->id(); $t->unsignedBigInteger('office_id')->index(); $t->unsignedBigInteger('user_id'); $t->date('sent_on'); $t->timestamps();
            $t->unique(['user_id', 'sent_on']);
        });
    }

    public function down(): void { Schema::dropIfExists('digest_runs'); }
};
