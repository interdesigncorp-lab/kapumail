# ADR-012: AI-kapcsolat MCP-n át (Claude, ChatGPT)

**Dátum:** 2026-11-13 · **Állapot:** elfogadva (a tulajdonos jóváhagyta a tervet) · **Terv:** `~/.claude/plans/imperative-cuddling-orbit.md`

## Döntés

A program egy MCP-szervert ad (Model Context Protocol). Ezen keresztül egy AI-asszisztens olvashatja és – a megadott szinten – kezelheti az iroda adatait. A szerver a `laravel/mcp` csomagra épül, két belépéssel:

| Belépés | Kinek | Hitelesítés |
|---|---|---|
| `php artisan mcp:start iratkapu` (stdio) | helyi Claude Desktop, Claude Code | személyes MCP-token az `IRATKAPU_MCP_TOKEN` környezeti változóban |
| `POST /mcp` (Streamable HTTP) | Claude Code távolról; **ChatGPT- és claude.ai-connector** | személyes MCP-token (`Authorization: Bearer ik_…`) **vagy** OAuth 2.1 (`laravel/passport`, dinamikus kliensregisztrációval) |

A ChatGPT és a claude.ai csak nyilvános HTTPS-címet ér el, ezért náluk **csak a szerver mód** működik. Helyi módban a beállítóoldal csak a helyi Claude-útvonalat kínálja.

## Szintek

Minden token és minden OAuth-kliens egy felhasználóé, és szintet kap:

- **olvasás**: ügyfelek, iratok és szövegük, határidők, adónaptár, feladatok, napló, összeköttetések állapota, beállítások (titkok nélkül), súgó;
- **munka**: az előzőn felül feladat és jegyzet felvétele, irat belső állapota, felelőse, határidő-megerősítés;
- **admin**: az előzőn felül beállítások, SMTP, naptármeghívók, szabályok, munkatársak és ügyfélkezelők.

A szint nem lehet több, mint amit a felhasználó szerepköre a felületen megenged: az eszközök ugyanazokat a vezérlőmetódusokat hívják, mint a felület, a token gazdájának nevében. Ugyanaz a jogosultság-ellenőrzés fut (`Scope`, szerepkör), egy könyvelő az MCP-n át sem lát más ügyfelet.

## Amit az MCP nem csinál

- **Állami oldal felé nem indít semmit:** átvételt, letöltést, NAV- vagy ASP-lekérdezést, szinkront nem. Ezek joghatása vagy kockázata miatt (ADR-004, ADR-010) ember indítja őket a felületen.
- **Titkot nem ad ki:** portáljelszó, hitelesítőkód, SMTP-jelszó, tárolókulcs nem kerül válaszba.
- Kockázatos admin művelet (munkatárs felvétele, SMTP cseréje, szabály mentése) csak `confirm: true` mellett fut. Nélküle az eszköz előnézetet ad vissza.

## Naplózás és adatvédelem

Minden MCP-hívás bekerül a csak bővíthető auditnaplóba (`MCP: <eszköz>`, a token vagy kliens nevével). Az AI-szolgáltató a neki átadott adatok tekintetében **adatfeldolgozó**: bekapcsolás előtt adatfeldolgozói szerződés és adatvédelmi hatásvizsgálat (DPIA) kell. Az MCP alapból ki van kapcsolva, és csak admin kapcsolhatja be.
