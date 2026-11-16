const test = require('node:test');
const assert = require('node:assert');
const A = require('../tarhely-auto');

// --------------------------------------------------- belépő alkalmassága
test('credsUsable: csak teljes, totp-módú belépő alkalmas', () => {
  assert.equal(A.credsUsable({ username: 'u', password: 'p', totpSeed: 'JBSWY3DPEHPK3PXP' }).ok, true);
  assert.equal(A.credsUsable(null).ok, false);
  assert.equal(A.credsUsable({ username: 'u' }).ok, false);
  assert.equal(A.credsUsable({ username: 'u', password: 'p', mode: 'email' }).ok, false);
  assert.equal(A.credsUsable({ username: 'u', password: 'p' }).ok, false, 'kulcs nélkül nem');
});

// --------------------------------------------------- ál-KAÜ-lánc (ügyfelenként eltérő tartalom)
const RFC_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
function resp(status, body, { location = null, setCookie = [], json = false } = {}) {
  const headers = new Map();
  if (location) headers.set('location', location);
  headers.set('content-type', json ? 'application/json' : 'text/html; charset=utf-8');
  return { status, headers: { get: k => headers.get(k.toLowerCase()) ?? null, getSetCookie: () => setCookie },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), arrayBuffer: async () => new ArrayBuffer(0) };
}
// `plan`: username -> { fail?: 'login', mailboxes:[{azonosito,name,rows:[eid...]}] }
function fakeKauFor(plan, seenPasswords) {
  let currentUser = null;
  const autoPost = (name, action) => `<form id="a" method="post" action="${action}"><input type="hidden" name="${name}" value="X"><input type="submit"></form>`;
  return async (url, init) => {
    const u = new URL(url); const p = u.host + u.pathname; const body = init.body || '';
    if (p === 'tarhely.gov.hu/levelezes/login' && init.method !== 'POST') return resp(200, autoPost('SAMLRequest', 'https://kau.gov.hu/proxy/saml/authnrequest'));
    if (p === 'kau.gov.hu/proxy/saml/authnrequest') return resp(303, '', { location: 'https://kau.gov.hu/proxy/saml/authservice' });
    if (p === 'kau.gov.hu/proxy/saml/authservice' && init.method !== 'POST') return resp(200, `<form id="urn:eksz.gov.hu:1.0:azonositas:kau:2:uk:totp" method="post" action="https://kau.gov.hu/proxy/saml/authservice"><input type="hidden" name="x" value="1"><input type="submit"></form>`);
    if (p === 'kau.gov.hu/proxy/saml/authservice' && init.method === 'POST') return resp(200, autoPost('SAMLRequest', 'https://idp.gov.hu/idp/saml/authnrequest/start'));
    if (p === 'idp.gov.hu/idp/saml/authnrequest/start') return resp(303, '', { location: 'https://idp.gov.hu/idp/saml/authnrequest' });
    if (p === 'idp.gov.hu/idp/saml/authnrequest' && init.method !== 'POST') return resp(200, '<form id="login-form" method="post" action="https://idp.gov.hu/idp/saml/authnrequest"><input name="felhasznaloNev" type="text"><input name="jelszo" type="password"><input type="submit"></form>');
    if (p === 'idp.gov.hu/idp/saml/authnrequest' && init.method === 'POST' && body.includes('jelszo=')) {
      const q = new URLSearchParams(body); currentUser = q.get('felhasznaloNev'); if (seenPasswords) seenPasswords.push(q.get('jelszo'));
      if (plan[currentUser]?.fail === 'login') return resp(200, '<form id="login-form" method="post" action="https://idp.gov.hu/idp/saml/authnrequest"><input name="felhasznaloNev" type="text"><input name="jelszo" type="password"></form><div class="alert-danger">Hibás adatok</div>');
      return resp(200, '<form id="login-form" method="post" action="https://idp.gov.hu/idp/saml/authnrequest"><input name="name" type="text"><input name="token" id="identifier" type="text"><input type="submit"></form>');
    }
    if (p === 'idp.gov.hu/idp/saml/authnrequest' && init.method === 'POST' && body.includes('token=')) return resp(200, autoPost('SAMLResponse', 'https://kau.gov.hu/proxy/saml/response'));
    if (p === 'kau.gov.hu/proxy/saml/response') return resp(200, autoPost('SAMLResponse', 'https://tarhely.gov.hu/levelezes/login'));
    if (p === 'tarhely.gov.hu/levelezes/login' && init.method === 'POST') return resp(302, '', { location: 'https://tarhely.gov.hu/levelezes/', setCookie: ['XSRF-TOKEN=x; Path=/; Secure'] });
    if (p === 'tarhely.gov.hu/levelezes/') return resp(200, '<title>BKSZ - Levelezés</title>');
    if (p === 'tarhely.gov.hu/levelezes/api/mailbox/reload') return resp(200, (plan[currentUser]?.mailboxes || []).map(m => ({ azonosito: m.azonosito, mailboxName: m.name })), { json: true });
    if (p === 'tarhely.gov.hu/levelezes/api/uzenetek/BEERKEZETT/kereses') {
      const aid = init.headers['address-id']; const mb = (plan[currentUser]?.mailboxes || []).find(m => m.azonosito === aid);
      const rows = (mb?.rows || []).map(eid => ({ erkeztetesiSzam: eid, erkezesiDatum: '2026-11-04T08:00:00Z' }));
      return resp(200, { uzenetek: rows, uzenetekSzama: rows.length }, { json: true });
    }
    throw new Error('ismeretlen hívás: ' + p);
  };
}

