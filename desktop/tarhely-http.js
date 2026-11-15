// Közös HTTP-mag a hivatali tárhelyhez (ADR-008). Böngészőbe írt szkript, debugger-figyelés
// és felületi kattintás nélkül: a KAÜ-láncot az oldalak űrlapjait követve járja végig, a
// postafiók- és levéllistát sima REST-hívással kéri le.
//
// Kétféleképpen táplálható:
//   B) kész munkamenet sütijeivel (az Electron belépőablakból), emberi belépés után;
//   C) belépési adatból (felhasználónév, jelszó, TOTP-kulcs), felügyelet nélkül.
//
// Invariánsok:
//   - Csak https és csak a KAÜ-lánc gépei (kau/idp/tarhely gov.hu) hívhatók.
//   - A postafiókot kizárólag az `address-id` fejléc választja ki; minden válasznál ellenőrizzük,
//     hogy a kért azonosító a munkamenet postafiók-listájában szerepel (idegen fiók nem keveredhet).
//   - Titok (jelszó, TOTP-kulcs/-kód, süti, token, SAML-üzenet) sosem kerül a visszaadott értékbe
//     vagy a lépésnaplóba; a napló csak metódust, rövid címet és állapotkódot tartalmaz.
//
// Referencia: godavid/tarhely-cli (MIT, f9fbddd) src/kau/login.ts és src/tarhely/api.ts; a lánc
// lépéseit az R07 kísérlet igazolta élőben (2026-11-12).

const { totpCode, secondsLeftInWindow } = require('./totp');
const { mailboxAllowed } = require('./mailbox-filter');
const { describeMailbox } = require('./mailbox-ident');

const START_URL = 'https://tarhely.gov.hu/levelezes/login';
const INBOX_REFERER = 'https://tarhely.gov.hu/levelezes/';
const MAILBOX_URL = 'https://tarhely.gov.hu/levelezes/api/mailbox/reload';
const SEARCH_URL = 'https://tarhely.gov.hu/levelezes/api/uzenetek/BEERKEZETT/kereses';
const ALLOWED_HOSTS = ['kau.gov.hu', 'idp.gov.hu', 'tarhely.gov.hu'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MAX_HOPS = 25;
// Ugyanaz a keresési szűrő, amit a KapuMail élő listázása küld (desktop/tarhely-live.js).
const LIST_FILTER = { searchTerm: null, labelIds: null, unreadOnly: null, excludeSystemMessages: null, messageTypes: [], verificationTypes: [], incomingFromDate: null, incomingToDate: null };

// ---------------------------------------------------------------- engedélylista
function isAllowedUrl(url, hosts = ALLOWED_HOSTS) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && hosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch { return false; }
}
/** `hosts`: az adott lánc engedélylistája; alapból a tárhelyé. Más célrendszer (NAV-portál) saját, szűk listát ad meg. */
function assertAllowed(url, hosts = ALLOWED_HOSTS) {
  if (!isAllowedUrl(url, hosts)) { const u = (() => { try { return new URL(url); } catch { return null; } })(); throw new Error(`Nem engedélyezett cím, megállok: ${u ? u.protocol + '//' + u.host : '(érvénytelen URL)'}`); }
}

// ---------------------------------------------------------------- sütitár
class CookieJar {
  constructor() { this.items = []; }

