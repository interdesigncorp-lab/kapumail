<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasTable('tax_obligations')) {
            return;
        }

        $today = now()->toDateString();
        $rows = DB::table('tax_obligations')
            ->whereIn('status', ['submitted', 'rejected'])
            ->get();

        foreach ($rows as $r) {
            $dueMonth = substr((string) ($r->due_date ?? ''), 0, 7);
            $subMonth = substr((string) ($r->submitted_at ?? ''), 0, 7);
            $staleDate = empty($r->period_end) && $dueMonth !== '' && $subMonth !== '' && $subMonth < $dueMonth;

            $downloadAck = false;
            if (! empty($r->receipt_message_id) && Schema::hasTable('messages')) {
                $msg = DB::table('messages')->where('id', $r->receipt_message_id)->first();
                if ($msg && preg_match('/letöltési\s+igazolás|letoltesiigazolas/iu', ($msg->subject ?? '').' '.($msg->live_type ?? ''))) {
                    $downloadAck = true;
                }
            }

            if ($staleDate || $downloadAck) {
                $due = (string) ($r->due_date ?? '');
                $restored = ! empty($r->conditional)
                    ? 'conditional'
                    : ($due !== '' && $due < $today ? 'missing' : 'submittable');

                DB::table('tax_obligations')->where('id', $r->id)->update([
                    'status' => $restored,
                    'receipt_message_id' => null,
                    'submitted_at' => null,
                    'error_at' => null,
                    'updated_at' => now(),
                ]);
            }
        }
    }

    public function down(): void
    {
        // Adatjavító migráció – visszavonás nem szükséges.
    }
};
