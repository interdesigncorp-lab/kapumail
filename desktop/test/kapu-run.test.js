'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const iso = require('../kapu/isolation');
const R = require('../kapu/run');

const FAKE = path.join(__dirname, 'fake-ai-cli');
const FIX = path.join(__dirname, 'fixtures', 'kapu');
const CONFIRM = '9f1c2a7e-0d3b-4c51-8e7a-2b6f4d9a1c30';
const TOKEN = 'kapu-teszt-token-0123456789';
const STDIO = { mode: 'stdio', php: '/usr/bin/php', artisan: '/opt/kapumail/artisan', token: TOKEN };
const HTTP = { mode: 'http', url: 'https://iroda.kapumail.hu/mcp', token: TOKEN };
const MCP_OFF_TEXT = 'Kapu most nem éri el az iroda adatait: az AI-kapcsolat ki van kapcsolva, vagy a Kapu-hozzáférés lejárt. Kapcsold be újra a Beállításokban.';

// Hamis belépések a kulcskarika helyett (a valódi kulcskarikát a teszt nem olvassa).
const AGY_LOGIN = JSON.stringify({ token: { access_token: 'ya29.teszt', token_type: 'Bearer', refresh_token: '1//teszt', expiry: '2099-01-01T00:00:00Z' }, auth_method: 'consumer' });
const claudeLogin = (expiresAt) => JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-teszt', refreshToken: 'sk-ant-ort-teszt', expiresAt, scopes: ['user:inference'], subscriptionType: 'max' } });
const keychain = async (service) => (service === 'gemini' ? AGY_LOGIN : service.startsWith('Claude Code-credentials') ? claudeLogin(4102444800000) : null);
const CODEX_AUTH = { auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-nem-kell', tokens: { id_token: 'id', access_token: 'acc', refresh_token: 'ref-1', account_id: 'a' }, last_refresh: '2026-11-07T14:56:34Z' };

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-run-'));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// Hamis felhasználói HOME: a codex belépése (~/.codex/auth.json) van benne.
function fakeHome() {
  const h = tmp();
  fs.mkdirSync(path.join(h, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(h, '.codex', 'auth.json'), JSON.stringify(CODEX_AUTH), { mode: 0o600 });
  return h;
}

const prep = (engine, extra = {}) => iso.prepare({ engine, userData: extra.userData || tmp(), mcp: STDIO, readKeychain: keychain, sourceHome: fakeHome(), ...extra });

// Egy kör a hamis CLI-vel; az összes eseményt visszaadja, amikor záró esemény jött.
function runTurn(engine, state, extra = {}) {
  const userData = extra.userData || tmp();
  const events = [];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const h = R.startRun({
      engine,
      message: extra.message || 'Keresd meg a Minta Kft.-t.',
      sessionId: extra.sessionId,
      conv: { userData, mcp: extra.mcp || STDIO },
      bin: path.join(FAKE, engine),
      env: { ...process.env, FAKE_AI_STATE: JSON.stringify(state), ANTHROPIC_API_KEY: 'sk-ant-titok', OPENAI_API_KEY: 'sk-titok', CODEX_HOME: '/idegen' },
      readKeychain: keychain,
      sourceHome: extra.sourceHome || fakeHome(),
      timeoutMs: extra.timeoutMs || 10000,
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'final' || e.type === 'error') resolve({ events, ms: Date.now() - t0, userData, handle: h });
      },
    });
    if (extra.onStart) extra.onStart(h, events, resolve, userData);
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const leftovers = (userData) => {
  const k = path.join(userData, 'kapu');
  const run = path.join(k, 'run');
  return [...(fs.existsSync(k) ? fs.readdirSync(k).filter((n) => n.startsWith('agy-home-')) : []), ...(fs.existsSync(run) ? fs.readdirSync(run) : [])];
};

// --- buildArgs ----------------------------------------------------------------------------------

test('buildArgs claude: mcp__kapumail__* és WebSearch engedélyezett, --strict-mcp-config', () => {
  const a = R.buildArgs('claude', { mcpFile: '/x/mcp.json', personaFile: '/x/p.md', extra: ['--settings', '/x/s.json'] });
  assert.strictEqual(a[0], '-p');
  assert.ok(a[1].startsWith('--')); // a kérdés nem a parancssorban van
  const at = (flag) => a[a.indexOf(flag) + 1];
  assert.ok(a.includes('--strict-mcp-config'));
  assert.strictEqual(at('--mcp-config'), '/x/mcp.json');
  assert.strictEqual(at('--setting-sources'), '');
  assert.strictEqual(at('--output-format'), 'stream-json');
  assert.ok(a.includes('--verbose'));
  // az --allowedTools értéke a kapumail és a WebSearch, utána rögtön kapcsoló jön
  assert.strictEqual(at('--allowedTools'), 'mcp__kapumail__*,WebSearch');
  assert.ok(a[a.indexOf('--allowedTools') + 2].startsWith('--'));
  assert.strictEqual(at('--tools'), 'WebSearch');
  assert.strictEqual(at('--append-system-prompt-file'), '/x/p.md');
  assert.ok(!a.includes('--append-system-prompt'));
  assert.strictEqual(at('--settings'), '/x/s.json');
  for (const bad of ['Bash', 'Read', 'WebFetch', '--dangerously-skip-permissions']) assert.ok(!a.includes(bad), bad);
  assert.ok(a.includes('WebSearch'));
  assert.ok(!a.includes('--resume'));
  // egyetlen argumentumban sincs sortörés vagy idézőjel (Windows, cmd.exe)
  assert.ok(a.every((x) => !/["\n\r]/.test(x)));
  const r = R.buildArgs('claude', { mcpFile: '/x/mcp.json', personaFile: '/x/p.md', sessionId: 'abc' });
  assert.deepStrictEqual(r.slice(-2), ['--resume', 'abc']);
  assert.strictEqual(R.stdinFor('claude', '--help', 'P'), '--help');
});

test('buildArgs codex: read-only sandbox, üres cwd, mcp kapcsolók', async () => {
  const userData = tmp();
  const p = await prep('codex', { userData, mcp: HTTP });
  const a = R.buildArgs('codex', { cwd: p.cwd, extra: p.args0 });
  const at = (flag) => a[a.indexOf(flag) + 1];
  assert.strictEqual(a[0], 'exec');
  assert.strictEqual(at('--sandbox'), 'read-only');
  assert.strictEqual(at('--cd'), path.join(userData, 'kapu', 'work'));
  assert.deepStrictEqual(fs.readdirSync(at('--cd')), []);
  assert.strictEqual(a[a.length - 1], '-'); // a kérdés a bemeneten
  assert.ok(a.includes('--json') && a.includes('--skip-git-repo-check') && a.includes('--ignore-user-config'));
  const cs = a.flatMap((x, i) => (x === '-c' ? [a[i + 1]] : []));
  for (const c of ['sandbox_mode=read-only', 'approval_policy=never', 'web_search=live',
    'mcp_servers.kapumail.url=https://iroda.kapumail.hu/mcp', 'mcp_servers.kapumail.bearer_token_env_var=KAPUMAIL_MCP_TOKEN',
    'mcp_servers.kapumail.default_tools_approval_mode=approve']) assert.ok(cs.includes(c), c);
  assert.ok(!cs.includes('web_search=disabled'));
  const off = a.flatMap((x, i) => (x === '--disable' ? [a[i + 1]] : []));
  for (const f of ['shell_tool', 'unified_exec', 'view_image', 'browser_use', 'computer_use', 'memories', 'plugins', 'code_mode', 'code_mode_host']) assert.ok(off.includes(f), f);
  // a token értéke sosem kerül a parancssorba, csak a környezetbe
  assert.ok(!a.some((x) => x.includes(TOKEN)));
  assert.ok(a.every((x) => !/["\n\r]/.test(x)));
  assert.strictEqual(p.env.KAPUMAIL_MCP_TOKEN, TOKEN);
  const r = R.buildArgs('codex', { sessionId: 'thr-1', extra: p.args0 });
  assert.deepStrictEqual(r.slice(0, 2), ['exec', 'resume']);
  assert.deepStrictEqual(r.slice(-2), ['thr-1', '-']);
  assert.ok(r.includes('sandbox_mode=read-only'));
  assert.match(R.stdinFor('codex', 'Szia', 'Kapu vagy.'), /^Kapu vagy\.[\s\S]*Szia$/);
  assert.strictEqual(R.stdinFor('codex', 'Szia', 'Kapu vagy.', 'thr-1'), 'Szia');
  p.cleanup(); // egyszerre csak egy codex-kör tarthat belépés-másolatot
  // stdio: a token neve megy tovább, az értéke nem
  const s = await prep('codex', { userData, mcp: STDIO });
  assert.ok(s.args0.includes('mcp_servers.kapumail.env_vars=["IRATKAPU_MCP_TOKEN"]'));
  assert.ok(s.args0.includes('mcp_servers.kapumail.args=["/opt/kapumail/artisan","mcp:start","iratkapu"]'));
  assert.ok(!s.args0.some((x) => x.includes(TOKEN)));
  assert.strictEqual(s.env.IRATKAPU_MCP_TOKEN, TOKEN);
  s.cleanup();
});

test('buildArgs agy: plan mód, sandbox', () => {
  const a = R.buildArgs('agy', { timeoutSec: 150 });
  const at = (flag) => a[a.indexOf(flag) + 1];
  assert.deepStrictEqual(a.slice(0, 2), ['-p', '']);
  assert.strictEqual(at('--input-format'), 'stream-json');
  assert.strictEqual(at('--mode'), 'plan');
  assert.ok(a.includes('--sandbox'));
  assert.strictEqual(at('--output-format'), 'stream-json');
  assert.strictEqual(at('--print-timeout'), '150s');
  // a --disable-slash-commands mellett a plan mód hatástalan lenne
  assert.ok(!a.includes('--disable-slash-commands'));
  assert.ok(!a.includes('--dangerously-skip-permissions'));
  const first = JSON.parse(R.stdinFor('agy', 'Szia\n"idézet"', 'Kapu vagy.'));
  assert.strictEqual(first.event, 'user');
  assert.match(first.message.content, /^Kapu vagy\.[\s\S]*Szia\n"idézet"$/);
  const next = JSON.parse(R.stdinFor('agy', '/help', 'P', 'c-1'));
  assert.strictEqual(next.message.content, ' /help'); // folytatásnál nincs személyiség, és nem parancs
  assert.deepStrictEqual(R.buildArgs('agy', { sessionId: 'c-1' }).slice(-2), ['--conversation', 'c-1']);
});

// --- prepare ------------------------------------------------------------------------------------

test('prepare: cwd üres mappa a userData alatt', async () => {
  const userData = tmp();
  const work = path.join(userData, 'kapu', 'work');
  fs.mkdirSync(path.join(work, 'maradek'), { recursive: true });
  fs.writeFileSync(path.join(work, 'regi.txt'), 'x');
  for (const engine of ['claude', 'codex', 'agy']) {
    const p = await prep(engine, { userData, env: { ...process.env, OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-y', ANTHROPIC_BASE_URL: 'https://gw' } });
    assert.strictEqual(p.cwd, work);
    assert.deepStrictEqual(fs.readdirSync(p.cwd), []);
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) assert.strictEqual(p.env[k], undefined, k);
    p.cleanup();
  }
});

test('prepare claude: 0600-as MCP-fájl, saját CLAUDE_CONFIG_DIR, token csak környezetben', async () => {
  const userData = tmp();
  const p = await prep('claude', { userData, mcp: HTTP, persona: 'Kapu vagy.\n"tegeződsz"' });
  const st = fs.statSync(p.mcpFile);
  if (process.platform !== 'win32') assert.strictEqual(st.mode & 0o777, 0o600);
  const cfg = JSON.parse(fs.readFileSync(p.mcpFile, 'utf8'));
  assert.deepStrictEqual(Object.keys(cfg.mcpServers), ['kapumail']);
  assert.deepStrictEqual(cfg.mcpServers.kapumail, { type: 'http', url: HTTP.url, headers: { Authorization: `Bearer ${TOKEN}` } });
  const settings = p.args0[p.args0.indexOf('--settings') + 1];
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { autoMemoryEnabled: false });
  assert.strictEqual(fs.readFileSync(p.personaFile, 'utf8'), 'Kapu vagy.\n"tegeződsz"');
  const cli = path.join(userData, 'kapu', 'cli', 'claude');
  assert.strictEqual(p.env.CLAUDE_CONFIG_DIR, cli);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(cli).mode & 0o777, 0o700);
  assert.strictEqual(p.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-teszt');
  assert.ok(!JSON.stringify(p.args0).includes('sk-ant'));
  p.cleanup();
  assert.ok(!fs.existsSync(p.mcpFile) && !fs.existsSync(settings) && !fs.existsSync(p.personaFile));
  const s = await prep('claude', { userData, mcp: STDIO });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(s.mcpFile, 'utf8')).mcpServers.kapumail,
    { type: 'stdio', command: '/usr/bin/php', args: ['/opt/kapumail/artisan', 'mcp:start', 'iratkapu'], env: { IRATKAPU_MCP_TOKEN: TOKEN } });
  s.cleanup();
});

test('prepare claude: lejáró belépést a saját claude frissít, különben signed_out', async () => {
  let logins = [claudeLogin(Date.now() + 1000), claudeLogin(4102444800000)];
  let renewed = 0;
  const kc = async (service) => (service.startsWith('Claude') ? logins[Math.min(renewed, 1)] : null);
  const p = await prep('claude', { readKeychain: kc, renewClaude: async () => { renewed++; } });
  assert.strictEqual(renewed, 1);
  assert.strictEqual(p.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-teszt');
  p.cleanup();
  logins = [claudeLogin(Date.now() + 1000), claudeLogin(Date.now() + 1000)];
  renewed = 0;
  await assert.rejects(prep('claude', { readKeychain: kc, renewClaude: async () => { renewed++; } }), (e) => e.code === 'signed_out' && /lejárt/.test(e.message));
  await assert.rejects(prep('claude', { readKeychain: async () => null }), (e) => e.code === 'signed_out');
});

test('prepare codex: saját CODEX_HOME az auth.json másolatával; frissített belépés vissza az eredetibe', async () => {
  const userData = tmp();
  const home = fakeHome();
  const p = await iso.prepare({ engine: 'codex', userData, mcp: HTTP, sourceHome: home, env: { ...process.env, CODEX_HOME: '/idegen' } });
  const root = path.join(userData, 'kapu', 'cli', 'codex');
  // új beszélgetés: saját h-* mappa
  assert.strictEqual(path.dirname(p.env.CODEX_HOME), root);
  assert.match(path.basename(p.env.CODEX_HOME), /^h-/);
  const h = p.env.CODEX_HOME;
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(p.env.CODEX_HOME).mode & 0o777, 0o700);
  const copy = path.join(p.env.CODEX_HOME, 'auth.json');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(copy).mode & 0o777, 0o600);
  const c = JSON.parse(fs.readFileSync(copy, 'utf8'));
  assert.strictEqual(c.OPENAI_API_KEY, null); // API-kulcs nem megy át
  assert.strictEqual(c.tokens.refresh_token, 'ref-1');
  // a futás frissítette a belépést → az eredeti auth.json-ba visszaíródik, az API-kulcs mezője megmarad
  fs.writeFileSync(copy, JSON.stringify({ ...c, tokens: { ...c.tokens, refresh_token: 'ref-2' } }));
  const thread = '01a1d486-c1aa-7b51-81d6-52a25e1daf0d';
  const rollout = (home, id) => { const d = path.join(home, 'sessions', '2026', '11', '13'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `rollout-2026-11-13T11-49-23-${id}.jsonl`), '{}'); };
  rollout(h, thread);
  p.cleanup({ sessionId: thread });
  assert.deepStrictEqual(fs.readdirSync(root), [path.basename(h)]);
  assert.ok(!fs.existsSync(path.join(h, 'auth.json'))); // a belépés másolata nem marad
  const orig = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'));
  assert.strictEqual(orig.tokens.refresh_token, 'ref-2');
  assert.strictEqual(orig.OPENAI_API_KEY, 'sk-nem-kell');
  // ha az eredeti közben megváltozott, nem írunk rá
  // csak átformázott fájl, változatlan tokenek → nincs visszaírás
  const before = fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8');
  const s2 = await iso.prepare({ engine: 'codex', userData, mcp: HTTP, sourceHome: home, sessionId: thread });
  const c2 = JSON.parse(fs.readFileSync(path.join(s2.env.CODEX_HOME, 'auth.json'), 'utf8'));
  fs.writeFileSync(path.join(s2.env.CODEX_HOME, 'auth.json'), JSON.stringify({ ...c2, last_refresh: 'masik' }));
  s2.cleanup({ sessionId: thread });
  assert.strictEqual(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'), before);
  // folytatás: ugyanaz a mappa
  const q = await iso.prepare({ engine: 'codex', userData, mcp: HTTP, sourceHome: home, sessionId: thread });
  assert.strictEqual(q.env.CODEX_HOME, h);
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ ...CODEX_AUTH, tokens: { ...CODEX_AUTH.tokens, refresh_token: 'felhasznalo' } }));
  fs.writeFileSync(path.join(q.env.CODEX_HOME, 'auth.json'), JSON.stringify({ ...c, tokens: { ...c.tokens, refresh_token: 'ref-3' } }));
  q.cleanup({ sessionId: thread });
  assert.deepStrictEqual(fs.readdirSync(root), [path.basename(h)]);
  // sikertelen új kör (nincs azonosító): a new-* mappa törlődik
  const r = await iso.prepare({ engine: 'codex', userData, mcp: HTTP, sourceHome: home });
  r.cleanup();
  assert.deepStrictEqual(fs.readdirSync(root), [path.basename(h)]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).tokens.refresh_token, 'felhasznalo');
  // belépés nélkül signed_out
  await assert.rejects(iso.prepare({ engine: 'codex', userData, mcp: HTTP, sourceHome: tmp() }), (e) => e.code === 'signed_out');
});

test('prepare: hibás MCP-cím vagy token elutasítva', async () => {
  const userData = tmp();
  await assert.rejects(prep('claude', { userData, mcp: { ...HTTP, url: 'http://gonosz.hu/mcp' } }), /https/);
  await assert.rejects(prep('codex', { userData, mcp: { ...HTTP, url: 'https://x/mcp" -c foo' } }));
  await assert.rejects(prep('codex', { userData, mcp: { ...HTTP, token: 'van benne szóköz' } }), /token/i);
});

test('prepare agy: a globális HOME-ba nem ír', async () => {
  const userData = tmp();
  const gemini = path.join(os.homedir(), '.gemini');
  const watch = [gemini, path.join(gemini, 'antigravity-cli'), path.join(gemini, 'config'), path.join(gemini, 'antigravity-cli', 'settings.json'), path.join(gemini, 'config', 'mcp_config.json')];
  const mtimes = () => watch.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } });
  const before = mtimes();
  const p = await prep('agy', { userData, mcp: HTTP, sourceHome: fakeHome() });
  assert.deepStrictEqual(mtimes(), before);
  assert.ok(p.home.startsWith(path.join(userData, 'kapu', 'agy-home-')));
  assert.strictEqual(p.env.HOME, p.home);
  const settings = JSON.parse(fs.readFileSync(path.join(p.home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
  assert.deepStrictEqual(settings.permissions.allow, ['mcp(kapumail/*)', 'search_web(*)']);
  for (const d of ['read_file(*)', 'write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)']) assert.ok(settings.permissions.deny.includes(d), d);
  const mcp = JSON.parse(fs.readFileSync(path.join(p.home, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
  assert.deepStrictEqual(mcp, { mcpServers: { kapumail: { serverUrl: HTTP.url, headers: { Authorization: `Bearer ${TOKEN}` } } } });
  const token = JSON.parse(fs.readFileSync(path.join(p.home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8'));
  assert.strictEqual(token.auth_method, 'consumer');
  assert.strictEqual(token.token.access_token, 'ya29.teszt');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(p.home).mode & 0o777, 0o700);
  p.cleanup();
  assert.ok(!fs.existsSync(p.home));
  assert.deepStrictEqual(mtimes(), before);
});

test('prepare agy: belépés nélkül signed_out', async () => {
  const userData = tmp();
  await assert.rejects(prep('agy', { userData, mcp: HTTP, sourceHome: tmp(), readKeychain: async () => null }), (e) => e.code === 'signed_out');
  assert.deepStrictEqual(leftovers(userData), []);
});

test('prepare agy: a beszélgetés-adatbázis átmegy a következő körre (a program saját mappájában)', async () => {
  const userData = tmp();
  const id = 'a872f131-a4cd-4cbf-b27a-7ea43bcb234b';
  const p = await prep('agy', { userData, mcp: HTTP });
  const conv = path.join(p.home, '.gemini', 'antigravity-cli', 'conversations');
  fs.mkdirSync(conv, { recursive: true });
  fs.writeFileSync(path.join(conv, `${id}.db`), 'beszelgetes');
  p.cleanup();
  assert.strictEqual(fs.readFileSync(path.join(userData, 'kapu', 'cli', 'agy', 'conversations', `${id}.db`), 'utf8'), 'beszelgetes');
  const q = await prep('agy', { userData, mcp: HTTP, sessionId: id });
  assert.strictEqual(fs.readFileSync(path.join(q.home, '.gemini', 'antigravity-cli', 'conversations', `${id}.db`), 'utf8'), 'beszelgetes');
  q.cleanup();
});

test('sweep: a 10 percnél régebbi agy-home-* és run/* törlődik, a friss marad', () => {
  const userData = tmp();
  const k = path.join(userData, 'kapu');
  fs.mkdirSync(path.join(k, 'run'), { recursive: true });
  fs.mkdirSync(path.join(k, 'agy-home-regi', '.gemini'), { recursive: true });
  fs.mkdirSync(path.join(k, 'agy-home-friss'));
  fs.writeFileSync(path.join(k, 'run', 'regi.mcp.json'), 'Bearer x');
  fs.writeFileSync(path.join(k, 'run', 'friss.mcp.json'), 'Bearer y');
  fs.mkdirSync(path.join(k, 'cli', 'claude'), { recursive: true });
  fs.mkdirSync(path.join(k, 'cli', 'codex', 'h-felbe'), { recursive: true });
  const kept = path.join(k, 'cli', 'codex', 'h-szal', 'sessions', '2026');
  fs.mkdirSync(kept, { recursive: true });
  fs.writeFileSync(path.join(kept, 'rollout-x-01a1d486-c1aa-7b51-81d6-52a25e1daf0d.jsonl'), '{}');
  // kör közben összeomlott codex: a belépés-másolat a megtartott mappában maradt
  const staleAuth = path.join(k, 'cli', 'codex', 'h-szal', 'auth.json');
  fs.writeFileSync(staleAuth, '{"tokens":{"refresh_token":"x"}}');
  fs.mkdirSync(path.join(k, 'cli', 'codex', 'h-fut', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(k, 'cli', 'codex', 'h-fut', 'sessions', 'rollout-y.jsonl'), '{}');
  const liveAuth = path.join(k, 'cli', 'codex', 'h-fut', 'auth.json');
  fs.writeFileSync(liveAuth, '{}'); // friss: egy éppen futó kör másolata
  const old = new Date(Date.now() - 11 * 60 * 1000);
  for (const f of [path.join(k, 'agy-home-regi'), path.join(k, 'run', 'regi.mcp.json'), path.join(k, 'cli'), path.join(k, 'cli', 'codex', 'h-felbe'), path.join(k, 'cli', 'codex', 'h-szal'), staleAuth]) fs.utimesSync(f, old, old);
  const removed = iso.sweep(userData);
  assert.strictEqual(removed.length, 4);
  assert.deepStrictEqual(fs.readdirSync(path.join(k, 'cli', 'codex')).sort(), ['h-fut', 'h-szal']);
  assert.ok(!fs.existsSync(staleAuth));
  assert.ok(fs.existsSync(liveAuth));
  assert.ok(fs.existsSync(path.join(kept, 'rollout-x-01a1d486-c1aa-7b51-81d6-52a25e1daf0d.jsonl')));
  assert.deepStrictEqual(fs.readdirSync(path.join(k, 'run')), ['friss.mcp.json']);
  assert.ok(fs.existsSync(path.join(k, 'agy-home-friss')) && !fs.existsSync(path.join(k, 'agy-home-regi')));
  assert.ok(fs.existsSync(path.join(k, 'cli', 'claude'))); // a CLI-k állapota nem szemét
});

test('forgetSession: a beszélgetés CLI-oldali fájljai törlődnek, a többi marad', () => {
  const userData = tmp();
  const id = 'cc91938c-eb34-444a-a7ae-76becff5502b';
  const other = '01a1d472-551b-78f0-8310-4572e0c2887a';
  const cli = path.join(userData, 'kapu', 'cli');
  const proj = path.join(cli, 'claude', 'projects', '-tmp-kapu-work');
  fs.mkdirSync(path.join(proj, id, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(proj, `${id}.jsonl`), 'x');
  fs.writeFileSync(path.join(proj, `${other}.jsonl`), 'y');
  for (const t of [id, other]) {
    const d = path.join(cli, 'codex', `h-${t.slice(0, 6)}`, 'sessions', '2026', '11', '13');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `rollout-2026-11-13T11-28-05-${t}.jsonl`), 'x');
    fs.writeFileSync(path.join(cli, 'codex', `h-${t.slice(0, 6)}`, 'state_5.sqlite'), 'beszelgetes');
  }
  fs.mkdirSync(path.join(cli, 'agy', 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(cli, 'agy', 'conversations', `${id}.db`), 'x');
  iso.forgetSession(userData, 'claude', id);
  assert.deepStrictEqual(fs.readdirSync(proj), [`${other}.jsonl`]);
  iso.forgetSession(userData, 'codex', id);
  assert.deepStrictEqual(fs.readdirSync(path.join(cli, 'codex')), [`h-${other.slice(0, 6)}`]);
  iso.forgetSession(userData, 'agy', id);
  assert.deepStrictEqual(fs.readdirSync(path.join(cli, 'agy', 'conversations')), []);
  // érvénytelen azonosítóval semmit nem töröl
  assert.strictEqual(iso.forgetSession(userData, 'claude', '..'), 0);
  assert.strictEqual(iso.forgetSession(userData, 'claude', ''), 0);
});

// --- run ----------------------------------------------------------------------------------------

for (const engine of ['claude', 'codex', 'agy']) {
  test(`run: fixture-ből activity, confirm, session, final események sorrendben (${engine})`, async () => {
    const argsFile = path.join(tmp(), 'args.json');
    const { events, userData } = await runTurn(engine, { fixture: path.join(FIX, `${engine}-turn.jsonl`), argsFile });
    const types = events.map((e) => e.type);
    assert.strictEqual(types[0], 'session');
    assert.deepStrictEqual(types.slice(1), ['activity', 'activity', 'confirm', 'final']);
    assert.deepStrictEqual(events.slice(1, 3).map((e) => e.text), ['Keresem az ügyfelet…', 'Előkészítem a beállítás módosítását…']);
    assert.strictEqual(events[3].id, CONFIRM);
    assert.match(events[4].text, /Minta Kft/);
    // amit a CLI kapott: üres munkamappa, kiszűrt kulcsok, a kérdés a bemeneten, saját állapotmappa
    const got = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.strictEqual(fs.realpathSync(got.cwd), fs.realpathSync(path.join(userData, 'kapu', 'work')));
    assert.ok(!got.env.includes('ANTHROPIC_API_KEY') && !got.env.includes('OPENAI_API_KEY'));
    assert.ok(!got.args.some((a) => a.includes('Minta Kft')));
    assert.match(got.stdin, /Keresd meg a Minta Kft\.-t\./);
    if (engine === 'agy') assert.ok(got.home.startsWith(path.join(userData, 'kapu', 'agy-home-')));
    if (engine === 'claude') assert.ok(got.env.includes('CLAUDE_CONFIG_DIR') && got.env.includes('CLAUDE_CODE_OAUTH_TOKEN'));
    if (engine === 'codex') {
      assert.ok(got.env.includes('CODEX_HOME'));
      // a hamis CLI nem ír rollout-fájlt, de kapott azonosítót: a saját mappa marad, a belépés másolata nélkül
      const root = path.join(userData, 'kapu', 'cli', 'codex');
      const homes = fs.readdirSync(root);
      assert.strictEqual(homes.length, 1);
      assert.ok(!fs.existsSync(path.join(root, homes[0], 'auth.json')));
    }
    // a kör után nem marad ideiglenes fájl
    await sleep(50);
    assert.deepStrictEqual(leftovers(userData), []);
  });
}

test('run: ismeretlen és hibás JSON-sorokat kihagy', async () => {
  const f = path.join(tmp(), 'zaj.jsonl');
  fs.writeFileSync(f, ['nem json', '{"type":"valami_uj","x":1}', '{"tört', fs.readFileSync(path.join(FIX, 'claude-turn.jsonl'), 'utf8')].join('\n'));
  const { events } = await runTurn('claude', { fixture: f });
  assert.strictEqual(events[events.length - 1].type, 'final');
});

for (const engine of ['claude', 'codex', 'agy']) {
  test(`run: kijelentkezett CLI gyors, értelmes hibát ad (${engine})`, async () => {
    const state = { fixture: path.join(FIX, `${engine}-signed-out.jsonl`), exitCode: 1 };
    // A valódi codex 401-nél percekig újrapróbál, az agy böngészős belépésre vár: a hamis is lóg.
    if (engine === 'codex') state.hangAfter = true;
    if (engine === 'agy') { state.hangAfter = true; state.stderr = 'Waiting for authentication (timeout 60s)...'; }
    const { events, ms } = await runTurn(engine, state);
    const last = events[events.length - 1];
    assert.strictEqual(last.type, 'error');
    assert.strictEqual(last.code, 'signed_out');
    assert.match(last.text, /nem vagy belépve/);
    assert.ok(ms < 2000, `${ms} ms`);
  });
}

test('run: az MCP-szerver 401-e nem kijelentkezés', () => {
  const p = R.createParser('codex');
  p.line({ type: 'error', message: 'MCP client for `kapumail` failed: 401 Unauthorized' });
  p.stderr('ERROR codex_core::mcp: kapumail 401 Unauthorized\n');
  assert.strictEqual(p.state.early, null);
  assert.strictEqual(p.end({ code: 1, stderr: 'mcp server kapumail: 401 Unauthorized' }).code, 'failed');
});

test('run: hiányzó CLI → missing', async () => {
  const events = [];
  await new Promise((resolve) => R.startRun({
    engine: 'codex', message: 'Szia', conv: { userData: tmp(), mcp: HTTP }, bin: '/nincs/ilyen/codex', sourceHome: fakeHome(),
    onEvent: (e) => { events.push(e); resolve(); },
  }));
  assert.strictEqual(events[0].code, 'missing');
  assert.match(events[0].text, /nincs telepítve/);
});

test('run: 150 mp korlát (paraméterezhető, a teszt 300 ms)', async () => {
  assert.strictEqual(R.TURN_TIMEOUT_MS, 150000);
  let pid;
  const { events, ms } = await runTurn('claude', { hang: true }, { timeoutMs: 300, onStart: (h) => setTimeout(() => { pid = h.pid; }, 100) });
  assert.deepStrictEqual(events.map((e) => e.code), ['timeout']);
  assert.match(events[0].text, /nem válaszolt/);
  assert.ok(ms >= 280 && ms < 2000, `${ms} ms`);
  await sleep(300);
  assert.ok(pid && !alive(pid));
});

test('run: cancel megöli a folyamatot', async () => {
  const userData = tmp();
  const events = [];
  const h = R.startRun({
    engine: 'claude', message: 'Szia', conv: { userData, mcp: HTTP }, bin: path.join(FAKE, 'claude'), readKeychain: keychain,
    env: { ...process.env, FAKE_AI_STATE: JSON.stringify({ fixture: path.join(FIX, 'claude-turn.jsonl'), hangAfter: true }) },
    onEvent: (e) => events.push(e),
  });
  for (let i = 0; i < 50 && !events.some((e) => e.type === 'session'); i++) await sleep(20);
  const pid = h.pid;
  assert.ok(pid && alive(pid));
  h.cancel();
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(20);
  assert.ok(!alive(pid));
  // megszakítás után nincs záró esemény, és az ideiglenes fájlok eltűnnek
  assert.ok(!events.some((e) => e.type === 'final' || e.type === 'error'));
  await sleep(50);
  assert.deepStrictEqual(leftovers(userData), []);
});

for (const engine of ['claude', 'agy']) {
  test(`run: azonnali cancel (még a felkészülés alatt) sem hagy tokenes fájlt (${engine})`, async () => {
    const userData = tmp();
    const events = [];
    const h = R.startRun({
      engine, message: 'Szia', conv: { userData, mcp: HTTP }, bin: path.join(FAKE, engine), readKeychain: keychain, sourceHome: fakeHome(),
      env: { ...process.env, FAKE_AI_STATE: JSON.stringify({ fixture: path.join(FIX, `${engine}-turn.jsonl`), hangAfter: true }) },
      onEvent: (e) => events.push(e),
    });
    h.cancel();
    await sleep(300);
    assert.deepStrictEqual(leftovers(userData), []);
    assert.strictEqual(h.pid, undefined); // el sem indult
    assert.deepStrictEqual(events, []);
  });
}

test('run: cancel SIGTERM után 2 mp-cel SIGKILL', async () => {
  assert.strictEqual(R.KILL_GRACE_MS, 2000);
  if (process.platform === 'win32') return;
  // A SIGTERM-et elnyelő folyamat: csak a SIGKILL állítja le.
  const dir = tmp();
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }))} + '\\n');\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const events = [];
  const h = R.startRun({ engine: 'claude', message: 'Szia', conv: { userData: tmp(), mcp: HTTP }, bin, readKeychain: keychain, killGraceMs: 300, onEvent: (e) => events.push(e) });
  for (let i = 0; i < 100 && !events.length; i++) await sleep(20);
  const pid = h.pid;
  h.cancel();
  await sleep(150);
  assert.ok(alive(pid), 'a SIGTERM még nem állította le');
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(20);
  assert.ok(!alive(pid));
});

test('run: cancel({cleanupNow}) a tokenes fájlokat azonnal törli, és SIGTERM után azonnal SIGKILL-t küld, nem időzítőre vár (kilépés)', async () => {
  if (process.platform === 'win32') return;
  const dir = tmp();
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }))} + '\\n');\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const userData = tmp();
  const events = [];
  const h = R.startRun({ engine: 'claude', message: 'Szia', conv: { userData, mcp: HTTP }, bin, readKeychain: keychain, killGraceMs: 60000, onEvent: (e) => events.push(e) });
  for (let i = 0; i < 100 && !events.length; i++) await sleep(20);
  const pid = h.pid;
  assert.ok(pid && alive(pid));
  assert.notDeepStrictEqual(leftovers(userData), []);
  h.cancel({ cleanupNow: true });
  assert.deepStrictEqual(leftovers(userData), []);
  // A SIGTERM-et elnyelő folyamatot a 60 mp-es türelmi idő előtt a SIGKILL leállítja.
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(20);
  assert.ok(!alive(pid), 'a SIGKILL azonnal ment');
});

