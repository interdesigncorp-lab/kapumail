'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { allowed, localRequest, createRelay } = require('../relay');

const CRED = { id: 'AbCdEfGhIjKlMnOpQrStUv', secret: 's', url: 'https://mcp.pelda.test/AbCdEfGhIjKlMnOpQrStUv/mcp' };
const BASE = 'https://mcp.pelda.test/AbCdEfGhIjKlMnOpQrStUv';

test('engedélylista: a helyi felület, az /api és a /local/enter nem érhető el', () => {
  assert.ok(allowed('POST', '/mcp'));
  assert.ok(allowed('GET', '/.well-known/oauth-protected-resource/mcp'));
  assert.ok(allowed('POST', '/mcp-connect'));
  for (const [m, p] of [['GET', '/'], ['GET', '/api/state'], ['POST', '/local/enter'], ['POST', '/login'], ['GET', '/mcp/../api/state'], ['GET', 'mcp']])
    assert.ok(!allowed(m, p), `${m} ${p}`);
});

test('helyi kérés: saját közvetítő-cím, kiszűrt fejlécek, átirányítás nem követve', () => {
  const r = localRequest({ method: 'POST', path: '/mcp', query: '?a=1', base: BASE, body: Buffer.from('{}').toString('base64'),
    headers: { authorization: 'Bearer x', 'x-kapumail-relay-base': 'https://evil', host: 'evil', 'x-forwarded-for': '1.1.1.1' } }, 'http://127.0.0.1:8000', 'https://mcp.pelda.test', CRED);
  assert.strictEqual(r.url, 'http://127.0.0.1:8000/mcp?a=1');
  assert.strictEqual(r.init.redirect, 'manual');
  assert.deepStrictEqual(r.init.headers, { authorization: 'Bearer x', 'x-kapumail-relay-base': BASE });
  assert.strictEqual(r.init.body.toString(), '{}');
  // Idegen kapcsolat címe vagy tiltott útvonal: nincs helyi kérés
  assert.strictEqual(localRequest({ method: 'POST', path: '/mcp', base: 'https://mcp.pelda.test/MasikKapcsolat12345678' }, 'http://x', 'https://mcp.pelda.test', CRED), null);
  assert.strictEqual(localRequest({ method: 'GET', path: '/api/state', base: BASE }, 'http://x', 'https://mcp.pelda.test', CRED), null);
});

process.env.RELAY_STORE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kmrelay-')), 't.json');
process.env.RELAY_PUBLIC_BASE = 'https://mcp.pelda.test';

const relayServerPath = path.resolve(__dirname, '../../relay/server.js');
const hasRelayServer = fs.existsSync(relayServerPath);

test('végig: a kérés a helyi szerverig jut, sütikkel és átirányítással', {
  skip: !hasRelayServer ? 'relay/server nem érhető el' : false,
}, async () => {
  const { start } = require('../../relay/server');
  const relaySrv = await start(0, '127.0.0.1');
  const port = relaySrv.address().port, relayBase = `http://127.0.0.1:${port}`;
  const seen = [];
  const local = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      seen.push({ url: req.url, base: req.headers['x-kapumail-relay-base'], body: b });
      res.setHeader('set-cookie', ['a=1; Path=/x', 'b=2']);
      res.writeHead(req.url.startsWith('/login') ? 302 : 200, { 'content-type': 'application/json', location: 'https://mcp.pelda.test/x/mcp-connect' });
      res.end('{"ok":true}');
    });
  });
  await new Promise(r => local.listen(0, '127.0.0.1', r));
  let saved = null;
  // A közvetítő a feladatba a RELAY_PUBLIC_BASE-t írja; a továbbító ehhez a relayUrl-hez hasonlít. Itt a fetch-et
  // úgy irányítjuk, hogy a nyilvános cím (https://mcp.pelda.test) a helyi közvetítőre menjen.
  const pubFetch = (u, i) => fetch(String(u).replace('https://mcp.pelda.test', relayBase), i);
  const relay = createRelay({ relayUrl: 'https://mcp.pelda.test', fetch: pubFetch, origin: () => `http://127.0.0.1:${local.address().port}`, load: () => saved, save: c => { saved = c; }, sleep: () => new Promise(r => setTimeout(r, 20)) });
  try {
    relay.start();
    for (let i = 0; i < 100 && relay.status().state !== 'online'; i++) await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(relay.status().state, 'online');
    assert.strictEqual(relay.status().url, `https://mcp.pelda.test/${saved.id}/mcp`);
    const out = await fetch(`${relayBase}/${saved.id}/mcp?q=1`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kapumail-relay-base': 'https://evil' }, body: '{"x":1}' });
    assert.strictEqual(out.status, 200);
    assert.deepStrictEqual(await out.json(), { ok: true });
    assert.deepStrictEqual(out.headers.getSetCookie(), ['a=1; Path=/x', 'b=2']);
    assert.deepStrictEqual(seen[0], { url: '/mcp?q=1', base: `https://mcp.pelda.test/${saved.id}`, body: '{"x":1}' });
    const redir = await fetch(`${relayBase}/${saved.id}/login`, { redirect: 'manual' });
    assert.strictEqual(redir.status, 302);
    assert.strictEqual(redir.headers.get('location'), 'https://mcp.pelda.test/x/mcp-connect');
    // tiltott útvonal: a közvetítőn megáll
    assert.strictEqual((await fetch(`${relayBase}/${saved.id}/api/state`)).status, 403);
    assert.strictEqual(seen.length, 2);
  } finally { relay.stop(); relaySrv.close(); local.close(); }
});
