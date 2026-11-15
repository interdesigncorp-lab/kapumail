// A helyi tárhely-szimulátor („iker") tesztjei. A szimulátort a VALÓDI tarhely-http és tarhely-auto modul
// járja be, így a tesztek azt is őrzik, hogy a böngésző nélküli út végigmegy rajta.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const H = require('../tarhely-http');
const A = require('../tarhely-auto');
const { createGovTwin, accountantScenario } = require('../simulator/gov-twin');

const login = (twin, key = 'konyvelo') => {
  const c = twin.credentials[key];
  return H.loginWithCredentials({ username: c.username, password: c.password, seed: c.totpSeed }, { fetchImpl: twin.fetchImpl });
};

const quiet = { sleep: async () => {} };

test('könyvelői minta a valódi szerkezettel: saját tárhely, négy Cégkapu, egy Hivatali kapu', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await login(twin);
  assert.equal(ctx.mailboxes.length, 6);
  const own = ctx.mailboxes.find(m => m.type === 'AP');
  assert.deepEqual([own.isDefault, own.rawName, /^értesítési tárhely · [0-9a-f]{8}$/.test(own.name)], [true, 'értesítési tárhely', true]);
  const ck = ctx.mailboxes.filter(m => m.type === 'CKP');
  assert.equal(ck.length, 4);
  assert.ok(ck.every(m => /^\d{8}$/.test(m.name) && m.displayName.includes('SZIMULÁTOR')), 'a Cégkapu kulcsa az adószám-törzs, a cég neve külön mezőben jön');
  assert.equal(ctx.mailboxes.filter(m => m.type === 'HKP').length, 1);
});

test('lapozás: a 230 leveles Cégkapu minden levele megjön, három kéréssel', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await login(twin);
  const big = ctx.mailboxes.find(m => m.name === '11223346');
  const before = twin.log.length;
  const rows = await H.listMailbox(ctx, big.addressId, quiet);
  assert.equal(rows.length, 230);
  assert.equal(new Set(rows.map(r => r.eid)).size, 230);
  assert.equal(twin.log.length - before, 3);
  assert.ok(twin.log.slice(before).every(c => c.addressId === big.addressId));
});

test('a saját tárhelyen két ügyfélirat és egy magánlevél van, a tartós tárban két régi levél; a postafiókok nem keverednek', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await login(twin);
  const own = ctx.mailboxes.find(m => m.type === 'AP');
  const rows = await H.listMailbox(ctx, own.addressId, quiet);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.mailbox === own.name && r.folder === 'BEERKEZETT' && r.portalOpened === false));
  assert.equal(rows.filter(r => /68412205/.test(r.desc)).length, 2); // a két ügyfélirat leírásában adószám áll
  const durable = await H.listMailbox(ctx, own.addressId, { ...quiet, folder: 'TARTOS_TAR' });
  assert.deepEqual(durable.map(r => [r.folder, r.durable, r.portalOpened]), [['TARTOS_TAR', true, true], ['TARTOS_TAR', true, true]]);
});

test('kezdődátumos szűrő: csak az azóta érkezett levelek jönnek, és a szűrő a tárhely által elfogadott alakban megy', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await login(twin);
  const own = ctx.mailboxes.find(m => m.type === 'AP');
  const since = new Date(Date.UTC(2026, 10, 12, 9, 0, 0) - 5 * 86400000);
  const rows = await H.listMailbox(ctx, own.addressId, { ...quiet, since });
  assert.equal(rows.length, 2, 'a húsznapos levél kimarad');
  // A valódi tárhely a sima dátumra 400-at ad; a szimulátor is.
  const bad = await twin.fetchImpl('https://tarhely.gov.hu/levelezes/api/uzenetek/BEERKEZETT/kereses', { method: 'POST',
    headers: { Cookie: ctx.jar.header('https://tarhely.gov.hu/levelezes/api/x'), 'x-xsrf-token': decodeURIComponent(ctx.jar.get('https://tarhely.gov.hu/levelezes/api/x', 'XSRF-TOKEN')), 'address-id': own.addressId },
    body: JSON.stringify({ pageNumber: 0, countPerPage: '100', filter: { incomingFromDate: '2026-11-07' } }) });
  assert.equal(bad.status, 400);
});

test('telítettség a kvótából számolva', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await login(twin);
  assert.equal(await H.mailboxQuota(ctx, ctx.mailboxes.find(m => m.name === '11223346').addressId), 88);
});

test('hibás jelszó és hibás kód érthető hibát ad, munkamenet nem jön létre', async () => {
  const twin = createGovTwin(accountantScenario());
  const c = twin.credentials.konyvelo;
  await assert.rejects(H.loginWithCredentials({ username: c.username, password: 'rossz', seed: c.totpSeed }, { fetchImpl: twin.fetchImpl }), /Hibás felhasználónév vagy jelszó/);
  await assert.rejects(H.loginWithCredentials({ username: c.username, password: c.password, getCode: async () => '000000' }, { fetchImpl: twin.fetchImpl }), /nem a tárhelyen ért véget|kód/);
  assert.equal(twin.sessions(), 0);
});

test('lejárt munkamenet a listázás közben: a modul jelzi, nem ad vissza csonka listát', async () => {
  const twin = createGovTwin(accountantScenario({ sessionCalls: 2 })); // a postafiók-lista után egy listakérés fér bele
  const ctx = await login(twin);
  const big = ctx.mailboxes.find(m => m.name === '11223346');
  await assert.rejects(H.listMailbox(ctx, big.addressId, quiet), /munkamenet lejárt/);
});

