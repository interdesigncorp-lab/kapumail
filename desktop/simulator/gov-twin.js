// Helyi tárhely-szimulátor („iker") fejlesztéshez és teszthez.
//
// A KAÜ-belépés és a tárhely levelezési felületének azt a szeletét utánozza, amelyet a böngésző nélküli
// modul (tarhely-http.js) használ: belépési űrlaplánc, postafiók-lista, levéllista lapozással.
// `fetch`-kompatibilis függvényt ad, hálózatot nem használ.
//
// A válaszok alakja az élő próbán megfigyelt szerkezetet követi (2026-11-12; docs/ALLAPOT.md): a postafiók-lista mezői
// (azonosito, mailboxName, megnevezes, name, type, defaultMailbox …), a levélsorok mezői (erkezesiDatum ezredmásodpercben,
// cimzettNev, cimzettRovidNev, olvasatlan, tarolasiHely …), a lapozási adat, a telítettség (kvota, hasznaltKvota), a tartós tár,
// és a kezdődátumos szűrő, amely csak „Z" végű teljes időbélyeget fogad el (másra 400-at ad, mint a valódi tárhely).
// FELTEVÉS maradt: a Hivatali kapu típuskódja (itt „HKP") – ilyen postafiókot élőben még nem láttunk.
// Mit NEM tud, szándékosan: letöltés, levélrészlet, NAV-portál. Ezek valódi válaszát még nem láttuk; ami itt nincs,
// arra a szimulátor hibát dob, nem találgat. A minták saját adatok; licenc nélküli külső kódból semmi nem került át.
// Fejlesztői eszköz: nincs a telepítőcsomagban.
'use strict';

const { totpCode } = require('../totp');
const { createHash } = require('node:crypto');

const PAGE = 100;

