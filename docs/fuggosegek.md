# Függőségi terv és licencjegyzék

Állapot: terv, 2026-11-11. Semmi nincs még telepítve. A verziókat a fejlesztés indításakor kell rögzíteni; a teljes tranzitív licencleltár akkor készül (CI-lépésként).

## Központi alkalmazás

| Komponens | Szerep | Licenc | Megjegyzés |
|---|---|---|---|
| Laravel 12 | Keretrendszer | MIT | Széles körben bevált technológia |
| Inertia + React 19 | Felület | MIT | Hivatalos React starter kit |
| Tailwind 4 | Stílus | MIT | A prototípus tokenjei ide kerülnek át |
| Laravel Fortify | Belépés, kétlépcsős azonosítás | MIT | |
| Laravel Horizon + Redis | Háttérsor | MIT / Redis licenc ellenőrizendő | |
| Laravel Reverb | Élő frissítés | MIT | |
| spatie/laravel-permission | Szerepkörök | MIT | Az ügyfélszintű szűrés saját kód |
| PostgreSQL | Adatbázis | PostgreSQL License | Jogosultságszintű védelem az auditnaplóra |
| Sentry | Hibakövetés | Szolgáltatás | Titokszűrővel; adatfeldolgozói feltételek ellenőrizendők |
| Pest | Tesztek | MIT | |

## Asztali kliens

| Komponens | Szerep | Licenc | Megjegyzés |
|---|---|---|---|
| Electron | Keret, Windows + macOS | MIT | [ADR-001](adr/ADR-001-platform.md) |
| electron-builder, electron-updater | Csomagolás, frissítés | MIT | Aláírás: M6 |
| Playwright (Chromium) | A csatlakozó böngészője | Apache-2.0 | A Chromium saját licencei a leltárba |
| better-sqlite3-multiple-ciphers | Helyi titkosított tár | MIT (ellenőrizendő a leltárban) | R06 ajánlása |
| Electron `safeStorage` | OS titoktár | Az Electron része | A `tarhely-cli` `@napi-rs/keyring`-et használ; a választás E02-3-ban |

## Átvett forrás

| Forrás | Mit veszünk át | Licenc | Teendő |
|---|---|---|---|
| godavid/tarhely-cli @ `f9fbddd0…7bf347` | Belépési és listázási logika mintaként, részben átvett kódként | MIT | A szerzői jogi megjegyzés megőrzése a `THIRD_PARTY_NOTICES` fájlban; az átvett fájlok fejlécében forrás és commit |
| godavid/magyar-jog | Adatforrás (MVP után) | CC0 | Nem hiteles jogforrás – a felületen jelölni |

## Hitelességvizsgálat – még nem eldöntött

| Jelölt | Licenc | Állapot |
|---|---|---|
| EU DSS (Java) | LGPL 2.1 | Dinamikus használat zárt termékben megengedett a licenc feltételeivel; az es3-támogatás **NEM BIZONYÍTOTT** |
| Microsec e-Szignó SDK | Kereskedelmi, szerződéses | Ár és platformlista **NEM BIZONYÍTOTT**; ajánlatkérés a PoC 6. lépése |

## Amit szándékosan nem veszünk át

- Más termék kódja, felülete, szövegei, szolgáltatói kulcsai és API-ja.
- A `tarhely-cli` „minden új levelet letölt” parancsa.
