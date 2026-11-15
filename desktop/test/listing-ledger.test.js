// A főfolyamat saját nyilvántartása arról, mit listázott a tárhelyről. A letöltési kapu ezzel veti össze a szerver
// engedélyét, így a felület által a szerverre beküldött (akár hamis) adat nem elég egy letöltéshez.
const test = require('node:test');
const assert = require('node:assert');
const { makeLedger, subjectOf } = require('../listing-ledger');
const { authorizeDownload } = require('../download-gate');

const json = (status, body) => ({ status, json: async () => body });
const base = { origin: 'http://127.0.0.1:8000', xsrf: null, messageId: 'm1' };
const permit = over => ({ ok: true, eid: 'E-1', mailbox: 'Postafiók', folder: 'BEERKEZETT', dlp: 'auto', subject: 'Elfogadó nyugta', ...over });

test('subjectOf ugyanazt a tárgyat képzi, mint a szerver: a leírás, ennek híján a típus', () => {
  assert.equal(subjectOf({ desc: ' Leírás ', type: 'Típus' }), 'Leírás');
  assert.equal(subjectOf({ desc: '', type: 'Típus' }), 'Típus');
  assert.equal(subjectOf({}), 'Tárgy nélküli küldemény');
});

test('a nyilvántartás csak a főfolyamat saját listázását ismeri', () => {
  const l = makeLedger();
  l.record([{ eid: 'E-1', mailbox: 'Postafiók', type: 'Elfogadó nyugta', desc: '' }, { eid: 'E-2', mailbox: 'Másik', type: 'Végzés', desc: 'Bírósági végzés', folder: 'TARTOS_TAR' }, { nincs: 'eid' }]);
  assert.deepEqual(l.lookup('E-1'), { mailbox: 'Postafiók', folder: 'BEERKEZETT', subject: 'Elfogadó nyugta', sender: '', senderShort: '', receivedAt: '', type: 'Elfogadó nyugta', size: null, opened: null, mailboxLabel: '' });
  assert.equal(l.lookup('E-2').folder, 'TARTOS_TAR');
  assert.equal(l.lookup('E-9'), null);
  assert.equal(l.size(), 2);
});

test('a szerver engedélye csak akkor elég, ha egyezik azzal, amit a főfolyamat maga listázott', async () => {
  const ledger = makeLedger();
  ledger.record([{ eid: 'E-1', mailbox: 'Postafiók', type: 'Bírósági végzés', desc: '' }]); // a tárhely szerint ez végzés
  const ask = body => authorizeDownload({ ...base, ledger, auto: true, fetchImpl: async () => json(200, body) });

  // A felület hamis típussal („nyugta”) küldte be a szerverre ugyanazt az érkeztetési számot: a tárgy nem egyezik.
  const spoofed = await ask(permit());
  assert.equal(spoofed.ok, false);
  assert.match(spoofed.error, /nem egyezik/);
  // Más postafiók vagy mappa: szintén nem.
  assert.equal((await ask(permit({ subject: 'Bírósági végzés', mailbox: 'Idegen' }))).ok, false);
  // A mappát a főfolyamat saját, friss listájából vesszük (a szerveren a levél első mappája tárolódik, az irat pedig azóta
  // a tartós tárba kerülhetett): eltérésnél nem tagadunk, hanem a listázott mappából töltünk le.
  const moved = await ask(permit({ subject: 'Bírósági végzés', folder: 'TARTOS_TAR' }));
  assert.deepEqual([moved.ok, moved.folder], [true, 'BEERKEZETT']);
  // Amit a főfolyamat nem listázott, azt nem tölti le; a hívó ebből tudja, hogy előbb listázni kell.
  const unknown = await ask(permit({ eid: 'E-404' }));
  assert.deepEqual([unknown.ok, unknown.needList], [false, true]);
  // Egyező adatokkal megy.
  assert.equal((await ask(permit({ subject: 'Bírósági végzés' }))).ok, true);
});

