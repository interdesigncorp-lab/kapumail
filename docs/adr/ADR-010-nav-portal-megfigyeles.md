# ADR-010: A NAV ügyfélportál megfigyelt felülete, és mit építünk rá

**Dátum:** 2026-11-13 · **Állapot:** megfigyelés rögzítve; az A kört a tulajdonos jóváhagyta és megépült (2026-11-13), a böngésző nélküli belépés élőben igazolt; a B és C kör döntésre vár · **Terv:** [TERV-7-FAZIS-NAV-PORTAL.md](../TERV-7-FAZIS-NAV-PORTAL.md)

## Hogyan készült

Egyetlen megfigyelés a tulajdonos fiókjával, a `megfigyelo:nav` eszközzel. A belépést a tulajdonos végezte (DÁP, QR-kóddal); a kattintásokat és a lekérdezések elindítását az asszisztens, a tulajdonos kifejezett jóváhagyásával. A program saját kérést nem küldött: csak azt jegyezte fel, amit a hivatalos felület maga forgalmazott. 254 kérés szerkezete került a jegyzőkönyvbe, érték nélkül (`research/kiserletek/kimenet/`, a gitből kizárva).

## Tények (egyszer megfigyelve)

| Tény | Megjegyzés |
|---|---|
| A portál gépneve `ugyfelportal.nav.gov.hu` | a kódban szereplő `upo.nav.gov.hu` nem ez |
| A belépés KAÜ-n át megy: `…/api/v1/user/login/start-kaulogin` → `kau.gov.hu/proxy/saml/…` | a megfigyelt belépés DÁP-os volt; az Ügyfélkapu+ kódos út ezen a portálon **nem megfigyelt** |
| A felület JSON-végpontokból dolgozik (`/api/…`, `/api/v1/…`) | idegen gépnévre nem ment kérés |
| A bejelentkezett felhasználó és a munkamenet hossza lekérhető: `GET /api/v1/user/login/logged-user` | mezők: név, adóazonosító jel, saját és kiválasztott adózói profil, `sessionLifeSpan` |
| **A képviselt adózók listája GET-tel jön:** `GET /api/v1/user/profil/adozoi-profil-page` (`megnevezes`, `page`, `size`) | lapozott (`content`, `total`); a tulajdonosnál két képviselt társaság |
| **A képviselet-váltás állapotot módosít:** `PUT /api/v1/user/login/change-kepviselet` (`adozoiProfilId`) | a munkamenet „kiválasztott adózóját" állítja át; a válasz az elérhető funkciók listája |
| Adószámla-összesítő GET-tel: `GET /api/v1/balance/tax-invoice/summary` | mezők: ügyfél összesen, tartozás, többlet, letétszámla, könyveletlen |
| Jövőbeli esedékességek GET-tel: `GET /api/v1/balance/tax-invoice/future-items` | |
| Tételes adószámla: `POST /api/v1/balance/tax-invoice` (időszak, típus, adónemek) → azonosító, majd `GET …/tax-invoice/last` | lekérdezést hoz létre a NAV oldalán |
| Hiányzó bevallások GET-tel: `GET /api/v1/declaration/missing-returns` (+ `/count`, `/returns-list`) | |
| Adónaptár GET-tel: `GET /api/v1/calendar/tax-calendar/posts` (`fromDate`, `toDate`, `lang`) | van `refreshPosts` kapcsolója is; azt nem használjuk |
| Törzsadatok GET-tel: `GET /api/v1/user/own-data/important` | magánszemély / egyéni vállalkozás / szervezet |
| Beadott bevallások: `POST /api/bevallas-lekerdezes` (időszakok, bevallásszám, adószám…) | szűrő a törzsben; olvasó lekérdezés |
| Dokumentumok: `POST /api/dokumentumok` | a sorokban KR érkeztetési szám, tárgy, irattípus, ügyszám, tárhelytípus – a tárhely leveleivel összeköthető |
| Képviseleti lekérdezés: `POST /api/v1/user/kepviselet/lekerdezes` → azonosító, majd `GET …/lekerdezes/<azonosító>` (lapozott) | van „eredmény tárhelyre küldése" beállítása; a megfigyeléskor kikapcsolva |
| Járulékadatok: `…/api/jarulek-adatok/adozoi-profilok/<id>/eredmenyek/…` | a lekérdezést nem indítottuk el (kötelező időszak) |
| **A felület böngészés közben maga is módosít:** `PUT …/notif/portal-uzenet/<id>/processed` (kétszer), `PUT …/user/profil/nyelv` | ezeket a hivatalos oldal küldte magától; a programnak ilyet nem szabad küldenie |

