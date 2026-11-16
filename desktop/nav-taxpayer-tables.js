// NAV ügyfélportál – Adózói táblák élő olvasása (C kör; docs/adr/ADR-010):
//   1. Biztosítottak (foglalkoztatói T1041 jogviszonyok)
//   2. Saját foglalkoztatók (természetes személy / egyéni vállalkozó saját biztosítotti jogviszonyai)
//   3. Egyszerűsített foglalkoztatottak – Bejelentések és éves összevont Napkeret (EFO / T1042E)
//   4. Adategyeztetések (NAV adategyeztető kampányok listája)
//
// Fontos védelem (ADR-010):
//   - A foglalkoztatói / foglalkoztatási POST-lekérdezések előtt a hivatalos ÜPO felülethez hasonlóan lekérdezi az
//     `adozoi-profilok/{id}/biztositasi-tipusok` végpontot (`FOGLALKOZTATO`, illetve nem szervezetnél `FOGLALKOZTATAS`),
//     így nem indít felesleges POST-ot (és nem ütközik 403-ba), ha az adózónál az adott jogviszonytípus nem él.
//   - Csak a lenti, szigorúan engedélyezett NAV-útvonalakra küld kérést, átirányítást nem követ, egy részterület hibája
//     nem állítja meg a többit (a lejárt munkamenet igen).
'use strict';

const H = require('./tarhely-http');

const HOST = 'ugyfelportal.nav.gov.hu';
const BASE = `https://${HOST}`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MAX_FILE = 10 * 1024 * 1024;
const realSleep = ms => new Promise(r => setTimeout(r, ms));

const PATHS = {
  reconciliations: '/api/v1/dialog/survey-from-joker/list',
  employerInsured: '/api/foglalkoztato-lekerdezesek/biztositotti-fajlba',
  employerInsuredExport: '/api/foglalkoztato-lekerdezesek/biztositotti-fajlba/export',
  ownEmployers: '/api/foglalkoztatas-lekerdezesek/biztositotti-fajlba',
  ownEmployersExport: '/api/foglalkoztatas-lekerdezesek/biztositotti-fajlba/export',
  efoDeclarations: '/api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett/',
  efoDeclarationsLast: '/api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett/last',
  efoPrevReported: '/api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett-korabban-bejelentett/',
  efoPrevReportedLast: '/api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett-korabban-bejelentett/last',
  efoPrevReportedExport: '/api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett-korabban-bejelentett/export',
  efoEmployeeQuota: '/api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett-adozo-adatai/',
  efoEmployeeQuotaLast: '/api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett-adozo-adatai/last',
};

const RE_INSURANCE_TYPES = /^\/api\/foglalkoztatas-lekerdezesek\/adozoi-profilok\/\d{1,12}\/biztositasi-tipusok$/;
const RE_MUNKAVALLALOK = /^\/api\/foglalkoztatas-lekerdezesek\/adozoi-profilok\/\d{1,12}\/munkavallalok$/;
const RE_EMPLOYER_INSURED_LAST = /^\/api\/foglalkoztato-lekerdezesek\/biztositotti-fajlba\/adozoi-profilok\/\d{1,12}\/eredmenyek\/utolso$/;
const RE_OWN_EMPLOYERS_LAST = /^\/api\/foglalkoztatas-lekerdezesek\/biztositotti-fajlba\/adozoi-profilok\/\d{1,12}\/eredmenyek\/utolso$/;

const POST_ALLOWED = new Set([
  PATHS.employerInsured,
  PATHS.ownEmployers,
  PATHS.efoDeclarations,
  PATHS.efoPrevReported,
  PATHS.efoPrevReportedExport,
  PATHS.efoEmployeeQuota,
]);

const GET_ALLOWED = new Set([
  PATHS.reconciliations,
  PATHS.employerInsuredExport,
  PATHS.ownEmployersExport,
  PATHS.efoDeclarationsLast,
  PATHS.efoPrevReportedLast,
  PATHS.efoEmployeeQuotaLast,
]);

function allowed(pathname, method = 'GET') {
  if (method === 'GET') {
    return GET_ALLOWED.has(pathname)
      || RE_INSURANCE_TYPES.test(pathname)
      || RE_MUNKAVALLALOK.test(pathname)
      || RE_EMPLOYER_INSURED_LAST.test(pathname)
      || RE_OWN_EMPLOYERS_LAST.test(pathname);
  }
  if (method === 'POST') return POST_ALLOWED.has(pathname);
  return false;
}

