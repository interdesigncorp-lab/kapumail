// NAV ügyfélportál – az adónaptár és a hiányzó bevallások tételeinek átalakítása kötelezettséggé (7. fázis, ADR-010).
//
// FONTOS: a megfigyeléskor (2026-11-13) mindkét lista ÜRES volt, ezért a tételek mezőnevei NEM ismertek. Ez a modul
// ezért védekező: több lehetséges mezőnévből olvas, és amit nem tud biztosan értelmezni (nincs felismerhető dátum),
// azt eldobja és megszámolja – határidőt soha nem talál ki. A hívó a `keys` listából (mezőnevek, érték nélkül) látja,
// milyen alakot adott az élő portál; az első élő válasz után a jelöltlisták szűkíthetők (docs/ALLAPOT.md).
'use strict';

const DATE_KEYS = ['dueDate', 'deadline', 'deadlineDate', 'hatarido', 'esedekesseg', 'benyujtasiHatarido', 'date', 'postDate', 'eventDate', 'day', 'datum', 'startDate', 'start', 'fromDate'];
const TITLE_KEYS = ['title', 'name', 'megnevezes', 'subject', 'summary', 'description', 'leiras', 'text', 'content', 'label', 'nev'];
const CODE_KEYS = ['declarationNumber', 'formCode', 'nyomtatvanyKod', 'nyomtatvanyAzonosito', 'bevallasKod', 'bevallasTipus', 'returnCode', 'returnType', 'declarationCode', 'declarationType', 'nyomtatvany', 'form'];
const TAXTYPE_KEYS = ['taxTypeIdentifier', 'taxTypeCode', 'adonemKod', 'adonem', 'taxType', 'taxTypes'];
const START_KEYS = ['periodStart', 'periodFrom', 'idoszakKezdete', 'idoszakTol', 'intervalStart'];
const END_KEYS = ['periodEnd', 'periodTo', 'idoszakVege', 'idoszakIg', 'intervalEnd'];
const DONE_KEYS = ['submitted', 'completed', 'done', 'teljesitett', 'beadva', 'benyujtva'];
const MAX_ITEMS = 1000;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const two = n => String(n).padStart(2, '0');

/** Dátum ISO alakban (ÉÉÉÉ-HH-NN), vagy null. Ismeri a szöveges, a pontozott magyar, az ezredmásodperces és a [év, hó, nap] alakot. */
function toIsoDate(v) {
  let y, m, d;
  // Időponttal és időzónával (például „2026-11-11T23:00:00Z”): a magyar naptári nap számít, nem az UTC-é.
  if (typeof v === 'string' && /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})\s*$/.test(v)) {
    const t = new Date(v.trim());
    if (!Number.isNaN(t.getTime())) v = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
  }
  if (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(Number.isInteger)) [y, m, d] = v;
  else if (typeof v === 'string') {
    const hit = /^\s*(\d{4})[-./]\s?(\d{1,2})[-./]\s?(\d{1,2})(?!\d)/.exec(v);
    if (!hit) return null;
    [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  } else if (typeof v === 'number' && Number.isFinite(v) && v > 1e12 && v < 4e12) {
    const t = new Date(v); [y, m, d] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  } else return null;
  if (y < 2015 || y > 2040 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1) return null; // például február 30.
  return `${y}-${two(m)}-${two(d)}`;
}

const clean = (v, n) => (typeof v === 'string' ? v.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '');
function pick(o, keys, fn) { for (const k of keys) { const r = fn(o[k]); if (r) return r; } return null; }
const text = (o, keys, n = 200) => pick(o, keys, v => clean(v, n) || (isObj(v) ? clean(v.name || v.megnevezes || v.title, n) : ''));

/** Nyomtatványkód a kifejezett mezőből, különben a címből. Évszámot (2026) nem néz nyomtatványnak. */
function formCodeOf(o, title) {
  const ok = s => /^[0-9A-Z][0-9A-Z_-]{1,19}$/.test(s) && !/^(19|20)\d{2}$/.test(s);
  const direct = pick(o, CODE_KEYS, v => { const s = clean(isObj(v) ? (v.code || v.kod || v.identifier) : v, 32).toUpperCase(); return ok(s) ? s : null; });
  if (direct) return direct;
  for (const hit of String(title || '').toUpperCase().matchAll(/(?<![0-9A-ZÁÉÍÓÖŐÚÜŰ])(2[1-9](?:\d{2}|[A-Z]{1,4}\d{0,4})[A-Z]?|T\d{3,4}[A-Z]?)(?![0-9A-ZÁÉÍÓÖŐÚÜŰ])/g)) if (ok(hit[1]) && /\d/.test(hit[1])) return hit[1];
  return null;
}

