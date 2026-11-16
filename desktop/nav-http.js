// NAV ügyfélportál – olvasás böngésző nélkül (7. fázis, „A kör”; docs/adr/ADR-010).
//
// Mit tud: belép a KAÜ-lánccal (ugyanaz az Ügyfélkapu+ kódos út, mint a tárhelynél), és a BELÉPŐ SAJÁT NEVÉBEN kiolvassa
// azt, ami egyszerű GET kéréssel elérhető: a bejelentkezett felhasználót, a képviselt adózók listáját, az adószámla
// összesítőjét, a jövőbeli esedékességek, a hiányzó bevallások és az adónaptár-bejegyzések számát, valamint – tételesen –
// az adónaptár bejegyzéseit és a hiányzó bevallásokat (kötelezettséggé alakítva: nav-calendar.js). A tételek ahhoz az
// adózóhoz tartoznak, akit a munkamenet a belépéskor „kiválasztottnak” mutat; a program ezen NEM változtat.
//
// Mit NEM tud, szándékosan: képviseletet váltani (az módosító kérés), lekérdezést indítani (POST), portálüzenetet
// feldolgozottnak jelölni, bármit módosítani. A modul csak az alábbi listán szereplő címekre küld kérést, csak GET-tel;
// minden más útvonalra hibát dob. Élőben igazolva: 2026-11-13, a tulajdonos fiókjával (belépés és mind a hét olvasás).
// NEM igazolt élőben: a teljes adónaptár (`calendarFull`) olvasása és a tételek mezőnevei – a megfigyeléskor a lista üres volt.
'use strict';

const H = require('./tarhely-http');
const C = require('./nav-calendar');
const T = require('./nav-taxpayer-tables');

const HOST = 'ugyfelportal.nav.gov.hu';
const BASE = `https://${HOST}`;
const HOSTS = ['kau.gov.hu', 'idp.gov.hu', HOST]; // a tárhely nincs benne: ez a lánc oda nem mehet
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const PATHS = {
  user: '/api/v1/user/login/logged-user',
  profiles: '/api/v1/user/profil/adozoi-profil-page',
  account: '/api/v1/balance/tax-invoice/summary',
  future: '/api/v1/balance/tax-invoice/future-items',
  missing: '/api/v1/declaration/missing-returns',
  calendar: '/api/v1/calendar/tax-calendar/posts/preview',
  calendarFull: '/api/v1/calendar/tax-calendar/posts',
};
const PAGE = 20, MAX_PAGES = 50;
const CALENDAR_DAYS = 90; // ennyi napra előre kérjük a teljes adónaptárat
const realSleep = ms => new Promise(r => setTimeout(r, ms));

function assertNavPath(pathname) {
  if (!Object.values(PATHS).includes(pathname)) throw new Error('Nem engedélyezett NAV-útvonal, megállok.');
}

/** Belépés a NAV-portálra. A titkok csak a hívás alatt élnek; a visszaadott ctx csak a sütitárat hordozza. */
async function loginNav(creds, opts = {}) {
  const { jar } = await H.kauLogin(creds, { startUrl: `${BASE}/api/v1/user/login/start-kaulogin`, endHost: HOST, hosts: HOSTS, endName: 'a NAV-portálon' }, opts);
  return { jar, fetchImpl: opts.fetchImpl };
}

/** Egyetlen GET a megengedett címek egyikére. Átirányítást nem követ, újra nem próbálkozik. */
async function get(ctx, pathname, query = null) {
  assertNavPath(pathname);
  const u = new URL(BASE + pathname); for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, String(v));
  H.assertAllowed(u.toString(), [HOST]);
  const headers = { 'User-Agent': UA, 'Accept-Language': 'hu-HU,hu;q=0.9', Accept: 'application/json, text/plain, */*', Referer: `${BASE}/dashboard` };
  const cookie = ctx.jar.header(u.toString()); if (cookie) headers.Cookie = cookie;
  const res = await (ctx.fetchImpl || fetch)(u.toString(), { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
  ctx.jar.store(u.toString(), res.headers.getSetCookie ? res.headers.getSetCookie() : []);
  const text = await res.text();
  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) throw new Error('A NAV-portál munkamenete nem érvényes, vagy a munkamenet lejárt.');
  if (res.status !== 200) throw new Error(`A NAV-portál nem várt választ adott (HTTP ${res.status}).`);
  try { return JSON.parse(text); } catch { throw new Error('A NAV-portál válasza nem JSON; a munkamenet lejárt, vagy a felület megváltozott.'); }
}

