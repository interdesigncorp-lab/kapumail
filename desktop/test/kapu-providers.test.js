'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const P = require('../kapu/providers');

const FAKE = path.join(__dirname, 'fake-ai-cli');
const st = (engine, state, extra = {}) => P.status(engine, { bin: path.join(FAKE, engine), env: { ...process.env, FAKE_AI_STATE: JSON.stringify(state) }, timeoutMs: 2000, ...extra });

test('motorok és feliratok', () => {
  assert.deepStrictEqual(P.ENGINES, ['claude', 'codex', 'agy']);
  assert.deepStrictEqual(P.ENGINE_LABEL, { claude: 'Claude', codex: 'ChatGPT', agy: 'Antigravity' });
  assert.strictEqual(P.signInCommand('claude'), 'claude auth login');
  assert.strictEqual(P.signInCommand('codex'), 'codex login');
  assert.strictEqual(P.signInCommand('agy'), 'agy');
});

test('status: nincs telepítve', async () => {
  for (const e of P.ENGINES) {
    const r = await P.status(e, { bin: '/nincs/ilyen/' + e, timeoutMs: 2000 });
    assert.deepStrictEqual(r, { engine: e, installed: false, signedIn: false });
  }
  const m = await st('claude', { missing: true });
  assert.strictEqual(m.installed, false);
});

test('status: claude bejelentkezve, előfizetés típusa', async () => {
  const r = await st('claude', { loggedIn: true, plan: 'max' });
  assert.deepStrictEqual(r, { engine: 'claude', installed: true, signedIn: true, account: 'max' });
  const o = await st('claude', { loggedIn: false });
  assert.deepStrictEqual(o, { engine: 'claude', installed: true, signedIn: false });
});

test('status: codex nem ChatGPT-vel lépett be → signedIn:false', async () => {
  const ok = await st('codex', { loggedIn: true });
  assert.deepStrictEqual(ok, { engine: 'codex', installed: true, signedIn: true, account: 'ChatGPT' });
  const key = await st('codex', { loggedIn: true, lines: ['Logged in using an API key - sk-...abcd'] });
  assert.strictEqual(key.signedIn, false);
  assert.ok(key.error);
  assert.ok(!JSON.stringify(key).includes('abcd'));
  const out = await st('codex', { loggedIn: false });
  assert.strictEqual(out.signedIn, false);
});

test('status: agy modell-lista üres → signedIn:false', async () => {
  const ok = await st('agy', { loggedIn: true, lines: ['gemini-4\tGemini 4'] });
  assert.deepStrictEqual(ok, { engine: 'agy', installed: true, signedIn: true, models: ['gemini-4'] });
  const empty = await st('agy', { loggedIn: true, lines: [] });
  assert.strictEqual(empty.signedIn, false);
  assert.strictEqual(empty.installed, true);
  // Kilépve a valódi agy hibakóddal és stderr-figyelmeztetéssel áll le: ez „nincs bejelentkezve”, nem olvashatatlan állapot.
  const out = await st('agy', { loggedIn: false, realSignedOut: true });
  assert.deepStrictEqual(out, { engine: 'agy', installed: true, signedIn: false });
});

test('status: lógó CLI a korlát után hibát ad', async () => {
  const t0 = Date.now();
  const r = await st('claude', { hang: true }, { timeoutMs: 200 });
  assert.strictEqual(r.installed, true);
  assert.strictEqual(r.signedIn, false);
  assert.ok(r.error);
  assert.ok(Date.now() - t0 < 1500);
});

test('status: ismeretlen motor', async () => {
  await assert.rejects(() => P.status('gemini', {}));
});

