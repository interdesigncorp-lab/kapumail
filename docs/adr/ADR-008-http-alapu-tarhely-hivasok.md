# ADR-008: Tárhely-hívások HTTP-ről, lapba írt szkript és felületi kattintás nélkül

Állapot: **elfogadva: B azonnal, C a cél** · 2026-11-12 (tulajdonosi döntés)
Előzmény: [ADR-002](ADR-002-tarhely-csatlakozo.md), [ADR-004](ADR-004-joghatas-kapuk.md), [ADR-006](ADR-006-titokkezeles.md), [ADR-007](ADR-007-elo-listazas-tarhely-cli.md)
Bizonyíték: [R07](../../research/R07-rokon-nyilt-forrasu-projektek.md) 9. fejezet, kísérleti szkript: `research/kiserletek/kau-http-belepes.mjs`

## Mi a kérdés

Ma két élő út van az asztali appban:

| Út | Belépés | Tárhely-hívások |
|---|---|---|
| `desktop/connector.js` (ADR-007) | a `tarhely-cli` lép be Playwright Chromiumban, tárolt jelszóval és TOTP-kulccsal | a `tarhely-cli` végzi |
| `desktop/tarhely-live.js` | a felhasználó lép be a hivatalos oldalon, elszigetelt ablakban (hitelesítő alkalmazás, e-mailes kód vagy DÁP) | a rejtve tartott lapba írt szkript `fetch`-el; a fejléceket a lap forgalmából lessük le (debugger); a postafiókváltás gombkattintás a portál felületén |

A kísérlet megmutatta, hogy ehhez nem kell lap. A kérdés: mire cseréljük, és mit hagyunk meg.

## Tények (R07 és az élő próbák, 2026-11-12)