for (const engine of ['claude', 'codex', 'agy']) {
  test(`run: a szerver hibás eszközeredménye („Nincs érvényes MCP-hozzáférés”) → mcp_off (${engine})`, async () => {
    const { events } = await runTurn(engine, { fixture: path.join(FIX, `${engine}-mcp-off.jsonl`) });
    const last = events[events.length - 1];
    assert.strictEqual(last.type, 'error');
    assert.strictEqual(last.code, 'mcp_off');
    assert.strictEqual(last.text, MCP_OFF_TEXT);
    assert.ok(!events.some((e) => e.type === 'confirm' || e.type === 'final'));
  });
}

for (const engine of ['claude', 'codex', 'agy']) {
  test(`run: sikeres eszközeredményben a „ki van kapcsolva” szöveg nem mcp_off (${engine})`, async () => {
    // A keresés eredménye helyére egy ügyfél kerül, akinek a jegyzetében ez áll – sikeres eredményként.
    const note = 'Nincs érvényes MCP-hozzáférés? Nem: az ügyfélnél ki van kapcsolva az értesítés.';
    const src = fs.readFileSync(path.join(FIX, `${engine}-turn.jsonl`), 'utf8');
    const out = src.replace(/\{\\"clients\\".*?\]\}/, JSON.stringify(JSON.stringify({ clients: [{ id: 42, name: 'Minta Kft.', note }] })).slice(1, -1));
    assert.notStrictEqual(out, src);
    const f = path.join(tmp(), `${engine}.jsonl`);
    fs.writeFileSync(f, out);
    const { events } = await runTurn(engine, { fixture: f });
    assert.strictEqual(events[events.length - 1].type, 'final');
  });
}

