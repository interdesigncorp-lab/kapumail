// NAV adónaptár és hiányzó bevallások: védekező átalakítás rögzített mintaválaszokon.
// A tételek mezőnevei élőben NEM megfigyeltek (a megfigyeléskor a lista üres volt) – a minták kitalált, de hihető alakok.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../nav-calendar');

const TODAY = '2026-11-13';
const cal = posts => C.calendarToObligations(posts, { today: TODAY });

test('dátum: szöveges, időbélyeges, pontozott magyar, ezredmásodperces és [év, hó, nap] alak; értelmetlenből null', () => {
  assert.deepEqual(['2026-11-20', '2026-11-20T00:00:00.000Z', '2026.11.20.', '2026. 11. 20.', '2026/1/5'].map(C.toIsoDate), ['2026-11-20', '2026-11-20', '2026-11-20', '2026-11-20', '2026-01-05']);
  assert.equal(C.toIsoDate([2026, 11, 20]), '2026-11-20');
  assert.equal(C.toIsoDate(Date.UTC(2026, 10, 20, 12)), '2026-11-20');
  assert.deepEqual(['', 'holnap', '20261120', '2026-13-01', '2026-02-30', '1999-01-01', null, undefined, 20, {}, [2026, 11], true].map(C.toIsoDate), Array(12).fill(null));
});

test('nyomtatványkód: kifejezett mezőből vagy a címből; évszámot és összeget nem néz kódnak', () => {
  assert.equal(C.formCodeOf({ nyomtatvanyKod: '2558' }, ''), '2558');
  assert.equal(C.formCodeOf({ formCode: ' 25a60 ' }, ''), '25A60');
  assert.equal(C.formCodeOf({ form: { code: '2565' } }, ''), '2565');
  assert.deepEqual(['2658 bevallás', 'A 26A60 összesítő nyilatkozat', '26SZJA bevallás', 'T1041 bejelentés', 'Bevallás (2608)'].map(t => C.formCodeOf({}, t)), ['2658', '26A60', '26SZJA', 'T1041', '2608']);
  assert.deepEqual(['2026. évi adóelőleg', 'Befizetés 5000 Ft', 'Társasági adóelőleg', '', '2026.11.20'].map(t => C.formCodeOf({}, t)), [null, null, null, null, null]);
  assert.equal(C.formCodeOf({ formCode: '<script>' }, ''), null);
});

test('adónaptár, „A” minta: dátum + cím + adónem-objektum', () => {
  const r = cal([{ id: 1, date: '2026-11-20', title: '2658 bevallás', taxType: { id: 7, identifier: '290', name: 'Szocho' } }, { id: 2, date: '2026-12-12', title: 'SZJA-előleg', taxType: { identifier: '103' } }]);
  assert.deepEqual(r.items, [
    { formCode: '2658', title: '2658 bevallás', dueDate: '2026-11-20', periodStart: null, periodEnd: null, conditional: false, status: 'submittable', kind: 'calendar' },
    { formCode: 'ADONEM-103', title: 'SZJA-előleg', dueDate: '2026-12-12', periodStart: null, periodEnd: null, conditional: false, status: 'submittable', kind: 'calendar' }]);
  assert.deepEqual([r.total, r.unknown, r.past, r.keys], [2, 0, 0, ['date', 'id', 'taxType', 'title']]);
});

test('adónaptár, „B” minta: magyar mezőnevek, időszak, [év, hó, nap] dátum, HTML a leírásban', () => {
  const r = cal([{ hatarido: [2026, 11, 20], megnevezes: 'Havi <b>áfabevallás</b>', nyomtatvanyKod: '2665', idoszakKezdete: '2026-10-01', idoszakVege: '2026-10-31T00:00:00', teljesitett: true }]);
  assert.deepEqual(r.items, [{ formCode: '2665', title: 'Havi áfabevallás', dueDate: '2026-11-20', periodStart: '2026-10-01', periodEnd: '2026-10-31', conditional: false, status: 'submitted', kind: 'calendar' }]);
});

