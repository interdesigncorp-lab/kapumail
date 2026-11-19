// MI-ből indított szinkron (ADR-016): zárolt appnál a felület IPC-hívásait a `guard` elutasítja. Egy MCP-kérésből indított futás
// idejére – legfeljebb 120 percre – csak a szinkronhoz szükséges csatornák mennek át; a zárolóképernyő végig fent marad.
'use strict';

const SYNC_CHANNELS = Object.freeze(['auto:run', 'auto:ack', 'auto:downloadOne', 'auto:clients', 'nav:readOwn', 'asp:readOwnAuto', 'schedule:get']);

function makeMcpRun({ now = Date.now, maxMs = 120 * 60000 } = {}) {
  let cur = null; // { id, until }
  const active = () => { if (cur && now() > cur.until) cur = null; return cur !== null; };
  return {
    /** Futó MCP-futás közben más azonosítóval nem nyitható újra (false). */
    begin(id) { if (active() && cur.id !== Number(id)) return false; cur = { id: Number(id), until: now() + maxMs }; return true; },
    end(id) { if (cur && cur.id === Number(id)) cur = null; },
    active,
    allows: channel => typeof channel === 'string' && active() && SYNC_CHANNELS.includes(channel),
  };
}

module.exports = { SYNC_CHANNELS, makeMcpRun };
