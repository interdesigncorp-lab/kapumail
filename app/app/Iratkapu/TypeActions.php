<?php

namespace App\Iratkapu;

use Illuminate\Support\Facades\DB;

/**
 * Az irattípus irodai beállításainak beérkezéskori műveletei: „Nem kell” (rejtett + kész + archivált), kezdő állapot, automatikus archiválás.
 * Csak az új irat létrehozásakor hívódik (a RuleEngine::apply előtt), újratipizáláskor és áthelyezéskor nem.
 */
final class TypeActions
{
    /** Rejtés és kezdő állapot. Igaz, ha a levelezési szabályoknak le kell futniuk (rejtett iratra nem: nem írhatják vissza az állapotát). */
    public static function onArrival(int $messageId): bool
    {
        $m = DB::table('messages')->find($messageId);
        if (! $m) {
            return false;
        }
        if (($m->folder ?? null) === 'ELKULDOTT') {
            if (TypeSettings::for((int) $m->office_id, $m->type_id)['hidden']) {
                DB::table('messages')->where('id', $m->id)->update(['hidden' => true, 'archived' => true, 'internal' => 'kesz']);
            }

            return false;
        }
        $s = TypeSettings::for((int) $m->office_id, $m->type_id);
        if ($s['hidden']) {
            $upd = ['hidden' => true, 'archived' => true, 'internal' => 'kesz'];
        } elseif ($s['initialState'] !== 'uj') {
            $upd = ['internal' => $s['initialState']];
        } else {
            return true;
        }
        DB::table('messages')->where('id', $m->id)->update($upd);
        Audit::log((int) $m->office_id, null, 'Irattípus szabálya alkalmazva: '.($s['hidden'] ? 'Nem kell: rejtett, késznek jelölve, archiválva' : "kezdő állapot: {$upd['internal']}"), ['client_id' => $m->client_id, 'message_id' => $m->id]);

        return ! $s['hidden'];
    }

    /** Automatikus archiválás: a határidő-kinyerés és a szabályok után fut, hogy a biztos határidős irat ne kerüljön az archívumba. */
    public static function autoArchive(int $messageId): void
    {
        $m = DB::table('messages')->find($messageId);
        if (! $m || $m->hidden || $m->deadline_sure || ! TypeSettings::for((int) $m->office_id, $m->type_id)['autoArchive']) {
            return;
        }
        DB::table('messages')->where('id', $m->id)->update(['archived' => true, 'internal' => 'kesz']);
        Audit::log((int) $m->office_id, null, 'Irattípus szabálya alkalmazva: automatikus archiválás, késznek jelölve', ['client_id' => $m->client_id, 'message_id' => $m->id]);
    }
}
