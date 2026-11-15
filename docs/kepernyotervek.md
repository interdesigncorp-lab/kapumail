# Képernyőtervek

Állapot: R05 UX prototípus kész. Forrás: [prototype/index.html](../prototype/index.html), kitalált mintaadatokkal, tárhelykapcsolat nélkül.

Indítás:

```bash
python3 -m http.server 4173 --directory prototype
```

A prototípus egyetlen HTML fájl, keretrendszer nélkül. A végleges felület React-komponensekből épül (lásd [ADR-001](adr/ADR-001-platform.md)); a prototípus a viselkedést és a vizuális nyelvet rögzíti, nem a kódot.

## Vizuális nyelv

| Elem | Döntés |
|---|---|
| Háttér | Pasztell rózsaszín–lila–barack átmenet, elmosott foltokkal |
| Ablak | Áttetsző üveg (`backdrop-filter`), 28 px lekerekítés |
| Ikonsáv | Fekete (`#15131c`), lebegő, lekerekített; az aktív ikon fehér |
| Szöveges felületek | Közel opak fehér: kijelölt sor, kártyák, előnézet, táblázatok |
| Kiemelő szín | Ibolya `#4a36e0` – csak aktív állapotra, fókuszra, számlálóra |
| Betűtípus | Figtree (latin-ext, ő/ű támogatással) |
| Állapotok | Mindig ikon + szöveg + szín; szín önmagában soha |

A referencia (fekete ikonsáv, pasztell oldalsáv, lebegő kereső, jobb gombos menü) ihlette, de saját arculat: más betű, más színrendszer, más szerkezet a részletnézetben.

## Képernyők

| # | Képernyő | Mit old meg | Spec-hivatkozás |
|---|---|---|---|
| 1 | Áttekintés | Reggeli indulás: mi vár átvételre, mi sürgős, mi jár le ma, melyik tárhely nem naprakész; „Ezzel kezdd” lista a következő lépéssel | 2.5 dashboard |
| 2 | Bejövő iratok | Háromoszlopos fő nézet: mappák és ügyfelek, lista, részlet | 2.1–2.4 |
| 3 | Feladatok | Minden teendő irathoz kötve; enyéim / nyitott / mind | 2.5, E07 |
| 4 | Határidők | Háromhetes naptár és sorrendi lista; megerősített és becsült külön jelöléssel | 2.5, 3 |
| 5 | Ügyfelek és tárhelyek | Ügyféllista szinkron- és meghatalmazás-állapottal; ügyféladatlap; csatlakoztatási varázsló | 2.5, E01 |
| 6 | Szabályok | Irattípus-szabály szerkesztése kifejezett mentéssel, szárazfutással, verziószámmal | 3, E07 |
| 7 | Szinkronnapló | Tárhelyenkénti állapot: kész / részben kész / fut / beavatkozás kell | 2.5, E08 |
| 8 | Auditnapló | Csak bővíthető napló; ki, mit, mikor, melyik ügyfélnél, milyen bizonyítékkal | 6, E08 |
| 9 | Beállítások | Munkatársak és szerepkörök, emlékeztetők, átvételi szabályzat, megjelenés | 2.5 |

## A bejövő nézet részletei

**Bal oszlop.** Mappák: Összes bejövő, Átvételre vár, Sürgős, Ma esedékes, Nekem kiosztott, Feldolgozás alatt, Kész, Archivált, Rendszerüzenetek. Alatta kereshető ügyféllista; a hibás szinkronú ügyfél háromszög jelet kap (nem csak más színt). Az oszlop az ikonsáv tetején lévő gombbal összecsukható.

**Középső oszlop.** Kereső (tárgy, ügyfél, adószám, feladó, típus), gyorsszűrő (Mind / Olvasatlan / Teendő van), nyugták elrejtése, tárhelytípus és feladó szűrő. Sor: feladó jelvénye, ügyfél, tárhely, felelős, érkezés, tárgy, hivatalos állapot, sürgősség, határidő, ES3 jelzés. Napi csoportosítás. Kijelöléskor alul megjelenik a tömeges műveletsáv – csak belső műveletekkel.