const VAULT = {
  ceg1: { username: 'ceg1', password: 'jelszo1', totpSeed: RFC_SEED, mode: 'totp' },
  ceg2: { username: 'ceg2', password: 'jelszo2', totpSeed: RFC_SEED, mode: 'totp' },
  nincs: { username: 'nincs', password: 'x' }, // kulcs nélkül
};
const getCreds = key => VAULT[key] || null;

test('runClient belép és listáz egy ügyfélnek', async () => {
  const plan = { ceg1: { mailboxes: [{ azonosito: 'A1', name: 'Saját', rows: ['E1', 'E2'] }] } };
  const r = await A.runClient('ceg1', { getCreds, fetchImpl: fakeKauFor(plan), sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.letterCount, 2);
  assert.deepEqual(r.mailboxes.map(m => m.addressId), ['A1']);
});

test('runClient nem dob, ha nincs használható belépő', async () => {
  const r = await A.runClient('nincs', { getCreds, fetchImpl: fakeKauFor({}) });
  assert.equal(r.ok, false);
  assert.match(r.error, /hitelesítő kulcs|belépő/i);
});

test('runClients: egy ügyfél hibája nem állítja meg a többit, és elszigetelt', async () => {
  const plan = {
    ceg1: { fail: 'login' },
    ceg2: { mailboxes: [{ azonosito: 'B1', name: 'Céges', rows: ['X1'] }, { azonosito: 'B2', name: 'Másik', rows: [] }] },
  };
  const seen = [];
  const prog = [];
  const sum = await A.runClients(['ceg1', 'ceg2', 'nincs'], { getCreds, fetchImpl: fakeKauFor(plan, seen), onProgress: r => prog.push(r.key), sleep: async () => {} });
  assert.equal(sum.ran, 3);
  assert.equal(sum.ok, 1);
  assert.equal(sum.failed, 2);
  assert.equal(sum.letterCount, 1);
  assert.deepEqual(prog, ['ceg1', 'ceg2', 'nincs'], 'minden ügyfél lefutott');
  const ceg2 = sum.results.find(r => r.key === 'ceg2');
  assert.equal(ceg2.ok, true);
  assert.equal(ceg2.letters[0].eid, 'X1');
  // a hibás ügyfél jelszavát beküldte, a jóét is; a kettő nem keveredett
  assert.ok(seen.includes('jelszo1') && seen.includes('jelszo2'));
});

test('az eredmény és a részlépések (onStep) semmilyen titkot nem tartalmaznak, és jelzik a postafiókokat', async () => {
  const plan = { ceg1: { mailboxes: [{ azonosito: 'A1', name: 'Saját', rows: ['E1'] }] } };
  const steps = [];
  const sum = await A.runClients(['ceg1'], { getCreds, fetchImpl: fakeKauFor(plan), onStep: s => steps.push(s), sleep: async () => {} });
  assert.ok(steps.some(s => s.phase === 'login' && s.index === 1 && s.total === 1));
  assert.ok(steps.some(s => s.phase === 'mailbox' && s.mailbox === 'Saját' && s.folder === 'Beérkezett' && s.mbIndex === 1 && s.mbTotal === 1));
  const blob = JSON.stringify({ sum, steps });
  for (const secret of ['jelszo1', RFC_SEED, VAULT.ceg1.password]) assert.equal(blob.includes(secret), false, `kiszivárgott: ${secret}`);
});

test('eligibleClients kiszűri az alkalmatlan belépőket', async () => {
  const keys = await A.eligibleClients(['ceg1', 'ceg2', 'nincs', 'ismeretlen'], getCreds);
  assert.deepEqual(keys, ['ceg1', 'ceg2']);
});

// --------------------------------------------------- kímélés: szünet, hibaszámláló, tiltás (a szimulátoron)
const { createGovTwin, accountantScenario } = require('../simulator/gov-twin');

function twoUsers() {
  const sc = accountantScenario();
  const ok = sc.users['konyvelo.teszt'];
  sc.users['masodik.teszt'] = { password: 'masik-jelszo', totpSeed: ok.totpSeed, mailboxes: ok.mailboxes.slice(1, 3) };
  return sc;
}

test('classifyError: a jelszóhiba külön fajta', () => {
  assert.equal(A.classifyError('Hibás felhasználónév vagy jelszó. Hibás felhasználónév vagy jelszó.'), 'password');
  assert.equal(A.classifyError('A postafiók-lista nem jött (HTTP 503).'), 'other');
  assert.equal(A.classifyError(''), 'other');
});

test('jelszóhiba után a belépő azonnal tiltva: a következő futás egyetlen kérést sem küld', async () => {
  const sc = accountantScenario(); sc.users['konyvelo.teszt'].fail = 'password';
  const twin = createGovTwin(sc); const state = {};
  const opts = { getCreds: async k => twin.credentials[k], fetchImpl: twin.fetchImpl, state, sleep: async () => {} };

  const first = await A.runClients(['konyvelo'], opts);
  assert.equal(first.results[0].ok, false);
  assert.match(state.konyvelo.blocked, /jelszó/i);
  const calls = twin.log.length;

  const second = await A.runClients(['konyvelo'], opts);
  assert.equal(twin.log.length, calls, 'tiltott belépővel nincs hálózati kérés');
  assert.equal(second.results[0].skipped, true);
  assert.match(second.results[0].error, /tiltva|szünetel/i);

  A.unblock(state, 'konyvelo'); // a belépési adatok újramentése feloldja
  assert.equal(state.konyvelo.blocked, null);
  assert.equal(state.konyvelo.fails, 0);
});

test('három egymást követő más hiba után tiltva; a siker nullázza a számlálót', async () => {
  const twin = createGovTwin(accountantScenario({ sessionCalls: 1 })); // a postafiók-lista megjön, az első levéllista már nem
  const state = {};
  const opts = { getCreds: async k => twin.credentials[k], fetchImpl: twin.fetchImpl, state, sleep: async () => {} };
  await A.runClients(['konyvelo'], opts); assert.equal(state.konyvelo.fails, 1); assert.equal(state.konyvelo.blocked, null);
  await A.runClients(['konyvelo'], opts); assert.equal(state.konyvelo.fails, 2); assert.equal(state.konyvelo.blocked, null);
  await A.runClients(['konyvelo'], opts); assert.equal(state.konyvelo.fails, 3); assert.match(state.konyvelo.blocked, /három/i);

  const good = createGovTwin(accountantScenario()); const st2 = { konyvelo: { fails: 2, blocked: null, lastError: 'x', lastOkAt: null } };
  await A.runClients(['konyvelo'], { getCreds: async k => good.credentials[k], fetchImpl: good.fetchImpl, state: st2, sleep: async () => {} });
  assert.equal(st2.konyvelo.fails, 0);
  assert.equal(st2.konyvelo.lastError, null);
  assert.ok(st2.konyvelo.lastOkAt > 0);
});

test('szünetek: postafiókok között 1–2 mp, belépők között 3–6 mp', async () => {
  const twin = createGovTwin(twoUsers()); const waits = [];
  const sum = await A.runClients(['konyvelo', 'masodik'], { getCreds: async k => twin.credentials[k], fetchImpl: twin.fetchImpl, sleep: async ms => { waits.push(ms); } });
  assert.equal(sum.ok, 2);
  const short = waits.filter(ms => ms >= 1000 && ms <= 2000), long = waits.filter(ms => ms >= 3000 && ms <= 6000);
  // Teljes listázás: postafiókonként három kérés (Beérkezett, tartós tár, telítettség), köztük szünet; a 230 leveles fióknál két további lap.
  assert.equal(short.length, (6 * 3 - 1) + 2 + (2 * 3 - 1), 'minden kérés között szünet, belépőnként az első kivételével');
  assert.equal(long.length, 1, 'a két belépő között egyszer');
  assert.equal(short.length + long.length, waits.length, 'más várakozás nincs');
});

test('az állapot belépőnként, azonnal mentődik; a kihagyott (tiltott) belépő nem írja felül a közben feloldott tiltást', () => {
  const blocked = { fails: 1, blocked: 'Hibás jelszó', lastError: 'x', lastOkAt: null };
  const snapshot = { a: { ...blocked }, b: { fails: 1, blocked: null, lastError: 'y', lastOkAt: null } };
  // A futás közben a felhasználó újramentette az „a” belépő adatait: a lemezen már nincs tiltva.
  let disk = { a: { fails: 0, blocked: null, lastError: null, lastOkAt: null }, c: { fails: 2, blocked: null, lastError: 'z', lastOkAt: null } };

  disk = A.mergeResult(disk, snapshot, { key: 'a', ok: false, skipped: true });
  assert.equal(disk.a.blocked, null, 'a kihagyott belépő állapota érintetlen');
  disk = A.mergeResult(disk, snapshot, { key: 'b', ok: false });
  assert.deepEqual(disk.b, snapshot.b);
  assert.equal(disk.c.fails, 2, 'más belépő állapota megmarad');
});

test('blockedReason és recordFailure: az ablakos belépés is ugyanazt a tiltást látja és írja', () => {
  const st = {};
  assert.equal(A.blockedReason(st, 'k'), null);
  A.recordFailure(st, 'k', 'Hibás felhasználónév vagy jelszó.');
  assert.match(A.blockedReason(st, 'k'), /jelszó/i);
  const st2 = {};
  A.recordFailure(st2, 'k', 'időtúllépés'); A.recordFailure(st2, 'k', 'időtúllépés');
  assert.equal(A.blockedReason(st2, 'k'), null);
  A.recordSuccess(st2, 'k');
  assert.equal(st2.k.fails, 0);
});

// --------------------------------------------------- növekményes listázás
test('listingWindow: első alkalommal és hetente teljes lista, közben csak az újak, három nap átfedéssel', () => {
  const now = Date.UTC(2026, 10, 12, 9, 0, 0), day = 86400000;
  assert.deepEqual(A.listingWindow(undefined, now), { full: true, since: null });
  assert.deepEqual(A.listingWindow({ ackAt: now - day, ackFullAt: null }, now), { full: true, since: null });
  assert.deepEqual(A.listingWindow({ ackAt: now - day, ackFullAt: now - 8 * day }, now), { full: true, since: null });
  const w = A.listingWindow({ ackAt: now - day, ackFullAt: now - 2 * day }, now);
  assert.equal(w.full, false);
  assert.equal(w.since.getTime(), now - day - 3 * day);
});

test('a második futás növekményes: kevesebb kérés és csak a friss levelek; a tartós tárhoz és a telítettséghez nem nyúl', async () => {
  const twin = createGovTwin(accountantScenario()); const state = {};
  const simNow = Date.UTC(2026, 10, 12, 9, 0, 0);
  const opts = { getCreds: async k => twin.credentials[k], fetchImpl: twin.fetchImpl, state, sleep: async () => {}, now: () => simNow };

  const first = await A.runClients(['konyvelo'], opts);
  assert.equal(first.results[0].full, true);
  const firstCalls = twin.log.length;
  A.acknowledge(state, 'konyvelo', { full: true, at: simNow - 86400000 }); // tegnap a szerver befogadta a teljes listát

  const second = await A.runClients(['konyvelo'], opts);
  const calls = twin.log.slice(firstCalls);
  assert.equal(second.results[0].full, false);
  assert.ok(second.results[0].letterCount < first.results[0].letterCount);
  assert.ok(second.results[0].letterCount > 0);
  assert.ok(calls.every(c => !c.path.includes('TARTOS_TAR') && !c.path.endsWith('/mailbox/details')), 'növekményes futásban nincs tartós tár és telítettség');
  const api = list => list.filter(c => c.path.includes('/api/uzenetek/') || c.path.endsWith('/mailbox/details')).length; // a belépés 12 kérése mindkét futásban ugyanannyi
  assert.ok(api(calls) < api(twin.log.slice(0, firstCalls)) / 2, 'jóval kevesebb listázó kérés, mint a teljes listázásnál');
  assert.equal(state.konyvelo.ackFullAt, simNow - 86400000, 'a teljes listázás ideje nem íródik felül');
});

// --------------------------------------------------- a vízjel csak a szerver visszaigazolása után lép előre
test('a növekményes ablak a SZERVER által visszaigazolt futáshoz igazodik, nem a sikeres listázáshoz', async () => {
  const twin = createGovTwin(accountantScenario()); const state = {};
  const simNow = Date.UTC(2026, 10, 12, 9, 0, 0);
  const opts = { getCreds: async k => twin.credentials[k], fetchImpl: twin.fetchImpl, state, sleep: async () => {}, now: () => simNow };

  assert.equal((await A.runClients(['konyvelo'], opts)).results[0].full, true);
  // A listázás sikerült, de a szerver még nem fogadta be (például nem volt elérhető): a következő futás megint teljes.
  assert.equal((await A.runClients(['konyvelo'], opts)).results[0].full, true);

  A.acknowledge(state, 'konyvelo', { full: true, at: simNow - 86400000 });
  const third = await A.runClients(['konyvelo'], opts);
  assert.equal(third.results[0].full, false);
  A.acknowledge(state, 'konyvelo', { full: false, at: simNow });
  assert.equal(state.konyvelo.ackFullAt, simNow - 86400000, 'növekményes visszaigazolás nem írja át a teljes listázás idejét');
});

test('teljes listázás kell, ha a felület kéri vagy ha megváltozott a postafiók-szűrő', async () => {
  const twin = createGovTwin(accountantScenario()); const state = {};
  const simNow = Date.UTC(2026, 10, 12, 9, 0, 0);
  const base = { getCreds: async k => twin.credentials[k], fetchImpl: twin.fetchImpl, state, sleep: async () => {}, now: () => simNow };
  await A.runClients(['konyvelo'], base);
  A.acknowledge(state, 'konyvelo', { full: true, at: simNow - 3600000 });

  assert.equal((await A.runClients(['konyvelo'], base)).results[0].full, false);
  assert.equal((await A.runClients(['konyvelo'], { ...base, forceFull: { konyvelo: true } })).results[0].full, true, 'új postafiók került a belépő alá');
  A.acknowledge(state, 'konyvelo', { full: true, at: simNow - 3600000 });
  const filter = { known: [], deny: [], unknown: 'taxNamed' };
  assert.equal((await A.runClients(['konyvelo'], { ...base, filters: { konyvelo: filter } })).results[0].full, true, 'megváltozott a szűrő');
  A.acknowledge(state, 'konyvelo', { full: true, at: simNow - 3600000 });
  assert.equal((await A.runClients(['konyvelo'], { ...base, filters: { konyvelo: filter } })).results[0].full, false, 'azonos szűrővel már növekményes');
});

test('a futó átadja a belépő munkamenetét a hívónak (a letöltéshez), de az eredménybe nem teszi bele', async () => {
  const { createGovTwin, accountantScenario } = require('../simulator/gov-twin');
  const twin = createGovTwin(accountantScenario());
  const got = {};
  const sum = await A.runClients(['konyvelo'], { getCreds: async k => twin.credentials[k], fetchImpl: twin.fetchImpl, sleep: async () => {}, onSession: (key, ctx) => { got[key] = ctx; } });
  assert.equal(sum.ok, 1);
  assert.ok(got.konyvelo && got.konyvelo.jar && got.konyvelo.mailboxes.length === 6);
  assert.equal(JSON.stringify(sum).includes('JSESSIONID'), false);
  assert.equal('ctx' in sum.results[0], false);
});

test('letöltés a megőrzött munkamenettel: a postafiókot név szerint keresi, szünetet tart, lejáratnál eldobja a munkamenetet', async () => {
  const { createGovTwin, accountantScenario } = require('../simulator/gov-twin');
  const twin = createGovTwin(accountantScenario());
  const sessions = A.makeSessions({ ttlMs: 60000, now: () => 1000 });
  const sum = await A.runClients(['konyvelo'], { getCreds: async k => twin.credentials[k], fetchImpl: twin.fetchImpl, sleep: async () => {}, onSession: sessions.put });
  const own = sum.results[0].letters.find(l => l.mailbox.startsWith('értesítési tárhely'));
  const waits = []; const sleep = async ms => { waits.push(ms); };
  const second = sum.results[0].letters.find(l => l.mailbox === own.mailbox && l.eid !== own.eid && l.folder === 'BEERKEZETT');
  const sent = () => twin.log.filter(x => x.path.includes('/letoltes/')).length;
  const a = await A.downloadWithSession(sessions, 'konyvelo', { eid: own.eid, mailbox: own.mailbox, folder: 'BEERKEZETT' }, { sleep, random: () => 0 });
  const b = await A.downloadWithSession(sessions, 'konyvelo', { eid: second.eid, mailbox: own.mailbox, folder: 'BEERKEZETT' }, { sleep, random: () => 0 });
  assert.deepEqual([a.ok, b.ok, waits.length, sent()], [true, true, 1, 2], 'az első előtt nincs szünet, a második előtt van');
  const again = await A.downloadWithSession(sessions, 'konyvelo', { eid: own.eid, mailbox: own.mailbox, folder: 'BEERKEZETT' }, { sleep });
  assert.deepEqual([again.ok, again.bytesBase64 === a.bytesBase64, sent()], [true, true, 2], 'ugyanazt az iratot egy futásban nem kérjük le kétszer: a megőrzött fájl megy vissza');
  assert.equal((await A.downloadWithSession(sessions, 'konyvelo', { eid: own.eid, mailbox: 'Nincs ilyen', folder: 'BEERKEZETT' }, { sleep })).ok, false);
  assert.equal((await A.downloadWithSession(sessions, 'masik', { eid: own.eid, mailbox: own.mailbox, folder: 'BEERKEZETT' }, { sleep })).needSession, true);
  const old = A.makeSessions({ ttlMs: 10, now: (() => { let t = 0; return () => (t += 100); })() });
  old.put('k', { mailboxes: [] });
  assert.equal(old.get('k'), null, 'a lejárt munkamenetet nem adja vissza');
});

test('letöltések egy futásban: párhuzamos hívásnál is sorban mennek, és a futás korlátja fölött nem megy ki kérés', async () => {
  const { createGovTwin, accountantScenario } = require('../simulator/gov-twin');
  const twin = createGovTwin(accountantScenario());
  const sessions = A.makeSessions({ maxDownloads: 3 });
  const sum = await A.runClients(['konyvelo'], { getCreds: async k => twin.credentials[k], fetchImpl: twin.fetchImpl, sleep: async () => {}, onSession: sessions.put });
  const big = sum.results[0].letters.filter(l => l.mailbox === '11223346' && l.folder === 'BEERKEZETT').slice(0, 5);
  let active = 0, peak = 0; const sleep = async () => { active += 1; peak = Math.max(peak, active); await new Promise(r => setImmediate(r)); active -= 1; };
  const out = await Promise.all(big.map(l => A.downloadWithSession(sessions, 'konyvelo', { eid: l.eid, mailbox: l.mailbox, folder: 'BEERKEZETT' }, { sleep, random: () => 0 })));
  assert.deepEqual(out.map(r => r.ok), [true, true, true, false, false]);
  assert.deepEqual([out[3].capReached, out[4].capReached], [true, true]);
  assert.equal(twin.log.filter(x => x.path.includes('/letoltes/')).length, 3);
  assert.equal(peak, 1, 'egyszerre egy letöltés fut, a szünet nem kerülhető meg');
});

test('kétszer egymás után bizonytalan válasz (403 vagy weboldal): a munkamenetet eldobjuk, nem próbálkozunk tovább', async () => {
  const sessions = A.makeSessions();
  let calls = 0;
  const res = { status: 403, headers: { get: () => null, getSetCookie: () => [] }, arrayBuffer: async () => new ArrayBuffer(0) };
  sessions.put('k', { mailboxes: [{ addressId: 'A', name: 'M' }], jar: { get: () => null, header: () => '', store: () => {} }, fetchImpl: async () => { calls += 1; return res; } });
  const go = eid => A.downloadWithSession(sessions, 'k', { eid, mailbox: 'M', folder: 'BEERKEZETT' }, { sleep: async () => {} });
  const r1 = await go('E1'), r2 = await go('E2'), r3 = await go('E3');
  assert.deepEqual([r1.ok, !!r1.needSession, !!r2.needSession, !!r3.needSession, calls], [false, false, true, true, 2]);
});

test('a letöltési korlát környezeti beállítása csak lejjebb viheti az alapértéket', () => {
  assert.deepEqual([undefined, '', '2', '0', '50', '500', '-1', 'abc', '1.5'].map(v => A.downloadCap(v)), [50, 50, 2, 0, 50, 50, 50, 50, 50]);
});

test('munkamenet kérésre (kézi letöltéshez): meglévőt újrahasznál, tiltott belépővel nem lép be, jelszóhiba után tilt', async () => {
  const { createGovTwin, accountantScenario } = require('../simulator/gov-twin');
  const twin = createGovTwin(accountantScenario());
  const sessions = A.makeSessions(); const state = {};
  const logins = () => twin.log.filter(x => x.host === 'idp.gov.hu' && x.method === 'POST').length;
  const opts = { getCreds: async () => twin.credentials.konyvelo, fetchImpl: twin.fetchImpl, state };
  const a = await A.ensureSession(sessions, 'k', opts); const n = logins();
  const b = await A.ensureSession(sessions, 'k', opts);
  assert.deepEqual([a.ok, b.ok, logins() === n, sessions.get('k').ctx.mailboxes.length, state.k.fails], [true, true, true, 6, 0], 'a második hívás nem lép be újra');

  const bad = { ...opts, getCreds: async () => ({ ...twin.credentials.konyvelo, password: 'rossz' }) };
  const c = await A.ensureSession(sessions, 'masik', bad); const m = logins();
  const d = await A.ensureSession(sessions, 'masik', bad);
  assert.deepEqual([c.ok, d.ok, !!state.masik.blocked, logins() === m], [false, false, true, true], 'jelszóhiba után nincs újabb belépési kísérlet');
  assert.equal((await A.ensureSession(sessions, 'dap', { ...opts, getCreds: async () => ({ mode: 'dap', username: 'x', password: 'y' }) })).ok, false);
});
