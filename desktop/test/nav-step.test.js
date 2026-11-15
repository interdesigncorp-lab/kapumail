// A teljes kapuszinkron 4. lépése (app.html `navPortalStep`) utánzott olvasóval: a szimulátorból kiolvasott adónaptár
// a szervernek szánt kérésben kötelezettségként megy tovább; nem alkalmas belépőnél érthető „kihagyva” szöveg jön,
// és a belépő soha nem kerül „újrakapcsolás kell” állapotba.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const N = require('../nav-http');
const { createGovTwin, accountantScenario } = require('../simulator/gov-twin');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'resources', 'ui', 'app.html'), 'utf8');
const src = html.slice(html.indexOf('/*NAVSTEP*/'), html.indexOf('/*END NAVSTEP*/'));

/** A felület lépése elszigetelve: a `window`, az `api` és a segédek utánzatok. */
function makeStep({ readOwn, server, today = '2026-11-13', office = {} }) {
  const calls = [];
  const api = async (method, url, body) => { calls.push({ method, url, body }); return server ? server(url, body) : {}; };
  const window = { iratkapuDesktop: readOwn ? { nav: { readOwn } } : {} };
  const sysOn = (p, k) => !(p.off || []).includes(k);
  const esc = s => String(s).replace(/[&<>"]/g, '');
  const step = new Function('window', 'api', 'sysOn', 'esc', 'TODAY', 'OFFICE', `${src}\nreturn navPortalStep;`)(window, api, sysOn, esc, today, office);
  return { step, calls };
}
const portal = (over = {}) => ({ id: 7, name: 'Próba belépő', vaultKey: 'portal-7', mine: true, authMode: 'totp', nav: null, ...over });

test('a lépés forrása megvan az app.html-ben, és a régi ablakos ÜPO-bejárást a felület már nem hívja', () => {
  assert.ok(src.includes('async function navPortalStep'));
  assert.equal(/live\.upoSync\(|live\/upo-ingest/.test(html), false);
  assert.equal(/upoState:'need'/.test(html), false, 'a NAV-lépés miatt a belépő nem kerülhet „újrakapcsolás kell” állapotba');
});

test('4. lépés a szimulátor olvasójával: az adónaptár tételei kötelezettségként mennek a szervernek', async () => {
  const twin = createGovTwin(accountantScenario()); const c = twin.credentials.konyvelo;
  const readOwn = async key => {
    assert.equal(key, 'portal-7');
    const ctx = await N.loginNav({ username: c.username, password: c.password, seed: c.totpSeed }, { fetchImpl: twin.fetchImpl });
    return { ok: true, ...(await N.readOwn(ctx, { sleep: async () => {}, today: new Date('2026-11-13T09:00:00Z') })) };
  };
  const { step, calls } = makeStep({ readOwn, server: (url, body) => ({ ok: true, known: 0, suggested: 2, total: 23,
    calendar: { upserted: body.obligations.length, paired: 1, received: body.obligations.length, matched: true, reason: null, client: 'c1' } }) });
  const r = await step(portal());
  assert.equal(r.ok, true);
  assert.equal(r.upserted, 4);
  assert.equal(r.text, 'NAV-portál kiolvasva – 23 képviselt adózó, <b>2 ajánlott ügyfél</b>, 4 adónaptár-tétel frissítve, 1 nyugtával összepárosítva, 1 tétel ismeretlen alakú, kihagyva');
  assert.deepEqual(calls.map(x => [x.method, x.url]), [['POST', 'nav/ingest']]);
  const body = calls[0].body;
  assert.deepEqual(body.subject, { stem: null, taxId: '8400000000', own: true });
  assert.deepEqual(body.obligations[0], { formCode: '2658', title: 'Bevallás a kifizetésekkel, juttatásokkal összefüggő adóról, járulékokról és egyéb adatokról', dueDate: '2026-11-20', periodStart: null, periodEnd: null, status: 'submittable' });
  assert.equal(body.obligations.length, 4);
  assert.equal(JSON.stringify(body).includes('jelszo'), false);
  assert.ok(twin.log.filter(l => l.host === 'ugyfelportal.nav.gov.hu' && l.path.startsWith('/api/v1/') && !/kaulogin/.test(l.path)).every(l => l.method === 'GET'), 'a NAV adatvégpontjaira csak GET megy');
});

test('nem alkalmas belépő: érthető „kihagyva” szöveg, olvasás nélkül, újrakapcsolás kérése nélkül', async () => {
  let reads = 0; const readOwn = async () => { reads++; return { ok: false, ineligible: true, error: 'x' }; };
  const cases = [
    [portal({ off: ['upo'] }), /kikapcsolva ennél a belépőnél/, 0],
    [portal({ mine: false }), /kihagyva: a NAV-adatokat csak a belépő gazdája/, 0],
    [portal({ authMode: 'dap' }), /kihagyva: csak kódos \(Ügyfélkapu\+\) belépővel/, 0],
    [portal({ nav: { at: '2026-11-13 08:00' } }), /ma már kiolvasva/, 0],
    [portal(), /kihagyva: ehhez a belépőhöz nincs elmentve a jelszó és a kódgeneráló kulcs/, 1],
  ];
  for (const [p, re, expectReads] of cases) {
    reads = 0; const { step, calls } = makeStep({ readOwn });
    const r = await step(p);
    assert.match(r.skip, re);
    assert.equal(reads, expectReads);
    assert.equal(calls.some(x => x.url === 'nav/ingest'), false);
    assert.ok(calls.every(x => /^portals\/7\/status$/.test(x.url) && x.body.upoState === 'idle' && !('lastError' in x.body)), 'legfeljebb „még nem futott” állapotba teszi');
  }
  const old = makeStep({ readOwn: null });
  assert.match((await old.step(portal())).skip, /frissebb asztali alkalmazás/);
});

test('a kézi frissítés a napi korlát ellenére is olvas; tiltott belépő kihagyva; olvasási hiba hibaszöveg, nem újrakapcsolás', async () => {
  const ok = makeStep({ readOwn: async () => ({ ok: true, user: {}, profiles: [], obligations: [], subject: null, calendarInfo: {} }), server: () => ({ total: 0, suggested: 0, calendar: { upserted: 0, matched: false, received: 0, reason: 'nosubject' } }) });
  assert.equal((await ok.step(portal({ nav: { at: '2026-11-13 08:00' } }), { daily: false })).text, 'NAV-portál kiolvasva – 0 képviselt adózó');
  assert.match((await makeStep({ readOwn: async () => ({ ok: false, blocked: true, error: 'tiltva' }) }).step(portal())).skip, /hibás jelszó miatt tiltva/);
  const bad = makeStep({ readOwn: async () => ({ ok: false, error: 'A NAV-portál nem várt választ adott (HTTP 503).' }) });
  assert.deepEqual(await bad.step(portal()), { error: 'A NAV-portál nem várt választ adott (HTTP 503).' });
  assert.deepEqual(bad.calls.map(x => x.body), [{ upoState: 'idle' }]);
  const unknown = makeStep({ readOwn: async () => ({ ok: true, user: {}, profiles: [], subject: { stem: '99887766', own: false }, obligations: [{ formCode: 'NAPTAR', dueDate: '2026-12-01' }], calendarInfo: {} }),
    server: () => ({ total: 1, suggested: 0, calendar: { upserted: 0, matched: false, received: 1, reason: 'unknown' } }) });
  assert.match((await unknown.step(portal())).text, /az adónaptár kihagyva: a NAV-nál kiválasztott adózó nem ügyfél/);
  const refused = makeStep({ readOwn: async () => ({ ok: true, obligations: [] }), server: () => { throw new Error('422'); } });
  assert.deepEqual(await refused.step(portal()), { error: 'a NAV-adatokat a szerver nem fogadta be' });
  await assert.rejects(makeStep({ readOwn: async () => ({ ok: true }), server: () => { throw new Error('auth'); } }).step(portal()), /auth/);
});

// ---- B kör: képviselet-váltás az ügyfelek adataihoz (alapból kikapcsolva)
const quietDay = { sleep: async () => {}, today: new Date('2026-11-13T09:00:00Z') };
function switchingReader(twin) {
  const c = twin.credentials.konyvelo;
  // ugyanaz, amit a főfolyamat tesz: saját adatok, majd csak a NAV listáján szereplő, kért adózókra váltás
  return async (key, ids) => {
    const ctx = await N.loginNav({ username: c.username, password: c.password, seed: c.totpSeed }, { fetchImpl: twin.fetchImpl });
    const data = await N.readOwn(ctx, quietDay);
    const want = Array.isArray(ids) ? ids : [];
    if (want.length) { const targets = data.profiles.filter(p => p.stem && want.includes(p.stem)); data.clients = await N.readClients(ctx, data.user.profileId, targets, quietDay); }
    return { ok: true, ...data };
  };
}
const ownAnswer = { ok: true, known: 1, suggested: 0, total: 23, calendar: { upserted: 0, paired: 0, received: 0, matched: true } };

test('B kör kikapcsolva: a lépés nem kér célokat, az olvasó nem kap azonosítót, képviseletet nem vált', async () => {
  const twin = createGovTwin(accountantScenario()); let got = 'nem hívták';
  const reader = switchingReader(twin);
  const { step, calls } = makeStep({ readOwn: (k, ids) => { got = ids; return reader(k, ids); }, server: () => ownAnswer });
  const r = await step(portal());
  assert.equal(r.ok, true); assert.deepEqual(got, []);
  assert.deepEqual(calls.map(x => x.url), ['nav/ingest']);
  assert.deepEqual(twin.navSwitches(), []);
});

test('B kör bekapcsolva: a szerver céljaira vált, az ügyfelek adatai külön kérésben mennek, és a végén visszavált', async () => {
  const twin = createGovTwin(accountantScenario());
  const server = (url, body) => url.startsWith('nav/targets') ? { enabled: true, ids: ['12345676', '30000007', '99999999'] }
    : url === 'nav/ingest-clients' ? { ok: true, saved: body.clients.length, skipped: 0, obligations: 8, restored: body.restored } : ownAnswer;
  const { step, calls } = makeStep({ readOwn: switchingReader(twin), server, office: { nav_switch: true } });
  const r = await step(portal());
  assert.deepEqual(calls.map(x => [x.method, x.url]), [['GET', 'nav/targets?portalId=7'], ['POST', 'nav/ingest'], ['POST', 'nav/ingest-clients']]);
  const body = calls[2].body;
  assert.deepEqual([body.portalId, body.restored, body.clients.map(c => [c.stem, c.taxId, c.account.debt])], [7, true, [['12345676', null, 1000], ['30000007', null, 3000]]], 'csak a NAV listáján szereplő két adózó; az ismeretlen azonosítóra nem vált');
  assert.ok(body.clients.every(c => Array.isArray(c.obligations) && c.obligations.every(o => o.formCode && o.dueDate)));
  assert.match(r.text, /ügyfelenként: <b>2 ügyfél adószámlája és adónaptára frissítve<\/b>/);
  assert.equal(/visszaváltás/.test(r.text), false);
  assert.deepEqual(twin.navSelected(), [10000001]);
});

test('B kör: ha a visszaváltás nem igazolható, a lépés szövege figyelmeztet, és a szerver is megkapja', async () => {
  const readOwn = async () => ({ ok: true, user: { taxId: '8400000000' }, profiles: [], account: null, subject: null, obligations: [], calendarInfo: {},
    clients: { clients: [{ ok: true, stem: '12345676', account: { debt: 1 }, obligations: [] }, { ok: false, stem: '30000007', error: 'x' }], restored: false, skipped: 3, error: 'A NAV-portál munkamenete nem érvényes' } });
  const server = (url, body) => url.startsWith('nav/targets') ? { enabled: true, ids: ['12345676'] } : url === 'nav/ingest-clients' ? { ok: true, saved: 1, skipped: 0, restored: body.restored } : ownAnswer;
  const { step, calls } = makeStep({ readOwn, server, office: { nav_switch: true } });
  const r = await step(portal());
  assert.equal(calls[2].body.restored, false); assert.equal(calls[2].body.clients.length, 1, 'a sikertelen adózó adata nem megy a szervernek');
  assert.match(r.text, /1 adózónál a váltás vagy az olvasás nem sikerült/); assert.match(r.text, /3 ügyfél a következő futásra marad/);
  assert.match(r.text, /a visszaváltás a saját profilodra nem volt igazolható/);
});

// ---- C kör: beadott bevallások (alapból kikapcsolva)
test('C kör: kikapcsolva az olvasó nem kap kérést; bekapcsolva a saját és az ügyfelek bevallásai is a szervernek mennek', async () => {
  const mk = twin => { const c = twin.credentials.konyvelo; let seen = null;
    const readOwn = async (key, ids, queries) => { seen = queries;
      const ctx = await N.loginNav({ username: c.username, password: c.password, seed: c.totpSeed }, { fetchImpl: twin.fetchImpl });
      let data = await N.readOwn(ctx, quietDay);
      if ((ids || []).length) data.clients = await N.readClients(ctx, data.user.profileId, data.profiles.filter(p => ids.includes(p.stem)), { ...quietDay, queries });
      if (queries) data = { ...data, ...(await N.withReturns(ctx, data.subject.taxId, {}, quietDay)), ...(await N.withDocuments(ctx, data.subject.taxId, {}, quietDay)) };
      return { ok: true, ...data }; };
    return { readOwn, seen: () => seen }; };
  const offTwin = createGovTwin(accountantScenario()); const off = mk(offTwin);
  const a = makeStep({ readOwn: off.readOwn, server: () => ownAnswer });
  await a.step(portal());
  assert.equal(off.seen(), false); assert.equal('returns' in a.calls[0].body, false);
  assert.equal(offTwin.log.some(l => l.path === N.RETURNS), false, 'kikapcsolva nincs lekérdezés a NAV felé');

  const twin = createGovTwin(accountantScenario()); const on = mk(twin);
  const server = (url, body) => url.startsWith('nav/targets') ? { enabled: true, ids: ['12345676'] } : url === 'nav/ingest-clients' ? { ok: true, saved: 1, skipped: 0, returns: body.clients[0].returns.length, documents: body.clients[0].documents.length, restored: true } : { ...ownAnswer, returns: body.returns.length, documents: body.documents.length };
  const b = makeStep({ readOwn: on.readOwn, server, office: { nav_switch: true, nav_queries: true } });
  const r = await b.step(portal());
  assert.equal(on.seen(), true);
  assert.deepEqual(b.calls[1].body.returns[0], { regNo: '8100000001', formCode: '2658', title: 'Havi bevallás a kötelezettségekről', periodStart: '2026-09-01', periodEnd: '2026-09-30', submittedAt: '2026-10-12 09:41', state: 'Feldolgozott', kind: 'ALAPBEVALLAS' });
  assert.deepEqual(b.calls[2].body.clients[0].returns.map(x => x.regNo), ['8100000001', '8100000002'], 'az ügyfél saját iktatószámai');
  assert.match(r.text, /4 beadott bevallás frissítve a NAV szerint/);
  assert.deepEqual(b.calls[2].body.clients[0].documents.map(d => d.barcode), ['8100000001', '8100000002']);
  assert.match(r.text, /4 NAV-dokumentum frissítve/);
  assert.equal(b.calls[1].body.documents.length, 2);
  assert.equal(JSON.stringify(b.calls).includes('TITKOS'), false, 'letöltési token nem megy a szervernek');
});

test('szinkron-összesítő sorok: tagolt, magyaros kulcs–érték sorok minden adattal és kattintható ajánlott ügyfél jelvénnyel', async () => {
  assert.ok(html.includes('.rabox>div>b{display:block'), 'a .rabox b nem törheti külön sorba a szövegközi félkövér elemeket');
  assert.ok(html.includes('A szinkronizálás sikeresen elkészült'));
  const readOwn = async () => ({
    ok: true, user: { taxId: '8400000000' }, profiles: [], account: null, subject: { taxId: '8400000000', own: true },
    obligations: [], calendarInfo: {}, returns: [], returnsInfo: { total: 190 }, documents: [], documentsInfo: { total: 33 },
    clients: { clients: [{ ok: true, stem: '12345676', account: { debt: 0 }, obligations: [], returns: [], returnsInfo: { total: 0 }, documents: [], documentsInfo: { total: 0 } }], restored: true, skipped: 0 },
  });
  const server = url => url.startsWith('nav/targets') ? { enabled: true, ids: ['12345676'] }
    : url === 'nav/ingest-clients' ? { ok: true, saved: 1, skipped: 0, returns: 190, documents: 33, restored: true }
    : { ok: true, total: 2, suggested: 1, returns: 0, documents: 0, calendar: { upserted: 0, paired: 0, received: 0, matched: true } };
  const { step } = makeStep({ readOwn, server, office: { nav_switch: true, nav_queries: true } });
  const r = await step(portal());
  assert.deepEqual(r.rows.map(x => x.k), ['NAV képviseletek', 'Saját adónaptár', 'Ügyfelek NAV-adatai', 'Beadott bevallások', 'NAV-dokumentumok']);
  assert.match(r.rows[0].v, /<b>2<\/b> képviselt adózó.*data-sjopen[^>]*>1 ajánlott ügyfél<\/button>/);
  assert.match(r.rows[1].v, /Nincs változás.*0 módosult tétel/);
  assert.match(r.rows[2].v, /<b>1 ügyfél<\/b> adószámlája és adónaptára naprakész/);
  assert.match(r.rows[3].v, /<b>190 bevallás<\/b> átvéve a NAV nyilvántartásából/);
  assert.match(r.rows[4].v, /<b>33 irat<\/b> az elmúlt fél évből/);
});


