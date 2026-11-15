# KapuMail – Adatkezelési tájékoztató

Verzió: 1.4 · Hatályos: 2026. november 13-tól

Ez a tájékoztató azt írja le, hogy Laczkovszki Gábor E.V. (a továbbiakban: Szolgáltató vagy Adatkezelő) **adatkezelőként** milyen személyes adatokat kezel a KapuMail szolgáltatással összefüggésben. A tájékoztató az Európai Parlament és a Tanács (EU) 2016/679 rendelete (GDPR) 13–14. cikkén, valamint az információs önrendelkezési jogról és az információszabadságról szóló 2011. évi CXII. törvényen (Infotv.) alapul.

## 1. Kétféle üzemmód – és röviden: kinek az adata, ki felel érte?

A KapuMail kétféle üzemmódra épül, amelyek adatkezelési szempontból alapvetően eltérnek:

- **Helyi (lokális) mód – jelenleg kizárólag ez érhető el:** a KapuMail jelenleg egy teljes egészében az Ön saját számítógépére telepíthető, lokálisan futó szoftver. Ebben az üzemmódban **semmilyen céghez vagy ügyfélhez kötődő adatot, tárhelyküldeményt, adóadatot, jelszót vagy hitelesítő kulcsot nem tárolunk és nem ismerünk meg**. Az adatkezelést és az adatfeldolgozást minden esetben a szoftvert a saját gépére telepítő és futtató Felhasználó végzi. A belépési adatokat a program az operációs rendszer saját, titkosított kulcstartójában (**macOS Kulcskarika**, illetve **Windows Hitelesítőadat-kezelő**) védi – pontosan ugyanazzal a rendszerszintű jelszóvédelemmel, amelyet a számítógép és a böngésző a közvetlen Ügyfélkapu-bejelentkezésnél is használ –, kiegészítve a program zárolásával (Touch ID, PIN-kód). A működés ebben nem tér el a közvetlen belépéstől, mindössze lehetővé teszi, hogy a küldeményeket a saját helyi tárhelyére rendezetten letöltse.
- **Felhő mód – későbbi terv:** a többmunkatársas közös irodai munkához később tervezett, szerveralapú változatnál a közös hozzáférés jellegéből adódóan a tisztán lokális adattárolás műszakilag nem alkalmazható; ott az irodai adatokban a Felhasználó adatfeldolgozójaként járunk majd el az [Adatfeldolgozási feltételek](ADATFELDOLGOZASI-FELTETELEK.md) szerint. **A Felhő mód jelenleg még nem érhető el**; e tájékoztató felhő módra vonatkozó pontjai annak későbbi elindulásakor lépnek életbe.

| Adat | Ki az adatkezelő? | Hol van? |
|---|---|---|
| Az Ön fiókja, számlázási adatai, levelezése velünk | **Laczkovszki Gábor E.V.** (ez a tájékoztató) | a mi rendszereinkben |
| Helyi módban: az ügyfelei és a cégek adatai, a letöltött iratok, a NAV- és ASP-adatok, a belépési adatok | **Ön** (a szoftvert a saját gépén futtató Felhasználó / könyvelőiroda) | **kizárólag az Ön gépén**; mi nem tároljuk és nem férünk hozzá (kivéve, ha külön bekapcsolja az MCP-közvetítőt – lásd lent) |
| Felhő módban (későbbi terv): ugyanezek az irodai adatok | **Ön** az adatkezelő, **mi az adatfeldolgozója** vagyunk | a felhő mód szerverén – lásd az [Adatfeldolgozási feltételeket](ADATFELDOLGOZASI-FELTETELEK.md) |
| Az Ön által bekapcsolt AI-asszisztensnek (például ChatGPT, Google Antigravity, Claude) átadott adat | **Ön**, illetve az Ön által választott AI-szolgáltató (OpenAI, Google, Anthropic stb.) | az AI-szolgáltatónál, az Ön szerződése szerint, jellemzően az USA-ban |
| Az Ön SMTP-kiszolgálóján kiküldött értesítők | **Ön** | az Ön levelezőszolgáltatójánál |

**A letöltési és átvételi beállítások felelőssége:** Hogy a Szoftver a Felhasználó gépén mit és hogyan tölt le, mit nyit meg, és ennek eredményeként mikortól minősül átvettnek egy küldemény, azt minden esetben a Felhasználó állítja be; ezekért a beállításokért és az általuk kiváltott adatkezelési és jogi hatásokért minden esetben a Felhasználó felel (ÁSZF 8.1. pont).

Ha Ön a könyvelőiroda **ügyfele**, és arról szeretne tájékozódni, hogyan kezelik az adatait az irodában, a könyvelőirodához forduljon: a KapuMail az iroda eszköze, az adatkezelésről az iroda dönt.

