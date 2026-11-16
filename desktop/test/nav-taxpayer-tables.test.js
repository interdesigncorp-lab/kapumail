// NAV ügyfélportál – Adózói táblák élő HTTP-olvasásának tesztjei (C kör; desktop/nav-taxpayer-tables.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const N = require('../nav-http');
const T = require('../nav-taxpayer-tables');
const { createGovTwin, accountantScenario } = require('../simulator/gov-twin');

const quiet = { sleep: async () => {}, random: () => 0, today: new Date('2026-11-16T09:00:00Z') };

test('saját magánszemély profil: FOGLALKOZTATO=[] esetén nem indít munkáltatói POST-ot, a Saját foglalkoztatókat és Adategyeztetéseket kiolvassa', async () => {
  const twin = createGovTwin(accountantScenario());
  const c = twin.credentials.konyvelo;
  const ctx = await N.loginNav({ username: c.username, password: c.password, seed: c.totpSeed }, { fetchImpl: twin.fetchImpl });
  const own = await N.readOwn(ctx, quiet);

  const out = await T.withTaxpayerTables(ctx, own.user.subjectProfileId, {}, {
    kind: own.user.subjectKind,
    ...quiet,
  });

  assert.ok(out.taxpayerTables);
  assert.deepEqual(out.taxpayerTables.insured_persons, [], 'nem munkáltatónál üres tömb jön 403 nélkül');
  assert.deepEqual(out.taxpayerTables.efo_declarations, []);
  assert.deepEqual(out.taxpayerTables.efo_quotas, []);

  assert.equal(out.taxpayerTables.employers.length, 1);
  assert.deepEqual(out.taxpayerTables.employers[0], {
    employer_name: 'SZIMULÁTOR Foglalkoztató Kft.',
    employer_tax_number: '12345676-2-41',
    employer_tax_id: null,
    relationship_start: '2024-03-01',
    relationship_end: null,
    relationship_type: '1101 - munkaviszony',
    weekly_hours: 40,
    status: 'active',
  });

  assert.equal(out.taxpayerTables.reconciliations.length, 2);
  assert.equal(out.taxpayerTables.reconciliations[0].status, 'Folyamatban');
  assert.equal(out.taxpayerTables.reconciliations[1].status, 'Beküldve');
  assert.equal(out.taxpayerTables.reconciliations[1].submitted_date, '2026-05-18 14:20');

  // FOGLALKOZTATO=[] mellett nem mehetett POST a foglalkoztatói végpontokra
  const empPosts = twin.log.filter(l => l.method === 'POST' && (
    l.path === '/api/foglalkoztato-lekerdezesek/biztositotti-fajlba'
    || l.path.startsWith('/api/v1/registry/foglalkoztato-lekerdezesek/')
  ));
  assert.equal(empPosts.length, 0);
});

test('képviselt cég (SZERVEZET) váltással és queries=true mellett: Biztosítottak, EFO Bejelentések + Napkeret és Adategyeztetések jönnek, Saját foglalkoztatók kimarad', async () => {
  const twin = createGovTwin(accountantScenario());
  const c = twin.credentials.konyvelo;
  const ctx = await N.loginNav({ username: c.username, password: c.password, seed: c.totpSeed }, { fetchImpl: twin.fetchImpl });
  const own = await N.readOwn(ctx, quiet);
  const targets = own.profiles.slice(0, 1);

  const res = await N.readClients(ctx, own.user.profileId, targets, { ...quiet, queries: true });
  assert.equal(res.restored, true);
  assert.equal(res.clients.length, 1);

  const cl = res.clients[0];
  assert.equal(cl.ok, true);
  assert.ok(cl.taxpayerTables);

  // Biztosítottak
  assert.equal(cl.taxpayerTables.insured_persons.length, 1);
  assert.deepEqual(cl.taxpayerTables.insured_persons[0], {
    name: 'SZIMULÁTOR Munkavállaló',
    tax_id: '8400000001',
    taj: '111-222-333',
    relationship_start: '2025-01-15',
    relationship_end: null,
    relationship_type: '1101 - munkaviszony',
    weekly_hours: 40,
    status: 'active',
  });

  // SZERVEZET esetén nincs saját foglalkoztató
  assert.deepEqual(cl.taxpayerTables.employers, []);

  // EFO bejelentés + összevont éves napkeret
  assert.equal(cl.taxpayerTables.efo_declarations.length, 1);
  assert.equal(cl.taxpayerTables.efo_declarations[0].employee_name, 'SZIMULÁTOR Alkalmi Dolgozó');
  assert.equal(cl.taxpayerTables.efo_declarations[0].employee_taj, '222-333-444');
  assert.equal(cl.taxpayerTables.efo_declarations[0].employment_type, 'Alkalmi munka');
  assert.equal(cl.taxpayerTables.efo_declarations[0].declaration_code, '26T1042E');
  assert.equal(cl.taxpayerTables.efo_declarations[0].status, 'Befogadva');
  assert.equal(cl.taxpayerTables.efo_declarations[0].days_count, 3);

  assert.equal(cl.taxpayerTables.efo_quotas.length, 1);
  assert.equal(cl.taxpayerTables.efo_quotas[0].employee_tax_id, '8400000002');
  assert.equal(cl.taxpayerTables.efo_quotas[0].used_days, 12);
  assert.equal(cl.taxpayerTables.efo_quotas[0].remaining_days, 108);
  assert.equal(cl.taxpayerTables.efo_quotas[0].quota_limit, 120);

  // Adategyeztetések
  assert.equal(cl.taxpayerTables.reconciliations.length, 2);
});