  /** Egy nyers Set-Cookie sor feldolgozása az adott kérés URL-je szerint. */
  storeLine(url, line) {
    const u = new URL(url);
    const parts = String(line).split(';').map(s => s.trim());
    const eq = parts[0].indexOf('=');
    if (eq < 1) return;
    const c = { name: parts[0].slice(0, eq), value: parts[0].slice(eq + 1), domain: u.hostname.toLowerCase(), hostOnly: true, path: defaultPath(u.pathname), secure: false };
    let expired = false;
    for (const p of parts.slice(1)) {
      const i = p.indexOf('='); const k = (i === -1 ? p : p.slice(0, i)).toLowerCase(); const v = i === -1 ? '' : p.slice(i + 1);
      if (k === 'domain' && v) { c.domain = v.replace(/^\./, '').toLowerCase(); c.hostOnly = false; }
      else if (k === 'path' && v.startsWith('/')) c.path = v;
      else if (k === 'secure') c.secure = true;
      else if (k === 'max-age' && Number(v) <= 0) expired = true;
      else if (k === 'expires' && Number.isFinite(Date.parse(v)) && Date.parse(v) < Date.now()) expired = true;
    }
    // Idegen domainre nem állítható süti.
    if (!c.hostOnly && !(u.hostname === c.domain || u.hostname.endsWith('.' + c.domain))) return;
    this.items = this.items.filter(o => !(o.name === c.name && o.domain === c.domain && o.path === c.path));
    if (!expired) this.items.push(c);
  }
  store(url, setCookies) { for (const line of setCookies || []) this.storeLine(url, line); }

  /** Munkamenet beállítása kész sütikből (B opció: Electron session.cookies.get()). */
  seed(cookies) {
    for (const c of cookies || []) {
      if (!c || !c.name) continue;
      const domain = String(c.domain || '').replace(/^\./, '').toLowerCase();
      if (!domain) continue;
      this.items.push({ name: c.name, value: String(c.value ?? ''), domain, hostOnly: c.hostOnly !== false ? !String(c.domain || '').startsWith('.') : false, path: c.path || '/', secure: c.secure !== false });
    }
  }

  match(url) {
    const u = new URL(url);
    return this.items.filter(c =>
      (c.hostOnly ? u.hostname === c.domain : (u.hostname === c.domain || u.hostname.endsWith('.' + c.domain))) &&
      pathMatches(u.pathname, c.path) &&
      (!c.secure || u.protocol === 'https:'));
  }
  header(url) { return this.match(url).map(c => `${c.name}=${c.value}`).join('; '); }
  get(url, name) { return this.match(url).find(c => c.name === name)?.value; }
  names() { return this.items.map(c => `${c.domain}:${c.name}`); }
}
function defaultPath(pathname) { const i = pathname.lastIndexOf('/'); return i <= 0 ? '/' : pathname.slice(0, i); }
function pathMatches(reqPath, cookiePath) {
  if (cookiePath === '/' || reqPath === cookiePath) return true;
  return reqPath.startsWith(cookiePath.endsWith('/') ? cookiePath : cookiePath + '/');
}

// ---------------------------------------------------------------- HTML-űrlapok
const decode = s => String(s ?? '')
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeCp(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => safeCp(Number(n)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function safeCp(n) { try { return String.fromCodePoint(n); } catch { return ''; } }

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** Az összes <form> kiolvasása rejtett és látható mezőkkel, abszolút action-nel. */
function parseForms(html, baseUrl) {
  const forms = [];
  for (const m of String(html).matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const fa = attrs(m[1]);
    let action; try { action = new URL(fa.action || baseUrl, baseUrl).toString(); } catch { action = baseUrl; }
    const form = { id: fa.id || '', method: (fa.method || 'GET').toUpperCase(), action, fields: [], buttons: [] };
    for (const t of m[2].matchAll(/<(input|button|select|textarea)\b([^>]*)>/gi)) {
      const a = attrs(t[2]); const kind = t[1].toLowerCase();
      const type = (a.type || (kind === 'button' ? 'submit' : 'text')).toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'image') { form.buttons.push({ name: a.name || '', value: a.value || '', id: a.id || '' }); continue; }
      if (!a.name) continue;
      if ((type === 'checkbox' || type === 'radio') && !('checked' in a)) continue;
      form.fields.push({ name: a.name, value: a.value || '', type, id: a.id || '' });
    }
    forms.push(form);
  }
  return forms;
}

const hasField = (f, pred) => f.fields.some(pred);
const isAutoPost = f => hasField(f, x => /^(SAMLRequest|SAMLResponse)$/.test(x.name));
const findPasswordForm = forms => forms.find(f => hasField(f, x => x.type === 'password'));
const findSelectorForm = forms => forms.find(f => f.id.includes(':azonositas:kau:') && f.id.endsWith(':uk:totp'))
  || forms.find(f => hasField(f, x => /:uk:totp$/.test(x.value)));
const findTotpForm = forms => forms.find(f => !findPasswordForm([f]) && hasField(f, x => x.id === 'identifier' || /totp|otp|token|identifier/i.test(x.name)));

function pageError(html) {
  const hits = [...String(html).matchAll(/<[^>]+class="[^"]*(?:alert-danger|invalid-feedback|form-error|error)[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/gi)]
    .map(m => decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()).filter(Boolean);
  return hits[0]?.slice(0, 200) || '';
}

// ---------------------------------------------------------------- postafiók- és levéladat
/** A /mailbox/reload válaszából a postafiók-hivatkozások (index + azonosító + név). */
function toMailboxRefs(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => describeMailbox(item, index)).filter(Boolean);
}

