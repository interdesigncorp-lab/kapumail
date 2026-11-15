// A főfolyamat saját nyilvántartása arról, mit listázott a tárhelyről ebben a futásban.
// A letöltési kapu ezzel veti össze a szerver engedélyét: a szerver a levél adatait a felülettől kapja, ezért egy hibás
// vagy feltört felület hamis típussal is beküldhetne egy érkeztetési számot. Amit a főfolyamat nem maga listázott,
// vagy aminek a tárgya, postafiókja, mappája eltér a listázottól, azt nem tölti le.
// Csak memóriában él: újraindítás után előbb listázni kell.
'use strict';

/** Ugyanaz a képzés, mint a szerveren: a leírás, ennek híján a típus; üresen „Tárgy nélküli küldemény". */
function subjectOf(letter) {
  const desc = letter && letter.desc != null ? String(letter.desc) : '';
  const s = (desc !== '' && desc !== '0' ? desc : String((letter && letter.type) || '')).trim();
  return s || 'Tárgy nélküli küldemény';
}

const normFolder = f => (f === 'TARTOS_TAR' ? 'TARTOS_TAR' : f === 'ELKULDOTT' ? 'ELKULDOTT' : 'BEERKEZETT');
const keyOf = (mailbox, folder, eid) => `${mailbox}|${folder}|${eid}`;

function makeLedger(max = 20000) {
  const items = new Map();
  const labels = new Map(); // postafiók-kulcs → megjelenített név (a megerősítő kérdéshez)
  return {
    /** A főfolyamat által a tárhelyről kapott levélsorok rögzítése. */
    record(letters) {
      for (const l of Array.isArray(letters) ? letters : []) {
        if (!l || typeof l.eid !== 'string' || !l.eid || typeof l.mailbox !== 'string') continue;
        const folder = normFolder(l.folder);
        const key = keyOf(l.mailbox, folder, l.eid);
        if (items.size >= max && !items.has(key)) items.delete(items.keys().next().value);
        const entry = {
          eid: l.eid, mailbox: l.mailbox, folder, subject: subjectOf(l),
          sender: String(l.senderFull || l.sender || '').slice(0, 200), senderShort: String(l.sender || '').slice(0, 60), receivedAt: String(l.receivedAt || '').slice(0, 16),
          type: String(l.type || '').slice(0, 120), size: typeof l.size === 'number' && l.size >= 0 ? Math.floor(l.size) : null, opened: typeof l.portalOpened === 'boolean' ? l.portalOpened : null,
        };
        if (folder === 'ELKULDOTT') {
          entry.recipient = String(l.recipient || '').slice(0, 200);
          entry.recipientShort = String(l.recipientShort || '').slice(0, 64);
        }
        items.set(key, entry);
      }
    },
    /** A postafiókok megjelenített neve a tárhely saját listájából. */
    noteMailboxes(list) {
      for (const m of Array.isArray(list) ? list : []) if (m && typeof m.name === 'string' && typeof m.displayName === 'string' && m.displayName) labels.set(m.name, m.displayName.slice(0, 200));
    },
    lookup(eid, mailbox = null, folder = null) {
      const id = String(eid);
      const format = it => {
        const { eid: _eid, ...rest } = it;
        return { ...rest, mailboxLabel: labels.get(it.mailbox) || '' };
      };
      if (mailbox && folder) {
        const dir = normFolder(folder);
        const exact = items.get(keyOf(mailbox, dir, id));
        if (exact) return format(exact);
        if (dir !== 'ELKULDOTT') {
          const moved = items.get(keyOf(mailbox, dir === 'BEERKEZETT' ? 'TARTOS_TAR' : 'BEERKEZETT', id));
          if (moved) return format(moved);
        }
        return null;
      }
      for (const dir of ['BEERKEZETT', 'TARTOS_TAR', 'ELKULDOTT']) {
        for (const it of items.values()) {
          if (it.eid === id && it.folder === dir && (!mailbox || it.mailbox === mailbox)) return format(it);
        }
      }
      return null;
    },
    size: () => items.size,
  };
}

module.exports = { makeLedger, subjectOf };
