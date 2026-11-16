<p align="center">
  <img src="docs/kepek/kapumail-cover.jpg" alt="KapuMail – Minden hivatalos irat. Egy helyen." width="100%">
</p>

<h1 align="center">KapuMail – dokumentumközpont könyvelőirodáknak és vállalkozásoknak</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/Licenc-GNU%20AGPLv3-6d28d9" alt="GNU AGPLv3"></a>
  <a href="https://kapumail.hu"><img src="https://img.shields.io/badge/Kiad%C3%A1s-v0.2.4-7c3aed" alt="v0.2.4"></a>
  <a href="https://kapumail.hu"><img src="https://img.shields.io/badge/M%C5%B1k%C3%B6d%C3%A9s-Local%20First%20(macOS%20%C2%B7%20Windows)-059669" alt="Local First"></a>
  <a href="../../issues/new?template=feature_request.yml"><img src="https://img.shields.io/badge/%C3%9Aj%20funkci%C3%B3%20k%C3%A9r%C3%A9se-Feature%20Request-2563eb" alt="Feature Request"></a>
</p>

A **KapuMail** helyi adattárolású (*local-first*) asztali dokumentumközpont, amely egyetlen átlátható felületen gyűjti és rendezi az ügyfelek **Ügyfélkapu+-**, **DÁP-**, **Cégkapu-** és **hivatali tárhelyének** küldeményeit, valamint a **NAV ügyfélportál** és az **önkormányzati ASP portál** adatait — szigorúan elválasztva a belső feldolgozást a joghatást kiváltó hivatalos átvételi műveletektől.

Weboldal és hivatalos aláírt telepítők: **https://kapumail.hu** · Kiadási verzió: **0.2.4**

---

## Bemutatóvideó

<p align="center">
  <a href="https://kapumail.hu/media/film.mp4" title="Kattints a teljes, hangos bemutatófilm megnyitásához (kapumail.hu)">
    <img src="docs/kepek/kapumail-bemutato.gif" alt="KapuMail bemutatófilm előnézete – kattints a teljes hangos videóhoz" width="88%">
  </a>
  <br>
  <em><a href="https://kapumail.hu/media/film.mp4">▶ Teljes bemutatófilm megnyitása hanggal (kapumail.hu)</a></em>
</p>

---

## Főbb funkciók és képességek (`0.2.4`)

- **Élő tárhely- és portálkapcsolatok:** Ügyfélkapu+ (KAÜ / TOTP), DÁP QR, Cégkapu és Hivatali tárhely küldeményeinek szinkronizálása, továbbá a NAV ügyfélportál (adónaptár, adószámla, bevallások) és az önkormányzati ASP portál (helyi adók) áttekintése.
- **Hordozható helyi architektúra (*Local-first*):** Az asztali alkalmazás beágyazott, hordozható PHP 8.4 CLI futtatókörnyezetet és helyi SQLite adatbázist futtat közvetlenül a felhasználó saját gépén (`<userData>/local-server`), külső felhős adattárolás nélkül.
- **Rendszerszintű titoktár:** A belépési azonosítók és kulcsok az operációs rendszer saját titkosított kulcstartójában maradnak (**macOS Keychain**, **Windows Credential Manager**), kiegészítve helyi alkalmazászárolással (Touch ID / PIN).
- **Kétszintű joghatás-kapuk (`DownloadPolicy`):** Éles határvonal a joghatás nélküli tájékozódó listázás és a joghatást kiváltó hivatalos iratátvétel között (megerősítő ablak, szerepkör szerinti vezetői jóváhagyás, auditnapló).
- **ES3 / ASiC-E olvasó és hitelesség-ellenőrzés:** `.es3` és `.asice` akták helyi kibontása, beágyazott PDF előnézet, SHA-256 lenyomat és kriptográfiai aláírás-sértetlenség vizsgálata.
- **69 típusos irattaxonómia és határidő-számítás:** Automatikus irattípus-felismerés, szabálymotor szárazfutással és határidő-követés naptárral.
- **Kapu-chat helyi AI-asszisztens:** Elszigetelt MCP eszközkészlettel működő asszisztens az iroda saját adatainak gyors lekérdezéséhez.
- **Sérthetetlen adathordozhatóság:** Minden letöltött dokumentum és az iratjegyzék bármikor egyetlen kattintással exportálható strukturált `.zip` és `.csv` csomagban.

