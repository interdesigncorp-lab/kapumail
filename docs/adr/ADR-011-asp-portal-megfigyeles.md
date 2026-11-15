# ADR-011: Az E-Önkormányzat Portál (ASP) megfigyelt felülete, és mit építünk rá

**Dátum:** 2026-11-13 · **Állapot:** megfigyelés rögzítve; a javasolt körök jóváhagyásra várnak · **Terv:** [TERV-10-FAZIS-ASP-PORTAL.md](../TERV-10-FAZIS-ASP-PORTAL.md)

## Hogyan készült

Egyetlen megfigyelés a tulajdonos fiókjával, a `megfigyelo:asp` eszközzel. A belépést (DÁP, QR-kóddal) és a szerepkörváltást a tulajdonos végezte; a többi kattintást az asszisztens, a tulajdonos kérésére. A program saját kérést nem küldött: csak azt jegyezte fel, amit a hivatalos felület maga forgalmazott. 65 kérés szerkezete került a jegyzőkönyvbe, érték nélkül.

Végigkattintva: adóegyenleg (egyszerű és részletes) a saját névben az egyik önkormányzatnál; adóbevallások listája; ügykövetés; a saját önkormányzatok listája és egy második önkormányzat kiválasztása; szerepkörváltás egyéni vállalkozóra; adóegyenleg egyéni vállalkozóként a második önkormányzatnál.

## Tények (egyszer megfigyelve)

