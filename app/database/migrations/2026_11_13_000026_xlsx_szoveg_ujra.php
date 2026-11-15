<?php

use App\Iratkapu\Documents;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;

/**
 * A ZIP-alapú (XLSX, DOCX…) iratok szövege korábban a nyers bájtokból készült, mert a MIME-típusukban szerepel az „xml”.
 * Újraszámoljuk: az XLSX-ek első munkalapja tabulátorral tagolt sorokként kerül a `text` mezőbe, a többinél üres lesz.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::table('documents')->whereNotNull('text')->where('mime', 'like', '%openxmlformats%')->orderBy('id')
            ->each(function ($d) {
                $bytes = Storage::disk('local')->exists($d->path) ? Storage::disk('local')->get($d->path) : null;
                $text = $bytes === null ? null : Documents::extractText($d->mime, $bytes);
                DB::table('documents')->where('id', $d->id)->update(['text' => $text, 'text_source' => $text === null ? null : 'text']);
            });
    }

    public function down(): void {}
};