Az AI-asszisztens csatlakoztatása **választható, alapból kikapcsolt** funkció, amelyet Ön saját felelősségére kapcsolhat be (ÁSZF 10. pont). Az AI-szolgáltató nem a mi adatfeldolgozónk: mi nem adunk át neki adatot, csak az Ön által bekapcsolt kapcsolaton át, az Ön által választott szinten fér hozzá. Bekapcsolás előtt érdemes ellenőrizni, hogy a választott AI-előfizetés felhasználja-e az adatokat modelltanításra.

Helyi módban az AI-asszisztens az Ön gépét csak akkor éri el, ha Ön a programban külön bekapcsolja az **MCP-közvetítőt** (mcp.kapumail.hu, ÁSZF 10.5. pont). Ilyenkor az AI-asszisztens kérései és a program válaszai a mi frankfurti szerverünkön haladnak át. Ezekben az adatokban az Ön adatfeldolgozójaként járunk el ([Adatfeldolgozási feltételek](ADATFELDOLGOZASI-FELTETELEK.md)): a tartalmukat nem tároljuk és nem naplózzuk, csak a működéshez szükséges üzemeltetési adatokat (kapcsolatazonosító, utolsó jelentkezés ideje, darabszámok, állapotkódok; a regisztráló IP-címét legfeljebb egy óráig, csak a memóriában) kezeljük. A közvetítőt bármikor kikapcsolhatja.

## 2. Az adatkezelő

| | |
|---|---|
| Név | Laczkovszki Gábor E.V. (egyéni vállalkozó) |
| Székhely | 2600 Vác, Deákvári fasor 35. fsz. 4. |
| Nyilvántartási szám | 62354624 (nyilvántartó hatóság: Nemzeti Adó- és Vámhivatal) |
| Adószám | 92080564-1-33 |
| Adatvédelmi kapcsolattartás | info@kapumail.hu |
| Telefon | +36 20 886 1309 |

## 3. Az egyes adatkezelések

### 3.1. Felhasználói fiók és a szerződés teljesítése

- **Érintettek:** a Felhasználó (könyvelőiroda) képviselője, kapcsolattartója, egyéni vállalkozó Felhasználó; felhő módban a Munkatársak.
- **Adatok:** név, e-mail-cím, iroda neve, telefonszám (ha megadja), szerepkör, a fiók létrehozásának és az ÁSZF elfogadásának időpontja és a hozzá tartozó nyilatkozatok, licencazonosító, csomag.
- **Cél:** a Szerződés megkötése és teljesítése, fiókkezelés, a kiemelt ÁSZF-rendelkezések elfogadásának bizonyítása.
- **Jogalap:** GDPR 6. cikk (1) b) (szerződés teljesítése); ha a Felhasználó jogi személy, a képviselő és a kapcsolattartó adatainál GDPR 6. cikk (1) f) (a Felhasználó és az Adatkezelő jogos érdeke a kapcsolattartáshoz).
- **Időtartam:** a Szerződés megszűnésétől számított 5 év (a Ptk. általános elévülési ideje).

Helyi módban a fiók és a hivatalos kiadás 14 napos próbaidőszakának kezdő időpontja kizárólag a Felhasználó saját gépén jön létre és tárolódik; a nevet és az e-mail-címet a Szoftver a gépen tárolja. Hozzánk ezek csak akkor kerülnek, ha Ön előfizet a weboldalon vagy ügyfélszolgálatunkhoz fordul.

### 3.2. Számlázás és díjfizetés

- **Adatok:** számlázási név, cím, adószám, e-mail-cím, a fizetés adatai (összeg, időpont, tranzakcióazonosító). Bankkártyaadatot nem kezelünk; azt a fizetési szolgáltató kezeli.
- **Cél:** a Díj beszedése, számla kiállítása, könyvelés.
- **Jogalap:** GDPR 6. cikk (1) c) (jogi kötelezettség: a számvitelről szóló 2000. évi C. törvény 169. §, az általános forgalmi adóról szóló 2007. évi CXXVII. törvény); a fizetés lebonyolításánál 6. cikk (1) b).
- **Időtartam:** a számviteli bizonylatokat 8 évig őrizzük.

### 3.3. Ügyfélszolgálat, hibabejelentés, panasz