test('XLSX tartalékág, részleges hibák szigetelése és lejárt munkamenet azonnali továbbadása', async () => {
  const xlsxBytes = Buffer.from('PK\x03\x04szimulator-xlsx');
  const jar = {
    header: () => 'NAVSESSION=ok; XSRF-TOKEN=teszt-xsrf',
    get: (_u, name) => (name === 'XSRF-TOKEN' ? 'teszt-xsrf' : null),
    store: () => {},
  };

  let seenXsrf = null;
  const mockCtx = {
    jar,
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      if (init.method === 'POST') seenXsrf = init.headers['X-XSRF-TOKEN'];
      if (u.pathname === '/api/v1/dialog/survey-from-joker/list') {
        return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
      }
      if (u.pathname.endsWith('/biztositasi-tipusok')) {
        return new Response(JSON.stringify({ elerhetoBiztositottiTipusok: ['BIZTOSITAS'] }), { status: 200 });
      }
      if (u.pathname === '/api/foglalkoztato-lekerdezesek/biztositotti-fajlba') {
        return new Response(JSON.stringify({ id: 55 }), { status: 200 });
      }
      if (u.pathname === '/api/foglalkoztato-lekerdezesek/biztositotti-fajlba/adozoi-profilok/2000000/eredmenyek/utolso') {
        // Nincs inline biztositottiJogviszonyok tömb -> XLSX export tartalékág lép életbe
        return new Response(JSON.stringify({ lekerdezesId: 55, lekerdezesEredmenyId: 5501 }), { status: 200 });
      }
      if (u.pathname === '/api/foglalkoztato-lekerdezesek/biztositotti-fajlba/export') {
        return new Response(xlsxBytes, { status: 200 });
      }
      return new Response('{}', { status: 404 });
    },
  };

  const r = await T.readTaxpayerTables(mockCtx, { profileId: 2000000, kind: 'SZERVEZET', ...quiet });
  assert.equal(seenXsrf, 'teszt-xsrf', 'POST kéréshez X-XSRF-TOKEN fejléc megy');
  assert.equal(r.tables.reconciliations, null, '403-as részterület null marad, nem törli a meglévőt');
  assert.ok(r.notes.some(n => n.includes('adategyeztetések')));
  assert.equal(r.tables.insured_persons, null);
  assert.equal(r.tables.insured_xlsx_base64, xlsxBytes.toString('base64'));
  assert.deepEqual(r.tables.efo_declarations, []);
  assert.deepEqual(r.tables.employers, []);

  // 401 lejárt munkamenet megállítja a futást
  const expiredCtx = {
    jar,
    fetchImpl: async () => new Response('', { status: 401 }),
  };
  await assert.rejects(
    T.readTaxpayerTables(expiredCtx, { profileId: 2000000, kind: 'SZERVEZET', ...quiet }),
    /munkamenet/
  );
});

