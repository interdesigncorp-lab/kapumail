<?php

namespace App\Mcp\Tools;

use App\Iratkapu\Scope;
use App\Mcp\McpData;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[IsReadOnly]
class GetMessage extends IratkapuTool
{
    protected string $name = 'get_message';

    protected string $description = 'Egy irat részletei: állapotok, határidő és forrása, a hozzá tartozó dokumentumok (ES3-csomagnál a kibontott fájlok is, aláírás-ellenőrzéssel), teendők, jegyzetek, ügyfélértesítések és az irat naplója. A dokumentumok szövegét a get_document_text adja.';

    public function schema(JsonSchema $schema): array
    {
        return [
            'message_id' => $schema->integer()->description('Az irat azonosítója (list_messages vagy search_documents adja).')->required(),
        ];
    }

    protected function run(Request $request, User $user): array
    {
        $m = Scope::message($user, (int) $request->get('message_id'));
        $ini = McpData::initials($user->office_id);
        $cids = Scope::clientIds($user);
        $names = [$m->client_id => DB::table('clients')->where('id', $m->client_id)->value('name')];

        $pairedReceipt = null;
        if (! empty($m->filing_receipt_id)) {
            $pr = DB::table('messages')->where('office_id', $user->office_id)->whereIn('client_id', $cids)->find((int) $m->filing_receipt_id);
            if ($pr) {
                $pairedReceipt = ['id' => (int) $pr->id, 'subject' => $pr->subject, 'folder' => $pr->folder ?? 'BEERKEZETT', 'arrived_at' => substr((string) $pr->arrived_at, 0, 16)];
            }
        }
        $pairedSubmission = null;
        if (($m->folder ?? 'BEERKEZETT') !== 'ELKULDOTT') {
            $ps = DB::table('messages')->where('office_id', $user->office_id)->whereIn('client_id', $cids)->where('folder', 'ELKULDOTT')->where('filing_receipt_id', $m->id)->first();
            if ($ps) {
                $pairedSubmission = ['id' => (int) $ps->id, 'subject' => $ps->subject, 'folder' => 'ELKULDOTT', 'filing_status' => $ps->filing_status, 'arrived_at' => substr((string) $ps->arrived_at, 0, 16)];
            }
        }

        return McpData::message($m, $ini, $names) + [
            'paired_receipt' => $pairedReceipt,
            'paired_submission' => $pairedSubmission,
            'deadline_excerpt' => $m->deadline_excerpt,
            'documents' => DB::table('documents')->where('message_id', $m->id)->orderBy('id')->get()->map(fn ($d) => ['id' => $d->id, 'parent_id' => $d->parent_id,
                'name' => $d->name, 'mime' => $d->mime, 'size' => $d->size, 'sha256' => $d->sha256, 'unpacked' => $d->parse_state, 'validity' => $d->validity,
                'validity_note' => $d->validity_note, 'has_text' => $d->text !== null])->values(),
            'tasks' => DB::table('tasks')->where('message_id', $m->id)->orderBy('id')->get()->map(fn ($t) => ['id' => $t->id, 'title' => $t->title, 'who' => $ini[$t->user_id] ?? null, 'done' => (bool) $t->done])->values(),
            'notes' => DB::table('notes')->where('message_id', $m->id)->orderBy('id')->get()->map(fn ($n) => ['who' => $ini[$n->user_id] ?? null, 'text' => $n->body, 'at' => $n->created_at])->values(),
            'client_notices' => DB::table('client_notices')->where('message_id', $m->id)->orderByDesc('id')->get()->map(fn ($n) => ['to' => $n->to_name, 'status' => $n->status, 'sent_at' => $n->sent_at, 'subject' => $n->subject])->values(),
            'log' => DB::table('audit_events')->where('message_id', $m->id)->orderByDesc('id')->limit(30)->get()->map(fn ($a) => ['at_utc' => $a->at_utc, 'who' => $a->actor_label, 'what' => $a->action])->values(),
        ];
    }
}
