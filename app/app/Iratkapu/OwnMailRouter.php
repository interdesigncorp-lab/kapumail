<?php

namespace App\Iratkapu;

use Illuminate\Support\Facades\DB;

/**
 * A könyvelő saját értesítési tárhelyére érkező, ügyfélnek szóló iratok szétválogatása (Air. 79. §).
 * Az átsorolt irat mindenkinek láthatóvá válik, aki az ügyfelet látja, ezért a program óvatos:
 *  - automatikusan csak azonosító (adószám, adóazonosító jel) alapján sorol be, és csak akkor, ha a levél
 *    leírásában vagy típusában pontosan egy olyan aktív ügyfél azonosítója áll, akit a tárhely gazdája is lát;
 *  - a címzett mezőt nem használja besorolásra (ott jó eséllyel a gazda saját azonosítója áll), csak javaslatra;
 *  - a gazda saját azonosítóira (a belépőn megadva) se nem sorol, se nem javasol;
 *  - a névegyezés csak javaslat.
 */
final class OwnMailRouter
{
    /** A szövegből kiolvasható azonosítók: adóazonosító jelek (10 jegy) és adószám-törzsek (8 jegy). */
    public static function identifiers(string $text): array
    {
        $ids = [];
        $rest = preg_replace_callback('/(?<!\d)(8\d{9})(?!\d)/', function ($m) use (&$ids) {
            $ids[$m[1]] = true;

            return ' ';
        }, $text);
        $rest = preg_replace_callback('/(?<!\d)(\d{8})-?\d-?\d{2}(?!\d)/', function ($m) use (&$ids) {
            $ids[$m[1]] = true;

            return ' ';
        }, $rest);
        preg_replace_callback('/(?<!\d)(\d{8})(?!\d)/', function ($m) use (&$ids) {
            $ids[$m[1]] = true;

            return ' ';
        }, $rest);

        return array_map('strval', array_keys($ids));
    }

    /**
     * @param  ?array<int>  $allowedClientIds  csak ezek az ügyfelek jöhetnek szóba (a tárhely gazdája által látottak); null = mind
     * @param  array<string>  $selfIds  a gazda saját azonosítói: kizárva
     * @return array{client: ?object, basis: ?string, suggest: ?object}
     */
    public static function decide(int $officeId, string $text, string $recipient = '', ?array $allowedClientIds = null, array $selfIds = []): array
    {
        $none = ['client' => null, 'basis' => null, 'suggest' => null];
        $keyOf = fn ($c) => preg_match('/^8\d{9}$/', (string) $c->tax) ? (string) $c->tax : substr(preg_replace('/\D/', '', (string) $c->tax), 0, 8);
        // Az egyezést az iroda MINDEN ügyfelére nézzük (inaktívra és a gazda által nem látottra is), hogy a több ügyfélre
        // illő levél akkor se sorolódjon be, ha a másik ügyfelet a gazda nem látja. Besorolni viszont csak engedélyezetthez lehet.
        $all = DB::table('clients')->where('office_id', $officeId)
            ->where(fn ($q) => $q->whereNull('discovered_via')->orWhere('discovered_via', '!=', 'own'))->get()
            ->reject(fn ($c) => in_array($keyOf($c), $selfIds, true));
        $eligible = fn ($c) => (bool) $c->active && ($allowedClientIds === null || in_array($c->id, $allowedClientIds));
        $clients = $all->filter($eligible);
        if ($clients->isEmpty()) {
            return $none;
        }
        $byKey = $all->groupBy($keyOf); // azonos azonosítójú több ügyfél: nem egyértelmű

        $match = function (string $source) use ($byKey, $selfIds): array {
            $hits = [];
            $ambiguous = false;
            foreach (array_diff(self::identifiers($source), $selfIds) as $id) {
                if (! isset($byKey[$id])) {
                    continue;
                }
                if ($byKey[$id]->count() > 1) {
                    $ambiguous = true;

                    continue;
                }
                $hits[$byKey[$id][0]->id] = [$byKey[$id][0], strlen($id) === 10 ? 'adóazonosító jel a levél leírásában (…'.substr($id, -3).')' : "adószám a levél leírásában ($id)"];
            }

            return [$hits, $ambiguous];
        };

        [$hits, $ambiguous] = $match($text);
        if ($ambiguous || count($hits) > 1) {
            return $none; // több ügyfélre is illik: nem döntünk, és javaslatot sem teszünk
        }
        if (count($hits) === 1) {
            [$client, $basis] = array_values($hits)[0];

            return $eligible($client) ? ['client' => $client, 'basis' => $basis, 'suggest' => null] : $none;
        }
        // Javaslat: azonosító a címzett mezőben, vagy névegyezés (egész kifejezés, legalább 6 karakter) – pontosan egy ügyfélre.
        [$rHits, $rAmbiguous] = $match($recipient);
        if ($rAmbiguous || count($rHits) > 1) {
            return $none;
        }
        if (count($rHits) === 1) {
            $c = array_values($rHits)[0][0];

            return ['client' => null, 'basis' => null, 'suggest' => $eligible($c) ? $c : null];
        }
        $hay = ' '.Taxonomy::norm("$text $recipient").' ';
        $named = $clients->filter(function ($c) use ($hay) {
            $n = Taxonomy::norm((string) $c->name);

            return strlen($n) >= 6 && str_contains($hay, " $n ");
        })->values();

        return ['client' => null, 'basis' => null, 'suggest' => $named->count() === 1 ? $named[0] : null];
    }

    /**
     * A gyűjtőben lévő, ember által még nem érintett iratra: besorol vagy javaslatot rögzít. Igaz, ha besorolta.
     */
    public static function route(object $message, object $collector, string $text, string $recipient, ?object $actor): bool
    {
        if ($message->route_manual ?? false) {
            return false;
        }
        if (($message->folder ?? null) === 'ELKULDOTT') {
            // Kimenő küldeménynél a címzett a hatóság (pl. NAV), soha nem az ügyfél: abból javaslat sem készülhet.
            $recipient = '';
        }
        $portal = $collector->portal_connection_id ? DB::table('portal_connections')->find($collector->portal_connection_id) : null;
        $owner = $portal && $portal->owner_user_id ? DB::table('users')->find($portal->owner_user_id) : null;
        if (! $owner) {
            return false; // gazda nélkül nem tudjuk, kit láthatna: nem sorolunk
        }
        $self = $portal->self_identifiers ? (json_decode($portal->self_identifiers, true) ?: []) : [];
        $d = self::decide((int) $message->office_id, $text, $recipient, Scope::clientIds($owner), array_map('strval', $self));
        if ($d['client']) {
            $upd = ['client_id' => $d['client']->id, 'routed_from_client_id' => $collector->id, 'route_basis' => $d['basis'], 'route_suggest_client_id' => null, 'updated_at' => now()];
            if ($message->assignee_id && ! Scope::userSeesClient((int) $message->assignee_id, (int) $d['client']->id)) {
                $upd['assignee_id'] = null;
            }
            DB::table('messages')->where('id', $message->id)->update($upd);
            Audit::log($message->office_id, $actor, "Irat automatikusan ügyfélhez sorolva a saját tárhelyről: {$d['client']->name}", [
                'client_id' => $d['client']->id, 'message_id' => $message->id, 'evidence' => $d['basis'], 'policy' => 'csak azonosító alapján; névegyezés nem elég',
            ]);

            return true;
        }
        DB::table('messages')->where('id', $message->id)->update(['route_suggest_client_id' => $d['suggest']->id ?? null]);

        return false;
    }
}
