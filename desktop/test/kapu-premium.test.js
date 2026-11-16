'use strict';
// Szakmai MCP (jogi és könyvelői eszközök): token a KapuMail-apptól, második MCP-szerver mindhárom motorban.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../kapu/premium');
const iso = require('../kapu/isolation');
const R = require('../kapu/run');

const TOKEN = 'kapu-teszt-token-0123456789';
const HTTP = { mode: 'http', url: 'https://iroda.kapumail.hu/mcp', token: TOKEN };
const PTOK = 'KMT1.eyJ2IjoxfQ.szakmai-teszt-alairas';
const PREMIUM = { url: 'https://mcp.pelda.test/mcp/', token: PTOK };
const DEV = '0f1e2d3c-4b5a-4978-8877-665544332211';

const AGY_LOGIN = JSON.stringify({ token: { access_token: 'ya29.teszt', token_type: 'Bearer', refresh_token: '1//teszt', expiry: '2099-01-01T00:00:00Z' }, auth_method: 'consumer' });
const claudeLogin = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-teszt', refreshToken: 'r', expiresAt: 4102444800000, scopes: ['user:inference'], subscriptionType: 'max' } });
const keychain = async (service) => (service === 'gemini' ? AGY_LOGIN : service.startsWith('Claude Code-credentials') ? claudeLogin : null);

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-premium-'));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function fakeHome() {
  const h = tmp();
  fs.mkdirSync(path.join(h, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(h, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'i', access_token: 'a', refresh_token: 'r', account_id: 'x' } }), { mode: 0o600 });
  return h;
}

// --- premium.js ---------------------------------------------------------------------------------

function okResp(now, extra = {}) {
  return { status: 200, json: { url: PREMIUM.url, token: PTOK, exp: Math.floor(now / 1000) + 3600, ent: ['jog', 'konyvelo'], plan: 'trial', ...extra } };
}

test('premium get: 200 → token; cache-ből adja exp − 300 s-ig, utána újat kér', async () => {
  let now = 1_800_000_000_000;
  const calls = [];
  const p = P.create({ deviceId: DEV, now: () => now, fetchPremium: async (d) => { calls.push(d); return okResp(now); } });
  assert.deepStrictEqual(await p.get(), { url: PREMIUM.url, token: PTOK, ent: ['jog', 'konyvelo'], plan: 'trial' });
  now += (3600 - 301) * 1000;
  await p.get();
  assert.strictEqual(calls.length, 1);
  now += 2000;
  await p.get();
  assert.deepStrictEqual(calls, [DEV, DEV]);
});

test('premium get: 204 → null és reason() a fejlécből; fetch-hiba → null, nem dob', async () => {
  const p = P.create({ deviceId: DEV, fetchPremium: async () => ({ status: 204, reason: 'no_entitlement' }) });
  assert.strictEqual(await p.get(), null);
  assert.strictEqual(p.reason(), 'no_entitlement');
  const q = P.create({ deviceId: DEV, fetchPremium: async () => { throw new Error('offline'); } });
  assert.strictEqual(await q.get(), null);
  assert.strictEqual(q.reason(), 'unavailable');
  const lassu = P.create({ deviceId: DEV, timeoutMs: 50, fetchPremium: () => new Promise(() => {}) });
  assert.strictEqual(await lassu.get(), null);
  assert.strictEqual(lassu.reason(), 'unavailable');
});

test('premium get: sikertelen lekérés után 90 s-ig nem kér újra (a billing kiesése nem lassít minden kört); reset törli', async () => {
  let now = 1_800_000_000_000;
  let calls = 0;
  let resp = () => { throw new Error('offline'); };
  const p = P.create({ deviceId: DEV, now: () => now, fetchPremium: async () => { calls++; return resp(); } });
  assert.strictEqual(await p.get(), null);
  now += 89_000;
  assert.strictEqual(await p.get(), null);
  assert.strictEqual(calls, 1);
  assert.strictEqual(p.reason(), 'unavailable');
  now += 2_000;
  resp = () => okResp(now);
  assert.ok(await p.get());
  assert.strictEqual(calls, 2);
  // 204 (pl. nincs előfizetés): 60 s-ig nem kérdez újra
  const q = P.create({ deviceId: DEV, now: () => now, fetchPremium: async () => { calls++; return { status: 204, reason: 'no_entitlement' }; } });
  calls = 0;
  await q.get(); await q.get();
  assert.strictEqual(calls, 1);
  now += 61_000;
  await q.get();
  assert.strictEqual(calls, 2);
  q.reset();
  await q.get();
  assert.strictEqual(calls, 3);
});

