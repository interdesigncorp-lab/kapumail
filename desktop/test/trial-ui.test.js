'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_HTML = path.join(REPO_ROOT, 'app', 'resources', 'ui', 'app.html');
const BUILD_RELEASE = path.join(REPO_ROOT, 'desktop', 'scripts', 'build-release.js');
const LICENSE_FILE = path.join(REPO_ROOT, 'LICENSE');

test('app.html: a 14 napos próbaidőszak aktiválási ablaka a pontos szöveget és a 3 gombot tartalmazza', () => {
  const html = fs.readFileSync(APP_HTML, 'utf8');

  assert.match(html, /<div id="trial" hidden><\/div>/);
  assert.ok(html.includes('A KapuMail 14 napos próbaidőszaka lejárt.'), 'Hiányzik az aktiválási ablak címsora');
  assert.ok(
    html.includes('A hivatalos KapuMail használatának folytatásához aktiválj előfizetést. Az előfizetés automatikus frissítéseket, ellenőrzött kiadásokat és támogatást biztosít.'),
    'Hiányzik az előfizetés leírása az aktiválási ablakból',
  );
  assert.ok(
    html.includes('A KapuMail nyílt forráskódú szoftver. Ha saját magad szeretnéd üzemeltetni, a forráskód ingyenesen elérhető a GitHubon.'),
    'Hiányzik az open source tájékoztatás az aktiválási ablakból',
  );

  // Mindhárom kért gomb jelen van az aktiválási ablakban
  assert.ok(html.includes('Előfizetek'), 'Hiányzik az Előfizetek gomb');
  assert.ok(html.includes('Open source verzió'), 'Hiányzik az Open source verzió gomb');
  assert.ok(html.includes('Dokumentumaim exportálása'), 'Hiányzik a Dokumentumaim exportálása gomb');
  assert.ok(html.includes('/api/export/documents'), 'Hiányzik a teljes dokumentumexport végpont hivatkozása');
});

test('build-release.js és LICENSE: GNU AGPLv3 forráslicenc és hivatalos kiadás jelzőfájl', () => {
  const lic = fs.readFileSync(LICENSE_FILE, 'utf8');
  assert.ok(lic.includes('GNU AFFERO GENERAL PUBLIC LICENSE'), 'A LICENSE fájlnak a GNU AGPLv3 szövegét kell tartalmaznia');
  assert.ok(lic.includes('Version 3, 19 November 2007'), 'Hiányzik az AGPLv3 verziófejléc');

  const buildSrc = fs.readFileSync(BUILD_RELEASE, 'utf8');
  assert.ok(buildSrc.includes('official-build.json'), 'A hivatalos kiadásépítőnek el kell helyeznie az official-build.json jelzőfájlt');
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, 'app', 'bootstrap', 'official-build.json')),
    false,
    'A nyílt forráskódú adattárban alapértelmezetten nem lehet jelen az official-build.json',
  );
});