- **Adatok:** név, e-mail-cím, a levelezés tartalma, a csatolt fájlok, a Szoftver verziója, operációs rendszer, hibanapló.
- **Cél:** kérdések megválaszolása, hibák kivizsgálása, panaszkezelés.
- **Jogalap:** GDPR 6. cikk (1) b) (a szerződés teljesítése); szerződés előtti megkeresésnél 6. cikk (1) f) (jogos érdek a megkeresés megválaszolásához).
- **Időtartam:** az ügy lezárásától számított 1 év; panasz esetén 5 év.
- **Fontos:** kérjük, hibabejelentéshez ne küldjön ügyfeleitől származó iratot, adóadatot vagy belépési adatot. Ha mégis küld, azt Ön mint adatkezelő adja át, és arra az [Adatfeldolgozási feltételek](ADATFELDOLGOZASI-FELTETELEK.md) vonatkoznak; a kivizsgálás után 30 napon belül töröljük.

### 3.4. A Szoftver hálózati kapcsolatai

- A Szoftver a Felhasználó gépéről kizárólag az Állami rendszerekhez (például tarhely.gov.hu, a NAV és az önkormányzati adóportálok felületei), a Felhasználó által megadott levelezőszerverhez és – ha a Felhasználó bekapcsolja – az általa választott AI-szolgáltatóhoz kapcsolódik.
- A Szoftver a Szolgáltató szervereihez **nem küld** iratot, ügyféladatot, adóadatot, belépési adatot, hibajelentést vagy használati adatot. A Szoftver a szerződési feltételek és e tájékoztató hatályos szövegét, a nyilvános hatósági nyomtatvány- és irattípus-katalógust, valamint az elérhető legújabb kiadás nyilvános verzióadatait (`latest.json`) a https://kapumail.hu oldalról süti és egyedi azonosító nélkül lekérheti, továbbá a frissítőcsomagok is a weboldalról tölthetők le a Felhasználó kezdeményezésére; ilyenkor kizárólag a 3.5. pont szerinti szokásos kiszolgálói napló keletkezik.
- A hivatalos kiadás a 14 napos próbaidőszakot és a megadott előfizetési licenckulcs kriptográfiai aláírását **helyben, offline** ellenőrzi a Felhasználó számítógépén, háttérbeli hálózati licenclekérdezés és ügyféladat-küldés nélkül. Ha a jövőben online licencellenőrzést vezetünk be, ennek adatkezelését e tájékoztató módosításával, előzetesen közöljük.

### 3.5. A weboldal (kapumail.hu), műszaki hibakövetés és a sütik

- **Adatok:** IP-cím, böngésző típusa, a látogatás ideje, a megtekintett oldal (kiszolgálói napló); továbbá a weboldal és az online előfizetési felület műszaki hibája esetén a hibakereséshez szükséges technikai hibajelentés (hibaüzenet és veremnyom, böngésző és operációs rendszer típusa, az érintett oldal címe titkos tokenek, licenckulcsok és személyes vásárlói adatok kiszűrésével).
- **Cél és jogalap:** a weboldal és az előfizetési rendszer biztonságos, hibamentes működése, az esetleges fizetési vagy megjelenítési hibák felderítése és elhárítása, GDPR 6. cikk (1) f) (jogos érdek).
- **Időtartam:** a kiszolgálói napló 30 napig; a műszaki hibajelentések legfeljebb 90 napig.
- **Sütik:** a weboldal nem használ sütit, munkamenet-felvételt (Session Replay), analitikát és hirdetéskövetést; a weboldali hibakövetés is sütimentesen működik. Ha ez változik, nem szükséges sütit csak az Ön hozzájárulásával helyezünk el (az elektronikus hírközlésről szóló 2003. évi C. törvény 155. § (4) bekezdés; GDPR 6. cikk (1) a)), amelyet bármikor visszavonhat.

### 3.6. Hírlevél és szakmai tájékoztatók

- **Adatok:** név, e-mail-cím, a feliratkozás időpontja.
- **Jogalap:** GDPR 6. cikk (1) a) (hozzájárulás), a gazdasági reklámtevékenység alapvető feltételeiről szóló 2008. évi XLVIII. törvény 6. §-a szerint.
- **Időtartam:** a leiratkozásig. A leiratkozás minden levél alján egy kattintással lehetséges.
- A szolgáltatással kapcsolatos rendszerüzeneteket (például ÁSZF-módosítás, díjváltozás, biztonsági értesítés) a 3.1. pont alapján hírlevél-feliratkozás nélkül is küldjük.

### 3.7. Jogi igények és a bizonyítás

- **Cél:** jogi igények előterjesztése, érvényesítése, védelme; az ÁSZF és a kiemelt rendelkezések elfogadásának bizonyítása.
- **Jogalap:** GDPR 6. cikk (1) f).
- **Időtartam:** az elévülési idő végéig, folyamatban lévő eljárásnál annak jogerős lezárásáig.

