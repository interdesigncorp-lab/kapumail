'use strict';
// MCP-közvetítő, asztali oldal (ADR-013). A KapuMail kifelé, long-poll kapcsolattal veszi fel a közvetítőtől
// (https://mcp.kapumail.hu) a ChatGPT / claude.ai kéréseit, továbbítja a helyi szervernek, és visszaküldi a választ.
// Befelé semmit nem nyit meg. Csak az MCP, az OAuth és a párosítás útvonalai mennek át (ugyanaz a lista, mint
// a relay/routes.js-ben és a Laravel RelayGuard-jában); a helyi felület, az /api/* és a /local/enter soha.
// Elektron nélküli modul: a hálózati hívás (fetch) és a titoktár kívülről érkezik, így tesztelhető.

const ALLOWED = [
  ['/mcp', ['POST', 'GET', 'DELETE'], false],
  ['/.well-known/oauth-authorization-server', ['GET'], true],
  ['/.well-known/oauth-protected-resource', ['GET'], true],
  ['/.well-known/openid-configuration', ['GET'], false],
  ['/oauth/register', ['POST'], false],
  ['/oauth/authorize', ['GET', 'POST', 'DELETE'], false],
  ['/oauth/token', ['POST'], false],
  ['/mcp-connect', ['GET', 'POST'], true],
  ['/login', ['GET'], false],
];
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const CONCURRENT = 8;

function allowed(method, p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.includes('..') || p.includes('//') || /[\\\0?#]/.test(p)) return false;
  return ALLOWED.some(([a, m, prefix]) => (prefix ? p === a || p.startsWith(a + '/') : p === a) && m.includes(method));
}

// A közvetítőtől kapott feladatból a helyi kérés. Null, ha a feladat nem engedélyezett vagy hibás.
function localRequest(job, origin, relayUrl, cred) {
  if (!job || typeof job !== 'object' || !allowed(job.method, job.path)) return null;
  const base = `${relayUrl.replace(/\/$/, '')}/${cred.id}`;
  if (job.base !== base) return null; // a nyilvános cím csak a saját kapcsolatunké lehet
  const query = typeof job.query === 'string' && /^(\?[^#\s]*)?$/.test(job.query) ? job.query : '';
  const headers = {};
  for (const [k, v] of Object.entries(job.headers || {})) {
    const n = k.toLowerCase();
    if (n === 'host' || n.startsWith('x-kapumail-') || n.startsWith('x-forwarded-') || n === 'content-length' || n === 'connection') continue;
    headers[n] = String(v);
  }
  headers['x-kapumail-relay-base'] = base;
  const body = job.body && !['GET', 'HEAD'].includes(job.method) ? Buffer.from(String(job.body), 'base64') : undefined;
  return { url: origin.replace(/\/$/, '') + job.path + query, init: { method: job.method, headers, body, redirect: 'manual' } };
}

async function encodeResponse(res) {
  const headers = {};
  res.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (cookies.length) headers['set-cookie'] = cookies;
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers, body: buf.length ? buf.toString('base64') : null };
}

/**
 * A közvetítő-kapcsolat. opts: relayUrl, origin() → a helyi szerver címe, load() / save(cred) → titoktár,
 * fetch (alapból a globális), sleep (tesztben gyorsítható).
 */
function createRelay(opts) {
  const doFetch = opts.fetch || globalThis.fetch;
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const relayUrl = opts.relayUrl.replace(/\/$/, '');
  let running = false, ctl = null, busy = 0, generation = 0;
  const state = { state: 'off', url: null, error: null, lastOk: null, handled: 0 };

  async function register() {
    const r = await doFetch(relayUrl + '/tunnel/register', { method: 'POST' });
    if (!r.ok) throw new Error(r.status === 429 ? 'A közvetítő túl sok regisztrációt kapott, később újrapróbálja.' : `A közvetítő nem regisztrált (HTTP ${r.status}).`);
    const c = await r.json();
    if (!ID_RE.test(c.id) || typeof c.secret !== 'string') throw new Error('A közvetítő hibás választ adott.');
    const cred = { id: c.id, secret: c.secret, url: c.url || `${relayUrl}/${c.id}/mcp` };
    opts.save(cred);
    return cred;
  }

  async function handle(job, cred) {
    busy++;
    let out;
    try {
      const req = localRequest(job, opts.origin(), relayUrl, cred);
      if (!req) out = { status: 403, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":"Nem engedélyezett útvonal."}').toString('base64') };
      else {
        try { out = await encodeResponse(await doFetch(req.url, req.init)); }
        catch { out = { status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":"A KapuMail helyi szervere nem válaszol."}').toString('base64') }; }
      }
      await doFetch(`${relayUrl}/tunnel/${cred.id}/respond/${job.rid}`, { method: 'POST', headers: { authorization: 'Bearer ' + cred.secret, 'content-type': 'application/json' }, body: JSON.stringify(out) });
      state.handled++;
    } catch { /* a közvetítő közben elérhetetlen lett: a ChatGPT időtúllépést kap */ } finally { busy--; }
  }

  async function loop(gen) {
    let cred = opts.load(), wait = 1000, hello = true;
    while (running && gen === generation) {
      try {
        if (!cred) { state.state = 'connecting'; cred = await register(); }
        state.url = cred.url;
        if (busy >= CONCURRENT) { await sleep(200); continue; }
        ctl = new AbortController();
        const r = await doFetch(`${relayUrl}/tunnel/${cred.id}/next${hello ? '?hello=1' : ''}`, { headers: { authorization: 'Bearer ' + cred.secret }, signal: ctl.signal });
        if (r.status === 401) { cred = null; hello = true; state.error = 'A közvetítő nem ismerte fel a kapcsolatot; új címet kértünk – a ChatGPT-ben frissíteni kell.'; continue; }
        if (!r.ok && r.status !== 204) throw new Error(`HTTP ${r.status}`);
        state.state = 'online'; state.error = null; state.lastOk = new Date().toISOString(); wait = 1000; hello = false;
        if (r.status === 200) handle(await r.json(), cred);
      } catch (e) {
        if (!running || gen !== generation) break;
        state.state = 'error'; state.error = state.error || String(e && e.message || e);
        await sleep(wait); wait = Math.min(wait * 2, 60_000); hello = true;
        state.error = null;
      }
    }
  }

  return {
    start() { if (running) return; running = true; generation++; state.state = 'connecting'; state.error = null; loop(generation); },
    stop() { running = false; generation++; state.state = 'off'; if (ctl) ctl.abort(); },
    status: () => ({ ...state, url: state.url || (opts.load() || {}).url || null }),
  };
}

module.exports = { allowed, localRequest, encodeResponse, createRelay, ALLOWED };
