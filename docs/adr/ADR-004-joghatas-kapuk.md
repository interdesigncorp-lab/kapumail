# ADR-004: Joghatás-kapuk és a tárhelyműveletek besorolása

Állapot: **elfogadva a fejlesztéshez; a besorolás feloldása ügyvédi és üzemeltetői válaszra vár** · 2026-11-11
**Részben felülírta** (tulajdonosi döntéssel, 2026-11-12): a felügyelet nélküli belépést és listázást az [ADR-006](ADR-006-titokkezeles.md) és az [ADR-008](ADR-008-http-alapu-tarhely-hivasok.md), az élő letöltést az [ADR-009](ADR-009-tipusonkenti-letoltesi-szabaly.md). A tartós tár, a törlés és a küldés besorolása itt marad érvényben.
Bizonyíték: [R03 jogi kézbesítési műveleti mátrix](../../research/R03-jogi-kezbesitesi-muveleti-matrix.md), [R01](../../research/R01-tarhely-cli-es-gitjog-audit.md)

Ez nem jogi tanácsadás. Az R03 forrásolt kutatási összefoglaló, amelyet ügyvédnek kell felülvizsgálnia.

## Amit a kutatás megállapított

| Kérdés | Megállapítás | Szint |
|---|---|---|
| Hatályos szabályozás | A Digitális Államról szóló 2023. évi CIII. törvény és a 322/2024. Korm. rendelet | Forrásból betöltve |
| Kézbesítési vélelem | Átvétel hiányában második értesítés, majd újabb határidő után beáll (322/2024. 42. §; Dáptv. 27. §) | Forrásból; a pontos szöveg ügyvédi ellenőrzésre |
| A listázás vagy a metaadat megtekintése átvétel-e | Sem a törvény, sem a rendelet nem határozza meg az átvételt műveletként | **NEM BIZONYÍTOTT** |
| Gépi letöltés hivatali tárhelyen | Átvételnek számít és a küldemény törlődik (322/2024. 43. § (6)); cégkapura ellenőrizendő | Forrásból, részben ellenőrizendő |
| Tartós tár joghatása | Csak tájékoztató oldalak, jogszabályhely nem került elő | **NEM BIZONYÍTOTT** |
| Belépés az ügyfél saját azonosítójával | A hatályos felhasználási feltételek nem voltak elérhetők | **BLOKKOLT** |
| Harmadik fél szoftverének gépi hozzáférése | Szervezeti tárhelyre regisztrált programmal van jogalap; természetes személy tárhelyére nincs forrás | **BLOKKOLT** |
| Adóhatósági iratok | Nincs külön vélelem; meghatalmazott esetén a képviselőnek kell kézbesíteni (Air. 79. §) | Forrásból |

A legfontosabb következmény: **élő tárhelyen jelenleg a listázás sem tekinthető bizonyítottan joghatás nélkülinek.** A specifikáció „(A) bizonyítottan joghatás nélküli listázás automatikus” osztálya ma üres.

## Döntés

1. A műveletek besorolása egyetlen helyen él: [app/config/iratkapu.php](../../app/config/iratkapu.php). A szerver őrfüggvénye (`ConnectorGuard`) minden tárhelyművelet előtt ebből dönt; a felületről nem módosítható.
2. Két üzemmód van:
   - **demó** – beépített minta-csatlakozó, valódi tárhely nélkül. Minden folyamat kipróbálható.
   - **élő** – nincs megvalósítva; minden tárhelyművelet zárolva, a zárolás oka naplózva. A jóváhagyási folyamat végigmegy, de a végén a művelet „zárolt” állapotba kerül.
3. Az őr szabályai mindkét módban érvényesek:

| Szabály | Hol ellenőrzött |
|---|---|
| Joghatású lehet → rendszer (ütemező, újrapróbálkozás) nem indíthatja | `test_letoltes_rendszerbol_es_jovahagyas_nelkul_elutasitva` |
| Jóváhagyás kell → csak erre az iratra és műveletre szóló, jóváhagyott kéréssel | ugyanott |
| A kérelmező nem lehet a jóváhagyó; könyvelő nem hagyhat jóvá | `test_sajat_kerest_nem_lehet_jovahagyni…` |
| Lejárt meghatalmazásnál nincs tárhelyművelet | `test_lejart_meghatalmazasnal_nincs_tarhelymuvelet` |
| Törlés és küldés soha | `test_torles_es_kuldes_soha_nem_engedelyezett` |
| Élő módban jóváhagyás után is zárolt | `test_elo_modban_a_jovahagyas_utan_is_zarolt…` |
| Minden elutasítás és indítás auditálva | az őr maga írja |

## Jelenlegi besorolás

| Művelet | Lehetséges joghatás | Jóváhagyás | Háttérben futhat | Élő tárhelyen |
|---|---|---|---|---|
| Tárhelyek listázása | nem ismert | nem | igen | NEM BIZONYÍTOTT |
| Küldemények listázása | nem ismert | nem | igen | NEM BIZONYÍTOTT |
| Részletek lekérése | nem ismert | igen | nem | NEM BIZONYÍTOTT |
| Igazolás lekérése | nem ismert | igen | nem | NEM BIZONYÍTOTT |
| Átvétel, letöltés | lehetséges | igen | nem | BLOKKOLT |
| Tartós tárba helyezés | nem ismert | igen | nem | BLOKKOLT |
| Törlés | biztos | – | nem | TILTOTT |
| Küldés | biztos | – | nem | TILTOTT |

Megjegyzés: az R03 óvatosabb javaslata szerint élőben a listázás is jóváhagyáshoz kötendő, amíg nincs válasz. Ezt az „élő mód zárolva” állapot ma erősebben teljesíti. A feloldáskor külön döntés kell arról, hogy a listázás jóváhagyásköteles legyen-e.

## Mi oldja fel

| Kapu | Kell hozzá |
|---|---|
| Élő listázás | Ügyvédi állásfoglalás + az üzemeltető válasza + jegyzőkönyvezett élő próba kijelölt saját tárhelyen |
| Élő átvétel jóváhagyással | Ugyanez, továbbá a letöltési igazolás kezelésének tisztázása |
| TOTP-kulcs tárolása, gépi belépés | A hatályos felhasználási feltételek és ügyvédi állásfoglalás ([ADR-006](ADR-006-titokkezeles.md)) |
| Tartós tár | Jogszabályhely vagy üzemeltetői válasz + csatlakozó-támogatás |

A konkrétan megfogalmazott kérdések az R03 végén találhatók, ügyvédnek és üzemeltetőnek külön.

## Változtatási szabály

A `config/iratkapu.php` `operations` tömbjének bármely módosítása jogi felülvizsgálói jóváhagyáshoz kötött, és a `policy_version` emelésével jár. A `tests/Feature/KapukTest.php` kapu-tesztjei nem gyengíthetők ugyanabban a változtatásban.
