// A kézi tárhely-szinkron növekményes ablaka: a vízjel csak a szerver befogadása után lép előre.
const test = require('node:test');
const assert = require('node:assert');
const { makeLiveListWindows, mailboxSig } = require('../live-list-window');

const store = () => { let cfg = {}; return { readCfg: () => JSON.parse(JSON.stringify(cfg)), saveCfg: p => { cfg = { ...cfg, ...p }; }, peek: () => cfg }; };
const DAY = 86400000, T0 = Date.UTC(2026, 10, 1, 9);

test('első futás teljes; visszaigazolás után növekményes, 3 nap átfedéssel', () => {
  const io = store(); const w = makeLiveListWindows(io);
  assert.deepEqual(w.plan('p7', { mailboxNames: ['A'], now: T0 }), { full: true, since: null, incomingFrom: null });
  w.ack('p7', { full: true, now: T0 });
  const p = w.plan('p7', { mailboxNames: ['A'], now: T0 + DAY });
  assert.equal(p.full, false);
  assert.equal(p.incomingFrom, new Date(T0 - 3 * DAY).toISOString());
});

test('visszaigazolás nélkül (a szerver nem fogadta be) a vízjel nem lép előre', () => {
  const io = store(); const w = makeLiveListWindows(io);
  w.plan('p7', { mailboxNames: ['A'], now: T0 }); w.ack('p7', { full: true, now: T0 });
  w.plan('p7', { mailboxNames: ['A'], now: T0 + DAY }); // ez a futás elakadt, nincs ack
  assert.equal(w.plan('p7', { mailboxNames: ['A'], now: T0 + 2 * DAY }).incomingFrom, new Date(T0 - 3 * DAY).toISOString());
});

test('hetente, kérésre és új postafióknál teljes lista; más belépő ablaka független', () => {
  const io = store(); const w = makeLiveListWindows(io);
  w.plan('p7', { mailboxNames: ['A'], now: T0 }); w.ack('p7', { full: true, now: T0 });
  assert.equal(w.plan('p7', { mailboxNames: ['A'], now: T0 + 7 * DAY }).full, true, 'hetente teljes');
  assert.equal(w.plan('p7', { mailboxNames: ['A'], now: T0 + DAY, forceFull: true }).full, true, 'kérésre teljes');
  assert.equal(w.plan('p7', { mailboxNames: ['A', 'B'], now: T0 + DAY }).full, true, 'új postafiók: teljes');
  assert.equal(w.plan('p7', { mailboxNames: ['A'], sent: true, now: T0 + DAY }).full, true, 'az Elküldött bekapcsolása: teljes');
  assert.equal(w.plan('p8', { mailboxNames: ['A'], now: T0 + DAY }).full, true);
  assert.equal(mailboxSig(['B', 'A', 'A'], false), mailboxSig(['A', 'B'], false));
});