const str = (v, n = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = v => (Array.isArray(v) ? v.length : null);

/** Egy képviselt adózó a listából: csak az ügyfél felismeréséhez kellő mezők. A személyes adatokat (születési adatok, anyja neve) nem visszük tovább. */
function toProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const stem = /^\d{8}$/.test(String(p.torzsszam || '')) ? String(p.torzsszam) : null;
  const taxId = /^8\d{9}$/.test(String(p.adoazonosito || '')) ? String(p.adoazonosito) : null;
  if (!stem && !taxId) return null;
  return { id: num(p.id), name: str(p.megnevezes), taxNumber: /^\d{8}-\d-\d{2}$/.test(String(p.adoszam || '')) ? p.adoszam : null, stem, taxId,
    kind: str(p.adozoiTipus, 40), state: str(p.allapotKod, 40), reliable: typeof p.megbizhatoJel === 'boolean' ? p.megbizhatoJel : null, legal: p.torvenyesKepviselet === true };
}

/** Kinek az adatait mutatja a munkamenet: a „kiválasztott” adózó, a bejelentkezett felhasználó válaszából. */
function subjectOf(u) {
  const sel = toProfile(u.kivalasztottAdozoiProfil) || toProfile(u.sajatAdozoiProfil);
  const ownId = num((u.sajatAdozoiProfil || {}).id);
  return sel ? { id: sel.id, name: sel.name, stem: sel.stem, taxId: sel.taxId, taxNumber: sel.taxNumber, kind: sel.kind, own: sel.id !== null && sel.id === ownId } : null;
}

const safeStep = (fn, info) => { if (fn) try { fn(info); } catch { /* a visszahívás hibája nem állíthatja meg a futást */ } };

/**
 * A munkamenet KIVÁLASZTOTT adózójának adatai: adószámla-összesítő, jövőbeli esedékességek, hiányzó bevallások, adónaptár.
 * Csak GET. A hívó felel azért, hogy a kiválasztott adózó az legyen, akire számít (lásd `subjectOf`).
 */
