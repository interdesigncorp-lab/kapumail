<?php

use App\Iratkapu\LegalDeadline;
use App\Iratkapu\Taxonomy;
use App\Iratkapu\TypeSettings;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * A 15 napos joghatályú borítékok (kézbesítés vélelmezés, végrehajtási költségátalány/minimum/felosztási terv,
     * jövedéki és vám határozat/végzés, szakterületi I. fokú határozatok és eljárást megszüntető végzések,
     * valamint az ellenőrzési iratbemutatási/iratrendezési felhívó végzések) letöltés előtti mintaillesztésének frissítése.
     */
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
            DB::table('document_types')->whereNull('office_id')->where('type_id', $x['type_id'])->update([
                'patterns' => json_encode(array_values(array_filter(array_map('trim', explode(';', $x['mintak'])))), JSON_UNESCAPED_UNICODE),
            ]);
        }
        fclose($fh);

        Taxonomy::flush();
        TypeSettings::flush();

        if (! DB::table('messages')->exists()) {
            return;
        }
        $rows = DB::table('messages')
            ->where('folder', 'BEERKEZETT')
            ->where(fn ($q) => $q->where('type_ai', true)->orWhere('unknown', true))
            ->get();
        foreach ($rows as $m) {
            $liveType = $m->live_type ?? null;
            $text = trim(($liveType ?? '').' '.($m->subject ?? ''));
            $sender = trim(($m->sender ?? '').' '.($m->sender_full ?? ''));
            $hit = Taxonomy::classify($text, $sender, isset($m->office_id) ? (int) $m->office_id : null, false, '', $liveType);
            if (! $hit || ($hit->type_id ?? null) === ($m->type_id ?? null)) {
                continue;
            }
            DB::table('messages')->where('id', $m->id)->update([
                'type_id' => $hit->type_id,
                'type_label' => $hit->label,
                'type_group' => $hit->group ?? null,
                'type_risk' => $hit->risk ?? null,
                'type_ai' => true,
                'unknown' => false,
            ]);
            if (in_array($m->official ?? '', ['ok', 'fic'], true) && ! empty($m->official_at) && empty($m->legal_date)) {
                LegalDeadline::apply((int) $m->id);
            }
        }
    }

    public function down(): void
    {
        Taxonomy::flush();
    }
};