| Tény | Szint |
|---|---|
| A KAÜ-lánc (tárhely → KAÜ módválasztó → idp jelszó → idp kód → KAÜ → tárhely) sima HTML-űrlapküldésekkel végigjárható, JavaScript nélkül | Élő futás, kétszer |
| A postafiók-lista (`GET /levelezes/api/mailbox/reload`) a munkamenet sütijeivel és az `XSRF-TOKEN` sütiből vett `x-xsrf-token` fejléccel 200-at ad | Élő futás, kétszer |
| A levéllista (`POST /levelezes/api/uzenetek/BEERKEZETT/kereses`) ugyanígy, `address-id` fejléccel 200-at ad | Élő futás, egyszer |
| Két postafiók ugyanabban a munkamenetben, csak eltérő `address-id` fejléccel eltérő listát adott (0 és 6 sor) | Élő futás, egyszer; két nem üres postafiókkal nincs megerősítve |
| Botszűrés, CAPTCHA a futásokon nem jelent meg | Élő futás; ismételt, ütemezett futásra **NEM BIZONYÍTOTT** |
| A termék saját modulja (`desktop/tarhely-http.js`) belép és listáz, két postafiókkal (egy saját, egy céges) | Élő futás, kétszer (2026-11-12, `research/kiserletek/elo-proba-szerkezet.mjs`), kézzel beírt kóddal |
| A tartós tár (`…/uzenetek/TARTOS_TAR/kereses`) ugyanúgy listázható, azonos mezőkkel | Élő futás, kétszer |
| A telítettség (`GET /levelezes/api/mailbox/details`: `kvota`, `hasznaltKvota`) lekérhető | Élő futás, kétszer |
| A lapozás működik (`pageNumber`, `countPerPage`; a válaszban `pagination`: `page`, `totalItems`, `totalPages`) | Élő futás, egyszer, 50-es oldalmérettel 54 levélen; 100 fölötti levélszámmal nincs megerősítve |
| A kezdődátumos szűrő (`filter.incomingFromDate`) csak „Z" végű teljes időbélyeget fogad el; sima dátumra 400-at ad | Élő futás, kétszer |
| A postafiók-lista mezői: `azonosito` (belépések között állandó), `mailboxName`/`megnevezes`, `name`, `type` (`AP` = a belépő saját tárhelye, `CKP` = Cégkapu), `defaultMailbox` | Élő futás, kétszer; a Hivatali kapu típuskódja nem ismert |
| Két egymást követő listázás után a Beérkezett levelei a tárhelyen olvasatlanok maradtak (`olvasatlan: true`) | Élő futás, kétszer; ez megfigyelés a jelzőről, nem bizonyíték a joghatás hiányára |
| A tárhely „LetoltesiIgazolas" típusú rendszerüzenetet is küld | Élő futás (a típuskódok között); arra utal, hogy a letöltésről a rendszer igazolást állít ki |
| A letöltés böngésző nélkül működik: `GET /levelezes/api/uzenet/letoltes/beerkezett/<érkeztetési szám>` az `address-id` fejléccel 200-at és a fájl bájtjait adja; a méret egyezik a listában jelzettel | Élő futás, egyszer, egy feladási igazoláson (PDF, 1,9 mp) |
| A tartós tárból a letöltés útvonala `…/uzenet/letoltes/tartostar/<érkeztetési szám>`; a rövid `…/tartos/…` alakra a tárhely 500-as JSON-hibát ad | Élő futás, egyszer, egy már megnyitott elfogadó nyugtán (PDF; a méret egyezik a listában jelzettel) |
| A kulcsból számolt kóddal a belépés működik | Élő futás, háromszor, a termék felügyelet nélküli útján |
| A letöltés válaszában a fájlnév, egy lenyomat és az érkeztetési szám külön fejlécben jön (`filename`, `hash`, `erkeztetesiszam`); `content-disposition` nincs | Élő futás, egyszer; a fejlécek értékét a próba nem rögzítette, a `hash` algoritmusa nem ismert |
| **A letöltéstől a levél a tárhelyen megnyitottá válik** (`olvasatlan: true → false`), részletlekérés nélkül is | Élő futás, egyszer; 6 másodperc múlva már így látszott |
| A letöltés után 30 másodpercen belül nem érkezett új levél és új letöltési igazolás | Élő futás, egyszer, rendszernyugtán; később még érkezhet, és hatósági iratnál más lehet |
| Levélrészlet HTTP-ről | **NEM BIZONYÍTOTT** |
| A munkamenet élettartama | **NEM BIZONYÍTOTT** |
| A listázás nem vált ki átvételt | **NEM BIZONYÍTOTT** (változatlanul az ADR-004 kapuja) |

## Opciók

| | A) Marad a mostani | B) Emberi belépés ablakban, hívások HTTP-ről | C) Teljes HTTP: belépés is tárolt adatból |
|---|---|---|---|
| Belépés | hivatalos oldal, ember | hivatalos oldal, ember (mindhárom mód) | saját kód küldi a jelszót és a kódot |
| Tárhely-hívások | lapba írt szkript, debugger, kattintás | a főfolyamatból, a belépőablak munkamenetével | saját HTTP-kliens, saját sütitár |
| Titok a mi kódunkban | nincs | nincs | jelszó és TOTP-kulcs (ADR-006 kapu) |
| DÁP, e-mailes kód | megy | megy | nem megy (emberi lépés kell) |
| Függés a portál felületétől | gombok azonosítói, felugró ablakok | csak a belépőoldal és az API | csak az űrlapmezők és az API |
| Chromium | kell (Electron része) | kell a belépéshez (Electron része) | nem kell; a `tarhely-cli` és a 150 MB-os Playwright kiváltható |
| Felügyelet nélküli futás | nem | a munkamenet élettartamáig | igen |
| Kockázat | törékeny; a felugróablak-bezáró idegen gombot is megnyomhat (R01) | kicsi | jogi (tárolt második faktor), és a nem böngészős kliens könnyebben szűrhető |

## Döntés (tulajdonosi, 2026-11-12)