test('ismeretlen útvonal és idegen postafiók-azonosító hibát ad', async () => {
  const twin = createGovTwin(accountantScenario());
  await assert.rejects(twin.fetchImpl('https://tarhely.gov.hu/levelezes/api/uzenet/torles/beerkezett/X', { method: 'POST', headers: {} }), /nem ismert útvonal/); // törlést, áthelyezést, küldést a szimulátor sem ismer
  const ctx = await login(twin);
  ctx.mailboxes.push({ addressId: 'IDEGEN', name: 'Idegen' });
  await assert.rejects(H.listMailbox(ctx, 'IDEGEN'), /HTTP 403|munkamenet lejárt/);
});

test('a többügyfeles futó a szimulátoron: két belépő, az egyik hibás, a másik hat postafiókot hoz', async () => {
  const sc = accountantScenario();
  sc.users['hibas.belepo'] = { password: 'jo', totpSeed: sc.users['konyvelo.teszt'].totpSeed, fail: 'password', mailboxes: [] };
  const twin = createGovTwin(sc);
  const sum = await A.runClients(Object.keys(twin.credentials), { getCreds: async k => twin.credentials[k], fetchImpl: twin.fetchImpl, sleep: async () => {} });
  assert.equal(sum.ran, 2);
  assert.equal(sum.ok, 1);
  const good = sum.results.find(r => r.ok);
  assert.equal(good.mailboxes.length, 6);
  assert.equal(good.full, true, 'első alkalommal teljes listázás');
  assert.equal(good.letterCount, 3 + 2 + 1 + 230 + 0 + 1 + 2, 'a Beérkezett mappák és a saját tárhely két tartós tári levele');
  assert.equal(good.mailboxes.find(m => m.name === '11223346').quotaPct, 88);
  assert.deepEqual(good.mailboxes.filter(m => m.type === 'AP').map(m => m.isDefault), [true]);
  assert.doesNotMatch(JSON.stringify(sum), new RegExp(twin.credentials.konyvelo.password)); // titok nem kerül az eredménybe
});

test('letöltés a szimulátoron: a fájl bájtjai jönnek, idegen postafiókból és ismeretlen iratra nem', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await login(twin);
  const own = ctx.mailboxes.find(m => m.type === 'AP'); const other = ctx.mailboxes.find(m => m.type === 'CKP');
  const rows = await H.listMailbox(ctx, own.addressId, quiet);
  const eid = rows[0].eid;
  const get = (addressId, path) => twin.fetchImpl('https://tarhely.gov.hu/levelezes/api/uzenet/letoltes/' + path, { method: 'GET',
    headers: { Cookie: ctx.jar.header('https://tarhely.gov.hu/levelezes/api/x'), 'x-xsrf-token': decodeURIComponent(ctx.jar.get('https://tarhely.gov.hu/levelezes/api/x', 'XSRF-TOKEN')), 'address-id': addressId } });
  const ok = await get(own.addressId, 'beerkezett/' + eid);
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.headers.get('filename'), ok.headers.get('erkeztetesiszam'), ok.headers.get('content-disposition')], ['szimulator-irat.xml', eid, null], 'a fájlnév külön fejlécben jön, mint élőben');
  assert.ok((await ok.arrayBuffer()).byteLength > 0);
  const after = await H.listMailbox(ctx, own.addressId, quiet);
  assert.equal(after.find(r => r.eid === eid).portalOpened, true, 'a letöltéstől a levél a tárhelyen megnyitottá válik (élőben megfigyelve)');
  assert.equal((await get(other.addressId, 'beerkezett/' + eid)).status, 404, 'más postafiókjában nincs ilyen irat');
  assert.equal((await get(own.addressId, 'tartostar/' + eid)).status, 404, 'a mappa is számít');
  assert.equal((await get(own.addressId, 'tartos/' + eid)).status, 500, 'a tartós tár útvonala „tartostar”; a rövid alakra a tárhely élőben is 500-at adott');
  assert.equal((await get('0'.repeat(64), 'beerkezett/' + eid)).status, 403);
});

test('a szimulátor fejlesztői eszköz: nincs a telepítőcsomagban, és a főfolyamat csak csomagolatlan appban tölti be', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(!pkg.build.files.some(f => f.includes('simulator')));
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const i = main.indexOf("'gov-twin.js'");
  assert.ok(i > 0, 'a főfolyamat hivatkozik a szimulátorra');
  assert.match(main.slice(Math.max(0, i - 400), i), /IRATKAPU_SIMULATOR[\s\S]*!app\.isPackaged|!app\.isPackaged[\s\S]*IRATKAPU_SIMULATOR/);
});

test('böngésző nélküli letöltés a modulból: fájl, fájlnév a fejlécből; ismeretlen postafiókra és hibás azonosítóra nem megy ki kérés', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await login(twin);
  const own = ctx.mailboxes.find(m => m.type === 'AP');
  const rows = await H.listMailbox(ctx, own.addressId, quiet);
  const before = twin.log.length;
  const r = await H.downloadLetter(ctx, own.addressId, rows[0].eid, 'BEERKEZETT');
  assert.deepEqual([r.ok, r.fileName, r.contentType, r.size > 0, Buffer.from(r.bytesBase64, 'base64').length === r.size], [true, 'szimulator-irat.xml', 'application/xml', true, true]);
  assert.equal(twin.log.length, before + 1, 'egyetlen kérés: részletet nem kér le');
  assert.deepEqual([(await H.downloadLetter(ctx, own.addressId, rows[0].eid, 'TARTOS_TAR')).code, (await H.downloadLetter(ctx, own.addressId, 'NINCS-ILYEN', 'BEERKEZETT')).code], [4, 4]);
  const sent = twin.log.length;
  await assert.rejects(H.downloadLetter(ctx, 'IDEGEN', rows[0].eid), /Ismeretlen postafiók/);
  assert.equal((await H.downloadLetter(ctx, own.addressId, '../etc/passwd')).ok, false);
  assert.equal(twin.log.length, sent, 'ezekre nem ment ki kérés');
});