## Következtetések

1. **A legértékesebb adatok egyszerű GET-tel olvashatók:** képviselt adózók, adószámla-összesítő, jövőbeli esedékességek, hiányzó bevallások, adónaptár, törzsadatok. Ezekre épülhet közvetlen lekérés.
2. **A több ügyfeles működés a képviselet-váltáson múlik, és az módosító kérés.** Nem a NAV-nál tárolt adatot írja át, hanem a munkamenet kiválasztott adózóját; a váltás nélkül viszont csak a belépő saját adatai látszanak. Ezt külön döntésként kell engedélyezni.
3. **A tételes lekérdezések (bevallások, dokumentumok, tételes adószámla, képviseleti lista) POST-tal mennek.** Olvasnak, de a NAV oldalán lekérdezést hoznak létre; ezek a második körbe kerülnek.
4. **A böngésző nélküli belépés nyitott kérdés.** A portál KAÜ-t használ, de az Ügyfélkapu+ kódos utat itt nem láttuk; a tárhelynél bevált lánc valószínűleg alkalmazható, igazolni kell.

## Javasolt sorrend (jóváhagyásra)

- **A kör – csak GET, a belépő saját nevében:** bejelentkezett felhasználó, képviselt adózók listája (ügyfél-ajánláshoz), adószámla-összesítő, hiányzó bevallások, adónaptár, törzsadat.
- **B kör – képviselet-váltással, ügyfelenként ugyanezek a GET-ek.** Feltétele a tulajdonos döntése a `change-kepviselet` kérésről, és egy védelem: a program minden futás végén visszavált a saját profilra.
- **C kör – POST-os olvasó lekérdezések:** beadott bevallások és dokumentumok (a tárhely leveleivel összekötve).
- **Nem építjük meg:** portálüzenet feldolgozottá tétele, nyelvváltás, kérelem benyújtása, befizetés, időpontfoglalás, képviselet bejelentése, „eredmény tárhelyre küldése".

## Kiegészítés (2026-11-13): az adónaptár tételes olvasása

Az A kör olvasója tételesen is olvassa az adónaptárat (`GET …/tax-calendar/posts`, `refreshPosts=false`; tartalék: `…/posts/preview`) és a hiányzó bevallásokat, és a `POST /api/nav/ingest` végponton át a kötelezettség-tárolóba menti. A megfigyeléskor mindkét lista üres volt, ezért a tételek mezőnevei nem ismertek: az átalakító védekező (`desktop/nav-calendar.js`), az élőben ellenőrizendő pontok a [docs/ALLAPOT.md](../ALLAPOT.md) 2026-11-13-i bejegyzésében vannak. A megfigyelt forgalomban az előnézet külön címen jött (`…/posts/preview`), `hasGeneratedBefore` és `shouldSync` mezővel.

## Kiegészítés (2026-11-13): a B kör megépült a szimulátoron – alapból kikapcsolva

A tulajdonos kérte a hiányzó, ügyfelenkénti részek megépítését. A képviselet-váltás az ADR 3. alapelve szerint épült meg: **szimulátoron, alapból kikapcsolva**; az élő bekapcsolás külön tulajdonosi döntés (`IRATKAPU_NAV_SWITCH=true` a szerver `.env` fájljában).

