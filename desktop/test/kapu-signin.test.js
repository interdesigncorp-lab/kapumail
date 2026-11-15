'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const S = require('../kapu/signin');

// Hamis tmux: minden hívást feljegyez; a capture-pane a megadott képernyőt adja vissza.
function fakeTmux(pane = () => '', code = 0) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    calls.push({ bin, args, env: opts && opts.env });
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.kill = () => {};
    setImmediate(() => {
      if (args.includes('capture-pane')) c.stdout.emit('data', pane());
      c.emit('close', typeof code === 'function' ? code(args) : code);
    });
    return c;
  };
  return { calls, spawn };
}

const CLAUDE_PANE = `Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz
Paste code here if prompted >`;
const AGY_MENU = ` Welcome to the Antigravity CLI. You are currently not signed in.
 Select login method:
 > 1. Google OAuth`;
const AGY_URL = ` Your browser should open automatically. If not:
 https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071
 L-x9Tw&code_challenge_method=S256&state=Olf5
 If you aren't automatically redirected, paste the authorization code below:
 authorization code...`;

test('parsePane: Claude URL és kódkérés', () => {
  const p = S.parsePane('claude', CLAUDE_PANE);
  assert.strictEqual(p.url, 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz');
  assert.strictEqual(p.needsCode, true);
  assert.strictEqual(p.menu, false);
});

test('parsePane: Antigravity tördelt URL összefűzve, menü felismerve', () => {
  assert.strictEqual(S.parsePane('agy', AGY_MENU).menu, true);
  const p = S.parsePane('agy', AGY_URL);
  assert.strictEqual(p.url, 'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071L-x9Tw&code_challenge_method=S256&state=Olf5');
  assert.strictEqual(p.needsCode, true);
});

test('parsePane: idegen host URL-je nem jön át', () => {
  assert.strictEqual(S.parsePane('codex', 'visit https://evil.example/oauth?x=1').url, '');
  assert.strictEqual(S.parsePane('codex', 'navigate: https://auth.openai.com/oauth/authorize?a=1').url, 'https://auth.openai.com/oauth/authorize?a=1');
  assert.strictEqual(S.okUrl('claude', 'http://claude.com/x'), false);
});

test('start: saját socket, rejtett munkamenet, API-kulcsok nélkül; régi munkamenet előbb leáll', async () => {
  const t = fakeTmux();
  const h = S.create({ tmux: '/opt/homebrew/bin/tmux', spawn: t.spawn, env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-x' }, bin: () => '/u/claude', platform: 'darwin' });
  assert.deepStrictEqual(await h.start('claude'), { ok: true });
  assert.deepStrictEqual(t.calls[0].args, ['-L', 'kapumail', 'kill-session', '-t', 'kapu-signin']);
  const ns = t.calls[1];
  assert.deepStrictEqual(ns.args.slice(0, 5), ['-L', 'kapumail', 'new-session', '-d', '-s']);
  const cmd = ns.args.at(-1);
  assert.match(cmd, /^'env' '-u' 'ANTHROPIC_API_KEY'/);
  assert.match(cmd, /'\/u\/claude' 'auth' 'login'$/);
  assert.strictEqual(ns.env.ANTHROPIC_API_KEY, undefined);
});

test('start: tmux nélkül és Windowson nem érhető el; ismeretlen motor hiba; hiányzó parancs hiba', async () => {
  const t = fakeTmux();
  assert.deepStrictEqual(await S.create({ tmux: null, spawn: t.spawn }).start('claude'), { ok: false, unavailable: true });
  assert.deepStrictEqual(await S.create({ tmux: '/x/tmux', spawn: t.spawn, platform: 'win32' }).start('claude'), { ok: false, unavailable: true });
  await assert.rejects(() => S.create({ tmux: '/x/tmux', spawn: t.spawn, platform: 'darwin' }).start('gemini'));
  const r = await S.create({ tmux: '/x/tmux', spawn: t.spawn, platform: 'darwin', bin: () => null }).start('codex');
  assert.match(r.error, /ChatGPT nincs telepítve/);
});

test('state: Antigravity menüjében egyszer Entert küld, utána az URL-t adja', async () => {
  let pane = AGY_MENU;
  const t = fakeTmux(() => pane);
  const h = S.create({ tmux: '/x/tmux', spawn: t.spawn, env: {}, bin: () => '/u/agy', platform: 'darwin' });
  await h.start('agy');
  await h.state();
  await h.state();
  assert.strictEqual(t.calls.filter((c) => c.args.includes('send-keys')).length, 1);
  pane = AGY_URL;
  const s = await h.state();
  assert.strictEqual(s.running, true);
  assert.match(s.url, /^https:\/\/accounts\.google\.com\//);
  assert.strictEqual(h.okUrl(s.url), true);
});

test('state: kilépett munkamenet → running:false; kód begépelése ellenőrzéssel', async () => {
  const t = fakeTmux(() => CLAUDE_PANE, (args) => (args.includes('capture-pane') ? 1 : 0));
  const h = S.create({ tmux: '/x/tmux', spawn: t.spawn, env: {}, bin: () => '/u/claude', platform: 'darwin' });
  assert.deepStrictEqual(await h.code('abcd'), { ok: false, error: 'Nincs folyamatban belépés.' });
  await h.start('claude');
  assert.deepStrictEqual(await h.code('rossz kód; rm -rf'), { ok: false, error: 'Ez nem tűnik belépési kódnak.' });
  assert.deepStrictEqual(await h.code('AbCd123#state_x-y'), { ok: true });
  const sent = t.calls.filter((c) => c.args.includes('send-keys'));
  assert.deepStrictEqual(sent[0].args.slice(-2), ['-l', 'AbCd123#state_x-y']);
  assert.deepStrictEqual(sent[1].args.slice(-1), ['Enter']);
  assert.deepStrictEqual(await h.state(), { running: false });
  assert.strictEqual(h.okUrl('https://claude.com/x'), false);
});
