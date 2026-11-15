## Összefoglaló
<!-- Röviden, magyarul írd le a változtatás célját, a megoldott problémát (pl. Kapcsolódó Issue: #12) és a megvalósítást. -->

## Változás jellege
- [ ] ✨ Új funkció (`feat`)
- [ ] 🐛 Hibajavítás (`fix`)
- [ ] 📝 Dokumentáció (`docs`)
- [ ] 🧪 Teszt / Refaktorálás (`test` / `refactor`)
- [ ] 🔧 Építési rendszer / CI (`build` / `ci`)

## Képernyőkép és a UI-változások megjelölése (KÖTELEZŐ felületi módosításnál)
<!-- Húzd ide a képernyőképet (szigorúan demó / fiktív mintaadatokkal!), és jelöld meg rajta vizuálisan (kerettel / nyíllal) VAGY sorold fel alatta pontokba szedve, pontosan mi került be vagy mi változott a felhasználói felületen! -->

**Mi került be / mi változott a UI-ban:**
- 

<!-- Illeszd be ide a képernyőképe(ke)t (Előtte / Utána vagy az új nézet jelölve): -->


## Minőségbiztosítási és commit-ellenőrzőlista
- [ ] **Képernyőkép csatolva és megjelölve:** Csatoltam képernyőképet a fejlesztésről (kizárólag fiktív mintaadatokkal), és egyértelműen megjelöltem, mi került be a UI-ba *(vagy a módosítás egyáltalán nem érint felhasználói felületet)*.
- [ ] **Commitolási szabályok betartva:** Magyar nyelvű, tiszta, atomi commit üzeneteket használtam, és nem futtattam tömeges átformázást (`vendor/bin/pint --dirty`) a meglévő fájlokon.
- [ ] **Szerveroldali tesztek zöldek:** `cd app && php artisan test`
- [ ] **Asztali tesztek zöldek:** `cd desktop && npm test`
- [ ] **Adatbázis-migrációk tiszták:** Új migráció esetén a `cd app && php artisan migrate --force && php artisan migrate:status` lefutott, nincs `Pending` migráció, és minden új `DB::table` oszlop védett (`$row->mezo ?? null`) hozzáféréssel van olvasva.
- [ ] **Adat- és titokvédelem:** A kód, a tesztek és a képernyőképek nem tartalmaznak valós ügyféladatot, éles adószámot, jelszót, privát kulcsot vagy belső szervercímet.

## Hozzájárulási nyilatkozat (CLA)
- [ ] Kijelentem, hogy a beküldött módosítás a saját munkám (vagy rendelkezem a beküldéséhez szükséges jogosultsággal), a kódra a GNU AGPLv3 licenc vonatkozik, és a `CONTRIBUTING.md` / ÁSZF 15.1 feltételei szerint nem kizárólagos, jogdíjmentes, visszavonhatatlan jogot engedek a KapuMail fejlesztőjének (Laczkovszki Gábor E.V.) a módosítás hivatalos kiadásokban és szolgáltatásokban történő terjesztésére.