test('premium get: hibás válasz (nem https, hiányzó token) → null', async () => {
  const now = Date.now();
  const p = P.create({ deviceId: DEV, now: () => now, fetchPremium: async () => okResp(now, { url: 'http://mcp.pelda.test/mcp/' }) });
  assert.strictEqual(await p.get(), null);
  const q = P.create({ deviceId: DEV, now: () => now, fetchPremium: async () => okResp(now, { token: '' }) });
  assert.strictEqual(await q.get(), null);
});

test('premium jelzés: no_entitlement egyszer, második körben nem; unavailable mellett nincs; reset után újra', async () => {
  let reason = 'no_entitlement';
  const p = P.create({ deviceId: DEV, fetchPremium: async () => ({ status: 204, reason }) });
  await p.get();
  assert.strictEqual(p.notice(), 'A jogi és könyvelői eszközökhöz előfizetés kell.');
  await p.get();
  assert.strictEqual(p.notice(), null);
  reason = 'unavailable';
  await p.get();
  assert.strictEqual(p.notice(), null);
  for (const [r, text] of [
    ['revoked', 'A jogi és könyvelői eszközökhöz előfizetés kell.'],
    ['trial_limit', 'Erről a hálózatról már több próbaidő is indult. A jogi és könyvelői eszközökhöz előfizetés kell.'],
    ['device_limit', 'Az előfizetésed már 3 eszközön használja a szakmai eszközöket.'],
  ]) {
    p.reset();
    reason = r;
    await p.get();
    assert.strictEqual(p.notice(), text, r);
  }
  for (const r of ['not_official', 'terms']) {
    p.reset();
    reason = r;
    await p.get();
    assert.strictEqual(p.notice(), null, r);
  }
});

test('premium deviceIdFor: egyszer generált UUID, 0600, két indítás között ugyanaz', () => {
  const u = tmp();
  const a = P.deviceIdFor(u);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.strictEqual(P.deviceIdFor(u), a);
  const f = path.join(u, 'kapu', 'device-id');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  fs.writeFileSync(f, 'szemet');
  assert.notStrictEqual(P.deviceIdFor(u), 'szemet');
});

// --- isolation ----------------------------------------------------------------------------------

test('prepare claude: premium mellett két http szerver, a szakmaié Bearer tokennel', async () => {
  const p = await iso.prepare({ engine: 'claude', userData: tmp(), mcp: HTTP, premium: PREMIUM, readKeychain: keychain, sourceHome: fakeHome() });
  const cfg = JSON.parse(fs.readFileSync(p.mcpFile, 'utf8'));
  assert.deepStrictEqual(Object.keys(cfg.mcpServers), ['kapumail', 'kapumail_szakmai']);
  assert.deepStrictEqual(cfg.mcpServers.kapumail_szakmai, { type: 'http', url: PREMIUM.url, headers: { Authorization: `Bearer ${PTOK}` } });
  assert.strictEqual(p.premium, true);
  p.cleanup();
  assert.ok(!fs.existsSync(p.mcpFile));
});

test('prepare claude: premium null → a konfig pontosan a mostani', async () => {
  const p = await iso.prepare({ engine: 'claude', userData: tmp(), mcp: HTTP, premium: null, readKeychain: keychain, sourceHome: fakeHome() });
  assert.strictEqual(fs.readFileSync(p.mcpFile, 'utf8'), JSON.stringify({ mcpServers: { kapumail: { type: 'http', url: HTTP.url, headers: { Authorization: `Bearer ${TOKEN}` } } } }));
  assert.strictEqual(p.premium, false);
  p.cleanup();
});

test('prepare: hibás premium (nem https vagy üres token) kimarad', async () => {
  for (const bad of [{ url: 'http://x/mcp/', token: PTOK }, { url: PREMIUM.url, token: '' }, { url: 'nem url', token: PTOK }, 'szoveg']) {
    const p = await iso.prepare({ engine: 'claude', userData: tmp(), mcp: HTTP, premium: bad, readKeychain: keychain, sourceHome: fakeHome() });
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(p.mcpFile, 'utf8')).mcpServers), ['kapumail']);
    p.cleanup();
  }
});

