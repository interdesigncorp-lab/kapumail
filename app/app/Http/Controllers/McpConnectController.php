<?php

namespace App\Http\Controllers;

use App\Http\Middleware\RelayGuard;
use App\Mcp\McpAccess;
use App\Mcp\McpPairing;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

/**
 * Párosító oldal a közvetítőn át csatlakozó ChatGPT / claude.ai számára (ADR-013). A felhasználó a KapuMail
 * Beállítások → AI-kapcsolat lapján kér egy kódot, és ide írja be; ezzel ez a böngésző-munkamenet a kód gazdájaként
 * lép be, és folytatódik az OAuth-engedélyezés (mcp-authorize). Csak közvetített kérésre él.
 */
class McpConnectController extends Controller
{
    public function form(Request $r)
    {
        abort_unless(RelayGuard::isRelayed($r), 404);

        return view('mcp-connect', ['error' => null]);
    }

    public function submit(Request $r)
    {
        abort_unless(RelayGuard::isRelayed($r), 404);
        $code = (string) $r->validate(['code' => 'required|string|max:20'])['code'];
        $pairing = McpPairing::redeem($code);
        if (! $pairing) {
            return response()->view('mcp-connect', ['error' => 'A kód nem jó, lejárt vagy már fel lett használva. Kérj újat a KapuMail Beállítások → AI-kapcsolat lapján.'], 422);
        }
        $user = User::query()->find($pairing->user_id);
        abort_if(! $user || ! McpAccess::enabled((int) $user->office_id), 403, 'Az AI-kapcsolat ki van kapcsolva a KapuMailben.');
        Auth::login($user);
        $r->session()->regenerate();

        return redirect()->intended(url('/mcp-connect/kesz'));
    }

    public function done(Request $r)
    {
        abort_unless(RelayGuard::isRelayed($r), 404);

        return view('mcp-connect', ['error' => null, 'done' => true]);
    }
}