/**
 * Egy keresés válaszából a levélsorok – csak amit a lista mutat. Élő próbával igazolt mezőnevek (2026-11-12):
 * erkeztetesiSzam, feladoRovidNev, feladoNev, cimzettNev, cimzettRovidNev, dokumentumTipus, dokumentumLeiras,
 * erkezesiDatum (ezredmásodperc), fajlMeret, olvasatlan (a tárhelyen még nem nyitották meg), tarolasiHely.
 */
const KNOWN_FOLDERS = new Set(['BEERKEZETT', 'TARTOS_TAR', 'ELKULDOTT']);
const normFolder = f => (KNOWN_FOLDERS.has(f) ? f : 'BEERKEZETT');

function toLetterRows(body, mailboxName, folder = 'BEERKEZETT') {
  const dir = normFolder(folder);
  const items = body && Array.isArray(body.uzenetek) ? body.uzenetek : [];
  return items.filter(it => it && typeof it.erkeztetesiSzam === 'string').map(it => {
    const rcpt = [it.cimzettNev, it.cimzettRovidNev].filter((x, i, a) => typeof x === 'string' && x !== '' && a.indexOf(x) === i).join(' ');
    const refEid = typeof it.hivatkozottErkeztetesiSzam === 'string' && it.hivatkozottErkeztetesiSzam ? it.hivatkozottErkeztetesiSzam.slice(0, 64) : '';
    return {
      eid: it.erkeztetesiSzam,
      mailbox: mailboxName,
      sender: String(it.feladoRovidNev || it.feladoNev || ''),
      senderFull: String(it.feladoNev ?? ''),
      recipient: rcpt.slice(0, 200),
      type: String(it.dokumentumTipus ?? ''),
      desc: String(it.dokumentumLeiras ?? ''),
      receivedAt: isoMinute(it.kuldesiDatum ?? it.feladasiDatum ?? it.erkezesiDatum),
      size: typeof it.fajlMeret === 'number' ? it.fajlMeret : null,
      portalOpened: typeof it.olvasatlan === 'boolean' ? !it.olvasatlan : null,
      durable: dir === 'TARTOS_TAR',
      folder: dir,
      ...(dir === 'ELKULDOTT' ? { recipientShort: String(it.cimzettRovidNev ?? '').slice(0, 64) } : {}),
      ...(refEid ? { refEid } : {}),
    };
  });
}
function isoMinute(ts) { if (ts == null) return ''; const d = new Date(ts); return isNaN(d) ? '' : d.toISOString().slice(0, 16).replace('T', ' '); }

function assertKnownAddressId(ctx, addressId) {
  if (!ctx.mailboxes.some(m => m.addressId === addressId)) {
    throw new Error('Ismeretlen postafiók-azonosító: a kért fiók nincs a munkamenet listájában.');
  }
}

// ---------------------------------------------------------------- HTTP
/**
 * Egy kérés, az átirányításokat kézzel követve (minden ugrásnál kezeljük a sütiket és az engedélylistát).
 * A `fetchImpl` cserélhető (teszt vagy Electron session.fetch); alapból a globális fetch.
 */
