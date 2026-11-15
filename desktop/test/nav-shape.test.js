// A NAV-portál megfigyelőjének tiszta része: a rögzített adatban szerkezet marad, érték nem.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../dev/nav-shape');

test('az útvonalból minta lesz: számok és hosszú azonosítók kitakarva, a lekérdezésből csak a kulcsok maradnak', () => {
  assert.deepEqual(S.urlPattern('https://ugyfelportal.nav.gov.hu/api/adozo/12345678/bevallasok?ev=2026&token=abc123XYZ#x'),
    { host: 'ugyfelportal.nav.gov.hu', path: '/api/adozo/9…/bevallasok', query: ['ev', 'token'] });
  assert.equal(S.urlPattern('https://x.nav.gov.hu/a/3f2b9c1e-7a55-4c1d-9b0e-112233445566/reszlet').path, '/a/{azonosító}/reszlet');
  assert.equal(S.urlPattern('https://x.nav.gov.hu/a/Kovacs_Bela_8412345678.pdf').path, '/a/{azonosító}');
  assert.equal(S.urlPattern('nem cím'), null);
});

test('csak állami gépnevek engedettek', () => {
  assert.deepEqual(['nav.gov.hu', 'ugyfelportal.nav.gov.hu', 'kau.gov.hu', 'idp.gov.hu', 'gov.hu.evil.com', 'evilgov.hu', 'example.com'].map(S.allowedHost), [true, true, true, true, false, false, false]);
});

test('a rögzítő végpontonként összesít, és a válaszból csak a szerkezetet őrzi meg', () => {
  const r = S.makeRecorder();
  r.add({ url: 'https://ugyfelportal.nav.gov.hu/api/adozok?oldal=1', method: 'GET', status: 200, contentType: 'application/json', body: JSON.stringify({ adozok: [{ nev: 'Minta Béla', adoszam: '12345678-1-12', aktiv: true }], osszes: 1 }) });
  r.add({ url: 'https://ugyfelportal.nav.gov.hu/api/adozok?oldal=2', method: 'GET', status: 200, contentType: 'application/json', body: JSON.stringify({ adozok: [], osszes: 1 }) });
  r.add({ url: 'https://ugyfelportal.nav.gov.hu/api/kepviselet', method: 'POST', status: 204, contentType: '', body: '', requestBody: JSON.stringify({ adoszam: '12345678' }), requestHeaders: { 'X-XSRF-TOKEN': 'abc123titok', Accept: '*/*', Cookie: 'JSESSIONID=abc123' } });
  r.add({ url: 'https://ugyfelportal.nav.gov.hu/oldal', method: 'GET', status: 200, contentType: 'text/html', body: '<html>Minta Béla</html>' });
  r.add({ url: 'https://example.com/kovet', method: 'GET', status: 200, contentType: 'application/json', body: '{"a":1}' });
  const out = r.toJSON();
  const list = out.vegpontok.find(e => e.path === '/api/adozok');
  assert.deepEqual([list.method, list.darab, list.statuszok, list.query], ['GET', 2, { 200: 2 }, ['oldal']]);
  assert.deepEqual(Object.keys(list.valasz.keys).sort(), ['adozok', 'osszes']);
  assert.deepEqual(Object.keys(list.valasz.keys.adozok.items.keys).sort(), ['adoszam', 'aktiv', 'nev']);
  const post = out.vegpontok.find(e => e.method === 'POST');
  assert.deepEqual(Object.keys(post.keres.keys), ['adoszam'], 'a módosító kérés törzsének is csak a szerkezete marad');
  assert.deepEqual(post.fejlecek, ['cookie', 'x-xsrf-token'], 'a fejléceknek csak a neve marad');
  assert.equal(out.vegpontok.some(e => e.host === 'example.com'), false, 'idegen gépnév nem kerül a jegyzőkönyvbe');
  assert.deepEqual(out.idegenGepnevek, ['example.com']);
  const text = JSON.stringify(out);
  for (const secret of ['Minta', 'Béla', '12345678', 'abc123']) assert.equal(text.includes(secret), false, `érték nem maradhat a kimenetben: ${secret}`);
});

