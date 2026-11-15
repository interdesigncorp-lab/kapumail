// Osztott képernyős (split-screen) ASP szinkronablak, automatikus KAÜ+TOTP belépés és saját neves háttérolvasás tesztjei.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const L = require('../asp-live');

test('normalizeItems: Saját adatom legfelül, 11 és 8 jegyű adószámok tisztítva, mai pipák megtartva', () => {
  const items = L.normalizeItems([
    { own: false, name: 'Alfa Kft.', tax: '12345678-2-41', doneToday: true, summary: '2 önkormányzat · ma lekérdezve' },
    { own: false, name: 'Béta Bt.', tax: '87654321', doneToday: false },
    { own: false, name: 'Magán Ügyfél', tax: '8412345678', doneToday: false },
    { own: false, name: 'Érvénytelen', tax: 'abc' },
    { own: true, name: 'Saját adatom', doneToday: false },
  ]);
  assert.deepEqual(items.map(x => [x.key, x.state, x.stem, x.tax11]), [
    ['own', 'todo', '', ''],
    ['client:12345678', 'done', '12345678', '12345678241'],
    ['client:87654321', 'todo', '87654321', ''],
    ['client:8412345678', 'todo', '8412345678', '8412345678'],
  ]);
  assert.equal(items[1].fresh, false);
  assert.match(items[1].summary, /ma lekérdezve/);
});

function makeKauPortalEnv({ userFn, rejectPassword = false }) {
  const ses = {
    handlers: {}, cleared: 0, fetched: [],
    setPermissionRequestHandler: () => {},
    webRequest: {
      onBeforeRequest: (f, cb) => { ses.handlers.before = cb || f; },
      onCompleted: (f, cb) => { ses.handlers.completed = cb || f; },
    },
    on: () => {},
    clearStorageData: async () => { ses.cleared += 1; },
  };
  let nextId = 10;
  let stage = 'selector';

  function makeWc(owner) {
    const wc = Object.assign(new EventEmitter(), {
      id: nextId++,
      at: '',
      sent: [],
      dead: false,
      isDestroyed() { return this.dead; },
      close() { this.dead = true; },
      send(ch, payload) { this.sent.push([ch, payload]); },
      getURL() { return this.at; },
      setWindowOpenHandler: () => {},
      loadFile: async file => { wc.loadedFile = file; },
      loadURL: async url => {
        wc.at = url;
        if (url === 'https://ohp-20.asp.lgov.hu/login') {
          wc.at = 'https://kau.gov.hu/proxy/saml/authnrequest';
          stage = 'selector';
        }
        wc.emit('did-navigate', {}, wc.at);
      },
      executeJavaScript: async code => {
        const s = String(code);
        // Portál GET hívások
        const m = /^\(async \(\) => \{ const r = await fetch\("([^"]+)", \{ method: 'GET'.*credentials: 'include'/.exec(s);
        if (m) {
          ses.fetched.push(m[1]);
          const u = userFn();
          return { status: u ? 200 : 401, url: 'https://ohp-20.asp.lgov.hu' + m[1], redirected: false, type: 'application/json', text: JSON.stringify({ body: u, length: 1 }) };
        }
        // Szerepkörváltó link keresése a portálon
        if (s.includes('szerepkor') && s.includes('routerlink')) return false;
        // KAÜ módválasztó
        if (s.includes(':uk:totp')) {
          stage = 'creds';
          wc.at = 'https://idp.gov.hu/idp/profile/SAML2/Redirect/SSO';
          return 'ok';
        }
        if (s.includes("querySelector('#name') && document.querySelector('#password')")) {
          return stage === 'creds';
        }
        if (s.includes("querySelector('#name'), p = document.querySelector('#password')")) {
          stage = rejectPassword ? 'bad-cred' : 'totp';
          return 'submitted';
        }
        if (s.includes("if (document.querySelector('#identifier')) return 'totp'")) {
          return stage === 'totp' ? 'totp' : stage === 'bad-cred' ? 'bad-cred' : 'wait';
        }
        if (s.includes("const inp = document.querySelector('#identifier')") && s.includes('submitted')) {
          stage = 'done';
          wc.at = 'https://ohp-20.asp.lgov.hu/successful-login';
          setImmediate(() => wc.emit('did-navigate', {}, wc.at));
          return 'submitted';
        }
        return false;
      },
    });
    if (owner) owner.webContents = wc;
    return wc;
  }

  const wins = [];
  const views = [];
  class BrowserWindow extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.dead = false;
      this.titles = [];
      this.size = [opts.width || 1400, opts.height || 880];
      this.children = [];
      this.contentView = {
        addChildView: v => this.children.push(v),
        removeChildView: v => { this.children = this.children.filter(x => x !== v); },
      };
      makeWc(this);
      wins.push(this);
    }
    getContentSize() { return this.size; }
    isDestroyed() { return this.dead; }
    destroy() { if (!this.dead) { this.dead = true; this.emit('closed'); } }
    setTitle(t) { this.titles.push(t); }
  }
  class WebContentsView {
    constructor(opts) {
      this.opts = opts;
      this.bounds = null;
      makeWc(this);
      views.push(this);
    }
    setBounds(b) { this.bounds = b; }
  }
  return { ses, session: { fromPartition: () => ses }, BrowserWindow, WebContentsView, wins, views };
}

