// Felügyelet nélküli, többügyfeles tárhely-listázás (ADR-008 C-cél).
//
// Ügyfelenként tárolt belépővel (felhasználónév, jelszó, TOTP-kulcs) sorban belép a hivatali
// tárhelyre a HTTP-maggal (desktop/tarhely-http.js) – böngészőablak nélkül –, és lekéri minden
// postafiók beérkezett leveleit. Egy ügyfél hibája nem állítja meg a többit.
//
// Jogi kapu: a tárolt TOTP-kulcsos, felügyelet nélküli belépést az ADR-006 tulajdonosi döntése
// nyitotta meg (2026-11-12), meghatalmazás és OS-kulcstár feltétellel. Csak listázás, nem letöltés.
//
// Titkok: a belépő kizárólag a `getCreds(key)` visszaadta objektumban él, a belépés idejére; a
// visszaadott eredmény és a napló SOHA nem tartalmaz felhasználónevet, jelszót, kulcsot vagy kódot.

const H = require('./tarhely-http');

/** Egy ügyfél belépőjének alkalmassága a felügyelet nélküli futásra. */
function credsUsable(c) {
  if (!c || !c.username || !c.password) return { ok: false, error: 'Nincs tárolt belépő ehhez az ügyfélhez.' };
  if ((c.mode || 'totp') !== 'totp') return { ok: false, error: 'A felügyelet nélküli futás csak hitelesítő alkalmazásos (totp) belépővel megy; az e-mailes és DÁP-mód embert igényel.' };
  if (!c.totpSeed) return { ok: false, error: 'Hiányzik a hitelesítő kulcs (TOTP-seed); e nélkül nincs felügyelet nélküli belépés.' };
  return { ok: true };
}

const realSleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_FAILS = 3;

/** A hiba fajtája: jelszóhiba után nem próbálkozunk újra (kizárás veszélye); minden más „egyéb”. */
function classifyError(message) {
  return /hibás felhasználónév vagy jelszó/i.test(String(message || '')) ? 'password' : 'other';
}

const blankState = () => ({ fails: 0, blocked: null, lastError: null, lastOkAt: null });

/** A tiltás feloldása (a belépési adatok újramentésekor). */
function unblock(state, key) {
  if (state) state[key] = { ...(state[key] || {}), ...blankState(), lastOkAt: (state[key] && state[key].lastOkAt) || null }; // a visszaigazolt futások ideje megmarad
}

/** A belépő tiltásának oka, vagy null. Az ablakos automata belépés is ezt kérdezi. */
function blockedReason(state, key) {
  return (state && state[key] && state[key].blocked) || null;
}
const recordFailure = (state, key, error) => record(state, key, { ok: false, error });
const recordSuccess = (state, key) => record(state, key, { ok: true });

/**
 * A lemezen lévő állapot frissítése egyetlen belépő friss eredményével. A kihagyott (tiltott) belépőhöz nem nyúl,
 * így a futás közben feloldott tiltást a régi pillanatkép nem írja vissza; más belépők állapota megmarad.
 */
function mergeResult(current, state, result) {
  const out = { ...(current && typeof current === 'object' ? current : {}) };
  if (result && !result.skipped && state && state[result.key]) out[result.key] = state[result.key];
  return out;
}

/** Egy futás eredményének rögzítése az állapotban. Jelszóhiba: azonnali tiltás; három más hiba egymás után: tiltás. */
function record(state, key, result) {
  if (!state) return;
  const st = state[key] || blankState();
  if (result.ok) { state[key] = { ...st, fails: 0, blocked: null, lastError: null, lastOkAt: Date.now() }; return; }
  st.fails += 1; st.lastError = result.error || 'ismeretlen hiba';
  if (classifyError(result.error) === 'password') st.blocked = 'Hibás jelszó vagy felhasználónév. A kizárás elkerülésére a program nem próbálkozik újra, amíg a belépési adatokat újra nem mented.';
  else if (st.fails >= MAX_FAILS) st.blocked = 'Három egymást követő futás hibázott. Ellenőrizd a belépőt, és mentsd újra a belépési adatokat.';
  state[key] = st;
}

