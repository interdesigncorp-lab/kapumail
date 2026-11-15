// E-Önkormányzat Portál (ASP) – olvasás böngésző nélkül (10. fázis, „A kör”; docs/adr/ADR-011).
//
// Mit tud: belép a KAÜ-lánccal (ugyanaz az Ügyfélkapu+ kódos út, mint a tárhelynél és a NAV-portálnál), és abban a
// szerepkörben, amelyet a munkamenet a belépéskor mutat, kiolvassa azt, ami egyszerű GET kéréssel elérhető: a
// felhasználót és a saját önkormányzatait, majd önkormányzatonként az adószámla-kivonatot (PDF), a benyújtott
// adóbevallások listáját és a folyamatban lévő ügyeket.
//
// Az önkormányzatot a portál egy olvasó kéréssel választja ki (`GET /api/public/tenant-services/<azonosító>`): ez a
// MUNKAMENET kiválasztott önkormányzatát állítja át, mást nem. Az alapértelmezett önkormányzathoz és a kedvencek
// listájához a program nem nyúl. Csak a felhasználó saját listáján szereplő önkormányzat választható.
//
// Mit NEM tud, szándékosan: szerepkört váltani (módosító kérés, robotszűrő védi), ügyet indítani, űrlapot beküldeni,
// fizetni, a kedvenceket vagy az alapértelmezett önkormányzatot módosítani, a felület használati naplóját (`…/ssb/…`) és
// a munkamenet-hosszabbítót (`keepalive`) hívni. A modul csak az alábbi mintákra illő címekre küld kérést, csak GET-tel.
//
// ÉLŐBEN NEM IGAZOLT: a belépés Ügyfélkapu+ kóddal ezen a portálon, és az, hogy a használati napló hívásai nélkül a
// szerver kiszolgálja-e az olvasásokat. Az útvonalak a megfigyelésből (2026-11-13) és a portál nyilvános kódjából valók.
'use strict';

const H = require('./tarhely-http');

const HOST = 'ohp-20.asp.lgov.hu';
const BASE = `https://${HOST}`;
const HOSTS = ['kau.gov.hu', 'idp.gov.hu', HOST]; // a tárhely és a NAV nincs benne: ez a lánc oda nem mehet
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const UID = '[A-Za-z0-9-]{1,64}';
const PATHS = [
  /^\/api\/public\/userdetails$/,
  /^\/api\/public\/service-permissions$/,
  new RegExp(`^/api/public/tenant-services/${UID}$`),
  /^\/api\/tax\/(SIMPLE|DETAILED)\/20\d\d$/,
  /^\/api\/tax-returns$/,
  /^\/api\/cases\/folyamatban$/,
];
const realSleep = ms => new Promise(r => setTimeout(r, ms));

function assertAspPath(pathname) {
  if (!PATHS.some(re => re.test(String(pathname)))) throw new Error('Nem engedélyezett ASP-útvonal, megállok.');
}

/** Belépés a portálra. A portál a belépés végén sima http-s címre irányít; a lánc ezt https-en követi. */
async function loginAsp(creds, opts = {}) {
  const { jar } = await H.kauLogin(creds, { startUrl: `${BASE}/login`, endHost: HOST, hosts: HOSTS, endName: 'az önkormányzati portálon', upgradeInsecure: true }, opts);
  return { jar, fetchImpl: opts.fetchImpl };
}

/** Egyetlen GET a megengedett címek egyikére. Átirányítást nem követ, újra nem próbálkozik. A portál `{ body, length }` borítékát lefejti. */
async function get(ctx, pathname) {
  assertAspPath(pathname);
  const url = BASE + pathname;
  H.assertAllowed(url, [HOST]);
  // Ablakos mód (`ctx.browser`): a kérés a belépőablak saját munkamenetéből megy, a böngésző a saját fejléceivel és sütijeivel küldi.
  const headers = ctx.browser ? { Accept: 'application/json, text/plain, */*' } : { 'User-Agent': UA, 'Accept-Language': 'hu-HU,hu;q=0.9', Accept: 'application/json, text/plain, */*', Referer: `${BASE}/szolgaltatasok` };
  const cookie = ctx.browser ? '' : ctx.jar.header(url); if (cookie) headers.Cookie = cookie;
  const res = await (ctx.fetchImpl || fetch)(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(60000) });
  if (!ctx.browser) ctx.jar.store(url, res.headers.getSetCookie ? res.headers.getSetCookie() : []);
  const text = await res.text();
  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) throw new Error('Az önkormányzati portál munkamenete nem érvényes, vagy a munkamenet lejárt.');
  if (res.status !== 200) throw new Error(`Az önkormányzati portál nem várt választ adott (HTTP ${res.status}).`);
  let j; try { j = JSON.parse(text); } catch { throw new Error('Az önkormányzati portál válasza nem JSON; a munkamenet lejárt, vagy a felület megváltozott.'); }
  return j && typeof j === 'object' && !Array.isArray(j) && 'body' in j ? j.body : j;
}

