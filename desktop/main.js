// Iratkapu asztali keret. Feladata:
//  1) elindítja a helyi szervert (fejlesztői módban vagy a telepítőbe épített PHP/SQLite-tal), ha még nem fut;
//  2) elszigetelt ablakban betölti a felületet (csak a saját origóról);
//  3) az OS titoktárával (Windows DPAPI / macOS Keychain) védett helyi titokkezelést,
//     beépített RFC 6238 TOTP hitelesítőt, valamint felügyelt Tárhely- és NAV-ügyfélportál-kapcsolatot ad.
// A felület (renderer) elmentett titkot SOHA nem kap vissza: csak eltárolni, törölni,
// a meglétét kérdezni és az aktuális 6 jegyű TOTP-kódot lekérni tudja.
const { app, BrowserWindow, WebContentsView, ipcMain, safeStorage, shell, session, Menu, dialog, systemPreferences, powerMonitor, Notification, Tray, nativeImage, nativeTheme, clipboard } = require('electron');
app.setName('KapuMail');
const connector = require('./connector');
const { LiveSession, MODES, PARTITION: LIVE_PARTITION } = require('./tarhely-live');
const tarhelyHttp = require('./tarhely-http');
const tarhelyAuto = require('./tarhely-auto');
const schedule = require('./schedule');
const { dueSlot } = schedule;
const DATE_LIST = v => String(v || '').split(/[\s,;]+/).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)).slice(0, 60);
const { authorizeDownload } = require('./download-gate');
const { makeLedger } = require('./listing-ledger');
const confirmView = require('./confirm-view');
const navHttp = require('./nav-http');
const { createRelay } = require('./relay');
const { createKapu } = require('./kapu');
const navExports = require('./nav-exports');
const aspLive = require('./asp-live');
const ledger = makeLedger(); // amit a főfolyamat ebben a futásban maga listázott a tárhelyről
const { cleanFilter, mailboxAllowed } = require('./mailbox-filter');
const { makeAutoControl } = require('./auto-control');
const { makeLiveListWindows } = require('./live-list-window');
const { totpCode, secondsLeftInWindow, parseTotpInput, decodeQrDataUrl } = require('./totp');
const lockLib = require('./lock');
const aliveLib = require('./alive');
const { makeMcpRun } = require('./mcp-sync');
const { resolveMode, userAgent } = require('./mode');
const { createLocalServer, pingHealth } = require('./local-server');
const { createUpdater } = require('./updater');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Átmenet a korábbi fejlesztői adatmappából (iratkapu-desktop -> KapuMail)
try {
  const oldDir = path.join(path.dirname(app.getPath('userData')), 'iratkapu-desktop');
  const newDir = app.getPath('userData');
  if (oldDir !== newDir && fs.existsSync(oldDir)) {
    if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
    for (const f of ['config.json', 'vault.json']) {
      const src = path.join(oldDir, f);
      const dst = path.join(newDir, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    }
  }
} catch {}

const DEFAULT_URL = 'http://127.0.0.1:8000';
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { return {}; } };
// Atomi mentés: ideiglenes fájlba írunk, majd átnevezzük, hogy egy megszakadt írás ne ürítse ki a beállításokat.
const saveCfg = patch => { const tmp = cfgFile() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ ...readCfg(), ...patch }), { mode: 0o600 }); fs.renameSync(tmp, cfgFile()); };
const autoCtl = makeAutoControl({ readCfg, saveCfg });
const liveWin = makeLiveListWindows({ readCfg, saveCfg });
let ORIGIN = process.env.IRATKAPU_URL || DEFAULT_URL;
function validUrl(u) { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname)) ? x.origin : null; } catch { return null; } }
const SMOKE = process.argv.includes('--smoke');
// MI-ből (MCP) indított app (ADR-016): ablak nélkül, a háttérben indul; az ablakot a felhasználó nyitja meg (Dock, tálca, újraindítás).
const MCP_BG = process.argv.includes('--mcp-hatter');
const PROBE = (process.argv.find(a => a.startsWith('--probe-kau=')) || '').split('=')[1] || null;
// Fejlesztői üzemmód: a NAV-portál (7. fázis) és az ASP-portál (10. fázis) megfigyelője. Csak csomagolatlan appban, kifejezett kapcsolóra indul.
const OBSERVE = process.argv.includes('--megfigyelo-nav') ? 'nav' : process.argv.includes('--megfigyelo-asp') ? 'asp' : null;
const ICON = path.join(__dirname, 'assets', 'icon.png');
// Üzemmód (mode.js): első indításkor nincs; a nyitóképernyő két kártyájáról választja ki a felhasználó.
const appMode = () => resolveMode(readCfg(), process.env) || (SMOKE ? 'local' : null);
// A felület kéréseit megjelöljük, hogy a szerver tudja: asztali alkalmazásból nézik (nincs mintafelhasználó-lista, a gép megjegyzi a belépést).
// Csak a felület munkamenetére vonatkozik; a hivatalos oldalak felé menő kérések jelölése nem változik.
function markRequests() { const s = session.defaultSession; s.setUserAgent(userAgent(s.getUserAgent(), app.getVersion(), appMode() || 'local')); }
let live = null;

const localSrv = createLocalServer({
  isPackaged: app.isPackaged,
  appDir: __dirname,
  resourcesPath: process.resourcesPath,
  userData: app.getPath('userData'),
  smoke: SMOKE,
});

const ping = () => pingHealth(ORIGIN, '/login', 1500);

async function ensureServer() {
  const res = await localSrv.ensure(ORIGIN);
  if (res.ok && res.origin) ORIGIN = res.origin;
  return res.ok;
}

// Napi parancsok helyi módban: nincs ütemező (cron), ezért a szerver indulása után egyszer, majd óránként megnézzük, futott-e már ma.
// A napot csak akkor mentjük, ha mindkét parancs sikerrel lefutott; hibánál a következő óra újrapróbálja. A parancsok naponta egyszer-biztosak.
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const runArtisan = cmd => localSrv.runArtisan(cmd);
let dailyBusy = false;
async function dailyTick() {
  if (dailyBusy || SMOKE || appMode() !== 'local') return;
  dailyBusy = true;
  try {
    const today = todayStr();
    if ((readCfg().daily || {}).lastRunOn === today) return;
    const a = await runArtisan('iratkapu:emlekeztetok'), b = await runArtisan('iratkapu:ertesitok');
    if (a && b) saveCfg({ daily: { ...(readCfg().daily || {}), lastRunOn: today } });
    else console.error('A napi parancsok nem futottak le rendben, a következő órában újra próbáljuk.');
  } catch (e) { console.error('Napi parancsok hiba:', e && e.message); }
  finally { dailyBusy = false; }
}
let dailyTimer = null;
// Minden sikeres szerverindítás után hívjuk: az ellenőrzés azonnal lefut (a dailyTick maga véd a kettős futás ellen), az óránkénti időzítő csak egyszer indul.
function startDaily() { dailyTick(); if (dailyTimer) return; dailyTimer = setInterval(dailyTick, 3600 * 1000); dailyTimer.unref && dailyTimer.unref(); }

