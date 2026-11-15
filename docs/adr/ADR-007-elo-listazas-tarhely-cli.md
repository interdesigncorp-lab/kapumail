# ADR-007: Élő listázás a tarhely-cli-vel

Állapot: **felváltotta az [ADR-008](ADR-008-http-alapu-tarhely-hivasok.md)** · 2026-11-12. A tarhely-cli út a felületről már nem érhető el. Az itt leírt két szabályt (minden élő belépés előtt megerősítés; csak a könyvelő saját azonosítója) az ADR-006 és az ADR-008 tulajdonosi döntése írta felül.
Eredeti állapot: megvalósítva, alapból kikapcsolva; élő tárhelyen nincs kipróbálva · 2026-11-11
Előzmény: [ADR-002](ADR-002-tarhely-csatlakozo.md), [ADR-004](ADR-004-joghatas-kapuk.md), [ADR-006](ADR-006-titokkezeles.md)

A megrendelő kérésére az alkalmazás megkapta az élő tárhelykapcsolat első, szűk szeletét: a levelek **listázását**.

## Mit csinál

1. A felhasználó a saját gépén telepíti a [godavid/tarhely-cli](https://github.com/godavid/tarhely-cli) eszközt (MIT), és a **saját termináljában** futtatja az `init` parancsot. A belépő a rendszer kulcstartójába kerül; az Iratkapu soha nem látja és nem kéri be.
2. Az asztali appban (Beállítások → Élő tárhely-csatlakozó) natív fájlválasztóval kijelöli a `dist/cli.js` fájlt.
3. „Postafiókok lekérése”: az app meghívja a `mailboxes --json` parancsot, majd a kapott postafiókokat hozzá lehet rendelni az ügyfelek tárhelyeihez.
4. „Élő listázás most”: az app meghívja a `list --json` parancsot, és a levelek metaadatát (érkeztetési szám, postafiók, feladó, típus, leírás, érkezés ideje) elküldi a szervernek.
5. A szerver idempotensen felveszi az új leveleket, a taxonómiával besorolja, a szabályokat lefuttatja.

## Mit nem csinál – szándékosan

| Nem | Miért |
|---|---|
| Letöltés, megnyitás, átvétel | A `tarhely-cli` `download` parancsa minden új levelet visz; egy megnevezett levél letöltését nem tudja. A letöltés joghatása tisztázatlan (R01, R03). Az asztali csatlakozóban ehhez nincs kód, és nincs hozzá IPC-csatorna. |
| Tartós tár, küldés, törlés | Tiltott ([ADR-004](ADR-004-joghatas-kapuk.md)) |
| Ütemezett, felügyelet nélküli élő listázás | Minden élő belépést natív megerősítő ablak előz meg (10 percig érvényes); a szerver rendszertől nem fogad el élő listázást |
| Belépési adat kezelése | A `tarhely-cli` olvassa a kulcstartóból; az Iratkapu felülete, szervere és naplója nem találkozik vele |
| DÁP-belépés | A `tarhely-cli` csak Ügyfélkapu+ belépést (felhasználónév, jelszó, TOTP) ismer – lásd lent |

## A hivatalos állapot: „nem ismert”

A `tarhely-cli` levéllistája nem tartalmazza, hogy egy iratot átvettek-e már. Ezért az élő listából érkezett irat hivatalos állapota **„Átvétel állapota nem ismert”** (`listed`), nem „Átvételre vár” és nem „Átvett”. Ilyen iratra az alkalmazásból nem kérhető átvétel; a felület a hivatalos tárhelyre irányít, és a kézzel letöltött fájl feltölthető archiválásra.

## Kapuk

| Kapu | Hol érvényesül |
|---|---|
| Szerveroldali főkapcsoló: `IRATKAPU_LIVE_LISTING` (alapból `false`) | `ConnectorGuard::authorizeLiveListing` |
| Csak ember indíthatja | ugyanott; rendszer-hívás elutasítva |
| Érvényes meghatalmazás | ugyanott |
| Csak hozzárendelt postafiók levele vehető fel | `liveIngest` – a többi „hozzárendelés nélküli”-ként számolódik |
| Csak vezető vagy admin rendelhet hozzá postafiókot | `mapLive` |
| Natív megerősítés minden élő belépés előtt | `desktop/main.js`, a betöltött weboldal nem tudja megkerülni |
| Csak `doctor`, `mailboxes`, `list` futtatható | `desktop/connector.js`, fehérlista; shell nincs |
| A CLI helyét csak a felhasználó választhatja ki | natív fájlválasztó + ellenőrzés, hogy valóban a `tarhely-cli` csomag |

Tesztek: `desktop/test/connector.test.js` (5), `app/tests/Feature/KapukTest.php` → `test_elo_lista_fogadasa_…`.

## Amit a bekapcsolás előtt tudni kell

- **A listázás joghatása nincs bizonyítva** ([R03](../../research/R03-jogi-kezbesitesi-muveleti-matrix.md)). A főkapcsoló bekapcsolása tulajdonosi döntés és felelősség.
- **Élő tárhelyen nincs kipróbálva.** A csatlakozó egy ál-CLI-vel van tesztelve, amely a valódi `--json` kimenet alakját utánozza. Az első élő futás lehet, hogy eltérést talál.
- A `tarhely-cli`-nek nincs kiadott csomagja; forrásból kell telepíteni, a vizsgált commit: `f9fbddd0af0aebb9aa1bcb06eb014ffd2f7bf347`. A portál változása eltörheti (4-es kilépési kód).
- A könyvelő a **saját** Ügyfélkapu+ azonosítójával lép be, és azokat a postafiókokat látja, amelyekhez neki van jogosultsága (saját tárhely, képviselt cégek). Ez a jogilag tisztább út; az ügyfél azonosítójával való belépést az alkalmazás nem támogatja.

## DÁP-belépés

**Nincs megvalósítva, és ebből a helyzetből nem is valósítható meg felelősen.**

- A `tarhely-cli` nem tartalmaz DÁP-belépést.
- A DÁP mobilalkalmazásos jóváhagyásra (QR-kód vagy értesítés a telefonon) épül, vagyis emberi közreműködést igényel; felügyelet nélkül nem futtatható.
- A belépési folyamat megírásához élő portálon, valódi DÁP-fiókkal kellene lépésenként feltárni az oldalakat. Ezt csak a megrendelő tudja elvégezni a saját fiókjával.

Járható út, ha kell: látható böngészőablakban a felhasználó maga azonosítja magát DÁP-pal, és a csatlakozó csak a sikeres belépés után veszi át a munkamenetet a listázáshoz. Ez a `tarhely-cli` kiegészítését vagy saját adaptert igényel, és a megrendelő közreműködésével, élő fiókon fejleszthető.

## Következő lépések

1. A megrendelő a saját gépén telepíti a `tarhely-cli`-t, lefuttatja a `doctor` és az `init` parancsot.
2. Jogi válasz birtokában bekapcsolja a főkapcsolót, és elvégzi az első élő listázást; az eredményt és az esetleges eltérést jegyzőkönyvezzük.
3. Egy levél jóváhagyásos letöltése: csak a jogi kapu feloldása után, saját adapterrel.