- **Kire vált:** a szerver adja meg (`GET /api/nav/targets`), és csak akkor, ha a kapcsoló be van kapcsolva: az irodában ügyfélként felvett, aktív, érvényes meghatalmazású, a belépő gazdája által látott adózókra, akiket ma még nem olvastunk ki; futásonként legfeljebb 15-re. Az asztali app ezek közül is csak arra vált, akit a NAV a belépő képviselt adózói között felsorol.
- **Hogyan:** adózónként `PUT …/change-kepviselet` → a bejelentkezett felhasználó újbóli lekérése → **csak akkor olvas, ha a NAV maga is ezt az adózót mutatja kiválasztottnak** (azonosító és adószám-törzs egyezik) → ugyanazok a GET-ek, mint az A körben (adószámla-összesítő, jövőbeli esedékességek, hiányzó bevallások, adónaptár).
- **Védelem:** a futás végén – hiba esetén is – visszavált a belépő saját profiljára, és ezt ellenőrzi. Ha a visszaváltás nem igazolható, a felület figyelmeztet, és a szerver auditnaplójába is bekerül.
- **Hová kerül:** az adószámla pillanatképe ügyfelenként (`nav_client_snapshots`), az adónaptár és a hiányzó bevallások a meglévő kötelezettség-tárolóba, az ügyfélhez. Ügyfél a váltásból nem jön létre; ismeretlen, inaktív vagy nem látott adózó adatát a szerver eldobja.

**Élőben igazolva (2026-11-13, a tulajdonos fiókjával, egy képviselt társasággal):** a NAV elfogadja a program által küldött váltó kérést; a váltás, az olvasás és a visszaváltás ellenőrzéssel együtt lefutott.

**Az építéskor még nem volt igazolt, azóta részben igen:** a váltó kérés a program által küldve (a megfigyelés a fejléceket nem rögzítette – nem tudjuk, kell-e hozzá külön token; a program a munkamenet `XSRF-TOKEN` sütijét, ha van, fejlécben is elküldi); a NAV válasza elutasított váltásra; a váltás utáni adatvégpontok viselkedése képviselt adózónál. A tulajdonos fiókjával ez két társaságon próbálható ki.

## Kiegészítés (2026-11-13): a C kör első fele – beadott bevallások – megépült a szimulátoron, alapból kikapcsolva

- **Kapcsoló:** `IRATKAPU_NAV_QUERIES` (alapból ki). A lekérdezés olvas, de POST-tal megy, és a NAV oldalán lekérdezést hoz létre – ezért külön tulajdonosi döntés.
- **Kérés:** `POST /api/bevallas-lekerdezes`, a megfigyelt törzzsel: minden szűrő üres, csak az adózó azonosítója (adószám-törzs vagy adóazonosító jel) és a nyelv megy. A program csak a munkamenet kiválasztott adózójára kérdez: saját néven a belépőre, bekapcsolt képviselet-váltásnál ügyfelenként az éppen kiválasztott ügyfélre.
- **Tárolás és párosítás:** a beadott bevallások ügyfelenként tárolódnak (`nav_returns`: nyomtatvány, megnevezés, időszak, beadás ideje, állapot, iktatószám). A tárhelyi nyugtával az **iktatószám = az irat vonalkódja** egyezés köti össze; az ügyfél adatlapján látszik, melyik bevallásnak nincs nyugtája az iratok között.
- **Ami a nyilvános felületkódból látszik, de nem építettük be:** a bevallások letöltése (`POST /api/bevallas-lekerdezes/letoltes`) és a dokumentumok lekérdezése (`POST /api/dokumentumok`). A dokumentum-lekérdezés kérésében a „beküldés iránya” mező értékkészletét a megfigyelés nem rögzítette (csak az alakját), ezért a kérést nem tudjuk találgatás nélkül összeállítani.

**Élőben igazolva (2026-11-13):** a NAV elfogadja a program által küldött lekérdezést; egy képviselt társaságra 190 sor jött, mind értelmezhető alakban. **Az „iktatószám = vonalkód” feltevés élő adaton nem állt meg** (a letöltött nyugtáknak nincs vonalkódjuk); a párosítás ezért a nyugta tárgyában lévő nyomtatványkódra és időszakra is támaszkodik – ez gyengébb, a felület jelzi.