const CREDS = { username: 'teszt.konyvelo', password: 'titkos-jelszo', totpSeed: 'JBSWY3DPEHPK3PXP' };
const OWN_USER = { name: 'TESZT KÖNYVELŐ', adoazonosito: '8400000000', roleDetails: { szerepkor: 'SAJAT_NEVEN_TERMESZETES_SZEMELY' } };
const FIRM1 = { ...OWN_USER, roleDetails: { szerepkor: 'CEG_NEVEBEN', szerepkorCeg: { cegadatok: { adoszam: '12345678241' } } } };
const FIRM2 = { ...OWN_USER, roleDetails: { szerepkor: 'CEG_NEVEBEN', szerepkorCeg: { cegadatok: { adoszam: '87654321242' } } } };

test('runOwnAuto: rejtett ablakban belép KAÜ+TOTP-vel, kiolvassa a saját szerepkört, majd törli a munkamenetet', async () => {
  let current = OWN_USER;
  const env = makeKauPortalEnv({ userFn: () => current });
  let usedStep = null;
  const r = await L.runOwnAuto({
    BrowserWindow: env.BrowserWindow,
    session: env.session,
    creds: CREDS,
    sleep: async () => {},
    onTotpUsed: s => { usedStep = s; },
    read: async ctx => {
      assert.equal(ctx.browser, true);
      return {
        user: { name: 'TESZT KÖNYVELŐ' },
        subject: { role: 'SAJAT_NEVEN_TERMESZETES_SZEMELY', own: true, id: '8400000000' },
        permissions: {}, skipped: 0,
        tenants: [{ uid: 't1', city: 'Budapest', balance: { pdf: Buffer.from('%PDF-1.4 sajat'), year: 2026, kind: 'DETAILED', status: 'Sikeres' }, returns: [], cases: 0, notes: [] }],
      };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(env.wins[0].opts.show, false, 'a saját neves automata olvasás rejtett ablakban fut');
  assert.equal(typeof usedStep, 'number');
  assert.equal(r.tenants.length, 1);
  assert.equal(Buffer.from(r.tenants[0].balance.pdfBase64, 'base64').toString(), '%PDF-1.4 sajat');
  assert.equal(env.wins[0].dead && env.ses.cleared >= 1, true);
});

test('runOwnAuto: hibás jelszónál nem próbálkozik végtelen ciklusban, és badCreds jelzéssel megáll', async () => {
  const env = makeKauPortalEnv({ userFn: () => OWN_USER, rejectPassword: true });
  const r = await L.runOwnAuto({
    BrowserWindow: env.BrowserWindow,
    session: env.session,
    creds: CREDS,
    sleep: async () => {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.badCreds, true);
  assert.match(r.error, /felhasználónevet vagy a jelszót/);
});

test('runSplit: osztott képernyő, automata belépés, élő pipálás és automatikus ugrás a következő ügyfélre', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  L.register(ipcMain);

  let current = OWN_USER;
  const env = makeKauPortalEnv({ userFn: () => current });
  const copied = [];
  const clipboard = { writeText: txt => copied.push(txt) };
  const ingested = [];

  const read = async () => {
    const sub = current === OWN_USER
      ? { role: 'SAJAT_NEVEN_TERMESZETES_SZEMELY', own: true, id: '8400000000' }
      : current === FIRM1
        ? { role: 'CEG_NEVEBEN', own: false, id: '12345678' }
        : { role: 'CEG_NEVEBEN', own: false, id: '87654321' };
    return {
      user: { name: 'TESZT' },
      subject: sub,
      permissions: {}, skipped: 0,
      tenants: [{ uid: 'u1', city: 'Pécs', balance: { pdf: Buffer.from('%PDF-1.4 ceg'), year: 2026, kind: 'DETAILED', status: 'Sikeres' }, returns: [{}], cases: 0, notes: [] }],
    };
  };

  const runPromise = L.runSplit({
    BrowserWindow: env.BrowserWindow,
    WebContentsView: env.WebContentsView,
    session: env.session,
    clipboard,
    creds: CREDS,
    sleep: async () => {},
    items: [
      { own: true, name: 'Saját adatom', doneToday: false },
      { own: false, name: 'Alfa Kft.', tax: '12345678-2-41', doneToday: false },
      { own: false, name: 'Béta Kft.', tax: '87654321-2-42', doneToday: false },
    ],
    onIngest: async data => {
      ingested.push(data.subject);
      return { ok: true, saved: 2, pdfs: 1 };
    },
    read,
  });

  const [panelView, portalView] = env.views;
  const win = env.wins[0];
  assert.deepEqual(panelView.bounds, { x: 0, y: 0, width: 380, height: 880 });
  assert.deepEqual(portalView.bounds, { x: 380, y: 0, width: 1020, height: 880 });

  // Átméretezéskor mindkét fél követi az ablakot
  win.size = [1200, 700];
  win.emit('resize');
  assert.equal(panelView.bounds.height, 700);
  assert.equal(portalView.bounds.x + portalView.bounds.width, 1200);

  // Idegen webContents nem fér hozzá a panel IPC-hez
  assert.equal(await handlers.get('aspPanel:state')({ sender: { id: 99999 } }), null);

  // Megvárjuk az automata belépést és a Saját adatom automatikus beolvasását
  for (let i = 0; i < 40 && ingested.length < 1; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].own, true);

  let st = await handlers.get('aspPanel:state')({ sender: { id: panelView.webContents.id } });
  assert.equal(st.items[0].state, 'done', 'a Saját adatom megkapta a pipát');
  assert.equal(st.items[0].fresh, true);
  assert.match(st.items[0].summary, /2 önkormányzat · 1 kivonat/);
  // Automatikusan kijelölte az első még nem szinkronizált ügyfelet (Alfa Kft.), vágólapra tette a 11 jegyű adószámát, és megnyitotta a szerepkörváltást
  assert.equal(st.selectedKey, 'client:12345678');
  assert.equal(copied.at(-1), '12345678241');
  assert.equal(portalView.webContents.getURL(), 'https://ohp-20.asp.lgov.hu/szerepkorvalasztas');

  // A 8 jegyű törzsszám másolása külön gombbal
  await handlers.get('aspPanel:select')({ sender: { id: panelView.webContents.id } }, 'client:12345678', '12345678', 'stem');
  assert.equal(copied.at(-1), '12345678');

  // A felhasználó átvált Alfa Kft.-re a jobb oldali portálon -> automatikus olvasás, mentés, pipa, ugrás Béta Kft.-re!
  current = FIRM1;
  env.ses.handlers.completed({ method: 'PUT', statusCode: 200 });
  for (let i = 0; i < 40 && ingested.length < 2; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(ingested.length, 2);
  assert.equal(ingested[1].id, '12345678');

  st = await handlers.get('aspPanel:state')({ sender: { id: panelView.webContents.id } });
  assert.equal(st.items[1].state, 'done', 'Alfa Kft. is megkapta a pipát');
  assert.equal(st.selectedKey, 'client:87654321', 'automatikusan átugrott Béta Kft.-re');
  assert.equal(copied.at(-1), '87654321242', 'Béta Kft. adószáma már a vágólapon van');

  // Változatlan szerepkör beküldésénél helybeni figyelmeztetést ad, és nem olvas duplán
  env.ses.handlers.before({
    url: 'https://ohp-20.asp.lgov.hu/api/role',
    method: 'PUT',
    uploadData: [{ bytes: Buffer.from(JSON.stringify({ szerepkor: 'CEG_NEVEBEN', szerepkorCeg: { cegadatok: { adoszam: '12345678241' } } })) }],
  }, () => {});
  env.ses.handlers.completed({ method: 'PUT', statusCode: 200 });
  await new Promise(r => setTimeout(r, 1200));
  st = await handlers.get('aspPanel:state')({ sender: { id: panelView.webContents.id } });
  assert.match(st.warning || '', /A szerepkör nem változott/);
  assert.equal(ingested.length, 2);

  // Kész gombbal bezárjuk az osztott ablakot
  await handlers.get('aspPanel:close')({ sender: { id: panelView.webContents.id } });
  const final = await runPromise;
  assert.deepEqual(final, { ok: true, split: true, syncedCount: 2, badCreds: false });
  assert.equal(win.dead && env.ses.cleared >= 1, true);
});

test('asp-panel.html és app.html segédek: szigorú CSP, nincs idegen innerHTML, aspBuildItems és aspOwnStep működik', async () => {
  const panelHtml = fs.readFileSync(path.join(__dirname, '..', 'asp-panel.html'), 'utf8');
  const panelJs = fs.readFileSync(path.join(__dirname, '..', 'asp-panel.js'), 'utf8');
  assert.match(panelHtml, /default-src 'none'/);
  assert.match(panelHtml, /CAPTCHA védi a robotbejárás ellen/);
  assert.equal(/innerHTML/.test(panelJs), false, 'a panel kizárólag biztonságos DOM/textContent építést használ');

  const appHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'resources', 'ui', 'app.html'), 'utf8');
  assert.match(appHtml, /CAPTCHA védi a robotbejárás ellen/);
  const s = appHtml.indexOf('let ASPST=');
  const e = appHtml.indexOf('function aspPdf(');
  assert.ok(s > 0 && e > s);
  const snippet = appHtml.slice(s, e);

  const calls = [];
  const fn = new Function('window', 'api', 'sysOn', 'TODAY', 'CLIENTS', 'ASPST_INIT', `
    ${snippet}
    ASPST = ASPST_INIT;
    return { aspBuildItems, aspOwnStep };
  `)(
    { iratkapuDesktop: { asp: { readOwnAuto: async key => { calls.push(['readOwnAuto', key]); return { ok: true, subject: { own: true, role: 'SAJAT_NEVEN_TERMESZETES_SZEMELY', id: '8400000000' }, tenants: [{ uid: 'a', name: 'Bp', city: 'Budapest', balance: null, returns: [], cases: 0, notes: [] }] }; } } } },
    async (m, u, b) => { calls.push([m, u, b]); return { ok: true, saved: 1, pdfs: 0 }; },
    () => true,
    '2026-11-15',
    [
      { id: 'c1', name: 'Zéta Kft.', tax: '11111111-2-41', active: true, auth: '2027-01-01', via: null },
      { id: 'c2', name: 'Alfa Bt.', tax: '22222222-1-42', active: true, auth: null, via: null },
      { id: 'c3', name: 'Inaktív Kft.', tax: '33333333-2-41', active: false, auth: null, via: null },
      { id: 'c4', name: 'Saját gyűjtő', tax: '8400000000', active: true, auth: null, via: 'own' },
    ],
    [{ id: 1, own: false, c: 'c2', at: '2026-11-15 08:10' }],
  );

  const built = fn.aspBuildItems();
  assert.deepEqual(built.map(x => [x.name, x.doneToday]), [
    ['Saját adatom', false],
    ['Alfa Bt.', true],
    ['Zéta Kft.', false],
  ]);

  const ownRes = await fn.aspOwnStep({ id: 1, vaultKey: 'portal-1', mine: true, authMode: 'totp', subjectScope: 'all' });
  assert.equal(ownRes.ok, true);
  assert.match(ownRes.text, /1 önkormányzat/);
  assert.equal(calls[0][0], 'readOwnAuto');
  assert.equal(calls[1][1], 'asp/ingest');
});
