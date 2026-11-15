// E-Önkormányzat Portál (ASP) – ablakos, osztott képernyős és saját neves automata út (10. fázis; docs/adr/ADR-011).
//
// 1) Osztott képernyős út (`runSplit`): bal oldalon a KapuMail saját vezérlősávja az ügyféllistával és az élő pipákkal,
//    jobb oldalon az E-Önkormányzat Portál. Ha van elmentett kódos (Ügyfélkapu+) hitelesítő, a KAÜ-belépést a program
//    automatikusan elvégzi. A szerepkörváltást (Cloudflare Turnstile védi) a felhasználó végzi a jobb oldali portálon;
//    a váltás után a program automatikusan kiolvassa az önkormányzatokat (kizárólag GET), beküldi a szervernek, és
//    kipipálja az ügyfelet a bal oldali listában.
// 2) Saját neves háttér-olvasás (`runOwnAuto`): szerepkörváltás nélkül, rejtett Chromium-ablakban belép a KAÜ-láncon,
//    ellenőrzi a saját magánszemélyes szerepkört, kiolvassa a saját önkormányzati adatokat, majd lezárja a munkamenetet.
// 3) Klasszikus párbeszédablakos út (`run`): visszafelé kompatibilis tartalék, ha nincs WebContentsView.
//
// A munkamenet mindig memóriában él (nem `persist:`): bezáráskor minden süti és tároló törlődik. Letöltést az ablak nem enged.
'use strict';

const path = require('node:path');
const A = require('./asp-http');
const { selectScript, fillCredentialsScript, fillTotpScript } = require('./tarhely-live');
const { totpCode, secondsLeftInWindow } = require('./totp');

const PARTITION = 'asp-live'; // nem `persist:` – semmi nem marad a lemezen
const PARTITION_AUTO = 'asp-auto';
const PANEL_WIDTH = 380;
const IDENTITY = ['kau.gov.hu', 'idp.gov.hu', 'dap.gov.hu']; // a KAÜ és az azonosítási módok (Ügyfélkapu+, DÁP)
const KAU_HOSTS = ['kau.gov.hu', 'idp.gov.hu'];
const realSleep = ms => new Promise(r => setTimeout(r, ms));
const under = (host, base) => host === base || host.endsWith('.' + base);

/** Az ablak csak a portálra és az azonosító szolgáltatókra navigálhat. Engedett gépnél a http-s címet a munkamenet https-re emeli. */
function allowedNav(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) && (u.hostname === A.HOST || IDENTITY.some(b => under(u.hostname, b))); } catch { return false; }
}
const onPortal = url => { try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === A.HOST; } catch { return false; } };
const onKauIdp = url => { try { const u = new URL(url); return u.protocol === 'https:' && KAU_HOSTS.some(b => under(u.hostname, b)); } catch { return false; } };
const onKauSelector = url => { try { const u = new URL(url); return u.protocol === 'https:' && under(u.hostname, 'kau.gov.hu'); } catch { return false; } };

/** A beolvasott adat a felület felé: a PDF base64 szövegként megy tovább. */
function serialize(data) {
  return { ...data, tenants: (data.tenants || []).map(t => ({ ...t, balance: t.balance ? { year: t.balance.year, kind: t.balance.kind, status: t.balance.status, pdfBase64: t.balance.pdf.toString('base64'), bytes: t.balance.pdf.length } : null })) };
}

/** A munkamenetből, a portál saját oldalán át indított GET kérés (Angular zone.js elkerülésével). */
function makePageFetch(wc, alive) {
  return async url => {
    const u = new URL(url); if (u.origin !== A.BASE) throw new Error('Nem engedélyezett cím.');
    if (!alive() || !onPortal(wc.getURL())) throw new Error('Az ablak már nem a portálon áll.');
    const r = await wc.executeJavaScript(`(async () => { const r = await fetch(${JSON.stringify(u.pathname)}, { method: 'GET', headers: { Accept: 'application/json, text/plain, */*' }, credentials: 'include', cache: 'no-store' }); return { status: r.status, url: r.url, redirected: r.redirected, type: r.headers.get('content-type') || '', text: await r.text() }; })()`, true);
    let end = null; try { end = r && r.url ? new URL(String(r.url)) : null; } catch { /* nincs értelmezhető végső cím */ }
    const mask = p => String(p).replace(/[A-Za-z0-9-]{12,}/g, '{azonosító}');
    if (end && end.origin !== A.BASE) { console.log(`ASP-ablak: a válasz idegen címről jött (${end.protocol}//${end.hostname}), eldobva`); throw new Error('A válasz nem a portálról jött.'); }
    if (!end || r.redirected || Number(r.status) !== 200) console.log(`ASP-ablak: ${mask(u.pathname)} → HTTP ${Number(r && r.status) || 0}, ${String((r && r.type) || '(nincs típus)').split(';')[0]}, ${String((r && r.text) || '').length} bájt${r && r.redirected ? `, átirányítva ide: ${end ? mask(end.pathname) : '(üres cím)'}` : ''}${end ? '' : ', végső cím nélkül'}`);
    return { status: Number(r && r.status) || 0, headers: { get: () => null }, text: async () => String((r && r.text) || '') };
  };
}