test('ASP: az lgov.hu csak az ASP-megfigyelésnél engedett, és a hasonmás gépnevek ott sem', () => {
  const hosts = ['ohp-20.asp.lgov.hu', 'lgov.hu', 'kau.gov.hu', 'e-onkormanyzat.gov.hu', 'asp.lgov.hu.evil.com', 'evillgov.hu', 'xgov.hu', 'example.com'];
  assert.deepEqual(hosts.map(S.allowedHostAsp), [true, true, true, true, false, false, false, false]);
  assert.equal(S.allowedHost('ohp-20.asp.lgov.hu'), false, 'a NAV-megfigyelő nem lát rá az lgov.hu-ra');
  const nav = S.makeRecorder(), asp = S.makeRecorder(S.allowedHostAsp);
  for (const r of [nav, asp]) r.add({ url: 'https://ohp-20.asp.lgov.hu/api/egyenleg', status: 200, contentType: 'application/json', body: '{"osszeg":1}' });
  assert.deepEqual([nav.count(), asp.count()], [0, 1]);
  assert.deepEqual(nav.toJSON().idegenGepnevek, ['ohp-20.asp.lgov.hu']);
});

test('HTML-oldalból az űrlapmezők neve és a táblázatok mérete marad, felirat és érték nem', () => {
  const html = `<html><body><h1>Minta Béla adóegyenlege</h1>
    <form method="post" action="/ado/egyenleg/8412345678?onk=Kisfalu"><input type="hidden" name="javax.faces.ViewState" value="titok123:456">
      <input name="form:adoazonosito" value="8412345678"><select name="onkormanyzat"><option value="77">Kisfalu</option></select><button name="form:lekerdez">Lekérdezés</button></form>
    <table><tr><th>Adónem</th><th>Egyenleg</th></tr><tr><td>Iparűzési adó</td><td>125 000 Ft</td></tr></table></body></html>`;
  const h = S.htmlShape(html, 'https://ohp-20.asp.lgov.hu/ado');
  assert.deepEqual(h.urlapok, [{ method: 'POST', cel: 'ohp-20.asp.lgov.hu/ado/egyenleg/9…', mezok: ['form:adoazonosito', 'form:lekerdez', 'javax.faces.ViewState', 'onkormanyzat'] }]);
  assert.deepEqual(h.tablak, [{ oszlopok: 2, sorok: 2 }]);
  const r = S.makeRecorder(S.allowedHostAsp);
  r.add({ url: 'https://ohp-20.asp.lgov.hu/ado', status: 200, contentType: 'text/html; charset=utf-8', body: html });
  r.add({ url: 'https://ohp-20.asp.lgov.hu/ado', status: 200, contentType: 'text/html', body: html });
  const out = r.toJSON(), e = out.vegpontok[0];
  assert.deepEqual([e.darab, e.urlapok.length, e.tablak.length], [2, 1, 1], 'az ismétlődő oldal szerkezete egyszer szerepel');
  const text = JSON.stringify(out);
  for (const secret of ['Minta', 'Béla', '8412345678', 'titok123', 'Kisfalu', 'Iparűzési', '125']) assert.equal(text.includes(secret), false, `érték nem maradhat a kimenetben: ${secret}`);
});

test('a megfigyelő fejlesztői eszköz: nincs a telepítőcsomagban, és a főfolyamat csak csomagolatlan appban tölti be', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(!pkg.build.files.some(f => f.includes('dev/') || f.includes('nav-observer') || f.includes('nav-shape')));
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const i = main.indexOf("'nav-observer.js'");
  assert.ok(i > 0, 'a főfolyamat hivatkozik a megfigyelőre');
  assert.match(main.slice(Math.max(0, i - 300), i), /!app\.isPackaged/);
  assert.match(main, /--megfigyelo-asp/); assert.match(pkg.scripts['megfigyelo:asp'], /--megfigyelo-asp$/);
});