test('adónaptár, „C” minta: csak adónemkód-lista és dátum – cím nélkül is felvehető, a kód az adónemből lesz', () => {
  const r = cal([{ deadline: '2026-11-30', taxTypes: [{ id: 3, identifier: '104', name: 'Áfa' }] }, { dueDate: '2026-11-30', taxTypeIdentifier: 104, description: 'Áfa befizetése' }]);
  assert.deepEqual(r.items.map(i => [i.formCode, i.title, i.dueDate]), [['ADONEM-104', 'Adónaptár-bejegyzés (adónem: 104)', '2026-11-30'], ['ADONEM-104', 'Áfa befizetése', '2026-11-30']]);
});

test('adónaptár: amit nem ért, azt eldobja és megszámolja – határidőt nem talál ki; a múltbeli bejegyzésből nem lesz riasztás', () => {
  const r = cal([{}, null, 'szöveg', 7, [], { title: 'Dátum nélkül' }, { date: 'hamarosan', title: 'Rossz dátum' }, { date: '2026-11-20' },
    { date: '2026-11-01', title: 'Már elmúlt' }, { date: '2026-11-13', title: 'Ma esedékes' }, { date: '2026-11-13', title: 'Ma esedékes' }]);
  assert.deepEqual([r.total, r.unknown, r.past, r.items.length], [11, 8, 1, 1]);
  assert.deepEqual([r.items[0].formCode, r.items[0].title, r.items[0].status], ['NAPTAR', 'Ma esedékes', 'submittable']);
  assert.deepEqual(r.keys, ['date', 'title'], 'a mezőnevek a tételekből jönnek, érték nélkül');
  for (const bad of [null, undefined, {}, 'x', 5]) assert.deepEqual(cal(bad), { items: [], total: 0, unknown: 0, past: 0, keys: [] });
});

test('adónaptár: túl hosszú és túl sok adat levágva', () => {
  const r = cal(Array.from({ length: 1500 }, (_, i) => ({ date: '2026-12-01', title: `${i} `.padEnd(400, 'x') })));
  assert.equal(r.total, 1000);
  assert.ok(r.items.every(i => i.title.length <= 200 && i.formCode.length <= 32));
});

test('hiányzó bevallások: csak kóddal ÉS kiolvasható határidővel lesz „hiányzó” kötelezettség; ismétlődés egyszer', () => {
  const rows = [
    { bevallasKod: '2558', idoszakTol: '2026-09-01', idoszakIg: '2026-09-30', benyujtasiHatarido: '2026-10-12' },
    { bevallasKod: '2558', idoszakTol: '2026-09-01', idoszakIg: '2026-09-30', benyujtasiHatarido: '2026-10-12' },
    { returnType: '2565', dueDate: '2026-10-20', periodEnd: '2026-09-30' },
    { nyomtatvanyKod: '2508', idoszakVege: '2026-09-30' }, // határidő nélkül: az időszak végéből nem csinálunk határidőt
    { megnevezes: 'Kód nélküli tétel', hatarido: '2026-10-12' },
    { nyomtatvanyKod: '2501', date: '2026-10-12' }, // a puszta „date” itt nem biztosan határidő
    {}, null];
  const r = C.missingToObligations(rows);
  assert.deepEqual(r.items.map(i => [i.formCode, i.dueDate, i.periodEnd, i.status, i.kind, i.title]), [
    ['2558', '2026-10-12', '2026-09-30', 'missing', 'missing', '2558 bevallás – a NAV szerint hiányzik'],
    ['2565', '2026-10-20', '2026-09-30', 'missing', 'missing', '2565 bevallás – a NAV szerint hiányzik']]);
  assert.deepEqual([r.total, r.unknown, r.keys], [8, 5, ['benyujtasiHatarido', 'bevallasKod', 'date', 'dueDate', 'hatarido', 'idoszakIg', 'idoszakTol', 'idoszakVege', 'megnevezes', 'nyomtatvanyKod', 'periodEnd', 'returnType']]);
  assert.deepEqual(C.missingToObligations(undefined), { items: [], total: 0, unknown: 0, keys: [] });
});