async function readSubjectData(ctx, { sleep = realSleep, random = Math.random, today = new Date(), onStep = null, prefix = '' } = {}) {
  const pause = () => sleep(Math.round(1000 + random() * 1000));
  safeStep(onStep, { phase: 'account', text: `${prefix}adószámla-egyenleg olvasása…` });
  await pause();
  const a = await get(ctx, PATHS.account);
  const account = { total: num(a.ugyfelOsszesen), debt: num(a.adozoiTartozas), surplus: num(a.adozoiTobblet), deposit: num(a.letetszamlaOsszesen), unbooked: num(a.konyveletlenOsszesen) };
  safeStep(onStep, { phase: 'future', text: `${prefix}jövőbeli esedékességek olvasása…` });
  await pause();
  const futureCount = count((await get(ctx, PATHS.future)).dates);
  safeStep(onStep, { phase: 'missing', text: `${prefix}hiányzó bevallások ellenőrzése…` });
  await pause();
  const m = await get(ctx, PATHS.missing);
  const missingCount = num(m.missingReturnsCount) ?? count(m.missingReturns);
  safeStep(onStep, { phase: 'calendarPreview', text: `${prefix}30 napos adónaptár-előnézet olvasása…` });
  await pause();
  const iso = d => d.toISOString().slice(0, 10);
  const preview = (await get(ctx, PATHS.calendar, { fromDate: iso(today), toDate: iso(new Date(today.getTime() + 30 * 86400000)), lang: 'hu' })).posts;
  let calendarCount = count(preview);

  // A teljes adónaptár tételesen. A hivatalos felület az Adónaptár oldal megnyitásakor ugyanezt a GET-et küldi
  // `refreshPosts` kapcsolóval: ettől a NAV a saját nyilvántartásából (újra)generálja a bevallási bejegyzéseket – akkor is,
  // ha az adózónak még nem volt adónaptára (megfigyelve 2026-11-13, képviselt társaságra váltva: üresből 3 tétel lett).
  // Ez nem nyilatkozat és nem bejelentés, csak a naptár tételeit hozza létre; értesítést nem kapcsol be (docs/adr/ADR-010).
  // Ha a portál ezt a kérést nem fogadja el, nem próbálkozunk újra: az előbb lekért előnézet tételeivel megyünk tovább.
  safeStep(onStep, { phase: 'calendarFull', text: `${prefix}90 napos adónaptár frissítése és kiolvasása…` });
  await pause();
  let posts = preview, source = 'preview';
  try {
    const full = (await get(ctx, PATHS.calendarFull, { fromDate: iso(today), toDate: iso(new Date(today.getTime() + CALENDAR_DAYS * 86400000)), lang: 'hu', refreshPosts: true })).posts;
    if (Array.isArray(full)) { posts = full; source = 'posts'; }
  } catch { source = 'preview'; }
  // Az előnézet (a következő 30 nap) generálatlan naptárnál üres; a frissen generált teljes listából számolunk.
  if (source === 'posts') { const lim = iso(new Date(today.getTime() + 30 * 86400000)); calendarCount = posts.filter(p => { const d = C.toIsoDate(p && (p.deadline ?? p.dueDate)); return d && d >= iso(today) && d <= lim; }).length; }
  const cal = C.calendarToObligations(posts, { today: iso(today) }), mis = C.missingToObligations(m.missingReturns);
  const obligations = [...mis.items, ...cal.items];
  const calendarInfo = { source, total: cal.total, unknown: cal.unknown, past: cal.past, keys: cal.keys, missingTotal: mis.total, missingUnknown: mis.unknown, missingKeys: mis.keys };
  return { account, missingCount, futureCount, calendarCount, obligations, calendarInfo };
}

/**
 * A belépő saját nevében olvasható adatok. Kérések között 1–2 mp szünet; a lista lapozva jön.
 * Hibát dob, ha a munkamenet lejár – csonka adatot nem ad vissza.
 * @returns {Promise<{ user: { name: ?string, taxId: ?string, sessionMinutes: ?number }, profiles: object[],
 *   account: ?{ total: ?number, debt: ?number, surplus: ?number, deposit: ?number, unbooked: ?number },
 *   missingCount: ?number, futureCount: ?number, calendarCount: ?number,
 *   subject: ?{ name: ?string, stem: ?string, taxId: ?string, taxNumber: ?string, own: boolean }, obligations: object[],
 *   calendarInfo: { source: string, total: number, unknown: number, past: number, keys: string[], missingTotal: number, missingUnknown: number, missingKeys: string[] } }>}
 */
