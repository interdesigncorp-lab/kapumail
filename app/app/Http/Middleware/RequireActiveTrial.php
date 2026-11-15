<?php

namespace App\Http\Middleware;

use App\Iratkapu\TrialLicense;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

/**
 * A hivatalos kiadásban a 14 napos próbaidőszak (vagy az előfizetés) lejárta után
 * megállítja az új külső szinkronizálási és letöltési műveleteket, miközben a már
 * letöltött dokumentumok megtekintése és exportálása korlátlanul elérhető marad.
 */
class RequireActiveTrial
{
    public function handle(Request $request, Closure $next): Response
    {
        if (! config('iratkapu.official_build', false)) {
            return $next($request);
        }

        $user = Auth::user();
        if (! $user) {
            return $next($request);
        }

        $office = DB::table('offices')->find($user->office_id);
        if ($office) {
            TrialLicense::requireActiveForSync($office);
        }

        return $next($request);
    }
}
