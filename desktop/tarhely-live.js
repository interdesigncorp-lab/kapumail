// Élő összekapcsolás a hivatalos belépőoldalon, mindhárom KAÜ-móddal:
//  1) Ügyfélkapu+ hitelesítő alkalmazással (tárolt OS-kulcstartós automata VAGY kézi belépés),
//  2) Ügyfélkapu+ e-mailes kóddal (interaktív jóváhagyás, majd megtartott munkamenet),
//  3) DÁP QR-kód (interaktív mobilappos jóváhagyás, majd megtartott munkamenet).
//
// Invariánsok:
//  - Csak https és csak *.gov.hu cím tölthető be az elszigetelt munkamenetben.
//  - Kitöltött belépőmezőről soha nem készül képernyőkép vagy napló; a tárolt titok
//    kizárólag a memóriában él a belépés másodpercei alatt, majd azonnal törlődik.
//  - Postafiók-elszigetelés: minden REST-hívás előtt ellenőrizzük, hogy a lap `address-id`
//    fejléce megegyezik a kért postafiók azonosítójával.
//  - Író/törlő/küldő végpont nincs a kódban: csak postafiók-lekérés, keresés, részlet és
//    kifejezett parancsra (vagy irodai szabályra) egyedi letöltés.
//
// Referencia: godavid/tarhely-cli (MIT, f9fbddd) src/kau/login.ts és src/tarhely/api.ts.

const { totpCode, secondsLeftInWindow } = require('./totp');
const { mailboxAllowed } = require('./mailbox-filter');
const { describeMailbox } = require('./mailbox-ident');

const MODES = {
  totp: { suffix: ':uk:totp', label: 'Ügyfélkapu+ hitelesítő alkalmazással' },
  email: { suffix: ':uk:email', label: 'Ügyfélkapu+ e-mailes kóddal' },
  dap: { suffix: ':dap:qr', label: 'DÁP' },
};
const TARHELY_URL = 'https://tarhely.gov.hu';
const INBOX_URL = 'https://tarhely.gov.hu/levelezes/';
const API = '/levelezes/api';
const PARTITION = 'tarhely-live'; // memória-munkamenet: bezáráskor minden süti elvész

/** Csak https és csak kormányzati (gov.hu) cím tölthető be a belépőablakban. */
function allowedUrl(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && (u.hostname === 'gov.hu' || u.hostname.endsWith('.gov.hu')); } catch { return false; }
}
function phaseOf(url) {
  try { const h = new URL(url).hostname; return h === 'kau.gov.hu' || h.endsWith('.kau.gov.hu') ? 'kau' : h === 'tarhely.gov.hu' ? 'tarhely' : 'other'; } catch { return 'other'; }
}

/** Hibaüzenetbe írható hely: csak gépnév és útvonal, lekérdezés és munkamenet-azonosító nélkül. */
function kauWhere(url) {
  try { const u = new URL(url); return (u.hostname + u.pathname.split(';')[0]).slice(0, 80); } catch { return 'ismeretlen cím'; }
}

/** A KAÜ módválasztóján a kért mód űrlapjának elküldése (szükség esetén lenyíló nyitással). */
function selectScript(mode) {
  const m = MODES[mode]; if (!m) throw new Error('Ismeretlen belépési mód');
  return `(() => {
    const suffix = ${JSON.stringify(m.suffix)}, label = ${JSON.stringify(m.label)};
    const norm = s => String(s || '').replace(/\\s+/g, ' ').trim();
    const dd = typeof document.getElementById === 'function' ? document.getElementById('dropdown-control-id') : null;
    if (dd && dd.getAttribute && dd.getAttribute('aria-expanded') !== 'true') { try { dd.click(); } catch {} }
    let form = [...document.forms].find(f => f.id && f.id.includes(':azonositas:kau:') && f.id.endsWith(suffix));
    let button = form && form.querySelector('button[type=submit], input[type=submit]');
    if (!button && suffix !== ':dap:qr') button = [...document.querySelectorAll('button')].find(b => norm(b.innerText) === label);
    if (!form && !button) return document.forms.length ? 'no-form' : 'not-ready';
    if (button) button.click(); else form.submit();
    return 'ok';
  })()`;
}

/** Felhasználónév + jelszó kitöltése a KAÜ ÜK+ űrlapján. A bemenetek JSON-kódolva érkeznek. */
function fillCredentialsScript(username, password) {
  return `(() => {
    const u = document.querySelector('#name'), p = document.querySelector('#password');
    if (!u || !p) return 'not-ready';
    const setVal = (el, val) => {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (d && d.set) d.set.call(el, val); else el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setVal(u, ${JSON.stringify(String(username))});
    setVal(p, ${JSON.stringify(String(password))});
    const btn = [...document.querySelectorAll('button, input[type=submit]')].find(b => /bejelentkez[eé]s|tov[aá]bb|bel[eé]p[eé]s/i.test((b.innerText || b.value || '').trim()))
      || (p.form && p.form.querySelector('button[type=submit], input[type=submit]'));
    if (btn) btn.click(); else if (p.form) p.form.submit(); else return 'no-submit';
    return 'submitted';
  })()`;
}

