// Ütemezés: munkanapokon 8, 12 és 16 órakor; kimaradt futásból csak a legutóbbi pótlódik.
const test = require('node:test');
const assert = require('node:assert');
const { dueSlot, nextSlot, slotsOf, normalize, validate, DEFAULTS } = require('../schedule');

const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0); // helyi idő
// 2026-11-09 hétfő … 2026-11-13 péntek, 2026-11-14 szombat, 2026-11-15 vasárnap

test('az alap időpontok: 8, 12 és 16 óra', () => assert.deepEqual(slotsOf(normalize({})), [480, 720, 960]));

test('nyolc előtt nincs esedékes futás, nyolckor van', () => {
  assert.equal(dueSlot(at(2026, 11, 9, 7, 59), null), null);
  assert.deepEqual(dueSlot(at(2026, 11, 9, 8, 0), null), at(2026, 11, 9, 8));
});

test('két kimaradt időpontból csak a legutóbbi pótlódik, és ugyanabban az időszakban másodszor nem fut', () => {
  const now = at(2026, 11, 10, 12, 30);
  const slot = dueSlot(now, at(2026, 11, 9, 16, 5).getTime()); // tegnap délután futott utoljára
  assert.deepEqual(slot, at(2026, 11, 10, 12));
  assert.equal(dueSlot(at(2026, 11, 10, 12, 40), now.getTime()), null);
  assert.equal(dueSlot(at(2026, 11, 10, 15, 59), now.getTime()), null);
  assert.deepEqual(dueSlot(at(2026, 11, 10, 16, 1), now.getTime()), at(2026, 11, 10, 16));
});

test('hétvégén nem fut, pénteken délután még igen, hétfőn újra', () => {
  assert.deepEqual(dueSlot(at(2026, 11, 13, 16, 5), at(2026, 11, 13, 12, 1).getTime()), at(2026, 11, 13, 16));
  assert.equal(dueSlot(at(2026, 11, 14, 10, 0), null), null);
  assert.equal(dueSlot(at(2026, 11, 15, 16, 30), at(2026, 11, 13, 8, 1).getTime()), null);
  assert.deepEqual(dueSlot(at(2026, 11, 16, 8, 2), at(2026, 11, 13, 16, 5).getTime()), at(2026, 11, 16, 8));
});

test('érvénytelen bemenetre nincs futás', () => {
  assert.equal(dueSlot(new Date(NaN), null), null);
  assert.equal(dueSlot(at(2026, 11, 9, 9, 0), at(2026, 11, 9, 10, 0).getTime()), null, 'a jövőbeli utolsó futás után nem fut');
});

// --------------------------------------------------- munkaszüneti napok és áthelyezett munkanapok
const { isWorkday, holidaysOf } = require('../schedule');

