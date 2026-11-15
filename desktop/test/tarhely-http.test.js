const test = require('node:test');
const assert = require('node:assert');
const H = require('../tarhely-http');

// ----------------------------------------------------------------- engedélylista
test('csak https és csak a KAÜ-lánc gépei engedélyezettek', () => {
  assert.equal(H.isAllowedUrl('https://tarhely.gov.hu/levelezes/'), true);
  assert.equal(H.isAllowedUrl('https://idp.gov.hu/idp/saml/authnrequest'), true);
  assert.equal(H.isAllowedUrl('https://kau.gov.hu/proxy/saml/response'), true);
  assert.equal(H.isAllowedUrl('http://tarhely.gov.hu/'), false, 'http nem');
  assert.equal(H.isAllowedUrl('https://ugyfelportal.nav.gov.hu/'), false, 'más gov.hu nem');
  assert.equal(H.isAllowedUrl('https://tarhely.gov.hu.evil.com/'), false, 'álcázott hoszt nem');
  assert.throws(() => H.assertAllowed('https://evil.example/'), /Nem engedélyezett/);
});

// ----------------------------------------------------------------- sütitár
test('a sütitár tiszteli a domaint, az útvonalat és a secure jelzőt', () => {
  const jar = new H.CookieJar();
  jar.store('https://tarhely.gov.hu/levelezes/login', ['XSRF-TOKEN=abc; Path=/; Secure', 'JSESSIONID=sess; Path=/levelezes; HttpOnly']);
  assert.equal(jar.get('https://tarhely.gov.hu/levelezes/api/mailbox/reload', 'XSRF-TOKEN'), 'abc');
  assert.equal(jar.get('https://tarhely.gov.hu/levelezes/api/mailbox/reload', 'JSESSIONID'), 'sess');
  // más útvonalra a /levelezes süti nem megy
  assert.equal(jar.get('https://tarhely.gov.hu/masik', 'JSESSIONID'), undefined);
  // más hoszt nem kapja meg (host-only)
  assert.equal(jar.get('https://kau.gov.hu/', 'XSRF-TOKEN'), undefined);
});

test('idegen domainre a Set-Cookie nem állítható', () => {
  const jar = new H.CookieJar();
  jar.store('https://idp.gov.hu/idp', ['X=1; Domain=evil.com']);
  assert.equal(jar.names().length, 0);
});

test('lejárt süti (Max-Age=0) törli a korábbit', () => {
  const jar = new H.CookieJar();
  jar.store('https://tarhely.gov.hu/', ['A=1; Path=/']);
  jar.store('https://tarhely.gov.hu/', ['A=2; Path=/; Max-Age=0']);
  assert.equal(jar.get('https://tarhely.gov.hu/', 'A'), undefined);
});

test('kész munkamenet sütikkel seedelhető (B opció)', () => {
  const jar = new H.CookieJar();
  jar.seed([{ name: 'XSRF-TOKEN', value: 'tok', domain: 'tarhely.gov.hu', path: '/', secure: true, hostOnly: true }]);
  assert.equal(jar.get('https://tarhely.gov.hu/levelezes/', 'XSRF-TOKEN'), 'tok');
});

// ----------------------------------------------------------------- űrlapok
test('parseForms kiolvassa a rejtett mezőket, a módszert és az abszolút action-t', () => {
  const html = `<form id="f1" method="post" action="/proxy/saml/authnrequest">
    <input type="hidden" name="SAMLRequest" value="PD94"/>
    <input type="hidden" name="RelayState" value="aHR0"/>
    <input type="submit" value="megy"/></form>`;
  const [f] = H.parseForms(html, 'https://tarhely.gov.hu/levelezes/login');
  assert.equal(f.id, 'f1');
  assert.equal(f.method, 'POST');
  assert.equal(f.action, 'https://tarhely.gov.hu/proxy/saml/authnrequest');
  assert.deepEqual(f.fields.map(x => x.name).sort(), ['RelayState', 'SAMLRequest']);
  assert.equal(H.isAutoPost(f), true);
});