const DAY = 86400000;
const FULL_EVERY = 7 * DAY;   // legalább hetente teljes listázás (tartós tárral és telítettséggel)
const OVERLAP = 3 * DAY;      // növekményes listázásnál ennyi átfedés az utolsó sikeres futáshoz képest

/**
 * Mit kell most listázni egy belépővel. Teljes listát kérünk első alkalommal, hetente, ha a felület kéri (például új
 * postafiók került a belépő alá), és ha megváltozott a postafiók-szűrő; közben csak az utolsó VISSZAIGAZOLT futás óta
 * érkezett leveleket, néhány nap átfedéssel. A vízjel a szerver befogadásához igazodik (`acknowledge`), nem a sikeres
 * listázáshoz: ha a lista nem jutott el a szerverre, a következő futás nem hagy ki semmit.
 * @returns {{ full: boolean, since: Date|null }}
 */
function listingWindow(st, now = Date.now(), { forceFull = false, filterSig = undefined } = {}) {
  const sigChanged = filterSig !== undefined && st && st.filterSig !== undefined && st.filterSig !== filterSig;
  if (forceFull || sigChanged || !st || !st.ackAt || !st.ackFullAt || now - st.ackFullAt >= FULL_EVERY) return { full: true, since: null };
  return { full: false, since: new Date(st.ackAt - OVERLAP) };
}

/** A szerver befogadta a belépő listáját: innen számít a növekményes ablak. Teljes listánál a szűrő lenyomata is rögzül. */
function acknowledge(state, key, { full = false, at = Date.now() } = {}) {
  if (!state) return;
  const st = state[key] || blankState();
  st.ackAt = at;
  if (full) { st.ackFullAt = at; if (st.pendingSig !== undefined) st.filterSig = st.pendingSig; }
  state[key] = st;
}

/**
 * Egy ügyfél feldolgozása. Sosem dob: a hibát az eredmény `ok:false` + `error` mezője hordozza.
 * `key`: az ügyfél azonosítója (a belépő kulcsa a titoktárban). `getCreds(key)` adja a belépőt.
 * `mailboxFilter`: a belépőn kikapcsolt rendszerek postafiókjait kihagyó szűrő (mailbox-filter.js).
 * `window`: teljes vagy növekményes listázás (listingWindow).
 */
async function runClient(key, { getCreds, fetchImpl, log = null, onSession = null, mailboxFilter = null, sleep = realSleep, random = Math.random, window = { full: true, since: null }, sent = false } = {}) {
  const started = Date.now();
  const base = { key, ok: false, letterCount: 0, mailboxes: [], letters: [] };
  try {
    const creds = await getCreds(key);
    const usable = credsUsable(creds);
    if (!usable.ok) return { ...base, error: usable.error };
    const ctx = await H.loginWithCredentials(
      { username: creds.username, password: creds.password, seed: creds.totpSeed },
      { fetchImpl },
    );
    const letters = await H.listAll(ctx, { log, mailboxFilter, sleep, random, full: window.full, since: window.since, sent: Boolean(sent) });
    if (onSession) { try { onSession(key, ctx); } catch { /* a visszahívás hibája nem állíthatja meg a futást */ } }
    return {
      key, ok: true, full: window.full,
      mailboxes: ctx.mailboxes.map(m => ({ addressId: m.addressId, name: m.name, rawName: m.rawName, displayName: m.displayName, type: m.type, isDefault: m.isDefault, ...(m.quotaPct != null ? { quotaPct: m.quotaPct } : {}), ...(m.skipped ? { skipped: true } : {}) })),
      letters, letterCount: letters.length,
      ms: Date.now() - started,
    };
  } catch (e) {
    return { ...base, error: String((e && e.message) || e).slice(0, 300), ms: Date.now() - started };
  }
}

/** A futásonkénti letöltési korlát: a beállított érték csak csökkentheti az alapértéket; érvénytelen értéknél az alap marad. */
function downloadCap(raw, base = 50) {
  const n = Number(raw);
  return raw != null && raw !== '' && Number.isInteger(n) && n >= 0 && n < base ? n : base;
}

