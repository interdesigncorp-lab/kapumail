// Az Áttekintés (`vHome`) alján megjelenő „Közelgő adónaptár-események” soronkénti kártyás blokkjának tesztje
// közvetlenül az app.html forrásából.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'resources', 'ui', 'app.html'), 'utf8');
const sPay = html.indexOf('function payBlock(o)');
const ePay = html.indexOf('function upoAsCalItems()');
const sUpo = html.indexOf('function upoBadge(o)');
const eUpo = html.indexOf('function vUpo()');
const sPer = html.indexOf('function navPer(f,t)');
const ePer = html.indexOf('let NAVDOC=[]');
const sHome = html.indexOf('function vHome()');
const eHome = html.indexOf('Object.assign(S,{tk:{open:false');

assert.ok(sPay > 0 && ePay > sPay, 'payBlock és upoFormParts megtalálható az app.html-ben');
assert.ok(sUpo > 0 && eUpo > sUpo, 'upoBadge és homeUpoSection megtalálható az app.html-ben');
assert.ok(sPer > 0 && ePer > sPer, 'navPer megtalálható az app.html-ben');
assert.ok(sHome > 0 && eHome > sHome, 'vHome megtalálható az app.html-ben');

const MONTHS = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];
const DOW = ['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek', 'Szombat', 'Vasárnap'];
const INT = { uj: 'Új', oszt: 'Osztályozandó', kiosztott: 'Kiosztott', folyamatban: 'Folyamatban', ell: 'Ellenőrzésre vár', kesz: 'Kész' };
const INT_ORDER = ['uj', 'oszt', 'kiosztott', 'folyamatban', 'ell', 'kesz'];

function makeHarness({
  today = '2026-11-15',
  clients = [{ id: 'c16', name: 'Teszt Zrt.', tax: '12345678-2-42', active: true, sync: { ok: true, at: '11-15 01:18' } }],
  obligations = [],
  messages = [],
  approvals = [],
  canDecide = () => false,
} = {}) {
  const S = { homeUpoAll: false };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const daysTo = d => Math.round((new Date(d) - new Date(today)) / 864e5);
  const ic = n => `<i data-ic="${n}"></i>`;
  const st = (cls, icn, txt) => `<span class="st ${cls}">${ic(icn)}${txt}</span>`;
  const C = id => clients.find(c => c.id === id);
  const isSent = m => m.folder === 'ELKULDOTT';
  const goBtn = m => `<button data-goto="${m.id}">${esc(m.sub)}</button>`;

  const fn = new Function(
    'S', 'TODAY', 'ME', 'MEU', 'OFFICE', 'PEOPLE', 'CLIENTS', 'M', 'APPR', 'OBLIGATIONS',
    'MONTHS', 'DOW', 'INT', 'INT_ORDER', 'esc', 'addDays', 'daysTo', 'ic', 'st', 'C', 'isSent', 'goBtn', 'canDecide',
    `${html.slice(sPay, ePay)}\n${html.slice(sPer, ePer)}\n${html.slice(sUpo, eUpo)}\n${html.slice(sHome, eHome)}\nreturn { vHome, homeUpoSection };`
  );
  const api = fn(
    S, today, 'LG', { name: 'Laczkovszki Gábor' }, { name: 'Teszt Zrt.' }, { LG: 'Laczkovszki Gábor', MJ: 'Minta János' },
    clients, messages, approvals, obligations, MONTHS, DOW, INT, INT_ORDER,
    esc, addDays, daysTo, ic, st, C, isSent, goBtn, canDecide
  );
  return { S, ...api };
}

test('a vHome alján soronkénti kártyákban jelennek meg a közelgő adónaptár-események, a kötelezők a feltételesek előtt', () => {
  const h = makeHarness({
    obligations: [
      {
        id: 16, c: 'c16', formCode: '26A60',
        title: 'Összesítő nyilatkozat', dueDate: '2026-11-20',
        conditional: true, status: 'conditional', pay: [],
      },
      {
        id: 15, c: 'c16', formCode: '2665',
        title: '2665 – Bevallás az általános forgalmi adóról', dueDate: '2026-11-20',
        periodStart: '2026-10-01', periodEnd: '2026-10-31',
        conditional: false, status: 'submittable',
        pay: [{ taxType: '104', name: 'NAV Általános forgalmi adó bevételi számla', account: '10032000-01076868', reference: '12345678-2-42' }],
      },
      {
        id: 20, c: 'c16', formCode: '2608',
        title: 'Havi járulékbevallás', dueDate: '2026-11-12',
        conditional: false, status: 'submitted', pay: [],
      },
    ],
  });

  const out = h.vHome();
  assert.match(out, /Közelgő adónaptár-események/);
  assert.equal((out.match(/class="hupo-card"/g) || []).length, 2, 'csak a 2 nyitott tétel kap kártyát, a beadott nem');
  // Azonos esedékességnél a kötelező (2665) megelőzi a feltételest (26A60), és a kód nem duplázódik a címben
  const i2665 = out.indexOf('>2665<');
  const i26A60 = out.indexOf('>26A60<');
  assert.ok(i2665 > 0 && i26A60 > i2665, 'a kötelező 2665 megelőzi az azonos napra eső feltételes 26A60-at');
  assert.match(out, /data-upojump="list">Bevallás az általános forgalmi adóról<\/button>/, 'a nyomtatványkód külön jelvényben áll, a látható címben nem ismétlődik');
  assert.match(out, /data-caljump="2026-11-20"/);
  assert.match(out, /5 nap múlva/);
  assert.match(out, /Időszak: 2026\. okt\./);
  assert.match(out, /10032000-01076868/, 'az utalási számlaszám lenyithatóan szerepel a kártyán');
});

