// Letöltési kapu a főfolyamatban: a tárhelyhez csak a szerver engedélye után, és csak az általa megnevezett irathoz nyúlunk.
const test = require('node:test');
const assert = require('node:assert');
const { authorizeDownload } = require('../download-gate');
const { makeLedger } = require('../listing-ledger');
const ledgerWith = (...rows) => { const l = makeLedger(); l.record(rows); return l; };

const json = (status, body) => ({ status, json: async () => body });
const base = { origin: 'http://127.0.0.1:8000', xsrf: 'tok%3D1' };

test('a szerver engedélye adja meg, mit töltünk le – a felület által küldött azonosítók nem számítanak', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return json(200, { ok: true, eid: 'SZERVER-EID', mailbox: 'Szerver postafiók', folder: 'TARTOS_TAR', auto: false, dlp: 'auto', subject: 'Nyugta' }); };
  const ledger = ledgerWith({ eid: 'SZERVER-EID', mailbox: 'Szerver postafiók', folder: 'TARTOS_TAR', type: 'Nyugta', desc: '' });
  const r = await authorizeDownload({ ...base, fetchImpl, ledger, messageId: 'm42', auto: false, eid: 'HAMIS', mailbox: 'Hamis' });

  assert.deepEqual(r, { ok: true, eid: 'SZERVER-EID', mailbox: 'Szerver postafiók', folder: 'TARTOS_TAR' });
  assert.equal(seen[0].url, 'http://127.0.0.1:8000/api/messages/m42/live-download-check');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['X-XSRF-TOKEN'], 'tok=1');
  assert.deepEqual(JSON.parse(seen[0].init.body), { auto: false });
});

test('automatikus letöltésnél a jelző és a szabály azonosítója is átmegy', async () => {
  let body;
  const fetchImpl = async (_u, init) => { body = JSON.parse(init.body); return json(200, { ok: true, eid: 'E', mailbox: 'M', folder: 'BEERKEZETT', dlp: 'kezi', auto: true, subject: 'T' }); };
  await authorizeDownload({ ...base, fetchImpl, ledger: ledgerWith({ eid: 'E', mailbox: 'M', type: 'T', desc: '' }), messageId: 'm7', auto: true, viaRuleId: 3 });
  assert.deepEqual(body, { auto: true, viaRuleId: 3 });
});

test('elutasítás, hibás válasz vagy hálózati hiba esetén nincs letöltés', async () => {
  const deny = await authorizeDownload({ ...base, fetchImpl: async () => json(422, { message: 'Ezt az irattípust a program nem tölti le; a hivatalos tárhelyen vehető át.' }), messageId: 'm1' });
  assert.equal(deny.ok, false);
  assert.match(deny.error, /nem tölti le/);

  assert.equal((await authorizeDownload({ ...base, fetchImpl: async () => json(401, {}), messageId: 'm1' })).ok, false);
  assert.equal((await authorizeDownload({ ...base, fetchImpl: async () => json(200, { ok: true }), messageId: 'm1' })).ok, false, 'hiányos engedély');
  assert.equal((await authorizeDownload({ ...base, fetchImpl: async () => json(200, { ok: true, eid: 'E', mailbox: 'M', folder: 'MAS' }), messageId: 'm1' })).ok, false, 'ismeretlen mappa');
  assert.equal((await authorizeDownload({ ...base, fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, messageId: 'm1' })).ok, false);
});

test('érvénytelen iratazonosítóval a szerverhez sem fordulunk', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return json(200, {}); };
  for (const bad of [null, '', 'm', '../../x', 'm1/../2', 42]) assert.equal((await authorizeDownload({ ...base, fetchImpl, messageId: bad })).ok, false);
  assert.equal(called, false);
});

test('felügyelet nélküli útnál csak az megy át, amit a szerver automatikusnak minősített; megerősítést nem kérünk', async () => {
  const ledger = ledgerWith({ eid: 'E', mailbox: 'M', type: 'T', desc: '' });
  const answer = body => async () => json(200, { ok: true, eid: 'E', mailbox: 'M', folder: 'BEERKEZETT', subject: 'T', ...body });
  let asked = 0; const confirm = async () => { asked += 1; return true; };
  let sentBody = null; const answerSeen = body => async (_u, init) => { sentBody = JSON.parse(init.body); return answer(body)(); };
  const run = body => authorizeDownload({ ...base, fetchImpl: answerSeen(body), ledger, messageId: 'm7', auto: true, requireAuto: true, portalKey: 'portal-abc', confirm });
  assert.equal((await run({ dlp: 'auto', auto: true })).ok, true);
  assert.equal((await run({ dlp: 'auto', auto: false })).ok, false, 'automatikus típus, de a szerver ezt a letöltést nem minősítette automatikusnak');
  assert.equal((await run({ dlp: 'kezi', auto: false })).ok, false);
  assert.equal(asked, 0, 'ember nincs jelen: megerősítő kérdés nem jelenhet meg');
  assert.deepEqual(sentBody, { auto: true, portalKey: 'portal-abc' }, 'a szerver megtudja, melyik belépő munkamenetével töltenénk le');
});

test('ELKULDOTT mappa szigorú mappa-egyezést követel: bejövő sorral nem tölthető le kimenőként és fordítva', async () => {
  const onlyIn = ledgerWith({ eid: 'E-10', mailbox: 'M', folder: 'BEERKEZETT', type: 'T', desc: 'Kérelem' });
  const trySentOnIn = await authorizeDownload({
    ...base, ledger: onlyIn, messageId: 'm10', auto: true,
    fetchImpl: async () => json(200, { ok: true, eid: 'E-10', mailbox: 'M', folder: 'ELKULDOTT', dlp: 'auto', auto: true, subject: 'Kérelem' }),
  });
  assert.equal(trySentOnIn.ok, false);

  const onlySent = ledgerWith({ eid: 'E-11', mailbox: 'M', folder: 'ELKULDOTT', type: 'T', desc: 'Beadvány' });
  const tryInOnSent = await authorizeDownload({
    ...base, ledger: onlySent, messageId: 'm11', auto: true,
    fetchImpl: async () => json(200, { ok: true, eid: 'E-11', mailbox: 'M', folder: 'BEERKEZETT', dlp: 'auto', auto: true, subject: 'Beadvány' }),
  });
  assert.equal(tryInOnSent.ok, false);

  const okSent = await authorizeDownload({
    ...base, ledger: onlySent, messageId: 'm11', auto: true,
    fetchImpl: async () => json(200, { ok: true, eid: 'E-11', mailbox: 'M', folder: 'ELKULDOTT', dlp: 'auto', auto: true, subject: 'Beadvány' }),
  });
  assert.deepEqual(okSent, { ok: true, eid: 'E-11', mailbox: 'M', folder: 'ELKULDOTT' });
});
