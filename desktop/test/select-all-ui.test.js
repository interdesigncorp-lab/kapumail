// A küldeménylista felső napcíme (Ma / Tegnap / Korábban) melletti „Összes kijelölése” jelölőnégyzet tesztje
// közvetlenül az app.html `toggleAllRows` + `renderRows` forrásából.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'resources', 'ui', 'app.html'), 'utf8');
const start = html.indexOf('function toggleAllRows()');
const end = html.indexOf('function stDD(');
assert.ok(start > 0 && end > start, 'toggleAllRows és renderRows megtalálható az app.html-ben');
const snippet = html.slice(start, end);

function makeHarness({ items = [], today = '2026-11-15', checked = [] } = {}) {
  const S = { client: null, folder: 'all', clientSent: false, q: '', hideRcpt: true, checked: new Set(checked) };
  const dom = {
    '#rows': { innerHTML: '' },
    '#bulk': { innerHTML: '' },
    ckall: null,
  };
  const $ = sel => {
    if (sel === '#rows [data-ckall]') return dom.ckall;
    return dom[sel];
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const dayOf = at => String(at).slice(0, 10);
  const isSent = m => !!m.sent;
  const rowHTML = m => `<div class="row" id="${m.id}" data-id="${m.id}"><input class="ck" type="checkbox" ${S.checked.has(m.id) ? 'checked' : ''}></div>`;
  let vis = items;
  const visible = () => vis;

  const { toggleAllRows, renderRows } = new Function(
    'S', '$', 'esc', 'addDays', 'dayOf', 'isSent', 'rowHTML', 'visible', 'TODAY', 'OFFICE', 'M',
    `${snippet}\nreturn { toggleAllRows, renderRows };`
  )(S, $, esc, addDays, dayOf, isSent, rowHTML, visible, today, { live_sent: false }, items);

  const render = () => {
    dom.ckall = { indeterminate: false };
    renderRows();
    if (!dom['#rows'].innerHTML.includes('data-ckall')) dom.ckall = null;
  };
  return { S, dom, render, toggleAllRows, setVisible: next => { vis = next; } };
}

test('egyetlen „Összes kijelölése” jelölőnégyzet jelenik meg több napcsoport (Ma, Tegnap, Korábban) mellett is', () => {
  const h = makeHarness({
    items: [
      { id: 'm1', at: '2026-11-15 09:10' },
      { id: 'm2', at: '2026-11-14 14:00' },
      { id: 'm3', at: '2026-11-13 08:30' },
    ],
  });
  h.render();
  const out = h.dom['#rows'].innerHTML;
  assert.equal((out.match(/data-ckall/g) || []).length, 1, 'pontosan egy fejléc-checkbox szerepel');
  assert.equal((out.match(/class="dgrp"/g) || []).length, 3, 'mindhárom napcsoport külön .dgrp konténerben van');
  assert.match(out, />Ma<\/div>/);
  assert.match(out, />Tegnap<\/div>/);
  assert.match(out, />Korábban<\/div>/);
  assert.match(out, /data-tip="Összes kijelölése \(3\)"/);
  assert.equal(h.dom.ckall.indeterminate, false);
  assert.equal(h.dom['#bulk'].innerHTML, '');
});

test('üres→mind→üres és részleges (indeterminate)→mind→üres váltások', () => {
  const h = makeHarness({
    items: [
      { id: 'm1', at: '2026-11-13 10:00' },
      { id: 'm2', at: '2026-11-13 09:00' },
      { id: 'm3', at: '2026-11-12 08:00' },
    ],
  });
  h.render();
  assert.equal(/data-ckall[^>]*checked/.test(h.dom['#rows'].innerHTML), false);

  // 0 -> mind a 3 kijelölve
  h.toggleAllRows();
  h.render();
  assert.deepEqual([...h.S.checked], ['m1', 'm2', 'm3']);
  assert.equal(/data-ckall[^>]*checked/.test(h.dom['#rows'].innerHTML), true);
  assert.match(h.dom['#rows'].innerHTML, /data-tip="Kijelölés törlése"/);
  assert.equal(h.dom.ckall.indeterminate, false);
  assert.match(h.dom['#bulk'].innerHTML, /3 kijelölve/);

  // mind -> kijelölés törlése
  h.toggleAllRows();
  h.render();
  assert.equal(h.S.checked.size, 0);
  assert.equal(/data-ckall[^>]*checked/.test(h.dom['#rows'].innerHTML), false);
  assert.equal(h.dom['#bulk'].innerHTML, '');

  // részleges kijelölés (1/3) -> indeterminate, kattintásra mind a 3 kijelölődik
  h.S.checked.add('m2');
  h.render();
  assert.equal(h.dom.ckall.indeterminate, true);
  assert.equal(/data-ckall[^>]*checked/.test(h.dom['#rows'].innerHTML), false);
  h.toggleAllRows();
  h.render();
  assert.deepEqual([...h.S.checked].sort(), ['m1', 'm2', 'm3']);
  assert.equal(h.dom.ckall.indeterminate, false);
  assert.equal(/data-ckall[^>]*checked/.test(h.dom['#rows'].innerHTML), true);
});

test('üres listánál nem jelenik meg az „Összes kijelölése” jelölőnégyzet', () => {
  const h = makeHarness({ items: [] });
  h.render();
  assert.equal(h.dom['#rows'].innerHTML.includes('data-ckall'), false);
  assert.equal(h.dom.ckall, null);
  assert.match(h.dom['#rows'].innerHTML, /class="empty"/);
});
