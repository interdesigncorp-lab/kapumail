# ADR-003: Dokumentumtár – helyi eredeti, központi metaadat

Állapot: **javasolt, nyitott üzleti kérdéssel** · 2026-11-11

## Döntés az MVP-re

| Adat | Hol | Megjegyzés |
|---|---|---|
| Eredeti fájl (ES3, PDF, csatolmány), bájtra változatlanul | Az asztali kliens titkosított helyi tára | SHA-256 a mentéskor; a fájl csak olvasható |
| SHA-256, méret, fájlnév, MIME, aláírás-ellenőrzés eredménye | Központi adatbázis | A hash bizonyítja a változatlanságot |
| Küldemény metaadata, állapotok, feladatok, megjegyzések | Központi adatbázis | |
| Kivont szöveg kereséshez | Központi adatbázis, **csak ha az iroda engedélyezi** | Ügyfélszintű kapcsoló |

A helyi tár: SQLite titkosítva (R06: `better-sqlite3-multiple-ciphers`), a kulcs az OS titoktárában.

## Miért

- Az eredeti iratok a legérzékenyebb adatok; ha nem kerülnek a szerverre, egy szerveroldali incidens hatása töredéknyi.
- A központi tárolás adatfeldolgozói szerződést és hatásvizsgálatot tesz szükségessé (lásd R03 és ADR-004); ezt nem akarjuk az MVP feltételévé tenni.

## Ismert hátrány

Ha az iratot az egyik munkatárs gépe töltötte le, a másik nem látja a tartalmát, csak a metaadatot. Az MVP-ben ez vállalt korlát; a felület kiírja, kinek a gépén van az eredeti.

## Nyitott kérdés (tulajdonosi döntés)

Kell-e központi, végpontok között titkosított dokumentumtár, hogy az irodán belül bárki megnyithassa az átvett iratot? Ha igen: irodai kulccsal titkosított feltöltés, a szerver nem látja a tartalmat. Ez MVP utáni epik, és a hosszú távú megőrzés jogi/üzleti követelményeinek tisztázását igényli.
