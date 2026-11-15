// A főfolyamat bekötései a felügyelet nélküli futáshoz: állapot mentése, tiltás feloldása, az ablakos belépés kapuja.
// A beállításfájlt memóriabeli tároló helyettesíti.
const test = require('node:test');
const assert = require('node:assert');
const { makeAutoControl } = require('../auto-control');
const { cleanFilter } = require('../mailbox-filter');

function memoryCfg(initial = {}) {
  let cfg = JSON.parse(JSON.stringify(initial)); const writes = [];
  return { readCfg: () => JSON.parse(JSON.stringify(cfg)), saveCfg: patch => { cfg = { ...cfg, ...JSON.parse(JSON.stringify(patch)) }; writes.push(Object.keys(patch)); }, get: () => cfg, writes };
}
const blocked = { fails: 1, blocked: 'Hibás jelszó vagy felhasználónév.', lastError: 'x', lastOkAt: null };

test('az állapot a beállításfájlból jön; hibás vagy hiányzó tartalom üres állapot', () => {
  assert.deepEqual(makeAutoControl(memoryCfg({ auto: { a: blocked } })).state(), { a: blocked });
  assert.deepEqual(makeAutoControl(memoryCfg({ auto: 'szemét' })).state(), {});
  assert.deepEqual(makeAutoControl(memoryCfg()).state(), {});
});

test('futás közben belépőnként azonnal ment, a többi beállítást nem bántja', () => {
  const c = memoryCfg({ background: true, auto: { regi: { fails: 2, blocked: null, lastError: 'y', lastOkAt: null } } });
  const ctl = makeAutoControl(c); const snapshot = ctl.state();
  snapshot.uj = { ...blocked };
  ctl.saver(snapshot)({ key: 'uj', ok: false });

  assert.equal(c.get().background, true);
  assert.equal(c.get().auto.uj.blocked, blocked.blocked);
  assert.equal(c.get().auto.regi.fails, 2);
  assert.equal(c.writes.length, 1);
});

test('a belépési adatok mentése feloldja a tiltást; ismeretlen belépőnél nem ír', () => {
  const c = memoryCfg({ auto: { a: { ...blocked, lastOkAt: 123 } } });
  const ctl = makeAutoControl(c);
  ctl.unblockOnSave('a');
  assert.deepEqual(c.get().auto.a, { fails: 0, blocked: null, lastError: null, lastOkAt: 123 });
  const before = c.writes.length;
  ctl.unblockOnSave('nincs-ilyen');
  assert.equal(c.writes.length, before);
});

test('az ablakos automata belépés kapuja: tiltott belépővel nem indul, jelszóhibát rögzít, más hibát nem', () => {
  const c = memoryCfg({ auto: { a: blocked } });
  const ctl = makeAutoControl(c);
  assert.match(ctl.gate('a'), /Hibás jelszó/);
  assert.equal(ctl.gate('b'), null);

  ctl.recordWindowResult('b', { ok: false, error: 'időtúllépés' });
  assert.equal(c.get().auto.b, undefined, 'nem jelszóhiba: az ablakos út nem számol hibát');
  ctl.recordWindowResult('b', { ok: true });
  assert.equal(c.get().auto.b, undefined);
  ctl.recordWindowResult('b', { ok: false, error: 'Hibás felhasználónév vagy jelszó.' });
  assert.match(ctl.gate('b'), /jelszó/i);
  assert.match(makeAutoControl(c).gate('b'), /jelszó/i, 'újraindítás után is megvan');
});

test('cleanFilter: a felülettől kapott szűrőből csak a várt alak megy tovább', () => {
  assert.equal(cleanFilter(null), null);
  assert.equal(cleanFilter('szöveg'), null);
  assert.deepEqual(cleanFilter({ known: ['a', 7], deny: 'nem tömb', unknown: 'bármi', extra: 1 }), { known: ['a', '7'], deny: [], unknown: 'none' });
  assert.equal(cleanFilter({ known: Array.from({ length: 2000 }, (_, i) => 'x' + i), deny: [], unknown: 'all' }).known.length, 1000);
  assert.equal(cleanFilter({ known: ['n'.repeat(500)], deny: [], unknown: 'taxNamed' }).known[0].length, 200);
});
