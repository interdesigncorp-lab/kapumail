// A letöltés megerősítő rétege: a főfolyamat saját nézete, amelyet a felület oldala nem tud megnyomni.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../confirm-view');

test('a megjelenített adatok szövegként, levágva és üres értékek nélkül mennek a nézetbe', () => {
  const m = C.confirmModel({ subject: '<b>Végzés</b>' + 'x'.repeat(400), mailbox: '12345676', mailboxLabel: 'Példa Kereskedelmi Kft', sender: 'Országos Bírósági Hivatal', senderShort: 'OBHIFORM', receivedAt: '2026-06-25 10:12', type: 'OBH_UKE_KIADMANY', size: 89306, opened: false, folder: 'TARTOS_TAR' });
  assert.equal(m.subject.length, 200);
  assert.ok(m.subject.startsWith('<b>Végzés</b>'), 'nem értelmezzük, a nézet szövegként írja ki');
  assert.deepEqual([m.mailbox, m.mailboxKey, m.sender, m.received, m.folder, m.type, m.size], ['Példa Kereskedelmi Kft', '12345676', 'Országos Bírósági Hivatal', '2026. 06. 25. 10:12', 'Tartós tár', 'OBH_UKE_KIADMANY', '87 KB']);
  assert.deepEqual([m.senderMark, m.mailboxMark], ['OBH', 'PK']);
  const empty = C.confirmModel({ subject: '', mailbox: 'M' });
  assert.deepEqual([empty.subject, empty.mailbox, empty.sender, empty.received, empty.folder, empty.type, empty.size, empty.senderMark], ['Tárgy nélküli küldemény', 'M', '', '', 'Beérkezett', '', '', '?']);
  assert.deepEqual(C.confirmModel(null).mailbox, '');
});

test('a kérdés a tárhely állapotához igazodik: olvasatlan iratnál átvételről szól, megnyitottnál nem ijesztget', () => {
  const unread = C.confirmModel({ subject: 'A', mailbox: 'M', opened: false });
  const opened = C.confirmModel({ subject: 'A', mailbox: 'M', opened: true });
  const unknown = C.confirmModel({ subject: 'A', mailbox: 'M' });
  assert.deepEqual([unread.state, opened.state, unknown.state], ['unread', 'opened', 'unknown']);
  assert.match(unread.title, /Átveszed/); assert.match(unread.lead, /olvasatlan/i); assert.match(unread.lead, /határidők/);
  assert.match(opened.title, /Letöltöd/); assert.match(opened.lead, /már megnyitották/); assert.doesNotMatch(opened.lead, /határidők/);
  assert.match(unknown.lead, /átvételnek számíthat/, 'ha nem tudjuk az állapotát, az óvatosabb szöveg megy');

  const sent = C.confirmModel({ subject: 'ÁFA bevallás', mailbox: '12345676', mailboxLabel: 'Példa Kft', folder: 'ELKULDOTT', recipient: 'Nemzeti Adó- és Vámhivatal', recipientShort: 'NAV', sender: 'Példa Kft', opened: false });
  assert.equal(sent.folder, 'Elküldött');
  assert.equal(sent.state, 'sent');
  assert.equal(sent.sender, 'Nemzeti Adó- és Vámhivatal');
  assert.equal(sent.senderMark, 'NAV');
  assert.doesNotMatch(sent.lead, /átvételnek számíthat|elindulhatnak a határidők/i);
  assert.match(sent.lead, /nincs átvételi joghatás/i);
});

test('a feladó jele: a szervezet rövid kódja vagy a név kezdőbetűi; logót csak ismert, biztonságos nevű fájlból ad', () => {
  assert.deepEqual(['NAV', 'IdomSoft BKSZ', '', 'nmhh'].map(s => C.confirmModel({ subject: 'A', mailbox: 'M', senderShort: s, sender: 'Nemzeti Média- és Hírközlési Hatóság' }).senderMark), ['NAV', 'IB', 'NMH', 'NMHH']);
  const has = new Set(['nav.svg', 'nmhh.png']);
  const pick = code => C.senderLogo(code, f => has.has(f));
  assert.deepEqual([pick('NAV'), pick('nmhh'), pick('OBHIFORM'), pick('../nav'), pick(''), pick('IdomSoft BKSZ')], ['nav.svg', 'nmhh.png', null, null, null, null]);
});

test('egyszerre egy kérdés élhet; választ csak a saját nézete adhat, és a bezárás nemet jelent', async () => {
  const made = [];
  class FakeView { constructor() { this.webContents = { id: made.length + 1, on() {}, setWindowOpenHandler() {}, loadFile() {}, focus() {}, isDestroyed: () => false, close: () => { this.closed = true; } }; made.push(this); } setBounds() {} setBackgroundColor() {} }
  const handlers = {}; const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const win = { isDestroyed: () => false, getContentSize: () => [800, 600], on() {}, removeListener() {}, contentView: { addChildView() {}, removeChildView() {} }, webContents: { focus() {} } };
  C.register(ipcMain);
  const first = C.askDownload({ WebContentsView: FakeView, win, info: { subject: 'A', mailbox: 'M' } });
  assert.equal(await C.askDownload({ WebContentsView: FakeView, win, info: { subject: 'B', mailbox: 'M' } }), false, 'amíg egy kérdés nyitva van, a második nem jelenik meg');
  assert.equal(handlers['confirm:info']({ sender: { id: 99 } }), null, 'idegen nézet nem kap adatot');
  assert.equal(handlers['confirm:info']({ sender: made[0].webContents }).subject, 'A');
  handlers['confirm:answer']({ sender: { id: 99 } }, true);
  handlers['confirm:answer']({ sender: made[0].webContents }, 'true');
  assert.equal(await first, false, 'csak a pontos true érték jelent igent');
  const second = C.askDownload({ WebContentsView: FakeView, win, info: { subject: 'C', mailbox: 'M' } });
  handlers['confirm:answer']({ sender: made[made.length - 1].webContents }, true);
  assert.equal(await second, true);
  assert.equal(made[made.length - 1].closed, true);
});