/**
 * Automatikus KAÜ + Ügyfélkapu+ (TOTP) belépés egy portálnézeten.
 * Csak https://*.kau.gov.hu és https://*.idp.gov.hu oldalon futtat kitöltő szkriptet; a titkot a beküldés után törli.
 */
async function autoKauLogin(wc, rawCreds, { isActive = () => true, onNote = () => {}, lastTotpStep = null, onTotpUsed = null, sleep = realSleep, nowSec = () => Date.now() / 1000 } = {}) {
  let creds = rawCreds && rawCreds.username && rawCreds.password && rawCreds.totpSeed
    ? { username: String(rawCreds.username), password: String(rawCreds.password), totpSeed: String(rawCreds.totpSeed) }
    : null;
  if (!creds) return { ok: false, skipped: true };
  let sawKau = false;
  const landedOnPortal = url => {
    if (!onPortal(url)) return false;
    const p = new URL(url).pathname;
    return p === '/successful-login' || (sawKau && p !== '/login');
  };
  try {
    // 1. lépés: várakozás a KAÜ oldalára, és ha a módválasztón állunk, az Ügyfélkapu+ (hitelesítő app) kiválasztása
    let selected = false;
    for (let i = 0; i < 45 && isActive(); i++) {
      const url = wc.getURL();
      if (landedOnPortal(url)) return { ok: true };
      if (onKauIdp(url)) {
        sawKau = true;
        const hasLoginFields = await wc.executeJavaScript(`Boolean(document.querySelector('#name') && document.querySelector('#password'))`, true).catch(() => false);
        if (hasLoginFields) { selected = true; break; }
        if (onKauSelector(url)) {
          const r = await wc.executeJavaScript(selectScript('totp'), true).catch(() => 'not-ready');
          if (r === 'ok') { selected = true; onNote('Ügyfélkapu+ kiválasztva, belépőmezők betöltése…'); break; }
        }
      }
      await sleep(400);
    }
    if (!isActive()) return { ok: false, cancelled: true };
    if (!selected) return { ok: false, error: 'A KAÜ belépési módválasztója nem jelent meg időben.' };

    // 2. lépés: felhasználónév és jelszó kitöltése
    let filled = false;
    for (let i = 0; i < 50 && isActive(); i++) {
      const url = wc.getURL();
      if (landedOnPortal(url)) return { ok: true };
      if (onKauIdp(url)) {
        const hasFields = await wc.executeJavaScript(`Boolean(document.querySelector('#name') && document.querySelector('#password'))`, true).catch(() => false);
        if (hasFields) {
          await sleep(450);
          if (!isActive() || !onKauIdp(wc.getURL())) break;
          onNote('Felhasználónév és jelszó beküldése…');
          const res = await wc.executeJavaScript(fillCredentialsScript(creds.username, creds.password), true).catch(() => 'err');
          if (res === 'submitted') { filled = true; break; }
        }
      }
      await sleep(450);
    }
    if (!isActive()) return { ok: false, cancelled: true };
    if (!filled) return { ok: false, error: 'A KAÜ belépőoldalon nem jelent meg a felhasználónév és jelszó űrlap.' };

    // 3. lépés: várakozás a 6 jegyű TOTP (#identifier) mezőre; hibás jelszó felismerése ciklus nélkül
    let hasTotp = false;
    for (let i = 0; i < 50 && isActive(); i++) {
      const url = wc.getURL();
      if (landedOnPortal(url)) return { ok: true };
      if (onKauIdp(url)) {
        const probe = await wc.executeJavaScript(`(() => {
          if (document.querySelector('#identifier')) return 'totp';
          const err = [...document.querySelectorAll('.alert-danger, .error, [role=alert], .invalid-feedback, .form-error')].map(n => (n.innerText || '').trim()).filter(Boolean).join(' ');
          if (document.querySelector('#password') && err) return 'bad-cred';
          return 'wait';
        })()`, true).catch(() => 'wait');
        if (probe === 'totp') { hasTotp = true; break; }
        if (probe === 'bad-cred' && i >= 2) {
          return { ok: false, badCreds: true, error: 'A KAÜ nem fogadta el a felhasználónevet vagy a jelszót. Ellenőrizd a belépési adatokat.' };
        }
      }
      await sleep(450);
    }
    if (!isActive()) return { ok: false, cancelled: true };
    if (!hasTotp) {
      const stillPw = onKauIdp(wc.getURL()) ? await wc.executeJavaScript(`Boolean(document.querySelector('#password'))`, true).catch(() => false) : false;
      return {
        ok: false,
        badCreds: !!stillPw,
        error: stillPw ? 'A KAÜ nem fogadta el a felhasználónevet vagy a jelszót.' : 'A jelszó elküldése után nem jelent meg a hitelesítő kód mezője.',
      };
    }

    // 4. lépés: 6 jegyű TOTP-kód számítása (ha ebben a 30 mp-es ablakban már volt kódhasználat vagy < 6 mp maradt, megvárjuk az újat)
    let tSec = nowSec();
    const curStep = Math.floor(tSec / 30);
    const rem = secondsLeftInWindow(tSec);
    if ((typeof lastTotpStep === 'number' && curStep <= lastTotpStep) || rem < 6) {
      onNote('Következő 30 mp-es hitelesítő kódablak megvárása…');
      await sleep((rem + 1) * 1000);
      if (!isActive()) return { ok: false, cancelled: true };
      tSec = nowSec();
    }
    const usedStep = Math.floor(tSec / 30);
    const code = totpCode(creds.totpSeed, tSec);
    creds = null; // a titok többé nem kell a memóriában
    if (!onKauIdp(wc.getURL())) return landedOnPortal(wc.getURL()) ? { ok: true } : { ok: false, error: 'A hitelesítő oldal elnavigált a kód beküldése előtt.' };
    onNote('6 jegyű hitelesítő kód beküldése…');
    await sleep(300);
    const step2 = await wc.executeJavaScript(fillTotpScript(code), true).catch(() => 'err');
    if (step2 !== 'submitted') return { ok: false, error: 'Nem sikerült elküldeni a hatjegyű hitelesítő kódot.' };
    if (typeof onTotpUsed === 'function') onTotpUsed(usedStep);

    // 5. lépés: várakozás a visszairányításra a portálra
    onNote('Belépés véglegesítése az önkormányzati portálon…');
    for (let i = 0; i < 60 && isActive(); i++) {
      const url = wc.getURL();
      if (landedOnPortal(url)) return { ok: true };
      if (i >= 8 && onKauIdp(url)) {
        const rejected = await wc.executeJavaScript(`(() => {
          const inp = document.querySelector('#identifier');
          if (!inp) return false;
          const err = [...document.querySelectorAll('.alert-danger, .error, [role=alert], .invalid-feedback')].map(n => (n.innerText || '').trim()).filter(Boolean).join(' ');
          return Boolean(err) || inp.value === '';
        })()`, true).catch(() => false);
        if (rejected) return { ok: false, error: 'A KAÜ nem fogadta el a hatjegyű hitelesítő kódot (ellenőrizd a kulcsot és a gép óráját).' };
      }
      await sleep(600);
    }
    if (!isActive()) return { ok: false, cancelled: true };
    return landedOnPortal(wc.getURL()) ? { ok: true } : { ok: false, error: 'A hitelesítés után nem érkezett meg az önkormányzati portál válasza.' };
  } finally {
    creds = null;
  }
}

