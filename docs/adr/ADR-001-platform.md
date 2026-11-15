# ADR-001: Platform – Laravel központ + Electron asztali kliens (Windows és macOS)

Állapot: **javasolt, tulajdonosi megerősítésre vár** · 2026-11-11
Bizonyíték: [R06 asztali keret összevetés](../../research/R06-asztali-keret-osszevetes.md), [R01 tarhely-cli audit](../../research/R01-tarhely-cli-es-gitjog-audit.md)

## Döntés

1. **Központi alkalmazás:** Laravel 12 + Inertia + React 19 + Tailwind 4, a hivatalos React starter kitből indítva. Sor: Horizon. Élő frissítés: Reverb. Jogosultság: spatie/laravel-permission + saját ügyfélszintű szűrés. Adatbázis: PostgreSQL.
2. **Asztali kliens:** vékony Electron-keret Windowsra és macOS-re, amely a szerverről tölti be ugyanazt a React-felületet, és helyben futtatja a tárhely-csatlakozót.
3. **Egy kódbázisú felület:** a böngészőben és az asztali kliensben ugyanaz fut. Böngészőben minden elérhető, ami nem igényel helyi csatlakozót (iratlista olvasása, feladatok, szabályok, audit); a tárhelyműveletek csak az asztali kliensből.

## Miért

| Szempont | Electron | Tauri 2 | NativePHP |
|---|---|---|---|
| Node + Playwright csatlakozó futtatása helyben | Natívan, a főfolyamat mellől | Külön Node-folyamatot kell mellécsomagolni | Külön Node-folyamat PHP-ból vezérelve |
| OS titoktár | `safeStorage`, kiforrott | Bővítményekkel | Közvetett |
| Aláírás, frissítés Windows + macOS | Kiforrott eszközlánc | Van, fiatalabb | Electronra épül |
| Méretelőny | – | A Chromium csatolása miatt elvész | – |
| A csapat tudása | JS/React megvan | Rust kellene | PHP megvan, de a csatlakozó Node |

A projekt ugyanezt a Laravel + Inertia + React alapot használja, így a csapat tudása és a meglévő minták (Fortify, Horizon, Sentry, spatie) újrahasznosíthatók. A `tarhely-cli` Node/TypeScript + Playwright, ezért a csatlakozóhoz Node-környezet kell a gépen – ezt Electron adja a legkevesebb illesztéssel.

## Elvetett lehetőségek

- **Tiszta webalkalmazás, szerveroldali csatlakozóval.** Az ügyfelek jelszavát és TOTP-kulcsát központilag kellene tárolni. Ez a termék legnagyobb biztonsági és jogi kockázata lenne; lásd [ADR-006](ADR-006-titokkezeles.md).
- **Csak asztali alkalmazás, központ nélkül.** Nincs közös feladatkezelés, jóváhagyás és megkerülhetetlen audit.
- **Tauri 2, NativePHP.** A fenti táblázat szerint.

## Következmények és kockázatok

| Kockázat | Kezelés |
|---|---|
| Szinkron csak futó asztali kliens mellett van | A felület mindenhol mutatja az utolsó sikeres szinkront; a lemaradás riasztás. Üzleti döntés, hogy ez elég-e. |
| Windows SmartScreen figyelmeztetés új aláíró tanúsítványnál | Kódaláírás az első kiadástól; a tanúsítvány típusa és az EU-s jogosultság ellenőrizendő (R06 szerint ellentmondó források) – **NEM BIZONYÍTOTT** |
| macOS-en notarizálás nélkül nincs automatikus frissítés | Apple Developer ID és notarizálás a kiadási folyamat része |
| Távoli felület Electronban | Szigorú elszigetelés, lásd [architektura.md](../architektura.md) „Biztonsági határok” |
| A Windows-méret és -memória nincs lemérve | E09-ben mérni |
| A `tarhely-cli` CI-ja csak Ubuntun fut | Windows/macOS működés **NEM BIZONYÍTOTT**; E02 első feladata |

## Eltérés a kipróbálható változatban

A 2026-11-11-i kipróbálható változat felülete egyetlen HTML + JavaScript fájl ([app/resources/ui/app.html](../../app/resources/ui/app.html)), amelyet a Laravel szolgál ki és amely a JSON API-t hívja. Ez a prototípusból nőtt ki, hogy minden funkció gyorsan kipróbálható legyen. Az Inertia + React átírás a backlog E03 tétele; a szerveroldali API és az őrfüggvény ettől független. Az adatbázis fejlesztéshez SQLite.

## Mit kell a tulajdonosnak megerősítenie

- Elfogadható-e, hogy felügyelet nélküli (éjszakai) szinkron nincs.
- A macOS az első kiadás része, vagy a Windows után következik. A felépítés mindkettőt támogatja; a különbség a kiadási és tesztelési munka.
