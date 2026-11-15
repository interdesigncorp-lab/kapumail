# Biztonsági irányelvek (Security Policy)

A KapuMail fejlesztői elkötelezettek a felhasználói adatok és az elektronikus közigazgatási iratok védelme iránt. Köszönjük a biztonsági kutatók és a közösség munkáját, amellyel hozzájárulnak a szoftver biztonságához.

---

## Támogatott verziók

A biztonsági frissítéseket az alábbi verziókhoz biztosítjuk:

| Verzió | Támogatott | Megjegyzés |
|---|---|---|
| `0.2.x` | :white_check_mark: | Jelenlegi stabil és aktívan támogatott kiadás |
| `< 0.2.0` | :x: | Nem támogatott |

---

## Sebezhetőségek felelős bejelentése

Ha feltételezett biztonsági rést vagy sebezhetőséget fedezel fel a KapuMail alkalmazásban, kérjük, hogy **kizárólag privát csatornán**, közvetlenül értesíts bennünket.

**Kérjük, NE hozz létre nyilvános GitHub Issue-t, Pull Requestet vagy vitaindítót a biztonsági hibákról!**

### Bejelentési csatorna
- **E-mail:** `info@kapumail.hu`
- **Tárgymező formátuma:** `[SECURITY] KapuMail sebezhetőség - <rövid leírás>`

### Szükséges adatok a bejelentésben
A gyors és hatékony kivizsgálás érdekében kérjük, mellékeld az alábbiakat:
1. **Érintett verzió és környezet:** pontos verziószám (pl. 0.2.0), operációs rendszer és architektúra (pl. macOS Sequoia 15.1 arm64, Windows 11 x64).
2. **Érintett modul / funkció:** pl. helyi szerver, titoktár, token-kezelés, hálózati kommunikáció.
3. **Reprodukciós lépések (PoC):** lépésről lépésre követhető leírás, amellyel a hiba megbízhatóan előidézhető.
4. **Becsült hatás:** milyen kockázatot jelent a sérülékenység (pl. helyi jogosultságkiterjesztés, adatszivárgás, integritássértés).

---

## Válaszadási SLA és kezelési folyamat

1. **Visszaigazolás (48 órán belül):** Visszaigazoljuk a bejelentés beérkezését, és megkezdjük a vizsgálatot.
2. **Szakmai értékelés és ütemterv (7 napon belül):** Elvégezzük a sebezhetőség validációját, és tájékoztatást küldünk az orvoslás várható ütemezéséről.
3. **Javítás és koordinált közzététel:** A javítást hivatalos kiadásban publikáljuk. A bejelentő kérésére köszönetnyilvánításban részesítjük a kiadási jegyzékben (Release Notes).

---

## Safe Harbor (Jóhiszemű kutatók védelme)

Nagyra értékeljük a biztonsági kutatók munkáját. Nem indítunk jogi eljárást olyan felek ellen, akik:
- Jóhiszeműen, a felhasználók és rendszerek védelme érdekében járnak el.
- Kerülik a felhasználói adatok jogosulatlan megtekintését, módosítását, törlését vagy nyilvánosságra hozatalát.
- Nem okoznak szolgáltatáskiesést vagy túlterhelést.
- Lehetőséget biztosítanak a hiba ésszerű határidőn belüli javítására a nyilvános közzététel előtt.