test('lejárt munkamenetnél a letöltés jelzi, hogy újra be kell lépni', async () => {
  const twin = createGovTwin(accountantScenario({ sessionCalls: 3 }));
  const ctx = await login(twin);
  const own = ctx.mailboxes.find(m => m.type === 'AP');
  const rows = await H.listMailbox(ctx, own.addressId, quiet);
  let r; for (let i = 0; i < 4; i++) r = await H.downloadLetter(ctx, own.addressId, rows[0].eid);
  assert.deepEqual([r.ok, r.code, r.expired], [false, 3, true]);
});

test('letöltés a tartós tárból: az élőben igazolt „tartostar” útvonalon megy', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await login(twin);
  const own = ctx.mailboxes.find(m => m.type === 'AP');
  const durable = await H.listMailbox(ctx, own.addressId, { ...quiet, folder: 'TARTOS_TAR' });
  const r = await H.downloadLetter(ctx, own.addressId, durable[0].eid, 'TARTOS_TAR');
  assert.deepEqual([r.ok, r.folder], [true, 'TARTOS_TAR']);
  assert.match(twin.log[twin.log.length - 1].path, /\/uzenet\/letoltes\/tartostar\//);
});

test('a KAÜ-lánc a megadott engedélylistán belül marad: szűkebb listával a tárhelyre nem jut el', async () => {
  const twin = createGovTwin(accountantScenario()); const c = twin.credentials.konyvelo;
  const creds = { username: c.username, password: c.password, seed: c.totpSeed };
  const target = { startUrl: 'https://tarhely.gov.hu/levelezes/login', endHost: 'tarhely.gov.hu' };
  const ok = await H.kauLogin(creds, target, { fetchImpl: twin.fetchImpl });
  assert.equal(new URL(ok.page.url).hostname, 'tarhely.gov.hu');
  await assert.rejects(H.kauLogin(creds, { ...target, hosts: ['kau.gov.hu', 'idp.gov.hu'] }, { fetchImpl: twin.fetchImpl }), /Nem engedélyezett cím/);
  await assert.rejects(H.kauLogin(creds, { ...target, endHost: 'ugyfelportal.nav.gov.hu', endName: 'a NAV-portálon' }, { fetchImpl: twin.fetchImpl }), /nem a NAV-portálon ért véget/);
});

// ---- NAV ügyfélportál (7. fázis, A kör): a megfigyelt szerkezet szimulátoron
const N = require('../nav-http');
const navLogin = (twin, key = 'konyvelo') => { const c = twin.credentials[key]; return N.loginNav({ username: c.username, password: c.password, seed: c.totpSeed }, { fetchImpl: twin.fetchImpl }); };

test('NAV-portál: belépés ugyanazzal a KAÜ-lánccal, és a saját adatok kiolvasása kizárólag GET-tel', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await navLogin(twin);
  const before = twin.log.length;
  const r = await N.readOwn(ctx, quiet);
  assert.deepEqual([r.user.name, r.user.taxId.length, r.user.sessionMinutes > 0], ['SZIMULÁTOR KÖNYVELŐ', 10, true]);
  assert.equal(r.profiles.length, 23, 'a lapozott lista minden oldala bejött');
  assert.deepEqual(Object.keys(r.profiles[0]).sort(), ['id', 'kind', 'legal', 'name', 'reliable', 'state', 'stem', 'taxId', 'taxNumber']);
  assert.deepEqual([r.profiles[0].name, r.profiles[0].stem, r.profiles[0].taxNumber, r.profiles[0].taxId], ['SZIMULÁTOR – Példa Kereskedelmi Kft', '12345676', '12345676-2-41', null]);
  assert.deepEqual(r.account, { total: -25000, debt: 0, surplus: 25000, deposit: 0, unbooked: 0 });
  assert.deepEqual([r.missingCount, r.futureCount, r.calendarCount], [1, 2, 3]);
  const calls = twin.log.slice(before);
  assert.ok(calls.length >= 7 && calls.every(c => c.host === 'ugyfelportal.nav.gov.hu' && c.method === 'GET'), 'a NAV felé csak GET megy');
  assert.equal(calls.some(c => /change-kepviselet|processed|nyelv/.test(c.path)), false, 'képviseletet nem vált, semmit nem módosít');
  assert.equal(JSON.stringify(r).includes('JSESSION'), false);
});

test('NAV-portál: a NAV-lánc nem léphet a tárhelyre, a tárhely munkamenete pedig nem érvényes a NAV-on', async () => {
  const twin = createGovTwin(accountantScenario());
  const nav = await navLogin(twin);
  assert.equal(nav.jar.header('https://tarhely.gov.hu/levelezes/api/mailbox/reload').includes('JSESSIONID'), false, 'a NAV-belépés nem ad tárhely-munkamenetet');
  const tarhely = await login(twin);
  await assert.rejects(N.readOwn({ jar: tarhely.jar, fetchImpl: twin.fetchImpl }, quiet), /munkamenet/);
  assert.throws(() => N.assertNavPath('/api/v1/user/login/change-kepviselet'), /Nem engedélyezett/);
  assert.throws(() => N.assertNavPath('/api/v1/balance/tax-invoice'), /Nem engedélyezett/, 'a lekérdezést indító (POST-os) cím nincs a listán');
});

