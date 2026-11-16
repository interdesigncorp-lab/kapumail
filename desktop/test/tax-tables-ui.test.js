// Adózói táblák (6 főfül, belső alfülek, keresés, szűrés, lapozás, export, szinkron-állapot)
// asztali felületi tesztje közvetlenül az app.html forrásából.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(repoRoot, 'app', 'resources', 'ui', 'app.html'), 'utf8');

test('TC-M2-1: Bal oldali sáv (Rail) navigáció és #table SVG szimbólum', () => {
  assert.match(html, /<symbol id="table" viewBox="0 0 24 24">/, '#table SVG szimbólum megtalálható');
  assert.doesNotMatch(html, /class="empty-state/, 'idegen empty-state osztály nem szerepelhet az app.html-ben');

  const railMatch = html.match(/const RAIL=\[[^\n]+\];/);
  assert.ok(railMatch, 'RAIL definíció megtalálható');
  assert.match(
    railMatch[0],
    /\['clients','Ügyfelek és tárhelyek','users'\],\['tables','Adózói táblák','table'\]/,
    'A tables menüpont közvetlenül a clients után szerepel a felső menücsoport alján'
  );

  const sRail = html.indexOf('function renderRail()');
  const eRail = html.indexOf('function renderFolders()');
  assert.ok(sRail > 0 && eRail > sRail, 'renderRail megtalálható');

  const railEl = { innerHTML: '' };
  const out = new Function(
    'S', 'M', 'OBLIGATIONS', 'CLIENTS', 'APPR', 'NOTIF', 'ME', 'MEU', 'window', 'railEl', 'ic', 'esc', 'isSent', 'canDecide',
    `const $=s=>s==='#rail'?railEl:null;\n${railMatch[0]}\n${html.slice(sRail, eRail)}\nrenderRail(); return railEl.innerHTML;`
  )(
    { area: 'tables' },
    [],
    [],
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

  assert.match(
    out,
    /<button data-area="tables" aria-label="Adózói táblák" title="Adózói táblák" aria-current="true"><i data-ic="table"><\/i><\/button>/,
    'A táblák gomb aria-current="true" állapotot kap és a table ikont rendereli'
  );
});

function makeTaxTablesView(tablesState = {}, clients = []) {
  const S = {
    area: 'tables',
    tables: {
      tab: 'returns',
      subtab: 'missing',
      q: '',
      client: '',
      year: 2026,
      status: '',
      sortCol: '',
      sortDir: 'asc',
      page: 1,
      pageSize: 50,
      loading: false,
      data: null,
      expOpen: false,
      fopen: false,
      ...tablesState
    }
  };

  const defaultClients = clients.length ? clients : [
    { id: 1, name: 'Acme Kft.', tax: '12345678-2-42' },
    { id: 2, name: 'Beta Zrt.', tax: '87654321-2-13' }
  ];

  const sTables = html.indexOf('const ttClientCell=');
  const eTables = html.indexOf('function vRules()');
  assert.ok(sTables > 0 && eTables > sTables, 'TAX_TABLE_VIEWS és vTables megtalálható');

  const fn = new Function(
    'S', 'CLIENTS', 'UPO_BUSY', 'esc', 'ic', 'tblw', 'api', 'renderDetail', 'simpleDlg',
    `${html.slice(sTables, eTables)}\nreturn { vTables, getActiveTableView, TAX_TABLE_VIEWS, downloadTaxTablesExport, openTaxCalendarMonth };`
  );

  let lastDlg = null;
  const res = fn(
    S,
    defaultClients,
    false,
    s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    (n, c = '') => `<i data-ic="${n}" class="${c}"></i>`,
    h => `<div class="tblw">${h}</div>`,
    () => Promise.resolve({ items: [], total: 0 }),
    () => {},
    (dlgHtml, wide) => { lastDlg = { html: dlgHtml, wide }; }
  );
  res.getLastDlg = () => lastDlg;
  return res;
}

test('TC-M2-2: KapuMail fő fülváltó (.seg.tabs.settabs), másodlagos alfülek (.seg.subseg) és Adónaptár szűrők', () => {
  const { vTables } = makeTaxTablesView({ tab: 'returns', subtab: 'missing' });
  const htmlOut = vTables();

  assert.match(htmlOut, /<h3>Adózói táblák<\/h3>/);
  assert.match(htmlOut, /<div class="seg tabs settabs" role="tablist" aria-label="Adózói táblák">/);
  assert.match(htmlOut, /data-ttab="returns" aria-selected="true" aria-pressed="true">Bevallások<\/button>/);
  assert.match(htmlOut, /data-ttab="insured" aria-selected="false" aria-pressed="false">Biztosítottak<\/button>/);
  assert.match(htmlOut, /data-ttab="employers" aria-selected="false" aria-pressed="false">Saját foglalkoztatók<\/button>/);
  assert.match(htmlOut, /data-ttab="efo" aria-selected="false" aria-pressed="false">Egyszerűsített foglalkoztatottak<\/button>/);
  assert.match(htmlOut, /data-ttab="reconciliations" aria-selected="false" aria-pressed="false">Adategyeztetések<\/button>/);
  assert.match(htmlOut, /data-ttab="calendar" aria-selected="false" aria-pressed="false">Adónaptár<\/button>/);
  assert.doesNotMatch(htmlOut, /class="dtabs"/, 'a részletpanelhez való .dtabs nem használatos teljes oldalas főfülként');

  assert.match(htmlOut, /data-tsubtab="missing" aria-selected="true" aria-pressed="true">Hiányzó bevallások<\/button>/);
  assert.match(htmlOut, /data-tsubtab="all" aria-selected="false" aria-pressed="false">Bevallások<\/button>/);

  const efoOut = makeTaxTablesView({ tab: 'efo', subtab: 'declarations' }).vTables();
  assert.match(efoOut, /data-ttab="efo" aria-selected="true" aria-pressed="true">Egyszerűsített foglalkoztatottak<\/button>/);
  assert.match(efoOut, /data-tsubtab="declarations" aria-selected="true" aria-pressed="true">Bejelentések<\/button>/);
  assert.match(efoOut, /data-tsubtab="quotas" aria-selected="false" aria-pressed="false">Napkeret<\/button>/);

  const calOut = makeTaxTablesView({ tab: 'calendar' }).vTables();
  assert.match(calOut, /<select class="chip ttsel" id="tableyear" aria-label="Évválasztó">/);
  assert.match(calOut, /data-tables-status="" aria-pressed="true">Mind<\/button>/);
  assert.match(calOut, /data-tables-status="submittable" aria-pressed="false">Beadható<\/button>/);
  assert.match(calOut, /data-tables-status="missing" aria-pressed="false">Hiányzó<\/button>/);
  assert.match(calOut, /data-tables-status="submitted" aria-pressed="false">Beadva<\/button>/);
  assert.match(calOut, /data-tables-status="conditional" aria-pressed="false">Feltételes<\/button>/);
  assert.match(calOut, /data-tables-status="unknown" aria-pressed="false">Ismeretlen<\/button>/);
});

test('TC-M2-3: Oszlopfejlécek és ügyfélhivatkozások mind a 8 nézetben', () => {
  // 1.1 Hiányzó bevallások
  {
    const out = makeTaxTablesView({
      tab: 'returns',
      subtab: 'missing',
      data: {
        items: [{ client_id: 1, client_name: 'Teszt Kft.', client_tax: '11111111-2-41', form_code: '2608', title: 'Havi járulék', period: '2026.01.01 – 2026.01.31', due_date: '2026-02-12' }],
        total: 1
      }
    }).vTables();
    assert.match(out, /Adózó neve/);
    assert.match(out, /Adószám/);
    assert.match(out, /<span>Bevallás<\/span>/);
    assert.match(out, /Bevallás megnevezése/);
    assert.match(out, /Időszak/);
    assert.match(out, /Eredeti esedékesség/);
    assert.match(out, /data-cl="1"><b>Teszt Kft\.<\/b><\/button>/);
    assert.match(out, /2608/);
  }

  // 1.2 Bevallások
  {
    const out = makeTaxTablesView({
      tab: 'returns',
      subtab: 'all',
      data: {
        items: [{ barcode: 'BC123', client_id: 1, client_name: 'Teszt Kft.', client_tax: '11111111-2-41', form_code: '2608', period_from: '2026-01-01', period_to: '2026-01-31', accepted_at: '2026-02-10', error_at: '', kind: 'Eredeti', state: 'Befogadva' }],
        total: 1
      }
    }).vTables();
    ['Vonalkód', 'Adózó neve', 'Adószáma', 'Bevallás', 'Kezdete', 'Vége', 'Befogadás dátuma', 'Hibaüzenet dátuma', 'Funkció', 'Státusz', 'BC123'].forEach(txt => {
      assert.match(out, new RegExp(txt));
    });
  }

  // 2. Biztosítottak
  {
    const out = makeTaxTablesView({
      tab: 'insured',
      data: {
        items: [{ client_name: 'Teszt Kft.', name: 'Kovács János', tax_id: '8401011234', taj: '123456789', relationship_start: '2024-01-01', relationship_type: 'Munkaviszony', weekly_hours: 40 }],
        total: 1
      }
    }).vTables();
    ['Adózó', 'Név', 'Adóazonosító jel', 'TAJ szám', 'Jogviszony kezdete', 'Jogviszony', 'Heti óra', 'Kovács János', '40 óra'].forEach(txt => {
      assert.match(out, new RegExp(txt));
    });
  }

  // 3. Saját foglalkoztatók
  {
    const out = makeTaxTablesView({
      tab: 'employers',
      data: {
        items: [{ client_name: 'Egyéni Vállalkozó', employer_name: 'Fő Foglalkoztató Kft.', employer_tax_number: '22222222-2-41', employer_tax_id: '8300000000', relationship_start: '2020-03-01', relationship_type: 'Munkaviszony', weekly_hours: 20 }],
        total: 1
      }
    }).vTables();
    ['Adózó', 'Foglalkoztató neve', 'Foglalkoztató adószáma', 'Foglalkoztató adóazonosítója', 'Jogviszony kezdete', 'Jogviszony', 'Heti óra', 'Fő Foglalkoztató Kft\\.'].forEach(txt => {
      assert.match(out, new RegExp(txt));
    });
  }

  // 4.1 EFO Bejelentések
  {
    const out = makeTaxTablesView({
      tab: 'efo',
      subtab: 'declarations',
      data: {
        items: [{ client_name: 'Teszt Kft.', employee_name: 'Nagy Béla', employee_tax_id: '8411111111', employee_taj: '987654321', declaration_code: '26T1042E', employment_type: 'Mezőgazdasági', start_date: '2026-06-01', end_date: '2026-06-05', reg_no: 'IKT-123', status: 'Befogadva', filing_type: 'Új', submitted_at: '2026-05-31', seq_no: 1 }],
        total: 1
      }
    }).vTables();
    ['Adózó', 'Név', 'Adóazonosító', 'TAJ', 'Bejelentés', 'Foglalkoztatás', 'Kezdő nap', 'Záró nap', 'Ikt\\. szám', 'Állapot', 'Bejelentés típusa', 'Benyújtva', 'Sorszám', 'Nagy Béla'].forEach(txt => {
      assert.match(out, new RegExp(txt));
    });
  }

  // 4.2 EFO Napkeret
  {
    const out = makeTaxTablesView({
      tab: 'efo',
      subtab: 'quotas',
      data: {
        items: [{ client_name: 'Teszt Kft.', year: 2026, employee_name: 'Nagy Béla', employee_tax_id: '8411111111', employee_taj: '987654321', employment_type: 'Mezőgazdasági', quota_limit: 120, used_days: 15, remaining_days: 105 }],
        total: 1
      }
    }).vTables();
    ['Adózó', 'Év', 'Munkavállaló neve', 'Adóazonosító', 'TAJ', 'Foglalkoztatás', 'Keret', 'Felhasznált', 'Hátralévő', '105 nap'].forEach(txt => {
      assert.match(out, new RegExp(txt));
    });
  }

  // 5. Adategyeztetések
  {
    const out = makeTaxTablesView({
      tab: 'reconciliations',
      data: {
        items: [{ client_name: 'Teszt Kft.', client_tax: '11111111-2-41', reconciler_name: 'NAV Főigazgatóság', status: 'Beküldve', created_date: '2026-04-01', submitted_date: '2026-04-02' }],
        total: 1
      }
    }).vTables();
    ['Adózó neve', 'Adószám', 'Adategyeztető neve', 'Státusz', 'Létrehozva', 'Beküldve', 'NAV Főigazgatóság'].forEach(txt => {
      assert.match(out, new RegExp(txt));
    });
  }

  // 6. Adónaptár (12 hónapos mátrix, adózó + adószám egy oszlopban a vUpo mintájára)
  {
    const out = makeTaxTablesView({
      tab: 'calendar',
      data: {
        items: [{
          client_id: 1,
          client_name: 'Teszt Kft.',
          client_tax: '11111111-2-41',
          months: {
            1: { items: [{ id: 10 }], summary: { submittable: 1, missing: 0, submitted: 0, conditional: 0, unknown: 0 } },
            2: { items: [{ id: 11 }], summary: { submittable: 0, missing: 1, submitted: 0, conditional: 0, unknown: 0 } }
          }
        }],
        total: 1
      }
    }).vTables();
    assert.match(out, /<span>Adózó<\/span>/);
    assert.match(out, /11111111-2-41/);
    ['Január', 'Február', 'Március', 'Április', 'Május', 'Június', 'Július', 'Augusztus', 'Szeptember', 'Október', 'November', 'December'].forEach(m => {
      assert.match(out, new RegExp(m));
    });
  }
});

test('TC-M2-4: Egységes KapuMail üres állapotok (.card.empty), élő szinkron gomb mind a 8 nézeten és üres lapozó elrejtése', () => {
  // 0. Alapértelmezésben mind a 8 nézetben be van kötve az élő NAV ÜPO szinkron
  const { TAX_TABLE_VIEWS } = makeTaxTablesView();
  for (const key of ['missing_returns', 'returns', 'insured', 'employers', 'efo_declarations', 'efo_quotas', 'reconciliations', 'calendar']) {
    assert.strictEqual(TAX_TABLE_VIEWS[key].syncSupported, true, `${key} syncSupported értéke true`);
  }

  const insuredEmptySynced = makeTaxTablesView({
    tab: 'insured',
    data: { items: [], total: 0, sync_supported: true }
  }).vTables();
  assert.match(insuredEmptySynced, /<div class="card empty"><b>Nincs bejelentett biztosított<\/b>/);
  assert.match(insuredEmptySynced, /data-uposync[^>]*>[\s\S]*?NAV ügyfélportál frissítése/);

  // 1. Szerveroldali sync_supported:false tartalékág szűrő nélkül
  const unsyncedOut = makeTaxTablesView({
    tab: 'employers',
    data: { items: [], total: 0, sync_supported: false }
  }).vTables();
  assert.match(unsyncedOut, /<div class="card empty"><b>Ehhez a táblához még nincs élő NAV-szinkron<\/b>/);
  assert.match(unsyncedOut, /Élő szinkron még nincs bekötve/);
  assert.doesNotMatch(unsyncedOut, /class="pagi"/, '0 találatnál nem jelenik meg a lapozósáv');

  // 2. Bekötött szinkronú nézet (Hiányzó bevallások) szűrő nélkül
  const syncedCleanOut = makeTaxTablesView({
    tab: 'returns',
    subtab: 'missing',
    data: { items: [], total: 0, sync_supported: true }
  }).vTables();
  assert.match(syncedCleanOut, /<div class="card empty"><b>Nincs hiányzó bevallás<\/b>Az ÜPO nyilvántartása szerint minden esedékes bevallás rendben van\.<\/div>/);
  assert.match(syncedCleanOut, /data-uposync[^>]*>[\s\S]*?NAV adónaptár frissítése/);
  assert.doesNotMatch(syncedCleanOut, /class="pagi"/);

  // 3. Aktív szűrő melletti üres találat (pontosan a Feladatok nézet mintájára)
  const filteredEmptyOut = makeTaxTablesView({
    tab: 'employers',
    q: 'nemletezo',
    data: { items: [], total: 0, sync_supported: false }
  }).vTables();
  assert.match(filteredEmptyOut, /<div class="card empty"><b>A szűrőknek egy tétel sem felel meg<\/b>Módosítsd a keresést, vagy töröld a szűrőket\.<\/div>/);
});

test('TC-M2-5: Nézetfüggő keresőmező (.search), nyitott adózó/év szűrők (duplikált Szűrő gomb és fiók nélkül) és lapozás', () => {
  const missingOut = makeTaxTablesView({ tab: 'returns', subtab: 'missing' }).vTables();
  assert.match(missingOut, /placeholder="Keresés adózóra, bevallásra, időszakra…"/);
  assert.match(missingOut, /<kbd>\/<\/kbd>/);
  assert.doesNotMatch(missingOut, /data-tables-fopen/, 'nincs duplikált Szűrő gomb');
  assert.doesNotMatch(missingOut, /id="tablesf"/, 'nincs duplikált lenyitható szűrőfiók');

  const returnsOut = makeTaxTablesView({ tab: 'returns', subtab: 'all' }).vTables();
  assert.match(returnsOut, /placeholder="Keresés vonalkódra, bevallásra, adózóra…"/);

  const recOut = makeTaxTablesView({ tab: 'reconciliations' }).vTables();
  assert.match(recOut, /placeholder="Keresés adózóra, adategyeztetőre, státuszra…"/);

  const pagedOut = makeTaxTablesView({
    tab: 'insured',
    client: '1',
    data: {
      items: [
        { client_name: 'Acme Kft.', name: 'Dolgozó 1', tax_id: '8111111111', taj: '111111111', relationship_start: '2024-01-01', relationship_type: 'Munkaviszony', weekly_hours: 40 }
      ],
      total: 120,
      page: 2,
      per_page: 50
    }
  }).vTables();

  assert.match(pagedOut, /class="search ttsearch"/);
  assert.match(pagedOut, /<input id="tableq" type="search" placeholder="Kezdj el gépelni…" aria-label="Keresés a táblázatban"/);
  assert.match(pagedOut, /<select class="chip ttsel" id="tableclient" aria-label="Adózó szűrő">/);
  assert.match(pagedOut, /<option value="">Minden adózó<\/option>/);
  assert.match(pagedOut, /<option value="1" selected>Acme Kft\.<\/option>/);
  assert.match(pagedOut, /data-tables-clear>Szűrők törlése<\/button>/);
  assert.doesNotMatch(pagedOut, /data-tables-fopen/);
  assert.doesNotMatch(pagedOut, /id="tablesf"/);

  assert.match(pagedOut, /<div class="pagi">/);
  assert.match(pagedOut, /51–100 \/ 120 biztosított/);
  assert.match(pagedOut, /data-tables-pagesize/);
  assert.match(pagedOut, /data-tables-page="1"/);
  assert.match(pagedOut, /data-tables-page="3"/);
});

test('TC-M2-6: Export menü és letöltési végpontok (CSV és XLSX)', () => {
  const view = makeTaxTablesView({ tab: 'returns', subtab: 'all' });
  const out = view.vTables();

  assert.match(out, /data-tables-expmenu aria-expanded="false" title="Export"><i data-ic="down"[^>]*><\/i>Export<\/button>/);
  assert.match(out, /data-tables-exp="csv"/);
  assert.match(out, /CSV letöltése \(\.csv\)/);
  assert.match(out, /data-tables-exp="xlsx"/);
  assert.match(out, /Excel letöltése \(\.xlsx\)/);
  assert.strictEqual(view.getActiveTableView(), 'returns');
});

test('TC-M2-7: VIEWS regisztráció, / keresőfókusz és a rózsaszín Iratok mappasáv automatikus elrejtése (syncCalFold)', () => {
  const viewsMatch = html.match(/const VIEWS=\{[^\n]+\};/);
  assert.ok(viewsMatch, 'VIEWS megtalálható');
  assert.match(viewsMatch[0], /tables:vTables/);
  assert.match(html, /S\.area==='tables'\?\$\('#tableq'\)/);

  const sFold = html.indexOf('const isCalArea=');
  const eFold = html.indexOf('function render(){');
  const classes = new Set(['app', 'nofold']);
  const appEl = {
    classList: {
      contains: c => classes.has(c),
      remove: c => classes.delete(c),
      toggle: (c, force) => { if (force) classes.add(c); else classes.delete(c); }
    }
  };
  const S = { area: 'inbox' };
  const syncCalFold = new Function('S', '$', 'innerWidth', `${html.slice(sFold, eFold)}\nreturn syncCalFold;`)(
    S,
    sel => (sel === '#app' ? appEl : null),
    1440
  );
  syncCalFold();
  assert.strictEqual(classes.has('nofold'), true);
  S.area = 'tables';
  syncCalFold();
  assert.strictEqual(classes.has('nofold'), false, 'Adózói táblákra lépve a mappasáv automatikusan elrejtőzik a széles táblázatokhoz');
  S.area = 'inbox';
  syncCalFold();
  assert.strictEqual(classes.has('nofold'), true, 'Bejövő iratokra visszatérve a mappasáv visszaáll');
});

test('TC-M2-8: Tiszta oszlopfejléc-rendezés (nyíl csak az aktívan rendezett oszlopon)', () => {
  const mockData = { items: [{ name: 'Kovács János' }], total: 1 };

  const outUnsorted = makeTaxTablesView({ tab: 'insured', sortCol: '', sortDir: 'asc', data: mockData }).vTables();
  assert.match(outUnsorted, /data-tables-sort="name" aria-sort="none"><span>Név<\/span><\/th>/);
  assert.doesNotMatch(outUnsorted, /↑↓/, 'rendezetlen oszlopokon nincs zavaró ↑↓ jel');

  const outAsc = makeTaxTablesView({ tab: 'insured', sortCol: 'name', sortDir: 'asc', data: mockData }).vTables();
  assert.match(outAsc, /data-tables-sort="name" aria-sort="ascending"><span>Név<\/span><span class="sort-arr">↑<\/span><\/th>/);

  const outDesc = makeTaxTablesView({ tab: 'insured', sortCol: 'name', sortDir: 'desc', data: mockData }).vTables();
  assert.match(outDesc, /data-tables-sort="name" aria-sort="descending"><span>Név<\/span><span class="sort-arr">↓<\/span><\/th>/);
});

test('TC-M2-9: Adónaptár mátrix nyomtatványkód-jelvények, havi részletező ablak és darabszám-tartalékág', () => {
  const view = makeTaxTablesView({
    tab: 'calendar',
    year: 2026,
    data: {
      items: [{
        client_id: 1,
        client_name: 'Minta Cég Kft.',
        client_tax: '12345678-2-42',
        months: {
          2: {
            items: [
              { id: 'r1', form_code: '2608', title: 'Havi járulékbevallás', period: '2026-01-01 – 2026-01-31', submitted_at: '2026-02-02 18:59', status: 'submitted' },
              { id: 'r2', form_code: '2665', title: 'ÁFA bevallás', period: '2026-01-01 – 2026-01-31', submitted_at: '2026-02-19 16:51', status: 'submitted' }
            ],
            summary: { submittable: 0, missing: 0, submitted: 2, conditional: 0, unknown: 0 }
          },
          5: { items: [{ id: 102 }], summary: { submittable: 0, missing: 1, submitted: 0, conditional: 1, unknown: 0 } }
        }
      }],
      total: 1
    }
  });
  const out = view.vTables();

  assert.match(out, /data-tables-calcell="1:2"/);
  assert.match(out, /<span class="st ok">2608<\/span>/);
  assert.match(out, /<span class="st ok">2665<\/span>/);
  assert.match(out, /data-tip="2608: Beadva \(2026-02-02\) · 2665: Beadva \(2026-02-19\)"/);
  assert.match(out, /class="st fic" title="1 hiányzó">1<\/span>/);
  assert.match(out, /class="st cond" title="1 feltételes">1<\/span>/);
  assert.match(out, /<span class="mut">–<\/span>/);

  view.openTaxCalendarMonth(1, 2);
  const dlg = view.getLastDlg();
  assert.ok(dlg && dlg.wide, 'havi cellára kattintva széles részletező párbeszédablak nyílik');
  assert.match(dlg.html, /Minta Cég Kft\. — 2026\. február/);
  assert.match(dlg.html, /Havi járulékbevallás/);
  assert.match(dlg.html, /2026-01-01 – 2026-01-31/);
  assert.match(dlg.html, /Beadva: <span class="mono">2026-02-02 18:59<\/span>/);
  assert.match(dlg.html, /data-tables-jump-returns="1"/);
});

test('TC-M2-10: Lapozó gombok letiltása határokon', () => {
  const firstOut = makeTaxTablesView({
    tab: 'insured',
    page: 1,
    pageSize: 50,
    data: { items: [{ name: 'A' }], total: 100, page: 1, per_page: 50 }
  }).vTables();
  assert.match(firstOut, /data-tables-page="0" disabled aria-label="Előző oldal"/);
  assert.match(firstOut, /data-tables-page="2"  aria-label="Következő oldal"/);

  const lastOut = makeTaxTablesView({
    tab: 'insured',
    page: 2,
    pageSize: 50,
    data: { items: [{ name: 'B' }], total: 100, page: 2, per_page: 50 }
  }).vTables();
  assert.match(lastOut, /data-tables-page="1"  aria-label="Előző oldal"/);
  assert.match(lastOut, /data-tables-page="3" disabled aria-label="Következő oldal"/);
});
