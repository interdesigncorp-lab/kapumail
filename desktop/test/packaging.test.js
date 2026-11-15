// A telepítőcsomag fájllistájának őre: minden helyi modul, amelyet a belépési pontok
// (közvetve is) behúznak, szerepeljen a package.json build.files listájában.
// Enélkül a fejlesztői mód működik, a telepített alkalmazás viszont el sem indul.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// A require-útvonalak a hívó fájl mappájához képest oldódnak fel (pl. kapu/index.js → kapu/store.js); mappára mutatónál index.js.
function localRequires(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  return [...src.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)].map((m) => {
    let rel = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
    if (fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isDirectory()) rel = path.posix.join(rel, 'index.js');
    return rel.endsWith('.js') ? rel : `${rel}.js`;
  });
}

// A build.files elemei: pontos fájlnév vagy `mappa/**` minta.
const listedBy = (files) => (f) => files.some((p) => (p.endsWith('/**') ? f.startsWith(p.slice(0, -2)) : p === f));

function reachable(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f) || !fs.existsSync(path.join(root, f))) continue;
    seen.add(f);
    queue.push(...localRequires(f));
  }
  return [...seen];
}

test('a belépési pontokból elérhető minden helyi modul benne van a telepítőcsomagban', () => {
  const listed = listedBy(pkg.build.files);
  const missing = reachable(['main.js', 'preload.js', 'lock-preload.js', 'confirm-preload.js']).filter((f) => !listed(f));
  assert.deepStrictEqual(missing, []);
});

test('a megerősítő réteg fájljai benne vannak a telepítőcsomagban', () => {
  const listed = new Set(pkg.build.files);
  assert.deepStrictEqual(['confirm-view.js', 'confirm-preload.js', 'confirm.html', 'confirm-screen.js'].filter(f => !listed.has(f) || !fs.existsSync(path.join(root, f))), []);
});

test('a nyitóképernyő (üzemmód-választó) benne van a telepítőcsomagban', () => {
  const listed = new Set(pkg.build.files);
  assert.deepStrictEqual(['welcome.html', 'mode.js'].filter(f => !listed.has(f) || !fs.existsSync(path.join(root, f))), []);
});

test('packaging: kapu/** a fájllistában', () => {
  assert.ok(pkg.build.files.includes('kapu/**'));
  const listed = listedBy(pkg.build.files);
  // A Kapu-modulok és a rendszerprompt (persona.md, futáskor olvasva) is a csomagba kerül.
  assert.deepStrictEqual(['kapu/index.js', 'kapu/store.js', 'kapu/run.js', 'kapu/isolation.js', 'kapu/providers.js', 'kapu/persona.md'].filter((f) => !listed(f) || !fs.existsSync(path.join(root, f))), []);
  assert.ok(reachable(['main.js']).includes('kapu/store.js'), 'a main.js-ből elérhető a Kapu tárolója');
});