test('NAV-portál: lejárt munkamenetnél megáll, és nem ad vissza csonka adatot', async () => {
  const twin = createGovTwin(accountantScenario({ navSessionCalls: 2 }));
  const ctx = await navLogin(twin);
  await assert.rejects(N.readOwn(ctx, quiet), /munkamenet lejárt/);
});

test('NAV-portál: hibás jelszó a tárhelyével azonos hibát ad (a futó ebből tudja, hogy tiltani kell)', async () => {
  const twin = createGovTwin(accountantScenario());
  const c = twin.credentials.konyvelo;
  await assert.rejects(N.loginNav({ username: c.username, password: 'rossz', seed: c.totpSeed }, { fetchImpl: twin.fetchImpl }), /Hibás felhasználónév vagy jelszó/);
});

// ---- NAV ügyfélportál: az adónaptár tételesen (a teljes szinkron 4. lépése)
const navDay = { ...quiet, today: new Date('2026-11-13T09:00:00Z') };

test('NAV-portál: az adónaptár tételesen jön, kötelezettséggé alakítva, a kiválasztott adózóhoz kötve – csak GET-tel, a hivatalos felülethez hasonlóan generálást kérve', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await navLogin(twin);
  const before = twin.log.length;
  const r = await N.readOwn(ctx, navDay);
  assert.deepEqual(r.subject, { name: 'SZIMULÁTOR KÖNYVELŐ', stem: null, taxId: '8400000000', taxNumber: null, own: true });
  assert.deepEqual(r.obligations.map(o => [o.formCode, o.dueDate, o.status, o.kind]), [
    ['2658', '2026-11-20', 'submittable', 'calendar'], ['2665', '2026-11-20', 'submittable', 'calendar'],
    ['26A60', '2026-12-12', 'submittable', 'calendar'], ['26KIVA', '2026-12-21', 'submitted', 'calendar']]);
  assert.deepEqual(r.obligations.map(o => o.conditional), [false, false, true, false], 'a NAV sárga (feltételes) jelölése megmarad');
  assert.deepEqual([r.calendarInfo.source, r.calendarInfo.total, r.calendarInfo.unknown, r.calendarInfo.keys], ['posts', 4, 0, ['conditional', 'deadline', 'declarationNumber', 'id', 'note', 'portalIdentifier', 'priority', 'title', 'type']]);
  assert.deepEqual([r.calendarInfo.missingTotal, r.calendarInfo.missingUnknown], [1, 1], 'az üres alakú hiányzó bevallásból nem lesz kitalált kötelezettség');
  assert.equal(r.calendarCount, 3, 'a következő 30 nap tételei a frissen generált teljes listából');
  const calls = twin.log.slice(before);
  assert.ok(calls.every(c => c.host === 'ugyfelportal.nav.gov.hu' && c.method === 'GET'), 'a NAV felé csak GET megy');
  assert.equal(calls.some(c => /change-kepviselet|processed|nyelv/.test(c.path)), false);
  assert.equal(calls.filter(c => c.path === '/api/v1/calendar/tax-calendar/posts').length, 1, 'a teljes naptárat egyszer kéri, újra nem próbálkozik');
});

test('NAV-portál: a még nem generált adónaptárat a frissítés kérése tölti meg (élőben így történt 2026-11-13-án)', async () => {
  const twin = createGovTwin({ ...accountantScenario(), navCalendarGenerated: false });
  const ctx = await navLogin(twin);
  const r = await N.readOwn(ctx, navDay);
  assert.equal(r.obligations.filter(o => o.kind === 'calendar').length, 4);
  assert.equal(r.calendarInfo.source, 'posts');
});

test('NAV-portál: ha a teljes adónaptár kérését a portál elutasítja, az előnézet tételeivel megy tovább, és a többi adat megmarad', async () => {
  for (const status of [400, 403, 500]) {
    const twin = createGovTwin(accountantScenario({ navPostsStatus: status }));
    const r = await N.readOwn(await navLogin(twin), navDay);
    assert.deepEqual([r.calendarInfo.source, r.obligations.length, r.profiles.length, r.account.surplus], ['preview', 3, 23, 25000], `HTTP ${status}`);
  }
});

test('NAV-portál: hiányzó bevallásból „hiányzó” kötelezettség lesz, ha a kód és a határidő kiolvasható', async () => {
  const twin = createGovTwin(accountantScenario({ navPosts: [], navMissing: [
    { nyomtatvanyKod: '2558', megnevezes: 'Havi bevallás', idoszakKezdete: '2026-09-01', idoszakVege: '2026-09-30', hatarido: '2026-10-12' },
    { megnevezes: 'Valami, határidő nélkül', idoszakVege: '2026-09-30' }] }));
  const r = await N.readOwn(await navLogin(twin), navDay);
  assert.deepEqual(r.obligations, [{ formCode: '2558', title: 'Havi bevallás', dueDate: '2026-10-12', periodStart: '2026-09-01', periodEnd: '2026-09-30', conditional: false, status: 'missing', kind: 'missing' }]);
  assert.deepEqual([r.calendarInfo.total, r.calendarInfo.missingTotal, r.calendarInfo.missingUnknown], [0, 2, 1]);
});

test('NAV-portál: a tételek ahhoz az adózóhoz tartoznak, akit a munkamenet kiválasztottnak mutat (a program nem vált)', () => {
  assert.throws(() => N.assertNavPath('/api/v1/calendar/tax-calendar/posts/refresh'), /Nem engedélyezett/);
  assert.doesNotThrow(() => N.assertNavPath('/api/v1/calendar/tax-calendar/posts'));
});

