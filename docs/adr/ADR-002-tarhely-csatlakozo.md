# ADR-002: Tárhely-csatlakozó – saját adapter, a tarhely-cli mintaként

Állapot: **javasolt** · 2026-11-11
Bizonyíték: [R01](../../research/R01-tarhely-cli-es-gitjog-audit.md)

## Tények (R01)

| Tény | Szint |
|---|---|
| Vizsgált commit: `f9fbddd0af0aebb9aa1bcb06eb014ffd2f7bf347` (2026-10-27), azóta nincs új | Forrásból |
| Licenc: MIT – zárt termékben használható a szerzői jogi megjegyzés megőrzésével | Forrásból |
| Node/TypeScript CLI, Playwright Chromium; belépés felhasználónév + jelszó + TOTP-kulcs; titkok OS-kulcstárban vagy környezeti változóban | Forrásból |
| A kliens csak keresés, részlet, letöltés és tárhely-részlet hívást használ; író végpontot nem hív | Forrásból |
| A hívások szerveroldali hatása (olvasottság, átvétel) | **NEM BIZONYÍTOTT** – élő futás nem volt |
| A szerző maga jelzi, hogy a letöltés jogi hatása nincs tisztázva | Forrásból |
| A letöltő parancs alapból minden új levelet visz minden tárhelyből | Forrásból |
| 14 commit, egy szerző, nincs kiadás, nincs stabil export, nincs támogatási vállalás | Forrásból |
| Windows és macOS működés | **NEM BIZONYÍTOTT** – a CI csak Ubuntu |

## Döntés

1. **Saját `TarhelyConnector` adapter** készül a [szerződés](../architektura.md#a-csatlakozó-szerződése) szerint. A `tarhely-cli` kódja mintaként és részben átvett forrásként szolgál (MIT, attribúcióval), nem közvetlen függőségként.
2. **Az MVP csatlakozója csak listáz.** A `listAccounts` és `listMessages` kerül be. A `getMetadata`, `getReceipt`, `download` és `moveToDurable` a kódban létezik, de `supported: false`, amíg a jogi és az élő technikai bizonyíték meg nem van.
3. **A `tarhely-cli` „minden újat letölt” viselkedése nem kerül át.** Letöltés csak egyetlen, megnevezett küldeményre, jóváhagyással indítható.
4. A fejlesztés ál-csatlakozóval (mock) halad; a felület és a szerver nem függ az élő csatlakozó elkészültétől.

## Miért nem közvetlen függőség vagy fork

| Opció | Előny | Hátrány |
|---|---|---|
| Közvetlen függőség | Leggyorsabb | Nincs kiadás, nincs stabil felület; a tömeges letöltés az alapviselkedés |
| Fork | Gyors prototípus | Egyfős upstream; a portál változását nekünk kell követni; a joghatás-kapu utólag nehezen építhető be |
| **Saját adapter** | A kapuk a szerkezet részei; tesztelhető szerződés | Több munka; a portál követése a mi feladatunk |

## Kapuk

| Kapu | Állapot | Mi oldja fel |
|---|---|---|
| A listázás nem vált ki átvételt | **NEM BIZONYÍTOTT** | Élő próba saját, erre kijelölt tárhelyen, az üzemeltetői/jogi válasszal együtt (ADR-004) |
| A részlet/metaadat lekérése nem vált ki átvételt | **NEM BIZONYÍTOTT** | Ugyanaz |
| Letöltés joghatása | **BLOKKOLT** automatikus használatra | Jogi állásfoglalás + élő próba |
| Tartós tárba helyezés | **BLOKKOLT** | A kliens nem hívja, a portál viselkedése ismeretlen |
| A gépi belépés megengedett-e a felhasználási feltételek szerint | Lásd ADR-004 | Jogi állásfoglalás |
| Windows/macOS működés | **NEM BIZONYÍTOTT** | E02 első feladata |

## GitJog (magyar-jog)

CC0, csak törvényeket tartalmaz (rendeleteket nem), és egy időállapot csak hatálybalépés után kerül be, mért medián késéssel 5 nap. Következtetés: **utólagos törvényváltozás-figyelésre használható, előrejelzésre és rendeletekre nem, és nem hiteles jogforrás.** MVP után, jelzőrendszerként; határidőszabály forrásaként nem.