async function readOwn(ctx, { sleep = realSleep, random = Math.random, today = new Date(), onStep = null } = {}) {
  const pause = () => sleep(Math.round(1000 + random() * 1000));
  safeStep(onStep, { phase: 'user', step: 1, total: 7, text: 'Bejelentkezett adózói profil lekérése…' });
  const u = await get(ctx, PATHS.user);
  const user = { name: str(u.nev), taxId: /^8\d{9}$/.test(String(u.adoazonositoJel || '')) ? String(u.adoazonositoJel) : null, sessionMinutes: Number(u.sessionLifeSpan) > 0 ? Number(u.sessionLifeSpan) : null };
  // Kinek az adatait mutatja a munkamenet: a „kiválasztott” adózó. Belépés után ez rendszerint maga a belépő, de a portál
  // megjegyezheti a korábbi választást – ezért nem feltételezzük, hanem kiolvassuk, és a tételeket ehhez az adózóhoz kötjük.
  const full = subjectOf(u); const subject = full ? { name: full.name, stem: full.stem, taxId: full.taxId, taxNumber: full.taxNumber, own: full.own } : null;
  user.profileId = num((u.sajatAdozoiProfil || {}).id);
  user.subjectProfileId = full ? full.id : user.profileId;
  user.subjectKind = full ? full.kind : str((u.sajatAdozoiProfil || {}).adozoiTipus, 40);

  const profiles = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page === 0) safeStep(onStep, { phase: 'profiles', step: 2, total: 7, text: 'Képviselt adózók listájának olvasása…' });
    await pause();
    const r = await get(ctx, PATHS.profiles, { megnevezes: '', page, size: PAGE });
    const batch = Array.isArray(r.content) ? r.content : [];
    profiles.push(...batch.map(toProfile).filter(Boolean));
    const tot = num(r.total) ?? 0;
    if (!batch.length || (page + 1) * PAGE >= tot) break;
    safeStep(onStep, { phase: 'profiles', step: 2, total: 7, text: `Képviselt adózók listájának olvasása (${profiles.length} / ${tot} adózó)…` });
  }

  const phaseIdx = { account: 3, future: 4, missing: 5, calendarPreview: 6, calendarFull: 7 };
  const { account, missingCount, futureCount, calendarCount, obligations, calendarInfo } = await readSubjectData(ctx, {
    sleep, random, today,
    onStep: info => safeStep(onStep, { ...info, step: phaseIdx[info.phase] || 5, total: 7, text: info.text.charAt(0).toUpperCase() + info.text.slice(1) }),
  });
  return { user, profiles, account, missingCount, futureCount, calendarCount, subject, obligations, calendarInfo };
}

// ---------------------------------------------------------------- C kör: beadott bevallások lekérdezése (docs/adr/ADR-010)
// Olvasó lekérdezés, de POST-tal megy, és a NAV oldalán lekérdezést hoz létre – ezért csak a hívó kifejezett kérésére
// fut (`queries: true`). A kérés törzse a megfigyelt alak: minden szűrő üres, csak az adózó azonosítója és a nyelv megy.
// ÉLŐBEN NEM IGAZOLT a program által küldve.
const RETURNS = '/api/bevallas-lekerdezes';

/** „2026.01.01 - 2026.03.31” → ['2026-01-01', '2026-03-31']; ismeretlen alaknál [null, null]. */
function parsePeriod(v) {
  const m = /^\s*(\d{4})\.(\d{2})\.(\d{2})\.?\s*-\s*(\d{4})\.(\d{2})\.(\d{2})\.?\s*$/.exec(String(v || ''));
  return m ? [`${m[1]}-${m[2]}-${m[3]}`, `${m[4]}-${m[5]}-${m[6]}`] : [null, null];
}

/** Egy beadott bevallás a NAV válaszából: csak a párosításhoz és a megjelenítéshez kellő mezők. Iktatószám nélkül kihagyjuk. */
function toReturn(b) {
  if (!b || typeof b !== 'object') return null;
  const regNo = /^\d{6,20}$/.test(String(b.iktatoSzam || '')) ? String(b.iktatoSzam) : null;
  const formCode = /^[0-9A-Za-z][0-9A-Za-z_-]{0,31}$/.test(String(b.bevallasSzama || '')) ? String(b.bevallasSzama) : null;
  if (!regNo || !formCode) return null;
  const [periodStart, periodEnd] = parsePeriod(b.bevallasIdoszak);
  const at = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(b.benyujtasIdopontja || ''));
  return { regNo, formCode, title: str((b.urlapTipusDto || {}).urlaptipusNev), periodStart, periodEnd, submittedAt: at ? `${at[1]} ${at[2]}` : null, state: str(b.bevallasNyomtatvanyAllapota, 60), kind: str(b.funckio, 40) };
}

/**
 * A megadott adózó beadott bevallásai. `id`: az adószám törzse (8 jegy) vagy az adóazonosító jel (10 jegy) – a hívó felel
 * azért, hogy ez a munkamenet KIVÁLASZTOTT adózója legyen. Újra nem próbálkozik.
 */