test('a hiányzó vagy elutasított múltbeli tételek elöl maradnak, az inaktív ügyfélé kimarad, és 8 felett lenyitható', () => {
  const obligations = [
    { id: 1, c: 'c16', formCode: '2608', title: 'Októberi járulék', dueDate: '2026-11-12', conditional: false, status: 'missing', pay: [] },
    { id: 99, c: 'c_off', formCode: '2665', title: 'Inaktív cég ÁFA', dueDate: '2026-11-20', conditional: false, status: 'submittable', pay: [] },
  ];
  for (let i = 2; i <= 10; i++) {
    obligations.push({
      id: i, c: 'c16', formCode: `26${String(i).padStart(2, '0')}`,
      title: `Bevallás #${i}`, dueDate: `2026-12-${String(10 + i).padStart(2, '0')}`,
      conditional: false, status: 'submittable', pay: [],
    });
  }
  const h = makeHarness({
    clients: [
      { id: 'c16', name: 'Teszt Zrt.', tax: '12345678-2-42', active: true, sync: { ok: true, at: '11-15 01:18' } },
      { id: 'c_off', name: 'Inaktív Kft.', tax: '11111111-1-41', active: false, sync: { ok: true, at: '11-15 01:18' } },
    ],
    obligations,
  });

  const collapsed = h.homeUpoSection();
  assert.ok(!collapsed.includes('Inaktív Kft.'), 'inaktív ügyfél adónaptára nem jelenik meg');
  assert.match(collapsed, /1 lejárt \/ hibás/);
  assert.match(collapsed, /3 napja lejárt/);
  assert.equal((collapsed.match(/class="hupo-card"/g) || []).length, 8, 'alapból legfeljebb 8 kártya látszik');
  assert.match(collapsed, /Mind a 10 közelgő esemény megjelenítése/);

  h.S.homeUpoAll = true;
  const expanded = h.homeUpoSection();
  assert.equal((expanded.match(/class="hupo-card"/g) || []).length, 10, 'lenyitva mind a 10 kártya látszik');
  assert.match(expanded, /Kevesebb megjelenítése/);
});

test('üres és minden-beadva állapotok megjelenítése', () => {
  const emptyH = makeHarness({ obligations: [] });
  assert.match(emptyH.homeUpoSection(), /Még nincs beolvasott NAV adónaptár-esemény/);

  const doneH = makeHarness({
    obligations: [
      { id: 1, c: 'c16', formCode: '2665', title: 'ÁFA', dueDate: '2026-11-20', conditional: false, status: 'submitted', pay: [] },
    ],
  });
  assert.match(doneH.homeUpoSection(), /Minden közelgő adónaptár-kötelezettség beadva/);
});

test('a Jóváhagyások kártya üres állapotban nem jelenik meg, függő kérésnél pedig a bal oszlopban (Ezzel kezdd alatt, Iratok feldolgozottsága előtt) áll', () => {
  const emptyOut = makeHarness({ approvals: [] }).vHome();
  assert.doesNotMatch(emptyOut, /Jóváhagyások/, 'üres APPR mellett a Jóváhagyások kártya nem jelenik meg');

  const withApprOut = makeHarness({
    messages: [{ id: 'm1', c: 'c16', s: 'NAV', sub: 'Határozat', off: 'wait', int: 'uj', arch: false, sys: false }],
    approvals: [{ id: 7, mid: 'm1', by: 'MJ', mine: false }],
    canDecide: () => true,
  }).vHome();
  const iTodo = withApprOut.indexOf('Ezzel kezdd');
  const iAppr = withApprOut.indexOf('Jóváhagyások');
  const iProc = withApprOut.indexOf('Iratok feldolgozottsága');
  assert.ok(iTodo > 0 && iAppr > iTodo && iProc > iAppr, 'a Jóváhagyások kártya a bal oldali stackben, az Iratok feldolgozottsága előtt jelenik meg');
  assert.match(withApprOut, /1 átvételi kérés vár jóváhagyásra\./);
  assert.match(withApprOut, /data-decide="7:1">Jóváhagyom<\/button>/);
});