const str = (v, n = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Egy önkormányzat a felhasználó listájából. */
function toTenant(t) {
  if (!t || typeof t !== 'object' || !new RegExp(`^${UID}$`).test(String(t.uid || ''))) return null;
  return { uid: String(t.uid), name: str(t.name), city: str(t.cityName), pir: str(t.pir, 20), code: str(t.code, 20) };
}

// A portál szerepkörei (a felület nyilvános kódjából) és a felületen látható nevük.
const ROLES = {
  SAJAT_NEVEN_TERMESZETES_SZEMELY: 'Saját néven (magánszemélyként)', CEG_NEVEBEN: 'Cég nevében', SAJAT_NEVEN_EGYENI_VALLALKOZO: 'Saját néven (egyéni vállalkozóként)',
  EGYENI_VALLALKOZO_NEVEBEN: 'Egyéni vállalkozó nevében', MAS_TERMESZETES_SZEMELY_NEVEBEN: 'Más természetes személy nevében',
  HKP_TARHELLYEL_RENDELKEZO_INTEZMENY_NEVEBEN: 'Hivatali Kapu tárhellyel rendelkező intézmény nevében', CEG_NEVEBEN_ELJARVA_MASIK_CEG_KEPVISELETEBEN: 'Cég nevében eljárva másik cég képviseletében',
};

/**
 * Kinek az adatait mutatja a munkamenet: a szerepkör és az azonosító, amelyhez a beolvasott adat köthető.
 * Saját néven a belépő adóazonosító jele; más szerepkörben a szerepkör adataiban talált adószám törzsszáma (8 jegy) vagy
 * – más természetes személynél – az adóazonosító jel. A szerepkör-adatok pontos alakját csak az egyéni vállalkozónál
 * láttuk élőben, ezért az azonosítót alak szerint keressük; ha nem egyértelmű (nincs, vagy több különböző van), `id` null.
 * @returns {{ role: ?string, label: string, own: boolean, id: ?string }}
 */
function subjectOf(u) {
  const rd = u && typeof u.roleDetails === 'object' && u.roleDetails ? u.roleDetails : {};
  const role = str(rd.szerepkor, 80);
  const self = /^8\d{9}$/.test(String((u && u.adoazonosito) || '')) ? String(u.adoazonosito) : null;
  const label = ROLES[role] || 'Ismeretlen szerepkör';
  if (role === 'SAJAT_NEVEN_TERMESZETES_SZEMELY') return { role, label, own: true, id: self };
  const stems = new Set(), persons = new Set();
  const walk = (v, depth, key = '') => {
    if (depth > 6 || v == null) return;
    if (typeof v === 'string') { const t = v.trim(); let m; if ((m = /^(\d{8})-?\d-?\d{2}$/.exec(t))) stems.add(m[1]); else if (/^8\d{9}$/.test(t) && t !== self) persons.add(t); else if (/^\d{8}$/.test(t) && /adoszam|torzsszam/i.test(key)) stems.add(t); }
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k !== 'adoazonosito' || depth > 0) walk(x, depth + 1, k); }
  };
  walk(rd, 0);
  const id = stems.size === 1 ? [...stems][0] : stems.size === 0 && persons.size === 1 ? [...persons][0] : null;
  return { role, label, own: false, id };
}

/** A szerepkör-adatok SZERKEZETE naplózáshoz: mezőnevek és az értékek alakja (betű → a, szám → 9); érték nem kerül bele. */
function roleShape(u) {
  const sh = (v, d) => (v === null ? null : typeof v === 'string' ? v.slice(0, 20).replace(/\p{L}/gu, 'a').replace(/\d/g, '9') : typeof v !== 'object' ? typeof v : d > 5 ? '…' : Array.isArray(v) ? v.slice(0, 3).map(x => sh(x, d + 1)) : Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [k.slice(0, 40), k === 'szerepkor' ? x : sh(x, d + 1)])));
  try { return JSON.stringify(sh((u && u.roleDetails) || null, 0)); } catch { return '(nem olvasható)'; }
}

/** A PDF a válaszban base64 szöveg; csak akkor fogadjuk el, ha tényleg PDF-nek indul. */
function toPdf(v) {
  if (typeof v !== 'string' || !v) return null;
  const buf = Buffer.from(v, 'base64');
  return buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-' ? buf : null;
}

