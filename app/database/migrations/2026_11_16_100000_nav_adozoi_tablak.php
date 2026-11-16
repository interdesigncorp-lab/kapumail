<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Adózói táblázatok és kimutatások (Hiányzó bevallások, Bevallások, Biztosítottak,
     * Saját foglalkoztatók, Egyszerűsített foglalkoztatottak / EFO, Adategyeztetések).
     */
    public function up(): void
    {
        // 1. nav_returns bővítése (vonalkód, befogadás és hibaüzenet időpontok)
        if (Schema::hasTable('nav_returns')) {
            Schema::table('nav_returns', function (Blueprint $t) {
                if (!Schema::hasColumn('nav_returns', 'barcode')) {
                    $t->string('barcode', 64)->nullable()->after('reg_no');
                }
                if (!Schema::hasColumn('nav_returns', 'accepted_at')) {
                    $t->string('accepted_at', 24)->nullable()->after('submitted_at');
                }
                if (!Schema::hasColumn('nav_returns', 'error_at')) {
                    $t->string('error_at', 24)->nullable()->after('accepted_at');
                }
            });
        }

        // 2. Biztosítottak (foglalkoztatói szempontból bejelentett alkalmazottak / megbízottak)
        if (!Schema::hasTable('nav_insured_persons')) {
            Schema::create('nav_insured_persons', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('office_id')->index();
                $t->unsignedBigInteger('client_id')->index();
                $t->string('name', 200);
                $t->string('tax_id', 10)->nullable()->index();
                $t->string('taj', 16)->nullable()->index();
                $t->date('relationship_start')->nullable()->index();
                $t->date('relationship_end')->nullable();
                $t->string('relationship_type', 120)->nullable();
                $t->decimal('weekly_hours', 5, 2)->nullable();
                $t->string('status', 40)->default('active');
                $t->string('source', 32)->default('nav_upo');
                $t->timestamp('fetched_at')->nullable();
                $t->timestamps();
                $t->index(['office_id', 'client_id']);
            });
        }

        // 3. Saját foglalkoztatók (természetes személy / adózó munkáltatói jogviszonyai)
        if (!Schema::hasTable('nav_employers')) {
            Schema::create('nav_employers', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('office_id')->index();
                $t->unsignedBigInteger('client_id')->index();
                $t->string('employer_name', 200);
                $t->string('employer_tax_number', 16)->nullable()->index();
                $t->string('employer_tax_id', 10)->nullable()->index();
                $t->date('relationship_start')->nullable()->index();
                $t->date('relationship_end')->nullable();
                $t->string('relationship_type', 120)->nullable();
                $t->decimal('weekly_hours', 5, 2)->nullable();
                $t->string('status', 40)->default('active');
                $t->string('source', 32)->default('nav_upo');
                $t->timestamp('fetched_at')->nullable();
                $t->timestamps();
                $t->index(['office_id', 'client_id']);
            });
        }

        // 4. Egyszerűsített foglalkoztatottak (EFO bejelentések tételes listája)
        if (!Schema::hasTable('nav_efo_declarations')) {
            Schema::create('nav_efo_declarations', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('office_id')->index();
                $t->unsignedBigInteger('client_id')->index();
                $t->string('employee_name', 200);
                $t->string('employee_tax_id', 10)->nullable()->index();
                $t->string('employee_taj', 16)->nullable()->index();
                $t->string('declaration_code', 40)->nullable();
                $t->string('employment_type', 80)->nullable();
                $t->date('start_date')->index();
                $t->date('end_date')->index();
                $t->integer('days_count')->default(1);
                $t->string('reg_no', 40)->nullable()->index();
                $t->string('status', 40)->default('Befogadva');
                $t->string('filing_type', 40)->default('Új');
                $t->string('submitted_at', 24)->nullable();
                $t->integer('seq_no')->nullable();
                $t->string('source', 32)->default('nav_upo');
                $t->timestamp('fetched_at')->nullable();
                $t->timestamps();
                $t->index(['office_id', 'client_id']);
            });
        }

        // 5. EFO Napkeret (éves foglalkoztatói és munkavállalói keretek)
        if (!Schema::hasTable('nav_efo_quotas')) {
            Schema::create('nav_efo_quotas', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('office_id')->index();
                $t->unsignedBigInteger('client_id')->index();
                $t->integer('year')->index();
                $t->string('employee_name', 200)->nullable();
                $t->string('employee_tax_id', 10)->nullable()->index();
                $t->string('employee_taj', 16)->nullable()->index();
                $t->string('employment_type', 80)->nullable();
                $t->integer('quota_limit')->default(0);
                $t->integer('used_days')->default(0);
                $t->integer('remaining_days')->default(0);
                $t->timestamps();
                $t->index(['office_id', 'client_id']);
                $t->index(['client_id', 'year']);
            });
        }

        // 6. Adategyeztetések (NAV felhívások és egyeztető eljárások)
        if (!Schema::hasTable('nav_reconciliations')) {
            Schema::create('nav_reconciliations', function (Blueprint $t) {
                $t->id();
                $t->unsignedBigInteger('office_id')->index();
                $t->unsignedBigInteger('client_id')->index();
                $t->string('reconciler_name', 200);
                $t->string('status', 40)->default('Függőben');
                $t->string('case_number', 60)->nullable();
                $t->date('created_date')->index();
                $t->date('submitted_date')->nullable();
                $t->text('notes')->nullable();
                $t->string('source', 32)->default('nav_upo');
                $t->timestamp('fetched_at')->nullable();
                $t->timestamps();
                $t->index(['office_id', 'client_id']);
            });
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('nav_reconciliations');
        Schema::dropIfExists('nav_efo_quotas');
        Schema::dropIfExists('nav_efo_declarations');
        Schema::dropIfExists('nav_employers');
        Schema::dropIfExists('nav_insured_persons');
        if (Schema::hasTable('nav_returns')) {
            Schema::table('nav_returns', function (Blueprint $t) {
                $cols = [];
                if (Schema::hasColumn('nav_returns', 'barcode')) {
                    $cols[] = 'barcode';
                }
                if (Schema::hasColumn('nav_returns', 'accepted_at')) {
                    $cols[] = 'accepted_at';
                }
                if (Schema::hasColumn('nav_returns', 'error_at')) {
                    $cols[] = 'error_at';
                }
                if (!empty($cols)) {
                    $t->dropColumn($cols);
                }
            });
        }
    }
};