// `upgradeInsecure`: ha egy engedélyezett gép sima http-s címre irányít át (az ASP-portál a belépés végén ezt teszi),
// a kérés https-en megy ki, ahogy a böngészőkben is. Titkosítatlan kérés így sem indul; alapból kikapcsolva.
async function request(jar, url, { method = 'GET', form = null, json = null, headers = {}, referer = null, log = null, fetchImpl = fetch, hosts = ALLOWED_HOSTS, upgradeInsecure = false } = {}) {
  let body = json != null ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : undefined;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    assertAllowed(url, hosts);
    const h = { 'User-Agent': UA, 'Accept-Language': 'hu-HU,hu;q=0.9', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...headers };
    const cookie = jar.header(url); if (cookie) h.Cookie = cookie;
    if (referer) h.Referer = referer;
    if (body !== undefined) { h['Content-Type'] = json != null ? 'application/json' : 'application/x-www-form-urlencoded'; h.Origin = new URL(referer || url).origin; }
    const res = await fetchImpl(url, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    jar.store(url, res.headers.getSetCookie ? res.headers.getSetCookie() : []);
    if (log) log(`${method} ${shortUrl(url)} → ${res.status}`);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const to = new URL(res.headers.get('location'), url);
      if (upgradeInsecure && to.protocol === 'http:' && isAllowedUrl(`https://${to.hostname}/`, hosts)) { to.protocol = 'https:'; to.port = ''; }
      const next = to.toString();
      await res.arrayBuffer().catch(() => {});
      if (res.status !== 307 && res.status !== 308) { method = 'GET'; body = undefined; }
      referer = url; url = next; continue;
    }
    return { url, status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
  }
  throw new Error('Túl sok átirányítás a KAÜ-láncban.');
}
const shortUrl = u => { try { const x = new URL(u); return x.host + x.pathname.replace(/;[^/]*/g, ''); } catch { return '(url)'; } };

function submit(jar, form, overrides = {}, referer, button = null, opts = {}) {
  const data = {}; for (const f of form.fields) data[f.name] = f.value; Object.assign(data, overrides);
  if (button?.name) data[button.name] = button.value;
  if (form.method === 'POST') return request(jar, form.action, { method: 'POST', form: data, referer, ...opts });
  const u = new URL(form.action); for (const [k, v] of Object.entries(data)) u.searchParams.set(k, v);
  return request(jar, u.toString(), { referer, ...opts });
}
async function followAutoPosts(jar, page, opts) {
  for (let i = 0; i < 6; i++) {
    const f = parseForms(page.text, page.url).find(isAutoPost);
    if (!f) return page;
    page = await submit(jar, f, {}, page.url, null, opts);
  }
  return page;
}

// ---------------------------------------------------------------- magas szint
/**
 * B opció: kész munkamenetből (sütik) indulunk; csak a postafiók-listát kérjük le, belépés nélkül.
 * `cookies`: az Electron `session.cookies.get({})` alakú tömbje a tárhely/kau/idp sütikkel.
 */
async function contextFromSession(cookies, opts = {}) {
  const jar = new CookieJar(); jar.seed(cookies);
  const ctx = { jar, mailboxes: [], fetchImpl: opts.fetchImpl };
  await loadMailboxes(ctx, opts);
  return ctx;
}

/**
 * A KAÜ belépési lánc végigjárása Ügyfélkapu+ hitelesítő alkalmazásos móddal, a megadott célrendszer felől indulva.
 * `startUrl`: a célrendszer belépést indító címe; `endHost`: ahol a láncnak véget kell érnie; `hosts`: a lánc engedélylistája.
 * Visszaadja a sütitárat és az utolsó oldalt. A titkok csak e függvény futása alatt élnek.
 */