test('az azonosítási mód és a jelszó/TOTP űrlap felismerése', () => {
  const selector = H.parseForms(`
    <form id="urn:eksz.gov.hu:1.0:azonositas:kau:3:dap:qr"><input type="hidden" name="x" value="1"></form>
    <form id="urn:eksz.gov.hu:1.0:azonositas:kau:2:uk:totp"><input type="hidden" name="x" value="2"></form>`, 'https://kau.gov.hu/proxy/saml/authservice');
  assert.equal(H.findSelectorForm(selector).id, 'urn:eksz.gov.hu:1.0:azonositas:kau:2:uk:totp');

  const pw = H.parseForms('<form id="login-form"><input name="felhasznaloNev" type="text"><input name="jelszo" type="password"></form>', 'https://idp.gov.hu/');
  assert.ok(H.findPasswordForm(pw));
  assert.equal(H.findTotpForm(pw), undefined, 'a jelszóűrlap nem TOTP-űrlap');

  const totp = H.parseForms('<form id="login-form"><input name="name" type="text"><input name="token" id="identifier" type="text"></form>', 'https://idp.gov.hu/');
  assert.ok(H.findTotpForm(totp));

  assert.equal(H.pageError('<div class="alert-danger">Hibás kód</div>'), 'Hibás kód');
});

// ----------------------------------------------------------------- adat-leképezés
test('toMailboxRefs csak az azonosítóval rendelkező fiókokat tartja meg', () => {
  const refs = H.toMailboxRefs([
    { azonosito: 'AID1', mailboxName: 'Saját' },
    { azonosito: '', mailboxName: 'Üres' },
    { megnevezes: 'Nincs azonosító' },
    { azonosito: 'AID2' },
  ]);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs.map(r => r.addressId), ['AID1', 'AID2']);
  // A név belépőnként egyedi kulcs: nem adószámos névnél az állandó azonosító eleje is benne van.
  assert.equal(refs[0].name, 'Saját · AID1');
  assert.equal(refs[1].name, 'postafiók 4 · AID2', 'név nélkül index-alapú címke');
});

test('toMailboxRefs a valódi postafiók-lista alakjával: a Cégkapu kulcsa az adószám-törzs, a saját tárhelyé belépőnként egyedi', () => {
  const id = 'a'.repeat(8) + 'b'.repeat(56);
  const refs = H.toMailboxRefs([
    { officeState: 'ACTIVE', defaultMailbox: true, name: 'értesítési tárhely', type: 'AP', mailboxName: 'értesítési tárhely', megnevezes: 'értesítési tárhely', azonosito: id },
    { officeState: 'ACTIVE', defaultMailbox: false, name: 'Példa Kereskedelmi Kft', type: 'CKP', mailboxName: '12345676', megnevezes: '12345676', azonosito: 'c'.repeat(64) },
  ]);
  assert.deepEqual(refs.map(r => [r.name, r.rawName, r.displayName, r.type, r.isDefault]), [
    ['értesítési tárhely · aaaaaaaa', 'értesítési tárhely', 'értesítési tárhely', 'AP', true],
    ['12345676', '12345676', 'Példa Kereskedelmi Kft', 'CKP', false],
  ]);
  // Két belépő saját tárhelye ugyanúgy hívódik, a kulcsuk mégis különbözik.
  const other = H.toMailboxRefs([{ name: 'értesítési tárhely', type: 'AP', mailboxName: 'értesítési tárhely', azonosito: 'd'.repeat(64) }]);
  assert.notEqual(other[0].name, refs[0].name);
});

