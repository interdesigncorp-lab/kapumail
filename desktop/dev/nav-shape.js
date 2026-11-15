// A portálmegfigyelő (NAV, ASP) tiszta része: abból, amit a hivatalos felület a hálózaton forgalmaz, csak a SZERKEZETET
// őrizzük meg (gépnév, útvonalminta, módszer, állapotkód, mezőnevek és típusok). Érték – név, adószám, összeg, token – nem
// kerül a jegyzőkönyvbe. Fejlesztői eszköz: nincs a telepítőcsomagban.
'use strict';

const shape = v => String(v).slice(0, 60).replace(/\p{Lu}/gu, 'A').replace(/\p{Ll}/gu, 'a').replace(/\p{Nd}/gu, '9');

/** Csak állami gépnevek (a `gov.hu` alatt): a megfigyelő ablak máshová nem navigál, és más gépnév forgalmát nem jegyzi fel. */
const allowedHost = host => /(^|\.)gov\.hu$/i.test(String(host || ''));
/** Az ASP (E-Önkormányzat Portál) megfigyelésénél az önkormányzati `lgov.hu` is engedett; a belépés ott is a `gov.hu` alatti KAÜ-n megy. */
const allowedHostAsp = host => /(^|\.)l?gov\.hu$/i.test(String(host || ''));

/** Útvonalszakasz: a rövid, kisbetűs szavak maradnak (ezek a végpont nevei); a számok és minden azonosítószerű rész kitakarva. */
function segment(s) {
  if (/^\d+$/.test(s)) return '9…';
  if (/^[a-z][a-z-]{0,30}\d{0,2}$/.test(s)) return s;
  return s.length <= 24 ? shape(s) : '{azonosító}';
}

/** @returns {{ host: string, path: string, query: string[] } | null} */
function urlPattern(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const path = '/' + u.pathname.split('/').filter(Boolean).map(p => { try { return segment(decodeURIComponent(p)); } catch { return '{azonosító}'; } }).join('/');
  return { host: u.hostname.toLowerCase(), path, query: [...new Set([...u.searchParams.keys()].map(k => k.slice(0, 40)))].sort() };
}

/** Egy érték sémája: típus, szövegnél legfeljebb három különböző ALAK. Értéket nem tárol. */
function describe(value, acc = {}, depth = 0) {
  const t = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  acc.types = acc.types || {}; acc.types[t] = (acc.types[t] || 0) + 1;
  if (t === 'string') { acc.shapes = acc.shapes || []; const s = shape(value); if (!acc.shapes.includes(s) && acc.shapes.length < 3) acc.shapes.push(s); acc.maxLen = Math.max(acc.maxLen || 0, value.length); }
  else if (t === 'number') { acc.digits = acc.digits || []; const d = String(Math.trunc(Math.abs(value))).length; if (!acc.digits.includes(d) && acc.digits.length < 6) acc.digits.push(d); }
  else if (t === 'boolean') { acc.values = acc.values || {}; acc.values[value] = (acc.values[value] || 0) + 1; }
  else if (depth < 8 && t === 'array') { acc.lengths = acc.lengths || []; if (!acc.lengths.includes(value.length) && acc.lengths.length < 5) acc.lengths.push(value.length); acc.items = acc.items || {}; value.slice(0, 50).forEach(x => describe(x, acc.items, depth + 1)); }
  else if (depth < 8 && t === 'object') { acc.keys = acc.keys || {}; for (const [k, x] of Object.entries(value).slice(0, 200)) describe(x, (acc.keys[shapeKey(k)] = acc.keys[shapeKey(k)] || {}), depth + 1); }
  return acc;
}
// A kulcsok mezőnevek, ezért megmaradnak – kivéve, ha maguk is adatnak látszanak (például adószám kulcsként).
const shapeKey = k => (/^[\p{L}_][\p{L}\p{N}_.-]{0,48}$/u.test(k) && !/\d{4,}/.test(k) ? k : shape(k));

// Űrlapmező neve: a szerveroldalon rajzolt felületek (például JSF) kettőspontot és szögletes zárójelet is használnak.
const fieldKey = k => (/^[\p{L}_][\p{L}\p{N}_.:[\]-]{0,78}$/u.test(k) && !/\d{4,}/.test(k) ? k : shape(k));
const attr = (tag, name) => (new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag) || [])[1] || '';

/**
 * Egy HTML-oldal szerkezete, ha a portál nem JSON-ból dolgozik: az űrlapok (módszer, a cél útvonalmintája, a mezők NEVEI)
 * és a táblázatok mérete (oszlop- és sorszám). Felirat, cellatartalom, mezőérték nem kerül bele.
 */