/** A második lépcsős 6 jegyű TOTP-kód kitöltése és beküldése (`#identifier`). */
function fillTotpScript(code) {
  return `(() => {
    const inp = document.querySelector('#identifier');
    if (!inp) return document.querySelector('#password') ? 'still-password' : 'not-ready';
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (d && d.set) d.set.call(inp, ${JSON.stringify(String(code))}); else inp.value = ${JSON.stringify(String(code))};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    const btn = [...document.querySelectorAll('button, input[type=submit]')].find(b => /bejelentkez[eé]s|tov[aá]bb|bel[eé]p[eé]s|ellen[oő]rz[eé]s/i.test((b.innerText || b.value || '').trim()))
      || (inp.form && inp.form.querySelector('button[type=submit], input[type=submit]'));
    if (btn) btn.click(); else if (inp.form) inp.form.submit(); else return 'no-submit';
    return 'submitted';
  })()`;
}

/** A /mailbox/reload válaszából a postafiókok, a választó sorrendjében. */
function toMailboxRefs(items) {
  if (!Array.isArray(items)) return [];
  const refs = [];
  items.forEach((item, index) => {
    if (!item || typeof item.azonosito !== 'string' || item.azonosito === '') return;
    refs.push({ ...describeMailbox(item, index), quotaPct: null }); // a név itt már a szervernek küldött, belépőnként egyedi kulcs
  });
  return refs;
}

function addDaysIso(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const normFolder = f => (f === 'TARTOS_TAR' ? 'TARTOS_TAR' : f === 'ELKULDOTT' ? 'ELKULDOTT' : 'BEERKEZETT');

/** Az API erkezesiDatum-a magyar helyi idő UTC-nek álcázva, ezért UTC-ben olvassuk. */
function apiRow(item, mailboxName, folder = 'BEERKEZETT') {
  const dir = normFolder(folder);
  const ts = item && (item.kuldesiDatum ?? item.feladasiDatum ?? item.erkezesiDatum);
  let when = '';
  if (typeof ts === 'number' || typeof ts === 'string') { const d = new Date(ts); if (!isNaN(d)) when = d.toISOString().slice(0, 16).replace('T', ' '); }
  const durable = dir === 'TARTOS_TAR';
  let expiresAt = null;
  const rawExp = item && (item.torlesDatum ?? item.lejaratiDatum ?? item.megorzesiIdo);
  if (typeof rawExp === 'string' || typeof rawExp === 'number') {
    const ed = new Date(rawExp);
    if (!isNaN(ed)) expiresAt = ed.toISOString().slice(0, 10);
  }
  if (!expiresAt && !durable && dir !== 'ELKULDOTT' && when.length >= 10) expiresAt = addDaysIso(when.slice(0, 10), 30);
  let portalOpened = null;
  if (item && typeof item.olvasatlan === 'boolean') portalOpened = !item.olvasatlan; // élő próbával igazolt mező (2026-11-12)
  else if (item && typeof item.olvasott === 'boolean') portalOpened = item.olvasott;
  else if (item && typeof item.megnyitott === 'boolean') portalOpened = item.megnyitott;
  else if (item && typeof item.letoltott === 'boolean') portalOpened = item.letoltott;
  const refEid = item && typeof item.hivatkozottErkeztetesiSzam === 'string' && item.hivatkozottErkeztetesiSzam ? item.hivatkozottErkeztetesiSzam.slice(0, 64) : '';
  return {
    eid: item && typeof item.erkeztetesiSzam === 'string' ? item.erkeztetesiSzam : null,
    mailbox: mailboxName,
    sender: String((item && (item.feladoRovidNev || item.feladoNev)) || ''),
    senderFull: String((item && item.feladoNev) ?? ''),
    recipient: [item && item.cimzettNev, item && item.cimzettRovidNev].filter((x, i, a) => typeof x === 'string' && x !== '' && a.indexOf(x) === i).join(' '),
    type: String((item && item.dokumentumTipus) ?? ''),
    desc: String((item && item.dokumentumLeiras) ?? ''),
    receivedAt: when,
    size: item && typeof item.fajlMeret === 'number' ? item.fajlMeret : null,
    portalOpened,
    expiresAt,
    durable,
    folder: dir,
    ...(dir === 'ELKULDOTT' ? { recipientShort: String((item && item.cimzettRovidNev) ?? '').slice(0, 64) } : {}),
    ...(refEid ? { refEid } : {}),
  };
}

function sanitizeFileName(fileName, fallbackEid = 'irat') {
  const raw = String(fileName || '').trim();
  const safe = raw.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^\.+/, '');
  return (safe || `kuldemeny-${String(fallbackEid).replace(/[^A-Za-z0-9_-]/g, '')}.es3`).slice(-100);
}