// ---- titoktár: a titkosított bájtok a felhasználói adatmappában, a kulcs az OS-nél (Keychain / DPAPI) ----
const vaultFile = () => path.join(app.getPath('userData'), 'vault.json');
const readVault = () => { try { return JSON.parse(fs.readFileSync(vaultFile(), 'utf8')); } catch { return {}; } };
const writeVault = v => fs.writeFileSync(vaultFile(), JSON.stringify(v), { mode: 0o600 });
// A felület a saját hivatkozásait kezelheti; a helyi fiók titkához (kapu:local:…) nem fér hozzá, azt csak a főfolyamat használja.
const okRef = ref => typeof ref === 'string' && /^[a-z0-9:_\/.-]{1,120}$/i.test(ref) && !ref.toLowerCase().startsWith('kapu:local:') && !ref.toLowerCase().startsWith('kapu:mcp-token:');
// MCP-közvetítő (ADR-013): a ChatGPT / claude.ai a közvetítő nyilvános címén éri el a helyi KapuMailt. A kapcsolat
// kifelé épül (long-poll), befelé semmi nem nyílik. Alapból ki van kapcsolva; csak helyi módban él. Az azonosító és a titok
// a titoktárban van (kapu:local:…, a felület nem látja).
const RELAY_REF = 'kapu:local:relay';
const RELAY_URL = process.env.KAPUMAIL_RELAY_URL || 'https://mcp.kapumail.hu';
const mcpRelay = createRelay({
  relayUrl: RELAY_URL, origin: () => ORIGIN,
  load: () => { try { const v = readVault()[RELAY_REF]; return v && safeStorage.isEncryptionAvailable() ? JSON.parse(safeStorage.decryptString(Buffer.from(v, 'base64'))) : null; } catch { return null; } },
  save: c => { if (!safeStorage.isEncryptionAvailable()) throw new Error('A titoktár nem elérhető ezen a gépen.'); const v = readVault(); v[RELAY_REF] = safeStorage.encryptString(JSON.stringify(c)).toString('base64'); writeVault(v); },
});
const relayOn = () => readCfg().relay === true && appMode() === 'local';
const relayInfo = () => ({ enabled: relayOn(), available: appMode() === 'local', ...mcpRelay.status() });
function syncRelay() { if (relayOn() && !SMOKE) mcpRelay.start(); else mcpRelay.stop(); }
// Kapu-chat (ADR-014): a logika a kapu/index.js-ben; itt csak a titoktár, a beállítás és az események továbbítása.
// Az előzmények a felhasználó gépén, safeStorage-szel titkosítva; a Kapu-token a titoktárban (a felület nem olvashatja vissza).
const vaultGet = ref => { try { const v = readVault()[ref]; return v && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : null; } catch { return null; } };
const needVault = () => { if (!safeStorage.isEncryptionAvailable()) throw new Error('A titoktár nem elérhető ezen a gépen.'); };
// Fejlesztői próba (csak csomagolatlan appban): IRATKAPU_KAPU_HOME-mal az AI-parancssorok egy másik HOME-ot látnak
// (pl. üreset, hogy a belépés kipróbálható legyen a valódi fiókok kiléptetése nélkül). Maga az app a valódi HOME-on marad.
const kapuCliEnv = !app.isPackaged && process.env.IRATKAPU_KAPU_HOME ? { ...process.env, HOME: process.env.IRATKAPU_KAPU_HOME } : null;
const kapuProviders = kapuCliEnv ? (P => ({ ...P, status: (e, o = {}) => P.status(e, { env: kapuCliEnv, ...o }) }))(require('./kapu/providers')) : require('./kapu/providers');
// Szakmai MCP (jogi és könyvelői eszközök): a token a KapuMail-apptól, a felület munkamenetével kérve
// (az app a billingtől kéri: automatikus próba vagy előfizetés). A token csak a kör MCP-konfigjába kerül.
const kapuPremium = require('./kapu/premium').create({
  deviceId: require('./kapu/premium').deviceIdFor(app.getPath('userData')),
  fetchPremium: async deviceId => {
    const ses = mainWin && !mainWin.isDestroyed() ? mainWin.webContents.session : session.defaultSession;
    const r = await ses.fetch(`${ORIGIN}/api/kapu/premium?device=${encodeURIComponent(deviceId)}`, {
      credentials: 'include', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000),
    });
    if (r.status === 204) return { status: 204, reason: r.headers.get('x-kapu-premium-reason') || 'unavailable' };
    if (r.status !== 200) return { status: r.status };
    return { status: 200, json: await r.json() };
  },
});
const kapu = createKapu({
  premium: kapuPremium,
  userData: app.getPath('userData'), readCfg, saveCfg,
  providers: kapuProviders,
  hiddenSignIn: require('./kapu/signin').create(kapuCliEnv ? { env: kapuCliEnv } : {}),
  encrypt: s => { needVault(); return safeStorage.encryptString(s); },
  decrypt: b => safeStorage.decryptString(b),
  readSecret: vaultGet,
  writeSecret: (ref, s) => { needVault(); const v = readVault(); v[ref] = safeStorage.encryptString(s).toString('base64'); writeVault(v); },
  deleteSecret: ref => { const v = readVault(); if (ref in v) { delete v[ref]; writeVault(v); } },
  mcpBase: () => (appMode() === 'local' ? localSrv.mcpStdio() : { mode: 'http', url: ORIGIN + '/mcp' }),
  // Kinek az előzményei: a szerver mondja meg a felület munkamenetéből (a felület által küldött azonosítóban nem bízunk).
  resolveScope: async () => {
    const ses = mainWin && !mainWin.isDestroyed() ? mainWin.webContents.session : session.defaultSession;
    const r = await ses.fetch(ORIGIN + '/api/kapu/me', { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('Nincs bejelentkezve.');
    const j = await r.json();
    return { officeId: j.officeId, userId: j.userId };
  },
  emit: ev => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('kapu:event', ev); },
  emitVoice: ev => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('kapu:voice', ev); },
});
// Mikrofon (Kapu élő hang): csak hang, csak a KapuMail saját oldalának fő keretén, a főablakban.
function allowMic({ contents, permission, mainFrame, url, mediaTypes }) {
  let own = false;
  try { own = new URL(url).origin === new URL(ORIGIN).origin; } catch { own = false; }
  return permission === 'media' && own && mainFrame === true && !!mainWin && !mainWin.isDestroyed() && contents === mainWin.webContents
    && Array.isArray(mediaTypes) && mediaTypes.length === 1 && mediaTypes[0] === 'audio';
}
// Helyi mód: jelszó nélküli belépés. A fiók titkát a program generálja és az OS kulcstartója védi; a felhasználó nem látja,
// a felület nem kapja meg. A szerverrész ugyanezen a gépen fut, a titok a gépet nem hagyja el.
const LOCAL_REF = 'kapu:local:account';
let lastLocalEnter = 0;
async function localEnter(opts = {}) {
  if (SMOKE || appMode() !== 'local' || !safeStorage.isEncryptionAvailable()) return false;
  lastLocalEnter = Date.now();
  const v = readVault(); let secret;
  if (v[LOCAL_REF]) { try { secret = safeStorage.decryptString(Buffer.from(v[LOCAL_REF], 'base64')); } catch { return false; } } // sérült bejegyzést nem írunk felül
  else { secret = crypto.randomBytes(32).toString('base64url'); v[LOCAL_REF] = safeStorage.encryptString(secret).toString('base64'); writeVault(v); }
  try {
    const r = await session.defaultSession.fetch(ORIGIN + '/local/enter', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(opts.terms ? { secret, terms: true } : { secret }) });
    return r.ok;
  } catch { return false; }
}
const portalRef = key => {
  const clean = String(key || '').trim();
  if (!/^[a-z0-9:_-]{1,80}$/i.test(clean)) throw new Error('Érvénytelen portálazonosító.');
  return clean.startsWith('kapu:portal:') ? clean : `kapu:portal:${clean}`;
};
function maskUsername(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (s.length <= 3) return s[0] + '***';
  return s.slice(0, 2) + '•••' + s.slice(-2);
}
function readPortalCreds(key) {
  if (!safeStorage.isEncryptionAvailable()) return null;
  const ref = portalRef(key);
  const enc = readVault()[ref];
  if (!enc) return null;
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(enc, 'base64')));
  } catch {
    return null;
  }
}
function portalCredSummary(c) {
  if (!c) return { hasCreds: false, mode: null, usernameHint: null, hasPassword: false, hasTotp: false };
  return {
    hasCreds: Boolean(c.username && c.password),
    mode: c.mode || 'totp',
    usernameHint: maskUsername(c.username),
    hasPassword: Boolean(c.password),
    hasTotp: Boolean(c.totpSeed),
    updatedAt: c.updatedAt || null,
  };
}
function slimLiveLetters(result, max = 2000) {
  const cap = (s, n) => String(s ?? '').slice(0, n);
  return (Array.isArray(result.letters) ? result.letters : []).filter(l => l && l.eid).slice(0, max).map(l => {
    const folder = l.folder === 'TARTOS_TAR' ? 'TARTOS_TAR' : l.folder === 'ELKULDOTT' ? 'ELKULDOTT' : 'BEERKEZETT';
    const refEid = typeof l.refEid === 'string' && l.refEid ? cap(l.refEid, 64) : '';
    return {
      eid: cap(l.eid, 80),
      mailbox: cap(l.mailbox, 200),
      sender: cap(l.sender, 120),
      senderFull: cap(l.senderFull, 200),
      recipient: cap(l.recipient, 200),
      type: cap(l.type, 200),
      desc: cap(l.desc, 300),
      receivedAt: cap(l.receivedAt, 16),
      size: typeof l.size === 'number' && l.size >= 0 ? Math.floor(l.size) : null,
      portalOpened: typeof l.portalOpened === 'boolean' ? l.portalOpened : null,
      expiresAt: typeof l.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(l.expiresAt) ? l.expiresAt : null,
      durable: Boolean(l.durable),
      folder,
      ...(folder === 'ELKULDOTT' ? { recipientShort: cap(l.recipientShort, 64) } : {}),
      ...(refEid ? { refEid } : {}),
    };
  });
}

// ---- alkalmazászár (önként bekapcsolható): PIN, macOS-en Touch ID, tétlenség és alvás utáni zárolás ----
let mainWin = null, lockView = null, locked = false, liveWasVisible = false, aspWin = null, aspWasVisible = false;
const throttle = new lockLib.Throttle();
const mcpRun = makeMcpRun();
const lockCfg = () => lockLib.normalize(readCfg().lock);
const touchAvailable = () => process.platform === 'darwin' && systemPreferences.canPromptTouchID();
const askTouch = reason => systemPreferences.promptTouchID(reason).then(() => true, () => false);
const lockInfo = () => { const c = lockCfg(); return { enabled: c.enabled, touchId: c.touchId && touchAvailable(), touchAvailable: touchAvailable(), hasRecovery: !!c.recovery, idleMin: c.idleMin, idleChoices: lockLib.IDLE_CHOICES }; };
function fitLock() { if (!lockView || !mainWin || mainWin.isDestroyed()) return; const [width, height] = mainWin.getContentSize(); lockView.setBounds({ x: 0, y: 0, width, height }); }
function showLock() {
  if (lockView || !mainWin || mainWin.isDestroyed()) return;
  lockView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'lock-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } });
  lockView.webContents.on('will-navigate', e => e.preventDefault());
  lockView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWin.contentView.addChildView(lockView); fitLock();
  lockView.webContents.loadFile(path.join(__dirname, 'lock.html'));
  lockView.webContents.focus();
}
function dropLockView() { const v = lockView; lockView = null; if (!v) return; if (mainWin && !mainWin.isDestroyed()) mainWin.contentView.removeChildView(v); if (!v.webContents.isDestroyed()) v.webContents.close(); }
function lockNow() {
  // Kapu: zároláskor (és a gép zárképernyőjénél, alváskor akkor is, ha az app zára ki van kapcsolva) nem fut tovább
  // az élő hang (mikrofon) és a futó kör sem. Közvetlen hívás: a kapu:* IPC zárolt állapotban tiltott.
  kapu.lockStop();
  if (SMOKE || locked || !lockCfg().enabled) return;
  locked = true;
  liveWasVisible = Boolean(live && live.win && !live.win.isDestroyed() && live.win.isVisible());
  if (liveWasVisible) live.win.hide();
  aspWasVisible = Boolean(aspWin && !aspWin.isDestroyed() && aspWin.isVisible());
  if (aspWasVisible) aspWin.hide();
  showLock();
}
function unlock() {
  locked = false; throttle.reset(); dropLockView();
  if (liveWasVisible && live && live.win && !live.win.isDestroyed() && live.status().status !== 'connected') live.win.show();
  liveWasVisible = false;
  if (aspWasVisible && aspWin && !aspWin.isDestroyed()) aspWin.show();
  aspWasVisible = false;
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.focus();
}
function registerLockIpc(guard) {
  const fromLock = e => { if (!lockView || e.sender !== lockView.webContents) throw new Error('Csak a zárképernyőről'); };
  ipcMain.handle('lockscreen:state', e => { fromLock(e); return { touch: lockInfo().touchId, recovery: lockInfo().hasRecovery, waitMs: throttle.waitMs() }; });
  ipcMain.handle('lockscreen:touch', async e => {
    fromLock(e); if (!lockInfo().touchId) return { ok: false };
    const ok = await askTouch('feloldani a KapuMailt'); if (ok && locked) setImmediate(unlock); return { ok };
  });
  ipcMain.handle('lockscreen:pin', (e, pin) => {
    fromLock(e); const w = throttle.waitMs(); if (w) return { ok: false, waitMs: w };
    if (lockLib.verifyPin(String(pin), lockCfg().pin)) { setImmediate(unlock); return { ok: true }; }
    return { ok: false, waitMs: throttle.fail() };
  });
  // Elfelejtett PIN: a beállításkor kapott helyreállító kóddal új PIN adható meg. Ugyanaz a próbálkozás-korlát védi, mint a PIN-t.
  ipcMain.handle('lockscreen:recover', (e, code, pin) => {
    fromLock(e); const c = lockCfg();
    if (!c.recovery) return { ok: false, none: true, error: 'Ehhez a zárhoz nincs helyreállító kód (régebben kapcsoltad be).' };
    const w = throttle.waitMs(); if (w) return { ok: false, waitMs: w };
    if (!lockLib.okPin(pin)) return { ok: false, error: 'Az új PIN legalább 4 karakter legyen.' };
    if (!lockLib.verifyRecovery(String(code), c.recovery)) return { ok: false, waitMs: throttle.fail(), error: 'Ez a helyreállító kód nem jó.' };
    saveCfg({ lock: { enabled: true, touchId: c.touchId, idleMin: c.idleMin, pin: lockLib.hashPin(pin), recovery: c.recovery } });
    setImmediate(unlock); return { ok: true };
  });
  ipcMain.handle('lock:get', e => { guard(e); return lockInfo(); });
  ipcMain.handle('lock:enable', (e, pin) => {
    guard(e); if (lockCfg().enabled) return { ok: false, error: 'A zár már be van kapcsolva.' };
    if (!lockLib.okPin(pin)) return { ok: false, error: 'A PIN legalább 4 karakter legyen.' };
    // A helyreállító kód itt, egyetlen alkalommal megy ki a felületnek (hogy a felhasználó felírhassa); a gépen csak a lenyomata marad.
    const recoveryCode = lockLib.newRecoveryCode();
    saveCfg({ lock: { enabled: true, touchId: false, idleMin: 5, pin: lockLib.hashPin(pin), recovery: lockLib.hashRecovery(recoveryCode) } }); return { ok: true, recoveryCode, ...lockInfo() };
  });
  ipcMain.handle('lock:disable', async (e, pin) => {
    guard(e); const c = lockCfg(); if (!c.enabled) return { ok: true, ...lockInfo() };
    let ok = false;
    if (typeof pin === 'string' && pin) { if (throttle.waitMs()) return { ok: false, needPin: true, error: 'Túl sok hibás próbálkozás. Várj egy kicsit.' }; ok = lockLib.verifyPin(pin, c.pin); if (ok) throttle.reset(); else throttle.fail(); }
    else if (c.touchId && touchAvailable()) ok = await askTouch('kikapcsolni az alkalmazászárat');
    if (!ok) return { ok: false, needPin: true, error: pin ? 'Hibás PIN.' : 'A kikapcsoláshoz add meg a PIN-t.' };
    saveCfg({ lock: { enabled: false } }); return { ok: true, ...lockInfo() };
  });
  ipcMain.handle('lock:set', async (e, patch) => {
    guard(e); const c = lockCfg(); if (!c.enabled) return { ok: false, error: 'Előbb kapcsold be a zárat.' };
    const next = { enabled: true, touchId: c.touchId, idleMin: c.idleMin, pin: c.pin, recovery: c.recovery };
    if (patch && lockLib.IDLE_CHOICES.includes(patch.idleMin)) next.idleMin = patch.idleMin;
    if (patch && typeof patch.touchId === 'boolean') {
      if (patch.touchId) {
        if (!touchAvailable()) return { ok: false, error: 'Ezen a gépen nincs beállított Touch ID.' };
        if (!(await askTouch('bekapcsolni a Touch ID-s feloldást'))) return { ok: false, error: 'A Touch ID azonosítás nem sikerült.' };
      }
      next.touchId = patch.touchId;
    }
    saveCfg({ lock: next }); return { ok: true, ...lockInfo() };
  });
  ipcMain.handle('lock:now', e => { guard(e); if (!lockCfg().enabled) return { ok: false }; setImmediate(lockNow); return { ok: true }; });
}
function watchIdle() {
  powerMonitor.on('lock-screen', lockNow); powerMonitor.on('suspend', lockNow);
  setInterval(() => { const c = lockCfg(); if (c.enabled && !locked && c.idleMin > 0 && powerMonitor.getSystemIdleTime() >= c.idleMin * 60) lockNow(); }, 10000).unref();
}