function htmlShape(html, baseUrl) {
  const text = String(html || '').slice(0, 2 * 1024 * 1024);
  const urlapok = [...text.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].slice(0, 20).map(m => {
    let cel = null; try { cel = urlPattern(new URL(attr(m[1], 'action') || baseUrl, baseUrl).href); } catch { /* nincs értelmezhető cél */ }
    const mezok = [...new Set([...m[2].matchAll(/<(?:input|select|textarea|button)\b[^>]*?\bname\s*=\s*["']([^"']{1,80})["']/gi)].map(x => fieldKey(x[1])))].sort().slice(0, 80);
    return { method: (attr(m[1], 'method') || 'GET').toUpperCase().slice(0, 8), cel: cel ? `${cel.host}${cel.path}` : null, mezok };
  });
  const tablak = [...text.matchAll(/<table\b[\s\S]*?<\/table>/gi)].slice(0, 20).map(m => ({
    oszlopok: ((/<tr\b[\s\S]*?<\/tr>/i.exec(m[0]) || [''])[0].match(/<t[hd]\b/gi) || []).length, sorok: (m[0].match(/<tr\b/gi) || []).length }));
  return { urlapok, tablak };
}
const merge = (list, add, max) => { const seen = new Set(list.map(x => JSON.stringify(x))); for (const x of add) { const k = JSON.stringify(x); if (!seen.has(k) && list.length < max) { seen.add(k); list.push(x); } } return list; };

function parse(text) { try { return typeof text === 'string' && text.trim() ? JSON.parse(text) : undefined; } catch { return undefined; } }

/** Végpontonként összesítő rögzítő. `add()` bármit kaphat; ami nem engedett gépnév, annak csak a gépneve kerül külön listába. */
function makeRecorder(allowedHost = module.exports.allowedHost) {
  const items = new Map(); const foreign = new Set(); const pages = new Map(); let total = 0;
  return {
    add({ url, method = 'GET', status = 0, contentType = '', body = null, requestBody = null, requestHeaders = null } = {}) {
      const p = urlPattern(url); if (!p) return;
      if (!allowedHost(p.host)) { foreign.add(p.host); return; }
      total += 1;
      const m = String(method).toUpperCase().slice(0, 8);
      const key = `${m} ${p.host}${p.path}`;
      const it = items.get(key) || { method: m, host: p.host, path: p.path, darab: 0, statuszok: {}, tipusok: {}, query: [] };
      it.darab += 1; it.statuszok[status] = (it.statuszok[status] || 0) + 1;
      const ct = String(contentType).split(';')[0].trim().toLowerCase().slice(0, 60) || '(nincs)'; it.tipusok[ct] = (it.tipusok[ct] || 0) + 1;
      it.query = [...new Set([...it.query, ...p.query])].sort();
      // a kérésfejlécek NEVEI (érték nélkül): ebből látszik, kell-e külön token vagy azonosító a hívásokhoz
      if (requestHeaders && typeof requestHeaders === 'object') it.fejlecek = [...new Set([...(it.fejlecek || []), ...Object.keys(requestHeaders).map(k => k.toLowerCase().slice(0, 40)).filter(k => !/^(sec-|accept|user-agent|referer|origin|content-length|host|connection|cache-control|pragma|upgrade-insecure)/.test(k))])].sort();
      if (/json/.test(ct)) { const j = parse(body); if (j !== undefined) it.valasz = describe(j, it.valasz || {}); }
      else if (/html/.test(ct) && typeof body === 'string' && body) { const h = htmlShape(body, url); it.urlapok = merge(it.urlapok || [], h.urlapok, 10); it.tablak = merge(it.tablak || [], h.tablak, 10); }
      const rq = parse(requestBody); if (rq !== undefined) it.keres = describe(rq, it.keres || {});
      else if (typeof requestBody === 'string' && requestBody) it.keresNemJson = true;
      items.set(key, it);
    },
    /** Egy meglátogatott oldal: csak a gépnév és az útvonalminta. */
    page(url) { const p = urlPattern(url); if (p && allowedHost(p.host)) pages.set(`${p.host}${p.path}`, (pages.get(`${p.host}${p.path}`) || 0) + 1); },
    count: () => total,
    toJSON() {
      return { megjegyzes: 'Megfigyelés: a hivatalos felület saját forgalmának szerkezete. Érték nincs benne; a program saját kérést nem küldött.',
        keresekSzama: total, oldalak: [...pages.keys()].sort(), idegenGepnevek: [...foreign].sort(),
        vegpontok: [...items.values()].sort((a, b) => (a.host + a.path).localeCompare(b.host + b.path)) };
    },
  };
}

module.exports = { shape, allowedHost, allowedHostAsp, urlPattern, describe, htmlShape, makeRecorder };