async function kauLogin({ username, password, seed = null, getCode = null }, { startUrl, endHost, hosts = ALLOWED_HOSTS, endName = 'a célrendszeren', upgradeInsecure = false }, opts = {}) {
  if (!username || !password) throw new Error('Hiányzó felhasználónév vagy jelszó.');
  if (!seed && !getCode) throw new Error('Hiányzó hitelesítő kulcs vagy kód-visszahívás.');
  const jar = new CookieJar(); const log = opts.log || null; const fopts = { log, fetchImpl: opts.fetchImpl, hosts, upgradeInsecure };

  let page = await request(jar, startUrl, fopts);
  page = await followAutoPosts(jar, page, fopts);

  let forms = parseForms(page.text, page.url);
  let pwForm = findPasswordForm(forms);
  if (!pwForm) {
    const sel = findSelectorForm(forms);
    if (!sel) throw new Error('Nem találom az „Ügyfélkapu+ hitelesítő alkalmazással” módot a KAÜ-oldalon.');
    page = await submit(jar, sel, {}, page.url, sel.buttons[0], fopts);
    page = await followAutoPosts(jar, page, fopts);
    forms = parseForms(page.text, page.url); pwForm = findPasswordForm(forms);
  }
  if (!pwForm) throw new Error('Nincs jelszómezős űrlap; lehet, hogy a belépőoldal megváltozott.');
  const userField = pwForm.fields.find(x => x.id === 'name') || pwForm.fields.find(x => x.type === 'text' || x.type === 'email');
  const passField = pwForm.fields.find(x => x.type === 'password');
  if (!userField) throw new Error('Nem találom a felhasználónév mezőt a belépőoldalon.');
  page = await submit(jar, pwForm, { [userField.name]: username, [passField.name]: password }, page.url, pwForm.buttons[0], fopts);
  page = await followAutoPosts(jar, page, fopts);

  forms = parseForms(page.text, page.url);
  if (findPasswordForm(forms)) throw new Error('Hibás felhasználónév vagy jelszó. ' + pageError(page.text));
  const totpForm = findTotpForm(forms);
  if (!totpForm) throw new Error('Nem találom a hitelesítő kód űrlapját. ' + pageError(page.text));
  const totpField = totpForm.fields.find(x => x.id === 'identifier') || totpForm.fields.find(x => /totp|otp|token|identifier/i.test(x.name));
  let code;
  if (seed) { if (secondsLeftInWindow() < 5) await sleep((secondsLeftInWindow() + 1) * 1000); code = totpCode(seed); }
  else { code = String(await getCode()).replace(/\s+/g, ''); if (!/^\d{6}$/.test(code)) throw new Error('A hitelesítő kód nem hat számjegy.'); }
  page = await submit(jar, totpForm, { [totpField.name]: code }, page.url, totpForm.buttons[0], fopts);
  page = await followAutoPosts(jar, page, fopts);

  if (new URL(page.url).hostname !== endHost) throw new Error(`A belépés nem ${endName} ért véget. ` + (pageError(page.text) || 'Lehet hibás kód, vagy közbeiktatott oldal.'));
  return { jar, page };
}

/**
 * C opció: belépési adatból (felhasználónév, jelszó, TOTP-kulcs VAGY kézi kód-visszahívás).
 * `getCode`: opcionális async függvény, ami a hatjegyű kódot adja (ha nincs tárolt kulcs).
 * A titkok csak e függvény futása alatt élnek; a visszaadott ctx nem tartalmazza őket.
 */
async function loginWithCredentials(creds, opts = {}) {
  const { jar } = await kauLogin(creds, { startUrl: START_URL, endHost: 'tarhely.gov.hu', endName: 'a tárhelyen' }, opts);
  const ctx = { jar, mailboxes: [], fetchImpl: opts.fetchImpl };
  await loadMailboxes(ctx, opts);
  return ctx;
}

async function loadMailboxes(ctx, opts = {}) {
  const xsrf = ctx.jar.get(MAILBOX_URL, 'XSRF-TOKEN');
  const api = await request(ctx.jar, MAILBOX_URL, { headers: { Accept: 'application/json', ...(xsrf ? { 'x-xsrf-token': decodeURIComponent(xsrf) } : {}) }, referer: INBOX_REFERER, log: opts.log, fetchImpl: opts.fetchImpl });
  if (api.status !== 200) throw new Error(`A postafiók-lista nem jött (HTTP ${api.status}). Lehet, hogy a munkamenet lejárt.`);
  let body; try { body = JSON.parse(api.text); } catch { throw new Error('A postafiók-lista nem JSON; a munkamenet valószínűleg lejárt.'); }
  const arr = Array.isArray(body) ? body : Object.values(body).find(Array.isArray);
  ctx.mailboxes = toMailboxRefs(arr);
  return ctx.mailboxes;
}

