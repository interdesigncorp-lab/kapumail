const test = require('node:test'); const assert = require('node:assert'); const vm = require('vm');
const L = require('../tarhely-live');

// A KAÜ módválasztójának 2026-11-11-én élőben látott szerkezete: három űrlap, beszédes azonosítóval.
function kauDoc(ids) {
  const clicked = [];
  const forms = ids.map(id => ({ id, querySelector: () => ({ click: () => clicked.push(id) }), submit: () => clicked.push('submit:' + id) }));
  return { clicked, document: { forms, querySelectorAll: () => [], getElementById: () => null } };
}
const IDS = ['urn:eksz.gov.hu:1.0:azonositas:kau:3:dap:qr', 'urn:eksz.gov.hu:1.0:azonositas:kau:2:uk:totp', 'urn:eksz.gov.hu:1.0:azonositas:kau:2:uk:email'];

test('mindhárom mód a saját űrlapját küldi el, és csak azt', () => {
  for (const [mode, id] of [['dap', IDS[0]], ['totp', IDS[1]], ['email', IDS[2]]]) {
    const d = kauDoc(IDS); assert.equal(vm.runInNewContext(L.selectScript(mode), d), 'ok'); assert.deepEqual(d.clicked, [id]);
  }
});
test('a szintszám változása nem töri el, a hiányzó mód viszont hiba', () => {
  const d = kauDoc(['urn:eksz.gov.hu:1.0:azonositas:kau:4:uk:email']); assert.equal(vm.runInNewContext(L.selectScript('email'), d), 'ok');
  assert.equal(vm.runInNewContext(L.selectScript('dap'), kauDoc([IDS[1]])), 'no-form');
  assert.equal(vm.runInNewContext(L.selectScript('dap'), kauDoc([])), 'not-ready');
  assert.throws(() => L.selectScript('jelszo'));
});
test('a belépőablak csak https kormányzati címet tölthet be', () => {
  for (const u of ['https://kau.gov.hu/proxy/saml/authservice', 'https://idp.gov.hu/idp/saml/authnrequest', 'https://idp.dap.gov.hu/qr-provider/authz', 'https://tarhely.gov.hu/levelezes/', 'https://upo.nav.gov.hu/']) assert.equal(L.allowedUrl(u), true, u);
  for (const u of ['http://kau.gov.hu/', 'https://kau.gov.hu.evil.example/', 'https://evilgov.hu/', 'https://example.com/?x=tarhely.gov.hu', 'file:///etc/passwd', 'javascript:alert(1)', '']) assert.equal(L.allowedUrl(u), false, u);
  assert.equal(L.phaseOf('https://kau.gov.hu/x'), 'kau'); assert.equal(L.phaseOf('https://tarhely.gov.hu/levelezes/'), 'tarhely'); assert.equal(L.phaseOf('https://idp.dap.gov.hu/'), 'other');
});
test('postafiókok és gazdagított levélsor átalakítása (30 napos lejárat + tartós tár)', () => {
  const refs = L.toMailboxRefs([{ mailboxName: 'Értesítési tárhely', azonosito: 'a1' }, { megnevezes: 'nincs azonosító' }, { megnevezes: '12345678 (Példa Kft)', azonosito: 'b2' }]);
  assert.deepEqual(refs.map(r => [r.index, r.name, r.addressId]), [[0, 'Értesítési tárhely · a1', 'a1'], [2, '12345678 (Példa Kft) · b2', 'b2']]);
  assert.deepEqual(L.toMailboxRefs(null), []);
  const row = L.apiRow({ erkeztetesiSzam: 'E1', feladoNev: 'Nemzeti Adó- és Vámhivatal', feladoRovidNev: 'NAV', cimzettNev: 'Példa Kft.', dokumentumTipus: 'T', dokumentumLeiras: 'D', erkezesiDatum: '2026-11-09T08:15:00Z', fajlMeret: 24576, olvasott: false }, 'Fiók');
  assert.deepEqual(row, {
    eid: 'E1', mailbox: 'Fiók', sender: 'NAV', senderFull: 'Nemzeti Adó- és Vámhivatal', recipient: 'Példa Kft.',
    type: 'T', desc: 'D', receivedAt: '2026-11-09 08:15', size: 24576, portalOpened: false,
    expiresAt: '2026-12-09', durable: false, folder: 'BEERKEZETT',
  });
  const durableRow = L.apiRow({ erkeztetesiSzam: 'E2', erkezesiDatum: '2026-11-01T10:00:00Z' }, 'Fiók', 'TARTOS_TAR');
  assert.equal(durableRow.durable, true);
  assert.equal(durableRow.expiresAt, null);
  assert.equal(durableRow.folder, 'TARTOS_TAR');
  const expRow = L.apiRow({ erkeztetesiSzam: 'E3', erkezesiDatum: '2026-11-01T10:00:00Z', torlesDatum: '2026-11-25T23:59:00Z' }, 'Fiók');
  assert.equal(expRow.expiresAt, '2026-11-25');
  assert.equal(L.apiRow({ erkezesiDatum: 'nem dátum' }, 'x').receivedAt, '');
});
test('ÜK+ űrlapkitöltő szkriptek (felhasználónév/jelszó + 6 jegyű TOTP)', () => {
  const mkInput = () => ({ value: '', events: [], dispatchEvent(e) { this.events.push(e.type); } });
  const u = mkInput(), p = mkInput(), totp = mkInput();
  let submitted = 0;
  const ctx1 = {
    Event: class { constructor(type) { this.type = type; } },
    HTMLInputElement: { prototype: {} },
    document: {
      querySelector: sel => sel === '#name' ? u : sel === '#password' ? p : null,
      querySelectorAll: () => [{ innerText: 'Bejelentkezés', click: () => { submitted++; } }],
    },
  };
  assert.equal(vm.runInNewContext(L.fillCredentialsScript('teszt.elek', 'Titkos"Jelszo!'), ctx1), 'submitted');
  assert.equal(u.value, 'teszt.elek');
  assert.equal(p.value, 'Titkos"Jelszo!');
  assert.equal(submitted, 1);

  const ctx2 = {
    Event: class { constructor(type) { this.type = type; } },
    HTMLInputElement: { prototype: {} },
    document: {
      querySelector: sel => sel === '#identifier' ? totp : null,
      querySelectorAll: () => [{ innerText: 'Tovább', click: () => { submitted++; } }],
    },
  };
  assert.equal(vm.runInNewContext(L.fillTotpScript('287082'), ctx2), 'submitted');
  assert.equal(totp.value, '287082');
  assert.equal(submitted, 2);
});
test('a tárhelyhez csak olvasó/kereső és egyedi letöltő végpont megy, módosító/törlő/küldő soha', () => {
  const src = require('fs').readFileSync(require.resolve('../tarhely-live'), 'utf8');
  assert.match(L.listScript('a1', 'x', 0), /\/levelezes\/api\/uzenetek\/BEERKEZETT\/kereses/);
  assert.match(L.listScript('a1', 'x', 0, 'TARTOS_TAR'), /\/levelezes\/api\/uzenetek\/TARTOS_TAR\/kereses/);
  assert.match(L.detailScript('a1', 'x', 'E-123'), /\/levelezes\/api\/uzenet\/beerkezett\/E-123/);
  assert.match(L.downloadScript('a1', 'x', 'E-123'), /\/levelezes\/api\/uzenet\/letoltes\/beerkezett\/E-123/);
  assert.match(L.downloadScript('a1', 'x', 'E-123', 'TARTOS_TAR'), /\/levelezes\/api\/uzenet\/letoltes\/tartostar\/E-123/); // élőben igazolt alak; a rövid „tartos” 500-at ad
  assert.match(L.listScript('a1', 'x', 0, 'ELKULDOTT'), /\/levelezes\/api\/uzenetek\/ELKULDOTT\/kereses/);
  assert.match(L.downloadScript('a1', 'x', 'E-123', 'ELKULDOTT'), /\/levelezes\/api\/uzenet\/letoltes\/elkuldott\/E-123/);
  assert.equal(/method:\s*['"](DELETE|PUT|PATCH)['"]|\/kuldes|\/torles/.test(src), false);
});
test('kapcsolat nélkül a listázás, postafiók-lekérés és letöltés elutasít', async () => {
  const s = new L.LiveSession({ BrowserWindow: null, session: null });
  assert.equal(s.status().status, 'idle');
  assert.equal(s.mailboxes().ok, false);
  assert.equal((await s.list()).code, 3);
  assert.equal((await s.downloadOne('Fiók', 'E1')).code, 3);
  s.s.status = 'connected'; s.win = {};
  assert.equal((await s.downloadOne('Fiók', '../bad')).code, 1);
});

test('a munkamenet megjegyzi, melyik kapcsolathoz tartozik, és bontáskor elfelejti', async () => {
  const ses = { setPermissionRequestHandler() {}, clearStorageData: async () => {} };
  class Win {
    constructor() { this.webContents = { on() {}, setWindowOpenHandler() {} }; }
    on() {} loadURL() { return Promise.resolve(); } isDestroyed() { return false; } isVisible() { return true; } destroy() {}
  }
  const s = new L.LiveSession({ BrowserWindow: Win, session: { fromPartition: () => ses } });
  assert.equal((await s.start('dap', null, { portalId: 'portal-a' })).ok, true);
  assert.equal(s.status().portalId, 'portal-a');
  assert.equal((await s.start('email', null)).ok, true);
  assert.equal(s.status().portalId, null);
  await s.close();
  assert.equal(s.status().portalId, null);
  assert.equal(s.status().status, 'idle');
});

// ---- A belépés utáni feltöltés (_prime) viselkedése utánzott ablakkal ----
// 2026-11-13-i élő próba: a feltöltés azonnal hibát jelzett, amint KAÜ-címet látott, akkor is, ha az csak
// átmenő átirányítás volt („Átirányítás…”), vagy ha a belépés még el sem kezdődött.
function primeRig({ urls, needsInput = false, sniffAt = null }) {
  // urls: a lap címe tickenként (az utolsó ismétlődik); sniffAt: ettől a ticktől „megjön” a postafiók-lista.
  let n = 0; const state = { destroyed: false, hidden: false };
  const s = new L.LiveSession({ BrowserWindow: class {}, session: {}, tickMs: 1 });
  const wc = {
    debugger: { isAttached: () => true, on() {}, sendCommand: async () => ({}) },
    loadURL: async () => {},
    getURL: () => { const u = urls[Math.min(n, urls.length - 1)]; if (sniffAt !== null && n >= sniffAt) { s.sniff.addressId = 'A1'; s.sniff.mailboxes = [{ name: 'Fiók' }]; } n++; return u; },
    executeJavaScript: async () => needsInput,
  };
  const win = { webContents: wc, isDestroyed: () => state.destroyed, isVisible: () => !state.hidden, destroy() { state.destroyed = true; }, hide() { state.hidden = true; } };
  s.win = win; s.s.status = 'running';
  return { s, win, state };
}
const KAU = 'https://kau.gov.hu/proxy/saml/atiranyitas;jsessionid=TITOK?x=1', BOX = 'https://tarhely.gov.hu/levelezes/';

test('belépés után az átmenő KAÜ-átirányítás nem hiba: a feltöltés megvárja, és összekapcsol', async () => {
  const r = primeRig({ urls: [KAU, KAU, KAU, BOX], sniffAt: 3 });
  r.s.sawKau = true;
  await r.s._prime(r.win);
  assert.equal(r.s.status().status, 'connected');
  assert.equal(r.state.hidden, true);
});

test('belépés előtt indult feltöltés csendben kilép: a belépőoldal nem hiba', async () => {
  const r = primeRig({ urls: [KAU], needsInput: true });
  r.s.sawKau = false;
  await r.s._prime(r.win);
  assert.equal(r.s.status().status, 'running');
  assert.equal(r.state.destroyed, false);
});

test('belépés után újra azonosítást kérő KAÜ-oldal hiba, a hely titok nélkül szerepel az üzenetben', async () => {
  const r = primeRig({ urls: [KAU], needsInput: true });
  r.s.sawKau = true;
  await r.s._prime(r.win);
  const st = r.s.status();
  assert.equal(st.status, 'failed');
  assert.match(st.error, /újra azonosítást kér \(kau\.gov\.hu\/proxy\/saml\/atiranyitas\)/);
  assert.doesNotMatch(st.error, /TITOK|x=1/);
});

test('véget nem érő átirányítás belépés után hiba, de csak a türelmi idő után', async () => {
  const r = primeRig({ urls: [KAU], needsInput: false });
  r.s.sawKau = true;
  await r.s._prime(r.win);
  assert.equal(r.s.status().status, 'failed');
  assert.match(r.s.status().error, /az átirányítás nem ért véget/);
});

// 2026-11-13, élő megfigyelés: a tárhely lapja a belépés ELŐTT is betölt; az idő előtti feltöltés törölte az
// automata belépés adatait és újratöltötte a KAÜ módválasztóját, ezért a belépés megállt.
test('belépés előtt betöltő tárhely-lap nem indít feltöltést, és az automata belépés adatai megmaradnak', async () => {
  const loads = [];
  const s = new L.LiveSession({ BrowserWindow: class {}, session: {}, tickMs: 2 });
  const wc = { getURL: () => 'https://tarhely.gov.hu/levelezes/', loadURL: async u => { loads.push(u); }, executeJavaScript: async () => false };
  const win = { webContents: wc, isDestroyed: () => false, isVisible: () => false, destroy() {}, hide() {} };
  s.win = win; s.s = { ...s.s, status: 'pending', mode: 'totp', auto: true };
  s._creds = { username: 'u', password: 'p', totpSeed: 's' };
  let primed = 0; s._prime = async () => { primed++; };
  await s._onLoad(win); await s._onLoad(win);
  assert.equal(primed, 0);
  assert.ok(s._creds, 'a belépési adatoknak meg kell maradniuk');
  assert.deepEqual(loads, []);
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(loads, ['https://tarhely.gov.hu/levelezes/'], 'ha a lap nem visz tovább, pontosan egyszer lökjük meg');
});

test('automata belépésnél a kód elküldése előtt a tárhely-cím nem indít feltöltést, utána igen', async () => {
  const s = new L.LiveSession({ BrowserWindow: class {}, session: {}, tickMs: 2 });
  const wc = { getURL: () => 'https://tarhely.gov.hu/levelezes/', loadURL: async () => {}, executeJavaScript: async () => false };
  const win = { webContents: wc, isDestroyed: () => false, isVisible: () => false, destroy() {}, hide() {} };
  s.win = win; s.s = { ...s.s, status: 'confirm', mode: 'totp', auto: true };
  s.sawKau = true; s.autoRunning = true; s._creds = { username: 'u', password: 'p', totpSeed: 's' };
  let primed = 0; s._prime = async () => { primed++; };
  await s._onLoad(win);
  assert.equal(primed, 0); assert.ok(s._creds);
  s.totpSent = true;
  await s._onLoad(win);
  assert.equal(primed, 1); assert.equal(s._creds, null);
});

test('növekményes listázás: a Beérkezett a tárhely saját „mióta” szűrőjével, tartós tár nélkül, az Elküldöttből egy oldal', async () => {
  const body = s => ({ filter: JSON.parse(/filter: (\{.*?\}) \}\) \}\);/.exec(s)[1]) });
  assert.equal(body(L.listScript('a1', 'x', 0)).filter.incomingFromDate, null);
  assert.equal(body(L.listScript('a1', 'x', 0, 'BEERKEZETT', '2026-11-10T08:00:00.000Z')).filter.incomingFromDate, '2026-11-10T08:00:00.000Z');
  assert.equal(body(L.listScript('a1', 'x', 0, 'BEERKEZETT', '2026-11-10')).filter.incomingFromDate, null, 'sima dátumot a tárhely 400-zal utasít el: nem küldjük');

  const calls = [];
  const s = new L.LiveSession({ BrowserWindow: null, session: null });
  s.s.status = 'connected'; s.sniff.mailboxes = [{ name: 'Fiók', addressId: 'a1' }]; s._switchMailbox = async () => {};
  s.win = { webContents: { executeJavaScript: async code => {
    if (code.includes('/mailbox/details')) return { status: 200, pct: 1 };
    const folder = /uzenetek\/(\w+)\/kereses/.exec(code)[1]; const from = /"incomingFromDate":("[^"]*"|null)/.exec(code)[1];
    calls.push({ folder, from });
    return { status: 200, body: { uzenetek: [{ erkeztetesiSzam: `E-${folder}-${calls.length}`, erkezesIdopontja: '2026-11-12T10:00:00' }], uzenetekSzama: 999 } };
  } } };
  const inc = await s.list(null, { incomingFrom: '2026-11-10T08:00:00.000Z', includeSent: true });
  assert.equal(inc.ok, true);
  assert.deepEqual([...new Set(calls.map(c => c.folder))], ['BEERKEZETT', 'ELKULDOTT'], 'növekményesen a tartós tár kimarad');
  assert.ok(calls.filter(c => c.folder === 'BEERKEZETT').every(c => c.from === '"2026-11-10T08:00:00.000Z"'));
  assert.equal(calls.filter(c => c.folder === 'ELKULDOTT').length, 1, 'az Elküldöttből csak az első oldal');
  calls.length = 0;
  await s.list(null, { includeSent: true });
  assert.deepEqual([...new Set(calls.map(c => c.folder))], ['BEERKEZETT', 'TARTOS_TAR', 'ELKULDOTT'], 'teljes listánál a tartós tár is');
  assert.ok(calls.every(c => c.from === 'null'));
});