async function readReturns(ctx, id) {
  if (!/^(\d{8}|8\d{9})$/.test(String(id || ''))) throw new Error('Érvénytelen adózó-azonosító a bevallás-lekérdezéshez.');
  const url = BASE + RETURNS; H.assertAllowed(url, [HOST]);
  const headers = { 'User-Agent': UA, 'Accept-Language': 'hu-HU,hu;q=0.9', Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Origin: BASE, Referer: `${BASE}/dashboard` };
  const cookie = ctx.jar.header(url); if (cookie) headers.Cookie = cookie;
  const xsrf = ctx.jar.get(url, 'XSRF-TOKEN'); if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);
  const body = { keletkezesDatumKezdete: null, keletkezesDatumVege: null, bevallasIdoszakKezdete: null, bevallasIdoszakVege: null, iktatoSzam: null, bevallasSzama: null, funkcio: null, jogelodAdozo: null, bevallasGarnitura: null, adoszam: String(id), nyelv: 'hu' };
  const res = await (ctx.fetchImpl || fetch)(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(60000) });
  ctx.jar.store(url, res.headers.getSetCookie ? res.headers.getSetCookie() : []);
  const text = await res.text();
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) throw new Error('A NAV-portál munkamenete nem érvényes, vagy a munkamenet lejárt.');
  if (res.status !== 200) throw new Error(`A NAV-portál a bevallás-lekérdezést nem fogadta el (HTTP ${res.status}).`);
  let j; try { j = JSON.parse(text); } catch { throw new Error('A bevallás-lekérdezés válasza nem JSON.'); }
  const rows = Array.isArray(j && j.bevallasok) ? j.bevallasok : [];
  const items = rows.map(toReturn).filter(Boolean);
  return { items: items.slice(0, 500), total: rows.length, unknown: rows.length - items.length };
}

// ---------------------------------------------------------------- C kör: NAV-dokumentumok lekérdezése (docs/adr/ADR-010)
// `POST /api/dokumentumok`, a megfigyelt törzzsel. A „beküldés iránya” (`befogadasAllapota`) értékkészlete a portál nyilvános
// felületkódjából: BEFOGADOTT, BEKULDOTT_NEM_BEFOGADOTT, FOGADOTT, MINDEN_IRANY – a forgalomban csak a BEFOGADOTT látszott.
// Időablak: a portál alapértéke, az elmúlt fél év (érkezés és letöltés szerint is). A dátum a nap eleje, hat tizedes
// másodperccel; a záró dátum a következő nap eleje (a portál `napigDtoKovNapKezdete` mezője így működik).
const DOCUMENTS = '/api/dokumentumok';
const DOC_DIRECTIONS = ['BEFOGADOTT', 'BEKULDOTT_NEM_BEFOGADOTT', 'FOGADOTT', 'MINDEN_IRANY'];

const dayStart = d => `${d.toISOString().slice(0, 10)}T00:00:00.000000`;

/** Egy NAV-dokumentum a válaszból: csak a megjelenítéshez és az összekötéshez kellő mezők; tokent és személyes adatot nem viszünk tovább. */
function toDocument(x) {
  if (!x || typeof x !== 'object') return null;
  const barcode = /^\d{6,20}$/.test(String(x.barkod || '')) ? String(x.barkod) : null;
  const regNo = /^[0-9A-Za-z/_-]{4,40}$/.test(String(x.iktatoszam || '')) ? String(x.iktatoszam) : null;
  if (!barcode && !regNo) return null;
  const ts = v => { const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(v || '')); return m ? `${m[1]} ${m[2]}` : null; };
  const files = Array.isArray(x.altalanosElektronikusTartalom) ? x.altalanosElektronikusTartalom.length : 0;
  return { barcode, regNo, subject: str(x.szovegesTargy, 300), docType: str(x.irattipusKod, 20), formCode: str(x.urlapTipus, 32), formName: str((x.urlapTipusDto || {}).urlaptipusNev),
    caseType: str(x.ugytipus, 200), caseNo: str(x.ugyszam, 40), krNo: str(x.krErkeztetesiSzam, 60), submittedAt: ts(x.benyujtasIdopontja), arrivedAt: ts(x.erkezesDatum), downloadedAt: ts(x.letoltesiIdo), files };
}

