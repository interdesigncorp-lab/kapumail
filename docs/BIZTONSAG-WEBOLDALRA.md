# Biztonsági architektúra és weboldalra kiírható tájékoztató (KapuMail)

Ez a dokumentum két részből áll:
1. **Weboldalra (landing page / biztonsági aloldal) közvetlenül kimásolható marketing- és bizalmi szöveg** könyvelőirodáknak és cégvezetőknek.
2. **Műszaki háttérdokumentáció (audit- és IT-ellenőrzéshez)** arról, pontosan hogyan tárolja és védi a KapuMail az Ügyfélkapu+ és DÁP munkameneteket.

---

## 1. Weboldalra kiírható szöveg (Landing Page blokk)

### Főcím (Hero / Biztonsági szekció)
**Banki és böngészőszintű titkosítás a saját gépeden – Zero-Knowledge védelemmel**

Ügyfélkapu+ belépési adataid és hitelesítő kódjaid **soha nem hagyják el a számítógépedet**. A KapuMail nem kér el és nem tárol jelszavakat felhőszerveren: pontosan ugyanazt az operációs rendszerbe épített hardveres/rendszerszintű kulcstartót használja, amelyre a **Google Chrome**, a **Microsoft Edge** és a **Safari** is bízza a mentett jelszavaidat.

### 4 biztonsági pillér (Kártyák a weboldalon)

1. **Operációs rendszer szintű titkosítás (macOS Keychain & Windows DPAPI)**
   - **Macen** az Apple **macOS Kulcskarikája (Keychain)** és a Secure Enclave védi a kulcsokat AES-256 titkosítással.
   - **Windowson** a Microsoft **DPAPI (`CryptProtectData`)** motorja titkosítja az adatokat a bejelentkezett Windows-fiókodhoz és az adott géphez kötve – más gépre átmásolva a fájl matematikailag visszafejthetetlen.
2. **Zero-Knowledge szerverarchitektúra**
   - A KapuMail szerverére kizárólag az iratok metaadatai, a jóváhagyott küldemények és az adónaptár-határidők kerülnek fel.
   - Sem a jelszavad, sem a 16 karakteres Ügyfélkapu+ hitelesítő kulcsod (TOTP seed) **soha egyetlen hálózati kérésben vagy naplóban sem szerepel** – még rendszergazdai jogosultsággal sem olvasható ki.
3. **Elszigetelt, csak kormányzati (`*.gov.hu`) kapcsolat + DÁP támogatás**
   - Az Ügyfélkapu+ és DÁP belépés elszigetelt memóriamunkamenetben zajlik, amely kizárólag HTTPS-en és kizárólag hivatalos `*.gov.hu` tartományokkal (`kau.gov.hu`, `tarhely.gov.hu`, `upo.nav.gov.hu`) kommunikálhat.
   - Az alkalmazás bezárásakor a memóriabeli munkamenet-sütik automatikusan megsemmisülnek.
4. **Helyi PIN-zár, Touch ID és módosíthatatlan SHA-256 auditnapló**
   - A KapuMail külön helyi PIN-kóddal és macOS **Touch ID** ujjlenyomattal is zárolható (automatikus zárolással képernyőzár és alvás után).
   - Minden letöltött e-aktáról (`.es3`) és PDF-ről **SHA-256 kriptográfiai ujjlenyomat** készül, az átvételi eseményeket pedig adatbázis-szinten védett, utólag nem módosítható és nem törölhető (append-only) auditnapló őrzi.

### Rövid összehasonlító táblázat (Weboldalra)

| Védelmi szempont | Felhős tárhely-letöltők | **KapuMail (Asztali + OS Vault)** |
|---|---|---|
| Hol tárolódik az ÜK+ jelszó és TOTP-kulcs? | Külső szolgáltató szerverén | **Csak a saját gépeden (macOS Keychain / Windows DPAPI)** |
| Mi történik egy központi szerverfeltörésnél? | Az összes ügyfél belépője veszélybe kerülhet | **Zero-Knowledge: a szerveren nincs egyetlen ÜK+ titok sem** |
| Honnan történik a belépés a `gov.hu` felé? | Idegen adatközponti IP-címről | **A könyvelőiroda saját gépéről és IP-címéről** |
| Joghatályos küldemények védelme | Gyakran válogatás nélkül mindent letölt | **Szabályozható: nyugták automatikusan, joghatályos iratok gombnyomásra vagy tudatos felülíró szabállyal** |

---

## 2. Műszaki specifikáció (IT és adatvédelmi megfeleléshez)

| Réteg | Megvalósítás a KapuMail kódbázisában |
|---|---|
| **Titkosító motor** | Electron `safeStorage` (Chromium `OSCrypt`): macOS-en Keychain Services API, Windows 10/11-en `CryptProtectData` (DPAPI, AES-256-GCM mesterkulccsal), Linuxon `libsecret` (`gnome-keyring` / `KWallet` – titkosítatlan `basic_text` háttértárat a program kifejezetten visszautasít). |
| **Folyamatszintű elszigetelés** | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. A webes megjelenítő (renderer) JavaScript-kódja a tárolt Base32 TOTP-kulcsot és jelszót **soha nem kapja meg**: az IPC-híd (`preload.js`) csak maszkolt létinformációt és az aktuális 30 másodperces 6 jegyű RFC 6238 kódot adja át. |
| **TOTP generátor** | Szabványos **RFC 6238** (HMAC-SHA1, 30 másodperces időszelet, 6 számjegy), külső npm-függőség nélkül, a Node.js beépített `crypto` moduljával (`desktop/totp.js`). |
| **Alkalmazászár** | `scrypt` kulcsszármaztatás (`N=16384, r=8, p=1`), egyedi 16 bájtos kriptográfiai sóval és konstans idejű (`crypto.timingSafeEqual`) összehasonlítással, exponenciális próbálkozás-lassítással (`desktop/lock.js`). |
| **Szerveroldali szivárgásvédelem** | Automatizált teszt (`KapukTest::test_titok_nem_kerul_az_allapotba_es_a_naploba`) ellenőrzi minden kiadás előtt, hogy sem jelszó, sem titoktár-URI nem kerülhet sem az API-válaszokba, sem az auditnaplóba. |
