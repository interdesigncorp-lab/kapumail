'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const I = require('../kapu/installer');
const P = require('../kapu/providers');
const none = () => null;

// Hamis spawn: rögzíti a hívást, és a megadott kóddal „lép ki”; a siker előtt létrehozhatja a binárist.
function fakeSpawn({ code = 0, out = '', onRun } = {}) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = () => {};
    setImmediate(() => {
      if (out) c.stdout.emit('data', out);
      if (onRun) onRun();
      if (code !== 'hang') c.emit('close', code);
    });
    return c;
  };
  return { spawn, calls };
}

test('installCommand: csak a hivatalos címek, macOS-en curl|shell, Windowson PowerShell', () => {
  const mac = I.installCommand('claude', { platform: 'darwin' });
  assert.strictEqual(mac.bin, '/bin/bash');
  assert.match(mac.args[1], /curl -fsSL --proto '=https' --tlsv1\.2 https:\/\/claude\.ai\/install\.sh \| bash$/);
  assert.match(I.installCommand('codex', { platform: 'darwin' }).args[1], /https:\/\/chatgpt\.com\/codex\/install\.sh \| sh$/);
  assert.match(I.installCommand('agy', { platform: 'darwin' }).args[1], /https:\/\/antigravity\.google\/cli\/install\.sh \| bash$/);
  const win = I.installCommand('codex', { platform: 'win32', env: { SystemRoot: 'D:\\Win' } });
  assert.strictEqual(win.bin, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(win.args.includes('-NonInteractive'));
  assert.match(win.args[win.args.length - 1], /irm https:\/\/chatgpt\.com\/codex\/install\.ps1 \| iex$/);
  assert.throws(() => I.installCommand('rm -rf', { platform: 'darwin' }));
});

test('telepítés: siker, ha a végén megvan a bináris; API-kulcs nem jut a telepítőhöz', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-inst-'));
  const env = { HOME: home, PATH: '/nincs', ANTHROPIC_API_KEY: 'sk-titok' };
  const bin = path.join(home, '.local', 'bin', 'claude');
  const f = fakeSpawn({ onRun: () => { fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 }); } });
  const inst = I.createInstaller({ spawn: f.spawn, platform: 'darwin', env });
  const r = inst.start('claude');
  assert.deepStrictEqual(r, { ok: true, running: true, source: 'claude.ai' });
  assert.strictEqual(inst.state().running, true);
  // Közben ugyanarra újra: nem indul második; másikra: elutasítva.
  assert.strictEqual(inst.start('claude').running, true);
  assert.strictEqual(inst.start('codex').ok, false);
  const done = await inst.wait();
  assert.deepStrictEqual(done, { running: false, engine: 'claude', installed: true, source: 'claude.ai' });
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].opts.env.ANTHROPIC_API_KEY, undefined);
  assert.strictEqual(f.calls[0].opts.env.CODEX_NON_INTERACTIVE, '1');
  assert.deepStrictEqual(f.calls[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
});

test('telepítés: 0-s kilépés, de nincs bináris → hiba; hálózati hiba → érthető üzenet', async () => {
  const env = { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-inst-')), PATH: '/nincs' };
  const a = I.createInstaller({ spawn: fakeSpawn({ code: 0 }).spawn, platform: 'darwin', env, resolveBin: none });
  a.start('agy');
  const ra = await a.wait();
  assert.strictEqual(ra.installed, false);
  assert.match(ra.error, /Antigravity telepítése nem sikerült.*antigravity\.google/);
  const b = I.createInstaller({ spawn: fakeSpawn({ code: 6, out: 'curl: (6) Could not resolve host: chatgpt.com' }).spawn, platform: 'darwin', env, resolveBin: none });
  b.start('codex');
  assert.match((await b.wait()).error, /nem érte el a szolgáltatót/);
  // Hiba után újrapróbálható.
  assert.strictEqual(b.start('codex').ok, true);
  await b.wait();
});

test('telepítés: időkorlát és nem támogatott rendszer', async () => {
  const env = { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-inst-')), PATH: '/nincs' };
  const t = I.createInstaller({ spawn: fakeSpawn({ code: 'hang' }).spawn, platform: 'darwin', env, timeoutMs: 30, resolveBin: none });
  t.start('claude');
  assert.match((await t.wait()).error, /tíz perc alatt nem ért véget/);
  const l = I.createInstaller({ spawn: fakeSpawn().spawn, platform: 'linux', env });
  assert.strictEqual(l.start('claude').ok, false);
  assert.strictEqual(l.start('ismeretlen').ok, false);
});

test('resolveBin: Windowson a Codex és az agy hivatalos telepítési mappája', () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-la-'));
  const cdir = path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin');
  const adir = path.join(local, 'agy', 'bin');
  fs.mkdirSync(cdir, { recursive: true });
  fs.mkdirSync(adir, { recursive: true });
  fs.writeFileSync(path.join(cdir, 'codex.exe'), '');
  fs.writeFileSync(path.join(adir, 'agy.exe'), '');
  const env = { PATH: '', USERPROFILE: '/nincs', LOCALAPPDATA: local };
  assert.strictEqual(P.resolveBin('codex', env, 'win32'), path.join(cdir, 'codex.exe'));
  assert.strictEqual(P.resolveBin('agy', env, 'win32'), path.join(adir, 'agy.exe'));
});
