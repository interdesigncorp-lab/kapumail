# ADR-009: Irattípusonkénti letöltési szabály

Állapot: **elfogadva (tulajdonosi döntés)** · 2026-11-12
Előzmény: [ADR-004](ADR-004-joghatas-kapuk.md), [ADR-006](ADR-006-titokkezeles.md), [ADR-008](ADR-008-http-alapu-tarhely-hivasok.md)
Terv: [TERV-KONYVELOI-AUTOMATA-BEJARAS.md](../TERV-KONYVELOI-AUTOMATA-BEJARAS.md)

Ez nem jogi állásfoglalás. A döntés és a jogszerűség megítélésének felelőssége a megrendelőé. Az [R03](../../research/R03-jogi-kezbesitesi-muveleti-matrix.md) továbbra sem ügyvédi munka.

## Mi a kérdés

Az ADR-004 műveletenként osztályoz: élő tárhelyen minden letöltés zárolt. A megrendelő azt kéri, hogy a program az irat fajtája szerint tegyen különbséget: amit letölthet, azt töltse le magától, amit nem vehet át, arról csak tudjon.

## Döntés

1. Minden irattípusnak letöltési szabálya van, három értékkel:
   - `auto` – a program magától letöltheti;
   - `kezi` – csak ember töltheti le, gombnyomással, figyelmeztető megerősítés után;
   - `csak_lista` – a program nem tölti le, kézi parancsra sem. Az irat látszik, átvenni a hivatalos tárhelyen lehet.
2. Kiinduló besorolás az irattípus-listában (`letoltesi_szabaly` oszlop):
   - `auto`: a három NAV-nyugta típus (elfogadó, elutasító, egyéb visszaigazolás);
   - `csak_lista`: minden „magas" becsült átvételi kockázatú típus (határozat, végzés, fizetési meghagyás és felhívás, végrehajtás, jegyzőkönyv), továbbá a bírósági irat és a nem adóhatósági fizetési felszólítás;
   - `kezi`: minden más, és minden ismeretlen típus.
3. Az iroda típusonként felülírhatja: a vezető csak szigoríthat, lazítani az admin tud. Minden módosítás az auditnaplóba kerül.
4. A levelezési szabály „joghatályos felülírás" módja ezután csak **ismert, `kezi` típusú** iratot emelhet automatikusra.

## Amit semmi nem írhat felül

- Ismeretlen típusú iratot a program nem tölt le automatikusan.
- `csak_lista` típusú iratot a program nem tölt le, amíg a típus szabálya ez.
- Hivatali kapu postafiókból nincs automatikus letöltés (a gépi letöltés ott jogszabály szerint átvétel, és az üzenet törlődik).
- A rendszer nevében (felhasználó nélkül) indított letöltést a szerver elutasítja.
- A tárgyból felismert „nyugta" jelző önmagában nem elég; a típus dönt.

## Kiegészítés (2026-11-13): a tárhelyen már átvett „csak lista” irat

Tulajdonosi döntés, nem jogi állásfoglalás. A `csak_lista` típus célja, hogy a program ne vegyen át olyan iratot, amelynek az átvétele határidőt indít. Ha az iratot a hivatalos tárhelyen már átvették, a letöltésnek nincs átvételi tétje.

- „Már átvett" az az irat, amely a tárhelyen a **tartós tárban** van, vagy amelyet a tárhely **megnyitottnak** jelez (`olvasatlan: false`). Az ilyen `csak_lista` típusú irat **kézzel letölthető**, a megerősítő kérdéssel; a felület „csak kézi letöltés" címkével mutatja.
- **Automatikusan így sem tölthető le**, irodai felülíró szabállyal sem.
- Olvasatlan iratnál, és ha a megnyitottság nem ismert, a tiltás marad.

**Vállalt kockázat:** a megnyitottságot a tárhely olvasatlanság-jelzőjéből tudjuk. Nem igazolt, hogy ez jogilag minden esetben egyenlő az átvétellel; a tartós tárnál ilyen kétség nincs. A tulajdonos a megnyitott iratokra is kérte a lazítást.

## Viszony az ADR-004-hez

Az ADR-004 táblázatából a „letöltés / átvétel" sor helyébe ez a döntés lép: az élő letöltés a típus szabálya szerint megy, a szerveroldali főkapcsoló (`IRATKAPU_LIVE_DOWNLOAD`) és a belépőnkénti kapcsoló mögött. A tartós tár, a törlés és a küldés besorolása változatlan. A felügyelet nélküli belépést és listázást az ADR-006 és az ADR-008 engedi; az ADR-004 „feloldási feltételei" ezekre a műveletekre tulajdonosi döntéssel teljesültnek tekintendők, jogi vélemény nélkül.

## Ami nyitva marad

- Ügyvédi vélemény arról, hogy a nyugta letöltése valóban joghatás nélküli-e.
- Üzemeltetői válasz arra, melyik művelet váltja ki az átvételt.
- Élő próba: egy nyugta letöltése a megrendelő saját fiókjából. Amíg ez nincs meg, az automatikus letöltés a felületen „előzetes".
- A típusfelismerés a tárgy szövegére épül, és tévedhet. Ezért a szabály a bizonytalan irányba szigorú: amit a program nem ismer fel, azt nem tölti le magától.