test('a magyar munkaszüneti napok: rögzített napok és a húsvéthoz kötöttek (2026)', () => {
  const h = holidaysOf(2026);
  for (const d of ['2026-01-01', '2026-03-15', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-25', '2026-08-20', '2026-10-23', '2026-11-01', '2026-12-25', '2026-12-26']) assert.ok(h.includes(d), d);
  assert.equal(h.length, 11);
  assert.ok(holidaysOf(2027).includes('2027-03-26'), 'nagypéntek 2027');
  assert.ok(holidaysOf(2027).includes('2027-05-17'), 'pünkösdhétfő 2027');
});

test('munkaszüneti napon nem fut, akkor sem, ha hétköznap', () => {
  assert.equal(isWorkday(at(2026, 10, 23, 9)), false);          // péntek, nemzeti ünnep
  assert.equal(dueSlot(at(2026, 10, 23, 9, 0), null), null);
  assert.equal(dueSlot(at(2026, 4, 6, 12, 30), null), null);     // húsvéthétfő
  assert.deepEqual(dueSlot(at(2026, 10, 22, 9, 0), null), at(2026, 10, 22, 8));
});

test('áthelyezett munkanap és pihenőnap a beállításból: a szombat munkanap, a hétköznap pihenőnap lehet', () => {
  const cal = { extraWorkdays: ['2026-11-14'], extraRestdays: ['2026-11-13'] };
  assert.deepEqual(dueSlot(at(2026, 11, 14, 8, 5), null, cal), at(2026, 11, 14, 8)); // szombat, de munkanap
  assert.equal(dueSlot(at(2026, 11, 13, 12, 5), null, cal), null);                    // péntek, de pihenőnap
  assert.equal(dueSlot(at(2026, 11, 14, 8, 5), null), null);                          // beállítás nélkül a szombat nem munkanap
  assert.equal(isWorkday(at(2026, 11, 14, 8), { extraWorkdays: ['értelmetlen', 42] }), false, 'hibás beállítás nem számít');
});

// --------------------------------------------------- állítható időzítő: módok, napok, 3 órás alsó határ
test('régi beállítófájl: az alap 8, 12, 16 munkanapokon', () => {
  assert.deepEqual(normalize({ enabled: true, lastRunAt: 5 }), DEFAULTS);
  assert.deepEqual(normalize({ times: 'x', everyHours: 1, days: 'soha', weekdays: [9], excluded: 7 }), DEFAULTS);
  assert.deepEqual(normalize({ times: ['12:00', '13:30'] }).times, DEFAULTS.times);
  assert.deepEqual(normalize(null), DEFAULTS);
});

test('mentéskor a 3 órás határ', () => {
  assert.equal(validate({ ...DEFAULTS, times: ['12:00', '13:30'] }).error, 'Két időpont között legalább 3 óra kell (12:00 és 13:30 között csak 1,5 óra van).');
  assert.equal(validate({ ...DEFAULTS, times: [] }).ok, false);
  assert.equal(validate({ ...DEFAULTS, times: ['25:00'] }).ok, false);
  assert.equal(validate({ ...DEFAULTS, mode: 'interval', everyHours: 2 }).ok, false);
  assert.equal(validate({ ...DEFAULTS, mode: 'interval', everyHours: 3.5 }).ok, false);
  assert.equal(validate({ ...DEFAULTS, mode: 'interval', from: '19:00', to: '07:00' }).ok, false);
  assert.equal(validate({ ...DEFAULTS, days: 'custom', weekdays: [] }).ok, false);
  assert.equal(validate(null).ok, false);
  assert.deepEqual(validate({ ...DEFAULTS, times: ['16:00', '09:30', '09:30'] }).cfg.times, ['09:30', '16:00']);
  assert.deepEqual(validate({ ...DEFAULTS, excluded: ['a', 'a', 5, ''] }).cfg.excluded, ['a']);
});

test('X óránként: fix napi időpontok az időablakban', () => {
  assert.deepEqual(slotsOf({ ...DEFAULTS, mode: 'interval', everyHours: 3 }), [420, 600, 780, 960, 1140]);
  assert.deepEqual(slotsOf({ ...DEFAULTS, mode: 'interval', everyHours: 5, from: '08:30', to: '17:00' }), [510, 810]);
});

test('késve pótolt futás után a közeli időpont kimarad, a következő fut', () => {
  const ran = at(2026, 11, 10, 11, 50).getTime();
  assert.equal(dueSlot(at(2026, 11, 10, 12, 0), ran), null);
  assert.equal(dueSlot(at(2026, 11, 10, 15, 30), ran), null);
  assert.deepEqual(dueSlot(at(2026, 11, 10, 16, 0), ran), at(2026, 11, 10, 16));
});

test('pontosan indult futás után a 3 órával későbbi időpont nem marad ki', () => {
  const cfg = { mode: 'interval', everyHours: 3 };
  assert.deepEqual(dueSlot(at(2026, 11, 10, 10, 0), at(2026, 11, 10, 7, 2).getTime(), cfg), at(2026, 11, 10, 10));
});

test('mentés után csak későbbi időpont esedékes', () => {
  const cfg = { times: ['08:00', '11:00'], changedAt: at(2026, 11, 10, 11, 30).getTime() };
  assert.equal(dueSlot(at(2026, 11, 10, 11, 31), null, cfg), null);
  assert.deepEqual(dueSlot(at(2026, 11, 11, 8, 0), null, cfg), at(2026, 11, 11, 8));
});

test('napok: minden nap és kiválasztott napok', () => {
  assert.deepEqual(dueSlot(at(2026, 11, 14, 8, 5), null, { days: 'all' }), at(2026, 11, 14, 8));          // szombat
  assert.equal(dueSlot(at(2026, 11, 9, 8, 5), null, { days: 'custom', weekdays: [2, 6] }), null);          // hétfő
  assert.deepEqual(dueSlot(at(2026, 10, 23, 8, 5), null, { days: 'custom', weekdays: [5] }), at(2026, 10, 23, 8)); // ünnepnap, de kipipált péntek
});

test('következő futás: hétvégén át, ünnepnap előtt, és a távolságszabállyal', () => {
  assert.deepEqual(nextSlot(at(2026, 11, 13, 16, 30), null), at(2026, 11, 16, 8));        // péntek este -> hétfő
  assert.deepEqual(nextSlot(at(2026, 10, 22, 17, 0), null), at(2026, 10, 26, 8));         // csütörtök, pénteken ünnep
  assert.deepEqual(nextSlot(at(2026, 11, 10, 11, 55), at(2026, 11, 10, 11, 50).getTime()), at(2026, 11, 10, 16));
  assert.equal(nextSlot(new Date(NaN), null), null);
});

test('X óránként: az utolsó és a másnapi első időpont között is kell a 3 óra', () => {
  const v = validate({ ...DEFAULTS, mode: 'interval', everyHours: 11, from: '00:00', to: '23:00' }); // 00:00, 11:00, 22:00 -> éjfélig csak 2 óra
  assert.equal(v.ok, false);
  assert.match(v.error, /22:00 és másnap 00:00 között csak 2 óra/);
  assert.equal(validate({ ...DEFAULTS, mode: 'interval', everyHours: 3, from: '00:00', to: '23:59' }).ok, true); // 21:00 -> 00:00 éppen 3 óra
  assert.equal(validate({ ...DEFAULTS, times: ['01:00', '23:00'] }).error, 'Két időpont között legalább 3 óra kell (23:00 és másnap 01:00 között csak 2 óra van).');
});

test('sérült utolsó futás (nem szám) nem állítja le az ütemezést', () => {
  assert.deepEqual(dueSlot(at(2026, 11, 10, 8, 5), 'abc'), at(2026, 11, 10, 8));
  assert.deepEqual(nextSlot(at(2026, 11, 10, 8, 5), 'abc'), at(2026, 11, 10, 12));
});