**Az építéskor még nem volt igazolt:** a lekérdezés a program által küldve; a válasz mezőinek tényleges értékkészlete (a megfigyelés csak alakot rögzített); nagy listák; az, hogy az iktatószám valóban megegyezik-e a tárhelyi nyugta vonalkódjával (a demó adatok alapján feltételezzük).

## Kiegészítés (2026-11-13): NAV-dokumentumok és letölthető kimutatások

- **Dokumentumok:** `POST /api/dokumentumok`; a „beküldés iránya” értékkészlete és a dátumalak a nyilvános felületkódból. A program `MINDEN_IRANY`-t küld (a forgalomban csak `BEFOGADOTT` látszott). Élőben nem igazolt.
- **Kimutatások** (második megfigyelés, 2026-11-13): adószámla `POST /api/v1/balance/tax-invoice` → `GET …/tax-invoice/last` (állapot és eredmény-azonosító) → `GET …/tax-invoice/export` (`lekerdezesEredmenyId`, `riportTipus`, `hitelesitett`, `tipus`, `lang`); törzsadat `GET /api/v1/user/own-data/export` (`riportTipus`, `adozoTipus`, `hitelesitett`, `tipus`, `lang`); biztosítottak `POST /api/foglalkoztato-lekerdezesek/biztositotti-fajlba` → `GET …/adozoi-profilok/<id>/eredmenyek/utolso` → `GET …/biztositotti-fajlba/export`. A paraméterértékek a nyilvános felületkódból. **Élőben igazolva** a képviselt társaságra: az adószámla (hitelesített PDF, XLSX) és a törzsadat (PDF); a biztosítotti lekérdezésre a NAV 403-at adott.
- Mindkettő kapcsoló mögött (`IRATKAPU_NAV_QUERIES`, `IRATKAPU_NAV_EXPORTS`), alapból kikapcsolva; a kimutatások csak kérésre, ügyfelenként futnak.

## Kiegészítés (2026-11-13): az adónaptár generálása

A tulajdonos kérésére egy újabb megfigyelés (a képviselt társaságra váltva) tisztázta, miért adott üres adónaptárat a portál. A kezdőlap szerint az adózónak „még nem” volt adónaptára. A szöveg szerint ezt a NAV a saját nyilvántartásából tölti fel, a bevallási kötelezettségek alapján. Gombot nem kellett megnyomni: az Adónaptár oldal megnyitásakor a felület a `GET /api/v1/calendar/tax-calendar/posts` kérést `refreshPosts` kapcsolóval küldte. Erre a válasz `systemPostsChanged: true` lett, és 3 tétel érkezett. Kérdőív, nyilatkozat vagy értesítés-beállítás nem volt; az értesítések kikapcsolva maradtak.

**Döntés:** a program a teljes naptár kérését `refreshPosts=true` értékkel küldi, ahogy a hivatalos felület. Ez nem bevallás és nem bejelentés. A NAV így a saját adataiból generálja a naptárbejegyzéseket, joghatás nélkül. Értesítést a program nem kapcsol be, saját bejegyzést nem hoz létre.

**A tételek megfigyelt alakja:** `id`, `type`, `conditional` (a NAV sárga, feltételes jelölése), `deadline` (UTC időpont, a magyar éjfél előző nap 23:00 Z), `title`, `note`, `declarationNumber` (nyomtatványkód), `portalIdentifier`, `priority.completed`. A feltételes tétel a meglévő modellben „feltételes” állapotú. Az előnézet (`posts/preview`) a generálás után is üres maradt, ezért a 30 napos darabszám a teljes listából számolódik.

**Élőben, 2026-11-13:** a társaságra 5 jövőbeli tétel jött (2665, 2608, 26A60 feltételesként), és megjelentek a Határidők naptárban.

## Kiegészítés (2026-11-16): C kör – Adózói táblák élő olvasása (Biztosítottak, Saját foglalkoztatók, EFO, Adategyeztetések)