function response(status, body, { location = null, setCookie = [], json = false, extra = null } = {}) {
  const headers = new Map([['content-type', json ? 'application/json' : 'text/html; charset=utf-8']]);
  if (location) headers.set('location', location);
  for (const [k, v] of Object.entries(extra || {})) headers.set(k.toLowerCase(), v);
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    headers: { get: k => headers.get(String(k).toLowerCase()) ?? null, getSetCookie: () => setCookie, keys: () => headers.keys() },
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const autoPost = (name, action, value = 'X') => `<form id="a" method="post" action="${action}"><input type="hidden" name="${name}" value="${esc(value)}"><input type="submit"></form>`;
const cookieOf = (init, name) => {
  const raw = (init && init.headers && (init.headers.Cookie || init.headers.cookie)) || '';
  const hit = raw.split(/;\s*/).map(p => p.split('=')).find(p => p[0] === name);
  return hit ? hit.slice(1).join('=') : null;
};
const header = (init, name) => {
  const h = (init && init.headers) || {};
  const k = Object.keys(h).find(x => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : null;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param scenario {{ users: Record<string, { password: string, totpSeed: string, mailboxes: Array<{ azonosito: string, mailboxName: string, name: string, type: string, defaultMailbox?: boolean, letters: object[], durable?: object[], quotaPct?: number }>, fail?: 'password'|'totp'|'slow' }>, sessionCalls?: number, slowMs?: number }}
 * @returns {{ fetchImpl: Function, log: Array<{ method: string, host: string, path: string, addressId: string|null, status: number }>, credentials: Record<string, object>, sessions: () => number }}
 */
function createGovTwin(scenario) {
  const users = scenario.users || {};
  const flows = new Map();    // belépési folyamat az azonosító szolgáltatónál
  const tickets = new Map();  // egyszer használható jegy a tárhely felé
  const sessions = new Map(); // tárhely-munkamenet
  const navSessions = new Map(); // NAV-portál munkamenet (külön süti, külön gépnév)
  const aspSessions = new Map(); // önkormányzati portál munkamenete (külön süti, külön gépnév)
  const log = [];
  let seq = 0;
  const id = p => `${p}${++seq}`;

  const passwordForm = err => `${err ? `<div class="alert-danger">${esc(err)}</div>` : ''}<form id="login-form" method="post" action="https://idp.gov.hu/idp/saml/authnrequest"><input name="felhasznaloNev" id="name" type="text"><input name="jelszo" type="password"><input type="submit"></form>`;
  const totpForm = err => `${err ? `<div class="alert-danger">${esc(err)}</div>` : ''}<form id="login-form" method="post" action="https://idp.gov.hu/idp/saml/authnrequest"><input name="token" id="identifier" type="text"><input type="submit"></form>`;

  function apiSession(init) {
    const s = sessions.get(cookieOf(init, 'JSESSIONID'));
    if (!s) return null;
    if (header(init, 'x-xsrf-token') !== s.xsrf) return null;
    s.calls += 1;
    if (scenario.sessionCalls != null && s.calls > scenario.sessionCalls) { sessions.delete(s.id); return null; }
    return s;
  }

  async function route(url, init) {
    const u = new URL(url); const p = u.host + u.pathname; const method = (init && init.method) || 'GET';
    const form = new URLSearchParams(typeof (init && init.body) === 'string' ? init.body : '');
    if (u.protocol !== 'https:') throw new Error(`A szimulátor titkosítatlan kérést kapott: ${u.protocol}//${u.host}`);

    // ---- belépési lánc
    if (p === 'tarhely.gov.hu/levelezes/login' && method !== 'POST') return response(200, autoPost('SAMLRequest', 'https://kau.gov.hu/proxy/saml/authnrequest'));
    // A KAÜ megjegyzi, melyik célrendszer kérte a belépést (tárhely vagy NAV-portál), és a végén oda küld vissza.
    if (p === 'kau.gov.hu/proxy/saml/authnrequest') return response(303, '', { location: 'https://kau.gov.hu/proxy/saml/authservice', setCookie: ['ROUTEID=k; Path=/', `KAUSP=${form.get('SAMLRequest') === 'NAV' ? 'nav' : form.get('SAMLRequest') === 'ASP' ? 'asp' : 'tarhely'}; Path=/`] });
    if (p === 'kau.gov.hu/proxy/saml/authservice' && method !== 'POST')
      return response(200, '<form id="urn:eksz.gov.hu:1.0:azonositas:kau:2:uk:totp" method="post" action="https://kau.gov.hu/proxy/saml/authservice"><input type="hidden" name="authServiceUri" value="totp"><input type="submit"></form>');
    if (p === 'kau.gov.hu/proxy/saml/authservice' && method === 'POST') return response(200, autoPost('SAMLRequest', 'https://idp.gov.hu/idp/saml/authnrequest/start'));
    if (p === 'idp.gov.hu/idp/saml/authnrequest/start') {
      const f = id('F'); flows.set(f, { user: null });
      return response(303, '', { location: 'https://idp.gov.hu/idp/saml/authnrequest', setCookie: [`IDPFLOW=${f}; Path=/`] });
    }
    if (p === 'idp.gov.hu/idp/saml/authnrequest') {
      const flow = flows.get(cookieOf(init, 'IDPFLOW'));
      if (!flow) return response(200, passwordForm('A belépési folyamat lejárt.'));
      if (method !== 'POST') return response(200, passwordForm());
      if (form.has('jelszo')) {
        const name = form.get('felhasznaloNev'); const user = users[name];
        if (!user || user.fail === 'password' || user.password !== form.get('jelszo')) return response(200, passwordForm('Hibás felhasználónév vagy jelszó.'));
        flow.user = name;
        return response(200, totpForm());
      }
      if (form.has('token') && flow.user) {
        const user = users[flow.user]; const now = Date.now() / 1000; const code = form.get('token');
        const good = user.fail !== 'totp' && [now, now - 30].some(t => totpCode(user.totpSeed, t) === code);
        if (!good) return response(200, totpForm('Hibás hitelesítő kód.'));
        const t = id('T'); tickets.set(t, flow.user); flows.delete(cookieOf(init, 'IDPFLOW'));
        return response(200, autoPost('SAMLResponse', 'https://kau.gov.hu/proxy/saml/response', t));
      }
      return response(200, passwordForm('Hiányzó adat.'));
    }
    if (p === 'kau.gov.hu/proxy/saml/response') return response(200, autoPost('SAMLResponse', cookieOf(init, 'KAUSP') === 'nav' ? 'https://ugyfelportal.nav.gov.hu/api/v1/user/login/kaulogin' : cookieOf(init, 'KAUSP') === 'asp' ? 'https://ohp-20.asp.lgov.hu/login' : 'https://tarhely.gov.hu/levelezes/login', form.get('SAMLResponse') || ''));
    if (p === 'tarhely.gov.hu/levelezes/login' && method === 'POST') {
      const user = tickets.get(form.get('SAMLResponse')); tickets.delete(form.get('SAMLResponse'));
      if (!user) return response(200, '<div class="alert-danger">Érvénytelen belépési jegy.</div>');
      const s = { id: id('S'), user, xsrf: id('X'), calls: 0 }; sessions.set(s.id, s);
      return response(302, '', { location: 'https://tarhely.gov.hu/levelezes/', setCookie: [`XSRF-TOKEN=${s.xsrf}; Path=/; Secure`, `JSESSIONID=${s.id}; Path=/`] });
    }
    if (p === 'tarhely.gov.hu/levelezes/') return response(200, '<html><title>BKSZ - Levelezés</title></html>');

    // ---- NAV ügyfélportál: a megfigyelt (ADR-010) belépés és GET végpontok, saját kézzel írt mintaválaszokkal.
    // Módosító végpont (képviselet-váltás, üzenet feldolgozottá tétele, lekérdezés indítása) szándékosan nincs: ha a
    // program ilyet hívna, a szimulátor „nem ismert útvonal” hibával megállítja a tesztet.
    if (p === 'ugyfelportal.nav.gov.hu/api/v1/user/login/start-kaulogin' && method === 'GET') return response(200, autoPost('SAMLRequest', 'https://kau.gov.hu/proxy/saml/authnrequest', 'NAV'));
    if (p === 'ugyfelportal.nav.gov.hu/api/v1/user/login/kaulogin' && method === 'POST') {
      const user = tickets.get(form.get('SAMLResponse')); tickets.delete(form.get('SAMLResponse'));
      if (!user) return response(200, '<div class="alert-danger">Érvénytelen belépési jegy.</div>');
      const s = { id: id('N'), user, calls: 0 }; navSessions.set(s.id, s);
      return response(302, '', { location: 'https://ugyfelportal.nav.gov.hu/', setCookie: [`NAVSESSION=${s.id}; Path=/; Secure`] });
    }
    if (p === 'ugyfelportal.nav.gov.hu/') return response(200, '<html><title>NAV ÜGYFÉLPORTÁL</title></html>');
    // A képviselet-váltás (B kör) az egyetlen módosító kérés, amelyet a szimulátor a NAV-részen ismer: a munkamenet
    // kiválasztott adózóját állítja át. Csak a saját profilra és a képviselt adózók egyikére lehet váltani.
    if (p === 'ugyfelportal.nav.gov.hu/api/v1/user/login/change-kepviselet' && method === 'PUT') {
      const s = navSessions.get(cookieOf(init, 'NAVSESSION'));
      if (s) { s.calls += 1; if (scenario.navSessionCalls != null && s.calls > scenario.navSessionCalls) navSessions.delete(s.id); }
      if (!s || !navSessions.has(s.id)) return response(401, { error: 'unauthorized' }, { json: true });
      let want = null; try { want = JSON.parse(init.body).adozoiProfilId; } catch { /* hibás törzs */ }
      const nav = navOf(users[s.user]);
      if (want !== 10000001 && !nav.profiles.some(x => x.id === want)) return response(400, { error: 'nincs ilyen képviselt adózó' }, { json: true });
      if (scenario.navSwitchRefuse === want) return response(403, { error: 'a váltás nem engedélyezett' }, { json: true });
      if (scenario.navSwitchIgnore !== want) s.selected = want; // „ignore”: a portál 200-at ad, de nem vált (védekező ellenőrzés tesztjéhez)
      (s.switches = s.switches || []).push(want);
      return response(200, { funkcioList: [] }, { json: true });
    }
    // Beadott bevallások lekérdezése (C kör): a megfigyelt kérés- és válaszalak, kitalált értékekkel. Csak a munkamenet
    // kiválasztott adózójára ad választ – más azonosítóra hibát, hogy a teszt észrevegye, ha a program rossz adózóra kérdez.
    // Letölthető kimutatások (C kör): adószámla-lekérdezés és -export, törzsadat-export, biztosítotti lekérdezés és -export.
    // Kitalált fájltartalommal, a megfigyelt útvonalakon és a nyilvános felületkódban látható paraméterekkel.
    if (u.host === 'ugyfelportal.nav.gov.hu' && /^\/api\/(v1\/balance\/tax-invoice(\/last|\/export)?|v1\/user\/own-data\/export|foglalkoztato-lekerdezesek\/biztositotti-fajlba(\/export|\/adozoi-profilok\/\d+\/eredmenyek\/utolso)?)$/.test(u.pathname)) {
      const s = navSessions.get(cookieOf(init, 'NAVSESSION'));
      if (s) { s.calls += 1; if (scenario.navSessionCalls != null && s.calls > scenario.navSessionCalls) navSessions.delete(s.id); }
      if (!s || !navSessions.has(s.id)) return response(401, { error: 'unauthorized' }, { json: true });
      const sel = s.selected ?? 10000001; const q = k => u.searchParams.get(k); let body = {}; try { body = JSON.parse(init.body || '{}'); } catch { /* üres */ }
      const file = (txt, type) => ({ status: 200, headers: { get: k => (String(k).toLowerCase() === 'content-type' ? type : null), getSetCookie: () => [] }, text: async () => txt, arrayBuffer: async () => new TextEncoder().encode(txt).buffer });
      s.exports = s.exports || {};
      if (u.pathname === '/api/v1/balance/tax-invoice' && method === 'POST') {
        if (body.adozoiProfilId !== sel || body.adoszamlaTipus !== 'TETELES' || !/^\d{4}-01-01$/.test(body.idoszakKezdete)) return response(400, { error: 'hibás kérés' }, { json: true });
        s.exports.account = { id: 500 + sel % 100, polls: 0 }; return response(200, { id: s.exports.account.id }, { json: true });
      }
      if (u.pathname === '/api/v1/balance/tax-invoice/last') {
        const a = s.exports.account; if (!a) return response(200, {}, { json: true }); a.polls += 1;
        return response(200, { query: { lekerdezesId: a.id, allapot: a.polls > 1 ? (scenario.navAccountState || 'FELDOLGOZOTT') : 'FELDOLGOZAS_ALATT' }, result: a.polls > 1 ? { eredmenyId: a.id * 10 } : null }, { json: true });
      }
      if (u.pathname === '/api/v1/balance/tax-invoice/export') {
        const a = s.exports.account; if (!a || +q('lekerdezesEredmenyId') !== a.id * 10) return response(400, { error: 'ismeretlen eredmény' }, { json: true });
        if (q('riportTipus') !== q('tipus') || String(q('hitelesitett')) !== String(q('riportTipus') === 'PDF_HITELESITETT')) return response(400, { error: 'hibás paraméter' }, { json: true });
        return q('riportTipus') === 'XLSX' ? file('PK\u0003\u0004 szimulátor adószámla ' + sel, 'application/octet-stream') : file('%PDF-1.4 szimulátor adószámla ' + sel, 'application/pdf');
      }
      if (u.pathname === '/api/v1/user/own-data/export') {
        if (!['TERMESZETESSZEMELY', 'CEG'].includes(q('adozoTipus')) || q('riportTipus') !== 'PDF') return response(400, { error: 'hibás paraméter' }, { json: true });
        return scenario.navOwnDataHtml ? file('<html>hiba</html>', 'text/html') : file('%PDF-1.4 szimulátor törzsadat ' + q('adozoTipus') + ' ' + sel, 'application/pdf');
      }
      if (u.pathname === '/api/foglalkoztato-lekerdezesek/biztositotti-fajlba' && method === 'POST') {
        if (body.adozoiProfilId !== sel || body.jogviszonyTipus !== 'NYITOTT' || !/T00:00:00\.000000$/.test((body.lekerdezesiIdoszakKezdete || {}).naptolDtoNapKezdete || '')) return response(400, { error: 'hibás kérés' }, { json: true });
        s.exports.insured = { id: 700, polls: 0 }; return response(200, { id: 700 }, { json: true });
      }
      if (/\/eredmenyek\/utolso$/.test(u.pathname)) {
        const i = s.exports.insured; if (!i || !u.pathname.includes(`/adozoi-profilok/${sel}/`)) return response(200, { lekerdezesId: null }, { json: true }); i.polls += 1;
        return response(200, {
          lekerdezesId: i.id,
          lekerdezesEredmenyId: i.polls > 1 ? 7001 : null,
          biztositottiJogviszonyok: i.polls > 1 ? (scenario.navInsured || [{ munkavallaloNeve: 'SZIMULÁTOR Munkavállaló', munkavallaloAdoazonositoJele: '8400000001', tajSzam: '111222333', jogviszonyKezdete: '2025-01-15', jogviszonyVege: null, jogviszonyKodMegnevezes: '1101 - munkaviszony', hetiOra: [{ hetiMunkaora: 40, hetiMunkaoraKezdeteDat: '2025-01-15' }] }]) : null,
          errorMessage: null,
        }, { json: true });
      }
      if (u.pathname === '/api/foglalkoztato-lekerdezesek/biztositotti-fajlba/export') {
        if (q('eredmenyId') !== '7001' || q('riportTipus') !== 'XLSX') return response(400, { error: 'hibás paraméter' }, { json: true });
        return file('PK\u0003\u0004 szimulátor biztosítottak ' + sel, 'application/octet-stream');
      }
    }
    // Adózói táblák (C kör): foglalkoztatási típusok, saját foglalkoztatók, EFO bejelentések és napkeret, adategyeztetések.
    if (u.host === 'ugyfelportal.nav.gov.hu' && /^\/api\/(v1\/dialog\/survey-from-joker\/list|foglalkoztatas-lekerdezesek\/(adozoi-profilok\/\d+\/(biztositasi-tipusok|munkavallalok)|biztositotti-fajlba(\/export|\/adozoi-profilok\/\d+\/eredmenyek\/utolso)?)|v1\/registry\/foglalkoztato-lekerdezesek\/(egyszerusitett\/|egyszerusitett\/last|egyszerusitett-korabban-bejelentett\/|egyszerusitett-korabban-bejelentett\/last|egyszerusitett-korabban-bejelentett\/export|egyszerusitett-adozo-adatai\/|egyszerusitett-adozo-adatai\/last))$/.test(u.pathname)) {
      const s = navSessions.get(cookieOf(init, 'NAVSESSION'));
      if (s) { s.calls += 1; if (scenario.navSessionCalls != null && s.calls > scenario.navSessionCalls) navSessions.delete(s.id); }
      if (!s || !navSessions.has(s.id)) return response(401, { error: 'unauthorized' }, { json: true });
      const sel = s.selected ?? 10000001; const q = k => u.searchParams.get(k); let body = {}; try { body = JSON.parse(init.body || '{}'); } catch { /* üres */ }
      s.exports = s.exports || {};
      if (u.pathname === '/api/v1/dialog/survey-from-joker/list' && method === 'GET') {
        return response(200, scenario.navSurveys || {
          runningSurveys: [{ kampanyAzonosito: 901, nev: 'SZIMULÁTOR – ÁFA adategyeztetés', kikuldesDatum: '2026-10-05', bekuldesIdopontja: null }],
          closedSurveys: [{ kampanyAzonosito: 850, nev: 'SZIMULÁTOR – Kontroll adategyeztetés', kikuldesDatum: '2026-05-10', bekuldesIdopontja: '2026-05-18T14:20:00' }],
        }, { json: true });
      }
      if (/\/biztositasi-tipusok$/.test(u.pathname) && method === 'GET') {
        if (!u.pathname.includes(`/adozoi-profilok/${sel}/`)) return response(403, { error: 'nem a kiválasztott profil' }, { json: true });
        const kat = q('kategoria');
        if (kat === 'FOGLALKOZTATO') return response(200, { elerhetoBiztositottiTipusok: scenario.navEmployerTypes || (sel === 10000001 ? [] : ['BIZTOSITAS', 'EGYSZERUSITETT']) }, { json: true });
        if (kat === 'FOGLALKOZTATAS') return response(200, { elerhetoBiztositottiTipusok: scenario.navOwnEmployerTypes || (sel === 10000001 ? ['BIZTOSITAS'] : []) }, { json: true });
        return response(400, { error: 'hibás kategória' }, { json: true });
      }
      if (/\/munkavallalok$/.test(u.pathname) && method === 'GET') {
        if (!u.pathname.includes(`/adozoi-profilok/${sel}/`)) return response(403, { error: 'nem a kiválasztott profil' }, { json: true });
        const list = scenario.navEfoMunkavallalok !== undefined ? scenario.navEfoMunkavallalok : [{ adoazonositoJel: '8400000002', megnevezes: 'SZIMULÁTOR Alkalmi Dolgozó', bejelentesDatuma: [{ napDtoNapKezdete: '2026-09-30' }] }];
        return response(200, { munkavallalok: list }, { json: true });
      }
      if (u.pathname === '/api/foglalkoztatas-lekerdezesek/biztositotti-fajlba' && method === 'POST') {
        if (body.adozoiProfilId !== sel || body.jogviszonyTipus !== 'NYITOTT') return response(400, { error: 'hibás kérés' }, { json: true });
        s.exports.ownEmployers = { id: 800, polls: 0 };
        return response(200, { id: 800 }, { json: true });
      }
      if (/^\/api\/foglalkoztatas-lekerdezesek\/biztositotti-fajlba\/adozoi-profilok\/\d+\/eredmenyek\/utolso$/.test(u.pathname) && method === 'GET') {
        const oe = s.exports.ownEmployers; if (!oe || !u.pathname.includes(`/adozoi-profilok/${sel}/`)) return response(200, { lekerdezesId: null }, { json: true }); oe.polls += 1;
        return response(200, {
          lekerdezesId: oe.id,
          lekerdezesEredmenyId: oe.polls > 1 ? 8001 : null,
          biztositottiJogviszonyok: oe.polls > 1 ? (scenario.navOwnEmployers || [{ foglalkoztatoNeve: 'SZIMULÁTOR Foglalkoztató Kft.', foglalkoztatoAdoalanyAzonositoja: '12345676-2-41', jogviszonyKezdete: { naptolDtoNapKezdete: '2024-03-01T00:00:00.000000' }, jogviszonyVege: null, jogviszonyKodMegnevezes: '1101 - munkaviszony', hetiOra: [{ hetiMunkaora: 40, hetiMunkaoraKezdeteDat: { napDtoNapKezdete: '2024-03-01T00:00:00.000000' } }] }]) : null,
          errorMessage: null,
        }, { json: true });
      }
      if (u.pathname === '/api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett/' && method === 'POST') {
        if (body.adozoiProfilId !== sel || body.lang !== 'hu') return response(400, { error: 'hiányzó adozoiProfilId vagy lang' }, { json: true });
        return response(200, {
          result: {
            egyszerusitettResponse: {
              egyszerusitettFoglalkoztatasok: scenario.navEfo || [{
                munkavallaloNeve: 'SZIMULÁTOR Alkalmi Dolgozó',
                munkavallaloAdoazonositoJele: '8400000002',
                munkavallaloTajSzama: '222333444',
                foglalkoztatasJellege: 'ALKALMI_MUNKA',
                foglalkoztatasKezdete: '2026-10-01',
                foglalkoztatasVege: '2026-10-03',
                munkaviszonyNapjainakSzama: 3,
                adatbejelentesJellege: 'UJ',
                adatlapbeerkezesDatuma: '2026-09-30T18:10:00',
                foglalkoztatasiLapokAdatai: { adatlapTipusa: '26T1042E', adatlapIktatoszam: '8199000001', adatlapStatusz: 'ELFOGADOTT', potlapSorszama: 1 },
              }],
            },
          },
        }, { json: true });
      }
      if (u.pathname === '/api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett-korabban-bejelentett/' && method === 'POST') {
        if (body.adozoiProfilId !== sel || body.lang !== 'hu') return response(400, { error: 'hiányzó adozoiProfilId vagy lang' }, { json: true });
        return response(200, { result: { korabbanBejelentettResponse: scenario.navEfoPrev || null } }, { json: true });
      }
      if (u.pathname === '/api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett-adozo-adatai/' && method === 'POST') {
        if (body.adozoiProfilId !== sel || body.lang !== 'hu') return response(400, { error: 'hiányzó adozoiProfilId vagy lang' }, { json: true });
        return response(200, {
          result: {
            adozoAdataiResponse: {
              munkavallaloNeve: body.nev,
              munkavallaloAdoazonosito: body.adoazonosito,
              munkavallaloTajszam: body.munkavallaloTajSzama,
              felhasznaltNapok: 12,
              felhasznalhatoNapok: 108,
            },
          },
        }, { json: true });
      }
    }
    // NAV-dokumentumok (C kör): a megfigyelt kérés- és válaszalak, kitalált értékekkel; csak a kiválasztott adózóra, és csak a
    // nyilvános felületkódban szereplő irányokkal és dátumalakkal válaszol.
    if (p === 'ugyfelportal.nav.gov.hu/api/dokumentumok' && method === 'POST') {
      const s = navSessions.get(cookieOf(init, 'NAVSESSION'));
      if (s) { s.calls += 1; if (scenario.navSessionCalls != null && s.calls > scenario.navSessionCalls) navSessions.delete(s.id); }
      if (!s || !navSessions.has(s.id)) return response(401, { error: 'unauthorized' }, { json: true });
      let body = {}; try { body = JSON.parse(init.body); } catch { /* hibás törzs */ }
      const nav = navOf(users[s.user]); const picked = nav.profiles.find(x => x.id === s.selected) || null;
      const okDate = v => v && /^\d{4}-\d{2}-\d{2}T00:00:00\.000000$/.test(v.naptolDtoNapKezdete || v.napigDtoKovNapKezdete || '');
      if (body.akutalisAdozo !== (picked ? picked.torzsszam : nav.taxId) || body.nyelv !== 'HU' || !['BEFOGADOTT', 'BEKULDOTT_NEM_BEFOGADOTT', 'FOGADOTT', 'MINDEN_IRANY'].includes(body.befogadasAllapota)
        || ![body.letoltesiIdoKezdete, body.letoltesiIdoVege, body.keletkezesiIdoKezdete, body.keletkezesiIdoVege].every(okDate)) return response(400, { error: 'hibás kérés' }, { json: true });
      if (scenario.navDocumentsStatus) return response(scenario.navDocumentsStatus, { error: 'x' }, { json: true });
      const base = picked ? nav.profiles.indexOf(picked) * 100 : 0;
      const doc = (n, kod, urlap, targy) => ({ benyujtasIdopontja: '2026-10-20T10:08:00', erkezesDatum: '2026-10-20T10:08:12', krErkeztetesiSzam: null, letoltesiIdo: null, szovegesTargy: targy, irattipusKod: kod, urlapTipus: urlap,
        altalanosElektronikusTartalom: [{ elektronikusTartalom: { etartalomAzonosito: '000000000001', allomany: { eredetiFajlnev: 'x', meret: 1 } }, alapiratJel: 'ALAPIRAT', etartalomAzonTokenBase64: 'TITKOS-TOKEN' }],
        ugytipus: 'Szimulátor ügytípus', ugytipusKod: 'U0001', ugyszam: String(9000000000 + n), kezbesitesTipus: null, tarhelyTipus: null, eredetiIratFormatum: 'ELEKTRONIKUS_IRAT',
        iktatoszam: `${8100000000 + base + n}/2026/NAV`, barkod: String(8100000000 + base + n), lekerdezesIdopontja: '2026-11-13T07:00:00.123456', beNemFogadasOka: null, felado: { adoalanyAzonosito: '8400000000' }, cimzett: [],
        urlapTipusDto: { urlaptipusAzon: urlap, urlaptipusNev: 'Szimulátor nyomtatvány' }, dokumentumLetoltesTokenDto: { iktatoszamTokenBase64: 'TITKOS', barkodTokenBase64: 'TITKOS' }, fromEszja: false });
      return response(200, scenario.navDocuments || [doc(1, 'B0001', '2658', 'Havi bevallás'), doc(2, 'B0002', '2665', 'Áfabevallás'), { szovegesTargy: 'azonosító nélkül' }], { json: true });
    }
    if (p === 'ugyfelportal.nav.gov.hu/api/bevallas-lekerdezes' && method === 'POST') {
      const s = navSessions.get(cookieOf(init, 'NAVSESSION'));
      if (s) { s.calls += 1; if (scenario.navSessionCalls != null && s.calls > scenario.navSessionCalls) navSessions.delete(s.id); }
      if (!s || !navSessions.has(s.id)) return response(401, { error: 'unauthorized' }, { json: true });
      let body = {}; try { body = JSON.parse(init.body); } catch { /* hibás törzs */ }
      const nav = navOf(users[s.user]); const picked = nav.profiles.find(x => x.id === s.selected) || null;
      const expect = picked ? picked.torzsszam : nav.taxId;
      if (body.adoszam !== expect || body.nyelv !== 'hu') return response(400, { error: 'nem a kiválasztott adózó' }, { json: true });
      if (scenario.navReturnsStatus) return response(scenario.navReturnsStatus, { error: 'x' }, { json: true });
      const one = (n, szam, idoszak, nev) => ({ szjaBevallas: false, iktatoSzam: String(8100000000 + n + (picked ? nav.profiles.indexOf(picked) * 100 : 0)), benyujtasIdopontja: '2026-10-12T09:41:07', bevallasSzama: szam, bevallasIdoszak: idoszak,
        funckio: 'ALAPBEVALLAS', riportAzonosito: null, lekerdezesIdopontja: '2026-11-13T07:00:00.123456', kapcsolodoDokumentumok: null, bevallasNyomtatvanyAllapota: 'Feldolgozott', bevallasonVoltJavitas: 'NINCS', jovedekiBevallas: false,
        urlapTipusDto: { urlaptipusAzon: szam, urlaptipusNev: nev, bevallasGarnituraKod: '26', bevallasGarnituraNev: 'Szimulátor garnitúra' } });
      return response(200, { bevallasok: scenario.navReturns || [one(1, '2658', '2026.09.01 - 2026.09.30', 'Havi bevallás a kötelezettségekről'), one(2, '2665', '2026.07.01 - 2026.09.30', 'Általános forgalmi adó bevallás'), { bevallasSzama: 'x y', iktatoSzam: null }] }, { json: true });
    }
    if (u.host === 'ugyfelportal.nav.gov.hu' && u.pathname.startsWith('/api/') && method === 'GET') {
      const s = navSessions.get(cookieOf(init, 'NAVSESSION'));
      if (s) { s.calls += 1; if (scenario.navSessionCalls != null && s.calls > scenario.navSessionCalls) navSessions.delete(s.id); }
      if (!s || !navSessions.has(s.id)) return response(401, { error: 'unauthorized' }, { json: true });
      const nav = navOf(users[s.user]); const own = { id: 10000001, megnevezes: nav.name, adoazonosito: nav.taxId, torzsszam: null, adoazonositoOrTorzsszam: nav.taxId, adoszam: null, vamazonosito: null, kozossegiAdoszam: null, adozoiTipus: 'MAGANSZEMELY', allapotKod: 'AKTIV', megbizhatoJel: false };
      const api = u.pathname.slice(4);
      const picked = nav.profiles.find(x => x.id === s.selected) || own; const k = nav.profiles.indexOf(picked) + 1; // 0: a saját profil
      if (api === '/v1/user/login/logged-user') return response(200, { adoazonositoJel: nav.taxId, elsodlegesTarhelyId: 'a'.repeat(32), nev: nav.name, nyelv: 'hu', sessionLifeSpan: '30', sajatAdozoiProfil: own, kivalasztottAdozoiProfil: picked }, { json: true });
      if (api === '/v1/user/profil/adozoi-profil-page') {
        const page = Number(u.searchParams.get('page')) || 0, size = Number(u.searchParams.get('size')) || 10;
        return response(200, { content: nav.profiles.slice(page * size, page * size + size), total: nav.profiles.length, page, size }, { json: true });
      }
      // A képviselt adózók adószámlája adózónként más (a sorszámából számolt, kitalált összeg), hogy a tesztből látsszon, kié.
      if (api === '/v1/balance/tax-invoice/summary') return response(200, k ? { ugyfelOsszesen: k * 1000, adozoiTartozas: k * 1000, adozoiTobblet: 0, letetszamlaOsszesen: 0, konyveletlenOsszesen: 0, hasEloreMutato: false, queryDurationMs: 90 }
        : { ugyfelOsszesen: -25000, adozoiTartozas: 0, adozoiTobblet: 25000, letetszamlaOsszesen: 0, konyveletlenOsszesen: 0, hasEloreMutato: false, queryDurationMs: 120 }, { json: true });
      if (api === '/v1/balance/tax-invoice/future-items') return response(200, { dates: ['2026-11-20', '2026-12-12'] }, { json: true });
      if (api === '/v1/declaration/missing-returns/count') return response(200, { missingReturnsCount: 1 }, { json: true });
      if (api === '/v1/declaration/missing-returns') return response(200, { queryTime: '2026-11-13T03:00:00.000000Z', fromDate: '2020-01-01', toDate: '2026-11-13', missingReturnsCount: 1, reportId: 'SZIM000000000000001', missingReturns: scenario.navMissing || [{}] }, { json: true });
      // A tételek alakja a 2026-11-13-i megfigyelés szerint (mezőnevek és alakok; az értékek kitaláltak). Az időpont UTC-ben
      // jön: a magyar éjfél előző nap 23:00 Z. `scenario.navPosts` felülírja.
      const prio = { id: 1, icon: 'important', text: 'Fontos', default: true, completed: false, order: 1 };
      const posts = scenario.navPosts || [
        { id: 10000001, type: 'SYSTEM_GENERATED', conditional: false, deadline: '2026-11-19T23:00:00Z', title: 'Bevallás a kifizetésekkel, juttatásokkal összefüggő adóról, járulékokról és egyéb adatokról', note: null, declarationNumber: '2658', portalIdentifier: null, priority: prio },
        { id: 10000002, type: 'SYSTEM_GENERATED', conditional: false, deadline: '2026-11-19T23:00:00Z', title: 'Bevallás az általános forgalmi adóról', note: null, declarationNumber: '2665', portalIdentifier: null, priority: prio },
        { id: 10000003, type: 'SYSTEM_GENERATED', conditional: true, deadline: '2026-12-11T23:00:00Z', title: 'Összesítő nyilatkozat az Európai Közösség területén belüli termékértékesítésekről', note: null, declarationNumber: '26A60', portalIdentifier: null, priority: prio },
        { id: 10000004, type: 'SYSTEM_GENERATED', conditional: false, deadline: '2026-12-20T23:00:00Z', title: 'Bevallás a kisvállalati adóról', note: null, declarationNumber: '26KIVA', portalIdentifier: null, priority: { ...prio, completed: true } },
      ];
      // Az előnézet a még nem generált naptárnál üres (élőben megfigyelve); a teljes lista frissítéssel kéri a generálást.
      const generated = scenario.navCalendarGenerated !== false;
      if (api === '/v1/calendar/tax-calendar/posts/preview') return response(200, { hasGeneratedBefore: false, shouldSync: false, posts: generated ? posts.slice(0, 3) : [] }, { json: true });
      if (api === '/v1/calendar/tax-calendar/posts') {
        if (scenario.navPostsStatus) return response(scenario.navPostsStatus, { error: 'x' }, { json: true });
        const refresh = u.searchParams.get('refreshPosts') === 'true';
        if (!generated && !refresh) return response(200, { systemPostsChanged: false, posts: [] }, { json: true });
        return response(200, { systemPostsChanged: refresh && !generated, posts }, { json: true });
      }
    }

    // ---- E-Önkormányzat Portál (ASP): a megfigyelt (ADR-011) belépés és GET végpontok, saját kézzel írt mintaválaszokkal.
    // A belépés végén – ahogy élőben – sima http-s címre irányít. Módosító végpont (szerepkörváltás, kedvencek,
    // használati napló, keepalive) szándékosan nincs: ha a program ilyet hívna, a teszt „nem ismert útvonal” hibával megáll.
    const ASP = 'ohp-20.asp.lgov.hu';
    if (p === `${ASP}/login` && method === 'GET') return response(200, autoPost('SAMLRequest', 'https://kau.gov.hu/proxy/saml/authnrequest', 'ASP'));
    if (p === `${ASP}/login` && method === 'POST') {
      const user = tickets.get(form.get('SAMLResponse')); tickets.delete(form.get('SAMLResponse'));
      if (!user) return response(200, '<div class="alert-danger">Érvénytelen belépési jegy.</div>');
      const s = { id: id('A'), user, calls: 0, tenant: null }; aspSessions.set(s.id, s);
      return response(302, '', { location: `http://${ASP}/successful-login`, setCookie: [`ASPSESSION=${s.id}; Path=/; Secure`] });
    }
    if (p === `${ASP}/successful-login`) return response(200, '<html><title>E-Önkormányzat Portál</title></html>');
    if (u.host === ASP && u.pathname.startsWith('/api/') && method === 'GET') {
      const s = aspSessions.get(cookieOf(init, 'ASPSESSION'));
      if (s) { s.calls += 1; if (scenario.aspSessionCalls != null && s.calls > scenario.aspSessionCalls) aspSessions.delete(s.id); }
      if (!s || !aspSessions.has(s.id)) return response(401, { error: 'unauthorized' }, { json: true });
      const asp = aspOf(users[s.user]); const wrap = body => response(200, { body, length: 1 }, { json: true });
      const api = u.pathname.slice(4);
      if (api === '/public/userdetails') return wrap({ name: asp.name, adoazonosito: asp.taxId, favouriteTenants: asp.tenants, defaultTenant: asp.tenants[0], termsAcceptedDate: 1700000000000,
        roleDetails: { adoazonosito: asp.taxId, szerepkor: 'SAJAT_NEVEN_TERMESZETES_SZEMELY', szerepkorCeg: null, szerepkorSajatEgyeniVallalkozo: null, szerepkorEgyeniVallalkozo: null, szerepkorMasTermeszetesSzemely: null, szerepkorHkp: null } });
      if (api === '/public/service-permissions') return wrap({ ugykovetes: true, adoegyenleg: true, ugyinditas: true, adofizetes: true, szamlafizetes: true, befizetesek: true, adobevallas: true, mentett_urlapok: true, ...(scenario.aspPermissions || {}) });
      const sel = /^\/public\/tenant-services\/([A-Za-z0-9-]+)$/.exec(api);
      if (sel) {
        if (!asp.tenants.some(t => t.uid === sel[1])) return response(404, { error: 'ismeretlen önkormányzat' }, { json: true });
        s.tenant = sel[1]; return wrap([{ url: 'adoegyenleg', title: 'Adóegyenleg lekérdezés', type: null, modificationDate: 1700000000000, description: '', body: '', serviceOrder: 1, serviceId: 'adoegyenleg' }]);
      }
      const here = asp.tenants.find(t => t.uid === s.tenant);
      if (!here) return response(400, { error: 'nincs kiválasztott önkormányzat' }, { json: true });
      const tax = /^\/tax\/(SIMPLE|DETAILED)\/(20\d\d)$/.exec(api);
      // Élőben látott állapot: „Sikeres” (2026-11-13). A kivonat nélküli eset állapota kitalált.
      if (tax) return wrap(here.noBalance ? { taxPdf: null, status: 'NINCS_ADAT', statusMessage: null } : { taxPdf: Buffer.from(`%PDF-1.4 szimulátor adószámla-kivonat ${here.cityName} ${tax[1]} ${tax[2]}`).toString('base64'), status: 'Sikeres', statusMessage: null });
      if (api === '/tax-returns') return wrap({ items: here.returns || [], status: 'Sikeres', statusMessage: null });
      if (api === '/cases/folyamatban') return wrap(here.cases || []);
    }

    // ---- levelezési felület
    if (p === 'tarhely.gov.hu/levelezes/api/mailbox/reload') {
      const s = apiSession(init); if (!s) return response(401, { error: 'unauthorized' }, { json: true });
      return response(200, users[s.user].mailboxes.map(m => ({
        officeState: 'ACTIVE', defaultMailbox: m.defaultMailbox === true, name: m.name, type: m.type, mailboxName: m.mailboxName, megnevezes: m.mailboxName,
        kapcsolattarto: m.type === 'CKP' ? true : null, meghiusulasiIgazolasokMenuTiltasa: false, cegkepviseletreJogosult: m.type === 'CKP' ? false : null,
        azonosito: m.azonosito, olvasatlanUzenetekSzama: (m.letters || []).filter(l => l.olvasatlan).length, ideiglenes: false,
      })), { json: true });
    }
    if (p === 'tarhely.gov.hu/levelezes/api/mailbox/details') {
      const s = apiSession(init); if (!s) return response(401, { error: 'unauthorized' }, { json: true });
      const box = users[s.user].mailboxes.find(m => m.azonosito === header(init, 'address-id'));
      if (!box) return response(403, { error: 'forbidden' }, { json: true });
      return response(200, { olvasatlanIgazolasTorles: false, masolatATartosTarba: false, uzenetOldalankent: 25, megerositesTorleskor: true, igazolasSzures: true, kvota: 31457280, hasznaltKvota: Math.round(31457280 * ((box.quotaPct ?? 10) / 100)) }, { json: true });
    }
    const folderMatch = /^tarhely\.gov\.hu\/levelezes\/api\/uzenetek\/(BEERKEZETT|TARTOS_TAR|ELKULDOTT)\/kereses$/.exec(p);
    if (folderMatch && method === 'POST') {
      const s = apiSession(init); if (!s) return response(401, { error: 'unauthorized' }, { json: true });
      const box = users[s.user].mailboxes.find(m => m.azonosito === header(init, 'address-id'));
      if (!box) return response(403, { error: 'forbidden' }, { json: true }); // más postafiókjához nincs hozzáférés
      let q = {}; try { q = JSON.parse(init.body || '{}'); } catch { return response(400, { error: 'bad request' }, { json: true }); }
      let rows = (folderMatch[1] === 'TARTOS_TAR' ? box.durable : folderMatch[1] === 'ELKULDOTT' ? box.sent : box.letters) || [];
      const from = q.filter && q.filter.incomingFromDate;
      if (from != null) { // a valódi tárhely csak „Z” végű teljes időbélyeget fogad el
        if (typeof from !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(from)) return response(400, { error: 'bad request' }, { json: true });
        rows = rows.filter(l => (l.kuldesiDatum ?? l.erkezesiDatum) >= Date.parse(from));
      }
      const size = Number(q.countPerPage) || PAGE; const page = Number(q.pageNumber) || 0;
      return response(200, { uzenetek: rows.slice(page * size, page * size + size), uzenetekSzama: rows.length,
        pagination: { page, totalItems: rows.length, totalPages: Math.ceil(rows.length / size) }, olvasatlanUzenetekSzama: rows.filter(l => l.olvasatlan).length }, { json: true });
    }
    // Letöltés, az élő próbán (2026-11-12) megfigyelt alakkal: a fájl bájtjai, a fájlnév, a lenyomat és az érkeztetési szám
    // külön válaszfejlécben (content-disposition nincs), és a levél ettől a tárhelyen olvasottá válik. A tartalom jelzett mintaszöveg.
    const dl = /^tarhely\.gov\.hu\/levelezes\/api\/uzenet\/letoltes\/(beerkezett|tartostar|tartos|elkuldott)\/([^/]+)$/.exec(p);
    if (dl && method === 'GET') {
      const s = apiSession(init); if (!s) return response(401, { error: 'unauthorized' }, { json: true });
      const box = users[s.user].mailboxes.find(m => m.azonosito === header(init, 'address-id'));
      if (!box) return response(403, { error: 'forbidden' }, { json: true });
      if (dl[1] === 'tartos') return response(500, { error: {}, success: false, errorCode: 0, messageKey: 'szim.hiba' }, { json: true }); // élőben így válaszol a rövid alakra
      const pool = dl[1] === 'tartostar' ? box.durable : dl[1] === 'elkuldott' ? box.sent : box.letters;
      const hit = (pool || []).find(l => l.erkeztetesiSzam === decodeURIComponent(dl[2]));
      if (!hit) return response(404, { error: 'not found' }, { json: true });
      if (dl[1] !== 'elkuldott') hit.olvasatlan = false;
      return response(200, `<?xml version="1.0" encoding="UTF-8"?><szimulator>SZIMULÁTOR – ez nem valódi irat (${esc(hit.dokumentumTipus)})</szimulator>`,
        { extra: { 'content-type': 'application/xml', filename: 'szimulator-irat.xml', hash: createHash('sha256').update(hit.erkeztetesiSzam).digest('hex'), erkeztetesiszam: hit.erkeztetesiSzam } });
    }
    throw new Error(`A szimulátor számára nem ismert útvonal: ${method} ${p}`);
  }

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (scenario.slowMs) await sleep(scenario.slowMs);
    const res = await route(url, init);
    log.push({ method: init.method || 'GET', host: u.host, path: u.pathname, addressId: header(init, 'address-id'), status: res.status });
    return res;
  };

  const credentials = {};
  for (const [name, user] of Object.entries(users)) credentials[name.split('.')[0]] = { mode: 'totp', username: name, password: user.password, totpSeed: user.totpSeed };

  return { fetchImpl, log, credentials, sessions: () => sessions.size, navSwitches: () => [...navSessions.values()].flatMap(x => x.switches || []), navSelected: () => [...navSessions.values()].map(x => x.selected ?? 10000001) };
}

/** A NAV-portál mintaadatai egy belépőhöz: a megfigyelt mezőnevekkel, kitalált értékekkel. 23 képviselt adózó (lapozáshoz). */
function navOf(user) {
  if (user.nav) return user.nav;
  const profile = (i, stem, name) => ({ id: 2000000 + i, megnevezes: name, adoazonosito: null, adoszam: `${stem}-2-41`, torzsszam: stem, adozoiTipus: 'SZERVEZET', kozossegiAdoszam: `HU${stem}`, vamazonosito: null,
    megbizhatoJel: true, allapotKod: 'AKTIV', partnerAltipusMaganszemely: null, partnerAltipusSzervezet: 'Gazdasági társaság', esetiJel: true, torvenyesKepviselet: false, cimList: [] });
  user.nav = { name: 'SZIMULÁTOR KÖNYVELŐ', taxId: '8400000000',
    profiles: [profile(0, '12345676', 'SZIMULÁTOR – Példa Kereskedelmi Kft'), ...Array.from({ length: 22 }, (_, i) => profile(i + 1, String(30000000 + i * 7), `SZIMULÁTOR – ${i + 1}. Ügyfél Kft`))] };
  return user.nav;
}

/** Az önkormányzati portál mintaadatai egy belépőhöz: a megfigyelt mezőnevekkel, kitalált értékekkel. */
function aspOf(user) {
  if (user.asp) return user.asp;
  const ret = (id, year) => ({ taxCategoryCode: '087', taxCategoryName: 'Helyi iparűzési adó', taxSubjectId: `SZIM-${id}`, taxReturnId: id, fileName: `szimulator-bevallas-${year}.pdf`, comments: `Bevallás adó éve: ${year}` });
  user.asp = { name: 'SZIMULÁTOR KÖNYVELŐ', taxId: '8400000000', tenants: [
    { uid: 'szim-tenant-0001', name: 'SZIMULÁTOR – Példafalva Község Önkormányzata', cityName: 'Példafalva', pir: '700001', code: '0001', services: [], returns: [ret(1, 2024), ret(2, 2025)], cases: [] },
    { uid: 'szim-tenant-0002', name: 'SZIMULÁTOR – Mintaváros Önkormányzata', cityName: 'Mintaváros', pir: '700002', code: '0002', services: [], noBalance: true, returns: [], cases: [{}] },
  ] };
  return user.asp;
}

const addr = label => createHash('sha256').update('szimulator:' + label).digest('hex'); // 64 karakteres, állandó azonosító, mint élőben
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const DAY = 86400000;

/** Levélsor a valódi mezőkkel. `days`: hány napja érkezett / lett elküldve. */
function letter(n, box, { sender = 'NAV', senderFull = 'Nemzeti Adó- és Vámhivatal', type = 'Tájékoztatás', desc = '', days = null, folder = 'BEERKEZETT', rcpt = ['SZIMULÁTOR CÍMZETT', 'SZIMULÁTOR CÍMZETT'], refEid = null, eid = null } = {}) {
  const ts = NOW - (days ?? (n % 27) + 1) * DAY - (n % 600) * 60000;
  const row = {
    erkezesiDatum: ts, cimzettNev: rcpt[0], cimzettRovidNev: rcpt[1], feladoRovidNev: sender, feladoNev: senderFull,
    hozzaferesEngedelyezett: true, dokumentumLeiras: desc,
    tarolasiHely: folder === 'TARTOS_TAR' ? 'TARTOSTAR' : folder === 'ELKULDOTT' ? 'ELKULDOTT' : 'BEERKEZETT',
    fajlMeret: 20000 + n,
    olvasatlan: folder === 'BEERKEZETT', dokumentumTipus: type,
    erkeztetesiSzam: eid ?? (String(100000000000000000000000000n + BigInt(box.length * 1000000 + n)) + box.replace(/\W/g, '')), cimkek: [],
  };
  if (folder === 'ELKULDOTT') row.kuldesiDatum = ts;
  if (refEid != null) row.hivatkozottErkeztetesiSzam = refEid;
  return row;
}

const company = (stem, name, letters, extra = {}) => ({ azonosito: addr(stem), mailboxName: stem, name, type: 'CKP', letters, durable: [], sent: [], ...extra });

/**
 * Könyvelői minta egy belépő mögött: a belépő saját értesítési tárhelye (két ügyféliráttal és egy magánlevéllel, plusz régi
 * levelek a tartós tárban), négy Cégkapu (az egyikben 230 levél a lapozáshoz, egy üres), egy Hivatali kapu.
 * A cégnevekben a SZIMULÁTOR szó áll, hogy az adatbázisba került mintaügyfél megkülönböztethető legyen a valóditól.
 */
function accountantScenario(opts = {}) {
  const co = (stem, name) => [`SZIMULÁTOR – ${name}`, stem];
  const navRcpt = ['Nemzeti Adó- és Vámhivatal', 'NAV'];
  const c1Sent = letter(501, 'C1', { sender: '12345676', senderFull: 'SZIMULÁTOR – Példa Kereskedelmi Kft', type: '2665A', desc: 'ÁFA bevallás beküldése (2665A_12345676241.xml)', days: 1, folder: 'ELKULDOTT', rcpt: navRcpt });
  const ownSent = letter(502, 'OWN', { sender: 'KONYVELO', senderFull: 'SZIMULÁTOR KÖNYVELŐ', type: 'EPAPIR', desc: 'e-Papír kérelem beküldése, adózó: 68412205-1-33', days: 1, folder: 'ELKULDOTT', rcpt: navRcpt });
  const many = Array.from({ length: 230 }, (_, i) => letter(i + 1, 'C3', { type: i % 9 === 0 ? 'Elfogadó nyugta' : 'Tájékoztatás bevallásról', desc: i % 9 === 0 ? `Elfogadó nyugta (2665A_11223346241_Elfogado_Nyu_${1000000000000000 + i}_${1700000000000 + i}.xml)` : 'Tájékoztatás bevallásról', rcpt: co('11223346', 'Béta Tech Zrt') }));
  return {
    ...opts,
    users: {
      'konyvelo.teszt': {
        password: 'szimulator-jelszo', totpSeed: 'JBSWY3DPEHPK3PXP',
        mailboxes: [
          { azonosito: addr('sajat'), mailboxName: 'értesítési tárhely', name: 'értesítési tárhely', type: 'AP', defaultMailbox: true, quotaPct: 26.5,
            letters: [
              letter(1, 'OWN', { type: 'Elfogadó nyugta', desc: 'Elfogadó nyugta (2658A_68412205133_Elfogado_Nyu_1000000000000001_1700000000001.xml)', days: 1 }),
              letter(2, 'OWN', { type: 'felhivas', desc: 'Felszólítás bevallás pótlására, adózó: 68412205-1-33', days: 2 }),
              letter(3, 'OWN', { sender: 'ASPONALLO', senderFull: 'Önkormányzati adóhatóság', type: 'Értesítés', desc: 'Gépjárműadó-értesítés', days: 20 }),
            ],
            durable: [letter(4, 'OWN', { type: 'Igazolás', desc: 'Régi igazolás', days: 200, folder: 'TARTOS_TAR' }), letter(5, 'OWN', { sender: 'OBHIFORM', senderFull: 'Országos Bírósági Hivatal', type: 'OBH_UKE_KIADMANY', desc: 'Végzés', days: 300, folder: 'TARTOS_TAR' })],
            sent: [ownSent] },
          company('12345676', 'SZIMULÁTOR – Példa Kereskedelmi Kft', [
            letter(1, 'C1', { type: 'Elfogadó nyugta', desc: 'Elfogadó nyugta (2665A_12345676241_Elfogado_Nyu_1000000000000002_1700000000002.xml)', days: 1, rcpt: co('12345676', 'Példa Kereskedelmi Kft'), refEid: c1Sent.erkeztetesiSzam }),
            letter(2, 'C1', { type: 'Illeték fizetési meghagyás', desc: 'Illeték fizetési meghagyás', days: 12, rcpt: co('12345676', 'Példa Kereskedelmi Kft') }),
          ], { quotaPct: 3.9, sent: [c1Sent] }),
          company('87654323', 'SZIMULÁTOR – Alfa Építő Bt', [letter(1, 'C2', { type: 'Tájékoztatás bevallásról', desc: 'Tájékoztatás bevallásról', days: 5, rcpt: co('87654323', 'Alfa Építő Bt') })]),
          company('11223346', 'SZIMULÁTOR – Béta Tech Zrt', many, { quotaPct: 88 }),
          company('55443320', 'SZIMULÁTOR – Gamma Szolgáltató Kft', []),
          { azonosito: addr('hk'), mailboxName: 'MINTAONK', name: 'SZIMULÁTOR – Minta Önkormányzat', type: 'HKP', letters: [letter(1, 'HK', { sender: 'MAK', senderFull: 'Magyar Államkincstár', type: 'Értesítés', desc: 'Támogatási kérelem', days: 3 })], durable: [], sent: [] },
        ],
      },
    },
  };
}

module.exports = { createGovTwin, accountantScenario };
