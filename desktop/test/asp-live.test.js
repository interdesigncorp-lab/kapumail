// Az ASP ablakos útja: hová navigálhat az ablak, és hogyan megy végig a belépés → rákérdezés → beolvasás (ál-Electronnal).
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const L = require('../asp-live');

test('az ablak csak a portálra és az azonosító szolgáltatókra navigálhat', () => {
  const urls = ['https://ohp-20.asp.lgov.hu/login', 'http://ohp-20.asp.lgov.hu/successful-login', 'https://kau.gov.hu/proxy/saml/authservice', 'https://idp.gov.hu/idp', 'https://idp.dap.gov.hu/qr-provider/authz',
    'https://tarhely.gov.hu/levelezes/', 'https://ugyfelportal.nav.gov.hu/', 'https://masik.asp.lgov.hu/', 'https://ohp-20.asp.lgov.hu.evil.com/', 'https://evilkau.gov.hu/', 'file:///etc/passwd', 'nem cím'];
  assert.deepEqual(urls.map(L.allowedNav), [true, true, true, true, true, false, false, false, false, false, false, false]);
  assert.equal(L.PARTITION.startsWith('persist:'), false, 'a munkamenet nem marad a lemezen');
});

function fakeElectron({ user, picks }) {
  const ses = { handlers: {}, cleared: 0, fetched: [],
    webRequest: { onBeforeRequest: (f, cb) => { ses.handlers.before = cb || f; }, onCompleted: (f, cb) => { ses.handlers.completed = cb || f; } },
    on: () => {}, clearStorageData: async () => { ses.cleared += 1; },
  };
  let win = null;
  class BrowserWindow extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.webContents = Object.assign(new EventEmitter(), { loadURL: async url => { this.loaded = url; this.at = url; }, getURL: () => this.at, setWindowOpenHandler: () => {},
      // a portáloldalon futó kérést utánozza: csak a kért útvonalat jegyzi fel
      executeJavaScript: async code => { const m = /^\(async \(\) => \{ const r = await fetch\("([^"]+)", \{ method: 'GET'.*credentials: 'include'/.exec(code); assert.ok(m, 'csak GET, a munkamenet sütijeivel, natív async függvényben'); ses.fetched.push(m[1]); return { status: user() ? 200 : 401, url: 'https://ohp-20.asp.lgov.hu' + m[1], redirected: false, text: JSON.stringify({ body: user(), length: 1 }) }; } });
    this.webContents.on('did-navigate', (_e, url) => { this.at = url; }); this.webContents.on('did-navigate-in-page', (_e, url) => { this.at = url; }); this.dead = false; this.titles = []; win = this; }
    isDestroyed() { return this.dead; } destroy() { if (!this.dead) { this.dead = true; this.emit('closed'); } } setTitle(t) { this.titles.push(t); }
  }
  const shown = [];
  const dialog = { showMessageBox: async (_w, o) => { shown.push(o.detail); return { response: picks.shift() }; } };
  return { ses, session: { fromPartition: () => ses }, BrowserWindow, dialog, shown, win: () => win };
}
const tick = () => new Promise(r => setTimeout(r, 5));
const own = { name: 'SZIMULÁTOR KÖNYVELŐ', adoazonosito: '8400000000', roleDetails: { szerepkor: 'SAJAT_NEVEN_TERMESZETES_SZEMELY' } };
const firm = { ...own, roleDetails: { szerepkor: 'CEG_NEVEBEN', szerepkorCeg: { adoszam: '12345678-2-41' } } };

test('belépés előtt a program egy kérést sem küld; belépés után rákérdez, és csak rábólintásra olvas', async () => {
  let current = own; const f = fakeElectron({ user: () => current, picks: [0] });
  const read = async ctx => { assert.equal(ctx.browser, true); return { user: { name: 'X' }, subject: { role: 'SAJAT_NEVEN_TERMESZETES_SZEMELY', own: true, id: '8400000000' }, permissions: {}, skipped: 0, tenants: [{ uid: 'a', balance: { pdf: Buffer.from('%PDF-1.4 x'), year: 2026, kind: 'DETAILED', status: 'OK' } }, { uid: 'b', balance: null }] }; };
  const p = L.run({ BrowserWindow: f.BrowserWindow, session: f.session, dialog: f.dialog, read });
  const w = f.win();
  assert.equal(w.loaded, 'https://ohp-20.asp.lgov.hu/login');
  assert.equal(w.opts.webPreferences.sandbox && w.opts.webPreferences.contextIsolation && !w.opts.webPreferences.nodeIntegration, true);
  w.webContents.emit('did-navigate', {}, 'https://kau.gov.hu/proxy/saml/authservice');
  w.webContents.emit('did-navigate', {}, 'https://ohp-20.asp.lgov.hu/nyitolap');
  await tick();
  assert.deepEqual(f.ses.fetched, [], 'belépés előtt nincs kérés');
  w.webContents.emit('did-navigate', {}, 'https://ohp-20.asp.lgov.hu/successful-login');
  const r = await p;
  assert.equal(r.ok, true);
  assert.deepEqual(r.tenants.map(t => t.balance && [t.balance.bytes, Buffer.from(t.balance.pdfBase64, 'base64').toString(), 'pdf' in t.balance]), [[10, '%PDF-1.4 x', false], null]);
  assert.match(f.shown[0], /Saját néven \(magánszemélyként\)\./);
  assert.equal(w.dead && f.ses.cleared >= 1, true, 'a végén az ablak bezárul és a munkamenet törlődik');
});

test('szerepkörváltás után új szerepkörrel kérdez rá; „Mégse” és ablakbezárás esetén nem olvas', async () => {
  let current = own; let reads = 0; const f = fakeElectron({ user: () => current, picks: [1, 2] });
  const p = L.run({ BrowserWindow: f.BrowserWindow, session: f.session, dialog: f.dialog, read: async () => { reads += 1; return { tenants: [] }; } });
  const w = f.win();
  w.webContents.emit('did-navigate', {}, 'https://ohp-20.asp.lgov.hu/successful-login'); await tick();
  w.webContents.emit('did-navigate-in-page', {}, 'https://ohp-20.asp.lgov.hu/szerepkorvalasztas'); await tick();
  assert.equal(f.shown.length, 1, 'ugyanarra a szerepkörre nem kérdez rá kétszer');
  f.ses.handlers.completed({ method: 'PUT', statusCode: 200 }); await new Promise(r => setTimeout(r, 1300));
  assert.equal(f.shown.length, 1, 'a 200-as válasz magában nem váltás: változatlan szerepkörre nem kérdez újra');
  current = firm; f.ses.handlers.completed({ method: 'PUT', statusCode: 200 });
  const r = await p;
  assert.match(f.shown[1], /Cég nevében \(12345678\)\./);
  assert.deepEqual([r.ok, r.cancelled, reads], [false, true, 0]);

  const g = fakeElectron({ user: () => null, picks: [] });
  const q = L.run({ BrowserWindow: g.BrowserWindow, session: g.session, dialog: g.dialog, read: async () => { throw new Error('nem hívható'); } });
  g.win().webContents.emit('did-navigate', {}, 'https://ohp-20.asp.lgov.hu/successful-login'); await tick();
  assert.equal(g.shown.length, 0, 'ha a portál nem ad felhasználót, nem kérdez és nem olvas');
  g.win().destroy();
  assert.deepEqual([(await q).ok, (await q).cancelled], [false, true]);
});

test('ha a szerepkör a rábólintás után más, mint amire a felhasználó rábólintott, semmit nem ad tovább', async () => {
  const sub = u => ({ role: u.roleDetails.szerepkor, own: u.roleDetails.szerepkor === 'SAJAT_NEVEN_TERMESZETES_SZEMELY', id: u.roleDetails.szerepkor === 'CEG_NEVEBEN' ? '12345678' : '8400000000' });
  // (1) a beolvasás már más szerepkörben futott; (2) a beolvasás közben váltott át
  for (const when of ['before', 'during']) {
    let current = own; const f = fakeElectron({ user: () => current, picks: [0] });
    const read = async () => { if (when === 'before') return { subject: sub(firm), tenants: [] }; const s = sub(current); current = firm; return { subject: s, tenants: [] }; };
    const p = L.run({ BrowserWindow: f.BrowserWindow, session: f.session, dialog: f.dialog, read });
    f.win().webContents.emit('did-navigate', {}, 'https://ohp-20.asp.lgov.hu/successful-login');
    const r = await p;
    assert.equal(r.ok, false, when); assert.match(r.error, /semmit nem mentettem/); assert.equal('tenants' in r, false);
  }
});

test('ha a felhasználó ugyanazt a szerepkört küldi be, a program szól, hogy nem változott; más szerepkör kérésénél nem zavar', async () => {
  const put = body => ({ url: 'https://ohp-20.asp.lgov.hu/api/role', method: 'PUT', uploadData: [{ bytes: Buffer.from(JSON.stringify({ ...body, turnstileToken: 'titok', confirmed: false })) }] });
  const wait = () => new Promise(r => setTimeout(r, 1300));
  let reads = 0; const f = fakeElectron({ user: () => own, picks: [1, 0, 1] });
  const p = L.run({ BrowserWindow: f.BrowserWindow, session: f.session, dialog: f.dialog, read: async () => { reads += 1; return { subject: { role: 'SAJAT_NEVEN_TERMESZETES_SZEMELY', own: true, id: '8400000000' }, tenants: [] }; } });
  f.win().webContents.emit('did-navigate', {}, 'https://ohp-20.asp.lgov.hu/successful-login'); await tick();
  assert.equal(f.shown.length, 1);
  // másik szerepkört kért (a portál megerősítést kérhet vagy hibát jelez): nincs figyelmeztetés
  let passed = null; f.ses.handlers.before(put({ adoazonosito: '8400000000', szerepkor: 'CEG_NEVEBEN', szerepkorCeg: { adoszam: '12345678-2-41' } }), r => { passed = r; });
  assert.deepEqual(passed, {}, 'a szerepkörváltó kérést a program nem módosítja és nem állítja meg');
  f.ses.handlers.completed({ method: 'PUT', statusCode: 200 }); await wait();
  assert.equal(f.shown.length, 1);
  // ugyanazt a szerepkört küldte be: figyelmeztetés, „Újra próbálom” → nem olvas
  f.ses.handlers.before(put({ adoazonosito: '8400000000', szerepkor: 'SAJAT_NEVEN_TERMESZETES_SZEMELY' }), () => {});
  f.ses.handlers.completed({ method: 'PUT', statusCode: 200 }); await wait();
  assert.equal(f.shown.length, 2); assert.match(f.shown[1], /Továbbra is ebben a szerepkörben vagy: Saját néven/); assert.equal(reads, 0);
  assert.equal(f.shown.join(' ').includes('titok'), false);
  // még egyszer ugyanaz: figyelmeztetés, „Beolvasás ebben a szerepkörben” → olvas
  f.ses.handlers.before(put({ adoazonosito: '8400000000', szerepkor: 'SAJAT_NEVEN_TERMESZETES_SZEMELY' }), () => {});
  f.ses.handlers.completed({ method: 'PUT', statusCode: 200 });
  const r = await p;
  assert.deepEqual([r.ok, reads, f.shown.length], [true, 1, 3]);
  // a http-s kérések emelése ugyanazon a figyelőn át továbbra is megy, idegen gépre nem
  const g = fakeElectron({ user: () => null, picks: [] }); const q = L.run({ BrowserWindow: g.BrowserWindow, session: g.session, dialog: g.dialog });
  let a, b; g.ses.handlers.before({ url: 'http://ohp-20.asp.lgov.hu/successful-login', method: 'GET' }, r => { a = r; }); g.ses.handlers.before({ url: 'http://evil.example/', method: 'GET' }, r => { b = r; });
  assert.deepEqual([a, b], [{ redirectURL: 'https://ohp-20.asp.lgov.hu/successful-login' }, { cancel: true }]);
  g.win().destroy(); await q;
});
