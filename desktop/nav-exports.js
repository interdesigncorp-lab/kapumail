// NAV ügyfélportál – letölthető kimutatások (C kör; docs/adr/ADR-010). Kérésre, ügyfelenként, külön kapcsoló mögött.
//
// Mit tud (a megfigyelt forgalom – 2026-11-13 – és a portál nyilvános felületkódja alapján):
//   - adószámla: tételes lekérdezés indítása az idei évre (POST), megvárja a feldolgozást, majd letölti PDF-ben
//     (hitelesített) és XLSX-ben;
//   - törzsadat (saját adatok): PDF;
//   - biztosítottak (foglalkoztatóként tett bejelentések): lekérdezés indítása az idei évre (POST), megvárja, majd XLSX.
// Az adószámla- és a biztosítotti lekérdezés a NAV oldalán lekérdezést hoz létre, ugyanúgy, mint a portálon kézzel. Más
// módosító kérést a modul nem küld; csak a lenti útvonalakra, csak a munkamenet KIVÁLASZTOTT adózójára.
// ÉLŐBEN NEM IGAZOLT a program által küldve.
'use strict';

const H = require('./tarhely-http');

const HOST = 'ugyfelportal.nav.gov.hu';
const BASE = `https://${HOST}`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const P = {
  account: '/api/v1/balance/tax-invoice', accountLast: '/api/v1/balance/tax-invoice/last', accountExport: '/api/v1/balance/tax-invoice/export',
  ownData: '/api/v1/user/own-data/export',
  insured: '/api/foglalkoztato-lekerdezesek/biztositotti-fajlba', insuredExport: '/api/foglalkoztato-lekerdezesek/biztositotti-fajlba/export',
};
const INSURED_LAST = /^\/api\/foglalkoztato-lekerdezesek\/biztositotti-fajlba\/adozoi-profilok\/\d{1,12}\/eredmenyek\/utolso$/;
const KINDS = ['adoszamla', 'torzsadat', 'biztositottak'];
const MAX_FILE = 10 * 1024 * 1024;
const realSleep = ms => new Promise(r => setTimeout(r, ms));
const iso = d => d.toISOString().slice(0, 10);
const dayStart = d => `${iso(d)}T00:00:00.000000`;

function allowed(pathname) {
  return Object.values(P).includes(pathname) || INSURED_LAST.test(pathname);
}

async function call(ctx, method, pathname, { query = null, json = null, binary = false } = {}) {
  if (!allowed(pathname)) throw new Error('Nem engedélyezett NAV-útvonal, megállok.');
  if (method !== 'GET' && ![P.account, P.insured].includes(pathname)) throw new Error('Ezen a címen csak olvasás engedélyezett.');
  const u = new URL(BASE + pathname); for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, String(v));
  H.assertAllowed(u.toString(), [HOST]);
  const headers = { 'User-Agent': UA, 'Accept-Language': 'hu-HU,hu;q=0.9', Accept: binary ? '*/*' : 'application/json, text/plain, */*', Referer: `${BASE}/dashboard` };
  if (json) { headers['Content-Type'] = 'application/json'; headers.Origin = BASE; }
  const cookie = ctx.jar.header(u.toString()); if (cookie) headers.Cookie = cookie;
  const xsrf = ctx.jar.get(u.toString(), 'XSRF-TOKEN'); if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);
  const res = await (ctx.fetchImpl || fetch)(u.toString(), { method, headers, body: json ? JSON.stringify(json) : undefined, redirect: 'manual', signal: AbortSignal.timeout(90000) });
  ctx.jar.store(u.toString(), res.headers.getSetCookie ? res.headers.getSetCookie() : []);
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) { await res.arrayBuffer().catch(() => {}); throw new Error('A NAV-portál munkamenete nem érvényes, vagy a munkamenet lejárt.'); }
  if (res.status !== 200) { await res.arrayBuffer().catch(() => {}); throw new Error(`A NAV-portál nem várt választ adott (HTTP ${res.status}).`); }
  if (binary) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE) throw new Error('A letöltött fájl túl nagy.');
    return { buf, type: String(res.headers.get('content-type') || '').split(';')[0] };
  }
  const text = await res.text(); try { return text ? JSON.parse(text) : null; } catch { throw new Error('A NAV-portál válasza nem JSON.'); }
}

/** A fájl valóban a várt formátum-e (a tartalom elejéből). */
function sniff(buf, format) {
  const head = buf.subarray(0, 8).toString('latin1');
  if (format.includes('PDF')) return head.startsWith('%PDF-');
  if (format === 'XLSX') return head.startsWith('PK');
  if (format === 'XML') return /^\s*</.test(buf.subarray(0, 64).toString('utf8').replace(/^﻿/, ''));
  return false;
}

async function download(ctx, pathname, query, format) {
  const { buf } = await call(ctx, 'GET', pathname, { query, binary: true });
  if (!sniff(buf, format)) throw new Error(`A NAV nem ${format.includes('PDF') ? 'PDF' : format} fájlt adott vissza.`);
  return buf;
}

/** Vár, amíg a `check` eredményt ad (vagy hibát jelez). Kíméletes: 3–5 mp-enként, legfeljebb ~90 mp-ig. */
async function poll(check, { sleep, random, tries = 20 }) {
  for (let i = 0; i < tries; i++) {
    await sleep(Math.round(3000 + random() * 2000));
    const r = await check(); if (r) return r;
  }
  throw new Error('A NAV-lekérdezés nem készült el időben; később újra lehet próbálni.');
}