test('parser: jóváhagyás csak érvényes confirm_id-val, egyszer', () => {
  const p = R.createParser('codex');
  const item = (id, text) => ({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'kapumail', tool: 'update_settings', result: { content: [{ type: 'text', text }] }, status: 'completed' } });
  const ok = JSON.stringify({ needs_approval: true, confirm_id: CONFIRM });
  assert.deepStrictEqual(p.line(item('i1', ok)).filter((e) => e.type === 'confirm'), [{ type: 'confirm', id: CONFIRM }]);
  assert.deepStrictEqual(p.line(item('i2', ok)).filter((e) => e.type === 'confirm'), []);
  assert.deepStrictEqual(p.line(item('i3', JSON.stringify({ needs_approval: true, confirm_id: 'nem-uuid' }))).filter((e) => e.type === 'confirm'), []);
  assert.deepStrictEqual(p.line(item('i4', JSON.stringify({ needs_approval: false, confirm_id: CONFIRM.replace('9', '8') }))).filter((e) => e.type === 'confirm'), []);
  // más eszköz → általános állapotszöveg
  assert.deepStrictEqual(p.line({ type: 'item.started', item: { id: 'i5', type: 'mcp_tool_call', server: 'mas', tool: 'x' } }), [{ type: 'activity', text: 'Dolgozom rajta…' }]);
});

