<?php

namespace App\Http\Controllers;

use App\Iratkapu\Audit;
use App\Iratkapu\PremiumMcp;
use App\Mcp\KapuConfirm;
use App\Mcp\McpAccess;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

/** Kapu-chat (ADR-014): a felhasználó a saját nevére, `kapu` szintű MCP-tokent kér magának; admin jóváhagyás nélkül, mert a szint szűk. */
class KapuController extends Controller
{
    /** Az asztali app ebből tudja, kinek a helyi előzményeit és Kapu-tokenjét használja (a felület által küldött azonosítóban nem bízik). */
    public function me()
    {
        $u = Auth::user();

        return ['ok' => true, 'userId' => (int) $u->id, 'officeId' => (int) $u->office_id];
    }

    /**
     * A szakmai MCP (jogi és könyvelői eszközök) tokenje erre az eszközre: 200 a tokennel, vagy 204, és az ok
     * az `X-Kapu-Premium-Reason` fejlécben. Licenc nélkül a háttérben, kérdés nélkül indul a 14 napos próba.
     */
    public function premium(Request $r)
    {
        $device = $r->validate(['device' => 'required|uuid'])['device'];
        $u = Auth::user();
        $office = DB::table('offices')->where('id', $u->office_id)->first();
        $res = $office ? PremiumMcp::token($office, (int) $u->id, strtolower($device)) : null;
        if ($res === null) {
            return response()->noContent()->header('X-Kapu-Premium-Reason', PremiumMcp::lastReason() ?? 'unavailable')->header('Cache-Control', 'no-store');
        }

        return response()->json($res)->header('Cache-Control', 'no-store');
    }

    public function issue(Request $r)
    {
        $u = Auth::user();
        $device = trim((string) ($r->validate(['device' => 'nullable|string|max:200'])['device'] ?? ''));
        $name = 'Kapu – '.($device !== '' ? mb_substr($device, 0, 60) : 'ez a gép');
        // Ugyanarra a gépre egyszerre egy token él: az újabb a régit visszavonja (egy tranzakcióban, hogy ne maradjon két élő token).
        $t = DB::transaction(function () use ($u, $name) {
            DB::table('mcp_tokens')->where('user_id', $u->id)->where('level', 'kapu')->where('name', $name)->whereNull('revoked_at')
                ->update(['revoked_at' => now(), 'updated_at' => now()]);

            return McpAccess::issue($u, $name, 'kapu', null);
        });
        Audit::log($u->office_id, $u, "Kapu-token létrehozva: {$name}");

        return ['ok' => true, 'token' => $t['token'], 'userId' => (int) $u->id, 'officeId' => (int) $u->office_id];
    }

    /** A felhasználó összes Kapu-tokenjének visszavonása (a más szintű, kézzel kiadott tokenekhez nem nyúl). */
    public function revoke()
    {
        $u = Auth::user();
        $n = DB::table('mcp_tokens')->where('user_id', $u->id)->where('level', 'kapu')->whereNull('revoked_at')
            ->update(['revoked_at' => now(), 'updated_at' => now()]);
        Audit::log($u->office_id, $u, "Kapu-tokenek visszavonva ({$n} db)");

        return ['ok' => true];
    }

    /** A jóváhagyó kártya adatai: mi változna (régi → új), meddig érvényes, jóváhagyták-e már. Csak a kérés gazdájának. */
    public function confirmation(string $id)
    {
        return KapuConfirm::card(Auth::user(), $id);
    }

    /** A felhasználó jóváhagyja Kapu beállítás-módosítását; ezután Kapu ugyanazokkal az adatokkal és a confirm_id-val végrehajthatja. */
    public function approve(string $id)
    {
        return ['ok' => true] + KapuConfirm::approve(Auth::user(), $id);
    }
}