// ---- E-Önkormányzat Portál (10. fázis, A kör): a megfigyelt szerkezet szimulátoron
const ASP = require('../asp-http');
const aspLogin = (twin, key = 'konyvelo') => { const c = twin.credentials[key]; return ASP.loginAsp({ username: c.username, password: c.password, seed: c.totpSeed }, { fetchImpl: twin.fetchImpl }); };

test('ASP-portál: a belépés végi http-s átirányítást a lánc https-en követi; titkosítatlan kérés nem megy ki', async () => {
  const twin = createGovTwin(accountantScenario()); const c = twin.credentials.konyvelo;
  const creds = { username: c.username, password: c.password, seed: c.totpSeed };
  const target = { startUrl: 'https://ohp-20.asp.lgov.hu/login', endHost: 'ohp-20.asp.lgov.hu', hosts: ASP.HOSTS };
  await assert.rejects(H.kauLogin(creds, target, { fetchImpl: twin.fetchImpl }), /Nem engedélyezett cím, megállok: http:/, 'kapcsoló nélkül a http-s cím tiltott marad');
  const ok = await H.kauLogin(creds, { ...target, upgradeInsecure: true }, { fetchImpl: twin.fetchImpl });
  assert.equal(ok.page.url, 'https://ohp-20.asp.lgov.hu/successful-login');
  // idegen gépre irányító http-s cím a kapcsolóval sem megy át
  const evil = async (url, init) => (url === 'https://ohp-20.asp.lgov.hu/x' ? { status: 302, headers: { get: k => (k === 'location' ? 'http://evil.example/' : null), getSetCookie: () => [] }, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' } : twin.fetchImpl(url, init));
  await assert.rejects(H.request(new H.CookieJar(), 'https://ohp-20.asp.lgov.hu/x', { fetchImpl: evil, hosts: ASP.HOSTS, upgradeInsecure: true }), /Nem engedélyezett cím/);
});

test('ASP-portál: önkormányzatonként kivonat, bevallások és ügyek – kizárólag GET-tel, a megengedett címekre', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await aspLogin(twin);
  const before = twin.log.length;
  const r = await ASP.readOwn(ctx, { ...quiet, today: new Date('2026-11-13T09:00:00Z') });
  assert.deepEqual(r.user, { name: 'SZIMULÁTOR KÖNYVELŐ', taxId: '8400000000', role: 'SAJAT_NEVEN_TERMESZETES_SZEMELY' });
  assert.deepEqual(r.tenants.map(t => [t.city, t.isDefault, !!t.balance, t.returns.length, t.cases]), [['Példafalva', true, true, 2, 0], ['Mintaváros', false, false, 0, 1]]);
  assert.equal(r.tenants[0].balance.pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(r.tenants[0].balance.pdf.toString(), /Példafalva DETAILED 2026/, 'a kivonat a kiválasztott önkormányzaté');
  assert.match(r.tenants[1].notes.join(' '), /nincs kivonat \(NINCS_ADAT\)/);
  assert.deepEqual(Object.keys(r.tenants[0].returns[0]).sort(), ['comments', 'fileName', 'returnId', 'subjectId', 'taxCode', 'taxName']);
  const calls = twin.log.slice(before);
  assert.ok(calls.length === 10 && calls.every(c => c.host === 'ohp-20.asp.lgov.hu' && c.method === 'GET'), 'a portál felé csak GET megy');
  assert.equal(calls.some(c => /role|ssb|keepalive|favourite|default-tenant/.test(c.path)), false, 'szerepkört nem vált, naplót és módosítót nem hív');
});

test('ASP-portál: csak a megfigyelt olvasó címek engedettek, és a lánc nem léphet a tárhelyre vagy a NAV-ra', async () => {
  for (const p of ['/api/role', '/api/role/reevaluate', '/api/keepalive', '/api/tax/ssb/enter', '/api/user-tenant/default-tenant', '/api/user-tenant/favourite-tenant', '/api/tax/EGYEB/2026', '/api/tax-returns/087/1', '/api/public/tenant-services/a/b', '/api/public/tenant-services/..%2Frole'])
    assert.throws(() => ASP.assertAspPath(p), /Nem engedélyezett/, p);
  assert.deepEqual(ASP.HOSTS.filter(h => /tarhely|nav/.test(h)), []);
  const twin = createGovTwin(accountantScenario());
  const ctx = await aspLogin(twin);
  assert.equal(ctx.jar.header('https://tarhely.gov.hu/levelezes/api/mailbox/reload').includes('JSESSIONID'), false);
  const tarhely = await login(twin);
  await assert.rejects(ASP.readOwn({ jar: tarhely.jar, fetchImpl: twin.fetchImpl }, quiet), /munkamenet/);
});

test('ASP-portál: lejárt munkamenetnél megáll; kikapcsolt szolgáltatást nem kérdez le; a lista korlátozható', async () => {
  const expired = createGovTwin(accountantScenario({ aspSessionCalls: 4 }));
  await assert.rejects(ASP.readOwn(await aspLogin(expired), quiet), /munkamenet/);
  const twin = createGovTwin(accountantScenario({ aspPermissions: { adoegyenleg: false, ugykovetes: false } }));
  const ctx = await aspLogin(twin); const before = twin.log.length;
  const r = await ASP.readOwn(ctx, { ...quiet, maxTenants: 1 });
  assert.deepEqual([r.tenants.length, r.skipped, r.tenants[0].balance, r.tenants[0].cases, r.tenants[0].returns.length], [1, 1, null, null, 2]);
  assert.equal(twin.log.slice(before).some(c => /\/api\/tax\/|\/api\/cases/.test(c.path)), false);
  assert.equal(ASP.toPdf(Buffer.from('<html>hiba</html>').toString('base64')), null, 'ami nem PDF, azt nem fogadjuk el kivonatnak');
});

test('ASP-portál, ablakos mód: a kérés a böngésző munkamenetéből megy, saját süti- és ügynökfejléc nélkül', async () => {
  const twin = createGovTwin(accountantScenario());
  const logged = await aspLogin(twin); const sent = [];
  // A belépőablak munkamenetét utánozza: a sütit a „böngésző” teszi a kérésre, nem a program.
  const sesFetch = (url, init) => { sent.push(Object.keys(init.headers)); return twin.fetchImpl(url, { ...init, headers: { ...init.headers, Cookie: logged.jar.header(url) } }); };
  const r = await ASP.readOwn({ browser: true, fetchImpl: sesFetch }, { ...quiet, maxTenants: 1 });
  assert.deepEqual([r.user.name, r.subject.own, r.subject.id, r.tenants.length], ['SZIMULÁTOR KÖNYVELŐ', true, '8400000000', 1]);
  assert.ok(sent.length > 0 && sent.every(h => h.join() === 'Accept'), 'a program csak az Accept fejlécet adja; a többit a böngésző');
});

test('ASP-portál: a szerepkörből kiderül, kinek az adata – és ha nem egyértelmű, nem találgat', () => {
  const u = (szerepkor, extra) => ({ name: 'X', adoazonosito: '8400000000', roleDetails: { adoazonosito: '8400000000', szerepkor, ...extra } });
  assert.deepEqual(ASP.subjectOf(u('SAJAT_NEVEN_TERMESZETES_SZEMELY')), { role: 'SAJAT_NEVEN_TERMESZETES_SZEMELY', label: 'Saját néven (magánszemélyként)', own: true, id: '8400000000' });
  assert.deepEqual(ASP.subjectOf(u('SAJAT_NEVEN_EGYENI_VALLALKOZO', { szerepkorSajatEgyeniVallalkozo: { evAdatok: { adoszam: '12345678-1-33' } } })).id, '12345678');
  assert.deepEqual(ASP.subjectOf(u('CEG_NEVEBEN', { szerepkorCeg: { barmi: { adoszam: '87654321241' } } })).id, '87654321', 'kötőjel nélküli adószám is');
  assert.deepEqual(ASP.subjectOf(u('MAS_TERMESZETES_SZEMELY_NEVEBEN', { szerepkorMasTermeszetesSzemely: { adoazonositoJel: '8411111111' } })).id, '8411111111');
  assert.equal(ASP.subjectOf(u('CEG_NEVEBEN_ELJARVA_MASIK_CEG_KEPVISELETEBEN', { a: { adoszam: '11111111-2-41' }, b: { adoszam: '22222222-2-41' } })).id, null, 'két különböző adószámnál nem választ');
  assert.equal(ASP.subjectOf(u('CEG_NEVEBEN')).id, null);
  assert.equal(ASP.subjectOf(u('CEG_NEVEBEN', { szerepkorCeg: { cegAdatok: { adoszamTorzs: '87654321', cegjegyzekszam: '01-10-123456', iranyitoszam: '12345678' } } })).id, '87654321', 'nyolcjegyű törzsszám csak adószám nevű mezőből');
  assert.equal(ASP.subjectOf(u('CEG_NEVEBEN', { szerepkorCeg: { egyeb: '12345678' } })).id, null);
  const shape = ASP.roleShape(u('CEG_NEVEBEN', { szerepkorCeg: { nev: 'Titkos Kft', adoszam: '87654321-2-41' } }));
  assert.equal(/Titkos|87654321/.test(shape), false); assert.match(shape, /"adoszam":"99999999-9-99"/); assert.match(shape, /CEG_NEVEBEN/);
  assert.equal(ASP.subjectOf(u('VALAMI_UJ')).label, 'Ismeretlen szerepkör');
  assert.equal(ASP.subjectOf(null).id, null);
});

// ---- NAV ügyfélportál, B kör: képviselet-váltás (alapból kikapcsolva; csak a hívó kifejezett kérésére)
test('NAV B kör: adózónként vált, ellenőriz, olvas, és a végén visszavált a saját profilra', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await navLogin(twin);
  const own = await N.readOwn(ctx, navDay);
  assert.equal(own.user.profileId, 10000001);
  const targets = own.profiles.slice(0, 3); const before = twin.log.length;
  const r = await N.readClients(ctx, own.user.profileId, targets, navDay);
  assert.deepEqual([r.restored, r.skipped, r.error], [true, 0, null]);
  assert.deepEqual(r.clients.map(c => [c.ok, c.stem, c.account.debt]), [[true, targets[0].stem, 1000], [true, targets[1].stem, 2000], [true, targets[2].stem, 3000]], 'mindegyik a saját adószámláját kapta');
  assert.deepEqual(twin.navSwitches(), [targets[0].id, targets[1].id, targets[2].id, 10000001], 'három váltás, majd vissza a saját profilra');
  assert.deepEqual(twin.navSelected(), [10000001]);
  const calls = twin.log.slice(before).filter(c => c.method !== 'GET');
  assert.ok(calls.length === 4 && calls.every(c => c.method === 'PUT' && c.path === N.SWITCH), 'az egyetlen módosító kérés a képviselet-váltás');
  assert.deepEqual((await N.readOwn(ctx, navDay)).subject.own, true, 'utána a munkamenet megint a belépő saját adatait mutatja');
});

test('NAV B kör: ha a NAV nem vált vagy elutasít, annak az adózónak az adata nem kerül ki; a többi megy, és visszavált', async () => {
  const base = accountantScenario(); const probe = createGovTwin(base); const o = await N.readOwn(await navLogin(probe), navDay);
  const [a, b, c] = o.profiles;
  const twin = createGovTwin(accountantScenario({ navSwitchIgnore: a.id, navSwitchRefuse: b.id }));
  const ctx = await navLogin(twin);
  const r = await N.readClients(ctx, 10000001, [a, b, c], navDay);
  assert.deepEqual(r.clients.map(x => x.ok), [false, false, true]);
  assert.match(r.clients[0].error, /nem ezt az adózót mutatta/); assert.equal('account' in r.clients[0], false, 'a rossz adózó adata nem megy tovább');
  assert.match(r.clients[1].error, /HTTP 403/);
  assert.equal(r.clients[2].account.debt, 3000);
  assert.equal(r.restored, true); assert.deepEqual(twin.navSelected(), [10000001]);
});

test('NAV B kör: lejárt munkamenetnél megáll és jelzi, hogy a visszaváltás nem ellenőrizhető; korlát és érvénytelen célok', async () => {
  const twin = createGovTwin(accountantScenario({ navSessionCalls: 6 }));
  const ctx = await navLogin(twin); const targets = [{ id: 2000000, stem: '12345676' }, { id: 2000001, stem: '30000000' }];
  const r = await N.readClients(ctx, 10000001, targets, navDay);
  assert.match(r.error, /munkamenet/); assert.equal(r.restored, false);
  const t2 = createGovTwin(accountantScenario()); const c2 = await navLogin(t2);
  const none = await N.readClients(c2, 10000001, [{ id: 10000001, stem: '11111111' }, { id: 0, stem: '2' }, { id: 5 }, null], navDay);
  assert.deepEqual([none.clients.length, none.restored, t2.navSwitches().length], [0, true, 0], 'saját profilra, érvénytelen vagy azonosító nélküli célra nem vált');
  const lim = await N.readClients(c2, 10000001, (await N.readOwn(c2, navDay)).profiles, { ...navDay, max: 2 });
  assert.deepEqual([lim.clients.length, lim.skipped, lim.restored], [2, 21, true]);
  await assert.rejects(N.readClients(c2, null, targets, navDay), /saját adózói profil nem ismert/);
  await assert.rejects(N.switchTo(c2, 'x'), /Érvénytelen/);
});

// ---- NAV ügyfélportál, C kör: beadott bevallások lekérdezése (alapból kikapcsolva; csak a hívó kifejezett kérésére)
test('NAV C kör: a beadott bevallások a kiválasztott adózóra kérdezhetők le; ismeretlen alakú sor kimarad', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await navLogin(twin);
  const r = await N.readReturns(ctx, '8400000000');
  assert.deepEqual([r.total, r.unknown, r.items.length], [3, 1, 2]);
  assert.deepEqual(r.items[0], { regNo: '8100000001', formCode: '2658', title: 'Havi bevallás a kötelezettségekről', periodStart: '2026-09-01', periodEnd: '2026-09-30', submittedAt: '2026-10-12 09:41', state: 'Feldolgozott', kind: 'ALAPBEVALLAS' });
  await assert.rejects(N.readReturns(ctx, '12345676'), /HTTP 400/, 'nem a kiválasztott adózóra a NAV nem válaszol');
  await assert.rejects(N.readReturns(ctx, 'abc'), /Érvénytelen/);
  assert.deepEqual(N.parsePeriod('2026.01.01. - 2026.12.31.'), ['2026-01-01', '2026-12-31']); assert.deepEqual(N.parsePeriod('2026'), [null, null]);
});