test('parser: webes keresés és irat_teendok_elemzese aktivitások mindhárom motornál', () => {
  // Claude WebSearch
  const pClaude = R.createParser('claude');
  const ev1 = pClaude.line({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_ws', name: 'WebSearch' }] },
  });
  assert.deepStrictEqual(ev1, [{ type: 'activity', text: 'Keresek a hivatalos oldalakon…' }]);

  // Claude irat_teendok_elemzese
  const ev2 = pClaude.line({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_ite', name: 'mcp__kapumail__irat_teendok_elemzese' }] },
  });
  assert.deepStrictEqual(ev2, [{ type: 'activity', text: 'Elemzem az irat teendőit…' }]);

  // Codex web_search
  const pCodex = R.createParser('codex');
  const ev3 = pCodex.line({
    type: 'item.started',
    item: { id: 'ws_1', type: 'web_search' },
  });
  assert.deepStrictEqual(ev3, [{ type: 'activity', text: 'Keresek a hivatalos oldalakon…' }]);

  // Codex irat_teendok_elemzese
  const ev4 = pCodex.line({
    type: 'item.started',
    item: { id: 'ite_1', type: 'mcp_tool_call', server: 'kapumail', tool: 'irat_teendok_elemzese' },
  });
  assert.deepStrictEqual(ev4, [{ type: 'activity', text: 'Elemzem az irat teendőit…' }]);

  // Antigravity search_web
  const pAgy = R.createParser('agy');
  const ev5 = pAgy.line({
    event: 'step_update',
    step_update: { step_type: 'tool', tool_name: 'search_web', step_index: 0 },
  });
  assert.deepStrictEqual(ev5, [{ type: 'activity', text: 'Keresek a hivatalos oldalakon…' }]);

  // Antigravity irat_teendok_elemzese
  const ev6 = pAgy.line({
    event: 'step_update',
    step_update: {
      step_type: 'tool',
      tool_name: 'call_mcp_tool',
      step_index: 1,
      tool_info: { parameters: { ServerName: 'kapumail', ToolName: 'irat_teendok_elemzese' } },
    },
  });
  assert.deepStrictEqual(ev6, [{ type: 'activity', text: 'Elemzem az irat teendőit…' }]);
});