/**
 * A belépők munkamenetei a listázás UTÁNRA, a letöltéshez: csak a főfolyamat memóriájában élnek, rövid ideig.
 * Azért őrizzük meg, hogy a letöltéshez ne kelljen újra belépni (az kétszer annyi belépés és kódhasználat lenne).
 * A tár tartja számon a futás letöltéseit is: `maxDownloads` fölött egy futásban nem megy ki több letöltési kérés,
 * bármit kér a felület. A korlát becslés, nem a tárhely ismert határához igazított érték.
 */
function makeSessions({ ttlMs = 30 * 60 * 1000, now = Date.now, maxDownloads = 50, maxKeptBytes = 60 * 1024 * 1024 } = {}) {
  const items = new Map();
  const run = { downloads: 0, keptBytes: 0 };
  return {
    put: (key, ctx) => { items.set(String(key), { ctx, at: now(), downloads: 0, doubtful: 0, done: new Map(), queue: Promise.resolve() }); },
    get: key => { const s = items.get(String(key)); if (!s) return null; if (now() - s.at > ttlMs) { items.delete(String(key)); return null; } return s; },
    drop: key => { items.delete(String(key)); },
    clear: () => { items.clear(); run.downloads = 0; run.keptBytes = 0; },
    run, maxDownloads, maxKeptBytes,
  };
}

/**
 * Munkamenet kérésre, a kézi letöltéshez: ha a belépőnek van még élő munkamenete, azt adja vissza; különben belép a tárolt
 * adatokkal. A tiltott belépővel nem próbálkozik, és a belépés eredményét ugyanúgy számolja, mint a szinkron (jelszóhiba
 * után tiltás), hogy a kézi letöltés se zárhassa ki a fiókot ismételt próbálkozással. Sosem dob.
 */
