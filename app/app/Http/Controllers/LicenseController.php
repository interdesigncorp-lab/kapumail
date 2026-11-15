<?php

namespace App\Http\Controllers;

use App\Iratkapu\DocumentArchiveExport;
use App\Iratkapu\Scope;
use App\Iratkapu\TrialLicense;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;

class LicenseController extends Controller
{
    public function show()
    {
        $u = Auth::user();
        $office = DB::table('offices')->find($u->office_id);
        abort_if(! $office, 404);

        return TrialLicense::status($office);
    }

    public function activate(Request $r)
    {
        $u = Auth::user();
        abort_if(! Scope::seesAll($u), 403, 'Licenckulcsot csak vezető vagy adminisztrátor aktiválhat.');
        $data = $r->validate([
            'key' => 'required|string|max:2048',
        ]);
        $office = DB::table('offices')->find($u->office_id);
        abort_if(! $office, 404);

        return [
            'ok' => true,
            'license' => TrialLicense::activate($office, $u, (string) $data['key']),
        ];
    }

    public function deactivate()
    {
        $u = Auth::user();
        abort_if(! Scope::seesAll($u), 403, 'Licenckulcsot csak vezető vagy adminisztrátor távolíthat el.');
        $office = DB::table('offices')->find($u->office_id);
        abort_if(! $office, 404);

        return [
            'ok' => true,
            'license' => TrialLicense::deactivate($office, $u),
        ];
    }

    public function exportDocuments()
    {
        $u = Auth::user();

        return DocumentArchiveExport::download($u);
    }
}