async function accountStatement(ctx, profileId, { today, sleep, random }) {
  const from = `${today.getFullYear()}-01-01`, to = iso(today);
  const created = await call(ctx, 'POST', P.account, { json: { adozoiProfilId: profileId, lang: 'hu', tobbevesCheck: false, idoszakKezdete: from, idoszakVege: to, adoszamlaTipus: 'TETELES',
    adonemAzonosioList: [], adonemSzuresText: 'Összes adónem kijelölve', iratszam: null, konyvelesreVar: true } });
  const id = created && Number.isInteger(created.id) ? created.id : null;
  const result = await poll(async () => {
    const r = await call(ctx, 'GET', P.accountLast); const q = (r && r.query) || {};
    if (id !== null && q.lekerdezesId !== id) return null;
    if (q.allapot === 'ELUTASITOTT') throw new Error('A NAV az adószámla-lekérdezést elutasította.');
    return q.allapot === 'FELDOLGOZOTT' && r.result && Number.isInteger(r.result.eredmenyId) ? r.result.eredmenyId : null;
  }, { sleep, random });
  const files = [];
  for (const format of ['PDF_HITELESITETT', 'XLSX']) {
    await sleep(Math.round(1000 + random() * 1000));
    const buf = await download(ctx, P.accountExport, { lekerdezesEredmenyId: result, riportTipus: format, hitelesitett: format === 'PDF_HITELESITETT', tipus: format, lang: 'hu' }, format);
    files.push({ kind: 'adoszamla', format, from, to, base64: buf.toString('base64'), bytes: buf.length });
  }
  return files;
}

async function ownData(ctx, adozoTipus) {
  const buf = await download(ctx, P.ownData, { riportTipus: 'PDF', adozoTipus, hitelesitett: false, tipus: 'PDF', lang: 'hu' }, 'PDF');
  return [{ kind: 'torzsadat', format: 'PDF', base64: buf.toString('base64'), bytes: buf.length }];
}

async function insured(ctx, profileId, { today, sleep, random }) {
  const start = new Date(Date.UTC(today.getFullYear(), 0, 1)), next = new Date(today.getTime() + 86400000);
  const created = await call(ctx, 'POST', P.insured, { json: { adozoiProfilId: profileId, lang: 'hu', bejelentesNapja: null, nev: null, nevAdoszam: null, jogviszonyTipus: 'NYITOTT', adatlapStatusz: null, adoazonosito: null,
    lekerdezesiIdoszakKezdete: { naptolDtoNapKezdete: dayStart(start) }, lekerdezesiIdoszakVege: { napigDtoKovNapKezdete: dayStart(next) } } });
  const id = created && Number.isInteger(created.id) ? created.id : null;
  const last = `/api/foglalkoztato-lekerdezesek/biztositotti-fajlba/adozoi-profilok/${profileId}/eredmenyek/utolso`;
  const resultId = await poll(async () => {
    const r = await call(ctx, 'GET', last) || {};
    if (id !== null && r.lekerdezesId !== id) return null;
    if (r.errorMessage) throw new Error('A NAV a biztosítotti lekérdezésre hibát adott.');
    return Number.isInteger(r.lekerdezesEredmenyId) ? r.lekerdezesEredmenyId : null;
  }, { sleep, random });
  await sleep(Math.round(1000 + random() * 1000));
  const buf = await download(ctx, P.insuredExport, { eredmenyId: resultId, lekerdezesEredmenyId: resultId, riportTipus: 'XLSX', hitelesitett: false, tipus: 'XLSX', lang: 'hu' }, 'XLSX');
  return [{ kind: 'biztositottak', format: 'XLSX', from: iso(start), to: iso(today), base64: buf.toString('base64'), bytes: buf.length }];
}

/**
 * A kért kimutatások a munkamenet KIVÁLASZTOTT adózójára. Egy fajta hibája nem állítja meg a többit (az oka a `notes`-ba
 * kerül); a lejárt munkamenet igen.
 * @param profileId a kiválasztott adózó adózói profiljának azonosítója; @param adozoTipus 'TERMESZETESSZEMELY' vagy 'CEG'
 */
async function runExports(ctx, { profileId, adozoTipus, kinds = KINDS, today = new Date(), sleep = realSleep, random = Math.random } = {}) {
  if (!Number.isInteger(profileId) || profileId <= 0) throw new Error('Érvénytelen adózói profil.');
  if (!['TERMESZETESSZEMELY', 'CEG'].includes(adozoTipus)) throw new Error('Ismeretlen adózótípus.');
  const files = [], notes = [];
  const step = async (name, fn) => { try { files.push(...await fn()); } catch (e) { if (/munkamenet/.test(String(e && e.message))) throw e; notes.push(`${name}: ${String((e && e.message) || e).slice(0, 160)}`); } };
  const opt = { today, sleep, random };
  if (kinds.includes('adoszamla')) await step('adószámla', () => accountStatement(ctx, profileId, opt));
  if (kinds.includes('torzsadat')) await step('törzsadat', () => ownData(ctx, adozoTipus));
  if (kinds.includes('biztositottak')) await step('biztosítottak', () => insured(ctx, profileId, opt));
  return { files, notes };
}

module.exports = { runExports, sniff, allowed, KINDS, PATHS: P };