test('prepare codex: kapumail_szakmai kapcsolók, a token csak a környezetben', async () => {
  const p = await iso.prepare({ engine: 'codex', userData: tmp(), mcp: HTTP, premium: PREMIUM, sourceHome: fakeHome(), env: { ...process.env, CODEX_HOME: '/idegen' } });
  const a = p.args0.join(' ');
  assert.ok(a.includes(`mcp_servers.kapumail_szakmai.url=${PREMIUM.url}`));
  assert.ok(a.includes('mcp_servers.kapumail_szakmai.bearer_token_env_var=KAPUMAIL_SZAKMAI_TOKEN'));
  assert.ok(a.includes('mcp_servers.kapumail_szakmai.enabled=true'));
  assert.ok(!a.includes(PTOK));
  assert.strictEqual(p.env.KAPUMAIL_SZAKMAI_TOKEN, PTOK);
  p.cleanup();
  const q = await iso.prepare({ engine: 'codex', userData: tmp(), mcp: HTTP, sourceHome: fakeHome(), env: { ...process.env, CODEX_HOME: '/idegen', KAPUMAIL_SZAKMAI_TOKEN: 'kivulrol' } });
  assert.ok(!q.args0.join(' ').includes('kapumail_szakmai'));
  assert.strictEqual(q.env.KAPUMAIL_SZAKMAI_TOKEN, undefined);
  q.cleanup();
});

test('prepare agy: mcp_config.json két szerverrel, és a szakmai eszközök is engedélyezettek', async () => {
  const p = await iso.prepare({ engine: 'agy', userData: tmp(), mcp: HTTP, premium: PREMIUM, readKeychain: keychain, sourceHome: fakeHome() });
  const mcp = JSON.parse(fs.readFileSync(path.join(p.home, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
  assert.deepStrictEqual(mcp.mcpServers.kapumail_szakmai, { serverUrl: PREMIUM.url, headers: { Authorization: `Bearer ${PTOK}` } });
  const settings = JSON.parse(fs.readFileSync(path.join(p.home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
  assert.deepStrictEqual(settings.permissions.allow, ['mcp(kapumail/*)', 'search_web(*)', 'mcp(kapumail_szakmai/*)']);
  p.cleanup();
  const q = await iso.prepare({ engine: 'agy', userData: tmp(), mcp: HTTP, readKeychain: keychain, sourceHome: fakeHome() });
  const s2 = JSON.parse(fs.readFileSync(path.join(q.home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
  assert.deepStrictEqual(s2.permissions.allow, ['mcp(kapumail/*)', 'search_web(*)']);
  q.cleanup();
});

// --- run ----------------------------------------------------------------------------------------

test('buildArgs claude: premium mellett mindkét eszközelőtag engedélyezett', () => {
  const a = R.buildArgs('claude', { mcpFile: '/x.json', persona: 'p', premium: true });
  assert.strictEqual(a[a.indexOf('--allowedTools') + 1], 'mcp__kapumail__*,mcp__kapumail_szakmai__*,WebSearch');
  const b = R.buildArgs('claude', { mcpFile: '/x.json', persona: 'p' });
  assert.strictEqual(b[b.indexOf('--allowedTools') + 1], 'mcp__kapumail__*,WebSearch');
});

test('parser: a szakmai eszközök saját feliratot kapnak mindhárom motorban; ismeretlen → BUSY', () => {
  const c = R.createParser('claude');
  const ev = c.line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__kapumail_szakmai__jog_kereses', input: {} }] } });
  assert.deepStrictEqual(ev, [{ type: 'activity', text: 'Keresem a jogszabályt…' }]);
  const x = R.createParser('codex');
  assert.deepStrictEqual(x.line({ type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'kapumail_szakmai', tool: 'official_sources_search' } }),
    [{ type: 'activity', text: 'Keresem a hivatalos könyvelői forrást…' }]);
  const g = R.createParser('agy');
  const ag = g.line({ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'call_mcp_tool', step_index: 1, state: 'RUNNING', tool_info: { parameters: { ServerName: 'kapumail_szakmai', ToolName: 'jog_szakasz' } } } });
  assert.deepStrictEqual(ag, [{ type: 'activity', text: 'Megnézem a jogszabályhelyet…' }]);
  assert.strictEqual(R.activityFor('ismeretlen_eszkoz'), 'Dolgozom rajta…');
  for (const t of ['jog_kereses', 'jog_szakasz', 'jog_valtozasok', 'jog_diff', 'official_sources_search', 'official_source_get',
    'official_source_verify', 'official_source_history', 'official_source_status', 'official_answer_check']) {
    assert.notStrictEqual(R.activityFor(t), 'Dolgozom rajta…', t);
  }
});

test('persona: a szakmai eszközök szabályai benne vannak', () => {
  const p = fs.readFileSync(path.join(__dirname, '..', 'kapu', 'persona.md'), 'utf8');
  assert.match(p, /nem hiteles jogforrás/);
  assert.match(p, /njt\.hu/);
  assert.match(p, /vonatkozási nap/);
});
