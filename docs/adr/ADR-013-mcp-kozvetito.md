# ADR-013: MCP-közvetítő a ChatGPT-hez és a claude.ai-hoz helyi módban

**Dátum:** 2026-11-13 · **Állapot:** elfogadva (a tulajdonos jóváhagyta a tervet), élesítésre vár · **Előzmény:** [ADR-012](ADR-012-mcp-ai-kapcsolat.md)

## Probléma

A ChatGPT és a claude.ai connectorait a szolgáltató a saját szervereiről hívja, ezért csak nyilvános HTTPS-címet érnek el. A KapuMail felhasználói helyi módban dolgoznak: a program és az adatok a saját gépükön vannak, a helyi szerver a `127.0.0.1` címen fut, kívülről nem látszik. Szerver módot ezért nem akarunk rájuk kényszeríteni.

## Döntés

Egy kis közvetítőt üzemeltetünk (`https://mcp.kapumail.hu`, a saját DigitalOcean-szerverünkön, Caddy mögött).

1. **Kapcsolat.** Az asztali app **kifelé** kapcsolódik hozzá, long-pollal (`/tunnel/<id>/next`), és visszaküldi a válaszokat (`/tunnel/<id>/respond/<rid>`). Befelé semmi nem nyílik, routert sem kell állítani.
2. **Cím.** Minden telepítés saját, véletlen azonosítót kap. A connector címe `https://mcp.kapumail.hu/<id>/mcp`. Az OAuth metaadat-címeit a közvetítő fordítja (RFC 8414 / RFC 9728 útvonal-beszúrás).
3. **Nyilvános cím a programban.** A helyi program a közvetített kérésnél a nyilvános címmel számol (`RelayGuard`: `forceRootUrl`, az átirányítások fordítása, kapcsolatonkénti `Secure` süti).
4. **Belépés jelszó nélkül.** A helyi fióknak nincs jelszava, ezért az OAuth-engedélyezés egy **csatlakozási kóddal** történik. Az admin a programban kéri; 8 jegyű, 10 percig érvényes, egyszer használható, 5 rossz próba után érvénytelen. A kód kérésekor választja ki a szintet („Csak olvas” / „Dolgozhat is”).

## Védelem

- **Engedélylista három helyen** (közvetítő, asztali továbbító, Laravel `RelayGuard`). Átmegy az `/mcp`, az OAuth-végpontok és a párosító oldal. A felület, az `/api/*`, a `/local/enter` és a dokumentumletöltés közvetítve tiltott.
- **A 127.0.0.1-ről érkező kérésben a program nem bízhat meg vakon.** A közvetített kérés is innen jön, a helyi belépés pedig a visszacsatolási címben bízik. Ezért a közvetítő fejlécét (`X-KapuMail-Relay-Base`) a közvetítő kívülről eldobja, csak az asztali app teheti rá, és a Laravel ennek alapján szűr.
- **A közvetítő titka a titoktárban van** (`kapu:local:relay`), a közvetítő csak a hash-ét tárolja.
- **Korlátok:** 5 MB, percenként 60 kérés, egyszerre 8 kérés, IP-nként óránként 5 regisztráció.
- **Napló:** csak darabszámot és állapotkódot tartalmaz, törzset nem.
- **Alapból ki van kapcsolva,** és csak helyi módban él (Beállítások → AI-kapcsolat).

## Amit tudni kell (adatvédelem)

- **A forgalom áthalad a közvetítőn.** A TLS a mi szerverünkön végződik, így a közvetítőn átmenő kérések és válaszok ott nyílt szövegként haladnak át, tárolás nélkül.
- **A KapuMail ezzel továbbító szereplő lesz** az ügyfél és az AI-szolgáltató között. Ezt az ÁSZF-ben és az adatkezelési tájékoztatóban jelezni kell.
- **Az adatok a gépen maradnak.** Ha a program nem fut, a ChatGPT semmit nem ér el (503).

## Elvetett lehetőségek

- **Szerver mód kötelezővé tétele:** a felhasználók helyi módot választottak, az adatok ne kerüljenek szerverre.
- **WebSocket:** az asztali app Node-jában nincs beépített kliens, új függőség kellett volna. A long-poll proxyn és tűzfalon is átmegy.
- **Azonosítónkénti aldomain:** a szerver on-demand TLS-e a központi fiókszerverhez kötött, helyettesítő tanúsítványhoz pedig DNS-API kellene.