const FOLDER_URL = folder => SEARCH_URL.replace('/BEERKEZETT/', `/${folder}/`);
const DETAILS_URL = MAILBOX_URL.replace('/mailbox/reload', '/mailbox/details');

/**
 * Egy postafiók egy mappájának listája, csak olvasás; a fiókot az `address-id` fejléc választja ki.
 * `since` (Date): csak az azóta érkezett levelek – a tárhely szűrője teljes időbélyeget vár („Z” végű ISO alak;
 * a sima dátumra 400-as hibát ad). `folder`: BEERKEZETT vagy TARTOS_TAR.
 */
async function listMailbox(ctx, addressId, { maxPages = 50, log = null, folder = 'BEERKEZETT', since = null, sleep: wait = sleep, random = Math.random } = {}) {
  assertKnownAddressId(ctx, addressId);
  const mb = ctx.mailboxes.find(m => m.addressId === addressId);
  const dir = normFolder(folder);
  const url = FOLDER_URL(dir);
  const xsrf = ctx.jar.get(url, 'XSRF-TOKEN');
  const filter = { ...LIST_FILTER, incomingFromDate: since instanceof Date && !isNaN(since) ? since.toISOString() : null };
  const rows = []; let total = null;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0) await wait(Math.round(1000 + random() * 1000)); // a lapok között is szünet
    const r = await request(ctx.jar, url, {
      method: 'POST', json: { pageNumber: page, countPerPage: '100', filter },
      headers: { Accept: 'application/json', 'address-id': addressId, ...(xsrf ? { 'x-xsrf-token': decodeURIComponent(xsrf) } : {}) },
      referer: INBOX_REFERER, log, fetchImpl: ctx.fetchImpl,
    });
    if (r.status === 401 || r.status === 403) throw new Error('A munkamenet lejárt: a tárhely újra belépést kér.');
    if (r.status !== 200) throw new Error(`A tárhely nem várt választ adott (HTTP ${r.status}).`);
    let body; try { body = JSON.parse(r.text); } catch { throw new Error('A levéllista nem JSON.'); }
    const batch = toLetterRows(body, mb.name, dir); rows.push(...batch);
    total = body.uzenetekSzama ?? total;
    if (!batch.length || (total != null && rows.length >= total)) break;
  }
  return rows;
}

/** A postafiók telítettsége százalékban (`kvota` és `hasznaltKvota` alapján), vagy null. */
async function mailboxQuota(ctx, addressId, { log = null } = {}) {
  assertKnownAddressId(ctx, addressId);
  const xsrf = ctx.jar.get(DETAILS_URL, 'XSRF-TOKEN');
  const r = await request(ctx.jar, DETAILS_URL, { headers: { Accept: 'application/json', 'address-id': addressId, ...(xsrf ? { 'x-xsrf-token': decodeURIComponent(xsrf) } : {}) }, referer: INBOX_REFERER, log, fetchImpl: ctx.fetchImpl });
  if (r.status !== 200) return null;
  try { const d = JSON.parse(r.text); const total = Number(d.kvota || 0); return total > 0 ? Math.round((Number(d.hasznaltKvota || 0) / total) * 1000) / 10 : null; } catch { return null; }
}

/**
 * Minden postafiók listája egyben, kíméletesen: kérések között 1–2 mp véletlen szünet.
 * `opts.mailboxFilter` (mailbox-filter.js): a kiszűrt postafiók leveleit le sem kérjük; a postafiók
 * `skipped: true` jelzést kap, de a listában marad, hogy a szerver tudjon róla.
 * `opts.since` (Date): növekményes listázás – csak a Beérkezett, az azóta érkezett levelekkel.
 * Teljes listázásnál (`since` nélkül) a tartós tár és a telítettség is lekérdezésre kerül, ha `opts.full` igaz.
 * A szünet hossza becslés, nem a tárhely ismert korlátjához igazított érték.
 */