/** A bal oldali vezérlősáv IPC-kezelőinek egyszeri bejegyzése (csak az aktív saját panelnek válaszol). */
let currentPanel = null;
function register(ipcMain) {
  const mine = e => (currentPanel && e.sender && e.sender.id === currentPanel.id ? currentPanel : null);
  ipcMain.handle('aspPanel:state', e => { const p = mine(e); return p ? p.getState() : null; });
  ipcMain.handle('aspPanel:select', (e, key, val, which) => { const p = mine(e); return p ? p.select(String(key || ''), String(val || ''), String(which || '')) : null; });
  ipcMain.handle('aspPanel:readNow', e => { const p = mine(e); return p ? p.readNow() : null; });
  ipcMain.handle('aspPanel:openSwitch', e => { const p = mine(e); return p ? p.openSwitch() : null; });
  ipcMain.handle('aspPanel:manualLogin', e => { const p = mine(e); return p ? p.manualLogin() : null; });
  ipcMain.handle('aspPanel:close', e => { const p = mine(e); return p ? p.close() : null; });
}

/** Az ügyféllista tisztítása és normalizálása a bal oldali panelhez. */
function normalizeItems(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const own = r.own === true;
    if (own) {
      if (seen.has('own')) continue;
      seen.add('own');
      out.unshift({
        key: 'own', own: true, name: String(r.name || 'Saját adatom').slice(0, 120),
        tax: '', tax11: '', stem: '',
        state: r.doneToday ? 'done' : 'todo', fresh: false,
        summary: r.doneToday ? String(r.summary || 'Ma már lekérdezve').slice(0, 120) : '', error: '',
      });
      continue;
    }
    const rawTax = String(r.tax || '').trim().slice(0, 40);
    const digits = rawTax.replace(/\D+/g, '');
    let stem = '';
    let tax11 = '';
    if (/^\d{11}$/.test(digits)) { stem = digits.slice(0, 8); tax11 = digits; }
    else if (/^8\d{9}$/.test(digits)) { stem = digits; tax11 = digits; }
    else if (/^\d{8}$/.test(digits)) { stem = digits; }
    else {
      const m = /^(\d{8})/.exec(rawTax);
      if (m) stem = m[1];
    }
    if (!stem) continue;
    const key = `client:${stem}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key, own: false, name: String(r.name || rawTax || stem).slice(0, 140),
      tax: rawTax || stem, tax11, stem,
      state: r.doneToday ? 'done' : 'todo', fresh: false,
      summary: r.doneToday ? String(r.summary || 'Ma már lekérdezve').slice(0, 120) : '', error: '',
    });
  }
  if (!seen.has('own')) {
    out.unshift({ key: 'own', own: true, name: 'Saját adatom', tax: '', tax11: '', stem: '', state: 'todo', fresh: false, summary: '', error: '' });
  }
  return out;
}

/**
 * Saját neves automata háttér-olvasás rejtett ablakban (szerepkörváltás és látható ablak nélkül).
 */
function runOwnAuto({ BrowserWindow, session, creds, read = A.readOwn, readOpts = {}, timeoutMs = 90000, lastTotpStep = null, onTotpUsed = null, sleep = realSleep }) {
  if (!creds || !creds.username || !creds.password || !creds.totpSeed) {
    return Promise.resolve({ ok: false, ineligible: true, error: 'Nincs elmentett kódos (Ügyfélkapu+) hitelesítő.' });
  }
  const ses = session.fromPartition(PARTITION_AUTO, { cache: false });
  if (typeof ses.setPermissionRequestHandler === 'function') ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (d, cb) => {
    try { const u = new URL(d.url); if (allowedNav(d.url)) { u.protocol = 'https:'; u.port = ''; return cb({ redirectURL: u.href }); } } catch { /* tiltva */ }
    cb({ cancel: true });
  });
  ses.on('will-download', e => e.preventDefault());
  const win = new BrowserWindow({
    width: 980, height: 720, show: false, title: 'KapuMail – Önkormányzati portál (háttér)',
    webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  const guard = (e, url) => { if (!allowedNav(url)) e.preventDefault(); };
  wc.on('will-navigate', guard); wc.on('will-redirect', guard);
  wc.setWindowOpenHandler(({ url }) => { if (allowedNav(url)) wc.loadURL(url).catch(() => {}); return { action: 'deny' }; });

  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => finish({ ok: false, error: 'Időtúllépés: az önkormányzati portál nem válaszolt időben.' }), timeoutMs);
    const finish = r => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ses.webRequest.onBeforeRequest(null); } catch { /* nem kritikus */ }
      try { if (!win.isDestroyed()) win.destroy(); } catch { /* már bezárult */ }
      Promise.resolve(ses.clearStorageData()).catch(() => {}).then(() => resolve(r));
    };
    win.on('closed', () => finish({ ok: false, error: 'A háttérablak váratlanul bezárult.' }));
    const ctx = { browser: true, fetchImpl: makePageFetch(wc, () => !done && !win.isDestroyed()) };

    (async () => {
      try {
        wc.loadURL(`${A.BASE}/login`).catch(() => {});
        const login = await autoKauLogin(wc, creds, { isActive: () => !done && !win.isDestroyed(), lastTotpStep, onTotpUsed, sleep });
        if (!login.ok) return finish({ ok: false, badCreds: !!login.badCreds, error: login.error || 'A belépés nem sikerült.' });
        // Rövid várakozás, ha a portál SPA még tölti a munkamenetet
        let u = null;
        for (let i = 0; i < 10 && !done; i++) {
          try { u = await A.get(ctx, '/api/public/userdetails'); if (u && u.name) break; } catch { /* még tölt */ }
          await sleep(400);
        }
        if (!u || typeof u !== 'object' || !u.name) return finish({ ok: false, error: 'Az önkormányzati portál belépés után nem adott felhasználói adatot.' });
        const who = A.subjectOf(u);
        if (!who.own || who.role !== 'SAJAT_NEVEN_TERMESZETES_SZEMELY') {
          return finish({ ok: false, error: 'A portál nem a saját magánszemélyes szerepkörben nyílt meg; a háttérben nem olvastam be semmit.' });
        }
        const key = `${who.role}|${who.id}`;
        const data = await read(ctx, readOpts);
        const same = x => x && `${x.role}|${x.id}` === key;
        let after = null; try { after = A.subjectOf(await A.get(ctx, '/api/public/userdetails')); } catch { /* nem ellenőrizhető */ }
        if (!same(data.subject) || !same(after)) {
          return finish({ ok: false, error: 'A szerepkör olvasás közben megváltozott; semmit nem mentettem.' });
        }
        finish({ ok: true, ...serialize(data) });
      } catch (err) {
        finish({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
      }
    })();
  });
}

/**
 * Osztott képernyős (split-screen) munkaablak: bal oldalon az ügyfelek pipálható listája, jobb oldalon az E-Önkormányzat Portál.
 */
function runSplit({ BrowserWindow, WebContentsView, session, clipboard = null, parent = null, creds = null, items = [], onIngest = null, onWindow = null, read = A.readOwn, readOpts = {}, lastTotpStep = null, onTotpUsed = null, sleep = realSleep }) {
  const ses = session.fromPartition(PARTITION, { cache: false });
  if (typeof ses.setPermissionRequestHandler === 'function') ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));

  let requested = null;
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', `${A.BASE}/api/role`] }, (d, cb) => {
    if (String(d.url).startsWith('http://')) {
      try { const u = new URL(d.url); if (allowedNav(d.url)) { u.protocol = 'https:'; u.port = ''; return cb({ redirectURL: u.href }); } } catch { /* tiltjuk */ }
      return cb({ cancel: true });
    }
    if (d.method === 'PUT') {
      requested = null;
      try {
        const body = JSON.parse(Buffer.concat((d.uploadData || []).filter(x => x.bytes).map(x => Buffer.from(x.bytes))).toString('utf8'));
        requested = A.subjectOf({ adoazonosito: body && body.adoazonosito, roleDetails: body });
      } catch { /* nem olvasható */ }
    }
    cb({});
  });
  ses.on('will-download', e => e.preventDefault());

  const title = 'KapuMail – Önkormányzati portál';
  const win = new BrowserWindow({
    width: 1400, height: 880, minWidth: 980, minHeight: 640, title, parent: parent || undefined, backgroundColor: '#f6f5fc',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  if (typeof onWindow === 'function') onWindow(win);

  const panelView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'asp-panel-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  const portalView = new WebContentsView({
    webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: false },
  });
  const panelWc = panelView.webContents;
  const portalWc = portalView.webContents;

  panelWc.on('will-navigate', e => e.preventDefault());
  panelWc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (e, url) => { if (!allowedNav(url)) e.preventDefault(); };
  portalWc.on('will-navigate', guard); portalWc.on('will-redirect', guard);
  portalWc.setWindowOpenHandler(({ url }) => { if (allowedNav(url)) portalWc.loadURL(url).catch(() => {}); return { action: 'deny' }; });

  const fit = () => {
    if (win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    const lw = Math.min(PANEL_WIDTH, Math.max(300, Math.floor(w * 0.36)));
    panelView.setBounds({ x: 0, y: 0, width: lw, height: h });
    portalView.setBounds({ x: lw, y: 0, width: Math.max(320, w - lw), height: h });
  };
  win.contentView.addChildView(panelView);
  win.contentView.addChildView(portalView);
  fit();
  win.on('resize', fit);

  const list = normalizeItems(items);
  const hasAutoCreds = !!(creds && creds.username && creds.password && creds.totpSeed);

  return new Promise(resolve => {
    let done = false, busy = false, loggedIn = false, afterChange = false, manualMode = !hasAutoCreds;
    let loginNote = '', warning = null, activeRole = null, activeKey = null, selectedKey = null, copiedKey = null, copiedWhat = null;
    let syncedCount = 0, badCreds = false;
    const readInSession = new Set();

    const getState = () => ({
      phase: !loggedIn ? 'login' : (busy ? 'reading' : 'ready'),
      autoLogin: !loggedIn && !manualMode,
      loginNote,
      activeRole,
      warning,
      selectedKey,
      copiedKey,
      copiedWhat,
      items: list.map(x => ({ ...x })),
    });
    const pushState = () => {
      if (done || panelWc.isDestroyed()) return;
      try { panelWc.send('aspPanel:state', getState()); } catch { /* még nem töltött be */ }
    };

    const copyForItem = (it, customVal = '', which = 'main') => {
      if (!it || it.own) return;
      const val = customVal || it.tax11 || it.stem || it.tax || '';
      if (val && clipboard && typeof clipboard.writeText === 'function') {
        try { clipboard.writeText(val); copiedKey = it.key; copiedWhat = which || 'main'; } catch { /* nem kritikus */ }
      }
    };

    const openRoleSwitch = async () => {
      if (done || portalWc.isDestroyed() || !loggedIn || busy) return;
      try {
        const u = new URL(portalWc.getURL());
        if (u.origin === A.BASE && u.pathname === '/szerepkorvalasztas') return;
      } catch { /* megyünk tovább */ }
      const clicked = onPortal(portalWc.getURL())
        ? await portalWc.executeJavaScript(`(() => {
            const el = [...document.querySelectorAll('a[href*="szerepkor"], [routerlink*="szerepkor"], button')].find(n => /szerepk[oö]rv[aá]lt[aá]s/i.test((n.innerText || n.getAttribute('href') || n.getAttribute('routerlink') || '')));
            if (el) { el.click(); return true; }
            return false;
          })()`, true).catch(() => false)
        : false;
      if (!clicked && !portalWc.isDestroyed()) {
        portalWc.loadURL(`${A.BASE}/szerepkorvalasztas`).catch(() => {});
      }
    };

    const advanceToNextClient = async () => {
      const next = list.find(x => !x.own && x.state === 'todo');
      if (!next) { selectedKey = null; pushState(); return; }
      selectedKey = next.key;
      copyForItem(next, '', 'main');
      pushState();
      await openRoleSwitch();
    };

    const finish = () => {
      if (done) return;
      done = true;
      if (currentPanel && currentPanel.id === panelWc.id) currentPanel = null;
      if (typeof onWindow === 'function') onWindow(null);
      win.removeListener('resize', fit);
      try { ses.webRequest.onBeforeRequest(null); ses.webRequest.onCompleted(null); } catch { /* nem kritikus */ }
      try { if (!win.isDestroyed()) { win.contentView.removeChildView(panelView); win.contentView.removeChildView(portalView); } } catch { /* már bezárult */ }
      try { if (!panelWc.isDestroyed()) panelWc.close(); } catch { /* már bezárult */ }
      try { if (!portalWc.isDestroyed()) portalWc.close(); } catch { /* már bezárult */ }
      try { if (!win.isDestroyed()) win.destroy(); } catch { /* már bezárult */ }
      Promise.resolve(ses.clearStorageData()).catch(() => {}).then(() => resolve({ ok: true, split: true, syncedCount, badCreds }));
    };

    win.on('closed', finish);
    const ctx = { browser: true, fetchImpl: makePageFetch(portalWc, () => !done && !portalWc.isDestroyed()) };

    const matchItem = who => {
      if (!who) return null;
      if (who.own && who.role === 'SAJAT_NEVEN_TERMESZETES_SZEMELY') return list.find(x => x.own) || null;
      if (!who.own && who.id) return list.find(x => !x.own && x.stem === who.id) || null;
      return null;
    };

    const performRead = async (who, key, item) => {
      busy = true;
      warning = null;
      if (item) { item.state = 'reading'; item.error = ''; }
      if (!win.isDestroyed()) win.setTitle(`${title} – beolvasás folyamatban…`);
      pushState();
      let shouldAdvance = false;
      try {
        const data = await read(ctx, readOpts);
        const same = x => x && `${x.role}|${x.id}` === key;
        let after = null; try { after = A.subjectOf(await A.get(ctx, '/api/public/userdetails')); } catch { /* nem ellenőrizhető */ }
        if (!same(data.subject) || !same(after)) {
          const msg = 'A szerepkör beolvasás közben megváltozott, ezért semmit nem mentettem. Próbáld újra.';
          if (item) { item.state = 'error'; item.error = msg; }
          warning = msg;
          return;
        }
        const serialized = serialize(data);
        let ing = { ok: true, saved: (serialized.tenants || []).length, pdfs: (serialized.tenants || []).filter(t => t.balance).length };
        if (typeof onIngest === 'function') {
          ing = await onIngest(serialized);
        }
        if (!ing || !ing.ok) {
          const msg = String((ing && ing.error) || 'A szerver nem tudta elmenteni az adatokat.').slice(0, 220);
          if (item) { item.state = 'error'; item.error = msg; }
          warning = msg;
          return;
        }
        readInSession.add(key);
        syncedCount += 1;
        const summary = `${ing.saved ?? (serialized.tenants || []).length} önkormányzat · ${ing.pdfs ?? 0} kivonat`;
        if (item) {
          item.state = 'done';
          item.fresh = true;
          item.summary = summary;
          item.error = '';
        }
        shouldAdvance = true;
      } catch (err) {
        const msg = String((err && err.message) || err).slice(0, 220);
        if (item) { item.state = 'error'; item.error = msg; }
        warning = msg;
      } finally {
        busy = false;
        if (!done && !win.isDestroyed()) win.setTitle(title);
      }
      if (shouldAdvance) {
        await advanceToNextClient();
      } else {
        pushState();
      }
    };

    const check = async ({ force = false } = {}) => {
      if (done || busy || !loggedIn) return;
      let u = null;
      try { u = await A.get(ctx, '/api/public/userdetails'); } catch (err) {
        console.log(`ASP-ablak: a felhasználó lekérése nem sikerült (${String((err && err.message) || err).slice(0, 120)})`);
        return;
      }
      if (!u || typeof u !== 'object' || !u.name) return;
      const who = A.subjectOf(u);
      const key = `${who.role}|${who.id}`;
      const prevKey = activeKey;
      const viaChange = afterChange;
      afterChange = false;
      activeKey = key;
      const item = matchItem(who);
      activeRole = { role: who.role, label: who.label, id: who.id, own: !!who.own, clientName: item && !item.own ? item.name : null };

      if (!force && prevKey === key) {
        if (viaChange && requested && `${requested.role}|${requested.id}` === key) {
          requested = null;
          warning = `A szerepkör nem változott (továbbra is: ${who.label}${who.id && !who.own ? ` · ${who.id}` : ''}). Előbb válaszd ki a portál lenyílójában a kívánt szerepkört (pl. „Cég nevében”), illeszd be az adószámot (⌘V / Ctrl+V), majd nyomd meg a Szerepkörváltás gombot.`;
          pushState();
        } else {
          pushState();
        }
        return;
      }

      requested = null;
      warning = null;
      console.log(`ASP-ablak (split): szerepkör ${who.role}, azonosító ${who.id ? 'megvan' : 'NINCS'}${who.own ? '' : `; szerkezet: ${A.roleShape(u)}`}`);

      if (force) {
        if (!who.own && !item) {
          warning = `A portálon kiválasztott adózó (${who.id || who.label}) nem szerepel az aktív, érvényes meghatalmazású ügyfeleid között. Előbb vedd fel ügyfélként a KapuMailben.`;
          pushState();
          return;
        }
        await performRead(who, key, item);
        return;
      }

      if (who.own) {
        if (item && item.state !== 'done' && !readInSession.has(key)) {
          await performRead(who, key, item);
        } else {
          pushState();
          await advanceToNextClient();
        }
        return;
      }

      // Cég / képviselt szerepkörre váltott a felhasználó
      if (!item) {
        warning = `A portálon kiválasztott adózó (${who.id || who.label}) nem szerepel az aktív, érvényes meghatalmazású ügyfeleid között, ezért nem mentettem el.`;
        pushState();
        return;
      }
      if (!readInSession.has(key)) {
        await performRead(who, key, item);
      } else {
        pushState();
      }
    };

    currentPanel = {
      id: panelWc.id,
      getState,
      select: async (key, val, which) => {
        const it = list.find(x => x.key === key);
        if (!it) return null;
        selectedKey = it.key;
        warning = null;
        if (it.own) {
          pushState();
          if (loggedIn && !busy && activeRole && activeRole.own) await check({ force: true });
          return null;
        }
        copyForItem(it, val, which);
        pushState();
        if (loggedIn && !busy) await openRoleSwitch();
        return null;
      },
      readNow: () => check({ force: true }),
      openSwitch: () => openRoleSwitch(),
      manualLogin: () => {
        manualMode = true;
        loginNote = 'Kézi belépés: jelentkezz be a jobb oldali portálon (DÁP vagy Ügyfélkapu+).';
        pushState();
        return null;
      },
      close: () => { finish(); return null; },
    };

    const seen = (_e, url) => {
      if (!onPortal(url)) return;
      if (new URL(url).pathname === '/successful-login') {
        loggedIn = true;
        warning = null;
      }
      check();
    };
    portalWc.on('did-navigate', seen);
    portalWc.on('did-navigate-in-page', seen);
    ses.webRequest.onCompleted({ urls: [`${A.BASE}/api/role`] }, d => {
      if (d.method === 'PUT' && d.statusCode === 200) {
        afterChange = true;
        setTimeout(() => check(), 1100);
      }
    });

    panelWc.loadFile(path.join(__dirname, 'asp-panel.html')).catch(() => {});
    portalWc.loadURL(`${A.BASE}/login`).catch(() => {});

    if (hasAutoCreds) {
      autoKauLogin(portalWc, creds, {
        isActive: () => !done && !loggedIn && !manualMode && !portalWc.isDestroyed(),
        onNote: txt => { loginNote = txt; pushState(); },
        lastTotpStep,
        onTotpUsed,
        sleep,
      }).then(r => {
        if (done || manualMode) return;
        if (r && r.ok) {
          loggedIn = true;
          warning = null;
          check();
          return;
        }
        if (loggedIn) return;
        if (r && !r.ok && !r.cancelled) {
          manualMode = true;
          if (r.badCreds) badCreds = true;
          loginNote = 'Lépj be kézzel a jobb oldali ablakban (Ügyfélkapu+ vagy DÁP).';
          warning = r.error || 'Az automatikus belépés nem sikerült; beléphetsz kézzel a jobb oldalon.';
          pushState();
        }
      }).catch(() => {});
    }
  });
}

/**
 * Klasszikus párbeszédablakos út (tartalék, ha nincs WebContentsView).
 * @returns {Promise<{ ok: true, user: object, subject: object, permissions: object, tenants: object[], skipped: number } | { ok: false, cancelled?: boolean, error: string }>}
 */
function run({ BrowserWindow, session, dialog, parent = null, read = A.readOwn, readOpts = {} }) {
  const ses = session.fromPartition(PARTITION, { cache: false });
  let requested = null;
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', `${A.BASE}/api/role`] }, (d, cb) => {
    if (String(d.url).startsWith('http://')) {
      try { const u = new URL(d.url); if (allowedNav(d.url)) { u.protocol = 'https:'; u.port = ''; return cb({ redirectURL: u.href }); } } catch { /* tiltjuk */ }
      return cb({ cancel: true });
    }
    if (d.method === 'PUT') {
      requested = null;
      try { const body = JSON.parse(Buffer.concat((d.uploadData || []).filter(x => x.bytes).map(x => Buffer.from(x.bytes))).toString('utf8')); requested = A.subjectOf({ adoazonosito: body && body.adoazonosito, roleDetails: body }); } catch { /* nem olvasható: nem figyelmeztetünk */ }
    }
    cb({});
  });
  ses.on('will-download', e => e.preventDefault());
  const title = 'KapuMail – Önkormányzati portál';
  const win = new BrowserWindow({ width: 1180, height: 860, title, parent: parent || undefined,
    webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: false } });
  const wc = win.webContents;
  const guard = (e, url) => { if (!allowedNav(url)) e.preventDefault(); };
  wc.on('will-navigate', guard); wc.on('will-redirect', guard);
  wc.setWindowOpenHandler(({ url }) => { if (allowedNav(url)) wc.loadURL(url).catch(() => {}); return { action: 'deny' }; });

  return new Promise(resolve => {
    let done = false, busy = false, loggedIn = false, asked = null, reading = false, afterChange = false, lastPick = null;
    const finish = r => {
      if (done) return; done = true;
      try { ses.webRequest.onBeforeRequest(null); ses.webRequest.onCompleted(null); } catch { /* a kezelők eltávolítása nem kritikus */ }
      try { if (!win.isDestroyed()) win.destroy(); } catch { /* már bezárult */ }
      Promise.resolve(ses.clearStorageData()).catch(() => {}).then(() => resolve(r));
    };
    win.on('closed', () => finish({ ok: false, cancelled: true, error: reading ? 'Az ablak beolvasás közben bezárult; adat nem került mentésre.' : 'Az ablak beolvasás előtt bezárult.' }));
    const ctx = { browser: true, fetchImpl: makePageFetch(wc, () => !done && !win.isDestroyed()) };

    const check = async () => {
      if (done || busy || !loggedIn) return; busy = true;
      try {
        let u; try { u = await A.get(ctx, '/api/public/userdetails'); } catch (err) { console.log(`ASP-ablak: a felhasználó lekérése nem sikerült (${String((err && err.message) || err).slice(0, 120)})`); return; }
        if (!u || typeof u !== 'object' || !u.name) { console.log('ASP-ablak: a portál nem adott felhasználót (még nincs belépve?)'); return; }
        const who = A.subjectOf(u); const key = `${who.role}|${who.id}`;
        const unchanged = asked === key; const viaChange = afterChange; afterChange = false;
        if (unchanged) {
          if (!(viaChange && lastPick === 1 && requested && `${requested.role}|${requested.id}` === key)) return;
          requested = null;
          const again = await dialog.showMessageBox(win, { type: 'warning', title, buttons: ['Újra próbálom a váltást', 'Beolvasás ebben a szerepkörben', 'Mégse'], defaultId: 0, cancelId: 2,
            message: 'A szerepkör nem változott.',
            detail: `Továbbra is ebben a szerepkörben vagy: ${who.label}${who.id && !who.own ? ` (${who.id})` : ''}.\n\nA portál a „Szerepkörváltás” gombra akkor is sikert jelez, ha a „Szerepkör” lenyílóban ugyanaz a szerepkör maradt kiválasztva. Ha ügyfél nevében olvasnál, előbb válaszd ki a lenyílóban a kívánt szerepkört (például „Cég nevében”), töltsd ki a megjelenő mezőket, és csak utána nyomd meg a gombot.` });
          if (done) return;
          if (again.response === 2) return finish({ ok: false, cancelled: true, error: 'Megszakítva.' });
          if (again.response === 0) return;
        } else {
          asked = key;
          console.log(`ASP-ablak: szerepkör ${who.role}, azonosító ${who.id ? 'megvan' : 'NINCS'}${who.own ? '' : `; szerkezet: ${A.roleShape(u)}`}`);
          const pick = await dialog.showMessageBox(win, { type: 'question', title, buttons: ['Beolvasás ebben a szerepkörben', 'Előbb szerepkört váltok', 'Mégse'], defaultId: 0, cancelId: 2,
            message: 'Beléptél az önkormányzati portálra.',
            detail: `Szerepkör: ${who.label}${who.id && !who.own ? ` (${who.id})` : ''}.\n\nBeolvasáskor a program a saját önkormányzataidnál lekéri az idei adószámla-kivonatot, a benyújtott adóbevallások listáját és a folyamatban lévő ügyek számát. Csak olvas: nem küld be, nem fizet, nem módosít.\n\nHa egy ügyfél nevében szeretnél beolvasni, előbb válts szerepkört a portálon (Szerepkörváltás); a váltás után újra megkérdezlek.` });
          if (done) return;
          lastPick = pick.response;
          if (pick.response === 2) return finish({ ok: false, cancelled: true, error: 'Megszakítva.' });
          if (pick.response === 1) return;
        }
        reading = true; if (!win.isDestroyed()) win.setTitle(`${title} – beolvasás folyamatban, ne zárd be`);
        const data = await read(ctx, readOpts);
        const same = x => x && `${x.role}|${x.id}` === key;
        let after = null; try { after = A.subjectOf(await A.get(ctx, '/api/public/userdetails')); } catch { /* nem ellenőrizhető: nem mentünk */ }
        if (!same(data.subject) || !same(after)) {
          console.log(`ASP-ablak: a szerepkör nem egyezik a jóváhagyottal (kérdéskor ${who.role}, beolvasás elején ${data.subject && data.subject.role}, végén ${after && after.role}); nincs mentés`);
          return finish({ ok: false, error: 'A szerepkör a kérdés óta megváltozott, vagy nem volt ellenőrizhető, ezért semmit nem mentettem. Indítsd újra a beolvasást.' });
        }
        console.log(`ASP-ablak: beolvasva ${data.tenants ? data.tenants.length : 0} önkormányzat; ${(data.tenants || []).map(t => `[kivonat ${t.balance ? 'van' : 'nincs'}, bevallás ${t.returns ? t.returns.length : '–'}, ügy ${t.cases ?? '–'}${t.notes && t.notes.length ? ', megjegyzés: ' + t.notes.join(' | ') : ''}]`).join(' ')}`);
        finish({ ok: true, ...serialize(data) });
      } catch (err) { finish({ ok: false, error: String((err && err.message) || err).slice(0, 300) }); }
      finally { busy = false; }
    };

    const seen = (_e, url) => { if (!onPortal(url)) return; if (new URL(url).pathname === '/successful-login') loggedIn = true; check(); };
    wc.on('did-navigate', seen); wc.on('did-navigate-in-page', seen);
    ses.webRequest.onCompleted({ urls: [`${A.BASE}/api/role`] }, d => { if (d.method === 'PUT' && d.statusCode === 200) { afterChange = true; setTimeout(check, 1200); } });
    wc.loadURL(`${A.BASE}/login`).catch(() => {});
  });
}

module.exports = {
  run,
  runSplit,
  runOwnAuto,
  autoKauLogin,
  normalizeItems,
  register,
  allowedNav,
  serialize,
  PARTITION,
  PARTITION_AUTO,
  PANEL_WIDTH,
};