/** Adónemkód (a megfigyelt `tax-types` lista szerint legfeljebb háromjegyű azonosító), ha a tétel hordoz ilyet. */
function taxTypeOf(o) {
  const one = v => { const s = isObj(v) ? v.identifier ?? v.code ?? v.kod : v; return /^\d{1,4}$/.test(String(s ?? '')) ? String(s) : null; };
  return pick(o, TAXTYPE_KEYS, v => (Array.isArray(v) ? v.map(one).find(Boolean) : one(v)));
}

/** A tételekben előforduló mezőnevek (érték nélkül): ebből látszik élőben, milyen alakot ad a portál. */
const keysOf = list => [...new Set(list.filter(isObj).slice(0, 50).flatMap(o => Object.keys(o)))].map(k => String(k).slice(0, 40)).sort().slice(0, 40);

/**
 * Adónaptár-bejegyzések → kötelezettségek. A múltbeli bejegyzést kihagyja: a naptár nem mondja meg, hogy a bevallás
 * beérkezett-e, ezért lejárt naptártételből nem csinálunk „hiányzó” riasztást (arra a hiányzó bevallások listája való).
 * @returns {{ items: object[], total: number, unknown: number, past: number, keys: string[] }}
 */
function calendarToObligations(posts, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const list = Array.isArray(posts) ? posts.slice(0, MAX_ITEMS) : [];
  const out = new Map(); let unknown = 0, past = 0;
  for (const p of list) {
    const dueDate = isObj(p) ? pick(p, DATE_KEYS, toIsoDate) : null;
    if (!dueDate) { unknown++; continue; }
    if (dueDate < today) { past++; continue; }
    const title = text(p, TITLE_KEYS), taxType = taxTypeOf(p);
    if (!title && !taxType && !formCodeOf(p, '')) { unknown++; continue; } // csak dátum: nem tudnánk megmondani, mi a teendő
    const formCode = formCodeOf(p, title) || (taxType ? `ADONEM-${taxType}` : 'NAPTAR');
    const done = DONE_KEYS.some(k => p[k] === true) || (isObj(p.priority) && p.priority.completed === true);
    const item = { formCode, title: title || (taxType ? `Adónaptár-bejegyzés (adónem: ${taxType})` : `${formCode} – adónaptár-bejegyzés`), dueDate,
      periodStart: pick(p, START_KEYS, toIsoDate), periodEnd: pick(p, END_KEYS, toIsoDate), conditional: p.conditional === true, status: done ? 'submitted' : 'submittable', kind: 'calendar' };
    out.set(`${item.formCode}|${item.dueDate}|${item.title}`, item);
  }
  return { items: [...out.values()], total: list.length, unknown, past, keys: keysOf(list) };
}

/**
 * Hiányzó bevallások → „hiányzó” állapotú kötelezettségek. Csak az kerül át, amelynek van nyomtatványkódja ÉS a NAV
 * válaszából kiolvasható a határideje; a többit megszámoljuk, de határidőt nem találunk ki hozzá.
 * @returns {{ items: object[], total: number, unknown: number, keys: string[] }}
 */
function missingToObligations(rows) {
  const list = Array.isArray(rows) ? rows.slice(0, MAX_ITEMS) : [];
  const out = new Map(); let unknown = 0;
  for (const r of list) {
    if (!isObj(r)) { unknown++; continue; }
    const title = text(r, TITLE_KEYS), formCode = formCodeOf(r, title);
    const dueDate = pick(r, DATE_KEYS.slice(0, 6), toIsoDate); // itt csak a kifejezetten határidőt jelentő nevek számítanak
    if (!formCode || !dueDate) { unknown++; continue; }
    const item = { formCode, title: title || `${formCode} bevallás – a NAV szerint hiányzik`, dueDate, periodStart: pick(r, START_KEYS, toIsoDate), periodEnd: pick(r, END_KEYS, toIsoDate),
      conditional: false, status: 'missing', kind: 'missing' };
    out.set(`${formCode}|${item.periodStart || ''}|${item.periodEnd || ''}|${dueDate}`, item);
  }
  return { items: [...out.values()], total: list.length, unknown, keys: keysOf(list) };
}

module.exports = { toIsoDate, formCodeOf, calendarToObligations, missingToObligations };