test('NAV C kör a váltással együtt: ügyfelenként a saját bevallásai jönnek; a lekérdezés hibája nem dobja el a többi adatot', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await navLogin(twin); const own = await N.readOwn(ctx, navDay);
  const off = await N.readClients(ctx, own.user.profileId, own.profiles.slice(0, 1), navDay);
  assert.equal('returns' in off.clients[0], false, 'kérés nélkül nincs lekérdezés');
  assert.equal(twin.log.some(l => l.path === N.RETURNS), false);
  const r = await N.readClients(ctx, own.user.profileId, own.profiles.slice(0, 2), { ...navDay, queries: true });
  assert.deepEqual(r.clients.map(c => [c.ok, c.returns.length, c.returns[0].regNo]), [[true, 2, '8100000001'], [true, 2, '8100000101']]);
  assert.equal(r.restored, true);
  const bad = createGovTwin(accountantScenario({ navReturnsStatus: 500 })); const c2 = await navLogin(bad); const o2 = await N.readOwn(c2, navDay);
  const e = await N.readClients(c2, o2.user.profileId, o2.profiles.slice(0, 1), { ...navDay, queries: true });
  assert.deepEqual([e.clients[0].ok, e.clients[0].returns, e.clients[0].account.debt], [true, null, 1000]);
  assert.match(e.clients[0].returnsInfo.error, /HTTP 500/);
});

