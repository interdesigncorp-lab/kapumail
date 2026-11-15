// Letöltési kapu a főfolyamatban.
// A tárhelyről való letöltés maga számíthat átvételnek, ezért a főfolyamat nem a felület szavára hagyatkozik:
// minden letöltés előtt maga kér engedélyt a szervertől, és azt az iratot tölti le, amelyet a szerver megnevez.
// Így a felület megkerülésével (vagy hibás felülettel) sem tölthető le tiltott vagy tetszőleges irat.
'use strict';

const FOLDERS = ['BEERKEZETT', 'TARTOS_TAR', 'ELKULDOTT'];

/**
 * @param {{ fetchImpl: Function, origin: string, xsrf?: string|null, messageId: string, auto?: boolean, viaRuleId?: number|null,
 *           ledger: { lookup: (eid: string) => ({ mailbox: string, folder: string, subject: string } | null) },
 *           confirm?: (info: { subject: string, mailbox: string }) => Promise<boolean> }} o
 *   fetchImpl: a KapuMail-ablak munkamenetével hívó fetch (a sütiket az hordozza).
 *   ledger: a főfolyamat saját listanyilvántartása (listing-ledger.js) – enélkül nincs letöltés.
 *   portalKey: annak a belépőnek a kulcsa, amelynek a munkamenetével letöltenénk (felügyelet nélküli út).
 *   requireAuto: felügyelet nélküli út – megerősítést nem kérünk, a nem automatikus letöltést elutasítjuk.
 *   confirm: a FŐFOLYAMAT megerősítő kérdése a felhasználónak; kézi letöltésnél kötelező, ha a típus nem automatikus.
 * @returns {Promise<{ ok: true, eid: string, mailbox: string, folder: string } | { ok: false, error: string, needList?: boolean }>}
 */
async function authorizeDownload({ fetchImpl, origin, xsrf = null, messageId, auto = false, viaRuleId = null, ledger = null, confirm = null, requireAuto = false, portalKey = null }) {
  if (typeof messageId !== 'string' || !/^m\d+$/.test(messageId)) return { ok: false, error: 'Érvénytelen iratazonosító.' };
  const body = { auto: auto === true };
  if (Number.isInteger(viaRuleId) && viaRuleId > 0) body.viaRuleId = viaRuleId;
  if (typeof portalKey === 'string' && portalKey) body.portalKey = portalKey.slice(0, 80); // a szerver ellenőrzi, hogy a postafiók ehhez a belépőhöz tartozik
  let res;
  try {
    res = await fetchImpl(`${origin}/api/messages/${messageId}/live-download-check`, {
      method: 'POST', credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(xsrf ? { 'X-XSRF-TOKEN': decodeURIComponent(xsrf) } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: 'A KapuMail-szerver nem érhető el; engedély nélkül nem töltünk le a tárhelyről.' };
  }
  let data = null;
  try { data = await res.json(); } catch { /* nem JSON */ }
  if (res.status !== 200 || !data || data.ok !== true) {
    const why = data && typeof data.message === 'string' ? data.message.slice(0, 300) : `A szerver nem adott engedélyt a letöltésre (HTTP ${res.status}).`;
    return { ok: false, error: why };
  }
  if (typeof data.eid !== 'string' || !data.eid || typeof data.mailbox !== 'string' || !data.mailbox || !FOLDERS.includes(data.folder)) {
    return { ok: false, error: 'A szerver engedélye hiányos; a letöltés nem indul el.' };
  }
  // A szerver a levél adatait a felülettől kapta: csak akkor fogadjuk el, ha egyezik azzal, amit a főfolyamat maga listázott.
  const listed = ledger ? ledger.lookup(data.eid, data.mailbox, data.folder) : null;
  if (!listed) return { ok: false, needList: true, error: 'Ezt az iratot az alkalmazás ebben a futásban még nem listázta a tárhelyről. Frissítsd a listát (szinkron), utána tölthető le.' };
  if ((data.folder === 'ELKULDOTT') !== (listed.folder === 'ELKULDOTT')) {
    return { ok: false, folderMismatch: true, error: 'A letöltés nem indul el: a kimenő és bejövő mappa nem keverhető össze.' };
  }
  if (listed.mailbox !== data.mailbox || (typeof data.subject === 'string' && listed.subject !== data.subject)) {
    return { ok: false, error: 'A letöltés nem indul el: a szerveren tárolt adat nem egyezik azzal, amit az alkalmazás a tárhelyről listázott.' };
  }
  // Automatikusnak csak az számít, amit a szerver is annak minősített. Minden más kézi letöltés: ha a típus nem
  // „automatikus”, a főfolyamat maga kérdezi meg a felhasználót – a felület szava ehhez nem elég.
  const autoGranted = auto === true && data.auto === true;
  // Felügyelet nélküli úton nincs ember, akit megkérdezhetnénénk: csak az megy át, amit a szerver automatikusnak minősített.
  if (requireAuto && !autoGranted) return { ok: false, error: 'Felügyelet nélkül csak az automatikusnak minősített irat tölthető le.' };
  if (!autoGranted && data.dlp !== 'auto') {
    const confirmInfo = {
      subject: listed.subject, mailbox: listed.mailbox, mailboxLabel: listed.mailboxLabel || '',
      sender: listed.sender || '', senderShort: listed.senderShort || '', receivedAt: listed.receivedAt || '',
      type: listed.type || '', size: listed.size ?? null, opened: listed.opened ?? null, folder: listed.folder,
      ...(listed.folder === 'ELKULDOTT' ? { recipient: listed.recipient || '', recipientShort: listed.recipientShort || '' } : {}),
    };
    if (typeof confirm !== 'function' || (await confirm(confirmInfo)) !== true) {
      return { ok: false, cancelled: true, error: 'A letöltés megerősítés nélkül nem indul el.' };
    }
  }
  // A mappát a saját, friss listánkból vesszük: a szerver a levél első mappáját tárolja, az irat pedig azóta a tartós tárba kerülhetett.
  return { ok: true, eid: data.eid, mailbox: listed.mailbox, folder: listed.folder };
}

module.exports = { authorizeDownload };
