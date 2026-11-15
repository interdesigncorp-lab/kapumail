const test = require('node:test');
const assert = require('node:assert');
const { hashPin, verifyPin, newRecoveryCode, hashRecovery, verifyRecovery, Throttle, normalize } = require('../lock');

test('a PIN csak a helyes értékkel ellenőrizhető, és nyersen nem tárolódik', () => {
  const rec = hashPin('4821');
  assert.ok(!JSON.stringify(rec).includes('4821'));
  assert.equal(verifyPin('4821', rec), true);
  assert.equal(verifyPin('4822', rec), false);
  assert.equal(verifyPin('', rec), false);
  assert.equal(verifyPin('4821', null), false);
});

test('ugyanaz a PIN kétszer más sóval más lenyomatot ad', () => {
  assert.notEqual(hashPin('4821').hash, hashPin('4821').hash);
});

test('túl rövid vagy nem szöveges PIN nem állítható be', () => {
  assert.throws(() => hashPin('123'));
  assert.throws(() => hashPin(1234));
});

test('öt hibás próbálkozás után várni kell, és a várakozás duplázódik', () => {
  let t = 0; const th = new Throttle(() => t);
  for (let i = 0; i < 4; i++) assert.equal(th.fail(), 0);
  assert.equal(th.fail(), 30000);
  t += 30000; assert.equal(th.waitMs(), 0);
  assert.equal(th.fail(), 60000);
  for (let i = 0; i < 20; i++) th.fail();
  assert.equal(th.waitMs(), 15 * 60000);
  th.reset(); assert.equal(th.waitMs(), 0);
});

test('hibás vagy PIN nélküli beállítás kikapcsolt zárat jelent', () => {
  assert.equal(normalize(undefined).enabled, false);
  assert.equal(normalize({ enabled: true }).enabled, false);
  assert.equal(normalize({ enabled: true, pin: hashPin('4821'), idleMin: 7 }).idleMin, 5);
  const ok = normalize({ enabled: true, touchId: true, idleMin: 15, pin: hashPin('4821') });
  assert.deepEqual([ok.enabled, ok.touchId, ok.idleMin], [true, true, 15]);
});

test('a helyreállító kód 4×5 jel, félreolvasható karakter nélkül, és minden alkalommal más', () => {
  const a = newRecoveryCode(), b = newRecoveryCode();
  assert.match(a, /^[A-HJKMNP-Z2-9]{5}(-[A-HJKMNP-Z2-9]{5}){3}$/);
  assert.notEqual(a, b);
});

test('a helyreállító kód csak lenyomatként tárolódik, és kisbetűvel, kötőjel nélkül beírva is jó', () => {
  const code = newRecoveryCode(), rec = hashRecovery(code);
  assert.ok(!JSON.stringify(rec).includes(code.replace(/-/g, '')));
  assert.equal(verifyRecovery(code, rec), true);
  assert.equal(verifyRecovery(code.toLowerCase().replace(/-/g, ' '), rec), true);
  assert.equal(verifyRecovery(newRecoveryCode(), rec), false);
  assert.equal(verifyRecovery('', rec), false);
  assert.equal(verifyRecovery(code, null), false);
});

test('a zár beállítása megőrzi a helyreállító kód lenyomatát; régi zárnál nincs ilyen', () => {
  const pin = hashPin('4821'), recovery = hashRecovery(newRecoveryCode());
  assert.deepEqual(normalize({ enabled: true, pin, recovery }).recovery, recovery);
  assert.equal(normalize({ enabled: true, pin }).recovery, null);
});