const LIST_FILTER = { searchTerm: null, labelIds: null, unreadOnly: null, excludeSystemMessages: null, messageTypes: [], verificationTypes: [], incomingFromDate: null, incomingToDate: null };

function listScript(addressId, xsrf, pageNumber, folder = 'BEERKEZETT') {
  const box = normFolder(folder);
  const path = `${API}/uzenetek/${box}/kereses`;
  return `(async () => {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', 'address-id': ${JSON.stringify(addressId)} };
    let x = ${JSON.stringify(xsrf || '')};
    if (!x) { const c = document.cookie.split('; ').find(i => i.startsWith('XSRF-TOKEN=')); if (c) x = decodeURIComponent(c.split('=')[1] || ''); }
    if (x) headers['x-xsrf-token'] = x;
    const r = await fetch(${JSON.stringify(path)}, { method: 'POST', headers, credentials: 'include',
      body: JSON.stringify({ pageNumber: ${Number(pageNumber)}, countPerPage: '100', filter: ${JSON.stringify(LIST_FILTER)} }) });
    const t = await r.text(); let body; try { body = JSON.parse(t); } catch { body = null; }
    return { status: r.status, body };
  })()`;
}

function quotaScript(addressId, xsrf) {
  return `(async () => {
    const headers = { Accept: 'application/json', 'address-id': ${JSON.stringify(addressId)} };
    let x = ${JSON.stringify(xsrf || '')};
    if (!x) { const c = document.cookie.split('; ').find(i => i.startsWith('XSRF-TOKEN=')); if (c) x = decodeURIComponent(c.split('=')[1] || ''); }
    if (x) headers['x-xsrf-token'] = x;
    const r = await fetch(${JSON.stringify(API + '/mailbox/details')}, { method: 'GET', headers, credentials: 'include' });
    if (r.status !== 200) return { status: r.status, pct: null };
    const d = await r.json().catch(() => ({}));
    const used = Number(d.hasznaltKvota ?? 0), total = Number(d.kvota ?? 0);
    return { status: 200, pct: total > 0 ? Math.round((used / total) * 1000) / 10 : null };
  })()`;
}

/** Részletek lekérése egyetlen küldeményhez (fájlnév, hivatkozott érkeztetési szám, megjegyzés). */
function detailScript(addressId, xsrf, eid, folder = 'BEERKEZETT') {
  const sub = folder === 'TARTOS_TAR' ? 'tartos' : folder === 'ELKULDOTT' ? 'elkuldott' : 'beerkezett';
  const path = `${API}/uzenet/${sub}/${encodeURIComponent(eid)}`;
  return `(async () => {
    const headers = { Accept: 'application/json', 'address-id': ${JSON.stringify(addressId)} };
    let x = ${JSON.stringify(xsrf || '')};
    if (!x) { const c = document.cookie.split('; ').find(i => i.startsWith('XSRF-TOKEN=')); if (c) x = decodeURIComponent(c.split('=')[1] || ''); }
    if (x) headers['x-xsrf-token'] = x;
    const r = await fetch(${JSON.stringify(path)}, { method: 'GET', headers, credentials: 'include' });
    const t = await r.text(); let body; try { body = JSON.parse(t); } catch { body = null; }
    return { status: r.status, body };
  })()`;
}

/** Egyetlen küldemény bináris letöltése a postafiók saját `address-id` fejlécével. */
function downloadScript(addressId, xsrf, eid, folder = 'BEERKEZETT') {
  const sub = folder === 'TARTOS_TAR' ? 'tartostar' : folder === 'ELKULDOTT' ? 'elkuldott' : 'beerkezett';
  const path = `${API}/uzenet/letoltes/${sub}/${encodeURIComponent(eid)}`;
  return `(async () => {
    const headers = { Accept: '*/*', 'address-id': ${JSON.stringify(addressId)} };
    let x = ${JSON.stringify(xsrf || '')};
    if (!x) { const c = document.cookie.split('; ').find(i => i.startsWith('XSRF-TOKEN=')); if (c) x = decodeURIComponent(c.split('=')[1] || ''); }
    if (x) headers['x-xsrf-token'] = x;
    const r = await fetch(${JSON.stringify(path)}, { method: 'GET', headers, credentials: 'include' });
    const ct = r.headers.get('content-type') || '';
    if (r.status !== 200) return { status: r.status, contentType: ct, base64: null };
    const bytes = new Uint8Array(await r.arrayBuffer());
    let raw = '';
    for (let off = 0; off < bytes.length; off += 0x8000) raw += String.fromCharCode(...bytes.subarray(off, off + 0x8000));
    return { status: 200, contentType: ct, size: bytes.length, base64: btoa(raw) };
  })()`;
}

