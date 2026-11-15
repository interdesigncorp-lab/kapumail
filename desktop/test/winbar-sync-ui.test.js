// A felső ablaksáv („Automata frissítés: …” / „Következő frissítés: …”) jelvényének tesztje
// közvetlenül az app.html `renderWinbar` és `winbarSyncClick` forrásából.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'resources', 'ui', 'app.html'), 'utf8');
const start = html.indexOf('const schedPortals=');
const end = html.indexOf('async function schedRefresh()');
assert.ok(start > 0 && end > start, 'renderWinbar és winbarSyncClick megtalálható az app.html-ben');
assert.match(html, /e\.target\.closest\('\[data-wbsched\]'\)\)\{winbarSyncClick\(\);return\}/);
const snippet = html.slice(start, end);

function makeHarness({
  portals = [],
  sched = { enabled: false, excluded: [], next: null },
  office = { live_listing: true },
  syncs = [{ at: '11-15 01:18' }],
  admin = true,
  desktop = true,
} = {}) {
  const S = { area: 'inbox', stab: 'mail' };
  const KEEP = {};
  const AUTO = { busy: false, bg: false, ov: false };
  const PS = { run: false, batch: null };
  let SYNCBUSY = false;
  let UPO_BUSY = false;
  let UPOV = null;

  const calls = { portalSync: [], allPortals: 0, syncOv: 0, render: 0, scrolled: 0 };
  const winbar = { innerHTML: '' };
  const detail = { scrollTop: 120 };
  const appClassRemoved = [];
  const schedCard = { scrollIntoView: () => { calls.scrolled++; } };

  const documentStub = {
    getElementById: id => (id === 'winbar' ? winbar : null),
    querySelector: sel => (sel === '.schedc' ? schedCard : null),
  };
  const windowStub = desktop ? { iratkapuDesktop: { schedule: {} } } : {};
  const $ = sel => {
    if (sel === '#detail') return detail;
    if (sel === '#app') return { classList: { remove: c => appClassRemoved.push(c) } };
    return null;
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = name => `<svg data-ic="${name}"></svg>`;
  const schedWhen = v => String(v).slice(-5);

  const fns = new Function(
    'window', 'document', '$', 'esc', 'ic', 'schedWhen', 'canAdmin', 'setTimeout',
    'TODAY', 'OFFICE', 'SCHED', 'SYNCS', 'S', 'KEEP', 'AUTO', 'PS',
    'getPortals', 'getBusy', 'runPortalSync', 'runAllPortals', 'renderSyncOv', 'render',
    `
    let PORTALS = getPortals(), SYNCBUSY = false, UPO_BUSY = false, UPOV = null;
    const syncVars = () => { PORTALS = getPortals(); ({ SYNCBUSY, UPO_BUSY, UPOV } = getBusy()); };
    ${snippet}
    MODE_TXT = 'Helyi mód – minden adat ezen a gépen marad';
    return {
      renderWinbar: () => { syncVars(); renderWinbar(); },
      winbarSyncClick: () => { syncVars(); winbarSyncClick(); },
    };
    `
  )(
    windowStub, documentStub, $, esc, ic, schedWhen, () => admin, fn => fn(),
    '2026-11-15', office, sched, syncs, S, KEEP, AUTO, PS,
    () => portals, () => ({ SYNCBUSY, UPO_BUSY, UPOV }),
    id => calls.portalSync.push(id),
    () => { calls.allPortals++; },
    () => { calls.syncOv++; },
    () => { calls.render++; },
  );

  return {
    S, KEEP, AUTO, PS, calls, winbar, detail, appClassRemoved,
    setPortals: next => { portals = next; },
    setBusy: next => {
      if ('SYNCBUSY' in next) SYNCBUSY = next.SYNCBUSY;
      if ('UPO_BUSY' in next) UPO_BUSY = next.UPO_BUSY;
      if ('UPOV' in next) UPOV = next.UPOV;
    },
    ...fns,
  };
}

test('ha még nincs beállított csatlakozás, a felső frissítés jelvény a Belépők és rendszerek oldalra visz', () => {
  const h = makeHarness({ portals: [] });
  h.renderWinbar();
  assert.match(h.winbar.innerHTML, /<button type="button" class="wb-i wb-next off" data-wbsched/);
  assert.match(h.winbar.innerHTML, /Automata frissítés: <b>kikapcsolva<\/b>/);
  assert.doesNotMatch(h.winbar.innerHTML, /data-stab=/);

  h.winbarSyncClick();
  assert.strictEqual(h.S.area, 'settings');
  assert.strictEqual(h.S.stab, 'portals');
  assert.strictEqual(h.KEEP.schedt, true);
  assert.strictEqual(h.detail.scrollTop, 0);
  assert.strictEqual(h.calls.scrolled, 1);
  assert.strictEqual(h.calls.portalSync.length, 0);
  assert.strictEqual(h.calls.allPortals, 0);
});

test('ha 1 csatlakozás már be van állítva, kattintásra azonnal indul a Kapu-animációs portálszinkron oldalváltás nélkül', () => {
  const h = makeHarness({ portals: [{ id: 42, vaultKey: 'vk-1', name: 'Saját ÜK+' }] });
  h.renderWinbar();
  assert.match(h.winbar.innerHTML, /title="Teljes szinkron indítása most/);

  h.winbarSyncClick();
  assert.deepStrictEqual(h.calls.portalSync, [42]);
  assert.strictEqual(h.calls.allPortals, 0);
  assert.strictEqual(h.S.area, 'inbox', 'nem ugrik el az aktuális nézetről');
});

test('ha több csatlakozás van beállítva, rákérdezés nélkül rögtön lefut az összes csatlakozás szinkronja', () => {
  const h = makeHarness({
    portals: [
      { id: 1, vaultKey: 'vk-1', name: 'Első ÜK+' },
      { id: 2, vaultKey: 'vk-2', name: 'Második ÜK+' },
    ],
    sched: { enabled: true, excluded: [], next: '2026-11-15T16:00:00' },
  });
  h.renderWinbar();
  assert.match(h.winbar.innerHTML, /<button type="button" class="wb-i wb-next" data-wbsched/);
  assert.match(h.winbar.innerHTML, /Következő frissítés:/);

  h.winbarSyncClick();
  assert.strictEqual(h.calls.allPortals, 1);
  assert.strictEqual(h.calls.portalSync.length, 0);
  assert.strictEqual(h.S.area, 'inbox');
});

test('már futó szinkronnál nem indít újabb példányt, háttérbe tett szinkronnál visszahozza a Kapu-animációt', () => {
  const h = makeHarness({ portals: [{ id: 7, vaultKey: 'vk-7', name: 'Saját ÜK+' }] });
  h.AUTO.busy = true;
  h.AUTO.bg = true;

  h.winbarSyncClick();
  assert.strictEqual(h.AUTO.bg, false);
  assert.strictEqual(h.AUTO.ov, true);
  assert.strictEqual(h.calls.syncOv, 1);
  assert.strictEqual(h.calls.portalSync.length, 0);

  h.AUTO.busy = false;
  h.PS.run = true;
  h.winbarSyncClick();
  assert.strictEqual(h.calls.syncOv, 2);
  assert.strictEqual(h.calls.portalSync.length, 0);
});