| Tény | Megjegyzés |
|---|---|
| A portál gépneve `ohp-20.asp.lgov.hu` | idegen gépnévre nem ment kérés; a `chatrobot.mia.gov.hu` a felület csevegőrobotja |
| A belépés KAÜ-n át megy: `GET /login` (SAML-kérés űrlapja) → `kau.gov.hu/proxy/saml/…` → vissza `POST /login` → `/successful-login` | a megfigyelt belépés DÁP-os volt; az Ügyfélkapu+ kódos út ezen a portálon **nem megfigyelt** |
| **A belépés után a portál titkosítatlan `http://ohp-20.asp.lgov.hu` címre irányít** | a böngészők maguktól `https`-re emelik; a mi láncunknak ezt kifejezetten kezelnie kell, titkosítatlan kérés nélkül |
| A felület JSON-végpontokból dolgozik (`/api/…`) | HTML-ből olvasni nem kell |
| A hívásokhoz külön fejléc (token) nem kellett | a süti elég; a kérésekben csak szokásos fejlécek voltak |
| Bejelentkezett felhasználó: `GET /api/public/userdetails` | mezők: név, adóazonosító, `favouriteTenants` (a saját önkormányzatok: azonosító, név, település, PIR, kód, szolgáltatások), `defaultTenant`, `roleDetails` (az aktuális szerepkör) |
| Mely szolgáltatások érhetők el: `GET /api/public/service-permissions` | kapcsolók: ügykövetés, adóegyenleg, ügyindítás, adófizetés, számlafizetés, befizetések, adóbevallás, mentett űrlapok |
| Egy önkormányzat szolgáltatásai: `GET /api/public/tenant-services/<azonosító>` | |
| **Adóegyenleg GET-tel:** `GET /api/tax/<típus>/<év>` (két típus: egyszerű, részletes) | **a válasz PDF** (`taxPdf` szövegmező, `status`, `statusMessage`); tételes, gépi egyenlegadat nem jött |
| **Adóbevallások listája GET-tel:** `GET /api/tax-returns` | tételenként: adónem kódja és neve, adótárgy azonosítója, bevallás azonosítója, fájlnév, megjegyzés; a felület lapoz, a válasz egyben jött |
| **Ügykövetés GET-tel:** `GET /api/cases/folyamatban` | a megfigyeléskor üres volt („nem került rögzítésre az önkormányzat partnertörzsébe") |
| **A szerepkörváltás állapotot módosít, és robotszűrő védi:** `PUT /api/role` | a törzsben a szerepkör adatai mellett `turnstileToken` (Cloudflare) és `confirmed`; a váltás után `GET /api/role/messages` |
| Az önkormányzat kiválasztásához külön kérést nem láttunk | a kiválasztás után a felület csak olvasott; **nem derült ki**, hogyan tudja a szerver, melyik önkormányzatra szól az `/api/tax` hívás (valószínűleg süti; a sütik neve nem került a jegyzőkönyvbe) |
| **A felület maga is küld módosító kéréseket:** `PUT /api/keepalive` (9-szer), és oldalanként `POST …/ssb/enter`, `…/ssb/list`, `/api/user/ssb/login` | a `keepalive` a munkamenetet tartja életben (10 perces óra); az `ssb` hívások törzs nélkül mentek, a válaszuk üres – a nevük alapján használati napló, **a céljuk nem igazolt** |

## Következtetések

1. **A saját néven futó olvasás egyszerű GET-ekkel megy:** felhasználó és önkormányzatlista, adóegyenleg, bevallások listája, ügyek. Erre épülhet közvetlen lekérés, ha a böngésző nélküli belépés működik.
2. **Az adóegyenleg PDF-ben jön.** A terméknek a kivonatot iratként kell eltennie (önkormányzat, szerepkör, év, lekérdezés napja), és ha összeg kell, azt a PDF szövegéből kell kiolvasni – ez törékenyebb, mint egy gépi mező, ezért az összeg „kiolvasott, ellenőrizendő" jelzést kap.
3. **A cég vagy vállalkozás nevében való lekérdezés a szerepkörváltáson múlik, azt pedig robotszűrő védi.** A program ilyen kérést nem küld, és a szűrőt nem kerüli meg. A több ügyfeles működés ezért csak úgy lehetséges, hogy a váltást a könyvelő végzi el a látható belépőablakban; a program utána a már átváltott munkamenetben olvas.
4. **Egy belépéssel több önkormányzat is lekérdezhető** (a megfigyelésben kettő), de a kiválasztás módja a szerver felé még nem ismert; a próbaszkriptnek ezt kell először kimérnie.
5. **A `keepalive` és az `ssb` hívásokat a program nem küldi.** Egy futás belefér a munkamenet idejébe; ha nem, újra belép.

## Javasolt sorrend (jóváhagyásra)

- **A kör – csak GET, a belépő saját nevében:** `userdetails` (önkormányzatlista az ügyfélhez), `service-permissions`, majd önkormányzatonként adóegyenleg-kivonat (PDF, iratként), bevallások listája, folyamatban lévő ügyek. Előfeltétel: csak olvasó próbaszkript, amely kiméri a belépést Ügyfélkapu+ kóddal, a `http`→`https` visszairányítást és az önkormányzat-kiválasztás módját.
- **B kör – a könyvelő által átváltott szerepkörben ugyanezek a GET-ek,** látható belépőablakkal. A program nem vált szerepkört; csak akkor olvas, ha a `roleDetails` szerint a kívánt szerepkör már él.
- **Nem építjük meg:** szerepkörváltás a program által, ügyindítás és űrlapbeküldés, befizetés, az alapértelmezett önkormányzat átállítása, `keepalive` és `ssb` hívások küldése.

## Kiegészítés (2026-11-13): amit a portál nyilvános kódja tisztázott; az A kör előkészítve

A tulajdonos jóváhagyta az A kört. A megfigyelés nyitott kérdéseit a portál bárki által letölthető, belépés nélküli felületkódja (a böngészőbe töltött szkriptek) válaszolta meg – ez nem megfigyelt forgalom, hanem a felület forrása:

| Kérdés | Válasz |
|---|---|
| A két egyenlegtípus útvonalneve | `SIMPLE` és `DETAILED` (`GET /api/tax/<típus>/<év>`); a felület az idei és az előző hat évet kínálja |
| Hogyan jut el a szerverhez a kiválasztott önkormányzat | **a `GET /api/public/tenant-services/<azonosító>` kérés választja ki** – olvasó kérés, de a munkamenet kiválasztott önkormányzatát átállítja; az alapértelmezettet (`PUT …/default-tenant`) és a kedvenceket külön, módosító kérés kezeli |
| Mik az `…/ssb/…` hívások | a felület használati naplója (oldalra lépés, listázás); a program nem küldi |
| A válaszok alakja | minden válasz `{ body, length }` borítékban jön, a felület a `body`-t használja |
| Egy bevallás letöltése | `GET /api/tax-returns/<adónem kódja>/<bevallás azonosítója>` – a megfigyelésben nem szerepelt, ezért **nem építjük be**, amíg élőben nem láttuk |

**Megépült (szimulátoron tesztelve, élőben nem):** `desktop/asp-http.js` – belépés a közös KAÜ-lánccal, majd önkormányzatonként kivonat (PDF), bevallások listája és ügyek, kizárólag GET-tel, mintákra szűkített útvonallistával. A közös lánc új, alapból kikapcsolt kapcsolója (`upgradeInsecure`) a belépés végi `http`-s átirányítást `https`-en követi; idegen gépre így sem megy. Csak olvasó próbaszkript: `research/kiserletek/elo-proba-asp.mjs`.

**A próba méri ki:** megy-e az Ügyfélkapu+ kódos belépés ezen a portálon böngésző nélkül; kiszolgálja-e a szerver az olvasásokat a használati napló hívásai nélkül; mik a `status` mező értékei.

## Korlátok

Egyetlen megfigyelés, egy fiók, DÁP-os belépés, két önkormányzat, kevés adat. A lapozás nagy listán, a hibaválaszok, a terhelési korlátok és a cég képviseletében elérhető adatok nem ismertek. A mezők jelentését a nevükből következtetjük; értéket a jegyzőkönyv nem tartalmaz, ezért például a két egyenlegtípus pontos útvonalneve és a `status` lehetséges értékei sem ismertek – ezeket a próbaszkript olvassa ki. A végpontok dokumentálatlanok: a portál bármikor megváltoztathatja őket.
