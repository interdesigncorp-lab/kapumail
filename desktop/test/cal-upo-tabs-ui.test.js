// A „Határidők és bevallások” összevont oldalsáv-menüpont, a két felső főfül (`Határidőnaptár` / `NAV bevallások és mátrix`)
// és a rózsaszín Iratok mappasáv automatikus elrejtésének (`syncCalFold`) tesztje közvetlenül az app.html forrásából.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(repoRoot, 'app', 'resources', 'ui', 'app.html'), 'utf8');
const guide = JSON.parse(fs.readFileSync(path.join(repoRoot, 'app', 'resources', 'mcp', 'ui-guide.json'), 'utf8'));

test('a bal oldali sávon egyetlen „Határidők és bevallások” menüpont szerepel, amely mindkét fülön aktív marad és átveszi a figyelmeztető pöttyöt', () => {
  const railMatch = html.match(/const RAIL=\[[^\n]+\];/);
  assert.ok(railMatch, 'RAIL definíció megtalálható');
  assert.match(railMatch[0], /\['cal','Határidők és bevallások','cal'\]/);
  assert.doesNotMatch(railMatch[0], /\['upo'/);

  const sRail = html.indexOf('function renderRail()');
  const eRail = html.indexOf('function renderFolders()');
  assert.ok(sRail > 0 && eRail > sRail, 'renderRail megtalálható');

  const runRail = (area, obligations) => {
    const railEl = { innerHTML: '' };
    return new Function(
      'S', 'M', 'OBLIGATIONS', 'CLIENTS', 'APPR', 'NOTIF', 'ME', 'MEU', 'window', 'railEl', 'ic', 'esc', 'isSent', 'canDecide',
      `const $=s=>s==='#rail'?railEl:null;\n${railMatch[0]}\n${html.slice(sRail, eRail)}\nrenderRail(); return railEl.innerHTML;`
    )(
      { area },
      [],
      obligations,
      [],
      [],
      [],
      'MJ',
      { name: 'Minta János', role: 'admin' },
      {},
      railEl,
      n => `<i data-ic="${n}"></i>`,
      s => String(s ?? ''),
      () => false,
      () => false,
    );
  };

  const calClean = runRail('cal', [{ status: 'submittable' }]);
  assert.match(calClean, /<button data-area="cal" aria-label="Határidők és bevallások" title="Határidők és bevallások" aria-current="true"><i data-ic="cal"><\/i><\/button>/);
  assert.doesNotMatch(calClean, /data-area="upo"/);

  const upoWithAlert = runRail('upo', [{ status: 'missing' }]);
  assert.match(
    upoWithAlert,
    /<button data-area="cal" aria-label="Határidők és bevallások" title="Határidők és bevallások" aria-current="true"><i data-ic="cal"><\/i><span class="dot"><\/span><\/button>/,
    'a NAV bevallások fülön is a Határidők és bevallások sávgomb aktív, és jelzi a hiányzó/hibás bevallást'
  );
});

test('a közös felső fülváltó (calHead) mindkét nézetben megjelenik, jelvénnyel jelzi a hiányzó/hibás bevallásokat, és a vUpo megtartja az 5 kártyát és a mátrixot', () => {
  const sPay = html.indexOf('const UPO_ST=');
  const eCal = html.indexOf("document.addEventListener('click',", html.indexOf('function vCal()'));
  const sUpo = html.indexOf('function upoBadge(o)');
  const eUpo = html.indexOf('function totpPillHtml(');
  assert.ok(sPay > 0 && eCal > sPay && sUpo > 0 && eUpo > sUpo);

  const makeViews = (obligations, area = 'cal', upoTab = 'matrix', calExtra = {}) => {
    const S = {
      area,
      cal: { view: 'week', at: '2026-11-15', fopen: false, cats: { nav: true, upo: true, onk: true, jog: true, egyeb: true }, sure: 'all', who: '', client: '', ...calExtra },
      upo: { tab: upoTab, q: '' },
    };
    const clients = [{ id: 'c1', name: 'Minta Kft.', tax: '12345678-2-42', active: true }];
    const CATS = { nav: ['NAV', '#6d4be8', '#efeaff'], upo: ['Adónaptár (NAV)', '#d96b00', '#fff0db'], onk: ['Önkormányzat', '#1a78c9', '#e1f1ff'], jog: ['Bíróság', '#c02d86', '#ffe6f4'], egyeb: ['Egyéb', '#0d857a', '#daf6f1'] };
    const MONTHS = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];
    const DOW = ['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek', 'Szombat', 'Vasárnap'];
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const monOf = d => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
    const fmtD = d => `nov. ${+d.slice(8)}.`;

    const fn = new Function(
      'S', 'TODAY', 'OFFICE', 'M', 'OBLIGATIONS', 'CLIENTS', 'PEOPLE', 'CATS', 'MONTHS', 'DOW', 'INT', 'SYNCBUSY', 'UPO_BUSY',
      'esc', 'ic', 'C', 'catOf', 'addDays', 'monOf', 'weekNo', 'payBlock', 'goBtn', 'dlChip', 'tblw', 'canAdmin', 'fmtD', 'daysTo', 'st', 'navPer',
      `${html.slice(sPay, eCal)}\n${html.slice(sUpo, eUpo)}\nreturn { calHead, vCal, vUpo };`
    );
    return fn(
      S, '2026-11-15', { single: false }, [], obligations, clients, { MJ: 'Minta János' }, CATS, MONTHS, DOW, { folyamatban: 'Folyamatban', kesz: 'Kész' },
      false, false, esc, n => `<i data-ic="${n}"></i>`, id => clients.find(c => c.id === id), m => m._upo ? 'upo' : 'nav',
      addDays, monOf, () => 46, () => '', () => '', () => '', h => `<div class="tblw">${h}</div>`, () => true, fmtD, () => 5, () => '', () => '2026. okt.'
    );
  };

  const viewsClean = makeViews([
    { id: 1, c: 'c1', formCode: '2608', title: 'Havi járulék', dueDate: '2026-12-14', conditional: false, status: 'submittable' },
    { id: 2, c: 'c1', formCode: '26A60', title: 'Összesítő', dueDate: '2026-11-20', conditional: true, status: 'conditional' },
  ]);

  const calOut = viewsClean.vCal();
  assert.match(calOut, /<h3>Határidők és bevallások<\/h3>/);
  assert.match(calOut, /role="tab" data-area="cal" aria-selected="true" aria-pressed="true"><i data-ic="cal"><\/i>Határidőnaptár<\/button>/);
  assert.match(calOut, /role="tab" data-area="upo" aria-selected="false" aria-pressed="false"><i data-ic="file"><\/i>NAV bevallások és mátrix<\/button>/, '0 hibás tételnél nincs jelvény a második fülön');
  assert.match(calOut, /class="calhead">[\s\S]*?<div class="acts">[\s\S]*?data-syncfull[\s\S]*?Szinkronizálás[\s\S]*?kapumail-hataridok\.ics[\s\S]*?Naptárfájl<\/a><div class="calfw"><button type="button" class="btn calfbtn" data-calfopen aria-expanded="false"[\s\S]*?<i data-ic="filter"><\/i><\/button><\/div><\/div><\/div><div class="calgrid">/, 'a Szinkronizálás, a Naptárfájl és a négyzetes fekete szűrőgomb a felső calhead jobb oldalán áll');
  assert.doesNotMatch(calOut, /id="calfpop"/, 'alapból csukva van a szűrőbuborék');
  assert.doesNotMatch(calOut, /<aside class="calside">[\s\S]*?Bizonyosság[\s\S]*?<\/aside>/, 'a Bizonyosság / Ügyfél kártya kikerült a bal oldalsávból');
  assert.match(calOut, /<div class="calacts"><button class="btn ghost today" data-calnav="0">Ma<\/button>\s*<div class="seg tabs"/, 'a naptárkártya belső sávjában már csak a Ma és a Hét/Hónap/Lista maradt');
  assert.match(calOut, /class="calside"/, 'a mini-naptár oldalsáv megmarad a Határidőnaptár fülön');
  assert.match(calOut, /data-calview="week"/);
  assert.match(calOut, /data-calview="month"/);
  assert.match(calOut, /data-calview="list"/);

  const calFilterOpen = makeViews([], 'cal', 'matrix', { fopen: true, sure: 'sure', client: 'c1' }).vCal();
  assert.match(calFilterOpen, /data-calfopen aria-expanded="true"[^>]*><i data-ic="filter"><\/i><span class="cnt">2<\/span><\/button>/, 'aktív szűrőknél jelvény jelenik meg a fekete szűrőgombon');
  assert.match(calFilterOpen, /id="calfpop"[\s\S]*?data-calfclear[\s\S]*?Bizonyosság[\s\S]*?data-calsure="sure" aria-pressed="true"[\s\S]*?data-calclient[\s\S]*?Minta Kft\./, 'nyitott állapotban megjelenik a kompakt szűrőpanel');

  const viewsBad = makeViews([
    { id: 1, c: 'c1', formCode: '2608', title: 'Havi járulék', dueDate: '2026-11-12', conditional: false, status: 'missing' },
    { id: 2, c: 'c1', formCode: '2665', title: 'ÁFA', dueDate: '2026-11-20', conditional: false, status: 'rejected' },
    { id: 3, c: 'c1', formCode: '26A60', title: 'Összesítő', dueDate: '2026-11-20', conditional: true, status: 'conditional' },
  ], 'upo', 'matrix');

  const upoOut = viewsBad.vUpo();
  assert.match(upoOut, /<h3>Határidők és bevallások<\/h3>/);
  assert.match(upoOut, /role="tab" data-area="cal" aria-selected="false" aria-pressed="false"><i data-ic="cal"><\/i>Határidőnaptár<\/button>/);
  assert.match(upoOut, /role="tab" data-area="upo" aria-selected="true" aria-pressed="true"><i data-ic="file"><\/i>NAV bevallások és mátrix<span class="cnt" title="2 hiányzó vagy elutasított bevallás">2<\/span><\/button>/);
  assert.equal((upoOut.match(/class="tile[\s"]/g) || []).length, 5, 'mind az 5 számlálókártya megjelenik');
  assert.match(upoOut, /data-upotab="matrix"[^>]*>Adónaptár mátrix<\/button>/);
  assert.match(upoOut, /data-upotab="list"[^>]*>Minden bevallás<\/button>/);
  assert.match(upoOut, /data-upotab="alerts"[^>]*>Hiányzó és hibás<\/button>/);
  assert.match(upoOut, /Minta Kft\./);
  assert.match(upoOut, /<th>2608<\/th><th>2665<\/th><th>26A60<\/th>/);
});