**Jobb oszlop.** Eszköztár (kiosztás, olvasott, kész, archiválás, eredeti tárhely), majd:

- **Két állapotsáv egymás mellett.** Sötét: hivatalos állapot, csak a tárhely igazolása alapján változik. Világos: irodai feldolgozás. Ez a felület fő megkülönböztető eleme.
- **Előnézet vagy zár.** Átvett iratnál a dokumentum; át nem vett iratnál zárolt kártya, amely csak a listából ismert adatokat mutatja.
- **Határidő-kártya.** Megerősített / becsült / ismeretlen; a becsült egy kattintással megerősíthető.
- **Teendők, hitelesség, megjegyzések és napló.**

## Rögzített viselkedési szabályok

Ezeket a végleges megvalósításnak is tartania kell.

1. A belső „olvasott” jelölés soha nem változtat a hivatalos állapoton. A visszajelző szöveg ezt ki is mondja.
2. Át nem vett irat tartalma nem jelenik meg. Az átvétel csak a részletnézetből, megerősítő ablakból, jóváhagyó megnevezésével kérhető; a kérés után az irat továbbra is „nincs átvéve”.
3. Átvételre váró irat nem zárható le készként, sem egyenként, sem tömegesen.
4. Tömeges művelet csak belső: kiosztás, olvasott, kész.
5. Becsült határidő mindig szaggatott keretes, „≈” jellel; át nem vett iratnál nincs dátum.
6. Ismeretlen irattípus külön jelölést kap és az Osztályozandó sorban marad; szabály nem oszthatja ki automatikusan.
7. Lejárt hitelesítésnél a rendszer kimondja, hogy a tárhely nem naprakész, és mikor volt az utolsó sikeres szinkron.
8. Szabály csak kifejezett „Szabály mentése” gombbal mentődik; a szárazfutás semmit nem változtat.
9. A csatlakoztatási varázsló nem enged tovább a meghatalmazás megerősítése nélkül, és nem kér be belépési adatot a saját felületén.

## Billentyűzet

| Billentyű | Művelet |
|---|---|
| `J` / `↓`, `K` / `↑` | Következő / előző irat |
| `Enter` | Megnyitás, fókusz a részletekre |
| `/` | Keresés |
| `X` | Kijelölés |
| `A` | Kiosztás nekem |
| `U` | Olvasott / olvasatlan |
| `E` | Kész |
| `Esc` | Vissza a listához, menü bezárása |
| `?` | Súgó |

## Reszponzív viselkedés

| Szélesség | Elrendezés |
|---|---|
| 1180 px felett | Ikonsáv + mappák + lista + részlet |
| 760–1180 px | A részlet rácsúszik a listára, „Lista” gombbal vissza |
| 760 px alatt | A mappaoszlop is elrejtve, az ikonsáv gombjával nyitható; naptár napi listává alakul |

## Ellenőrzöttség

| Mit | Hogyan | Eredmény |
|---|---|---|
| Mind a 9 képernyő betölt, nincs vízszintes görgetés | Böngészőben, 1440 és 375 px | Rendben |
| Átvételkérés, szárazfutás, szabálymentés, varázsló, ügyféladatlap, ugrás irathoz | Szkriptelt kattintások | Rendben |
| Billentyűs lépkedés | Szkriptelt `J` | Rendben |
| Képernyőolvasó | – | **Nincs ellenőrizve** |
| Kontrasztarányok mérése (WCAG AA) | – | **Nincs mérve**, csak tervezési szándék |
| Valós felhasználói próba a négy fő feladattal | – | **Nincs elvégezve** |

## Ami a prototípusból hiányzik

- Mentett nézetek és megosztásuk, URL-ben visszaállítható szűrők.
- Dátumintervallum, címke, hitelesség és fájltípus szerinti szűrés.
- Valódi PDF- és ES3-előnézet.
- Értesítési előnézet és kiküldött levelek listája.
- Sötét téma.
- Ügyfélportál (a spec szerint MVP után).