test('toLetterRows tárgy nélkül, érkeztetési szám kötelező', () => {
  const rows = H.toLetterRows({ uzenetek: [
    { erkeztetesiSzam: 'E1', feladoNev: 'NAV', tipus: 'Hivatalos', erkezesiDatum: '2026-11-04T08:00:00Z' },
    { feladoNev: 'nincs eid' },
  ] }, 'Saját');
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['desc', 'durable', 'eid', 'folder', 'mailbox', 'portalOpened', 'receivedAt', 'recipient', 'sender', 'senderFull', 'size', 'type']);
  assert.equal(rows[0].receivedAt, '2026-11-04 08:00');
  assert.deepEqual([rows[0].portalOpened, rows[0].size, rows[0].folder], [null, null, 'BEERKEZETT'], 'hiányzó mezőknél nem találgat');
  // A valódi levélsor alakja: ezredmásodperces dátum, címzett név és rövid név, olvasatlan jelző.
  const real = H.toLetterRows({ uzenetek: [{ erkezesiDatum: Date.UTC(2026, 10, 4, 8, 0), cimzettNev: 'Példa Kft', cimzettRovidNev: '12345676', feladoRovidNev: 'NAV', feladoNev: 'Nemzeti Adó- és Vámhivatal',
    dokumentumLeiras: 'Elfogadó nyugta (2665A_12345676241_x.xml)', tarolasiHely: 'TARTOSTAR', fajlMeret: 24576, olvasatlan: false, dokumentumTipus: 'igazolas', erkeztetesiSzam: '123', cimkek: [] }] }, '12345676', 'TARTOS_TAR')[0];
  assert.deepEqual(real, { eid: '123', mailbox: '12345676', sender: 'NAV', senderFull: 'Nemzeti Adó- és Vámhivatal', recipient: 'Példa Kft 12345676', type: 'igazolas',
    desc: 'Elfogadó nyugta (2665A_12345676241_x.xml)', receivedAt: '2026-11-04 08:00', size: 24576, portalOpened: true, durable: true, folder: 'TARTOS_TAR' });
  assert.ok(!('tárgy' in rows[0]) && !('subject' in rows[0]));
});

test('ismeretlen address-id elutasítása (fiók-elszigetelés)', () => {
  const ctx = { mailboxes: [{ addressId: 'AID1', name: 'A' }] };
  assert.doesNotThrow(() => H.assertKnownAddressId(ctx, 'AID1'));
  assert.throws(() => H.assertKnownAddressId(ctx, 'AID9'), /Ismeretlen postafiók/);
});