function registerIpc() {
  // Zárolt appnál csak egy MI-ből indított szinkron idejére, és csak a szinkron csatornáin enged át (mcp-sync.js).
  const guard = (e, channel) => { if (new URL(e.senderFrame.url).origin !== new URL(ORIGIN).origin) throw new Error('Idegen origó'); if (locked && !mcpRun.allows(channel)) throw new Error('Az alkalmazás zárolva van'); };
  // MI-ből indított szinkron (ADR-016): a felület jelzi a futás elejét és végét; zárolt állapotban is hívható (csak origóellenőrzés).
  const fromApp = e => { if (new URL(e.senderFrame.url).origin !== new URL(ORIGIN).origin) throw new Error('Idegen origó'); };
  // A zárat csak valódi, a szerveren függő vagy futó MCP-kérés nyithatja meg (a felület szavára önmagában nem).
  ipcMain.handle('mcpsync:begin', async (e, id) => {
    fromApp(e); const n = Number(id); if (!Number.isInteger(n) || n <= 0) return { ok: false };
    let status = null;
    try { const r = await session.defaultSession.fetch(ORIGIN + '/api/desktop/mcp-sync/' + n, { credentials: 'include', headers: { Accept: 'application/json' } }); if (r.ok) status = (await r.json()).status; } catch { /* nincs kapcsolat: nem nyitunk */ }
    if (status !== 'pending' && status !== 'running') return { ok: false };
    return { ok: mcpRun.begin(n) };
  });
  ipcMain.handle('mcpsync:end', (e, id) => { fromApp(e); mcpRun.end(Number(id)); return { ok: true }; });
  // Rendszerértesítés a felület kérésére. Zárolt állapotban tartalom nélkül jelenik meg, és kattintásra sem nyit meg semmit.
  const shown = new Set();
  ipcMain.handle('notify:show', (e, n) => {
    if (new URL(e.senderFrame.url).origin !== new URL(ORIGIN).origin) throw new Error('Idegen origó');
    if (!Notification.isSupported()) return { ok: false };
    const x = new Notification(locked ? { title: 'KapuMail', body: 'Új értesítésed érkezett.' } : { title: String(n.title), body: String(n.body) });
    shown.add(x); x.on('close', () => shown.delete(x));
    x.on('click', () => {
      shown.delete(x); if (!mainWin || mainWin.isDestroyed()) return;
      if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus();
      if (!locked) mainWin.webContents.send('notify:click', n.id);
    });
    x.show(); return { ok: true };
  });
  ipcMain.handle('background:get', e => { guard(e); return { enabled: bgOn() }; });
  ipcMain.handle('background:set', (e, on) => { guard(e); saveCfg({ background: on === true }); syncTray(); return { enabled: bgOn() }; });
  ipcMain.handle('relay:get', e => { guard(e); return relayInfo(); });
  ipcMain.handle('relay:set', (e, on) => { guard(e); saveCfg({ relay: on === true }); syncRelay(); return relayInfo(); });
  // Kapu-chat: minden válasz {ok:true, ...} vagy {ok:false, error}. A hatókört (iroda, felhasználó) a főfolyamat a szervertől kérdezi.
  const kTry = async fn => { try { return await fn(); } catch (err) { return { ok: false, error: (err && err.message) || 'Hiba történt.' }; } };
  ipcMain.handle('kapu:status', e => { guard(e); return kTry(async () => ({ ok: true, engines: await kapu.status() })); });
  ipcMain.handle('kapu:signIn', (e, engine) => { guard(e); return kTry(() => kapu.signIn(String(engine))); });
  ipcMain.handle('kapu:cancelSignIn', e => { guard(e); return kTry(() => kapu.cancelSignIn()); });
  ipcMain.handle('kapu:signInState', e => { guard(e); return kTry(async () => ({ ok: true, ...(await kapu.signInState()) })); });
  ipcMain.handle('kapu:signInCode', (e, code) => { guard(e); return kTry(() => kapu.signInCode(String(code || '').slice(0, 600))); });
  // A belépőoldal újranyitása: csak a futó belépés szolgáltatójának saját HTTPS-címe (a rejtett munkamenet képernyőjéről).
  ipcMain.handle('kapu:signInOpen', (e, url) => { guard(e); return kTry(async () => { if (!kapu.signInUrlOk(String(url || ''))) return { ok: false, error: 'Ez a cím nem nyitható meg.' }; await shell.openExternal(String(url)); return { ok: true }; }); });
  ipcMain.handle('kapu:config', e => { guard(e); return kTry(async () => ({ ok: true, ...kapu.config(), mode: appMode(), hasToken: await kapu.hasToken() })); });
  ipcMain.handle('kapu:setConfig', (e, patch) => { guard(e); return kTry(() => ({ ok: true, ...kapu.setConfig(patch || {}) })); });
  ipcMain.handle('kapu:tokenState', e => { guard(e); return kTry(async () => ({ ok: true, has: await kapu.hasToken(), device: os.hostname().slice(0, 60) })); });
  ipcMain.handle('kapu:storeToken', (e, res) => { guard(e); return kTry(async () => { await kapu.storeToken(res && res.token, { officeId: res && res.officeId, userId: res && res.userId }); return { ok: true }; }); });
  ipcMain.handle('kapu:list', e => { guard(e); return kTry(async () => ({ ok: true, items: await kapu.list() })); });
  ipcMain.handle('kapu:get', (e, id) => { guard(e); return kTry(async () => { const c = await kapu.get(String(id)); return c ? { ok: true, conv: c } : { ok: false, error: 'Nincs ilyen beszélgetés.' }; }); });
  ipcMain.handle('kapu:remove', (e, id) => { guard(e); return kTry(() => kapu.remove(String(id))); });
  ipcMain.handle('kapu:clear', e => { guard(e); return kTry(() => kapu.clear()); });
  ipcMain.handle('kapu:send', (e, req) => { guard(e); return kTry(async () => ({ ok: true, ...(await kapu.send({ convId: req && req.convId != null ? String(req.convId) : null, text: String((req && req.text) || ''), model: req && typeof req.model === 'string' && req.model ? req.model : null })) })); });
  // A modell-azonosítót a kapu/models.js engedélyezett listája ellenőrzi (ismeretlen: hiba), parancssorba más nem jut.
  ipcMain.handle('kapu:models', e => { guard(e); return kTry(async () => ({ ok: true, engines: await kapu.modelCatalog() })); });
  ipcMain.handle('kapu:setModel', (e, req) => { guard(e); return kTry(() => kapu.setModel(String((req && req.convId) || ''), String((req && req.model) || ''))); });
  ipcMain.handle('kapu:cancel', (e, id) => { guard(e); return kTry(() => kapu.cancel(String(id))); });
  // Élő hang. A mikrofonengedélyt macOS-en a rendszer kéri (askForMediaAccess); a böngészőrész a fenti allowMic szerint kap hangot.
  ipcMain.handle('kapu:micAccess', e => { guard(e); return kTry(async () => {
    if (process.platform !== 'darwin') return { ok: true };
    const st = systemPreferences.getMediaAccessStatus('microphone');
    if (st === 'granted') return { ok: true };
    if (st === 'not-determined' && await systemPreferences.askForMediaAccess('microphone')) return { ok: true };
    return { ok: false, error: 'A KapuMail nem kapott mikrofon-hozzáférést. Engedélyezd: Rendszerbeállítások → Adatvédelem és biztonság → Mikrofon.' };
  }); });
  ipcMain.handle('kapu:voiceStart', (e, req) => { guard(e); return kTry(async () => ({ ok: true, ...(await kapu.voiceStart({ engine: String((req && req.engine) || ''), sdp: String((req && req.sdp) || ''), convId: req && req.convId != null ? String(req.convId) : null })) })); });
  ipcMain.handle('kapu:voiceStop', e => { guard(e); return kTry(() => kapu.voiceStop()); });
  ipcMain.handle('kapu:voiceDeclined', e => { guard(e); return kTry(() => kapu.voiceDeclined()); });
  ipcMain.handle('kapu:voiceText', (e, text) => { guard(e); return kTry(() => kapu.voiceText(String(text || '').slice(0, 8000))); });
  // Az Antigravity-hang PCM-útja (a mikrofon 16 kHz s16le darabjai, ~60 ms-onként, válasz nélkül); a ChatGPT-hang WebRTC-n megy.
  ipcMain.on('kapu:voiceAudio', (e, b64) => {
    try { guard(e); } catch { return; }
    if (typeof b64 === 'string' && b64.length > 0 && b64.length <= 200000) { try { kapu.voiceAudio(b64); } catch { /* nincs hang */ } }
  });
  ipcMain.handle('setup:get', e => { if (!e.senderFrame.url.startsWith('file:')) throw new Error('Csak a beállítóoldalról'); return { url: ORIGIN }; });
  ipcMain.handle('setup:set', async (e, url) => {
    if (!e.senderFrame.url.startsWith('file:')) throw new Error('Csak a beállítóoldalról');
    const o = validUrl(String(url)); if (!o) return { ok: false, error: 'Csak https:// cím adható meg (http csak a saját gépre).' };
    const prev = ORIGIN; ORIGIN = o;
    if (!(await ping())) { ORIGIN = prev; return { ok: false, error: 'Ezen a címen nem érhető el KapuMail-szerver.' }; }
    saveCfg({ url: o });
    BrowserWindow.fromWebContents(e.sender).loadURL(ORIGIN + '/'); return { ok: true };
  });

  // Nyitóképernyő (welcome.html): üzemmód választása. A felhő alapú mód kártyája egyelőre nem választható.
  ipcMain.handle('setup:mode', async (e, mode, terms) => {
    if (!e.senderFrame.url.startsWith('file:')) throw new Error('Csak a nyitóképernyőről');
    if (mode !== 'local') return { ok: false, error: 'A felhő alapú csatlakozás hamarosan érkezik.' };
    if (terms !== true) return { ok: false, error: 'A folytatáshoz fogadd el az ÁSZF-et és az adatkezelési tájékoztatót.' };
    if (!process.env.IRATKAPU_URL) ORIGIN = localSrv.getOrigin() || DEFAULT_URL;
    if (!(await ensureServer())) {
      const detail = localSrv.getLastError();
      return { ok: false, error: 'A helyi szerver nem indult el.' + (detail ? ` (${detail.slice(0, 180)})` : '') };
    }
    saveCfg({ mode: 'local' }); markRequests(); startDaily(); await localEnter({ terms: true });
    BrowserWindow.fromWebContents(e.sender).loadURL(ORIGIN + '/'); return { ok: true };
  });

  // Nyitóképernyő: a szerződési feltételek szövege a helyi szerver /legal oldaláról; a nyitóképernyő beágyazva mutatja.
  ipcMain.handle('setup:legal', async (e, doc) => {
    if (!e.senderFrame.url.startsWith('file:')) throw new Error('Csak a nyitóképernyőről');
    if (!['aszf', 'adatkezeles', 'adatfeldolgozas'].includes(doc)) return { ok: false, error: 'Ismeretlen dokumentum.' };
    if (!process.env.IRATKAPU_URL && !appMode()) ORIGIN = localSrv.getOrigin() || DEFAULT_URL;
    if (!(await ensureServer())) return { ok: false, error: 'A szöveg most nem tölthető be: a helyi szerver nem indult el.' };
    startDaily();
    try {
      const r = await session.defaultSession.fetch(ORIGIN + '/legal/' + doc);
      if (!r.ok) return { ok: false, error: 'A szöveg nem tölthető be.' };
      const html = await r.text(), m = html.match(/<body>([\s\S]*)<\/body>/);
      return { ok: true, html: m ? m[1] : '' };
    } catch { return { ok: false, error: 'A szöveg nem tölthető be.' }; }
  });

  ipcMain.handle('desktop:info', e => {
    guard(e);
    const backend = typeof safeStorage.getSelectedStorageBackend === 'function'
      ? safeStorage.getSelectedStorageBackend()
      : (process.platform === 'darwin' ? 'keychain' : process.platform === 'win32' ? 'dpapi' : 'os-keyring');
    return { platform: process.platform, version: app.getVersion(), mode: appMode(), vault: safeStorage.isEncryptionAvailable(), vaultBackend: backend };
  });
  ipcMain.handle('vault:has', (e, ref) => { guard(e); return okRef(ref) && ref in readVault(); });
  ipcMain.handle('vault:set', (e, ref, secret) => {
    guard(e);
    if (!okRef(ref) || typeof secret !== 'string' || !secret || secret.length > 4096) throw new Error('Érvénytelen kérés');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Az OS titoktára nem érhető el');
    const v = readVault(); v[ref] = safeStorage.encryptString(secret).toString('base64'); writeVault(v); return true;
  });
  ipcMain.handle('vault:delete', (e, ref) => { guard(e); if (!okRef(ref)) return false; const v = readVault(); delete v[ref]; writeVault(v); return true; });

  // ---- Ügyfélkapu+ hitelesítő (TOTP + OS titoktár) ----
  ipcMain.handle('portal:credInfo', (e, key) => {
    guard(e);
    try { return { ok: true, ...portalCredSummary(readPortalCreds(key)) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('portal:saveCreds', (e, key, payload) => {
    guard(e);
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Az operációs rendszer titkosított tárolója nem érhető el.' };
    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      return { ok: false, error: 'Nem áll rendelkezésre titkosított kulcstartó (Secret Service / KWallet).' };
    }
    let ref;
    try { ref = portalRef(key); } catch (err) { return { ok: false, error: err.message }; }
    const prev = readPortalCreds(key) || {};
    const mode = payload && MODES[payload.mode] ? payload.mode : (prev.mode || 'totp');
    const username = String((payload && payload.username) || '').trim() || prev.username || '';
    const password = String((payload && payload.password) || '') || prev.password || '';
    let totpSeed = prev.totpSeed || '';
    if (payload && typeof payload.totpSeed === 'string' && payload.totpSeed.trim() !== '') {
      const parsed = parseTotpInput(payload.totpSeed);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      totpSeed = parsed.seed;
    }
    if (mode === 'totp' && (!username || !password || !totpSeed)) {
      return { ok: false, error: 'Az automata Ügyfélkapu+ belépéshez add meg a felhasználónevet, a jelszót és a hitelesítő kulcsot.' };
    }
    const record = { mode, username: username.slice(0, 160), password: password.slice(0, 256), totpSeed, updatedAt: new Date().toISOString() };
    const v = readVault();
    v[ref] = safeStorage.encryptString(JSON.stringify(record)).toString('base64');
    writeVault(v);
    // A belépési adatok újramentése feloldja a felügyelet nélküli futás tiltását (pl. jelszóhiba után).
    autoCtl.unblockOnSave(String(key));
    return { ok: true, ...portalCredSummary(record) };
  });
  // Egy már elmentett belépő adatainak átvétele egy új kapcsolathoz (például új fiók ugyanazon a gépen). A másolás a főfolyamatban
  // történik: a felület a titkot ekkor sem látja, csak azt mondja meg, melyik bejegyzésből melyikbe. A forrás megmarad.
  ipcMain.handle('portal:copyCreds', (e, fromKey, toKey) => {
    guard(e);
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Az operációs rendszer titkosított tárolója nem érhető el.' };
    let to; try { to = portalRef(toKey); portalRef(fromKey); } catch (err) { return { ok: false, error: err.message }; }
    const src = readPortalCreds(fromKey);
    if (!src || !src.username || !src.password) return { ok: false, error: 'Az elmentett belépő nem található ezen a gépen.' };
    const v = readVault();
    v[to] = safeStorage.encryptString(JSON.stringify({ ...src, updatedAt: new Date().toISOString() })).toString('base64');
    writeVault(v); autoCtl.unblockOnSave(String(toKey));
    return { ok: true, ...portalCredSummary(src) };
  });
  ipcMain.handle('portal:deleteCreds', (e, key) => {
    guard(e);
    try { const v = readVault(); delete v[portalRef(key)]; writeVault(v); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('portal:totpPreview', (e, raw) => {
    guard(e);
    const r = parseTotpInput(String(raw || ''));
    return r.ok ? { ok: true, seed: r.seed, code: r.code, secondsLeft: r.secondsLeft, period: r.period, account: r.account, issuer: r.issuer } : r;
  });
  ipcMain.handle('portal:decodeQr', async (e, dataUrl) => {
    guard(e);
    return decodeQrDataUrl(BrowserWindow, dataUrl);
  });
  ipcMain.handle('portal:totpCode', (e, key) => {
    guard(e);
    const c = readPortalCreds(key);
    if (!c || !c.totpSeed) return { ok: false, error: 'Ehhez az Ügyfélkapuhoz nincs elmentett hitelesítő kulcs.' };
    const nowSec = Date.now() / 1000;
    return { ok: true, code: totpCode(c.totpSeed, nowSec), secondsLeft: secondsLeftInWindow(nowSec), period: 30 };
  });

  // ---- élő tárhely-csatlakozó (tarhely-cli tartalék út) ----
  const cliPath = () => readCfg().tarhelyCli || '';
  let consentUntil = 0;
  ipcMain.handle('connector:status', e => { guard(e); const p = cliPath(); const v = p ? connector.validateCli(p) : { ok: false }; return { configured: v.ok, version: v.version || null, path: p ? path.basename(path.dirname(path.dirname(p))) + '/dist/cli.js' : null }; });
  ipcMain.handle('connector:choose', async e => {
    guard(e);
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'A tarhely-cli dist/cli.js fájlja', properties: ['openFile'], filters: [{ name: 'cli.js', extensions: ['js'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'Nincs kiválasztva.' };
    const v = connector.validateCli(r.filePaths[0]); if (v.ok) saveCfg({ tarhelyCli: r.filePaths[0] });
    return v;
  });
  ipcMain.handle('connector:doctor', e => { guard(e); return connector.run(cliPath(), 'doctor', { timeoutMs: 30000 }); });
  const consent = async e => {
    if (Date.now() < consentUntil) return true;
    const r = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), { type: 'warning', buttons: ['Mégsem', 'Belépés és listázás'], defaultId: 0, cancelId: 0,
      title: 'Élő belépés a tárhelyre', message: 'Élő belépés indul a hivatalos tárhelyre',
      detail: 'A tarhely-cli a te gépeden, a rendszer kulcstartójában tárolt saját Ügyfélkapu+ azonosítóddal lép be, és lekéri a postafiókok és a levelek listáját.' });
    if (r.response !== 1) return false; consentUntil = Date.now() + 10 * 60 * 1000; return true;
  };
  ipcMain.handle('connector:mailboxes', async e => { guard(e); if (!(await consent(e))) return { ok: false, code: 1, error: 'Megszakítva.' }; const r = await connector.run(cliPath(), 'mailboxes'); return r.ok ? { ok: true, mailboxes: (r.mailboxes || []).map(m => ({ name: String(m.name).slice(0, 200) })) } : { ok: false, code: r.code, error: r.error, hint: r.hint }; });
  ipcMain.handle('connector:list', async (e, since) => { guard(e); if (!(await consent(e))) return { ok: false, code: 1, error: 'Megszakítva.' }; const r = await connector.run(cliPath(), 'list', since ? { since: String(since) } : {}); return r.ok ? { ok: true, letters: connector.slimLetters(r) } : { ok: false, code: r.code, error: r.error, hint: r.hint }; });

  // ---- élő összekapcsolás (Tárhely): automata OS-kulcstartós ÜK+ TOTP vagy interaktív DÁP / e-mail ----
  live = new LiveSession({ BrowserWindow, session });
  ipcMain.handle('live:status', e => { guard(e); return live.status(); });
  ipcMain.handle('live:start', async (e, mode, portalKey) => {
    guard(e); if (!(mode in MODES)) return { ok: false, error: 'Ismeretlen belépési mód.' };
    const w = BrowserWindow.fromWebContents(e.sender);
    return live.start(mode, w, { portalId: portalKey ? String(portalKey).slice(0, 80) : null });
  });
  ipcMain.handle('live:connectAuto', async (e, key) => {
    guard(e);
    const creds = readPortalCreds(key);
    if (!creds || !creds.username || !creds.password || !creds.totpSeed) {
      return { ok: false, code: 2, error: 'Ehhez az Ügyfélkapuhoz nincs elmentett felhasználónév, jelszó és TOTP-kulcs az OS titoktárában.' };
    }
    // Ugyanaz a tiltás, mint a felügyelet nélküli futónál: jelszóhiba után innen sem próbálkozunk újra (kizárás veszélye).
    const why = autoCtl.gate(String(key));
    if (why) return { ok: false, code: 2, error: `A belépő tiltva: ${why}` };
    const w = BrowserWindow.fromWebContents(e.sender);
    const res = await live.start('totp', w, { creds, portalId: String(key) });
    autoCtl.recordWindowResult(String(key), res);
    return res;
  });
  const sendProgress = (sender, channel, payload) => {
    try { if (sender && !sender.isDestroyed()) sender.send(channel, payload); } catch { /* ablak bezárult */ }
  };
  ipcMain.handle('live:windowVisible', (e, vis) => { guard(e); return live.setWindowVisible(Boolean(vis)); });
  ipcMain.handle('live:close', async e => { guard(e); await live.close(); return { ok: true }; });
  ipcMain.handle('live:mailboxes', e => { guard(e); return live.mailboxes(); });
  ipcMain.handle('live:list', async (e, since, filter, opts) => {
    guard(e);
    // Növekményes kézi szinkron: a felület a belépő azonosítóját adja, az ablakot a főfolyamat számolja ki és őrzi.
    const winKey = opts && /^\d{1,12}$/.test(String(opts.portalId || '')) ? `${ORIGIN}|${opts.portalId}` : null;
    let win = null;
    if (winKey) {
      const mbs = live.mailboxes();
      const names = mbs && mbs.ok ? mbs.mailboxes.map(m => m.name).filter(n => mailboxAllowed(n, cleanFilter(filter))) : [];
      win = liveWin.plan(winKey, { mailboxNames: names, sent: !!(opts && opts.sent), forceFull: !!(opts && opts.full) });
    }
    const r = await live.list(since ? String(since) : null, {
      incomingFrom: win && !win.full ? win.incomingFrom : null,
      mailboxFilter: cleanFilter(filter),
      includeSent: !!(opts && opts.sent),
      onProgress: p => sendProgress(e.sender, 'live:progress', {
        index: p.index, total: p.total,
        text: `Postafiók (${p.index} / ${p.total}): ${p.mailbox} – ${p.folder}${p.page > 1 ? ` (${p.page}. oldal)` : ''}…`,
      }),
    });
    if (!r.ok) return r;
    const letters = slimLiveLetters(r);
    ledger.record(letters);
    // A postafiókok adatai a tárhely listájából (típuskód, megjelenített név): a szerver ebből ismeri fel a fajtájukat.
    const mb = live.mailboxes();
    return { ok: true, letters, quotas: r.quotas || {}, mailboxes: mb && mb.ok ? mb.mailboxes.map(({ name, rawName, displayName, type, isDefault }) => ({ name, rawName, displayName, type, isDefault })) : [],
      ...(win ? { window: { full: win.full, since: win.incomingFrom } } : {}) };
  });
  // A szerver befogadta a kézi szinkron listáját: csak ezután lép előre a növekményes ablak.
  ipcMain.handle('live:ack', (e, portalId, full) => {
    guard(e);
    if (!/^\d{1,12}$/.test(String(portalId || ''))) return { ok: false };
    liveWin.ack(`${ORIGIN}|${portalId}`, { full: full === true });
    return { ok: true };
  });
  // Letöltés: a főfolyamat maga kér engedélyt a szervertől (a KapuMail-ablak munkamenetével), és azt az iratot tölti le,
  // amelyet a szerver megnevez. A felület csak az irat azonosítóját adja meg.
  ipcMain.handle('live:downloadOne', async (e, req) => {
    guard(e);
    const ses = e.sender.session;
    const xsrf = (await ses.cookies.get({ url: ORIGIN, name: 'XSRF-TOKEN' }).catch(() => []))[0];
    const win = BrowserWindow.fromWebContents(e.sender);
    const permit = await authorizeDownload({
      fetchImpl: (url, init) => ses.fetch(url, init), origin: ORIGIN, xsrf: xsrf ? xsrf.value : null, ledger,
      messageId: String((req && req.messageId) || ''), auto: !!(req && req.auto), viaRuleId: Number.isInteger(req && req.viaRuleId) ? req.viaRuleId : null,
      // Kézi letöltés megerősítése a főfolyamat saját rétegében: a felület oldala ezt nem tudja helyettünk megnyomni.
      confirm: info => confirmView.askDownload({ WebContentsView, win, info }),
    });
    if (!permit.ok) return { ok: false, code: 4, denied: true, cancelled: !!permit.cancelled, needList: !!permit.needList, error: permit.error };
    return live.downloadOne(permit.mailbox, permit.eid, permit.folder);
  });

  // ---- ADR-008 B: listázás a belépőablak munkamenetéből, HTTP-maggal (lapba írt szkript nélkül) ----
  // A régi `live:list` mellett él; a belépés változatlanul a hivatalos ablakban, emberrel történik.
  ipcMain.handle('live:listHttp', async (e, opts) => {
    guard(e);
    if (live.status().status !== 'connected') return { ok: false, error: 'Nincs élő kapcsolat a tárhellyel.' };
    try {
      const ses = session.fromPartition(LIVE_PARTITION);
      const cookies = await ses.cookies.get({});
      const ctx = await tarhelyHttp.contextFromSession(cookies, { fetchImpl: tarhelyHttp.sessionFetchAdapter(ses) });
      const letters = await tarhelyHttp.listAll(ctx, { sent: !!(opts && opts.sent) });
      ledger.record(letters);
      return { ok: true, letters, mailboxes: ctx.mailboxes.map(m => ({ name: m.name })) };
    } catch (err) { return { ok: false, error: String(err && err.message || err).slice(0, 300) }; }
  });

  // ---- ADR-008 C: felügyelet nélküli, többügyfeles listázás (böngészőablak nélkül) ----
  // Jogi kapu: ADR-006 tulajdonosi döntése (meghatalmazás, OS-kulcstár). Csak listázás, nem letöltés.
  const portalKeys = () => Object.keys(readVault()).filter(r => r.startsWith('kapu:portal:')).map(r => r.slice('kapu:portal:'.length));
  // A felügyelet nélküli futás állapota belépőnként (hibaszámláló, tiltás): lásd auto-control.js.
  const autoState = () => autoCtl.state();
  ipcMain.handle('auto:clients', e => {
    guard(e, 'auto:clients');
    const st = autoState();
    return { ok: true, clients: portalKeys().map(k => ({ key: k, ...portalCredSummary(readPortalCreds(k)), fails: (st[k] && st[k].fails) || 0, blocked: (st[k] && st[k].blocked) || null, lastError: (st[k] && st[k].lastError) || null, lastOkAt: (st[k] && st[k].lastOkAt) || null })) };
  });
  // ---- Ütemezett szinkron: az időpontot a főfolyamat számolja, a futást a felület indítja (a bejelentkezett felhasználó nevében).
  //      Zárolt appnál a híd (guard) minden hívást elutasít, így a futás a feloldásig vár.
  const schedCfg = () => { const s = readCfg().schedule; return s && typeof s === 'object' ? s : {}; };
  const hhmm = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  // A teljes beállítás a felületnek: a mentett (vagy alapértelmezett) időzítés, a nap kiszámolt időpontjai és a következő futás.
  const schedView = () => {
    const s = schedCfg(), on = s.enabled === true, next = on ? schedule.nextSlot(new Date(), s.lastRunAt || null, s) : null;
    return { enabled: on, lastRunAt: s.lastRunAt || null, extraWorkdays: s.extraWorkdays || [], extraRestdays: s.extraRestdays || [], ...schedule.normalize(s), slots: schedule.slotsOf(s).map(hhmm), next: next ? next.toISOString() : null, defaults: schedule.normalize({}) };
  };
  ipcMain.handle('schedule:get', e => { guard(e, 'schedule:get'); return schedView(); });
  // Időzítés mentése: mikor, mely napokon és mely belépőkre fusson. A 3 órás alsó határt itt is ellenőrizzük, nem csak a felületen.
  // A `changedAt` miatt a mentés előtti időpont nem esedékes: az átírás nem indít azonnali belépést.
  ipcMain.handle('schedule:save', (e, input) => {
    guard(e);
    const v = schedule.validate(input);
    if (!v.ok) throw new Error(v.error);
    saveCfg({ schedule: { ...schedCfg(), ...v.cfg, changedAt: Date.now() } });
    return schedView();
  });
  // Áthelyezett munkanapok és pihenőnapok (évente rendelet írja elő): a felhasználó adja meg, ÉÉÉÉ-HH-NN alakban.
  ipcMain.handle('schedule:setCalendar', (e, work, rest) => { guard(e); saveCfg({ schedule: { ...schedCfg(), extraWorkdays: DATE_LIST(work), extraRestdays: DATE_LIST(rest), changedAt: Date.now() } }); const s = schedCfg(); return { extraWorkdays: s.extraWorkdays, extraRestdays: s.extraRestdays }; });
  // A `changedAt` miatt bekapcsolás és a kivételnapok mentése után is csak a későbbi időpont esedékes: nincs azonnali belépés.
  ipcMain.handle('schedule:set', (e, on) => { guard(e); saveCfg({ schedule: { ...schedCfg(), enabled: on === true, changedAt: Date.now() } }); return { enabled: on === true }; });
  ipcMain.handle('schedule:due', e => {
    guard(e);
    const s = schedCfg();
    const slot = s.enabled === true ? dueSlot(new Date(), s.lastRunAt || null, s) : null;
    return { due: !!slot, slot: slot ? slot.toISOString() : null };
  });
  ipcMain.handle('schedule:ran', e => { guard(e); saveCfg({ schedule: { ...schedCfg(), lastRunAt: Date.now() } }); return { ok: true }; });
  // A felület visszaigazolja, hogy a szerver befogadta egy belépő listáját: a növekményes listázás innen számít.
  ipcMain.handle('auto:ack', (e, key, full) => { guard(e, 'auto:ack'); const st = autoState(); tarhelyAuto.acknowledge(st, String(key), { full: full === true }); saveCfg({ auto: st }); return { ok: true }; });
  // Letöltés a felügyelet nélküli futás után, a belépő megőrzött munkamenetével. Ember nincs jelen, ezért szigorúbb, mint a
  // kézi út: a szerver engedélye és a saját listánk egyezése mellett az is kell, hogy a szerver a letöltést automatikusnak minősítse.
  // A futásonkénti letöltési korlát (alapból 50) az IRATKAPU_MAX_DOWNLOADS környezeti változóval csak LEJJEBB vihető:
  // az első élő futásokhoz, amikor egy-két letöltéssel akarjuk megnézni, mi történik.
  const autoSessions = tarhelyAuto.makeSessions({ maxDownloads: tarhelyAuto.downloadCap(process.env.IRATKAPU_MAX_DOWNLOADS) });
  ipcMain.handle('auto:downloadOne', async (e, key, req) => {
    try {
      guard(e, 'auto:downloadOne');
      const ses = e.sender.session;
      const xsrf = (await ses.cookies.get({ url: ORIGIN, name: 'XSRF-TOKEN' }).catch(() => []))[0];
      if (!autoSessions.get(String(key))) return { ok: false, code: 3, needSession: true, error: 'Ehhez a belépőhöz nincs élő munkamenet; a letöltés a következő szinkronra marad.' };
      const permit = await authorizeDownload({
        fetchImpl: (url, init) => ses.fetch(url, init), origin: ORIGIN, xsrf: xsrf ? xsrf.value : null, ledger, requireAuto: true, auto: true, portalKey: String(key),
        messageId: String((req && req.messageId) || ''), viaRuleId: Number.isInteger(req && req.viaRuleId) ? req.viaRuleId : null,
      });
      if (!permit.ok) return { ok: false, code: 4, denied: true, error: permit.error };
      return await tarhelyAuto.downloadWithSession(autoSessions, String(key), permit);
    } catch (err) { return { ok: false, code: 4, error: String((err && err.message) || err).slice(0, 300) }; }
  });
  const lastTotpStep = new Map();
  const markTotpUsed = key => lastTotpStep.set(String(key), Math.floor(Date.now() / 30000));
  // NAV ügyfélportál, „A kör”: a belépő saját nevében, kizárólag GET-tel olvasható adatok (docs/adr/ADR-010).
  // Ugyanaz a belépő és ugyanaz a védelem, mint a tárhelynél: tiltott belépővel nem próbálkozik, a jelszóhiba tilt.
  ipcMain.handle('nav:readOwn', async (e, key, clientIds, queries) => {
    try {
      guard(e, 'nav:readOwn');
      key = String(key);
      // Ha ehhez a belépőhöz ezen a gépen nincs elmentett belépési adat (például a belépőt másik gépen vagy a varázslóban
      // vették fel, mentés nélkül), az nem hiba, hanem „nem alkalmas belépő”: a felület érthető „kihagyva” szöveget ad.
      if (!portalKeys().includes(key)) return { ok: false, ineligible: true, error: 'Ehhez a belépőhöz ezen a gépen nincs elmentett belépési adat.' };
      const state = autoState();
      if (state[key] && state[key].blocked) return { ok: false, blocked: true, error: `A belépő tiltva: ${state[key].blocked}` };
      const creds = readPortalCreds(key);
      if (!(await tarhelyAuto.eligibleClients([key], async () => creds)).length) return { ok: false, ineligible: true, error: 'Ehhez a belépőhöz nincs felügyelet nélküli belépésre alkalmas (TOTP-kulcsos) hitelesítő elmentve.' };
      let data;
      try {
        const want = (Array.isArray(clientIds) ? clientIds : []).map(String).filter(x => /^(\d{8}|8\d{9})$/.test(x)).slice(0, navHttp.MAX_CLIENTS);
        const navStep = (pct, text) => sendProgress(e.sender, 'nav:progress', { key, pct: Math.max(0, Math.min(92, Math.round(pct))), text: String(text || '').slice(0, 220) });
        // A tárhely szinkronja közvetlenül előtte ugyanezzel a kulccsal lépett be. Megvárjuk a következő kódablakot, hogy a
        // NAV-belépés ne ugyanazt a hatjegyű kódot használja újra (azt az azonosító szolgáltató elutasíthatja).
        const waitSec = secondsLeftInWindow() + 1;
        for (let rem = waitSec; rem > 0; rem--) {
          navStep(4 + ((waitSec - rem) / Math.max(1, waitSec)) * 8, `Új 6 jegyű hitelesítő kódra várunk (${rem} mp)…`);
          await new Promise(r => setTimeout(r, 1000));
        }
        markTotpUsed(key);
        navStep(14, 'Belépés a NAV ügyfélportálra (KAÜ)…');
        const ctx = await navHttp.loginNav({ username: creds.username, password: creds.password, seed: creds.totpSeed });
        const ownEnd = want.length ? 32 : (queries === true ? 46 : 88);
        data = await navHttp.readOwn(ctx, {
          onStep: s => navStep(16 + ((s.step || 1) / (s.total || 7)) * (ownEnd - 16), s.text),
        });
        // B kör (ADR-010): képviselet-váltás csak akkor, ha a szerver célokat adott (ott tulajdonosi kapcsoló engedi). Csak arra
        // az adózóra váltunk, akit a NAV maga is a belépő képviselt adózói között sorol fel; a végén a modul visszavált.
        if (want.length) {
          const targets = (data.profiles || []).filter(p => (p.stem && want.includes(p.stem)) || (!p.stem && p.taxId && want.includes(p.taxId)));
          const clStart = 34, clEnd = queries === true ? 74 : 88, subsPerClient = queries === true ? 5 : 2;
          data.clients = targets.length ? await navHttp.readClients(ctx, data.user.profileId, targets, {
            queries: queries === true,
            onStep: s => {
              const frac = Math.min(1, ((s.index || 0) + Math.min(1, (s.sub || 0) / subsPerClient)) / Math.max(1, s.count || targets.length));
              navStep(clStart + frac * (clEnd - clStart), s.text);
            },
          }) : { clients: [], restored: true, skipped: 0, error: null };
        }
        // C kör: a beadott bevallások, dokumentumok és adózói táblák lekérdezése a kiválasztott (a váltások után megint a saját) adózóra – csak kérésre.
        if (queries === true && data.subject && (!data.clients || data.clients.restored !== false)) {
          const qStart = want.length ? 75 : 48;
          const own = data.subject.stem || data.subject.taxId;
          if (own) {
            Object.assign(data, await navHttp.withReturns(ctx, own, {}, { onStep: s => navStep(qStart + 3, `Saját ${s.text}`) }));
            Object.assign(data, await navHttp.withDocuments(ctx, own, {}, { onStep: s => navStep(qStart + 7, `Saját ${s.text}`) }));
          }
          const pid = data.user && (data.user.subjectProfileId || data.user.profileId);
          let ttIdx = 0;
          if (pid) Object.assign(data, await navHttp.withTaxpayerTables(ctx, pid, {}, {
            kind: (data.user && data.user.subjectKind) || null,
            onStep: lbl => { ttIdx++; navStep(Math.min(90, qStart + 9 + ttIdx * 3), `Adózói táblák: ${lbl}…`); },
          }));
        }
        // Összegzés a naplóba, érték nélkül: ebből látszik, mi futott le és mi nem (darabszámok és hibaokok).
        const di = x => (x && x.documentsInfo ? (x.documentsInfo.error ? `hiba: ${x.documentsInfo.error}` : `${(x.documents || []).length} / ${x.documentsInfo.total} sor`) : 'nem futott');
        const ri = x => (x && x.returnsInfo ? (x.returnsInfo.error ? `hiba: ${x.returnsInfo.error}` : `${(x.returns || []).length} / ${x.returnsInfo.total} sor`) : 'nem futott');
        const ti = x => {
          if (!x || !x.taxpayerTables) return x && x.taxpayerTablesInfo && x.taxpayerTablesInfo.error ? `hiba: ${x.taxpayerTablesInfo.error}` : 'nem futott';
          const t = x.taxpayerTables;
          return `bizt:${Array.isArray(t.insured_persons) ? t.insured_persons.length : (t.insured_xlsx_base64 ? 'xlsx' : '–')},fogl:${Array.isArray(t.employers) ? t.employers.length : '–'},efo:${Array.isArray(t.efo_declarations) ? t.efo_declarations.length : '–'},egyezt:${Array.isArray(t.reconciliations) ? t.reconciliations.length : '–'}`;
        };
        console.log(`NAV-olvasás: ${(data.profiles || []).length} képviselt adózó; kért ügyfél: ${want.length}; váltás: ${data.clients ? `${data.clients.clients.filter(c => c.ok).length} sikeres, ${data.clients.clients.filter(c => !c.ok).length} sikertelen, visszaváltás ${data.clients.restored ? 'rendben' : 'NEM IGAZOLT'}${data.clients.error ? ', megszakadt: ' + data.clients.error : ''}` : 'nem volt'}; bevallás-lekérdezés (saját): ${queries === true ? ri(data) : 'kikapcsolva'}${data.clients ? '; ügyfeleknél: ' + (data.clients.clients.map(c => (c.ok ? ri(c) : 'kihagyva')).join(' | ') || '–') : ''}; dokumentumok (saját): ${queries === true ? di(data) : 'kikapcsolva'}${data.clients ? '; ügyfeleknél: ' + (data.clients.clients.map(c => (c.ok ? di(c) : 'kihagyva')).join(' | ') || '–') : ''}; adózói táblák (saját): ${queries === true ? ti(data) : 'kikapcsolva'}${data.clients ? '; ügyfeleknél: ' + (data.clients.clients.map(c => (c.ok ? ti(c) : 'kihagyva')).join(' | ') || '–') : ''}`);
      } catch (err) {
        const error = String((err && err.message) || err).slice(0, 300);
        // Csak a jelszóhibát számoljuk a közös tiltáshoz: a NAV-portál egyéb hibája ne tiltsa le a tárhely szinkronját.
        if (tarhelyAuto.classifyError(error) === 'password') { tarhelyAuto.recordFailure(state, key, error); saveCfg({ auto: state }); }
        return { ok: false, error };
      }
      return { ok: true, ...data };
    } catch (err) { return { ok: false, error: String((err && err.message) || err).slice(0, 300) }; }
  });
  // NAV ügyfélportál, letölthető kimutatások (C kör; ADR-010): kérésre, egy adózóra. Ha a cél nem a belépő maga, a program
  // átvált rá, ellenőrzi, majd a végén – hiba esetén is – visszavált a saját profilra. Ugyanaz a belépő és tiltás, mint a NAV-olvasásnál.
  ipcMain.handle('nav:exports', async (e, key, target, kinds) => {
    try {
      guard(e);
      key = String(key);
      if (!portalKeys().includes(key)) return { ok: false, ineligible: true, error: 'Ehhez a belépőhöz ezen a gépen nincs elmentett belépési adat.' };
      const state = autoState();
      if (state[key] && state[key].blocked) return { ok: false, blocked: true, error: `A belépő tiltva: ${state[key].blocked}` };
      const creds = readPortalCreds(key);
      if (!(await tarhelyAuto.eligibleClients([key], async () => creds)).length) return { ok: false, ineligible: true, error: 'Ehhez a belépőhöz nincs felügyelet nélküli belépésre alkalmas (TOTP-kulcsos) hitelesítő elmentve.' };
      const want = target == null ? null : String(target);
      if (want !== null && !/^(\d{8}|8\d{9})$/.test(want)) return { ok: false, error: 'Érvénytelen adózó-azonosító.' };
      const list = (Array.isArray(kinds) ? kinds : navExports.KINDS).map(String).filter(k => navExports.KINDS.includes(k));
      let ctx;
      try {
        await new Promise(r => setTimeout(r, (secondsLeftInWindow() + 1) * 1000));
        markTotpUsed(key);
        ctx = await navHttp.loginNav({ username: creds.username, password: creds.password, seed: creds.totpSeed });
      } catch (err) {
        const error = String((err && err.message) || err).slice(0, 300);
        if (tarhelyAuto.classifyError(error) === 'password') { tarhelyAuto.recordFailure(state, key, error); saveCfg({ auto: state }); }
        return { ok: false, error };
      }
      const u = await navHttp.get(ctx, navHttp.PATHS.user);
      const ownId = Number((u.sajatAdozoiProfil || {}).id);
      const own = navHttp.subjectOf(u);
      if (want === null || (own && (own.stem === want || own.taxId === want) && own.own)) {
        const r = await navExports.runExports(ctx, { profileId: ownId, adozoTipus: 'TERMESZETESSZEMELY', kinds: list });
        console.log(`NAV-kimutatások (saját): ${r.files.length} fájl${r.notes.length ? '; ' + r.notes.join(' | ') : ''}`);
        return { ok: true, subject: { stem: own && own.stem, taxId: own && own.taxId, own: true }, restored: true, ...r };
      }
      const t = await navHttp.findProfile(ctx, want);
      if (!t) return { ok: false, error: 'Ez az adózó nincs a belépő képviselt adózói között a NAV-nál.' };
      let out = null, restored = false, error = null;
      try {
        await navHttp.switchTo(ctx, t.id);
        const now = navHttp.subjectOf(await navHttp.get(ctx, navHttp.PATHS.user));
        if (!now || now.id !== t.id) throw new Error('A NAV a váltás után nem ezt az adózót mutatta kiválasztottnak; nem töltöttem le semmit.');
        out = await navExports.runExports(ctx, { profileId: t.id, adozoTipus: t.stem ? 'CEG' : 'TERMESZETESSZEMELY', kinds: list });
      } catch (err) { error = String((err && err.message) || err).slice(0, 300); }
      try { await navHttp.switchTo(ctx, ownId); const back = navHttp.subjectOf(await navHttp.get(ctx, navHttp.PATHS.user)); restored = !!back && back.id === ownId; } catch { restored = false; }
      console.log(`NAV-kimutatások (ügyfél): ${out ? out.files.length : 0} fájl; visszaváltás ${restored ? 'rendben' : 'NEM IGAZOLT'}${error ? '; hiba: ' + error : ''}${out && out.notes.length ? '; ' + out.notes.join(' | ') : ''}`);
      if (!out) return { ok: false, restored, error };
      return { ok: true, subject: { stem: t.stem, taxId: t.stem ? null : t.taxId, own: false }, restored, ...out };
    } catch (err) { return { ok: false, error: String((err && err.message) || err).slice(0, 300) }; }
  });
  // E-Önkormányzat Portál (ASP):
  // 1) Osztott képernyős ablak (`asp:readWindow`): bal oldalon az ügyféllista élő pipákkal, jobb oldalon az E-Önkormányzat Portál.
  //    Ha a kiválasztott belépőhöz van TOTP-hitelesítő (és nincs tiltva), a KAÜ-belépést a program elvégzi; szerepkört a
  //    felhasználó vált (Turnstile védi), minden váltott szerepkört a program automatikusan kiolvas (GET) és azonnal beküld.
  // 2) Saját neves háttér-olvasás (`asp:readOwnAuto`): szerepkörváltás nélkül, rejtett ablakban olvassa a saját helyi adókat.
  let aspBusy = false;
  ipcMain.handle('asp:readWindow', async (e, opts) => {
    try {
      guard(e);
      if (aspBusy) return { ok: false, error: 'Az önkormányzati portál ablaka már nyitva van.' };
      aspBusy = true;
      try {
        const sender = e.sender;
        const senderSes = sender.session;
        const pKey = opts && opts.portalKey ? String(opts.portalKey) : null;
        const state = autoState();
        let creds = null;
        if (pKey && portalKeys().includes(pKey) && !(state[pKey] && state[pKey].blocked)) {
          const raw = readPortalCreds(pKey);
          if ((await tarhelyAuto.eligibleClients([pKey], async () => raw)).length) creds = raw;
        }
        const onIngest = async data => {
          const xsrf = (await senderSes.cookies.get({ url: ORIGIN, name: 'XSRF-TOKEN' }).catch(() => []))[0];
          const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
          if (xsrf && xsrf.value) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf.value);
          const body = {
            subject: { own: !!(data.subject && data.subject.own), role: (data.subject && data.subject.role) || null, id: (data.subject && data.subject.id) || null },
            tenants: (data.tenants || []).map(t => ({
              uid: t.uid, name: t.name, city: t.city,
              balance: t.balance ? { year: t.balance.year, kind: t.balance.kind, status: t.balance.status, pdfBase64: t.balance.pdfBase64 } : null,
              returns: t.returns, cases: t.cases, notes: t.notes || [],
            })),
          };
          const res = await senderSes.fetch(`${ORIGIN}/api/asp/ingest`, { method: 'POST', headers, body: JSON.stringify(body) });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || !j.ok) return { ok: false, error: String(j.message || `HTTP ${res.status}`).slice(0, 220) };
          if (!sender.isDestroyed()) sender.send('asp:updated');
          return j;
        };
        const out = await aspLive.runSplit({
          BrowserWindow, WebContentsView, session, clipboard,
          parent: mainWin && !mainWin.isDestroyed() ? mainWin : null,
          creds,
          items: opts && Array.isArray(opts.items) ? opts.items : [],
          onIngest,
          onWindow: w => { aspWin = w; },
          lastTotpStep: pKey ? lastTotpStep.get(pKey) : null,
          onTotpUsed: pKey ? step => lastTotpStep.set(pKey, step) : null,
        });
        if (out && out.badCreds && pKey) {
          tarhelyAuto.recordFailure(state, pKey, 'A KAÜ nem fogadta el a felhasználónevet vagy a jelszót.');
          saveCfg({ auto: state });
        }
        return out;
      } finally { aspBusy = false; aspWin = null; }
    } catch (err) { return { ok: false, error: String((err && err.message) || err).slice(0, 300) }; }
  });
  ipcMain.handle('asp:readOwnAuto', async (e, key) => {
    try {
      guard(e, 'asp:readOwnAuto');
      if (aspBusy) return { ok: false, busy: true, error: 'Az önkormányzati portál ablaka már nyitva van.' };
      key = String(key || '');
      if (!portalKeys().includes(key)) return { ok: false, ineligible: true, error: 'Ehhez a belépőhöz ezen a gépen nincs elmentett belépési adat.' };
      const state = autoState();
      if (state[key] && state[key].blocked) return { ok: false, blocked: true, error: `A belépő tiltva: ${state[key].blocked}` };
      const creds = readPortalCreds(key);
      if (!(await tarhelyAuto.eligibleClients([key], async () => creds)).length) {
        return { ok: false, ineligible: true, error: 'Ehhez a belépőhöz nincs felügyelet nélküli belépésre alkalmas (TOTP-kulcsos) hitelesítő elmentve.' };
      }
      aspBusy = true;
      try {
        const out = await aspLive.runOwnAuto({
          BrowserWindow, session, creds,
          lastTotpStep: lastTotpStep.get(key) ?? null,
          onTotpUsed: step => lastTotpStep.set(key, step),
        });
        if (!out.ok && out.badCreds) {
          tarhelyAuto.recordFailure(state, key, out.error || 'A KAÜ nem fogadta el a felhasználónevet vagy a jelszót.');
          saveCfg({ auto: state });
        }
        return out;
      } finally { aspBusy = false; }
    } catch (err) { return { ok: false, error: String((err && err.message) || err).slice(0, 300) }; }
  });
  // Kézi letöltés böngészőablak nélkül, a belépő tárolt adataival. Ugyanaz a kapu, mint az ablakos kézi letöltésnél:
  // a szerver engedélye, a saját listánkkal való egyezés, és nem automatikus típusnál natív megerősítő kérdés.
  ipcMain.handle('auto:downloadManual', async (e, key, req) => {
    try {
      guard(e);
      key = String(key);
      if (!portalKeys().includes(key)) return { ok: false, code: 1, error: 'Ismeretlen belépő.' };
      const ses = e.sender.session; const win = BrowserWindow.fromWebContents(e.sender);
      const xsrf = (await ses.cookies.get({ url: ORIGIN, name: 'XSRF-TOKEN' }).catch(() => []))[0];
      const ask = () => authorizeDownload({
        fetchImpl: (url, init) => ses.fetch(url, init), origin: ORIGIN, xsrf: xsrf ? xsrf.value : null, ledger, portalKey: key,
        messageId: String((req && req.messageId) || ''), auto: false,
        confirm: info => confirmView.askDownload({ WebContentsView, win, info }),
      });
      let permit = await ask();
      if (!permit.ok && !permit.needList) return { ok: false, code: 4, denied: true, cancelled: !!permit.cancelled, error: permit.error };
      const state = autoState();
      const s = await tarhelyAuto.ensureSession(autoSessions, key, { getCreds: k => readPortalCreds(k), state });
      if (!s.reused) saveCfg({ auto: state });
      if (!s.ok) return { ok: false, code: 3, error: s.error };
      if (!permit.ok) {
        // Ezt az iratot ebben a futásban még nem listáztuk (például újraindítás után): előbb friss lista, utána újra az engedély.
        const rec = autoSessions.get(key);
        const letters = await tarhelyHttp.listAll(rec.ctx, { full: true, sent: !!(req && req.sent) || process.env.IRATKAPU_SIMULATOR === '1' });
        ledger.record(slimLiveLetters({ letters }, 50000)); ledger.noteMailboxes(rec.ctx.mailboxes);
        permit = await ask();
        if (!permit.ok) return { ok: false, code: 4, denied: true, cancelled: !!permit.cancelled, error: permit.error };
      }
      return await tarhelyAuto.downloadWithSession(autoSessions, key, permit);
    } catch (err) { return { ok: false, code: 4, error: String((err && err.message) || err).slice(0, 300) }; }
  });
  ipcMain.handle('auto:run', async (e, keys, filters, forceFull, opts) => {
    try {
      guard(e, 'auto:run');
      let summary; let simulator = false;
      const wantSent = !!(opts && opts.sent);
      const emitAuto = s => sendProgress(e.sender, 'auto:progress', {
        key: s.key, index: s.index, total: s.total, phase: s.phase,
        mailbox: s.mailbox || null, folder: s.folder || null, mbIndex: s.mbIndex || null, mbTotal: s.mbTotal || null,
      });
      if (process.env.IRATKAPU_SIMULATOR === '1' && !app.isPackaged) {
        simulator = true;
        // Fejlesztői mód: a valódi tárhely helyett a helyi szimulátor könyvelői mintája fut (hálózat nélkül).
        // A szimulátor nincs a telepítőcsomagban, ezért itt, kérésre töltjük be.
        const { createGovTwin, accountantScenario } = require(path.join(__dirname, 'simulator', 'gov-twin.js'));
        const twin = createGovTwin(accountantScenario());
        // A minta a felület első belépőjének neve alatt fut, a valódi úttal megegyezően (munkamenet megőrzése, listanyilvántartás),
        // így a letöltés kapuja és a letöltés maga is kipróbálható hálózat nélkül.
        const simKey = Array.isArray(keys) && keys.length ? String(keys[0]) : 'konyvelo';
        autoSessions.clear();
        summary = await tarhelyAuto.runClients([simKey], { getCreds: async () => twin.credentials.konyvelo, fetchImpl: twin.fetchImpl, sleep: async () => {}, sent: true, onSession: autoSessions.put, onStep: emitAuto,
          onProgress: r => { r.letters = slimLiveLetters(r, 50000); ledger.record(r.letters); } });
      } else {
        const all = portalKeys();
        const chosen = Array.isArray(keys) && keys.length ? keys.map(String).filter(k => all.includes(k)) : all;
        const eligible = await tarhelyAuto.eligibleClients(chosen, k => readPortalCreds(k));
        const state = autoState();
        const perKey = {};
        if (filters && typeof filters === 'object') for (const k of eligible) if (filters[k]) perKey[k] = cleanFilter(filters[k]);
        // Az állapotot belépőnként, azonnal mentjük: ha az app futás közben leáll, a jelszóhiba miatti tiltás akkor is megmarad.
        const force = {}; if (forceFull && typeof forceFull === 'object') for (const k of eligible) if (forceFull[k] === true) force[k] = true;
        // Üres listanyilvántartásnál (az alkalmazás indítása utáni első futás) mindenkinél teljes lista kell: letölteni csak azt lehet, amit ebben a futásban listáztunk.
        if (ledger.size() === 0) for (const k of eligible) force[k] = true;
        autoSessions.clear(); // új futás: a régi munkamenetek nem kellenek
        summary = await tarhelyAuto.runClients(eligible, { getCreds: k => readPortalCreds(k), state, filters: perKey, forceFull: force, sent: wantSent, onSession: autoSessions.put, onStep: emitAuto,
          onProgress: r => { if (r && r.key) markTotpUsed(r.key); r.letters = slimLiveLetters(r, 50000); ledger.record(r.letters); ledger.noteMailboxes(r.mailboxes); autoCtl.saver(state)(r); } });
      }
      // Figyelem: a `summary.ok` a sikeres ügyfelek SZÁMA, ezért külön mezőben adjuk át (okCount),
      // nehogy felülírja a transzport-szintű `ok` sikerjelzőt. Az eredmény titkot nem tartalmaz.
      return { ok: true, simulator, ran: summary.ran, okCount: summary.ok, failed: summary.failed, letterCount: summary.letterCount, results: summary.results };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  confirmView.register(ipcMain);
  aspLive.register(ipcMain);
  registerLockIpc(guard);
  ipcMain.handle('updater:get', e => { guard(e); return appUpdater.state(); });
  ipcMain.handle('updater:check', e => { guard(e); return appUpdater.check(); });
  ipcMain.handle('updater:install', e => { guard(e); return appUpdater.install(); });
  ipcMain.handle('updater:restart', e => { guard(e); return appUpdater.restartToUpdate(); });
}

async function probeKau(mode) {
  const s = new LiveSession({ BrowserWindow, session, show: false });
  const out = { probe: mode, start: await s.start(mode) };
  for (let i = 0; i < 80 && ['pending', 'running'].includes(s.status().status); i++) await new Promise(r => setTimeout(r, 500));
  await new Promise(r => setTimeout(r, 4000));
  out.status = s.status();
  if (s.win) out.page = await s.win.webContents.executeJavaScript(`({ host: location.hostname, path: location.pathname, title: document.title,
    headings: [...document.querySelectorAll('h1,h2,h3')].map(h => h.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 6),
    inputs: [...document.querySelectorAll('input:not([type=hidden])')].map(i => ({ id: i.id, type: i.type })),
    buttons: [...document.querySelectorAll('button')].map(b => b.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 12),
    qr: [...document.querySelectorAll('canvas, svg, img')].filter(n => { const r = n.getBoundingClientRect(); return r.width >= 120 && Math.abs(r.width - r.height) < 12; }).map(n => ({ tag: n.tagName.toLowerCase(), id: n.id || null, cls: String(n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className).slice(0, 60), w: Math.round(n.getBoundingClientRect().width) })) })`).catch(e => ({ error: String(e) }));
  console.log(JSON.stringify(out, null, 1));
  await s.close(); app.quit();
}

// Háttérben futás: bekapcsolva az ablak bezárása csak elrejti az ablakot, a felület tovább fut (és értesít),
// az app a tálcáról / menüsorból nyitható meg újra, és csak a „Kilépés” állítja le. Alapból ki van kapcsolva.
let tray = null, quitting = false;
const updateNotices = [];
function showMain() {
  if (!mainWin || mainWin.isDestroyed()) { createWindow(); return; }
  if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus();
}
const appUpdater = createUpdater({
  currentVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  envUpdateUrl: process.env.KAPUMAIL_UPDATE_URL || '',
  platform: process.platform,
  arch: process.arch,
  userDataDir: app.getPath('userData'),
  tempDir: app.getPath('temp'),
  downloadsDir: app.getPath('downloads'),
  openInstaller: p => shell.openPath(p),
  stopServices: async () => { mcpRelay.stop(); localSrv.stop(); },
  quitApp: () => { quitting = true; app.quit(); },
  onState: st => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('updater:state', st); },
  onProgress: p => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('updater:progress', p);
    if (p && p.phase === 'ready' && (!mainWin || mainWin.isDestroyed() || !mainWin.isVisible()) && Notification.isSupported()) {
      const n = new Notification({ title: `Kész a KapuMail ${p.version}`, body: 'Újraindítással vagy kilépéskor települ.' });
      n.on('click', showMain);
      updateNotices.push(n); if (updateNotices.length > 5) updateNotices.shift();
      n.show();
    }
  },
  onWindowProgress: v => { if (mainWin && !mainWin.isDestroyed()) mainWin.setProgressBar(v); },
  onNotifyAvailable: rel => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: `Elérhető a KapuMail ${rel.version}`, body: 'Nyisd meg a KapuMailt a frissítéshez.' });
    n.on('click', showMain);
    updateNotices.push(n); if (updateNotices.length > 5) updateNotices.shift();
    n.show();
  },
});
async function menuCheckForUpdates() {
  showMain();
  const st = await appUpdater.check();
  const ask = opts => (mainWin && !mainWin.isDestroyed() && mainWin.isVisible() ? dialog.showMessageBox(mainWin, opts) : dialog.showMessageBox(opts));
  if (!st.enabled) {
    await ask({ type: 'info', message: 'Fejlesztői példány fut', detail: `KapuMail ${st.current} – forráskódból indítva a program nem keres automatikusan frissítést.` });
    return;
  }
  if (st.failed) {
    await ask({ type: 'warning', message: 'A kapumail.hu jelenleg nem érhető el.', detail: 'A KapuMail később automatikusan újra megpróbálja.' });
    return;
  }
  if (!st.available) {
    await ask({ type: 'info', message: 'A legújabb verzió fut.', detail: `KapuMail ${st.current}` });
  }
}
const bgOn = () => !SMOKE && !PROBE && readCfg().background === true;
function syncTray() {
  if (!bgOn()) { if (tray) { tray.destroy(); tray = null; } return; }
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 18, height: 18 }));
  tray.setToolTip('KapuMail – a háttérben fut');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'KapuMail megnyitása', click: showMain },
    { type: 'separator' },
    { label: 'Kilépés', click: () => { quitting = true; app.quit(); } },
  ]));
  if (process.platform !== 'darwin') tray.on('click', showMain);
}