/** A kiválasztott adózó NAV-dokumentumai az elmúlt fél évből. A hívó felel azért, hogy `id` a kiválasztott adózó legyen. */
async function readDocuments(ctx, id, { direction = 'MINDEN_IRANY', today = new Date(), months = 6 } = {}) {
  if (!/^(\d{8}|8\d{9})$/.test(String(id || ''))) throw new Error('Érvénytelen adózó-azonosító a dokumentum-lekérdezéshez.');
  if (!DOC_DIRECTIONS.includes(direction)) throw new Error('Ismeretlen beküldési irány.');
  const from = new Date(today); from.setMonth(from.getMonth() - months); const to = new Date(today.getTime() + 86400000);
  const range = { naptol: { naptolDtoNapKezdete: dayStart(from) }, napig: { napigDtoKovNapKezdete: dayStart(to) } };
  const body = { befogadasAllapota: direction, letoltesiIdoKezdete: range.naptol, letoltesiIdoVege: range.napig, keletkezesiIdoKezdete: range.naptol, keletkezesiIdoVege: range.napig,
    krerkeztetesiSzam: null, barkod: null, ugyTipusKod: null, urlapTipus: null, iratTargya: null, nyelv: 'HU', ugyszam: null, akutalisAdozo: String(id) };
  const url = BASE + DOCUMENTS; H.assertAllowed(url, [HOST]);
  const headers = { 'User-Agent': UA, 'Accept-Language': 'hu-HU,hu;q=0.9', Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Origin: BASE, Referer: `${BASE}/dashboard` };
  const cookie = ctx.jar.header(url); if (cookie) headers.Cookie = cookie;
  const xsrf = ctx.jar.get(url, 'XSRF-TOKEN'); if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);
  const res = await (ctx.fetchImpl || fetch)(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(60000) });
  ctx.jar.store(url, res.headers.getSetCookie ? res.headers.getSetCookie() : []);
  const text = await res.text();
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) throw new Error('A NAV-portál munkamenete nem érvényes, vagy a munkamenet lejárt.');
  if (res.status !== 200) throw new Error(`A NAV-portál a dokumentum-lekérdezést nem fogadta el (HTTP ${res.status}).`);
  let j; try { j = JSON.parse(text); } catch { throw new Error('A dokumentum-lekérdezés válasza nem JSON.'); }
  const rows = Array.isArray(j) ? j : [];
  const items = rows.map(toDocument).filter(Boolean);
  return { items: items.slice(0, 500), total: rows.length, unknown: rows.length - items.length };
}

/** A NAV-dokumentumok a többi adat mellé; a hiba nem dobja el a már kiolvasott adatot. */
async function withDocuments(ctx, id, data, { sleep = realSleep, random = Math.random, today = new Date(), onStep = null, prefix = '' } = {}) {
  safeStep(onStep, { phase: 'documents', text: `${prefix}NAV-dokumentumok lekérdezése (elmúlt fél év)…` });
  await sleep(Math.round(1000 + random() * 1000));
  try { const r = await readDocuments(ctx, id, { today }); return { ...data, documents: r.items, documentsInfo: { total: r.total, unknown: r.unknown } }; }
  catch (e) { if (/munkamenet/.test(String(e && e.message))) throw e; return { ...data, documents: null, documentsInfo: { error: String((e && e.message) || e).slice(0, 160) } }; }
}

/** A beadott bevallások a többi adat mellé: hiba esetén nem dobja el a már kiolvasott adatot, csak megjegyzi az okot. */
async function withReturns(ctx, id, data, { sleep = realSleep, random = Math.random, onStep = null, prefix = '' } = {}) {
  safeStep(onStep, { phase: 'returns', text: `${prefix}beadott bevallások lekérdezése…` });
  await sleep(Math.round(1000 + random() * 1000));
  try { const r = await readReturns(ctx, id); return { ...data, returns: r.items, returnsInfo: { total: r.total, unknown: r.unknown } }; }
  catch (e) { if (/munkamenet/.test(String(e && e.message))) throw e; return { ...data, returns: null, returnsInfo: { error: String((e && e.message) || e).slice(0, 160) } }; }
}