// ---- NAV ügyfélportál, C kör: NAV-dokumentumok lekérdezése
test('NAV dokumentumok: a kiválasztott adózóra, a megfigyelt alakkal; tokent nem visz tovább; azonosító nélküli sor kimarad', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await navLogin(twin);
  const r = await N.readDocuments(ctx, '8400000000', { today: new Date('2026-11-13T09:00:00Z') });
  assert.deepEqual([r.total, r.unknown, r.items.length], [3, 1, 2]);
  assert.deepEqual(r.items[0], { barcode: '8100000001', regNo: '8100000001/2026/NAV', subject: 'Havi bevallás', docType: 'B0001', formCode: '2658', formName: 'Szimulátor nyomtatvány', caseType: 'Szimulátor ügytípus', caseNo: '9000000001', krNo: null, submittedAt: '2026-10-20 10:08', arrivedAt: '2026-10-20 10:08', downloadedAt: null, files: 1 });
  assert.equal(JSON.stringify(r).includes('TITKOS'), false, 'letöltési token nem kerül ki');
  await assert.rejects(N.readDocuments(ctx, '12345676'), /HTTP 400/, 'nem a kiválasztott adózóra nem válaszol');
  await assert.rejects(N.readDocuments(ctx, '8400000000', { direction: 'MINDEN' }), /Ismeretlen beküldési irány/);
});

