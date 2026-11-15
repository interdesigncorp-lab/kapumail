# Hozzájárulási útmutató (Contributing Guide)

Köszönjük, hogy érdeklődsz a **KapuMail** fejlesztése iránt! Ez az útmutató részletesen bemutatja, hogyan kérhetsz új funkciót (*Feature Request*), hogyan épül fel a forkolási és fejlesztési folyamat, milyen commitolási és minőségbiztosítási szabályokat vár el a projekt, valamint hogyan kell dokumentálnod képernyőképpel (*screenshot*) a felhasználói felület változásait.

---

## 1. Licencelés és Hozzájárulási Szerződés (CLA)

A KapuMail programkódja nyílt forráskódú szoftver, amely a **GNU Affero General Public License v3.0 (GNU AGPLv3)** licenc alatt érhető el (lásd a gyökérkönyvtárban található [`LICENSE`](LICENSE) fájlt).

### 1.1. Hozzájárulási feltételek (CLA)
Az ÁSZF 15.1. pontja és a [`FELELOSSEGKIZARAS.md`](FELELOSSEGKIZARAS.md) rendelkezéseivel összhangban:
> Aki a hivatalos adattárba fejlesztési hozzájárulást (kódot, javítást, dokumentációt, pull requestet) küld be, kijelenti, hogy jogosult arra, és a GNU AGPLv3 licenc mellett **nem kizárólagos, jogdíjmentes, visszavonhatatlan felhasználási jogot enged Laczkovszki Gábor E.V. részére** a hozzájárulás hivatalos, digitálisan aláírt KapuMail kiadásokban és szolgáltatásokban történő szerepeltetésére és terjesztésére is.

### 1.2. Eredetiségnyilatkozat (DCO – Developer Certificate of Origin)
A Pull Request beküldésével kijelented, hogy:
- A beküldött kód a saját szellemi alkotásod, vagy rendelkezel a megfelelő jogokkal ahhoz, hogy a fenti feltételekkel közzétedd.
- A hozzájárulás nem sérti harmadik felek szerzői jogait, védjegyeit vagy szabadalmait.
- A kód, a tesztek és a mellékelt képernyőképek nem tartalmaznak üzleti titkot, valós ügyféladatot, éles adószámot vagy jogosulatlan harmadik féltől származó tartalmat.

### 1.3. Védjegyek és arculati elemek védelme
A „KapuMail” név, a logó, az arculati illusztrációk és a Kapu kabalafigura **nem képezik a nyílt forráskódú licenc részét**, azok Laczkovszki Gábor E.V. kizárólagos szellemi tulajdonát képezik. Harmadik fél saját fordítását vagy módosított változatát nem tüntetheti fel hivatalos KapuMail termékként.

---

## 2. Új funkció kérése (Feature Request) és előzetes egyeztetés

Mielőtt nagyobb fejlesztésbe kezdenél, javasoljuk az ötlet előzetes egyeztetését:

1. Nyiss egy új Issue-t a **[✨ Új funkció kérése (Feature Request)](.github/ISSUE_TEMPLATE/feature_request.yml)** sablonnal.
2. Írd le pontosan:
   - **Milyen valós könyvelői / irodai problémát** old meg a javaslat;
   - **Hogyan működne a gyakorlatban**, és hol jelenne meg a felületen;
   - **Érint-e külső állami portált vagy joghatású műveletet** (pl. küldemény megnyitása, letöltése, hivatalos átvétele). A KapuMail alapelve a tájékozódó listázás és a joghatást kiváltó műveletek szigorú szétválasztása (`docs/adr/ADR-004-joghatas-kapuk.md`), ezért a portálkapcsolati módosítások mindig előzetes architektúra-jóváhagyást igényelnek.
3. Ha szívesen el is készíted a funkciót, jelöld be az űrlapon a vonatkozó mezőt — így a karbantartók gyors visszajelzést tudnak adni a javasolt megvalósítási irányról még a kódolás előtt.

---

## 3. Forkolási és új funkció beküldési folyamat

Minden külső hozzájárulás a szabványos **Fork & Pull Request** munkafolyamaton keresztül érkezik:

### 3.1. Fork létrehozása és helyi klónozás
1. Kattints a GitHub oldalon a jobb felső **`Fork`** gombra, és hozd létre a saját másolatodat.
2. Klónozd le a saját forkodat, és állítsd be az eredeti tárolót `upstream` néven:
   ```bash
   git clone git@github.com:<SAJAT-GITHUB-NEVED>/kapumail.git
   cd kapumail
   git remote add upstream https://github.com/interdesigncorp-lab/kapumail.git
   ```

### 3.2. Munkaág (Branch) indítása
Soha ne dolgozz közvetlenül a `main` ágon! Mindig frissítsd a `main` ágadat az `upstream`-ből, és nyiss beszédes nevű munkaágat:
```bash
git fetch upstream
git checkout main
git merge --ff-only upstream/main
git checkout -b feat/rovid-funkcio-nev
```
Javasolt ágnév-előtagok:
- `feat/...` – új funkció vagy felületi bővítés (pl. `feat/felelos-nelkuli-szuro`)
- `fix/...` – hibajavítás (pl. `fix/es3-zip-idobelyeg`)
- `docs/...` – dokumentációs pontosítás
- `test/...` – tesztlefedettség bővítése

### 3.3. Helyi fejlesztői környezet beállítása
Előfeltételek: **PHP 8.3 / 8.4 CLI** (`sqlite3`, `pdo_sqlite`, `openssl`, `zip`, `mbstring`), **Composer 2.x**, **Node.js 20+**.

