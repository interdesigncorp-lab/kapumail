// A kézi (ablakos) tárhely-szinkron listázási ablaka belépőnként: ugyanaz a szabály, mint a felügyelet nélküli futásnál
// (tarhely-auto.js `listingWindow`): első alkalommal, hetente, kérésre és a postafiókok körének változásakor teljes lista,
// közben csak az utolsó, a szerver által VISSZAIGAZOLT futás óta érkezett levelek, 3 nap átfedéssel. A vízjel csak a
// szerver befogadása után lép előre (`ack`), így egy megszakadt vagy el nem fogadott futás után sem marad ki levél.
// Titkot nem tárol: időpontokat és a postafiókok nevéből képzett lenyomatot.
'use strict';

const A = require('./tarhely-auto');

/** A postafiókok körének lenyomata: ha új fiók jelenik meg vagy a szűrő változik, a következő futás teljes lesz. */
function mailboxSig(names, sent) {
  return JSON.stringify({ m: [...new Set((names || []).map(String))].sort(), s: Boolean(sent) });
}

/** @param {{ readCfg: () => object, saveCfg: (patch: object) => void }} io */
function makeLiveListWindows({ readCfg, saveCfg }) {
  const all = () => { const s = readCfg().liveWin; return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; };
  return {
    /**
     * Mit kérjen most a kézi szinkron. `forceFull`: a felhasználó teljes újraolvasást kért.
     * @returns {{ full: boolean, since: Date|null, incomingFrom: string|null }}
     */
    plan(key, { mailboxNames = [], sent = false, forceFull = false, now = Date.now() } = {}) {
      const st = all(); const k = String(key);
      const sig = mailboxSig(mailboxNames, sent);
      const w = A.listingWindow(st[k], now, { forceFull, filterSig: sig });
      st[k] = { ...(st[k] || {}), pendingSig: sig };
      saveCfg({ liveWin: st });
      return { full: w.full, since: w.since, incomingFrom: w.since ? w.since.toISOString() : null };
    },
    /** A szerver befogadta a listát: innen számít a következő növekményes ablak. */
    ack(key, { full = false, now = Date.now() } = {}) {
      const st = all();
      A.acknowledge(st, String(key), { full, at: now });
      saveCfg({ liveWin: st });
      return st[String(key)];
    },
    state: all,
  };
}

module.exports = { makeLiveListWindows, mailboxSig };