async function listAll(ctx, opts = {}) {
  const wait = opts.sleep || sleep; const rnd = opts.random || Math.random;
  const pause = () => wait(Math.round(1000 + rnd() * 1000));
  const out = []; let calls = 0;
  for (const mb of ctx.mailboxes) {
    if (!mailboxAllowed(mb.name, opts.mailboxFilter || null)) { mb.skipped = true; continue; }
    if (calls++ > 0) await pause();
    out.push(...await listMailbox(ctx, mb.addressId, { ...opts, folder: 'BEERKEZETT' }));
    if (opts.full && !opts.since) {
      await pause(); calls++;
      out.push(...await listMailbox(ctx, mb.addressId, { ...opts, folder: 'TARTOS_TAR' }).catch(() => [])); // nem minden fióktípusnál érhető el
      await pause(); calls++;
      mb.quotaPct = await mailboxQuota(ctx, mb.addressId, opts).catch(() => null);
    }
    if (opts.sent) {
      await pause(); calls++;
      out.push(...await listMailbox(ctx, mb.addressId, { ...opts, since: null, maxPages: opts.since ? 1 : opts.maxPages, folder: 'ELKULDOTT' }).catch(() => []));
    }
  }
  return out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- letöltés
// A tartós tár útvonalrésze „tartostar” (élőben igazolva, 2026-11-13); a rövid „tartos” alakra a tárhely 500-at ad.
const DOWNLOAD_SLUG = { BEERKEZETT: 'beerkezett', TARTOS_TAR: 'tartostar', ELKULDOTT: 'elkuldott' };
const DOWNLOAD_URL = (folder, eid) => MAILBOX_URL.replace('/mailbox/reload', `/uzenet/letoltes/${DOWNLOAD_SLUG[normFolder(folder)]}/${encodeURIComponent(eid)}`);
const MAX_DOWNLOAD = 20 * 1024 * 1024; // a szerver ennél nagyobb fájlt nem fogad be: amit nem tudnánk eltenni, azt le sem kérjük
function safeFileName(name, eid) {
  let raw = String(name || '').trim();
  try { raw = decodeURIComponent(raw); } catch { /* nem kódolt név */ }
  const safe = raw.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^\.+/, '');
  return (safe || `kuldemeny-${String(eid).replace(/[^A-Za-z0-9_-]/g, '')}.es3`).slice(-100);
}

/**
 * EGY küldemény eredeti fájljának letöltése, egyetlen kéréssel (részletet nem kér le: a fájlnév a válasz fejlécében jön).
 * FIGYELEM: a letöltéstől a levél a tárhelyen megnyitottá válik (élőben megfigyelve), és átvételnek számíthat. Ezt a
 * függvényt csak a letöltési kapu engedélye után szabad hívni (download-gate.js); maga nem dönt arról, mit szabad letölteni.
 * Hibát csak ismeretlen postafiókra dob; minden más esetben `{ ok: false, code, error }` a válasz (3: újra be kell lépni;
 * `ambiguous`: nem dönthető el, hogy a munkamenet járt le, vagy csak ez az irat nem adható ki). Újra nem próbálkozik.
 * @returns {Promise<{ ok: true, eid: string, folder: string, fileName: string, contentType: string, size: number, bytesBase64: string }
 *   | { ok: false, code: number, error: string, expired?: boolean }>}
 */