A NAV Ügyfélportál nyilvános felületkódjából azonosított REST-végpontok bekerültek a `desktop/nav-taxpayer-tables.js` modulba (`IRATKAPU_NAV_QUERIES` mögött, saját profilra és bekapcsolt `IRATKAPU_NAV_SWITCH` mellett képviselt ügyfelekre is):

- **Jogosultsági előellenőrzés (403-védelem):** a POST lekérdezések előtt a program lekéri a `GET /api/foglalkoztatas-lekerdezesek/adozoi-profilok/<id>/biztositasi-tipusok` végpontot `kategoria=FOGLALKOZTATO`, illetve (nem szervezeti profilnál) `kategoria=FOGLALKOZTATAS` paraméterrel. Ha az adott típus (`BIZTOSITAS`, `EGYSZERUSITETT`) nem szerepel az engedélyezett listában, a program nem indít POST lekérdezést (elkerülve a korábban megfigyelt HTTP 403 választ), hanem üres listát ad vissza.
- **Biztosítottak (`nav_insured_persons`):** `POST /api/foglalkoztato-lekerdezesek/biztositotti-fajlba` → `GET /api/foglalkoztato-lekerdezesek/adozoi-profilok/<id>/eredmenyek/utolso` (JSON sorok kiolvasása; ha az eredmény csak fájlként érhető el, visszaesés `GET /api/foglalkoztato-lekerdezesek/biztositotti-fajlba/export` XLSX olvasásra a szerveren).
- **Saját foglalkoztatók (`nav_employers`):** szervezeti profiloknál (`SZERVEZET`) kihagyva; magánszemély / egyéni vállalkozó profilnál `POST /api/foglalkoztatas-lekerdezesek/biztositotti-fajlba` → `GET /api/foglalkoztatas-lekerdezesek/adozoi-profilok/<id>/eredmenyek/utolso` (szükség esetén `.../export` XLSX visszaeséssel).
- **Egyszerűsített foglalkoztatottak (`nav_efo_declarations`, `nav_efo_quotas`):** gyors GET előellenőrzés a hivatalos szűrő erőforrás-végpontján (`GET /api/foglalkoztatas-lekerdezesek/adozoi-profilok/<id>/munkavallalok?biztositottiTipus=EGYSZERUSITETT`) — ha `munkavallalok` üres, POST lekérdezés nélkül azonnal `[]` adódik vissza; ha van EFO-s munkavállaló, `POST /api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett/` (`adozoiProfilId` + `lang: 'hu'` kötelező mezőkkel) + `GET .../last` lekérdezés a bejelentésekhez, valamint `egyszerusitett-korabban-bejelentett/` + `.../last` és `egyszerusitett-adozo-adatai/` + `.../last` az összevont éves napkerethez.
- **Adategyeztetések (`nav_reconciliations`):** `GET /api/v1/dialog/survey-from-joker/list` (`runningSurveys` + `closedSurveys`).
- **Tárolás és izoláció:** szekciónként izolált hibakezelés (egy végpont hibája nem állítja meg a többit; csak a HTTP 401 / 3xx munkamenet-lejárat szakítja meg a ciklust). Sikeres üres válasz (`[]`) törli a korábbi `nav_upo` / `demo` sorokat az adott ügyfélnél, míg részleges hiba (`null`) érintetlenül hagyja a korábbi pillanatképet.
- **Élőben igazolva (2026-11-16):** a *Biztosítottak*, a *Saját foglalkoztatók* és az *Adategyeztetések* élő NAV ÜPO szinkronja saját profilra és képviselt társaságra is sikeresen lefutott; az EFO-végpontok a hiányzó `adozoiProfilId` + `lang` mező és a `munkavallalok` GET előellenőrzés pótlásával javítva.

## Korlátok

Egyetlen megfigyelés, egy fiók, DÁP-os belépés. A lapozás nagy listán, a hibaválaszok, a munkamenet lejárata és a terhelési korlátok nem ismertek. A mezők jelentését a nevükből következtetjük; értéket a jegyzőkönyv nem tartalmaz, ezért az egységek és a kódkészletek az építéskor, élő válaszon ellenőrizendők.