async function ensureSession(sessions, key, { getCreds, fetchImpl = fetch, state = null } = {}) {
  if (sessions.get(key)) return { ok: true, reused: true };
  if (state && state[key] && state[key].blocked) return { ok: false, error: `A belépő tiltva: ${state[key].blocked}` };
  let result;
  try {
    const creds = await getCreds(key);
    const usable = credsUsable(creds);
    if (!usable.ok) return { ok: false, error: usable.error };
    const ctx = await H.loginWithCredentials({ username: creds.username, password: creds.password, seed: creds.totpSeed }, { fetchImpl });
    sessions.put(key, ctx);
    result = { ok: true };
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
  record(state, key, result);
  return result;
}

/**
 * Egy, a letöltési kapu által MÁR engedélyezett irat letöltése a belépő megőrzött munkamenetével.
 * - A postafiókot a kapu által megnevezett kulcs alapján keresi ki a munkamenet saját listájából.
 * - Belépőnként egyszerre egy letöltés fut, közöttük 1,5–3 mp szünettel (párhuzamos hívásnál is).
 * - Ugyanazt az iratot egy futásban nem kéri le kétszer: az ismételt hívás a megőrzött fájlt kapja vissza (így a szerverre
 *   feltöltés megismételhető a tárhely újabb érintése nélkül).
 * - Két egymást követő bizonytalan válasz (403 vagy weboldal) után a munkamenetet lejártnak tekinti.
 * Sosem dob. `needSession`: nincs (vagy lejárt) munkamenet; `capReached`: a futás letöltési korlátja betelt –
 * mindkét esetben a hátralévő letöltések a következő szinkronra maradnak.
 */
function downloadWithSession(sessions, key, permit, opts = {}) {
  const s = sessions.get(key);
  if (!s) return Promise.resolve({ ok: false, code: 3, needSession: true, error: 'Ehhez a belépőhöz nincs élő munkamenet; a letöltés a következő szinkronra marad.' });
  const job = s.queue.then(() => downloadNow(sessions, key, s, permit, opts)).catch(e => ({ ok: false, code: 4, error: String((e && e.message) || e).slice(0, 300) }));
  s.queue = job.then(() => {}, () => {});
  return job;
}

async function downloadNow(sessions, key, s, permit, { sleep = realSleep, random = Math.random } = {}) {
  if (sessions.get(key) !== s) return { ok: false, code: 3, needSession: true, error: 'A belépő munkamenete időközben megszűnt; a letöltés a következő szinkronra marad.' };
  const mb = (s.ctx.mailboxes || []).find(m => m.name === permit.mailbox && !m.skipped);
  if (!mb) return { ok: false, code: 1, error: 'A postafiók nincs a belépő munkamenetében.' };
  const id = `${mb.addressId}|${permit.folder}|${permit.eid}`;
  if (s.done.has(id)) return s.done.get(id) || { ok: false, code: 1, already: true, error: 'Ezt az iratot ebben a futásban már letöltöttük; a fájl a következő szinkronnál kerül be.' };
  if (sessions.run.downloads >= sessions.maxDownloads) return { ok: false, code: 4, capReached: true, error: 'Ebben a futásban több letöltés nem indul; a többi a következő szinkronra marad.' };
  if (s.downloads > 0) await sleep(Math.round(1500 + random() * 1500));
  s.downloads += 1; sessions.run.downloads += 1;
  const r = await H.downloadLetter(s.ctx, mb.addressId, permit.eid, permit.folder);
  if (r.ok) {
    s.doubtful = 0;
    const out = { ...r, mailbox: mb.name };
    const keep = sessions.run.keptBytes + r.size <= sessions.maxKeptBytes; // nagy fájlokból nem tartunk a memóriában korlátlanul
    if (keep) sessions.run.keptBytes += r.size;
    s.done.set(id, keep ? out : null);
    return out;
  }
  if (r.ambiguous && (s.doubtful += 1) >= 2) { sessions.drop(key); return { ...r, code: 3, needSession: true }; }
  if (r.expired) { sessions.drop(key); return { ...r, needSession: true }; }
  return r;
}

/**
 * Több belépő sorban (nem párhuzamosan), kíméletesen: belépők között 3–6 mp véletlen szünet, azonnali
 * újrapróbálkozás nincs. Minden belépő külön munkamenet (saját sütitár), így nem keverednek.
 * `state[key]`: hibaszámláló és tiltás (a hívó menti); a tiltott belépőhöz a futó hozzá sem nyúl.
 * `filters[key]`: postafiók-szűrő belépőnként. `onProgress(result)` minden belépő után meghívódik. Soha nem dob.
 */
async function runClients(keys, { getCreds, fetchImpl = fetch, log = null, onProgress = null, onSession = null, state = null, filters = null, forceFull = null, sleep = realSleep, random = Math.random, now = Date.now, sent = false } = {}) {
  const results = []; let attempted = 0;
  for (const key of Array.isArray(keys) ? keys : []) {
    let r;
    if (state && state[key] && state[key].blocked) {
      r = { key, ok: false, skipped: true, letterCount: 0, mailboxes: [], letters: [], error: `A belépő tiltva, a szinkron szünetel: ${state[key].blocked}` };
    } else {
      if (attempted++ > 0) await sleep(Math.round(3000 + random() * 3000));
      const filter = (filters && filters[key]) || null; const sig = JSON.stringify(filter);
      r = await runClient(key, { getCreds, fetchImpl, log, onSession, mailboxFilter: filter, sleep, random, sent, window: listingWindow(state && state[key], now(), { forceFull: !!(forceFull && forceFull[key]), filterSig: sig }) });
      record(state, key, r);
      if (state && r.ok) state[key].pendingSig = sig; // teljes listánál a visszaigazoláskor válik érvényessé
    }
    results.push(r);
    if (onProgress) { try { onProgress(r); } catch { /* a visszahívás hibája nem állíthatja meg a futást */ } }
  }
  return {
    ran: results.length,
    ok: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    letterCount: results.reduce((n, r) => n + (r.letterCount || 0), 0),
    results,
  };
}

/** A felügyelet nélküli futásra alkalmas ügyfelek kiszűrése egy kulcslistából (belépő olvasással). */
async function eligibleClients(keys, getCreds) {
  const out = [];
  for (const key of Array.isArray(keys) ? keys : []) {
    const c = await getCreds(key);
    if (credsUsable(c).ok) out.push(key);
  }
  return out;
}

module.exports = { credsUsable, runClient, runClients, eligibleClients, classifyError, unblock, blockedReason, recordFailure, recordSuccess, mergeResult, listingWindow, acknowledge, makeSessions, downloadWithSession, ensureSession, downloadCap, MAX_FAILS };