const toReturn = r => (r && typeof r === 'object' ? { taxCode: str(r.taxCategoryCode, 20), taxName: str(r.taxCategoryName), subjectId: str(r.taxSubjectId, 60), returnId: num(r.taxReturnId), fileName: str(r.fileName), comments: str(r.comments, 500) } : null);

/**
 * A munkamenet aktuális szerepkörében olvasható adatok, önkormányzatonként. Kérések között 1–2 mp szünet.
 * Hibát dob, ha a munkamenet lejár – csonka adatot nem ad vissza. Egy önkormányzat hibás válasza (például nincs ott
 * nyilvántartva a felhasználó) nem állítja meg a többit: az adott tétel `null` marad, a hiba oka a `notes`-ba kerül.
 * @returns {Promise<{ user: { name: ?string, taxId: ?string, role: ?string }, subject: { role: ?string, label: string, own: boolean, id: ?string }, permissions: object,
 *   tenants: Array<{ uid: string, name: ?string, city: ?string, pir: ?string, code: ?string, isDefault: boolean,
 *     balance: ?{ pdf: Buffer, status: ?string, year: number, kind: string }, returns: ?object[], cases: ?number, notes: string[] }>, skipped: number }>}
 */
async function readOwn(ctx, { sleep = realSleep, random = Math.random, today = new Date(), maxTenants = 10, kind = 'DETAILED' } = {}) {
  const pause = () => sleep(Math.round(1000 + random() * 1000));
  const u = await get(ctx, '/api/public/userdetails');
  if (!u || typeof u !== 'object') throw new Error('Az önkormányzati portál nem adott felhasználói adatot; a munkamenet valószínűleg nem él.');
  const role = u.roleDetails && typeof u.roleDetails === 'object' ? u.roleDetails : {};
  const user = { name: str(u.name), taxId: /^8\d{9}$/.test(String(u.adoazonosito || '')) ? String(u.adoazonosito) : null, role: str(role.szerepkor, 80) };
  const subject = subjectOf(u);
  const def = toTenant(u.defaultTenant);
  const all = (Array.isArray(u.favouriteTenants) ? u.favouriteTenants : []).map(toTenant).filter(Boolean);
  if (def && !all.some(t => t.uid === def.uid)) all.unshift(def);
  const list = all.slice(0, Math.max(0, maxTenants));
  await pause();
  const p = await get(ctx, '/api/public/service-permissions');
  const permissions = p && typeof p === 'object' ? Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === 'boolean')) : {};
  const year = today.getFullYear(); const taxKind = kind === 'SIMPLE' ? 'SIMPLE' : 'DETAILED';
  const tenants = [];
  for (const t of list) {
    const row = { ...t, isDefault: !!def && def.uid === t.uid, balance: null, returns: null, cases: null, notes: [] };
    // A soft hibák (nincs adat, a szolgáltatás ott nem él) nem állítják meg a futást; a lejárt munkamenet igen.
    const soft = async (what, fn) => { await pause(); try { return await fn(); } catch (e) { if (/munkamenet/.test(e.message)) throw e; row.notes.push(`${what}: ${String(e.message).slice(0, 120)}`); return null; } };
    await pause();
    await get(ctx, `/api/public/tenant-services/${t.uid}`); // ez választja ki az önkormányzatot a munkamenetben
    if (permissions.adoegyenleg !== false) {
      const b = await soft('adóegyenleg', () => get(ctx, `/api/tax/${taxKind}/${year}`));
      const pdf = b ? toPdf(b.taxPdf) : null;
      if (b && !pdf) row.notes.push(`adóegyenleg: nincs kivonat (${str(b.status, 40) || 'ismeretlen állapot'})`);
      if (pdf) row.balance = { pdf, status: str(b.status, 40), year, kind: taxKind };
    }
    if (permissions.adobevallas !== false) {
      const r = await soft('adóbevallások', () => get(ctx, '/api/tax-returns'));
      if (r && Array.isArray(r.items)) row.returns = r.items.map(toReturn).filter(Boolean);
      else if (r) row.notes.push(`adóbevallások: nincs lista (${str(r.status, 40) || 'ismeretlen állapot'})`);
    }
    if (permissions.ugykovetes !== false) {
      const c = await soft('ügykövetés', () => get(ctx, '/api/cases/folyamatban'));
      if (Array.isArray(c)) row.cases = c.length;
    }
    tenants.push(row);
  }
  return { user, subject, permissions, tenants, skipped: all.length - list.length };
}

module.exports = { loginAsp, readOwn, get, toTenant, toPdf, subjectOf, roleShape, assertAspPath, HOST, HOSTS, BASE, ROLES };