A megrendelő mindkét utat kéri: **B) azonnal, C) pedig a cél**, mert a termék rendeltetése, hogy **felügyelet nélkül, magától szedje le több ügyfél leveleit**. Ehhez a tárolt jelszavas és hitelesítő kulcsos (teljesen HTTP-alapú) belépés kell, emberi közreműködés nélkül.

**1. A B) opció a közös mag, és azonnal épül.** A `tarhely-live.js` emberi belépése változatlan marad (hitelesítő alkalmazás, e-mailes kód, DÁP), de a tárhely-hívások a főfolyamatból mennek, a belépőablak munkamenetének sütijeivel. Megszűnik a lapba írt `fetch`, a debugger-alapú fejlécfigyelés, a postafiókváltó kattintás és a felugróablak-bezáró. A postafiókot kizárólag az `address-id` fejléc választja ki.

- Megvalósítási jelölt: az Electron `session.fromPartition(...).fetch()`, amely a munkamenet sütijeit és a Chromium hálózati rétegét használja. **NEM BIZONYÍTOTT**, hogy így is megy; az első lépés ennek próbája. Ha nem, a sütik átadhatók saját HTTP-kliensnek (ezt a kísérlet igazolta).
- A belépés (űrlaplánc) és a hívások (postafiók- és levéllista) egy közös, tesztelhető **HTTP-mag** modulba kerülnek, amely kétféleképpen táplálható: (B) egy kész munkamenettel, vagy (C) belépési adatokkal. Ez a mag a kísérleti szkript (`research/kiserletek/kau-http-belepes.mjs`) megszilárdított változata.

**2. A C) opció a cél: felügyelet nélküli, többügyfeles futás.** A HTTP-mag belépési adatból (felhasználónév, jelszó, TOTP-kulcs) lép be, ügyfelenként, ütemezetten, ember nélkül. Ez kiváltja a `tarhely-cli`-t és a Playwright Chromiumot (kisebb telepítő, nincs külső, kiadás nélküli függőség). Feltételei a 7. szakasz kapui; a jogi kapu az ADR-006/ADR-004 átírását igényli (lásd lent).

**3. A jogi kapu feloldása tulajdonosi döntés és felelősség.** Az ADR-006 eddig tiltotta a csak tárolt TOTP-kulccsal működő funkciót. A megrendelő ezt a célt most elfogadja, azzal, hogy:

- minden ügyfél tárolt belépője a saját, kifejezett meghatalmazásán és hozzájárulásán alapul;
- a titkok kizárólag az asztali gép OS-kulcstárában élnek (ADR-006 1–3. pont változatlan), szerverre, naplóba, hibajelentésbe sosem kerülnek;
- a szolgáltatás feltételei és a gépi, felügyelet nélküli belépés jogszerűsége megítélésének felelőssége a megrendelőé. A piacon a `molnar-iroda/tarhely-figyelo` pontosan ezt teszi (tárolt jelszó + TOTP-kulcs, ütemezett futás), tehát precedens van, de ez nem jogi állásfoglalás.

Az ADR-006 „Nyitott jogi kapu” szakaszát és az ADR-004 érintett sorát ennek megfelelően frissíteni kell (külön lépés).

**4. A funkciókör: listázás, és (2026-11-12-től, tulajdonosi döntéssel) az automatikusnak jelölt irattípusok letöltése.** Eredetileg csak a listázás tartozott ide. Az első élő letöltési próba után a tulajdonos úgy döntött, hogy a felügyelet nélküli futás le is töltheti azokat az iratokat, amelyeket az [ADR-009](ADR-009-tipusonkenti-letoltesi-szabaly.md) szerint a szerver automatikusan letölthetőnek minősít (nyugták). Ez nem jogi állásfoglalás; a letöltés a tárhelyen megnyitottá teszi a levelet, és átvételnek számíthat. Feltételek, amelyeket a kód kikényszerít:
- a főfolyamat minden letöltés előtt engedélyt kér a szervertől, megnevezve a belépőt; a szerver csak automatikus típusra, aktív ügyfélre, bekapcsolt rendszerre és a postafiók saját belépőjére ad engedélyt;
- csak az tölthető le, amit a főfolyamat ebben a futásban maga listázott; ember híján megerősítő kérdés nincs, a nem automatikus irat elutasítva;
- egy futásban legfeljebb 50 letöltés, belépőnként egyszerre egy, 1,5–3 mp szünettel; ugyanaz az irat egy futásban egyszer; újrapróbálkozás a tárhely felé nincs.
Levélrészlet, tartós tárba helyezés, törlés, küldés továbbra sincs.

