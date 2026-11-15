<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('offices', function (Blueprint $t) {
            if (! Schema::hasColumn('offices', 'trial_started_at')) {
                $t->timestamp('trial_started_at')->nullable();
            }
            if (! Schema::hasColumn('offices', 'license_key')) {
                $t->text('license_key')->nullable();
            }
            if (! Schema::hasColumn('offices', 'license_id')) {
                $t->string('license_id', 80)->nullable();
            }
            if (! Schema::hasColumn('offices', 'license_plan')) {
                $t->string('license_plan', 60)->nullable();
            }
            if (! Schema::hasColumn('offices', 'license_holder')) {
                $t->string('license_holder', 160)->nullable();
            }
            if (! Schema::hasColumn('offices', 'license_valid_until')) {
                $t->date('license_valid_until')->nullable();
            }
            if (! Schema::hasColumn('offices', 'license_activated_at')) {
                $t->timestamp('license_activated_at')->nullable();
            }
        });

        DB::table('offices')->whereNull('trial_started_at')->update([
            'trial_started_at' => now(),
        ]);
    }

    public function down(): void {}
};