test('parser: resolve_code, resolve_tax_code és list_taxpayer_tables aktivitások', () => {
  assert.strictEqual(R.activityFor('resolve_code'), 'Feloldom a nyomtatvány- vagy adókódot…');
  assert.strictEqual(R.activityFor('resolve_tax_code'), 'Feloldom a nyomtatvány- vagy adókódot…');
  assert.strictEqual(R.activityFor('list_taxpayer_tables'), 'Megnézem az adózói táblákat…');

  const pCodex = R.createParser('codex');
  const ev1 = pCodex.line({
    type: 'item.started',
    item: { id: 'rc_1', type: 'mcp_tool_call', server: 'kapumail', tool: 'resolve_code' },
  });
  assert.deepStrictEqual(ev1, [{ type: 'activity', text: 'Feloldom a nyomtatvány- vagy adókódot…' }]);

  const ev2 = pCodex.line({
    type: 'item.started',
    item: { id: 'ltt_1', type: 'mcp_tool_call', server: 'kapumail', tool: 'list_taxpayer_tables' },
  });
  assert.deepStrictEqual(ev2, [{ type: 'activity', text: 'Megnézem az adózói táblákat…' }]);

  const ev3 = pCodex.line({
    type: 'item.started',
    item: { id: 'rtc_1', type: 'mcp_tool_call', server: 'kapumail', tool: 'resolve_tax_code' },
  });
  assert.deepStrictEqual(ev3, [{ type: 'activity', text: 'Feloldom a nyomtatvány- vagy adókódot…' }]);
});