async function downloadLetter(ctx, addressId, eid, folder = 'BEERKEZETT', { log = null, maxBytes = MAX_DOWNLOAD } = {}) {
  assertKnownAddressId(ctx, addressId);
  if (typeof eid !== 'string' || !/^[A-Za-z0-9._:-]{1,80}$/.test(eid) || /^\.+$/.test(eid)) return { ok: false, code: 1, error: 'Érvénytelen érkeztetési szám.' };
  const dir = normFolder(folder);
  const url = DOWNLOAD_URL(dir, eid);
  assertAllowed(url);
  const xsrf = ctx.jar.get(url, 'XSRF-TOKEN'); const cookie = ctx.jar.header(url);
  const headers = { 'User-Agent': UA, 'Accept-Language': 'hu-HU,hu;q=0.9', Accept: '*/*', Referer: INBOX_REFERER, 'address-id': addressId,
    ...(cookie ? { Cookie: cookie } : {}), ...(xsrf ? { 'x-xsrf-token': decodeURIComponent(xsrf) } : {}) };
  let res;
  try { res = await (ctx.fetchImpl || fetch)(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(60000) }); }
  catch { return { ok: false, code: 4, error: 'A tárhely nem válaszolt a letöltésre.' }; }
  ctx.jar.store(url, res.headers.getSetCookie ? res.headers.getSetCookie() : []);
  if (log) log(`GET ${shortUrl(url).replace(/[^/]+$/, '…')} → ${res.status}`);
  const drain = () => res.arrayBuffer().catch(() => {});
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) { await drain(); return { ok: false, code: 3, expired: true, error: 'A munkamenet lejárt: a tárhely újra belépést kér.' }; }
  // 403 és a fájl helyett kapott weboldal lehet lejárt munkamenet, de lehet csak ennek az egy iratnak a hibája is: a hívó dönt.
  if (res.status === 403) { await drain(); return { ok: false, code: 4, ambiguous: true, error: 'A tárhely megtagadta a letöltést (HTTP 403).' }; }
  if (res.status === 404) { await drain(); return { ok: false, code: 4, error: 'Az üzenet már nem tölthető le a tárhelyről (törlődhetett, vagy másik mappába került).' }; }
  if (res.status !== 200) { await drain(); return { ok: false, code: 4, error: `A letöltés sikertelen (HTTP ${res.status}).` }; }
  const contentType = String(res.headers.get('content-type') || 'application/octet-stream');
  if (/json|html/i.test(contentType)) { await drain(); return { ok: false, code: 4, ambiguous: true, error: 'A tárhely fájl helyett weboldalt adott vissza.' }; }
  if (Number(res.headers.get('content-length') || 0) > maxBytes) { await drain(); return { ok: false, code: 4, error: 'A fájl túl nagy a letöltéshez.' }; }
  const named = res.headers.get('erkeztetesiszam');
  if (named && named !== eid) { await drain(); return { ok: false, code: 4, error: 'A tárhely más küldeményt adott vissza, mint amit kértünk; a fájlt eldobtuk.' }; }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) return { ok: false, code: 4, error: 'A tárhely üres fájlt adott vissza.' };
  if (bytes.length > maxBytes) return { ok: false, code: 4, error: 'A fájl túl nagy a letöltéshez.' };
  return { ok: true, eid, folder: dir, fileName: safeFileName(res.headers.get('filename'), eid), contentType, size: bytes.length, bytesBase64: bytes.toString('base64') };
}

/**
 * B opció: fetchImpl az Electron munkamenetéből. A belépőablak sütijeit a munkamenet hordozza,
 * így a hívások a böngészőével azonos ujjlenyomatúak. Csak belépés UTÁNi, átirányítás nélküli
 * hívásokhoz (postafiók- és levéllista); a KAÜ-láncot nem ezen járjuk végig.
 */
function sessionFetchAdapter(ses) {
  return (url, init) => ses.fetch(url, init);
}

module.exports = {
  // a KAÜ-lánc más célrendszerhez is (NAV-portál): saját kezdőcímmel és engedélylistával
  kauLogin, request,
  // letöltés (csak a letöltési kapu engedélye után hívható)
  downloadLetter, safeFileName,
  // engedélylista
  isAllowedUrl, assertAllowed, ALLOWED_HOSTS,
  // sütitár és űrlapok (tesztelt tiszta részek)
  CookieJar, parseForms, isAutoPost, findPasswordForm, findSelectorForm, findTotpForm, pageError,
  toMailboxRefs, toLetterRows, assertKnownAddressId,
  // magas szint
  contextFromSession, loginWithCredentials, loadMailboxes, listMailbox, listAll, mailboxQuota, sessionFetchAdapter,
  // állandók
  URLS: { START_URL, MAILBOX_URL, SEARCH_URL, INBOX_REFERER },
};