// ---------------------------------------------------------------- B kör: képviselet-váltás (docs/adr/ADR-010)
// Az EGYETLEN módosító kérés, amelyet a modul a NAV felé küldhet: a munkamenet kiválasztott adózójának átállítása
// (`PUT …/change-kepviselet`, törzs: `adozoiProfilId`). A NAV-nál tárolt adatot nem ír át, de a munkamenet állapotát igen,
// ezért csak a hívó kifejezett kérésére fut (`readClients`), és a futás végén MINDIG visszavált a belépő saját profiljára.
// ÉLŐBEN NEM IGAZOLT a program által küldve: a kérést csak a hivatalos felület forgalmában figyeltük meg (fejlécek nélkül).
const SWITCH = '/api/v1/user/login/change-kepviselet';
const MAX_CLIENTS = 15;

async function switchTo(ctx, profileId) {
  if (!Number.isInteger(profileId) || profileId <= 0) throw new Error('Érvénytelen adózói profil.');
  const url = BASE + SWITCH; H.assertAllowed(url, [HOST]);
  const headers = { 'User-Agent': UA, 'Accept-Language': 'hu-HU,hu;q=0.9', Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Origin: BASE, Referer: `${BASE}/dashboard` };
  const cookie = ctx.jar.header(url); if (cookie) headers.Cookie = cookie;
  const xsrf = ctx.jar.get(url, 'XSRF-TOKEN'); if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);
  const res = await (ctx.fetchImpl || fetch)(url, { method: 'PUT', headers, body: JSON.stringify({ adozoiProfilId: profileId }), redirect: 'manual', signal: AbortSignal.timeout(30000) });
  ctx.jar.store(url, res.headers.getSetCookie ? res.headers.getSetCookie() : []);
  await res.text();
  // 401 vagy átirányítás: a munkamenet nem él. A 403 itt a váltás elutasítása is lehet (nincs képviseleti jog) – az csak
  // erre az adózóra vonatkozik; ha valójában a munkamenet járt le, a következő olvasás úgyis megáll rajta.
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) throw new Error('A NAV-portál munkamenete nem érvényes, vagy a munkamenet lejárt.');
  if (res.status !== 200) throw new Error(`A NAV-portál a képviselet-váltást nem fogadta el (HTTP ${res.status}).`);
}

/**
 * A megadott képviselt adózók adatai, egyenként: váltás → ellenőrzés (a NAV szerint tényleg ő a kiválasztott) → olvasás.
 * A végén – hiba esetén is – visszavált a belépő saját profiljára, és ellenőrzi. `restored: false` azt jelenti, hogy a
 * visszaváltás nem sikerült vagy nem volt ellenőrizhető: ilyenkor a hívónak szólnia kell a felhasználónak.
 * Egy adózó hibája nem állítja meg a többit; a lejárt munkamenet igen.
 * @param ownId a belépő saját adózói profiljának azonosítója (readOwn: user.profileId)
 * @param targets a readOwn `profiles` listájának elemei (id, stem, taxId, name)
 */