// ----------------------------------------------------------------- teljes lánc ál-fetchcsel
function resp(status, body, { location = null, setCookie = [], json = false } = {}) {
  const headers = new Map();
  if (location) headers.set('location', location);
  headers.set('content-type', json ? 'application/json' : 'text/html; charset=utf-8');
  return {
    status,
    headers: { get: k => headers.get(k.toLowerCase()) ?? null, getSetCookie: () => setCookie },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

// Ál-KAÜ-lánc: a kísérlet által megfigyelt lépéseket utánozza, titkokat ellenőrizve.
function fakeKau() {
  const seen = { password: null, token: null, addressIds: [] };
  const autoPost = (name, action) => `<form id="a" method="post" action="${action}"><input type="hidden" name="${name}" value="X"><input type="submit"></form>`;
  const fetchImpl = async (url, init) => {
    const u = new URL(url); const p = u.host + u.pathname; const body = init.body || '';
    if (p === 'tarhely.gov.hu/levelezes/login' && init.method !== 'POST')
      return resp(200, autoPost('SAMLRequest', 'https://kau.gov.hu/proxy/saml/authnrequest'));
    if (p === 'kau.gov.hu/proxy/saml/authnrequest')
      return resp(303, '', { location: 'https://kau.gov.hu/proxy/saml/authservice', setCookie: ['ROUTEID=k; Path=/'] });
    if (p === 'kau.gov.hu/proxy/saml/authservice' && init.method !== 'POST')
      return resp(200, `<form id="urn:eksz.gov.hu:1.0:azonositas:kau:2:uk:totp" method="post" action="https://kau.gov.hu/proxy/saml/authservice"><input type="hidden" name="authServiceUri" value="totp"><input type="submit"></form>`);
    if (p === 'kau.gov.hu/proxy/saml/authservice' && init.method === 'POST')
      return resp(200, autoPost('SAMLRequest', 'https://idp.gov.hu/idp/saml/authnrequest/start'));
    if (p === 'idp.gov.hu/idp/saml/authnrequest/start')
      return resp(303, '', { location: 'https://idp.gov.hu/idp/saml/authnrequest' });
    if (p === 'idp.gov.hu/idp/saml/authnrequest' && init.method !== 'POST')
      return resp(200, '<form id="login-form" method="post" action="https://idp.gov.hu/idp/saml/authnrequest"><input name="felhasznaloNev" type="text"><input name="jelszo" type="password"><input type="submit"></form>');
    if (p === 'idp.gov.hu/idp/saml/authnrequest' && init.method === 'POST' && body.includes('jelszo=')) {
      seen.password = new URLSearchParams(body).get('jelszo');
      return resp(200, '<form id="login-form" method="post" action="https://idp.gov.hu/idp/saml/authnrequest"><input name="name" type="text"><input name="token" id="identifier" type="text"><input type="submit"></form>');
    }
    if (p === 'idp.gov.hu/idp/saml/authnrequest' && init.method === 'POST' && body.includes('token=')) {
      seen.token = new URLSearchParams(body).get('token');
      return resp(200, autoPost('SAMLResponse', 'https://kau.gov.hu/proxy/saml/response'));
    }
    if (p === 'kau.gov.hu/proxy/saml/response')
      return resp(200, autoPost('SAMLResponse', 'https://tarhely.gov.hu/levelezes/login'));
    if (p === 'tarhely.gov.hu/levelezes/login' && init.method === 'POST')
      return resp(302, '', { location: 'https://tarhely.gov.hu/levelezes/', setCookie: ['XSRF-TOKEN=xtok; Path=/; Secure', 'JSESSIONID=s; Path=/'] });
    if (p === 'tarhely.gov.hu/levelezes/' )
      return resp(200, '<html><title>BKSZ - Levelezés</title></html>');
    if (p === 'tarhely.gov.hu/levelezes/api/mailbox/reload')
      return resp(200, [{ azonosito: 'AID1', mailboxName: 'Saját' }, { azonosito: 'AID2', mailboxName: 'Céges' }], { json: true });
    if (p === 'tarhely.gov.hu/levelezes/api/uzenetek/BEERKEZETT/kereses') {
      const aid = init.headers['address-id']; seen.addressIds.push(aid);
      const rows = aid === 'AID2' ? [{ erkeztetesiSzam: 'E1', feladoNev: 'NAV', erkezesiDatum: '2026-11-04T08:00:00Z' }] : [];
      return resp(200, { uzenetek: rows, uzenetekSzama: rows.length }, { json: true });
    }
    throw new Error('ismeretlen hívás a tesztben: ' + p);
  };
  return { fetchImpl, seen };
}

test('loginWithCredentials végigjárja a láncot és behozza a postafiókokat', async () => {
  const { fetchImpl, seen } = fakeKau();
  const ctx = await H.loginWithCredentials({ username: 'u', password: 'titkosjelszo', getCode: async () => '123456' }, { fetchImpl });
  assert.equal(seen.password, 'titkosjelszo');
  assert.equal(seen.token, '123456');
  assert.deepEqual(ctx.mailboxes.map(m => m.addressId), ['AID1', 'AID2']);
});

test('listMailbox az address-id fejlécet küldi, és csak ismert fiókra', async () => {
  const { fetchImpl, seen } = fakeKau();
  const ctx = await H.loginWithCredentials({ username: 'u', password: 'p', getCode: async () => '000000' }, { fetchImpl });
  const a = await H.listMailbox(ctx, 'AID1');
  const b = await H.listMailbox(ctx, 'AID2');
  assert.equal(a.length, 0);
  assert.equal(b.length, 1);
  assert.equal(b[0].eid, 'E1');
  assert.deepEqual(seen.addressIds, ['AID1', 'AID2']);
  await assert.rejects(() => H.listMailbox(ctx, 'IDEGEN'), /Ismeretlen postafiók/);
});

test('hibás jelszó esetén érthető hiba, kód beküldése nélkül', async () => {
  const { fetchImpl } = fakeKau();
  // a jelszóoldal után ismét jelszóoldalt adó ál-fetch
  const wrong = async (url, init) => {
    const r = await fetchImpl(url, init);
    const u = new URL(url);
    if (u.host + u.pathname === 'idp.gov.hu/idp/saml/authnrequest' && init.method === 'POST' && (init.body || '').includes('jelszo='))
      return resp(200, '<form id="login-form" method="post" action="https://idp.gov.hu/idp/saml/authnrequest"><input name="felhasznaloNev" type="text"><input name="jelszo" type="password"></form><div class="alert-danger">Hibás belépési adatok</div>');
    return r;
  };
  let codeAsked = false;
  await assert.rejects(
    () => H.loginWithCredentials({ username: 'u', password: 'rossz', getCode: async () => { codeAsked = true; return '111111'; } }, { fetchImpl: wrong }),
    /Hibás felhasználónév vagy jelszó/);
  assert.equal(codeAsked, false, 'hibás jelszónál a kódot be sem kéri');
});

test('ELKULDOTT mappa: kuldesiDatum, recipientShort, refEid leképezés, listAll({ sent: true }) és letöltés /elkuldott/ ágon', async () => {
  const sentRow = H.toLetterRows({ uzenetek: [{
    erkeztetesiSzam: 'SENT-1', feladoRovidNev: '12345676', feladoNev: 'Példa Kft',
    cimzettNev: 'Nemzeti Adó- és Vámhivatal', cimzettRovidNev: 'NAV',
    dokumentumTipus: '2665A', dokumentumLeiras: 'ÁFA bevallás',
    kuldesiDatum: Date.UTC(2026, 10, 14, 9, 30), fajlMeret: 12000,
    hivatkozottErkeztetesiSzam: 'REF-999',
  }] }, '12345676', 'ELKULDOTT')[0];
  assert.equal(sentRow.folder, 'ELKULDOTT');
  assert.equal(sentRow.receivedAt, '2026-11-14 09:30');
  assert.equal(sentRow.recipientShort, 'NAV');
  assert.equal(sentRow.refEid, 'REF-999');
  assert.equal(sentRow.durable, false);

  const { createGovTwin, accountantScenario } = require('../simulator/gov-twin');
  const twin = createGovTwin(accountantScenario());
  const ctx = await H.loginWithCredentials({
    username: twin.credentials.konyvelo.username,
    password: twin.credentials.konyvelo.password,
    seed: twin.credentials.konyvelo.totpSeed,
  }, { fetchImpl: twin.fetchImpl });

  const withoutSent = await H.listAll(ctx, { sleep: async () => {} });
  assert.equal(withoutSent.some(r => r.folder === 'ELKULDOTT'), false);

  const withSent = await H.listAll(ctx, { sent: true, sleep: async () => {} });
  const sentItems = withSent.filter(r => r.folder === 'ELKULDOTT');
  assert.ok(sentItems.length >= 2, 'szimulátorból bejönnek az elküldött tételek');
  const c1Sent = sentItems.find(r => r.mailbox === '12345676');
  assert.ok(c1Sent);
  assert.equal(c1Sent.recipientShort, 'NAV');

  const withSentInc = await H.listAll(ctx, { sent: true, since: new Date('2099-01-01T00:00:00Z'), sleep: async () => {} });
  assert.equal(withSentInc.some(r => r.folder === 'BEERKEZETT'), false);
  assert.ok(withSentInc.some(r => r.folder === 'ELKULDOTT'), 'növekményes futásnál az ELKULDOTT incomingFromDate nélkül (1 oldalon) jön');

  const c1Mb = ctx.mailboxes.find(m => m.name === '12345676');
  const dl = await H.downloadLetter(ctx, c1Mb.addressId, c1Sent.eid, 'ELKULDOTT');
  assert.equal(dl.ok, true);
  assert.equal(dl.folder, 'ELKULDOTT');
  assert.ok(dl.size > 0);
});