// Életjel (ADR-016): 30 mp-enként a PHP storage/app mappájába; a helyi MCP ebből látja, fut-e az app, és hogyan indítható.
let aliveTimer = null;
const aliveData = ({ stopped = false } = {}) => aliveLib.payload({ now: Date.now(), pid: process.pid, isPackaged: app.isPackaged, stopped,
  launch: aliveLib.launchInfo({ platform: process.platform, execPath: process.execPath, isPackaged: app.isPackaged }) });
const aliveWrite = opts => { try { aliveLib.writeAlive(aliveLib.aliveFile(localSrv.resolvePaths()), aliveData(opts)); } catch { /* az életjel nem kritikus */ } };
function startAlive() { aliveWrite(); aliveTimer = setInterval(() => aliveWrite(), 30000); aliveTimer.unref(); }
function stopAlive() { if (!aliveTimer) return; clearInterval(aliveTimer); aliveTimer = null; aliveWrite({ stopped: true }); }

async function createWindow() {
  // Az ablak címsora (és a natív párbeszédek) fixen világosak maradnak, akkor is, ha a rendszer sötét módban van.
  nativeTheme.themeSource = 'light';
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 380, minHeight: 600, title: 'KapuMail', backgroundColor: '#eadff5', show: !SMOKE && !MCP_BG, icon: ICON,
    titleBarStyle: 'hidden', trafficLightPosition: { x: 13, y: 7 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  mainWin = win;
  win.on('resize', fitLock); win.on('focus', () => { if (lockView) lockView.webContents.focus(); });
  win.on('close', e => { if (bgOn() && !quitting) { e.preventDefault(); kapu.lockStop(); win.hide(); if (lockCfg().enabled && !locked) lockNow(); } });
  // Bezárt ablak = zárolt alkalmazás: macOS-en az app az ablak bezárása után is fut, és újranyitáskor (Dock, újabb indítás)
  // új ablakot kap. Bekapcsolt zárnál ez az új ablak a zárképernyővel nyílik, különben a zár egy ablakbezárással megkerülhető lenne.
  win.on('closed', () => {
    // Kapu: az ablakkal együtt az élő hang (codex, mikrofon-kapcsolat) és a futó körök is leállnak.
    kapu.cancelAll({ cleanupNow: true });
    if (mainWin !== win) return;
    dropLockView(); mainWin = null;
    if (!SMOKE && lockCfg().enabled && !locked) { locked = true; liveWasVisible = Boolean(live && live.win && !live.win.isDestroyed() && live.win.isVisible()); if (liveWasVisible) live.win.hide(); }
  });
  if (locked) showLock();
  const sameOrigin = url => { try { return url.startsWith('file:') ? ['setup.html', 'welcome.html'].some(f => url === require('url').pathToFileURL(path.join(__dirname, f)).href) : new URL(url).origin === new URL(ORIGIN).origin; } catch { return false; } };
  win.webContents.on('will-navigate', (e, url) => { if (!sameOrigin(url)) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => cb(allowMic({
    contents: wc, permission, mainFrame: details && details.isMainFrame, url: details && details.requestingUrl, mediaTypes: (details && details.mediaTypes) || [],
  })));
  // Ellenőrzés: a médián kívül a korábbi (Electron alapértelmezett) viselkedés marad.
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => permission !== 'media' || allowMic({
    contents: wc, permission, mainFrame: details && details.isMainFrame, url: (details && details.requestingUrl) || origin, mediaTypes: details && details.mediaType ? [details.mediaType] : [],
  }));
  const t0 = Date.now();
  await win.loadFile(path.join(__dirname, 'splash.html'));
  // Első indítás: még nincs üzemmód, a kapu-animáció után a két kártyás választó jön (a szervert csak a választás után keressük).
  const first = !appMode();
  const up = first ? false : await ensureServer();
  if (!SMOKE) await new Promise(r => setTimeout(r, Math.max(0, (first ? 1800 : 900) - (Date.now() - t0))));
  if (win.isDestroyed()) return;
  if (up) startDaily();
  // Helyi módban a program maga lép be a kulcstartóban őrzött titokkal; ha a belépőoldalra kerülne (lejárt munkamenet, kijelentkezés), újra megteszi.
  // Összeomlott vagy leállított felület: a hang és a körök se fussanak tovább gazdátlanul.
  win.webContents.on('render-process-gone', () => kapu.cancelAll({ cleanupNow: true }));
  win.webContents.on('did-navigate', async (_e, url) => {
    kapu.resetScope(); // Kapu-chat: új oldal (kijelentkezés, belépőoldal, másik felhasználó) → a futó körök leállnak, a hatókört újra kérdezzük
    try { if (new URL(url).origin !== new URL(ORIGIN).origin || new URL(url).pathname !== '/login' || Date.now() - lastLocalEnter < 15000) return; } catch { return; }
    if ((await localEnter()) && !win.isDestroyed()) win.loadURL(ORIGIN + '/');
  });
  if (first) await win.loadFile(path.join(__dirname, 'welcome.html'));
  else if (up) { await localEnter(); await win.loadURL(ORIGIN + '/'); }
  else await win.loadFile(path.join(__dirname, 'setup.html'));
  if (lockView) lockView.webContents.focus();
  if (SMOKE) {
    const title = win.webContents.getTitle();
    const bridge = await win.webContents.executeJavaScript('typeof window.iratkapuDesktop === "object" && typeof window.iratkapuDesktop.portal === "object" && typeof window.require === "undefined"');
    const liveBridge = await win.webContents.executeJavaScript('window.iratkapuDesktop.live.status().then(x => x.status)').catch(e => 'HIBA: ' + e.message);
    const qrSupported = await win.webContents.executeJavaScript('typeof BarcodeDetector !== "undefined" ? BarcodeDetector.getSupportedFormats().then(f => f.includes("qr_code")).catch(() => false) : false').catch(() => false);
    console.log(JSON.stringify({ smoke: true, serverUp: up, origin: ORIGIN, packaged: app.isPackaged, title, bridgeIsolated: bridge, liveBridge, qrSupported, vaultAvailable: safeStorage.isEncryptionAvailable(), platform: process.platform }));
    app.quit();
  }
}

app.whenReady().then(() => {
  if (!process.env.IRATKAPU_URL) { const o = validUrl(readCfg().url || ''); if (o) ORIGIN = o; }
  if (PROBE) { probeKau(PROBE); return; }
  if (OBSERVE) {
    if (app.isPackaged) { app.quit(); return; }
    // A megfigyelő nincs a telepítőcsomagban, ezért itt, kérésre töltjük be. A jegyzőkönyv a gitből kizárt kutatási mappába kerül.
    if (!app.isPackaged) require(path.join(__dirname, 'dev', 'nav-observer.js')).run({ app, BrowserWindow, session, Menu, dialog, profile: OBSERVE, outDir: path.join(__dirname, '..', 'research', 'kiserletek', 'kimenet') });
    return;
  }
  registerIpc(); markRequests(); kapu.start(); if (!SMOKE) kapu.warmup();
  locked = !SMOKE && lockCfg().enabled; watchIdle();
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) app.dock.setIcon(ICON);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: 'A KapuMail névjegye' },
        { label: 'Frissítések keresése…', click: () => void menuCheckForUpdates() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'A KapuMail elrejtése' },
        { role: 'hideOthers', label: 'A többi elrejtése' },
        { role: 'unhide', label: 'Összes megjelenítése' },
        { type: 'separator' },
        { role: 'quit', label: 'Kilépés a KapuMailből' },
      ],
    }] : []),
    { role: 'editMenu' }, { label: 'Nézet', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }, { role: 'windowMenu' },
    { label: 'Zár', submenu: [
      { label: 'Zárolás most', accelerator: 'CmdOrCtrl+Shift+L', click: lockNow },
      ...(process.platform !== 'darwin' ? [{ type: 'separator' }, { label: 'Frissítések keresése…', click: () => void menuCheckForUpdates() }] : []),
    ] },
  ]));
  createWindow(); syncTray(); syncRelay();
  if (!SMOKE) startAlive();
  if (!SMOKE) appUpdater.start();
  app.on('activate', showMain);
});
app.on('before-quit', () => { quitting = true; appUpdater.stop(); kapu.cancelAll({ cleanupNow: true }); kapu.cancelSignIn().catch(() => {}); }); // a Kapu-körök gyerekfolyamatai külön csoportban futnak, ezért itt állítjuk le őket
if (!SMOKE && !PROBE && !OBSERVE) { if (!app.requestSingleInstanceLock()) app.quit(); else app.on('second-instance', (_e, argv) => { if (Array.isArray(argv) && argv.includes('--mcp-hatter')) return; if (app.isReady()) showMain(); }); }
app.on('window-all-closed', () => { if ((process.platform !== 'darwin' || SMOKE) && !PROBE) app.quit(); });
app.on('quit', () => { stopAlive(); mcpRelay.stop(); localSrv.stop(); appUpdater.applyStagedOnQuit(); });