async function call(ctx, method, pathname, { query = null, json = null, binary = false } = {}) {
  if (!allowed(pathname, method)) {
    if (allowed(pathname, 'GET') || allowed(pathname, 'POST')) throw new Error('Ezen a címen ez a HTTP-metódus nem engedélyezett.');
    throw new Error('Nem engedélyezett NAV-útvonal, megállok.');
  }
  const u = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  H.assertAllowed(u.toString(), [HOST]);
  const headers = {
    'User-Agent': UA,
    'Accept-Language': 'hu-HU,hu;q=0.9',
    Accept: binary ? '*/*' : 'application/json, text/plain, */*',
    Referer: `${BASE}/dashboard`,
  };
  if (json !== null) {
    headers['Content-Type'] = 'application/json';
    headers.Origin = BASE;
  }
  const cookie = ctx.jar.header(u.toString());
  if (cookie) headers.Cookie = cookie;
  const xsrf = ctx.jar.get(u.toString(), 'XSRF-TOKEN');
  if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);

  const res = await (ctx.fetchImpl || fetch)(u.toString(), {
    method,
    headers,
    body: json !== null ? JSON.stringify(json) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(60000),
  });
  ctx.jar.store(u.toString(), res.headers.getSetCookie ? res.headers.getSetCookie() : []);

  if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
    await res.arrayBuffer().catch(() => {});
    throw new Error('A NAV-portál munkamenete nem érvényes, vagy a munkamenet lejárt.');
  }
  if (res.status !== 200) {
    await res.arrayBuffer().catch(() => {});
    throw new Error(`A NAV-portál nem várt választ adott (HTTP ${res.status}).`);
  }
  if (binary) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE) throw new Error('A letöltött fájl túl nagy.');
    if (!buf.subarray(0, 4).toString('latin1').startsWith('PK')) throw new Error('A NAV nem XLSX fájlt adott vissza.');
    return buf;
  }
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { throw new Error('A NAV-portál válasza nem JSON.'); }
}

const str = (v, n = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const iso = d => d.toISOString().slice(0, 10);
const dayStart = d => `${iso(d)}T00:00:00.000000`;

function unwrapDate(v) {
  if (!v) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    for (const k of ['naptolDtoNapKezdete', 'napDtoNapKezdete', 'napigDtoKovNapKezdete', 'idopontDto', 'datum', 'date', 'value']) {
      if (typeof v[k] === 'string' && v[k].trim()) return v[k];
    }
  }
  return null;
}