```bash
# 1. Laravel háttérrendszer előkészítése (demó mintaadatokkal a biztonságos UI-teszteléshez és képernyőképekhez)
cd app
composer install
cp -n .env.example .env
php artisan key:generate --force
php artisan migrate --force
php artisan db:seed

# 2. Asztali alkalmazás indítása fejlesztői módban
cd ../desktop
npm install
npm start
```

Aláírás nélküli közösségi telepítőcsomag építésének ellenőrzéséhez:
```bash
cd desktop && npm run build:oss
```

---

## 4. Kötelező kódolási, migrációs és commitolási szabályok

### 4.1. Commitolási szabályok
- **Nyelv és tömörség:** A commit üzeneteket **magyar nyelven** írd. Az első sor legyen legfeljebb ~72 karakteres, egyértelmű összefoglaló arról, *mit* és *hol* változtat a commit:
  - *Jó példa:* `Bejövő iratok: felelős nélküli küldemények gyorsszűrője`
  - *Jó példa:* `ES3 olvasó: beágyazott ASiC-E mellékletek SHA-256 ellenőrzése`
  - *Kerülendő:* `fix`, `wip`, `módosítások`, `update app.html`
- **Atomi commitok:** Egy commit egyetlen összetartozó változtatást tartalmazzon. Ne keverj össze egy commitban új funkciót, független hibajavítást és stílusmódosítást.
- **Commit előtti önellenőrzés:** Minden commit előtt futtass `git status -sb` és `git diff --stat` ellenőrzést, hogy véletlenül se kerüljön be ideiglenes fájl, `.env` vagy helyi adatbázis.

### 4.2. Kódstílus és architektúra
- **Tilos a `vendor/bin/pint --dirty` futtatása** a meglévő fájlokon, mert tömegesen átírja a projekt tömör stílusát és ütközéseket okoz más fejlesztésekkel.
- Új szerveroldali üzleti logikát az `app/app/Iratkapu/` mappába szervezve, önálló, jól tesztelhető osztályként hozz létre.

### 4.3. Adatbázis-migrációk és biztonságos `stdClass` oszlophozzáférés
1. **Kötelező helyi migráció:** Minden új vagy módosított migráció után futtasd le:
   ```bash
   cd app && php artisan migrate --force && php artisan migrate:status
   ```
   Egyetlen migráció sem maradhat `Pending` státuszban! *(A `php artisan test` memóriabeli `:memory:` adatbázist használ, ezért önmagában nem migrálja a fájlos SQLite adatbázist.)*
2. **Védett `stdClass` mezőolvasás (`DB::table`):** A szerveroldali lekérdezések `stdClass` objektumokat adnak vissza. Minden újonnan felvett vagy opcionális táblaoszlopot **kizárólag védve** szabad kiolvasni:
   - **Helyes:** `($row->ref_eid ?? null)`, `empty($row->ref_eid)`, `($row->filing_status ?? null) ?: 'pending'`
   - **Tilos:** csupasz `$row->ref_eid === null` vagy `! $row->ref_eid` (részleges `SELECT` vagy sémaeltérés esetén `Undefined property` futásidejű hibát okoz).

### 4.4. Automatizált tesztek és szivárgásvédelem
Minden Pull Request beküldése előtt mindkét tesztcsomagnak 100%-osan zöldnek kell lennie, és az új funkcióhoz saját tesztet is várunk:
```bash
cd app && php artisan test
cd desktop && npm test
```
A beküldött kód, teszt és képernyőkép **soha nem tartalmazhat** éles API-kulcsot, jelszót, privát kulcsot, valós személyes adatot, valós cégnevet vagy éles adószámot!

---

## 5. Kötelező képernyőkép (Screenshot) és UI-változások megjelölése

A KapuMail felületének átláthatósága és biztonsági jelzései kritikusak a könyvelői munkában, ezért minden olyan Pull Requestnél, amely felhasználói felületet érint (`app/resources/ui/`, `desktop/*.html`, felugró ablakok, kártyák, jelvények, táblázatok):

1. **Készíts képernyőképet a futó alkalmazásról demó / mintaadatokkal** (`php artisan db:seed` mintaügyfeleivel, pl. *Borostyán Pékség Kft.*, *Szalai Nóra* — soha nem valós ügyféladatokkal!).
2. **Jelöld meg egyértelműen, mi került be a UI-ba:**
   - a csatolt képernyőképen **vizuális jelöléssel** (keretezéssel, nyíllal vagy sorszámozással), **ÉS**
   - a Pull Request leírásában a **„Mi került be / mi változott a UI-ban”** pont alatt tételesen felsorolva, melyik képernyőn milyen új gomb, szűrő, oszlop, állapotjelző vagy szöveg jelent meg.
3. **Meglévő felület módosításakor** csatolj **Előtte / Utána** képernyőkép-párt, hogy a bírálók azonnal össze tudják vetni a változást.

*(Képernyőkép és UI-megjelölés hiányában a felületet érintő Pull Requesteket nem tudjuk befogadni.)*

---

## 6. A Pull Request beküldésének ellenőrzőlistája

1. Frissítsd az ágadat az `upstream/main` legújabb állapotára, és oldd fel az esetleges ütközéseket.
2. Futtasd le a `php artisan test` és az `npm test` parancsokat, és győződj meg róla, hogy minden teszt zöld.
3. Töltsd fel a munkaágadat a saját forkodba: `git push -u origin feat/rovid-funkcio-nev`.
4. Nyiss Pull Requestet a GitHubon, töltsd ki a [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) minden szakaszát, **csatold és jelöld meg a képernyőképet**, majd pipáld be a **Hozzájárulási nyilatkozat (CLA)** jelölőnégyzetet.