## 4. Adatfeldolgozóink és címzettek

| Adatfeldolgozó | Feladat | Helyszín, továbbítás |
|---|---|---|
| DigitalOcean, LLC (101 6th Ave, New York, NY 10013, USA) | a weboldal, (felhő módban) a szerver, valamint (helyi módban, ha Ön bekapcsolja) az MCP-közvetítő üzemeltetése | Frankfurt, Németország (fra1); az USA-beli anyavállalat felé általános szerződési feltételek (SCC) és az EU–USA adatvédelmi keret |
| Stripe Technology Europe, Limited (The One Building, 1 Grand Canal Street Lower, Dublin 2, Írország) | online bankkártyás fizetés lebonyolítása | Írország (EGT); a Stripe, Inc. (USA) felé általános szerződési feltételek (SCC) és az EU–USA adatvédelmi keret |
| KBOSS.hu Kft. – Számlázz.hu (1031 Budapest, Záhony utca 7.; cégjegyzékszám: 01-09-303201) | számlakiállítás | Magyarország |
| SendGrid, Inc. (1801 California Street, Suite 500, Denver, CO 80202, USA) | rendszerüzenetek küldése | USA; általános szerződési feltételek (SCC) és az EU–USA adatvédelmi keret |
| Mailgun Technologies, Inc. (112 E Pecan St. #1135, San Antonio, TX 78205, USA) | hírlevélküldés | USA; általános szerződési feltételek (SCC) és az EU–USA adatvédelmi keret |
| Fin-S Könyvelőiroda Kft. (2142 Nagytarcsa, Vadrózsa utca 11.; cégjegyzékszám: 13-09-134900) | könyvelés | Magyarország |
| Functional Software, Inc. – Sentry (45 Fremont Street, 8th Floor, San Francisco, CA 94105, USA) | a kapumail.hu weboldal és előfizetési háttérszolgáltatás sütimentes, személyesadat-szűrt műszaki hibakövetése (a helyi Szoftver nem küld hibajelentést) | USA; általános szerződési feltételek (SCC) és az EU–USA adatvédelmi keret |

Hatóságnak, bíróságnak csak jogszabályi kötelezettség alapján adunk át adatot.

## 5. Adatbiztonság

Az adatokat titkosított kapcsolaton (TLS) továbbítjuk, a hozzáférést szerepkörhöz és kétlépcsős azonosításhoz kötjük, a rendszereket rendszeresen frissítjük, és naplózzuk a hozzáféréseket. Helyi módban a Szoftver a belépési adatokat kizárólag a Felhasználó gépének operációs rendszer szintű, titkosított kulcstartójában (macOS Kulcskarika, Windows Hitelesítőadat-kezelő – ugyanabban a rendszertárban, amely az Ügyfélkapu-belépések jelszavait is védi) tárolja, és az alkalmazás zárolását (PIN-kód, Touch ID) kínálja; ezek bekapcsolása, a letöltési szabályok beállítása és a számítógép védelme a Felhasználó feladata.

## 6. Az Ön jogai

Ön a 2. pontban megadott elérhetőségen kérheti:

- **tájékoztatást és hozzáférést** az adataihoz (GDPR 15. cikk);
- adatai **helyesbítését** (16. cikk);
- adatai **törlését** (17. cikk), ha a kezelésnek nincs más jogalapja (például a számviteli megőrzés);
- az adatkezelés **korlátozását** (18. cikk);
- adatai **hordozható** formában való kiadását (20. cikk);
- **tiltakozhat** a jogos érdeken alapuló adatkezelés ellen (21. cikk);
- a hozzájárulását bármikor **visszavonhatja**, ami a korábbi adatkezelés jogszerűségét nem érinti.

A kérelemre legkésőbb egy hónapon belül válaszolunk; ez indokolt esetben további két hónappal meghosszabbítható, amiről értesítjük.

## 7. Jogorvoslat

Panaszával a Nemzeti Adatvédelmi és Információszabadság Hatósághoz fordulhat:

- cím: 1055 Budapest, Falk Miksa utca 9–11.
- postacím: 1363 Budapest, Pf. 9.
- telefon: +36 1 391 1400
- e-mail: ugyfelszolgalat@naih.hu
- honlap: https://naih.hu

Jogai megsértése esetén bírósághoz is fordulhat; a pert lakóhelye vagy tartózkodási helye szerinti törvényszéken is megindíthatja (GDPR 79. cikk, Infotv. 23. §).

## 8. A tájékoztató módosítása

A tájékoztatót a jogszabályok és a Szolgáltatás változásához igazítjuk. A lényeges változásokról e-mailben és a Szoftverben értesítjük.