async function readClients(ctx, ownId, targets, { sleep = realSleep, random = Math.random, today = new Date(), max = MAX_CLIENTS, queries = false, onStep = null } = {}) {
  if (!Number.isInteger(ownId) || ownId <= 0) throw new Error('A saját adózói profil nem ismert; képviseletet nem váltok.');
  const pause = () => sleep(Math.round(1000 + random() * 1000));
  const list = (Array.isArray(targets) ? targets : []).filter(t => t && Number.isInteger(t.id) && t.id > 0 && t.id !== ownId && (t.stem || t.taxId));
  const todo = list.slice(0, Math.max(0, max)); const clients = []; let fatal = null, switched = false;
  try {
    for (let ci = 0; ci < todo.length; ci++) {
      const t = todo[ci];
      const row = { profileId: t.id, name: t.name || null, stem: t.stem || null, taxId: t.taxId || null };
      const who = (t.name || t.stem || t.taxId || 'adózó').slice(0, 60);
      const pfx = `Ügyfél (${ci + 1} / ${todo.length}) · ${who}: `;
      try {
        safeStep(onStep, { phase: 'switch', index: ci, count: todo.length, sub: 0, text: `${pfx}képviselet átváltása…` });
        await pause();
        switched = true; await switchTo(ctx, t.id);
        await pause();
        const now = subjectOf(await get(ctx, PATHS.user));
        // A váltás csak akkor számít, ha a NAV maga is ezt az adózót mutatja kiválasztottnak, és az azonosítója egyezik.
        if (!now || now.id !== t.id || (t.stem && now.stem !== t.stem) || (!t.stem && now.taxId !== t.taxId)) { clients.push({ ...row, ok: false, error: 'A NAV a váltás után nem ezt az adózót mutatta kiválasztottnak; az adatait nem olvastam ki.' }); continue; }
        let data = await readSubjectData(ctx, { sleep, random, today, prefix: pfx, onStep: info => safeStep(onStep, { ...info, index: ci, count: todo.length, sub: 1 }) });
        if (queries) {
          data = await withReturns(ctx, t.stem || t.taxId, data, { sleep, random, prefix: pfx, onStep: info => safeStep(onStep, { ...info, index: ci, count: todo.length, sub: 2 }) });
          data = await withDocuments(ctx, t.stem || t.taxId, data, { sleep, random, today, prefix: pfx, onStep: info => safeStep(onStep, { ...info, index: ci, count: todo.length, sub: 3 }) });
          data = await T.withTaxpayerTables(ctx, t.id, data, { kind: now.kind || t.kind || null, today, sleep, random, onStep: lbl => safeStep(onStep, { phase: 'tables', index: ci, count: todo.length, sub: 4, text: `${pfx}adózói táblák – ${lbl}…` }) });
        }
        clients.push({ ...row, ok: true, ...data });
      } catch (e) {
        if (/munkamenet/.test(String(e && e.message))) throw e;
        clients.push({ ...row, ok: false, error: String((e && e.message) || e).slice(0, 200) });
      }
    }
  } catch (e) { fatal = String((e && e.message) || e).slice(0, 200); }
  // Visszaváltás a saját profilra – akkor is, ha közben hiba volt. Ha a munkamenet lejárt, nincs mit visszaállítani.
  let restored = !switched;
  if (switched) {
    safeStep(onStep, { phase: 'restore', index: todo.length, count: todo.length, sub: 0, text: 'Visszaváltás a saját adózói profilra…' });
    try { await pause(); await switchTo(ctx, ownId); await pause(); const now = subjectOf(await get(ctx, PATHS.user)); restored = !!now && now.id === ownId; }
    catch { restored = false; }
  }
  return { clients, restored, skipped: list.length - todo.length, error: fatal };
}

/** Egy képviselt adózó a NAV listájából (lapozva), adószám-törzs vagy adóazonosító jel szerint. Ha nincs a listán: null. */
async function findProfile(ctx, id, { sleep = realSleep, random = Math.random } = {}) {
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page) await sleep(Math.round(1000 + random() * 1000));
    const r = await get(ctx, PATHS.profiles, { megnevezes: '', page, size: PAGE });
    const batch = (Array.isArray(r.content) ? r.content : []).map(toProfile).filter(Boolean);
    const hit = batch.find(p => p.stem === id || (!p.stem && p.taxId === id)); if (hit) return hit;
    if (!batch.length || (page + 1) * PAGE >= (num(r.total) ?? 0)) return null;
  }
  return null;
}

module.exports = { get, findProfile, loginNav, readOwn, readSubjectData, readClients, readReturns, withReturns, toReturn, parsePeriod, readDocuments, withDocuments, toDocument, DOCUMENTS, DOC_DIRECTIONS, readTaxpayerTables: T.readTaxpayerTables, withTaxpayerTables: T.withTaxpayerTables, switchTo, subjectOf, RETURNS, toProfile, assertNavPath, HOST, HOSTS, PATHS, SWITCH, MAX_CLIENTS };