function isoDate(v) {
  const raw = unwrapDate(v);
  if (!raw) return null;
  const m = /^(\d{4})[-.](\d{2})[-.](\d{2})/.exec(raw.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function isoDateTime(v) {
  const raw = unwrapDate(v);
  if (!raw) return null;
  const m = /^(\d{4})[-.](\d{2})[-.](\d{2})(?:[T\s](\d{2}:\d{2}))?/.exec(raw.trim());
  if (!m) return null;
  return m[4] ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}` : `${m[1]}-${m[2]}-${m[3]}`;
}

function taxId10(v) {
  const clean = String(v || '').replace(/\D/g, '');
  return /^8\d{9}$/.test(clean) ? clean : null;
}

function tajOf(v) {
  const d = String(v || '').replace(/\D/g, '');
  return /^\d{9}$/.test(d) ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : null;
}

function parsePartyIds(obj) {
  let taxNumber = null;
  let taxId = null;
  const candidates = [
    obj.foglalkoztatoAdoszama,
    obj.adoszam,
    obj.foglalkoztatoAdoazonositoJele,
    obj.adoazonositoJel,
    obj.foglalkoztatoAdoalanyAzonositoja,
    obj.adoalanyAzonosito,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const s = String(raw).trim();
    const mTax = /^(\d{8})(?:-?(\d)-?(\d{2}))?$/.exec(s);
    if (mTax && !taxNumber) {
      taxNumber = mTax[2] ? `${mTax[1]}-${mTax[2]}-${mTax[3]}` : mTax[1];
      continue;
    }
    const tid = taxId10(s);
    if (tid && !taxId) taxId = tid;
  }
  return { taxNumber, taxId };
}

function extractWeeklyHours(x) {
  if (Array.isArray(x.hetiOra) && x.hetiOra.length) {
    const valid = x.hetiOra
      .filter(h => h && h.hetiMunkaora != null && Number.isFinite(Number(h.hetiMunkaora)))
      .sort((a, b) => String(unwrapDate(a.hetiMunkaoraKezdeteDat) || '').localeCompare(String(unwrapDate(b.hetiMunkaoraKezdeteDat) || '')));
    if (valid.length) return Number(valid[valid.length - 1].hetiMunkaora);
  }
  for (const cand of [x.hetiOra, x.hetiMunkaora, x.hetiMunkaorakSzama, x.bejelentes && x.bejelentes[0] && x.bejelentes[0].hetiMunkaorakSzama]) {
    if (cand != null && typeof cand !== 'object' && cand !== '' && Number.isFinite(Number(cand))) return Number(cand);
  }
  return null;
}

function mapInsuredPerson(x, todayIso) {
  if (!x || typeof x !== 'object') return null;
  const name = str(x.munkavallaloNeve || x.nev, 200);
  if (!name) return null;
  const end = isoDate(x.jogviszonyVege);
  return {
    name,
    tax_id: taxId10(x.munkavallaloAdoazonositoJele || x.adoazonosito || x.adoazonositoJel),
    taj: tajOf(x.tajSzam || x.munkavallaloTajSzama || (Array.isArray(x.bejelentes) && x.bejelentes[0] && x.bejelentes[0].tajSzam)),
    relationship_start: isoDate(x.jogviszonyKezdete),
    relationship_end: end,
    relationship_type: str(x.jogviszonyKodMegnevezes || x.jogviszonyMegnevezes || x.jogviszonyKod, 200),
    weekly_hours: extractWeeklyHours(x),
    status: end && end < todayIso ? 'closed' : 'active',
  };
}

function mapEmployer(x, todayIso) {
  if (!x || typeof x !== 'object') return null;
  const employerName = str(x.foglalkoztatoNeve || x.nev, 200);
  if (!employerName) return null;
  const { taxNumber, taxId } = parsePartyIds(x);
  const end = isoDate(x.jogviszonyVege);
  return {
    employer_name: employerName,
    employer_tax_number: taxNumber,
    employer_tax_id: taxId,
    relationship_start: isoDate(x.jogviszonyKezdete),
    relationship_end: end,
    relationship_type: str(x.jogviszonyKodMegnevezes || x.jogviszonyMegnevezes || x.jogviszonyKod, 200),
    weekly_hours: extractWeeklyHours(x),
    status: end && end < todayIso ? 'closed' : 'active',
  };
}

const EFO_TYPE_LABELS = {
  ALKALMI_MUNKA: 'Alkalmi munka',
  MEZOGAZDASAGI_IDENYMUNKA: 'Mezőgazdasági idénymunka',
  TURISZTIKAI_IDENYMUNKA: 'Turisztikai idénymunka',
  FILMIPARI_STATISZTA: 'Filmipari statiszta',
};

const EFO_STATUS_LABELS = {
  ELFOGADOTT: 'Befogadva',
  FELDOLGOZOTT: 'Befogadva',
  BEFOGADOTT: 'Befogadva',
  FELDOLGOZAS_ALATT: 'Feldolgozás alatt',
  HIBAS: 'Hibás',
  ELUTASITOTT: 'Elutasított',
  TOROLT: 'Törölt',
};

const EFO_FILING_LABELS = {
  UJ: 'Új',
  ALAPBEJELENTES: 'Új',
  TORLES: 'Törlés',
  MODOSITAS: 'Módosítás',
  HELYESBITES: 'Helyesbítés',
};

function mapEfoDeclaration(x) {
  if (!x || typeof x !== 'object') return null;
  const employeeName = str(x.munkavallaloNeve || x.nev, 200);
  const startDate = isoDate(x.foglalkoztatasKezdete || x.kezdoNap);
  if (!employeeName || !startDate) return null;
  const lapRaw = x.foglalkoztatasiLapokAdatai;
  const lap = Array.isArray(lapRaw) ? (lapRaw[0] || {}) : (lapRaw && typeof lapRaw === 'object' ? lapRaw : {});
  const rawType = str(x.foglalkoztatasJellege, 120);
  const rawStatus = str(lap.adatlapStatusz || x.adatlapStatusz || x.allapot, 60);
  const rawFiling = str(x.adatbejelentesJellege || lap.adatbejelentesJellege, 60);
  const days = Number(x.munkaviszonyNapjainakSzama ?? x.napokSzama);
  const seq = lap.potlapSorszama ?? x.sorszam;
  return {
    employee_name: employeeName,
    employee_tax_id: taxId10(x.munkavallaloAdoazonositoJele || x.adoazonosito),
    employee_taj: tajOf(x.munkavallaloTajSzama || x.tajSzam),
    declaration_code: str(lap.adatlapTipusa || x.adatlapTipusa || 'T1042E', 40),
    employment_type: (rawType && EFO_TYPE_LABELS[rawType]) || rawType,
    start_date: startDate,
    end_date: isoDate(x.foglalkoztatasVege || x.zaroNap) || startDate,
    days_count: Number.isFinite(days) && days > 0 ? Math.round(days) : 1,
    reg_no: str(lap.adatlapIktatoszam || lap.adatlapIktatoszama || x.iktatoszam, 60),
    status: (rawStatus && EFO_STATUS_LABELS[rawStatus]) || rawStatus || 'Befogadva',
    filing_type: (rawFiling && EFO_FILING_LABELS[rawFiling]) || rawFiling || 'Új',
    submitted_at: isoDateTime(x.adatlapbeerkezesDatuma || lap.adatlapbeerkezesDatuma || x.benyujtasIdopontja),
    seq_no: seq != null && seq !== '' && Number.isFinite(Number(seq)) ? Number(seq) : null,
  };
}

function mapEfoQuota(x, year, fallbackEmp = {}) {
  if (!x || typeof x !== 'object') return null;
  const employeeName = str(x.munkavallaloNeve || x.nev || fallbackEmp.employee_name, 200);
  const employeeTaxId = taxId10(x.munkavallaloAdoazonosito || x.munkavallaloAdoazonositoJele || x.adoazonosito || fallbackEmp.employee_tax_id);
  if (!employeeName && !employeeTaxId) return null;
  const reusedUsed = x.adatlapbeerkezesDatuma != null && /^\d+$/.test(String(x.adatlapbeerkezesDatuma).trim()) ? Number(x.adatlapbeerkezesDatuma) : undefined;
  const reusedRem = x.foglalkoztatasKezdete != null && /^\d+$/.test(String(x.foglalkoztatasKezdete).trim()) ? Number(x.foglalkoztatasKezdete) : undefined;
  const used = Number(x.felhasznaltNapok ?? x.felhasznaltNapokSzama ?? reusedUsed ?? 0);
  const remRaw = x.felhasznalhatoNapok ?? x.hatralevoNapok ?? reusedRem;
  const limitRaw = x.keretNapok ?? x.osszesKeret;
  const usedSafe = Number.isFinite(used) && used >= 0 ? Math.round(used) : 0;
  let limitSafe = Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0 ? Math.round(Number(limitRaw)) : null;
  let remSafe = remRaw != null && Number.isFinite(Number(remRaw)) ? Math.max(0, Math.round(Number(remRaw))) : null;
  if (limitSafe === null && remSafe !== null) limitSafe = usedSafe + remSafe;
  if (limitSafe === null) limitSafe = 120;
  if (remSafe === null) remSafe = Math.max(0, limitSafe - usedSafe);
  const rawType = str(x.foglalkoztatasJellege || fallbackEmp.employment_type, 120);
  return {
    year,
    employee_name: employeeName,
    employee_tax_id: employeeTaxId,
    employee_taj: tajOf(x.munkavallaloTajszam || x.munkavallaloTajSzama || x.tajSzam || x.adatbejelentesJellege || fallbackEmp.employee_taj),
    employment_type: (rawType && EFO_TYPE_LABELS[rawType]) || rawType || 'Egyszerűsített foglalkoztatás (összevont)',
    quota_limit: limitSafe,
    used_days: usedSafe,
    remaining_days: remSafe,
  };
}

function mapReconciliation(s, bucket) {
  if (!s || typeof s !== 'object') return null;
  const reconcilerName = str(s.nev || s.megnevezes || s.kampanyNev, 200);
  if (!reconcilerName) return null;
  const submittedDate = isoDateTime(s.bekuldesIdopontja || s.bekuldesDatum);
  const createdDate = isoDate(s.kikuldesDatum || s.letrehozasDatum || s.kezdete) || (submittedDate ? submittedDate.slice(0, 10) : null);
  if (!createdDate) return null;
  let status = str(s.statuszMegnevezes || s.allapotMegnevezes, 60);
  if (!status) {
    if (submittedDate) status = 'Beküldve';
    else status = bucket === 'closed' ? 'Lezárt' : 'Folyamatban';
  }
  return {
    reconciler_name: reconcilerName,
    status,
    case_number: s.kampanyAzonosito != null ? String(s.kampanyAzonosito).slice(0, 80) : str(s.azonosito || s.ugyszam, 80),
    created_date: createdDate,
    submitted_date: submittedDate,
    notes: str(s.leiras || s.megjegyzes, 300),
  };
}

async function poll(check, { sleep, random, tries = 14 }) {
  for (let i = 0; i < tries; i++) {
    await sleep(Math.round(1500 + random() * 1500));
    const r = await check();
    if (r) return r;
  }
  throw new Error('A NAV-lekérdezés nem készült el időben.');
}

/**
 * Adategyeztetések olvasása (`GET /api/v1/dialog/survey-from-joker/list`).
 */
async function readReconciliations(ctx) {
  const res = await call(ctx, 'GET', PATHS.reconciliations);
  const running = Array.isArray(res && res.runningSurveys) ? res.runningSurveys : [];
  const closed = Array.isArray(res && res.closedSurveys) ? res.closedSurveys : [];
  const items = [
    ...running.map(x => mapReconciliation(x, 'running')),
    ...closed.map(x => mapReconciliation(x, 'closed')),
  ].filter(Boolean);
  return items.slice(0, 500);
}

async function queryAsyncRelationshipList(ctx, { postPath, lastPath, exportPath, profileId, isEmployer, today, sleep, random }) {
  const start = new Date(Date.UTC(today.getFullYear(), 0, 1));
  const next = new Date(today.getTime() + 86400000);
  const body = {
    adozoiProfilId: profileId,
    lang: 'hu',
    bejelentesNapja: null,
    nev: null,
    nevAdoszam: null,
    jogviszonyTipus: 'NYITOTT',
    adatlapStatusz: null,
    ...(isEmployer ? { adoazonosito: null } : { adoszam: null }),
    lekerdezesiIdoszakKezdete: { naptolDtoNapKezdete: dayStart(start) },
    lekerdezesiIdoszakVege: { napigDtoKovNapKezdete: dayStart(next) },
  };
  const created = await call(ctx, 'POST', postPath, { json: body });
  const id = created && Number.isInteger(created.id) ? created.id : null;
  const done = await poll(async () => {
    const r = (await call(ctx, 'GET', lastPath)) || {};
    if (id !== null && r.lekerdezesId != null && r.lekerdezesId !== id) return null;
    if (r.errorMessage) throw new Error('A NAV a biztosítotti lekérdezésre hibát adott.');
    if (Array.isArray(r.biztositottiJogviszonyok)) return { rows: r.biztositottiJogviszonyok, eredmenyId: r.lekerdezesEredmenyId };
    if (Number.isInteger(r.lekerdezesEredmenyId)) return { rows: null, eredmenyId: r.lekerdezesEredmenyId };
    return null;
  }, { sleep, random });

  const todayIso = iso(today);
  if (Array.isArray(done.rows)) {
    const mapper = isEmployer ? mapInsuredPerson : mapEmployer;
    return { items: done.rows.map(x => mapper(x, todayIso)).filter(Boolean).slice(0, 1000), xlsxBase64: null };
  }
  await sleep(Math.round(800 + random() * 800));
  const buf = await call(ctx, 'GET', exportPath, {
    query: { eredmenyId: done.eredmenyId, lekerdezesEredmenyId: done.eredmenyId, riportTipus: 'XLSX', hitelesitett: false, tipus: 'XLSX', lang: 'hu' },
    binary: true,
  });
  return { items: null, xlsxBase64: buf.toString('base64') };
}

async function pollRegistryLast(ctx, lastPath, expectedId, { sleep, random, tries = 8 }) {
  for (let i = 0; i < tries; i++) {
    await sleep(Math.round(1200 + random() * 1000));
    const r = await call(ctx, 'GET', lastPath);
    if (!r) {
      if (i >= 4) return null;
      continue;
    }
    const q = r.query || {};
    if (expectedId !== null && q.lekerdezesId != null && q.lekerdezesId !== expectedId) {
      if (i >= 4) return null;
      continue;
    }
    if (q.allapot === 'ELUTASITOTT') {
      if (/nincs/i.test(String(q.errorMessage || ''))) return { empty: true };
      throw new Error('A NAV az egyszerűsített foglalkoztatási lekérdezést elutasította.');
    }
    if (q.allapot === 'FELDOLGOZOTT' || r.result != null || Array.isArray(r.egyszerusitettFoglalkoztatasok)) {
      return r;
    }
  }
  return null;
}

async function readEfoData(ctx, { profileId, today, sleep, random }) {
  // Gyors GET előellenőrzés a hivatalos szűrő erőforrás-végpontján: ha 0 EFO munkavállaló van bejelentve az adózónál,
  // felesleges háttér-lekérdezést (POST) sem indítunk, azonnal üres listát adunk vissza.
  try {
    const empRes = await call(ctx, 'GET', `/api/foglalkoztatas-lekerdezesek/adozoi-profilok/${profileId}/munkavallalok`, {
      query: { biztositottiTipus: 'EGYSZERUSITETT' },
    });
    if (empRes && Array.isArray(empRes.munkavallalok) && empRes.munkavallalok.length === 0) {
      return { declarations: [], quotas: [], quotasXlsxBase64: null };
    }
  } catch (e) {
    if (/munkamenet/.test(String(e && e.message))) throw e;
  }

  const year = today.getFullYear();
  const from = `${year}-01-01`;
  const to = iso(today);
  const res = await call(ctx, 'POST', PATHS.efoDeclarations, {
    json: {
      adozoiProfilId: profileId,
      lang: 'hu',
      lekerdezesiIdoszakKezdete: from,
      lekerdezesiIdoszakVege: to,
      bejelentesNapja: null,
      nev: null,
      nevAdoszam: null,
      adoazonosito: null,
      jogviszonyTipus: 'MINDKETTO',
      adatlapStatusz: null,
    },
  });

  let rawRows = (res && res.result && res.result.egyszerusitettResponse && res.result.egyszerusitettResponse.egyszerusitettFoglalkoztatasok)
    || (res && res.egyszerusitettFoglalkoztatasok);
  if (!Array.isArray(rawRows)) {
    const qid = res && Number.isInteger(res.id) ? res.id : (res && res.query && Number.isInteger(res.query.lekerdezesId) ? res.query.lekerdezesId : null);
    const last = await pollRegistryLast(ctx, PATHS.efoDeclarationsLast, qid, { sleep, random });
    rawRows = (last && last.result && last.result.egyszerusitettResponse && last.result.egyszerusitettResponse.egyszerusitettFoglalkoztatasok)
      || (last && last.egyszerusitettFoglalkoztatasok) || [];
  }
  const declarations = (Array.isArray(rawRows) ? rawRows : []).map(mapEfoDeclaration).filter(Boolean).slice(0, 1000);

  // Napkeret: először a tömeges „korábban bejelentett munkavállalók” lekérdezést próbáljuk (JSON lista vagy XLSX),
  // majd ha nincs inline lista/XLSX, a bejelentésekben szereplő egyedi munkavállalókra (legfeljebb 15 fő) kérdezzük le az éves keretet.
  let quotas = [];
  let quotasXlsxBase64 = null;
  try {
    await sleep(Math.round(800 + random() * 800));
    let prev = await call(ctx, 'POST', PATHS.efoPrevReported, { json: { adozoiProfilId: profileId, lang: 'hu' } });
    if (prev && !prev.result && (Number.isInteger(prev.id) || (prev.query && Number.isInteger(prev.query.lekerdezesId)))) {
      const pid = Number.isInteger(prev.id) ? prev.id : prev.query.lekerdezesId;
      prev = (await pollRegistryLast(ctx, PATHS.efoPrevReportedLast, pid, { sleep, random })) || prev;
    }
    const prevResp = (prev && prev.result && (prev.result.korabbanBejelentettResponse || (prev.result.egyszerusitettResponse && prev.result.egyszerusitettResponse.egyszerusitettFoglalkoztatasok))) || prev || {};
    const inlineArr = prevResp.korabbanBejelentettek || prevResp.munkavallalok || prevResp.adozoAdataiList || (Array.isArray(prevResp) ? prevResp : null);
    if (Array.isArray(inlineArr)) {
      quotas = inlineArr.map(x => mapEfoQuota(x, year)).filter(Boolean);
    } else {
      const qid = (prev && prev.query && prev.query.lekerdezesId) ?? (prev && prev.lekerdezesId);
      if (Number.isInteger(qid) && !(prev && prev.empty)) {
        await sleep(Math.round(800 + random() * 800));
        const buf = await call(ctx, 'POST', PATHS.efoPrevReportedExport, {
          json: { eredmenyId: qid, lekerdezesId: qid, lang: 'hu', riportTipus: 'XLSX', hitelesitett: false, tipus: 'XLSX' },
          binary: true,
        });
        quotasXlsxBase64 = buf.toString('base64');
      }
    }
  } catch (e) {
    if (/munkamenet/.test(String(e && e.message))) throw e;
  }

  if (!quotas.length && !quotasXlsxBase64 && declarations.length) {
    const seen = new Map();
    for (const d of declarations) {
      if (d.employee_tax_id && d.employee_name && !seen.has(d.employee_tax_id)) seen.set(d.employee_tax_id, d);
    }
    for (const emp of [...seen.values()].slice(0, 15)) {
      try {
        await sleep(Math.round(600 + random() * 600));
        const tajDigits = emp.employee_taj ? emp.employee_taj.replace(/\D/g, '') : null;
        let qr = await call(ctx, 'POST', PATHS.efoEmployeeQuota, {
          json: {
            adozoiProfilId: profileId,
            lang: 'hu',
            targyEv: year,
            adoazonosito: emp.employee_tax_id,
            nev: emp.employee_name,
            munkavallaloTajSzama: tajDigits || null,
            masholBiztositott: !tajDigits,
          },
        });
        if (qr && !qr.result && (Number.isInteger(qr.id) || (qr.query && Number.isInteger(qr.query.lekerdezesId)))) {
          const eid = Number.isInteger(qr.id) ? qr.id : qr.query.lekerdezesId;
          qr = (await pollRegistryLast(ctx, PATHS.efoEmployeeQuotaLast, eid, { sleep, random })) || qr;
        }
        const respRaw = (qr && qr.result && (qr.result.adozoAdataiResponse || (qr.result.egyszerusitettResponse && qr.result.egyszerusitettResponse.egyszerusitettFoglalkoztatasok && qr.result.egyszerusitettResponse.egyszerusitettFoglalkoztatasok[0]))) || qr;
        const mapped = mapEfoQuota(respRaw, year, emp);
        if (mapped) quotas.push(mapped);
      } catch (e) {
        if (/munkamenet/.test(String(e && e.message))) throw e;
      }
    }
  }

  return { declarations, quotas, quotasXlsxBase64 };
}

/**
 * Mind a 4 hiányzó adózói táblacsoport kiolvasása a munkamenet KIVÁLASZTOTT adózójára:
 *   - Adategyeztetések (`reconciliations`)
 *   - Biztosítottak (`insured_persons` / `insured_xlsx_base64`)
 *   - Saját foglalkoztatók (`employers` / `employers_xlsx_base64`) — csak ha nem `SZERVEZET`
 *   - EFO Bejelentések és Napkeret (`efo_declarations`, `efo_quotas`, `efo_quotas_xlsx_base64`)
 */
async function readTaxpayerTables(ctx, { profileId, kind = null, today = new Date(), sleep = realSleep, random = Math.random, onStep = null } = {}) {
  if (!Number.isInteger(profileId) || profileId <= 0) throw new Error('Érvénytelen adózói profil az adózói táblákhoz.');
  const pause = () => sleep(Math.round(800 + random() * 800));
  const report = t => { if (onStep) try { onStep(t); } catch { /* a visszahívás hibája nem állíthatja meg a futást */ } };
  const out = {
    reconciliations: null,
    insured_persons: null,
    insured_xlsx_base64: null,
    employers: null,
    employers_xlsx_base64: null,
    efo_declarations: null,
    efo_quotas: null,
    efo_quotas_xlsx_base64: null,
  };
  const notes = [];
  const step = async (label, fn) => {
    try { await fn(); } catch (e) {
      if (/munkamenet/.test(String(e && e.message))) throw e;
      notes.push(`${label}: ${String((e && e.message) || e).slice(0, 160)}`);
    }
  };

  // 1. Adategyeztetések
  report('adategyeztetések olvasása');
  await pause();
  await step('adategyeztetések', async () => {
    out.reconciliations = await readReconciliations(ctx);
  });

  // 2. Foglalkoztatói jogviszonytípusok (Biztosítottak + EFO előellenőrzés)
  let employerTypes = null;
  report('foglalkoztatói jogviszonyok ellenőrzése');
  await pause();
  await step('foglalkoztatói típusok', async () => {
    const r = await call(ctx, 'GET', `/api/foglalkoztatas-lekerdezesek/adozoi-profilok/${profileId}/biztositasi-tipusok`, { query: { kategoria: 'FOGLALKOZTATO' } });
    employerTypes = Array.isArray(r && r.elerhetoBiztositottiTipusok) ? r.elerhetoBiztositottiTipusok : [];
  });

  if (Array.isArray(employerTypes)) {
    if (employerTypes.includes('BIZTOSITAS')) {
      report('biztosítottak (T1041) lekérdezése');
      await pause();
      await step('biztosítottak', async () => {
        const res = await queryAsyncRelationshipList(ctx, {
          postPath: PATHS.employerInsured,
          lastPath: `/api/foglalkoztato-lekerdezesek/biztositotti-fajlba/adozoi-profilok/${profileId}/eredmenyek/utolso`,
          exportPath: PATHS.employerInsuredExport,
          profileId,
          isEmployer: true,
          today,
          sleep,
          random,
        });
        if (res.items !== null) out.insured_persons = res.items;
        if (res.xlsxBase64) out.insured_xlsx_base64 = res.xlsxBase64;
      });
    } else {
      out.insured_persons = [];
    }

    if (employerTypes.includes('EGYSZERUSITETT')) {
      report('egyszerűsített foglalkoztatás (EFO) és napkeret');
      await pause();
      await step('egyszerűsített foglalkoztatás', async () => {
        const efo = await readEfoData(ctx, { profileId, today, sleep, random });
        out.efo_declarations = efo.declarations;
        out.efo_quotas = efo.quotas;
        if (efo.quotasXlsxBase64) out.efo_quotas_xlsx_base64 = efo.quotasXlsxBase64;
      });
    } else {
      out.efo_declarations = [];
      out.efo_quotas = [];
    }
  }

  // 3. Saját foglalkoztatók: kizárólag természetes személy / egyéni vállalkozó esetén (társaságnak nincs saját foglalkoztatója)
  const isOrg = typeof kind === 'string' && kind.toUpperCase().includes('SZERVEZET');
  if (isOrg) {
    out.employers = [];
  } else {
    let ownTypes = null;
    report('saját biztosítotti jogviszonyok ellenőrzése');
    await pause();
    await step('foglalkoztatási típusok', async () => {
      const r = await call(ctx, 'GET', `/api/foglalkoztatas-lekerdezesek/adozoi-profilok/${profileId}/biztositasi-tipusok`, { query: { kategoria: 'FOGLALKOZTATAS' } });
      ownTypes = Array.isArray(r && r.elerhetoBiztositottiTipusok) ? r.elerhetoBiztositottiTipusok : [];
    });
    if (Array.isArray(ownTypes)) {
      if (ownTypes.includes('BIZTOSITAS')) {
        report('saját foglalkoztatók lekérdezése');
        await pause();
        await step('saját foglalkoztatók', async () => {
          const res = await queryAsyncRelationshipList(ctx, {
            postPath: PATHS.ownEmployers,
            lastPath: `/api/foglalkoztatas-lekerdezesek/biztositotti-fajlba/adozoi-profilok/${profileId}/eredmenyek/utolso`,
            exportPath: PATHS.ownEmployersExport,
            profileId,
            isEmployer: false,
            today,
            sleep,
            random,
          });
          if (res.items !== null) out.employers = res.items;
          if (res.xlsxBase64) out.employers_xlsx_base64 = res.xlsxBase64;
        });
      } else {
        out.employers = [];
      }
    }
  }

  return { tables: out, notes };
}

/** A többi NAV-adat mellé fűzhető burkoló: hiba esetén sem dobja el a már kiolvasott adatokat (kivéve lejárt munkamenet). */
async function withTaxpayerTables(ctx, profileId, data, { kind = null, today = new Date(), sleep = realSleep, random = Math.random, onStep = null } = {}) {
  if (!Number.isInteger(profileId) || profileId <= 0) return data;
  try {
    const r = await readTaxpayerTables(ctx, { profileId, kind, today, sleep, random, onStep });
    return { ...data, taxpayerTables: r.tables, taxpayerTablesInfo: { notes: r.notes } };
  } catch (e) {
    if (/munkamenet/.test(String(e && e.message))) throw e;
    return { ...data, taxpayerTables: null, taxpayerTablesInfo: { error: String((e && e.message) || e).slice(0, 160), notes: [] } };
  }
}

module.exports = {
  PATHS,
  allowed,
  readReconciliations,
  readTaxpayerTables,
  withTaxpayerTables,
  mapInsuredPerson,
  mapEmployer,
  mapEfoDeclaration,
  mapEfoQuota,
  mapReconciliation,
};
