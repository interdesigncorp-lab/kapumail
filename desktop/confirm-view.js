// A letöltés megerősítő kérdése a főfolyamat saját rétegében, a KapuMail megjelenésével.
// A tárhelyről való letöltés átvételnek számíthat, ezért a kérdést nem a felület oldala rajzolja: azt egy hibás vagy feltört
// oldal maga is „megnyomhatná”. Ez a réteg külön, elszigetelt nézet az ablak fölött (ahogy a zárképernyő), saját híddal;
// az oldal nem éri el, a választ csak ez a nézet adhatja meg.
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const FOLDER = { BEERKEZETT: 'Beérkezett', TARTOS_TAR: 'Tartós tár', ELKULDOTT: 'Elküldött' };
const cut = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);

const words = v => cut(v, 200).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** A feladó jele a monogramos dobozba: a szervezet rövid kódja, ennek híján a név nagy kezdőbetűi. */
function senderMark(short, name) {
  const w = words(short);
  if (w.length === 1) return w[0].slice(0, w[0].length <= 4 ? 4 : 3).toUpperCase();
  if (w.length > 1) return w.slice(0, 3).map(x => x[0]).join('').toUpperCase();
  const caps = words(name).filter(x => x[0] !== x[0].toLowerCase());
  return caps.slice(0, 3).map(x => x[0]).join('') || '?';
}
const mailboxMark = (label, key) => (words(label).slice(0, 2).map(x => x[0]).join('') || cut(key, 2)).toUpperCase();
function sizeText(n) {
  if (typeof n !== 'number' || !(n >= 0)) return '';
  if (n < 1024) return `${Math.round(n)} bájt`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/**
 * A szervezet logója, ha a telepítés tartalmaz hozzá fájlt (assets/senders/<rövid kód>.svg vagy .png). A KapuMail maga nem
 * szállít hivatali logót: azt az üzemeltető teheti oda, ha jogosult a használatára. Csak betűkből és számokból álló,
 * egyszavas kódra keresünk, így a fájlnév nem vezethet ki a mappából.
 */
function senderLogo(short, exists) {
  const slug = String(short || '').trim().toLowerCase();
  if (!/^[a-z0-9]{2,12}$/.test(slug)) return null;
  return [`${slug}.svg`, `${slug}.png`].find(f => exists(f)) || null;
}

const TEXT = {
  unread: ['Átveszed ezt az iratot?', 'Még olvasatlan a tárhelyen. A letöltéstől megnyitottá válik, és ettől elindulhatnak a határidők. Nem vonható vissza.', 'Olvasatlan a tárhelyen'],
  opened: ['Letöltöd ezt az iratot?', 'A tárhelyen már megnyitották, a letöltés ezen nem változtat.', 'Már megnyitott a tárhelyen'],
  unknown: ['Letöltöd ezt az iratot?', 'A letöltés a hivatalos tárhelyen átvételnek számíthat, és elindíthatja a határidőket. Nem vonható vissza.', 'Állapota a tárhelyen nem ismert'],
  sent: ['Letöltöd ezt az elküldött beadványt?', 'Kimenő beadvány archiválása (nincs átvételi joghatás).', 'Elküldött küldemény'],
};

/** A nézetnek átadott adatok: csak szöveg, levágva. A nézet `textContent`-tel írja ki, HTML-ként soha. */
function confirmModel(info) {
  const i = info || {};
  const isSent = i.folder === 'ELKULDOTT';
  const key = cut(i.mailbox, 120), label = cut(i.mailboxLabel, 120);
  const at = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(cut(i.receivedAt, 20));
  const state = isSent ? 'sent' : i.opened === true ? 'opened' : i.opened === false ? 'unread' : 'unknown';
  const party = isSent ? (i.recipient || i.sender) : i.sender;
  const partyShort = isSent ? (i.recipientShort || i.senderShort) : i.senderShort;
  return {
    state, title: TEXT[state][0], lead: TEXT[state][1], stateLabel: TEXT[state][2],
    subject: cut(i.subject, 200) || 'Tárgy nélküli küldemény',
    mailbox: label || key, mailboxKey: label && label !== key ? key : '', mailboxMark: mailboxMark(label, key),
    sender: cut(party, 160), senderMark: senderMark(partyShort, party),
    received: at ? `${at[1]}. ${at[2]}. ${at[3]}.${at[4] ? ' ' + at[4] : ''}` : '',
    folder: FOLDER[i.folder] || FOLDER.BEERKEZETT,
    type: cut(i.type, 80), size: sizeText(i.size),
  };
}

let current = null; // { id, model, done }

/** Az IPC-kezelők egyszeri bejegyzése. Mindkettő csak az éppen nyitott kérdés saját nézetének válaszol. */
function register(ipcMain) {
  ipcMain.handle('confirm:info', e => (current && e.sender && e.sender.id === current.id ? current.model : null));
  ipcMain.handle('confirm:answer', (e, yes) => { if (current && e.sender && e.sender.id === current.id) current.done(yes === true); return null; });
}

/**
 * Megkérdezi a felhasználót, letölti-e az iratot. Igazat csak a „Letöltés” gomb megnyomására ad; minden más
 * (Mégse, Esc, az ablak bezárása, egy már nyitott kérdés) hamis.
 * @returns {Promise<boolean>}
 */
function askDownload({ WebContentsView, win, info }) {
  if (current || !win || win.isDestroyed()) return Promise.resolve(false);
  return new Promise(resolve => {
    const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'confirm-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } });
    const fit = () => { if (!win.isDestroyed()) { const [width, height] = win.getContentSize(); view.setBounds({ x: 0, y: 0, width, height }); } };
    const closed = () => finish(false);
    function finish(answer) {
      if (!current || current.id !== view.webContents.id) return;
      current = null;
      win.removeListener('resize', fit); win.removeListener('closed', closed);
      if (!win.isDestroyed()) { win.contentView.removeChildView(view); win.webContents.focus(); }
      if (!view.webContents.isDestroyed()) view.webContents.close();
      resolve(answer === true);
    }
    const model = confirmModel(info);
    const logo = senderLogo(info && info.senderShort, f => fs.existsSync(path.join(__dirname, 'assets', 'senders', f)));
    if (logo) model.senderLogo = `assets/senders/${logo}`;
    current = { id: view.webContents.id, model, done: finish };
    view.setBackgroundColor('#00000000');
    view.webContents.on('will-navigate', e => e.preventDefault());
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('render-process-gone', closed);
    win.on('resize', fit); win.on('closed', closed);
    win.contentView.addChildView(view); fit();
    view.webContents.loadFile(path.join(__dirname, 'confirm.html'));
    view.webContents.focus();
  });
}

module.exports = { askDownload, register, confirmModel, senderLogo };