test('prepare claude: a megszakítás leállítja a belépés frissítését', async () => {
  const ac = new AbortController();
  let aborted = false;
  const renew = ({ signal }) => new Promise((resolve) => { signal.addEventListener('abort', () => { aborted = true; resolve(); }); });
  const kc = async (service) => (service.startsWith('Claude') ? claudeLogin(Date.now() + 1000) : null);
  const pr = prep('claude', { readKeychain: kc, renewClaude: renew, signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(pr, (e) => e.code === 'failed');
  assert.ok(aborted);
});

test('run: a Claude-belépés frissítése is a 150 mp-es korláton belül számít, és cancel leállítja', async () => {
  const kc = async (service) => (service.startsWith('Claude') ? claudeLogin(Date.now() + 1000) : null);
  let renewSignal;
  const renew = ({ signal }) => new Promise((resolve) => { renewSignal = signal; signal.addEventListener('abort', resolve); });
  const userData = tmp();
  const events = [];
  const t0 = Date.now();
  await new Promise((resolve) => R.startRun({
    engine: 'claude', message: 'Szia', conv: { userData, mcp: HTTP }, bin: path.join(FAKE, 'claude'), readKeychain: kc, renewClaude: renew, timeoutMs: 300,
    onEvent: (e) => { events.push(e); resolve(); },
  }));
  assert.deepStrictEqual(events.map((e) => e.code), ['timeout']);
  assert.ok(Date.now() - t0 < 1500);
  assert.ok(renewSignal.aborted);
  // cancel a frissítés alatt
  let sig2;
  const h = R.startRun({ engine: 'claude', message: 'Szia', conv: { userData, mcp: HTTP }, bin: path.join(FAKE, 'claude'), readKeychain: kc,
    renewClaude: ({ signal }) => new Promise((resolve) => { sig2 = signal; signal.addEventListener('abort', resolve); }), onEvent: (e) => events.push(e) });
  await sleep(50);
  h.cancel();
  await sleep(50);
  assert.ok(sig2 && sig2.aborted);
  assert.deepStrictEqual(leftovers(userData), []);
});

test('run: azonnali cancel (még a felkészülés alatt) sem hagy tokenes fájlt (codex)', async () => {
  const userData = tmp();
  const events = [];
  const h = R.startRun({
    engine: 'codex', message: 'Szia', conv: { userData, mcp: HTTP }, bin: path.join(FAKE, 'codex'), sourceHome: fakeHome(),
    env: { ...process.env, FAKE_AI_STATE: JSON.stringify({ fixture: path.join(FIX, 'codex-turn.jsonl'), hangAfter: true }) },
    onEvent: (e) => events.push(e),
  });
  h.cancel();
  await sleep(300);
  assert.strictEqual(h.pid, undefined);
  assert.deepStrictEqual(events, []);
  const root = path.join(userData, 'kapu', 'cli', 'codex');
  const homes = fs.existsSync(root) ? fs.readdirSync(root) : [];
  assert.ok(homes.every((n) => !fs.existsSync(path.join(root, n, 'auth.json'))), 'nem maradt belépés-másolat');
  assert.deepStrictEqual(homes, []);
});

test('run: egyszerre csak egy codex-kör tart belépés-másolatot (a második vár)', async () => {
  const { EventEmitter } = require('node:events');
  const children = [];
  const fakeSpawn = (bin, args, opts) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {};
    c.stderr = new EventEmitter();
    c.stdin = { on() {}, end(input) { c.input = input; } };
    c.exitCode = null; c.signalCode = null;
    c.kill = () => { c.exitCode = 1; setImmediate(() => c.emit('close', null)); };
    c.home = opts.env.CODEX_HOME;
    c.authAtSpawn = fs.existsSync(path.join(c.home, 'auth.json'));
    children.push(c);
    return c;
  };
  const finish = (c) => {
    c.stdout.emit('data', fs.readFileSync(path.join(FIX, 'codex-turn.jsonl'), 'utf8'));
    c.exitCode = 0;
    c.emit('close', 0);
  };
  const userData = tmp();
  const home = fakeHome();
  const ends = [];
  const start = (msg) => new Promise((resolve) => R.startRun({
    engine: 'codex', message: msg, conv: { userData, mcp: HTTP }, bin: '/x/codex', spawn: fakeSpawn, sourceHome: home,
    onEvent: (e) => { if (e.type === 'final' || e.type === 'error') { ends.push(msg); resolve(e); } },
  }));
  const runs = { egy: start('egy'), 'kettő': start('kettő') };
  await sleep(150);
  assert.strictEqual(children.length, 1, 'a második kör még vár');
  assert.ok(children[0].authAtSpawn);
  // amelyik előbb megkapta a zárat, az fut; a sorrend nem számít
  const first = /egy$/.test(children[0].input) ? 'egy' : 'kettő';
  const second = first === 'egy' ? 'kettő' : 'egy';
  finish(children[0]);
  assert.strictEqual((await runs[first]).type, 'final');
  for (let i = 0; i < 50 && children.length < 2; i++) await sleep(10);
  assert.strictEqual(children.length, 2);
  assert.ok(!fs.existsSync(path.join(children[0].home, 'auth.json'))); // az első másolata már törölve
  assert.ok(children[1].authAtSpawn);
  finish(children[1]);
  assert.strictEqual((await runs[second]).type, 'final');
  assert.deepStrictEqual(ends, [first, second]);
});