test('cleanEnv törli az API-kulcsokat', () => {
  const src = { PATH: '/bin', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b', GEMINI_API_KEY: 'c', GOOGLE_API_KEY: 'd', GOOGLE_GENAI_API_KEY: 'e', HOME: '/h' };
  assert.deepStrictEqual(P.cleanEnv(src), { PATH: '/bin', HOME: '/h' });
  assert.strictEqual(src.OPENAI_API_KEY, 'b'); // az eredetit nem bántja
  // átjáró, felhő és idegen állapotmappa sem
  const route = { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://gw', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', OPENAI_BASE_URL: 'https://gw', CODEX_HOME: '/c' };
  assert.deepStrictEqual(P.cleanEnv(route), { PATH: '/bin' });
  assert.deepStrictEqual(P.cleanEnv({ codex_home: '/c', Path: 'x' }, 'win32'), { Path: 'x' });
});

test('status: az API-kulcsok nem jutnak a CLI-hez', async () => {
  let seen;
  const spawn = (bin, args, opts) => { seen = opts; const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {}; setImmediate(() => p.emit('close', 0)); return p; };
  await P.status('claude', { bin: '/x/claude', env: { ANTHROPIC_API_KEY: 'k', PATH: '/bin' }, spawn });
  assert.ok(!('ANTHROPIC_API_KEY' in seen.env));
  assert.ok(!seen.shell);
});

test('resolveBin: PATH és a megszokott mappák', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-bin-'));
  fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  assert.strictEqual(P.resolveBin('codex', { PATH: dir }), path.join(dir, 'codex'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-home-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  assert.strictEqual(P.resolveBin('claude', { PATH: '/nincs', HOME: home }), path.join(home, '.local', 'bin', 'claude'));
});

function fakeSpawn(calls, code = 0) {
  return (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {}; p.unref = () => {};
    setImmediate(() => p.emit('close', code));
    return p;
  };
}

test('openSignIn megírja a .command fájlt (macOS)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-in-'));
  const calls = [];
  const r = await P.openSignIn('claude', { dir, platform: 'darwin', spawn: fakeSpawn(calls), bin: '/x/claude' });
  assert.strictEqual(r.file, path.join(dir, 'claude-sign-in.command'));
  const body = fs.readFileSync(r.file, 'utf8');
  assert.ok(body.startsWith('#!/bin/zsh -l\n'));
  assert.ok(/'\/x\/claude' 'auth' 'login'\n$/.test(body), body);
  assert.ok(body.includes('unset ANTHROPIC_API_KEY'));
  assert.strictEqual(fs.statSync(r.file).mode & 0o777, 0o700);
  assert.deepStrictEqual(calls.map((c) => [c.bin, c.args]), [['open', ['-a', 'Terminal', r.file]]]);
});

test('openSignIn: codex és agy parancsa, rossz motor hiba', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-in-'));
    const c = await P.openSignIn('codex', { dir, platform: 'darwin', spawn: fakeSpawn([]), bin: 'codex' });
  assert.ok(/'codex' 'login'\n$/.test(fs.readFileSync(c.file, 'utf8')));
  const a = await P.openSignIn('agy', { dir, platform: 'darwin', spawn: fakeSpawn([]), bin: 'agy' });
  assert.ok(/'agy'\n$/.test(fs.readFileSync(a.file, 'utf8')));
  await assert.rejects(() => P.openSignIn('gemini', { dir, platform: 'darwin', spawn: fakeSpawn([]) }));
});

test('openSignIn: az open hibája hibát ad', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-in-'));
  await assert.rejects(() => P.openSignIn('claude', { dir, platform: 'darwin', spawn: fakeSpawn([], 1), bin: '/x/claude' }));
});

test('openSignIn: Windowson .cmd fájl és cmd /c start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-in-'));
  const calls = [];
  const r = await P.openSignIn('codex', { dir, platform: 'win32', spawn: fakeSpawn(calls), bin: 'codex' });
  assert.strictEqual(r.file, path.join(dir, 'codex-sign-in.cmd'));
  const body = fs.readFileSync(r.file, 'utf8');
  assert.ok(body.includes('\r\ncall codex login\r\n'), body);
  assert.ok(body.includes('pause'));
  assert.deepStrictEqual(calls[0].bin, 'cmd.exe');
  assert.deepStrictEqual(calls[0].args, ['/d', '/c', 'start', '', '.\\codex-sign-in.cmd']);
  assert.strictEqual(calls[0].opts.cwd, dir);
});

test('openSignIn: más rendszeren hiba', async () => {
  await assert.rejects(() => P.openSignIn('claude', { dir: os.tmpdir(), platform: 'linux', spawn: fakeSpawn([]) }));
});

test('cleanEnv Windowson a kulcsneveket kis-nagybetű nélkül veti össze', () => {
  const src = { Path: 'x', Anthropic_Api_Key: 'a', openai_api_key: 'b' };
  assert.deepStrictEqual(P.cleanEnv(src, 'win32'), { Path: 'x' });
  assert.deepStrictEqual(P.cleanEnv({ Anthropic_Api_Key: 'a' }, 'darwin'), { Anthropic_Api_Key: 'a' });
});