test('a rózsaszín Iratok mappasáv (nofold) a Határidők és bevallások oldalon alapból összecsukódik, más nézetre visszalépve pedig visszaáll', () => {
  const sFold = html.indexOf('const isCalArea=');
  const eFold = html.indexOf('function render(){');
  assert.ok(sFold > 0 && eFold > sFold, 'syncCalFold megtalálható az app.html-ben');

  const makeFoldHarness = ({ area = 'inbox', nofold = true, width = 1440 } = {}) => {
    const classes = new Set(nofold ? ['app', 'nofold'] : ['app']);
    const appEl = {
      classList: {
        contains: c => classes.has(c),
        add: c => classes.add(c),
        remove: c => classes.delete(c),
        toggle: (c, force) => {
          const on = force === undefined ? !classes.has(c) : !!force;
          if (on) classes.add(c); else classes.delete(c);
          return on;
        },
      },
    };
    const S = { area };
    const syncCalFold = new Function(
      'S', '$', 'innerWidth',
      `${html.slice(sFold, eFold)}\nreturn syncCalFold;`
    )(S, sel => (sel === '#app' ? appEl : null), width);
    return { S, appEl, syncCalFold, isOpen: () => classes.has('nofold') };
  };

  // 1. Inboxból indulva nyitott mappasávval -> cal/upo elrejti -> inbox visszaállítja
  const h1 = makeFoldHarness({ area: 'inbox', nofold: true });
  h1.syncCalFold();
  assert.equal(h1.isOpen(), true, 'Inboxban nyitva marad a mappasáv');
  h1.S.area = 'cal';
  h1.syncCalFold();
  assert.equal(h1.isOpen(), false, 'Határidőnaptárra lépve a rózsaszín Iratok mappasáv automatikusan elrejtőzik');
  h1.S.area = 'upo';
  h1.syncCalFold();
  assert.equal(h1.isOpen(), false, 'a két fül közti váltáskor is rejtve marad');
  h1.S.area = 'inbox';
  h1.syncCalFold();
  assert.equal(h1.isOpen(), true, 'Bejövő iratokra visszalépve a mappasáv visszaáll nyitottra');

  // 2. Közvetlen #a=cal indulás asztali méretben: azonnal rejtett, később inboxra lépve kinyílik
  const h2 = makeFoldHarness({ area: 'cal', nofold: true, width: 1440 });
  h2.syncCalFold();
  assert.equal(h2.isOpen(), false, 'közvetlen #a=cal betöltéskor is azonnal elrejtőzik a mappasáv');
  h2.S.area = 'inbox';
  h2.syncCalFold();
  assert.equal(h2.isOpen(), true, 'közvetlen #a=cal indulás után az Inboxba lépve megjelenik a mappasáv');

  // 3. Ha a felhasználó az Inboxban kézzel összecsukta a mappasávot, cal után visszatérve is csukva marad
  const h3 = makeFoldHarness({ area: 'inbox', nofold: false, width: 1440 });
  h3.syncCalFold();
  h3.S.area = 'upo';
  h3.syncCalFold();
  assert.equal(h3.isOpen(), false);
  h3.S.area = 'inbox';
  h3.syncCalFold();
  assert.equal(h3.isOpen(), false, 'tiszteletben tartja a felhasználó korábbi összecsukott állapotát');
});

test('az MCP ui-guide.json tükrözi az összevont Határidők és bevallások menüpontot és a két főfület', () => {
  const byKey = Object.fromEntries(guide.topics.map(t => [t.key, t]));
  assert.match(byKey.cal.title, /Határidők és bevallások: Határidőnaptár/);
  assert.match(byKey.cal.where, /Határidők és bevallások/);
  assert.match(byKey.upo.title, /Határidők és bevallások: NAV bevallások és mátrix/);
  assert.match(byKey.upo.where, /NAV bevallások és mátrix/);
  assert.match(byKey.clients.where, /ötödik ikon/);
});
