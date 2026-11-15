# Harmadik felek összetevői

A KapuMail saját kódjára a [GNU Affero General Public License v3.0 (GNU AGPLv3)](LICENSE) vonatkozik (szerzői jogi jogosult: Laczkovszki Gábor / Laczkovszki Gábor E.V.). Az alábbi összetevők más szerzők művei, rájuk a saját licencük érvényes.

## Referenciaként használt forrás

### godavid/tarhely-cli

- Forrás: https://github.com/godavid/tarhely-cli, vizsgált commit: `f9fbddd0af0aebb9aa1bcb06eb014ffd2f7bf347`
- Licenc: MIT, Copyright (c) 2026 Goldmann Dávid
- Mire használjuk: a KAÜ-belépés és a tárhely-listázás lépéseinek referenciája a `desktop/tarhely-http.js` és a `desktop/tarhely-live.js` fájlban (a fájlok fejléce jelöli); a `desktop/connector.js` a felhasználó által külön telepített eszközt hívja, a kódját nem tartalmazza.

A tarhely-cli licencszövege:

```
MIT License

Copyright (c) 2026 Goldmann Dávid

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Függőségek

A függőségek nincsenek a repóba másolva; a `composer install` és az `npm install` tölti le őket. A pontos, tranzitív lista a `app/composer.lock`, az `app/package.json` és a `desktop/package-lock.json` fájlban van.

| Összetevő | Hol | Licenc |
|---|---|---|
| Laravel keretrendszer és a Laravel alkalmazásváz | `app/` | MIT |
| robrichards/xmlseclibs | `app/` | BSD-3-Clause |
| Tailwind CSS | `app/` | MIT |
| Electron, electron-builder | `desktop/` | MIT |
| PHP 8.4 CLI futtatókörnyezet (macOS: static-php-cli, Windows: php.net NTS x64) | telepítőcsomag (`resources/php`) | PHP-3.01, OpenSSL: Apache-2.0, SQLite: közkincs, CA-tanúsítványtár: MPL-2.0 |

## Betűtípusok

A felület a Figtree, a landing a Figtree és a Fraunces betűtípust a Google Fonts szolgáltatásból tölti be (SIL Open Font License 1.1). A betűfájlok nincsenek a repóban.

## Ikonok

A Kapu-chat motorválasztójában a szolgáltatók jelei a népszerű CLI-eszközök jeleivel egyeznek, és az `app/resources/ui/kapu.js` ikonkészletében szerepelnek:

| Jel | Forrás | Licenc |
|---|---|---|
| Claude (Anthropic) | Simple Icons | CC0 1.0 |
| ChatGPT / Codex (OpenAI) | LobeHub Icons | MIT |
| Antigravity (Google) | LobeHub Icons | MIT |

A jelek a szolgáltatók védjegyei; csak a szolgáltató megjelölésére szolgálnak.