<p align="center">
  <img src="docs/kepek/kapumail-illusztracio.jpg" alt="KapuMail a könyvelőirodai munkában" width="100%">
</p>

---

## Futtatás és saját fordítás forráskódból

### Előfeltételek
- **PHP:** 8.3 vagy 8.4 CLI (`sqlite3`, `pdo_sqlite`, `openssl`, `zip`, `mbstring` modulokkal)
- **Composer:** 2.x
- **Node.js:** 20.x vagy újabb + `npm`

### 1. Szerveroldali háttérrendszer (Laravel)
```bash
cd app
composer install
cp -n .env.example .env
php artisan key:generate --force
php artisan migrate --force
```

Fejlesztői böngészős indítás (demó mintaadatokkal `php artisan db:seed` után):
```bash
php artisan serve --port=8000
```

### 2. Asztali alkalmazás fejlesztői módban (Electron)
```bash
cd desktop
npm install
npm start
```

### 3. Aláírásmentes közösségi csomagépítés (`build:oss`)
A forráskódból bárki önállóan készíthet teljes értékű telepítőt Apple Developer ID vagy kódaláíró tanúsítvány nélkül:
```bash
cd desktop
npm run build:oss
```
*(vagy közvetlenül: `KAPUMAIL_OFFICIAL_BUILD=0 node scripts/build-release.js --unsigned`)*

A parancs letölti a hordozható PHP 8.4 futtatókörnyezetet, előkészíti a tiszta Laravel alkalmazásszervert, és lefordítja a telepítőket a `desktop/dist/` mappába (`KapuMail-0.2.4-arm64.dmg`, `KapuMail-0.2.4-x64.dmg`, `KapuMail-Setup-0.2.4.exe`).

---

## Új funkció kérése, forkolás és fejlesztői hozzájárulás

Örömmel fogadjuk a közösségi ötleteket, hibajavításokat és új funkciókat! A részletes szabályokat a **[CONTRIBUTING.md](CONTRIBUTING.md)** tartalmazza; alább a legfontosabb tudnivalók összefoglalása olvasható.

### 1. Hogyan kérhetsz új funkciót? (*Feature Request*)
1. Nyiss egy új bejegyzést a GitHub **[Issues → ✨ Új funkció kérése (Feature Request)](../../issues/new?template=feature_request.yml)** űrlapjával.
2. Írd le, milyen könyvelői vagy ügyviteli problémát old meg a javaslat, hogyan működne a felületen, és érint-e külső állami portált vagy joghatású műveletet (iratletöltés / átvétel).
3. Nagyobb fejlesztés megkezdése előtt érdemes megvárni a karbantartói visszajelzést az Issue alatt, hogy az irány illeszkedjen a KapuMail biztonsági és joghatás-kapu architektúrájába.

### 2. Forkolási és új funkció beküldési folyamat
1. **Forkold** a tárolót a GitHubon a saját fiókodba (`Fork` gomb), majd klónozd le és vedd fel az eredeti (`upstream`) tárolót:
   ```bash
   git clone git@github.com:<SAJAT-NEVED>/kapumail.git
   cd kapumail
   git remote add upstream https://github.com/interdesigncorp-lab/kapumail.git
   ```
2. **Hozz létre külön munkaágat** mindig a legfrissebb `main` ágból:
   - új funkcióhoz: `git checkout -b feat/rovid-beszedes-nev`
   - hibajavításhoz: `git checkout -b fix/rovid-beszedes-nev`
3. **Fejleszd le a változtatást és írj hozzá tesztet** (`app/tests/Feature/` vagy `desktop/test/`), majd ellenőrizd mindkét tesztkészletet és a migrációkat:
   ```bash
   cd app && php artisan migrate --force && php artisan migrate:status
   cd app && php artisan test
   cd ../desktop && npm test
   ```
4. **Töltsd fel az ágat a saját forkodba**, és nyiss **Pull Requestet** az eredeti tároló `main` ága felé a [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) sablon hiánytalan kitöltésével és a CLA elfogadásával.