function switchScript(index) {
  return `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (const m of document.querySelectorAll('modal-container.show, .modal.show, [role=dialog]'))
      for (const b of m.querySelectorAll('button')) if (/bezár|mégse|megse|close/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || ''))) { b.click(); break; }
    let sel = null;
    for (let i = 0; i < 90 && !(sel = document.querySelector('#mailboxSelectorButton')); i++) await sleep(500);
    if (!sel) return 'no-selector';
    if (sel.getAttribute('aria-expanded') === 'false') { sel.click(); await sleep(800); }
    const opt = document.querySelector('#selectMailboxButton_${Number(index)}');
    if (!opt) return 'no-option';
    opt.click(); return 'ok';
  })()`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TXT = { idle: 'Nincs összekapcsolva', pending: 'Függőben', running: 'Folyamatban', confirm: 'Megerősítés', connected: 'Kész', failed: 'Sikertelen' };

/**
 * Egyetlen élő munkamenet. Az `electron` függőséget kívülről kapja, hogy a tiszta logika
 * Electron nélkül is tesztelhető legyen.
 */
class LiveSession {
  constructor({ BrowserWindow, session, timeoutMs = 10 * 60 * 1000, show = true, tickMs = 1000 }) {
    this.el = { BrowserWindow, session }; this.timeoutMs = timeoutMs; this.show = show; this.tickMs = tickMs;
    this.win = null; this.busy = false; this._reset();
  }
  _reset() {
    this.s = { status: 'idle', mode: null, auto: false, portalId: null, error: null, since: null };
    this.sniff = { addressId: null, xsrf: null, mailboxes: [] };
    this._creds = null; this.selected = false; this.autoRunning = false; this.sawKau = false; this.priming = false; this.kicked = false; this.totpSent = false;
    clearTimeout(this.timer);
  }
  status() {
    return {
      status: this.s.status, label: TXT[this.s.status], mode: this.s.mode,
      modeLabel: this.s.mode ? MODES[this.s.mode].label : null,
      auto: !!this.s.auto, portalId: this.s.portalId,
      visible: !!(this.win && !this.win.isDestroyed() && this.win.isVisible()),
      error: this.s.error, since: this.s.since, mailboxes: this.sniff.mailboxes.length,
    };
  }
  setWindowVisible(vis) {
    if (!this.win || this.win.isDestroyed()) return { ok: false };
    if (vis) { this.win.show(); this.win.focus(); } else this.win.hide();
    return { ok: true, visible: this.win.isVisible() };
  }
  _fail(error) {
    if (this.s.status === 'failed') return;
    this._creds = null;
    this.s.status = 'failed'; this.s.error = error; clearTimeout(this.timer);
    const w = this.win; this.win = null; if (w && !w.isDestroyed()) w.destroy();
  }
  async close() {
    this._creds = null;
    const w = this.win; this.win = null; if (w && !w.isDestroyed()) w.destroy();
    this._reset();
    if (this.el.session) await this.el.session.fromPartition(PARTITION).clearStorageData().catch(() => {});
  }

  /**
   * Indítja a KAÜ/Tárhely összekapcsolást.
   * Ha `opts.creds` (`{ username, password, totpSeed }`) meg van adva `totp` módban, a belépés
   * felügyelet nélkül, rejtett ablakban fut le. Egyébként interaktív ablak nyílik (pl. DÁP QR, e-mail).
   */
  async start(mode, parent, opts = {}) {
    if (!MODES[mode]) return { ok: false, error: 'Ismeretlen belépési mód.' };
    const auto = !!(mode === 'totp' && opts && opts.creds && opts.creds.username && opts.creds.password && opts.creds.totpSeed);
    await this.close();
    const ses = this.el.session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    this._creds = auto ? { username: opts.creds.username, password: opts.creds.password, totpSeed: opts.creds.totpSeed } : null;
    this.s = { status: 'pending', mode, auto, portalId: opts.portalId || null, error: null, since: null };
    const win = this.win = new this.el.BrowserWindow({
      width: 560, height: 820, show: auto ? false : this.show, parent: auto ? undefined : (parent || undefined),
      title: 'Belépés a hivatalos oldalon – ' + MODES[mode].label, autoHideMenuBar: true,
      webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
    });
    const wc = win.webContents;
    const block = (e, url) => { if (!allowedUrl(url)) e.preventDefault(); };
    wc.on('will-navigate', block); wc.on('will-redirect', block);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('page-title-updated', e => e.preventDefault());
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null;
        if (this.s.status !== 'connected') this._fail('Bezártad a belépőablakot, mielőtt a belépés befejeződött.');
        else this._fail('A belépőablak bezárult, a kapcsolat megszűnt.');
      }
    });
    wc.on('did-finish-load', () => this._onLoad(win).catch(e => this._fail('Váratlan hiba: ' + String(e.message || e).slice(0, 200))));
    this.timer = setTimeout(() => { if (this.s.status !== 'connected') this._fail('Időtúllépés: a belépés nem fejeződött be időben.'); }, auto ? 120000 : this.timeoutMs);
    win.loadURL(TARHELY_URL).catch(() => { if (this.win === win && this.s.status === 'pending') this._fail('A tarhely.gov.hu nem érhető el.'); });
    return { ok: true, auto };
  }

  async _onLoad(win) {
    if (this.win !== win) return;
    const wc = win.webContents, phase = phaseOf(wc.getURL());
    if (phase === 'kau') {
      if (this.s.status === 'connected') return this._fail('A kapcsolat megszűnt: a tárhely újra belépést kér.');
      this.sawKau = true;
      if (this.selected) return;
      this.s.status = 'running';
      for (let i = 0; i < 20; i++) {
        if (this.win !== win || phaseOf(wc.getURL()) !== 'kau') return;
        const r = await wc.executeJavaScript(selectScript(this.s.mode), true).catch(() => 'not-ready');
        if (r === 'ok') {
          this.selected = true;
          this.s.status = 'confirm';
          if (this._creds && !this.autoRunning) {
            this.autoRunning = true;
            this._runAutoTotp(win).catch(e => this._fail('Automata belépés sikertelen: ' + String(e.message || e).slice(0, 200)));
          }
          return;
        }
        if (r === 'no-form' && i >= 6) break;
        await sleep(500);
      }
      return this._fail(`A hivatalos belépőoldalon nem található a(z) „${MODES[this.s.mode].label}” lehetőség. Lehet, hogy az oldal megváltozott.`);
    }
    if (phase === 'tarhely' && this.s.status !== 'connected' && !this.priming) {
      if (!this.sawKau) {
        // Még nem léptünk be: a tárhely lapja betölt, majd magától a KAÜ-re visz. Itt NEM indul feltöltés és a
        // belépési adatok megmaradnak (2026-11-13, élőben: az idő előtti feltöltés törölte az automata belépés
        // adatait és újratöltötte a módválasztót, ezért a belépés megállt). Ha a lap nem visz tovább, egyszer meglökjük.
        if (!this.kicked) {
          this.kicked = true;
          setTimeout(() => {
            if (this.win === win && !this.sawKau && this.s.status !== 'failed' && phaseOf(wc.getURL()) === 'tarhely') wc.loadURL(INBOX_URL).catch(() => {});
          }, 5 * this.tickMs);
        }
        return;
      }
      // Automata belépésnél a kód elküldése előtt a tárhely-cím még nem jelent belépést.
      if (this.s.auto && this.autoRunning && !this.totpSent) return;
      this._creds = null;
      this.priming = true; this.s.status = 'running';
      try { await this._prime(win); } finally { this.priming = false; }
    }
  }

  /** Felügyelet nélküli ÜK+ TOTP belépés az OS titoktárból feloldott adatokkal. */
  async _runAutoTotp(win) {
    const creds = this._creds;
    if (!creds) return;
    try {
      const wc = win.webContents;
      // 1. lépés: várakozás a #name és #password mezőkre, majd kitöltés
      let filled = false;
      for (let i = 0; i < 50; i++) {
        if (this.win !== win || this.s.status === 'failed' || this.s.status === 'connected') return;
        if (phaseOf(wc.getURL()) === 'tarhely') return;
        const st = await wc.executeJavaScript(`Boolean(document.querySelector('#name') && document.querySelector('#password'))`, true).catch(() => false);
        if (st) {
          await sleep(600);
          const res = await wc.executeJavaScript(fillCredentialsScript(creds.username, creds.password), true).catch(() => 'err');
          if (res === 'submitted') { filled = true; break; }
        }
        await sleep(500);
      }
      if (!filled) return this._fail('A belépőoldalon nem jelent meg a felhasználónév/jelszó űrlap.');

      // 2. lépés: várakozás a #identifier (6 jegyű kód) mezőre; rossz jelszó felismerése ciklus nélkül
      let hasTotpInput = false;
      for (let i = 0; i < 50; i++) {
        if (this.win !== win || this.s.status === 'failed' || this.s.status === 'connected') return;
        if (phaseOf(wc.getURL()) === 'tarhely') return;
        const probe = await wc.executeJavaScript(`(() => {
          if (document.querySelector('#identifier')) return 'totp';
          const err = [...document.querySelectorAll('.alert-danger, .error, [role=alert], .invalid-feedback, .form-error')].map(n => (n.innerText || '').trim()).filter(Boolean).join(' ');
          if (document.querySelector('#password') && err) return 'bad-cred';
          return 'wait';
        })()`, true).catch(() => 'wait');
        if (probe === 'totp') { hasTotpInput = true; break; }
        if (probe === 'bad-cred' && i >= 3) {
          return this._fail('A KAÜ nem fogadta el a felhasználónevet vagy a jelszót. Ellenőrizd és frissítsd a belépési adatokat.');
        }
        await sleep(500);
      }
      if (!hasTotpInput) {
        const stillPw = await wc.executeJavaScript(`Boolean(document.querySelector('#password'))`, true).catch(() => false);
        return this._fail(stillPw
          ? 'A KAÜ nem fogadta el a felhasználónevet vagy a jelszót.'
          : 'A jelszó elküldése után nem jelent meg a hitelesítő kód mezője.');
      }

      // 3. lépés: ha az aktuális 30 mp-es TOTP-ablakból < 7 mp maradt, megvárjuk az újat
      const rem = secondsLeftInWindow(Date.now() / 1000);
      if (rem < 7) await sleep((rem + 1) * 1000);
      if (this.win !== win) return;
      const code = totpCode(creds.totpSeed, Date.now() / 1000);
      await sleep(400);
      const step2 = await wc.executeJavaScript(fillTotpScript(code), true).catch(() => 'err');
      if (step2 !== 'submitted') return this._fail('Nem sikerült elküldeni a hatjegyű hitelesítő kódot.');
      this.totpSent = true;

      // 4. lépés: várakozás a SAML visszairányításra a tárhelyre
      for (let i = 0; i < 60; i++) {
        if (this.win !== win || this.s.status === 'failed' || this.s.status === 'connected') return;
        if (phaseOf(wc.getURL()) === 'tarhely') {
          if (!this.priming && this.s.status !== 'connected') {
            this.priming = true; this.s.status = 'running';
            try { await this._prime(win); } finally { this.priming = false; }
          }
          return;
        }
        if (i >= 10) {
          const rejected = await wc.executeJavaScript(`(() => {
            const inp = document.querySelector('#identifier');
            if (!inp) return false;
            const err = [...document.querySelectorAll('.alert-danger, .error, [role=alert], .invalid-feedback')].map(n => (n.innerText || '').trim()).filter(Boolean).join(' ');
            return Boolean(err) || inp.value === '';
          })()`, true).catch(() => false);
          if (rejected) return this._fail('A KAÜ nem fogadta el a hatjegyű hitelesítő kódot (ellenőrizd a 16 karakteres kulcsot és a gép óráját).');
        }
        await sleep(750);
      }
      if (this.s.status !== 'connected') this._fail('A hitelesítő kód után nem érkezett meg a tárhely válasza.');
    } finally {
      this._creds = null;
    }
  }

  // A fejléceket (address-id, XSRF) és a postafiókokat a lap saját API-forgalmából lessük le,
  // mint a tarhely-cli. A figyelő csak a belépés UTÁN indul, így jelszót hordozó kérést nem lát.
  async _prime(win) {
    const wc = win.webContents, dbg = wc.debugger, pending = new Set();
    if (!dbg.isAttached()) dbg.attach('1.3');
    dbg.on('message', (_e, method, p) => {
      try {
        if (method === 'Network.requestWillBeSent' && p.request.url.includes(API + '/')) {
          const h = {}; for (const k of Object.keys(p.request.headers || {})) h[k.toLowerCase()] = p.request.headers[k];
          if (h['address-id']) { this.sniff.addressId = String(h['address-id']); if (h['x-xsrf-token']) this.sniff.xsrf = String(h['x-xsrf-token']); }
        } else if (method === 'Network.responseReceived' && p.response.status === 200 && p.response.url.endsWith(API + '/mailbox/reload')) pending.add(p.requestId);
        else if (method === 'Network.loadingFinished' && pending.delete(p.requestId)) {
          dbg.sendCommand('Network.getResponseBody', { requestId: p.requestId }).then(b => {
            const refs = toMailboxRefs(JSON.parse(b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body));
            if (refs.length) this.sniff.mailboxes = refs;
          }).catch(() => {});
        }
      } catch { /* best-effort */ }
    });
    await dbg.sendCommand('Network.enable');
    // Belépés előtt indult-e a feltöltés (a tárhely nyitólapja betöltött, mielőtt a KAÜ-re vitt volna)?
    const authed = this.sawKau;
    let kauTicks = 0;
    for (let round = 0; round < 3; round++) {
      if (this.win !== win) return;
      await wc.loadURL(INBOX_URL).catch(() => {});
      for (let tick = 0; tick < 20; tick++) {
        if (this.win !== win || this.s.status === 'failed') return;
        if (phaseOf(wc.getURL()) === 'kau') {
          // Még nem léptünk be: ez a szokásos belépőoldal, nem hiba. A feltöltés a belépés után újraindul.
          if (!authed) return;
          // Belépés után a tárhely az egyszeri belépés (SSO) miatt átmenetileg a KAÜ-n át töltődhet be („Átirányítás…”).
          // Csak akkor hiba, ha a KAÜ tényleg újra adatot kér, vagy az átirányítás nem ér véget.
          kauTicks++;
          const needsInput = await wc.executeJavaScript(`Boolean(document.querySelector('#name, #password, #identifier, form[id*=":azonositas:kau:"]'))`, true).catch(() => false);
          if ((needsInput && kauTicks >= 4) || kauTicks >= 15) {
            return this._fail(`A belépés nem fejeződött be: a tárhely visszairányított a belépőoldalra${needsInput ? ', amely újra azonosítást kér' : ', és az átirányítás nem ért véget'} (${kauWhere(wc.getURL())}).`);
          }
          await sleep(this.tickMs);
          continue;
        }
        kauTicks = 0;
        if (this.sniff.addressId && this.sniff.mailboxes.length) {
          this.s.status = 'connected'; this.s.since = new Date().toISOString(); clearTimeout(this.timer);
          if (!win.isDestroyed()) win.hide();
          return;
        }
        await sleep(this.tickMs);
      }
    }
    this._fail('A belépés sikerült, de a tárhely nem adta meg a postafiókokat. Lehet, hogy az oldal megváltozott.');
  }

  async _switchMailbox(wc, mb) {
    if (this.sniff.addressId !== mb.addressId) {
      const r = await wc.executeJavaScript(switchScript(mb.index), true);
      if (r !== 'ok') throw new Error(`A postafiók-választó nem található (${mb.name}). Lehet, hogy az oldal megváltozott.`);
      for (let i = 0; i < 30 && this.sniff.addressId !== mb.addressId; i++) await sleep(500);
    }
    if (this.sniff.addressId !== mb.addressId) {
      throw new Error(`Nem sikerült átváltani erre a postafiókra: ${mb.name} (address-id eltérés).`);
    }
  }

  mailboxes() {
    if (this.s.status !== 'connected') return { ok: false, code: 3, error: 'Nincs élő kapcsolat. Indítsd el az összekapcsolást.' };
    return { ok: true, mailboxes: this.sniff.mailboxes.map(m => ({ name: m.name.slice(0, 200), rawName: String(m.rawName ?? '').slice(0, 200), displayName: String(m.displayName ?? '').slice(0, 200), type: m.type ?? null, isDefault: m.isDefault === true, quotaPct: m.quotaPct ?? null })) };
  }

  async list(since, opts = {}) {
    if (this.s.status !== 'connected' || !this.win) return { ok: false, code: 3, error: 'Nincs élő kapcsolat. Indítsd el az összekapcsolást.' };
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) return { ok: false, code: 1, error: 'Érvénytelen dátum.' };
    if (this.busy) return { ok: false, code: 1, error: 'Már fut egy tárhelyművelet.' };
    this.busy = true;
    const includeDurable = opts.includeDurable !== false;
    try {
      const wc = this.win.webContents, letters = [], quotas = {};
      const allowedMbs = this.sniff.mailboxes.filter(mb => mailboxAllowed(mb.name, opts.mailboxFilter || null));
      const folderLabel = f => (f === 'TARTOS_TAR' ? 'Tartós tár' : f === 'ELKULDOTT' ? 'Elküldött' : 'Beérkezett');
      const emit = p => { if (opts.onProgress) try { opts.onProgress(p); } catch { /* nem állítja meg */ } };
      for (let mi = 0; mi < allowedMbs.length; mi++) {
        const mb = allowedMbs[mi];
        const mbLabel = String(mb.displayName || mb.name || 'postafiók').slice(0, 70);
        emit({ index: mi + 1, total: allowedMbs.length, mailbox: mbLabel, folder: 'átváltás', page: 1 });
        await this._switchMailbox(wc, mb);
        const q = await wc.executeJavaScript(quotaScript(mb.addressId, this.sniff.xsrf), true).catch(() => null);
        if (q && typeof q.pct === 'number') { mb.quotaPct = q.pct; quotas[mb.name] = q.pct; }
        const folders = ['BEERKEZETT', ...(includeDurable ? ['TARTOS_TAR'] : []), ...(opts.includeSent ? ['ELKULDOTT'] : [])];
        const seenInMb = new Set();
        for (const folder of folders) {
          const rows = [];
          for (let page = 0; page < 50; page++) {
            emit({ index: mi + 1, total: allowedMbs.length, mailbox: mbLabel, folder: folderLabel(folder), page: page + 1 });
            const r = await wc.executeJavaScript(listScript(mb.addressId, this.sniff.xsrf, page, folder), true);
            if (!this.win || r.status === 401 || r.status === 403) {
              if (folder !== 'BEERKEZETT') break;
              this._fail('A kapcsolat megszűnt: a tárhely újra belépést kér.');
              return { ok: false, code: 3, error: this.s.error };
            }
            if (r.status !== 200 || !r.body) {
              if (folder !== 'BEERKEZETT') break; // opcionális mappa nem minden fióktípusnál érhető el
              throw new Error(`A tárhely nem várt választ adott (HTTP ${r.status}).`);
            }
            const items = Array.isArray(r.body.uzenetek) ? r.body.uzenetek : [];
            rows.push(...items);
            const total = r.body.uzenetekSzama;
            if (!items.length || (total != null && rows.length >= total)) break;
          }
          for (const it of rows) {
            const row = apiRow(it, mb.name, folder);
            const seenKey = (folder === 'ELKULDOTT' ? 'SENT:' : 'IN:') + row.eid;
            if (!row.eid || seenInMb.has(seenKey)) continue;
            seenInMb.add(seenKey);
            if (!since || row.receivedAt.slice(0, 10) >= since) letters.push(row);
          }
        }
      }
      return { ok: true, letters, quotas };
    } catch (e) { return { ok: false, code: 4, error: String(e.message || e).slice(0, 300) }; }
    finally { this.busy = false; }
  }

  /**
   * Egyetlen küldemény eredeti fájljának (`.es3` / `.pdf` / `.xml`) letöltése parancsra vagy
   * kifejezett irodai szabály alapján, postafiók-azonosító ellenőrzéssel.
   */
  async downloadOne(mailboxName, eid, folder = 'BEERKEZETT') {
    if (this.s.status !== 'connected' || !this.win) return { ok: false, code: 3, error: 'Nincs élő kapcsolat a tárhellyel. Előbb kapcsold össze a fiókot.' };
    if (typeof eid !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(eid)) return { ok: false, code: 1, error: 'Érvénytelen érkeztetési szám.' };
    const mb = this.sniff.mailboxes.find(m => m.name === mailboxName);
    if (!mb) return { ok: false, code: 1, error: `A postafiók nem található az aktív munkamenetben: ${mailboxName}` };
    if (this.busy) return { ok: false, code: 1, error: 'Már fut egy tárhelyművelet, várj egy pillanatot.' };
    this.busy = true;
    try {
      const wc = this.win.webContents;
      await this._switchMailbox(wc, mb);
      const detRes = await wc.executeJavaScript(detailScript(mb.addressId, this.sniff.xsrf, eid, folder), true);
      if (!this.win || detRes.status === 401 || detRes.status === 403) {
        this._fail('A kapcsolat megszűnt: a tárhely újra belépést kér.');
        return { ok: false, code: 3, error: this.s.error };
      }
      if (detRes.status === 404) {
        return { ok: false, code: 4, error: 'Az üzenet nem található a tárhelyen (lehet, hogy 30 nap után már törlődött).' };
      }
      const dBody = detRes.status === 200 && detRes.body && typeof detRes.body === 'object' ? detRes.body : {};
      const dlRes = await wc.executeJavaScript(downloadScript(mb.addressId, this.sniff.xsrf, eid, folder), true);
      if (!this.win || dlRes.status === 401 || dlRes.status === 403) {
        this._fail('A kapcsolat megszűnt: a tárhely újra belépést kér.');
        return { ok: false, code: 3, error: this.s.error };
      }
      if (dlRes.status === 404) {
        return { ok: false, code: 4, error: 'Az üzenet már nem tölthető le a tárhelyről (30 napos megőrzési idő lejárt).' };
      }
      if (dlRes.status !== 200 || !dlRes.base64) {
        return { ok: false, code: 4, error: `A letöltés sikertelen (HTTP ${dlRes.status}).` };
      }
      if (/json|html/i.test(String(dlRes.contentType || ''))) {
        return { ok: false, code: 4, error: 'A tárhely fájl helyett weboldalt adott vissza (valószínűleg lejárt a munkamenet).' };
      }
      const bytes = Buffer.from(String(dlRes.base64), 'base64');
      if (bytes.byteLength === 0) {
        return { ok: false, code: 4, error: 'A tárhely üres fájlt adott vissza.' };
      }
      return {
        ok: true,
        eid,
        mailbox: mb.name,
        folder,
        fileName: sanitizeFileName(dBody.fajlNev, eid),
        contentType: String(dlRes.contentType || 'application/octet-stream'),
        size: bytes.byteLength,
        bytesBase64: bytes.toString('base64'),
        detail: {
          referencedRegistrationNumber: typeof dBody.hivatkozottErkeztetesiSzam === 'string' ? dBody.hivatkozottErkeztetesiSzam : null,
          note: typeof dBody.megjegyzes === 'string' ? dBody.megjegyzes : null,
        },
      };
    } catch (e) {
      return { ok: false, code: 4, error: String(e.message || e).slice(0, 300) };
    } finally {
      this.busy = false;
    }
  }
}

module.exports = {
  MODES,
  kauWhere,
  PARTITION,
  allowedUrl,
  phaseOf,
  selectScript,
  fillCredentialsScript,
  fillTotpScript,
  toMailboxRefs,
  apiRow,
  sanitizeFileName,
  listScript,
  quotaScript,
  detailScript,
  downloadScript,
  switchScript,
  LiveSession,
};
