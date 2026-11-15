// Postafiók-szűrő: a belépőn kikapcsolt rendszer postafiókjának leveleit az asztali app le sem kéri.
const test = require('node:test');
const assert = require('node:assert');
const { mailboxAllowed } = require('../mailbox-filter');
const H = require('../tarhely-http');
const A = require('../tarhely-auto');
const { createGovTwin, accountantScenario } = require('../simulator/gov-twin');

test('mailboxAllowed: szűrő nélkül minden megy; ismert névnél a tiltólista dönt', () => {
  assert.equal(mailboxAllowed('Bármi', null), true);
  const f = { known: ['Értesítési tárhely', '12345676 (A Kft)'], deny: ['Értesítési tárhely'], unknown: 'none' };
  assert.equal(mailboxAllowed('Értesítési tárhely', f), false);
  assert.equal(mailboxAllowed('12345676 (A Kft)', f), true);
});

test('mailboxAllowed: ismeretlen névnél a szabály dönt', () => {
  const base = { known: [], deny: [] };
  assert.equal(mailboxAllowed('Új tárhely', { ...base, unknown: 'all' }), true);
  assert.equal(mailboxAllowed('Új tárhely', { ...base, unknown: 'none' }), false);
  assert.equal(mailboxAllowed('Új tárhely', { ...base, unknown: 'taxNamed' }), false);
  assert.equal(mailboxAllowed('87654323 (Új Kft)', { ...base, unknown: 'taxNamed' }), true);
  assert.equal(mailboxAllowed('Új Kft (87654323-2-41)', { ...base, unknown: 'taxNamed' }), true);
  assert.equal(mailboxAllowed('12345676 Kettő (87654323)', { ...base, unknown: 'taxNamed' }), false, 'két szám: nem egyértelmű');
  assert.equal(mailboxAllowed('Kovács Éva 8412345678', { ...base, unknown: 'taxNamed' }), false, 'adóazonosító jel nem adószám');
  assert.equal(mailboxAllowed('Új tárhely', { ...base, unknown: 'értelmetlen' }), false, 'ismeretlen szabály: szigorúan');
});

test('a kiszűrt postafiók leveleit a modul le sem kéri, de a postafiók a listában marad', async () => {
  const twin = createGovTwin(accountantScenario());
  const c = twin.credentials.konyvelo;
  const ctx = await H.loginWithCredentials({ username: c.username, password: c.password, seed: c.totpSeed }, { fetchImpl: twin.fetchImpl });
  const before = twin.log.length;
  const own = ctx.mailboxes.find(m => m.type === 'AP'), hk = ctx.mailboxes.find(m => m.type === 'HKP');
  const filter = { known: [own.name], deny: [own.name], unknown: 'taxNamed' };
  const letters = await H.listAll(ctx, { mailboxFilter: filter, sleep: async () => {} });

  const asked = new Set(twin.log.slice(before).map(x => x.addressId));
  assert.ok(!asked.has(own.addressId), 'a saját tárhelyre nem ment kérés');
  assert.ok(!asked.has(hk.addressId), 'az ismeretlen (szám nélküli) hivatali kapura sem');
  assert.equal(asked.size, 4);
  assert.ok(letters.every(l => ![own.name, hk.name].includes(l.mailbox)));
  assert.equal(ctx.mailboxes.length, 6);
});

test('a többügyfeles futó belépőnként külön szűrőt kap, és jelzi a kihagyott postafiókokat', async () => {
  const twin = createGovTwin(accountantScenario());
  const sum = await A.runClients(['konyvelo'], { getCreds: async k => twin.credentials[k], fetchImpl: twin.fetchImpl, sleep: async () => {},
    filters: { konyvelo: { known: [], deny: [], unknown: 'none' } } });
  const r = sum.results[0];
  assert.equal(r.ok, true);
  assert.equal(r.letterCount, 0);
  assert.equal(r.mailboxes.length, 6);
  assert.equal(r.mailboxes.filter(m => m.skipped).length, 6);
});
