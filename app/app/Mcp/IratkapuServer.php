<?php

namespace App\Mcp;

use App\Mcp\Tools;
use Laravel\Mcp\Server;
use Laravel\Mcp\Server\Attributes\Instructions;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Attributes\Version;

/** Az Iratkapu / KapuMail MCP-szervere (ADR-012). */
#[Name('KapuMail iratkezelő')]
#[Version('1.0.0')]
#[Instructions(<<<'MD'
Ez egy magyar könyvelőiroda iratkezelő programja (KapuMail / Iratkapu). Az ügyfelek állami tárhelyeiről (Ügyfélkapu+, Cégkapu, Hivatali kapu) érkező iratokat, a NAV adónaptárt, bevallásokat és határidőket kezeli.

- Mindig magyarul válaszolj, és a felhasználó nevében, az ő jogosultságával dolgozol: csak azt látod, amit ő a felületen.
- Ha nem tudod, mire jó egy menü vagy gomb, hívd az `app_guide` eszközt.
- Ügyfél keresése: `search_clients`, adatlap: `get_client`. Iratok: `list_messages`, `get_message`; szöveg: `get_document_text` (PDF, XML, ES3 e-akta); keresés a szövegekben: `search_documents`.
- Határidők és naptár: `list_deadlines`. Összeköttetések állapota: `connections_status`.
- A módosító eszközök szintje a kapcsolattól függ (olvasás / munka / admin). A `confirm` mezős eszközöknél előbb mutasd meg a felhasználónak az előnézetet, és csak az ő kifejezett igenje után hívd újra `confirm: true`-val.
- Állami oldal felé (átvétel, letöltés, NAV-lekérdezés, szinkron) az MCP nem indít semmit; ezeket a felhasználó a programban végzi.
- A becsült (nem megerősített) határidőt mindig jelezd becsültként.
MD)]
class IratkapuServer extends Server
{
    protected array $tools = [
        Tools\AppGuide::class,
        Tools\ConnectionsStatus::class,
        Tools\GetSettings::class,
        Tools\ListUsers::class,
        Tools\SearchClients::class,
        Tools\GetClient::class,
        Tools\ListMessages::class,
        Tools\GetMessage::class,
        Tools\SearchDocuments::class,
        Tools\GetDocumentText::class,
        Tools\ListDeadlines::class,
        Tools\ListTasks::class,
        Tools\AuditLog::class,
        Tools\CreateTask::class,
        Tools\SetTaskDone::class,
        Tools\AddNote::class,
        Tools\UpdateMessage::class,
        Tools\UpdateSettings::class,
        Tools\ConfigureSmtp::class,
        Tools\ManageUsers::class,
        Tools\ManageClient::class,
        Tools\SaveRule::class,
    ];

    public int $maxPaginationLength = 50;

    public int $defaultPaginationLength = 50; // minden eszköz egy listában (egyes kliensek nem lapoznak)

    protected array $resources = [];

    protected array $prompts = [];
}