test('nav-taxpayer-tables: ha a munkavállaló-lista EFO-ra üres, felesleges POST nélkül [] adódik vissza, aszinkron EFO /last pedig kiolvasódik', async () => {
  const jar = {
    header: () => 'NAVSESSION=ok; XSRF-TOKEN=teszt-xsrf',
    get: (_u, name) => (name === 'XSRF-TOKEN' ? 'teszt-xsrf' : null),
    store: () => {},
  };

  let efoPosts = 0;
  const zeroEfoCtx = {
    jar,
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      if (init.method === 'POST' && u.pathname.includes('egyszerusitett')) efoPosts++;
      if (u.pathname === '/api/v1/dialog/survey-from-joker/list') return new Response(JSON.stringify({ runningSurveys: [], closedSurveys: [] }), { status: 200 });
      if (u.pathname.endsWith('/biztositasi-tipusok')) return new Response(JSON.stringify({ elerhetoBiztositottiTipusok: ['EGYSZERUSITETT'] }), { status: 200 });
      if (u.pathname.endsWith('/munkavallalok') && u.searchParams.get('biztositottiTipus') === 'EGYSZERUSITETT') {
        return new Response(JSON.stringify({ munkavallalok: [] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    },
  };
  const zeroRes = await T.readTaxpayerTables(zeroEfoCtx, { profileId: 2000000, kind: 'SZERVEZET', ...quiet });
  assert.equal(efoPosts, 0, '0 EFO munkavállalónál nem indít POST lekérdezést');
  assert.deepEqual(zeroRes.tables.efo_declarations, []);
  assert.deepEqual(zeroRes.tables.efo_quotas, []);

  // Aszinkron EFO lekérdezés adozoiProfilId + lang ellenőrzéssel és /last lekérdezéssel
  let seenBodies = [];
  const asyncEfoCtx = {
    jar,
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      if (init.method === 'POST') seenBodies.push({ path: u.pathname, body: JSON.parse(init.body) });
      if (u.pathname === '/api/v1/dialog/survey-from-joker/list') return new Response(JSON.stringify({ runningSurveys: [], closedSurveys: [] }), { status: 200 });
      if (u.pathname.endsWith('/biztositasi-tipusok')) return new Response(JSON.stringify({ elerhetoBiztositottiTipusok: ['EGYSZERUSITETT'] }), { status: 200 });
      if (u.pathname.endsWith('/munkavallalok')) return new Response(JSON.stringify({ munkavallalok: [{ adoazonositoJel: '8400000002', megnevezes: 'Teszt Dolgozó' }] }), { status: 200 });
      if (u.pathname === '/api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett/') return new Response(JSON.stringify({ id: 91 }), { status: 200 });
      if (u.pathname === '/api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett/last') {
        return new Response(JSON.stringify({
          query: { lekerdezesId: 91, allapot: 'FELDOLGOZOTT' },
          result: { egyszerusitettResponse: { egyszerusitettFoglalkoztatasok: [{ munkavallaloNeve: 'Teszt Dolgozó', munkavallaloAdoazonositoJele: '8400000002', munkavallaloTajSzama: '111222333', foglalkoztatasKezdete: '2026-10-05', foglalkoztatasJellege: 'ALKALMI_MUNKA' }] } },
        }), { status: 200 });
      }
      if (u.pathname === '/api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett-korabban-bejelentett/') return new Response(JSON.stringify({ id: 92 }), { status: 200 });
      if (u.pathname === '/api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett-korabban-bejelentett/last') {
        return new Response(JSON.stringify({ query: { lekerdezesId: 92, allapot: 'FELDOLGOZOTT' }, result: { korabbanBejelentettResponse: [] } }), { status: 200 });
      }
      if (u.pathname === '/api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett-adozo-adatai/') return new Response(JSON.stringify({ id: 93 }), { status: 200 });
      if (u.pathname === '/api/v1/registry/foglalkoztato-lekerdezesek/egyszerusitett-adozo-adatai/last') {
        return new Response(JSON.stringify({
          query: { lekerdezesId: 93, allapot: 'FELDOLGOZOTT' },
          result: { egyszerusitettResponse: { egyszerusitettFoglalkoztatasok: [{ munkavallaloNeve: 'Teszt Dolgozó', munkavallaloAdoazonositoJele: '8400000002', adatbejelentesJellege: '111222333', adatlapbeerkezesDatuma: '8', foglalkoztatasKezdete: '112' }] } },
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    },
  };
  const asyncRes = await T.readTaxpayerTables(asyncEfoCtx, { profileId: 2000000, kind: 'SZERVEZET', ...quiet });
  assert.ok(seenBodies.every(b => b.body.adozoiProfilId === 2000000 && b.body.lang === 'hu'), 'minden EFO POST tartalmazza az adozoiProfilId és lang mezőt');
  assert.equal(asyncRes.tables.efo_declarations.length, 1);
  assert.equal(asyncRes.tables.efo_quotas.length, 1);
  assert.equal(asyncRes.tables.efo_quotas[0].used_days, 8);
  assert.equal(asyncRes.tables.efo_quotas[0].remaining_days, 112);
});