test('kézi letöltésnél a megerősítést a főfolyamat kéri; nyugtatípusnál nem kell', async () => {
  const ledger = makeLedger(); ledger.record([{ eid: 'E-1', mailbox: 'Postafiók', type: 'Tájékoztatás', desc: '' }]);
  const asked = [];
  const run = (body, answer, auto = false) => authorizeDownload({ ...base, ledger, auto, fetchImpl: async () => json(200, body), confirm: async info => { asked.push(info.subject); return answer; } });

  assert.equal((await run(permit({ subject: 'Tájékoztatás', dlp: 'kezi' }), false)).ok, false, 'a felhasználó nemet mondott');
  assert.equal((await run(permit({ subject: 'Tájékoztatás', dlp: 'kezi' }), true)).ok, true);
  assert.deepEqual(asked, ['Tájékoztatás', 'Tájékoztatás']);
  assert.equal((await run(permit({ subject: 'Tájékoztatás', dlp: 'auto' }), false)).ok, true, 'automatikus típusnál nincs kérdés');
  assert.equal(asked.length, 2);
  // Megerősítő nélkül (hibás bekötés) a kézi típus letöltése nem megy át.
  const noConfirm = await authorizeDownload({ ...base, ledger, auto: false, fetchImpl: async () => json(200, permit({ subject: 'Tájékoztatás', dlp: 'kezi' })) });
  assert.equal(noConfirm.ok, false);
  // Ha a szerver a kérés ellenére nem automatikusnak minősíti, az `auto` jelző nem kerüli meg a megerősítést.
  assert.equal((await run({ ...permit({ subject: 'Tájékoztatás', dlp: 'kezi' }), auto: false }, false, true)).ok, false);
});

test('a kérés a KapuMail-ablak sütijeivel megy', async () => {
  const ledger = makeLedger(); ledger.record([{ eid: 'E-1', mailbox: 'Postafiók', type: 'Elfogadó nyugta', desc: '' }]);
  let init;
  await authorizeDownload({ ...base, ledger, auto: true, fetchImpl: async (_u, i) => { init = i; return json(200, { ...permit(), auto: true }); } });
  assert.equal(init.credentials, 'include');
});

test('a nyilvántartás a megerősítő kérdéshez a feladót, az érkezés idejét és a postafiók megjelenített nevét is megőrzi', async () => {
  const ledger = makeLedger();
  ledger.record([{ eid: 'E-9', mailbox: '12345676', folder: 'TARTOS_TAR', type: 'Végzés', desc: 'Bírósági végzés', sender: 'OBHIFORM', senderFull: 'Országos Bírósági Hivatal', receivedAt: '2026-06-25 10:12', size: 89306, portalOpened: false }]);
  ledger.noteMailboxes([{ name: '12345676', displayName: 'Példa Kft' }, { name: 'x' }, null]);
  assert.deepEqual(ledger.lookup('E-9'), { mailbox: '12345676', folder: 'TARTOS_TAR', subject: 'Bírósági végzés', sender: 'Országos Bírósági Hivatal', senderShort: 'OBHIFORM', receivedAt: '2026-06-25 10:12', type: 'Végzés', size: 89306, opened: false, mailboxLabel: 'Példa Kft' });
  let seen = null;
  const r = await authorizeDownload({ ...base, ledger, fetchImpl: async () => json(200, { ok: true, eid: 'E-9', mailbox: '12345676', folder: 'BEERKEZETT', subject: 'Bírósági végzés', dlp: 'kezi', auto: false }), confirm: async info => { seen = info; return true; } });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, { subject: 'Bírósági végzés', mailbox: '12345676', mailboxLabel: 'Példa Kft', sender: 'Országos Bírósági Hivatal', senderShort: 'OBHIFORM', receivedAt: '2026-06-25 10:12', type: 'Végzés', size: 89306, opened: false, folder: 'TARTOS_TAR' });
});

test('azonos érkeztetési szám két mappában (BEERKEZETT és ELKULDOTT) vagy két fiókban nem írja felül egymást', () => {
  const ledger = makeLedger();
  ledger.record([
    { eid: 'E-SAME', mailbox: '12345676', folder: 'BEERKEZETT', type: 'Kérelem', desc: 'Bejövő példány', sender: '87654323' },
    { eid: 'E-SAME', mailbox: '12345676', folder: 'ELKULDOTT', type: 'Kérelem', desc: 'Kimenő példány', sender: '12345676', recipient: 'NAV', recipientShort: 'NAV' },
    { eid: 'E-SAME', mailbox: '87654323', folder: 'ELKULDOTT', type: 'Kérelem', desc: 'Másik cég kimenő példánya', sender: '87654323' },
  ]);
  assert.equal(ledger.size(), 3);
  assert.equal(ledger.lookup('E-SAME', '12345676', 'BEERKEZETT').subject, 'Bejövő példány');
  assert.equal(ledger.lookup('E-SAME', '12345676', 'ELKULDOTT').subject, 'Kimenő példány');
  assert.equal(ledger.lookup('E-SAME', '12345676', 'ELKULDOTT').folder, 'ELKULDOTT');
  assert.equal(ledger.lookup('E-SAME', '87654323', 'ELKULDOTT').subject, 'Másik cég kimenő példánya');
  // Kontekstus nélküli lookup a bejövő mappát részesíti előnyben
  assert.equal(ledger.lookup('E-SAME').folder, 'BEERKEZETT');
});