## Kapuk és feltételek

| Feltétel | Állapot | Mi oldja fel |
|---|---|---|
| A hívások működnek a belépőablak munkamenetéből, lap nélkül | **NEM BIZONYÍTOTT** | Élő próba a megrendelő fiókjával |
| Az `address-id` fejléc két nem üres postafióknál is elkülönít | részben igazolt | Élő próba olyan fiókkal, amelynek két nem üres postafiókja van |
| Idegen postafiók adata nem keveredhet | tervezési követelmény | Minden válasznál ellenőrizzük, hogy a kért `address-id` szerepel a munkamenet postafiók-listájában; teszt ál-szerverrel |
| Csak engedélyezett gépek és HTTPS | tervezési követelmény | Gép-engedélylista a hívó modulban (ahogy a kísérleti szkriptben), teszttel |
| A listázás joghatása | **NEM BIZONYÍTOTT** | ADR-004, változatlan |
| Ismételt futásnál nincs szűrés, zárolás | **NEM BIZONYÍTOTT** | Megfigyelés kézi futásokon; ütemezett futás ettől függetlenül sincs (ADR-007) |

## Amit ez a döntés nem old meg

- A munkamenet lejárta: marad a látható újrahitelesítési kérés (ADR-006 5. pont).
- A NAV ügyfélportál elérése ugyanezzel a belépéssel (R07 2. fejezet): külön kutatás és külön döntés.
- A portál változása: az API és a belépőoldal változását továbbra is nekünk kell követni; a felületi elemektől való függés viszont megszűnik.

## Következő lépések

**B) fázis – közös HTTP-mag emberi belépéssel:**
1. A kísérleti szkript megszilárdítása közös modullá (`desktop/tarhely-http.js`): űrlaplánc-belépés, postafiók-lista, levéllista; gép-engedélylista; `address-id`-ellenőrzés minden válasznál; semmilyen titok a naplóba.
2. Próba a meglévő belépőablak munkamenetéből `session.fetch`-csel, a mostani út mellett, kapcsoló mögött.
3. Ha megy: a `tarhely-live.js` hívásainak átírása a magra; a debugger-figyelés, a `switchScript` és a felugróablak-bezáró törlése; egységtesztek ál-szerverrel.

**C) fázis – felügyelet nélküli, többügyfeles futás:**
4. Előbb a jogi kapu: az ADR-006/ADR-004 frissítése a tulajdonosi döntéssel és a feltételekkel (meghatalmazás, OS-kulcstár, hozzájárulás).
5. Ügyfelenkénti belépő az OS-kulcstárban (felhasználónév, jelszó, TOTP-kulcs); a TOTP-kódot a `desktop/totp.js` adja. A kód sosem lép a felületre, naplóba, szerverre.
6. Ütemezett, sorban futó többügyfeles listázás a HTTP-maggal; ügyfelenként elkülönített munkamenet és sütitár; hiba egy ügyfélnél nem állítja meg a többit.
7. Élő futás a megrendelő fiókjával (előbb egy, majd több ügyféllel), jegyzőkönyv az R07-be; a munkamenet élettartamának és az ismételt futás viselkedésének megfigyelése; utána a `tarhely-cli`-alapú `connector.js` (ADR-007) nyugdíjazása.
