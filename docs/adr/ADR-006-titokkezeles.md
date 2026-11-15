# ADR-006: Titokkezelés

Állapot: **javasolt; a jogi kaput a tulajdonos 2026-11-12-én megnyitotta (lásd lent)** · 2026-11-11
Bizonyíték: [R01](../../research/R01-tarhely-cli-es-gitjog-audit.md), [R06](../../research/R06-asztali-keret-osszevetes.md), [ADR-008](ADR-008-http-alapu-tarhely-hivasok.md)

## Döntés

1. Tárhely-belépési adat (felhasználónév, jelszó, TOTP-kulcs, munkamenet-süti) **kizárólag az asztali gép OS titoktárában** él (Windows: Credential Manager / DPAPI; macOS: Keychain). A szerver adatbázisában csak `CredentialReference` van.
2. A felület (renderer) soha nem kap titkot; csak a csatlakozó-folyamat olvassa.
3. Titok nem kerülhet naplóba, hibajelentésbe, képernyőképbe, keresőindexbe, nyelvi modell bemenetébe. A hibakövető titokszűrővel fut; erre automatizált teszt van.
4. A termék saját fiókja (iroda-belépés, kétlépcsős azonosítás) külön dolog a tárhely-azonosítástól; a felület ezt szövegben és vizuálisan is megkülönbözteti.
5. Lejárt munkamenetnél látható újrahitelesítési kérés; nincs végtelen újrapróbálkozás, nincs CAPTCHA- vagy hozzáféréskorlát-megkerülés.

## Nyitott jogi kapu

Az ügyfél jelszavának és TOTP-kulcsának tárolása kell ahhoz, hogy a rendszer emberi közreműködés nélkül, felügyelet nélkül lépjen be és szedje le az ügyfelek leveleit (ADR-008 C-cél). Hogy egy könyvelő jogszerűen tárolhatja-e és használhatja-e az ügyfél azonosítóját és TOTP-kulcsát, és hogy a szolgáltatás feltételei megengedik-e a gépi belépést: **az [ADR-004](ADR-004-joghatas-kapuk.md) kérdése.**

**Tulajdonosi döntés (2026-11-12):** a megrendelő a célt vállalja, az alábbi feltételekkel. A döntés és a jogszerűség megítélésének felelőssége a megrendelőé; ez nem jogi állásfoglalás.

- Minden tárolt ügyfél-belépő a kliens **kifejezett meghatalmazásán és hozzájárulásán** alapul.
- A titkok (felhasználónév, jelszó, TOTP-kulcs) **kizárólag az OS-kulcstárban** élnek (fenti 1–3. pont változatlan); szerverre, naplóba, hibajelentésbe, felületre sosem kerülnek. A TOTP-kódot a `desktop/totp.js` a memóriában állítja elő, és csak a belépés másodperceiben.
- A TOTP-kulccsal működő, felügyelet nélküli belépés **mostantól építhető**; ügyfelenként külön belépő, külön munkamenet.
- A meglévő óvintézkedések maradnak: lejárt munkamenetnél újrahitelesítés, nincs CAPTCHA-/hozzáféréskorlát-megkerülés, a letöltés (átvétel-joghatás) továbbra is az [ADR-004](ADR-004-joghatas-kapuk.md) külön kapuja — a felügyelet nélküli futás egyelőre csak belépés és **listázás**, nem letöltés.