test('NAV dokumentumok a váltással: ügyfelenként a sajátjai; hiba esetén a többi adat megmarad', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await navLogin(twin); const own = await N.readOwn(ctx, navDay);
  const r = await N.readClients(ctx, own.user.profileId, own.profiles.slice(0, 2), { ...navDay, queries: true });
  assert.deepEqual(r.clients.map(c => c.documents.map(d => d.barcode)), [['8100000001', '8100000002'], ['8100000101', '8100000102']]);
  assert.equal(r.restored, true);
  const bad = createGovTwin(accountantScenario({ navDocumentsStatus: 500 })); const c2 = await navLogin(bad); const o2 = await N.readOwn(c2, navDay);
  const e = await N.readClients(c2, o2.user.profileId, o2.profiles.slice(0, 1), { ...navDay, queries: true });
  assert.deepEqual([e.clients[0].ok, e.clients[0].documents, e.clients[0].returns.length], [true, null, 2]);
  assert.match(e.clients[0].documentsInfo.error, /HTTP 500/);
});

// ---- NAV ügyfélportál, letölthető kimutatások
const X = require('../nav-exports');
const fast = { sleep: async () => {}, random: () => 0, today: new Date('2026-11-13T09:00:00Z') };

test('NAV kimutatások: adószámla PDF+XLSX, törzsadat PDF, biztosítottak XLSX – a kiválasztott adózóra', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await navLogin(twin);
  const r = await X.runExports(ctx, { profileId: 10000001, adozoTipus: 'TERMESZETESSZEMELY', ...fast });
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.files.map(f => [f.kind, f.format, f.from || null, f.to || null]), [['adoszamla', 'PDF_HITELESITETT', '2026-01-01', '2026-11-13'], ['adoszamla', 'XLSX', '2026-01-01', '2026-11-13'], ['torzsadat', 'PDF', null, null], ['biztositottak', 'XLSX', '2026-01-01', '2026-11-13']]);
  assert.match(Buffer.from(r.files[0].base64, 'base64').toString(), /^%PDF-1\.4 szimulátor adószámla 10000001/);
  const writes = twin.log.filter(l => l.method !== 'GET' && l.host === 'ugyfelportal.nav.gov.hu' && !/kaulogin/.test(l.path));
  assert.deepEqual(writes.map(l => l.path), ['/api/v1/balance/tax-invoice', '/api/foglalkoztato-lekerdezesek/biztositotti-fajlba'], 'csak a két lekérdezés-indítás megy POST-tal');
});

test('NAV kimutatások: egy fajta hibája nem állítja meg a többit; rossz formátumú fájl nem megy tovább; tiltott útvonal', async () => {
  const twin = createGovTwin(accountantScenario({ navAccountState: 'ELUTASITOTT', navOwnDataHtml: true }));
  const ctx = await navLogin(twin);
  const r = await X.runExports(ctx, { profileId: 10000001, adozoTipus: 'TERMESZETESSZEMELY', ...fast });
  assert.deepEqual(r.files.map(f => f.kind), ['biztositottak']);
  assert.match(r.notes.join(' | '), /adószámla: A NAV az adószámla-lekérdezést elutasította/); assert.match(r.notes.join(' | '), /törzsadat: A NAV nem PDF fájlt adott vissza/);
  assert.equal(X.allowed('/api/v1/user/login/change-kepviselet'), false);
  await assert.rejects(X.runExports(ctx, { profileId: 1, adozoTipus: 'MAS', ...fast }), /Ismeretlen adózótípus/);
  assert.deepEqual([X.sniff(Buffer.from('%PDF-1'), 'PDF_HITELESITETT'), X.sniff(Buffer.from('PK..'), 'XLSX'), X.sniff(Buffer.from('<html>'), 'PDF')], [true, true, false]);
});

test('NAV kimutatások ügyfélre: váltás után a képviselt adózóé jön, és megtalálható a lapozott listán', async () => {
  const twin = createGovTwin(accountantScenario());
  const ctx = await navLogin(twin);
  const t = await N.findProfile(ctx, '30000147', { sleep: async () => {} });
  assert.ok(t && t.stem === '30000147', 'a második oldalon lévő adózó is megvan');
  assert.equal(await N.findProfile(ctx, '99999999', { sleep: async () => {} }), null);
  await N.switchTo(ctx, t.id);
  const r = await X.runExports(ctx, { profileId: t.id, adozoTipus: 'CEG', kinds: ['adoszamla', 'torzsadat'], ...fast });
  assert.deepEqual(r.notes, []);
  assert.match(Buffer.from(r.files[2].base64, 'base64').toString(), new RegExp(`törzsadat CEG ${t.id}`));
});