test('status: Windowson a .cmd indítófájl cmd.exe /c call-lal megy', async () => {
  const calls = [];
  const r = await P.status('claude', { bin: 'C:\\Users\\Ági\\AppData\\Roaming\\npm\\claude.cmd', platform: 'win32', spawn: fakeSpawn(calls) });
  assert.strictEqual(r.installed, true);
  assert.strictEqual(calls[0].bin, 'cmd.exe');
  assert.deepStrictEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c']);
  assert.ok(calls[0].args[3].startsWith('"call "C:\\Users'), calls[0].args[3]);
  assert.ok(calls[0].args[3].endsWith('claude.cmd" auth status --json"'));
  assert.strictEqual(calls[0].opts.windowsVerbatimArguments, true);
  const exe = [];
  await P.status('claude', { bin: 'C:\\x\\claude.exe', platform: 'win32', spawn: fakeSpawn(exe) });
  assert.strictEqual(exe[0].bin, 'C:\\x\\claude.exe');
});

test('status: .cmd útvonal %-jellel nem indul, a hiba nem dob', async () => {
  const calls = [];
  const r = await P.status('claude', { bin: 'C:\\100%\\claude.cmd', platform: 'win32', spawn: fakeSpawn(calls) });
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(r.installed, true);
  assert.ok(r.error);
});

test('openSignIn Windowson: chcp 65001, szóközös útvonal idézve, %-os elutasítva', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-in-'));
  const r = await P.openSignIn('codex', { dir, platform: 'win32', spawn: fakeSpawn([]), bin: 'C:\\Program Files\\codex.cmd' });
  const body = fs.readFileSync(r.file, 'utf8');
  assert.ok(body.startsWith('@echo off\r\nchcp 65001 >nul\r\n'), body);
  assert.ok(body.includes('call "C:\\Program Files\\codex.cmd" login'));
  await assert.rejects(() => P.openSignIn('codex', { dir, platform: 'win32', spawn: fakeSpawn([]), bin: 'C:\\100%\\codex.cmd' }));
});

test('fetchModels: Claude friss helyi cache-ből hálózat nélkül olvas, force esetén frissít, offline-nál visszaesik', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-claude-cat-'));
  const cacheDir = path.join(home, '.claude', 'cache', 'model-catalog');
  fs.mkdirSync(cacheDir, { recursive: true });
  const nowMs = Date.now();
  fs.writeFileSync(path.join(cacheDir, 'tok-cc.json'), JSON.stringify({
    version: 2,
    staleAt: nowMs + 60000,
    catalog: { config: { models: [{ id: 'claude-haiku-5-5', section: 'main' }, { id: 'claude-fable-5-2', section: 'main' }] } },
  }));
  let netCalls = 0;
  const cached = await P.fetchModels('claude', {
    env: { HOME: home }, platform: 'darwin', now: () => nowMs,
    fetchImpl: async () => { netCalls++; throw new Error('nem kellene hívni'); },
  });
  assert.strictEqual(netCalls, 0);
  assert.deepStrictEqual(cached, ['claude-haiku-5-5', 'claude-fable-5-2']);

  // force: true (összekötéskor) lekéri a friss katalógust
  const forced = await P.fetchModels('claude', {
    env: { HOME: home }, platform: 'darwin', force: true, now: () => nowMs,
    fetchImpl: async () => {
      netCalls++;
      return { ok: true, text: async () => JSON.stringify({ surfaces: { cc: { model_selector_config: [{ id: 'cc', models: [{ id: 'claude-fable-5-3', section: 'main' }] }] } } }) };
    },
  });
  assert.strictEqual(netCalls, 1);
  assert.deepStrictEqual(forced, ['claude-fable-5-3']);

  // Ha nincs hálózat, a helyi cache-re esik vissza
  const fallback = await P.fetchModels('claude', {
    env: { HOME: home }, platform: 'darwin', force: true, now: () => nowMs,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.deepStrictEqual(fallback, ['claude-haiku-5-5', 'claude-fable-5-2']);
});

test('fetchModels: Codex a debug models kimenetét olvassa API-kulcsok nélkül', async () => {
  let seenEnv;
  const spawn = (bin, args, opts) => {
    seenEnv = opts.env;
    assert.deepStrictEqual(args, ['debug', 'models']);
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
    setImmediate(() => {
      p.stdout.emit('data', JSON.stringify({ models: [{ slug: 'gpt-6-luna', visibility: 'list', supported_in_api: true }, { slug: 'gpt-reserve', visibility: 'hide' }] }));
      p.emit('close', 0);
    });
    return p;
  };
  const ids = await P.fetchModels('codex', { bin: '/x/codex', env: { PATH: '/bin', OPENAI_API_KEY: 'titok' }, platform: 'darwin', spawn });
  assert.ok(!('OPENAI_API_KEY' in seenEnv));
  assert.deepStrictEqual(ids, ['gpt-6-luna']);
});