### 3. Commitolási szabályok
- **Magyar nyelvű, atomi commitok:** Egy commit egy jól körülhatárolt logikai egységet tartalmazzon. A commit első sora tömör (~72 karakter), magyar nyelvű összefoglaló legyen kijelentő vagy főnévi formában (pl. `Bejövő szűrősáv: felelős nélküli iratok gyorsszűrője`).
- **Tiszta diffek:** Tilos a meglévő fájlokon tömeges automatikus átformázást (`vendor/bin/pint --dirty`) futtatni, mert átírja a projekt tömör kódstílusát.
- **Biztonságos adatbázis-hozzáférés:** A `DB::table(...)` által visszaadott `stdClass` sorok új vagy opcionális oszlopait kizárólag védve (`$row->oszlop ?? null`) szabad kiolvasni.
- **Zéró érzékeny adat:** Soha ne commitolj `.env` fájlt, `.sqlite` adatbázist, API-kulcsot, privát kulcsot, valós cégnevet vagy éles adószámot!

### 4. Kötelező képernyőkép (Screenshot) és UI-változások megjelölése
Minden olyan Pull Requesthez, amely a felhasználói felületet (`app/resources/ui/`, `desktop/*.html`) érinti vagy új vizuális funkciót ad hozzá:
1. **Kötelező képernyőképet (screenshotot) csatolni** a Pull Request leírásába a futó alkalmazásról (**kizárólag demó / fiktív mintaadatokkal!**).
2. **Egyértelműen meg kell jelölni, mi került be a UI-ba:** a képernyőképen vizuális kiemeléssel (kerettel, nyíllal, számozással) **és/vagy** közvetlenül a kép alatt pontokba szedve mutasd be, pontosan mely gombok, szűrők, kártyák, jelvények vagy állapotok kerültek be, illetve változtak meg (meglévő nézet módosításánál *Előtte / Utána* képpárral).

---

## Tesztek és projektstruktúra

```bash
cd app && php artisan test      # Szerveroldali PHPUnit tesztek (382 teszt)
cd desktop && npm test          # Asztali kliens tesztek (407+ teszt)
```

| Mappa / fájl | Szerep |
|---|---|
| [`app/`](app/) | Laravel háttérrendszer: adatmodell, joghatás-őrfüggvény, ES3 olvasó, szinkronmotor, API és UI |
| [`desktop/`](desktop/) | Electron asztali keretrendszer: hordozható PHP szerverkezelő, OS titoktár, portálcsatlakozók, Kapu-chat MCP |
| [`.github/`](.github/) | CI munkafolyamat, Feature Request / Bug Report űrlapok és Pull Request sablon |
| [`docs/`](docs/) | Architektúra-áttekintés és döntési naplók (`docs/adr/`) |

---

## Biztonság (Security)

Biztonsági sebezhetőséget kérjük **soha ne nyilvános Issue-ban**, hanem kizárólag privátban, az **`info@kapumail.hu`** címen jelents be. Részletek, válaszidők és *Safe Harbor* szabályok: **[SECURITY.md](SECURITY.md)**.

---

## Licenc és felelősségkizárás

A KapuMail programkódja nyílt forráskódú szoftver: a forráskód a **[GNU Affero General Public License v3.0 (GNU AGPLv3)](LICENSE)** alatt érhető el (Copyright (C) 2026 Laczkovszki Gábor / Laczkovszki Gábor E.V.).

- **Nyílt forráskódú saját fordítás (AGPLv3):** A forráskódból saját magad által lefordított változat próbaidő-korlát nélkül, szabadon használható a GNU AGPLv3 feltételei szerint, „ahogy van” állapotban, szavatosság és támogatás nélkül.
- **Hivatalos kiadás ([kapumail.hu](https://kapumail.hu)):** Digitálisan aláírt, ellenőrzött, automatikusan frissülő és támogatott macOS és Windows kiadás (14 napos ingyenes próbaidőszakkal, a már letöltött dokumentumok korlátlan megtekintésével és exportálásával).
- **Márkanév és arculat:** A „KapuMail” név, a logó, az arculati illusztrációk és a Kapu kabalafigura nem része a nyílt forráskódú licencnek; azok a jogosult kizárólagos szellemi tulajdonát képezik.
- Magyar nyelvű jogi összefoglaló és felelősségkizárás: **[FELELOSSEGKIZARAS.md](FELELOSSEGKIZARAS.md)** · Külső összetevők licencei: **[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)**.
