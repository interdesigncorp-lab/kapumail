# ADR-005: ES3-olvasás és hitelességvizsgálat

Állapot: **javasolt; az érvényesítő kiválasztása PoC-től függ** · 2026-11-11
Bizonyíték: [R04](../../research/R04-es3-es-hitelessegvizsgalat.md)

## Tények (R04)

- Az `.es3` a Microsec e-akta formátuma: XML-konténer, a dokumentumok base64-ben a `ds:Object` elemekben, opcionálisan tömörítve vagy titkosítva. Dokumentum- és keretaláírás (XAdES) és időbélyeg is lehet benne. **Nem ZIP és nem ASiC.** Nyilvános specifikáció van.
- Az EU DSS könyvtár (LGPL 2.1, Java) kezeli a XAdES-t, a megbízható listákat és a visszavonást. Hogy az es3 konténert közvetlenül érti-e: **NEM BIZONYÍTOTT.**
- A Microsec e-Szignó SDK natívan érti az e-aktát; fizetős, szerződéses, a platformlista és az ár **NEM BIZONYÍTOTT.**
- Nyilvánosan letölthető teszt-es3 nem került elő.

## Döntés

Két külön lépés, két külön eredménnyel – a felület soha nem mossa össze őket:

1. **Kibontás (saját olvasó, helyben).** A nyilvános specifikáció alapján: tartalomjegyzék, beágyazott PDF/XML kinyerése, beágyazott akták kezelése, fájlnév- és MIME-normalizálás. Eredmény: *kibontva / nem bontható ki*.
2. **Hitelességvizsgálat (érvényesítő komponens).** Eredmény négy állapot egyike:

| ETSI EN 319 102-1 eredmény | Állapot a felületen |
|---|---|
| TOTAL-PASSED | Érvényes |
| TOTAL-FAILED | Érvénytelen |
| INDETERMINATE | Nem ellenőrizhető (az alindikációval együtt mentve) |
| – (még fut, vagy újrapróbálásra vár) | Ellenőrzés folyamatban |

A sikeres kibontás önmagában soha nem ad „érvényes” állapotot. A részletes jelentést és az ellenőrzés idejét bizonyítékként mentjük.

Az érvényesítő kiválasztása a PoC eredményétől függ: első jelölt az EU DSS, tartalék az e-Szignó SDK. A DSS Java-alapú, ezért kis helyi szolgáltatásként vagy szerveroldalon futna – ha szerveroldalon, az ütközik az ADR-003-mal (az eredeti fájl nem megy fel), ezért elsődlegesen **helyi futtatás** a cél; a csomagolás terhe a PoC-ben mérendő.

## Megvalósult köztes lépés (2026-11-11)

Teljes érvényesítő hiányában a kipróbálható változat az aláírások **kriptográfiai sértetlenségét** ellenőrzi az `xmlseclibs` könyvtárral ([app/app/Iratkapu/Signature.php](../../app/app/Iratkapu/Signature.php)):

| Eredmény | Állapot a felületen |
|---|---|
| Bármely aláírás lenyomata vagy aláírásértéke hibás | Érvénytelen |
| Minden aláírás sértetlen | Nem ellenőrizhető – a lánc, a megbízható lista, a visszavonás és az időbélyeg nincs vizsgálva |
| Külső hivatkozás, nem támogatott transzformáció, hiányzó tanúsítvány, nem egyértelmű hivatkozás | Nem ellenőrizhető |

„Érvényes” ebből a komponensből soha nem jöhet. Külső hivatkozást nem követ. Csak saját készítésű, önaláírt mintán van kipróbálva (manipulált tartalom, sérült aláírásérték, külső hivatkozás); valódi hatósági XAdES-aláíráson nem. A teljes érvényesítő kiválasztása továbbra is a lenti PoC-től függ.

## Az olvasó biztonsági korlátai

| Veszély | Védekezés |
|---|---|
| XXE, külső entitás, entitásbomba | DTD és külső entitás tiltva az XML-olvasóban |
| Túlméretezett base64 vagy tömörített tartalom | Fájlméret-, kibontott méret- és aránykorlát; folyamalapú dekódolás |
| Mélyen egymásba ágyazott akták | Mélységkorlát |
| Túl sok elem | Elemszámkorlát |
| Útvonal-bejárás a fájlnévben | Normalizálás; a fájl soha nem az aktabeli néven íródik lemezre |
| Lefagyás | Időkorlát; külön folyamat, amely megölhető |
| Kártékony csatolmány | Megnyitás előtt ellenőrzés; makrós és futtatható típus külön figyelmeztetéssel |

Bármelyik korlát sérülése: *nem bontható ki*, részleges „érvényes” állapot nélkül.

## PoC-terv

1. Olvasóváz a nyilvános specifikációból, szintetikus mintával.
2. Korlátok és a rosszindulatú minták tesztjei (XXE, bomba, mélység, útvonal).
3. SHA-256 mentés és változatlanság-ellenőrzés.
4. **[BLOKKOLT]** Valódi, jogszerűen beszerzett es3 megnyitása, PDF kinyerése.
5. **[BLOKKOLT]** EU DSS futtatása a valódi mintán: érti-e a konténert, milyen szintű az aláírás.
6. **[BLOKKOLT]** Ha a DSS nem elég: e-Szignó SDK ajánlatkérés és próba.
7. Döntés az érvényesítőről és a futtatás helyéről.

## Mi oldja fel a blokkolást

A megrendelő ad legalább 3–5 valódi es3 fájlt (pl. saját cégbírósági végzés, NAV-irat), amelyek tesztelésre használhatók. Az 1–3. lépés enélkül is elvégezhető.
