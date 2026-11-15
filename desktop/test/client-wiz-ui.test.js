// Az „+ Új ügyfél” varázsló (WIZ) kinyitható magyarázatának tesztje közvetlenül az app.html forrásából.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'resources', 'ui', 'app.html'), 'utf8');
const start = html.indexOf('const WIZ=[');
const end = html.indexOf('function renderWiz()');
assert.ok(start > 0 && end > start, 'WIZ definíció megtalálható az app.html-ben');
const snippet = html.slice(start, end);

function evalWizStep0({ keepOpen = false, type = 'CK' } = {}) {
  const S = { wz: { name: '', tax: '', type } };
  const KEEP = { wizwhy: keepOpen };
  const esc = x => String(x ?? '');
  const TODAY = '2026-11-15';
  const addDays = () => '2026-11-16';
  const WIZ = new Function('S', 'KEEP', 'esc', 'TODAY', 'addDays', `${snippet}\nreturn WIZ;`)(
    S, KEEP, esc, TODAY, addDays
  );
  return WIZ[0][1]();
}

test('az Új ügyfél varázsló 1. lépése kinyitható (details) súgót tartalmaz alapból zárt állapotban', () => {
  const closed = evalWizStep0({ keepOpen: false });
  assert.match(closed, /<details class="ntc"[^>]*data-keep="wizwhy">/);
  assert.doesNotMatch(closed, /<details class="ntc"[^>]*\bopen\b/);
  assert.match(closed, /Mire jó ez\?/);
  assert.match(closed, /Nem kér jelszót és sehová nem jelentkezik be/);
  assert.match(closed, /Saját tárhelyen keveredő NAV-iratok/);
  assert.match(closed, /data-portalnew/);
});

test('a lenyitott súgó állapota (KEEP.wizwhy) megmarad lépésváltás után, új megnyitáskor pedig visszaáll csukottra', () => {
  const opened = evalWizStep0({ keepOpen: true });
  assert.match(opened, /<details class="ntc"[^>]*data-keep="wizwhy" open>/);
  assert.ok(html.includes("if('wiz' in d){S.wiz=0;S.wz={type:'CK'};KEEP.wizwhy=false;renderWiz();return}"));
});
