'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('../kapu/store');
const { createKapu, scopeKey, tokenRef } = require('../kapu');

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-store-'));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// Hamis titkosítás a safeStorage helyett: visszafordítható, de a nyílt szöveg nem látszik a fájlban.
const KEY = 0x5a;
const encrypt = (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ KEY));
const decrypt = (b) => Buffer.from(b.map((x) => x ^ KEY)).toString('utf8');

test('store: titkosítva ír, visszaolvas', () => {
  const dir = path.join(tmp(), 'kapu', '3-7');
  const s = createStore({ dir, encrypt, decrypt });
  const id = s.create('claude');
  s.append(id, { role: 'user', text: 'Mi a határidő a Kovács-ügyben?' });
  s.append(id, { role: 'kapu', text: 'Péntek.', confirmId: 'abc' });
  s.setSession(id, '11111111-2222-4333-8444-555555555555');
  const files = fs.readdirSync(dir);
  assert.deepStrictEqual(files, [`${id}.bin`]);
  const raw = fs.readFileSync(path.join(dir, files[0]));
  assert.ok(!raw.toString('utf8').includes('Kovács'), 'a fájlban nem lehet nyílt szöveg');
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600);
  const again = createStore({ dir, encrypt, decrypt }).get(id);
  assert.strictEqual(again.engine, 'claude');
  assert.strictEqual(again.sessionId, '11111111-2222-4333-8444-555555555555');
  assert.deepStrictEqual(again.messages.map((m) => [m.role, m.text, m.confirmId]), [['user', 'Mi a határidő a Kovács-ügyben?', undefined], ['kapu', 'Péntek.', 'abc']]);
  assert.ok(again.messages.every((m) => typeof m.at === 'number'));
  const [row] = s.list();
  assert.deepStrictEqual(Object.keys(row).sort(), ['engine', 'id', 'model', 'title', 'updatedAt']);
});

test('store: felhasználónként külön', () => {
  const base = path.join(tmp(), 'kapu');
  const a = createStore({ dir: path.join(base, '1-1'), encrypt, decrypt });
  const b = createStore({ dir: path.join(base, '1-2'), encrypt, decrypt });
  const id = a.create('codex');
  a.append(id, { role: 'user', text: 'Szia' });
  assert.strictEqual(a.list().length, 1);
  assert.deepStrictEqual(b.list(), []);
  assert.strictEqual(b.get(id), null);
  assert.throws(() => b.append(id, { role: 'user', text: 'x' }));
});

test('store: cím az első kérdésből', () => {
  const s = createStore({ dir: path.join(tmp(), 'kapu', '2-5'), encrypt, decrypt });
  const id = s.create('agy');
  assert.strictEqual(s.get(id).title, '');
  const long = '  Kérlek,   nézd meg\naz összes ' + 'nagyon '.repeat(20) + 'fontos iratot';
  s.append(id, { role: 'user', text: long });
  s.append(id, { role: 'user', text: 'Második kérdés' });
  const title = s.get(id).title;
  assert.strictEqual(title.length, 60);
  assert.ok(title.startsWith('Kérlek, nézd meg az összes nagyon'));
  assert.strictEqual(s.list()[0].title, title);
});

test('store: clear mindent töröl', () => {
  const dir = path.join(tmp(), 'kapu', '4-4');
  const s = createStore({ dir, encrypt, decrypt });
  const ids = [s.create('claude'), s.create('codex')];
  for (const id of ids) s.append(id, { role: 'user', text: 'kérdés ' + id });
  assert.strictEqual(s.list().length, 2);
  const removed = s.clear();
  assert.deepStrictEqual(removed.map((c) => c.id).sort(), [...ids].sort());
  assert.deepStrictEqual(s.list(), []);
  assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0);
});

test('store: hibás azonosító és szerep elutasítva, sérült fájl kimarad', () => {
  const dir = path.join(tmp(), 'kapu', '5-5');
  const s = createStore({ dir, encrypt, decrypt });
  assert.strictEqual(s.get('../../config'), null);
  assert.strictEqual(s.remove('../x'), null);
  const id = s.create('claude');
  assert.throws(() => s.append(id, { role: 'admin', text: 'x' }));
  assert.throws(() => s.append(id, { role: 'user', text: '' }));
  assert.throws(() => s.create('gpt'));
  fs.writeFileSync(path.join(dir, 'f'.repeat(32) + '.bin'), 'szemét');
  assert.deepStrictEqual(s.list().map((c) => c.id), [id]);
});

// ---- index.js: a modulok összefogása hamis futtatóval és hamis szerverrel ----

function fakeRunner() {
  const runs = [];
  const startRun = (opts) => {
    const r = { opts, cancelled: false, cancelOpts: undefined };
    runs.push(r);
    return { cancel(o) { r.cancelled = true; r.cancelOpts = o; } };
  };
  return { runs, startRun };
}

function makeKapu(over = {}) {
  const userData = tmp();
  const cfg = {};
  const vault = {};
  const events = [];
  const forgotten = [];
  const swept = [];
  const runner = fakeRunner();
  // A „szerver”: a felület munkamenetének felhasználója (GET /api/kapu/me). null = nincs bejelentkezve.
  const server = { me: { officeId: 3, userId: 9 }, calls: 0 };
  const k = createKapu({
    userData, encrypt, decrypt,
    readCfg: () => cfg, saveCfg: (p) => Object.assign(cfg, p),
    readSecret: (ref) => vault[ref] || null, writeSecret: (ref, v) => { vault[ref] = v; },
    mcpBase: () => ({ mode: 'stdio', php: 'php', artisan: '/app/artisan' }),
    resolveScope: async () => { server.calls++; if (!server.me) throw new Error('401'); return { ...server.me }; },
    emit: (ev) => events.push(ev),
    startRun: runner.startRun,
    isolation: { sweep: (u) => swept.push(u), forgetSession: (u, e, s) => forgotten.push([e, s]) },
    providers: { ENGINES: ['claude', 'codex', 'agy'], status: async (e) => ({ engine: e, installed: true, signedIn: e === 'claude' }), openSignIn: async () => ({ file: 'x' }), signInCommand: (e) => ({ bin: e, args: ['login'] }) },
    // Alapból nincs rejtett belépés (mintha nem lenne tmux): a tesztek nem indítanak valódi parancsot.
    hiddenSignIn: { start: async () => ({ ok: false, unavailable: true }), state: async () => ({ running: false }), code: async () => ({ ok: false }), stop: async () => ({ ok: true }), okUrl: () => false },
    ...over,
  });
  return { k, cfg, vault, events, forgotten, swept, runner, userData, server };
}

const SID = '11111111-2222-4333-8444-555555555555';
const ME = { officeId: 3, userId: 9 };
const TOK = 'kapu-token-0123456789';

async function ready(over) {
  const x = makeKapu(over);
  x.k.setConfig({ on: true, engine: 'claude' });
  await x.k.storeToken(TOK, ME);
  return x;
}

test('index: a hatókör a szervertől jön, gyorsítótárazva; konfig és token', async () => {
  const { k, cfg, vault, swept, userData, server } = makeKapu();
  k.start();
  assert.deepStrictEqual(swept, [userData]);
  assert.strictEqual(scopeKey(ME), '3-9');
  assert.strictEqual(tokenRef(ME), 'kapu:mcp-token:3-9');
  assert.throws(() => scopeKey({ officeId: 0, userId: 1 }));
  assert.throws(() => scopeKey({ officeId: '3', userId: 1.5 }));
  assert.deepStrictEqual(await k.scope(), ME);
  await k.list(); await k.list();
  assert.strictEqual(server.calls, 1);
  assert.deepStrictEqual(k.config(), { on: false, engine: null, readAloud: false, model: {} });
  assert.deepStrictEqual(k.setConfig({ on: true, engine: 'codex', readAloud: 1 }), { on: true, engine: 'codex', readAloud: false, model: {} });
  assert.throws(() => k.setConfig({ engine: 'gpt' }));
  assert.deepStrictEqual(cfg.kapu, { on: true, engine: 'codex', readAloud: false, model: {} });
  assert.strictEqual(await k.hasToken(), false);
  await assert.rejects(k.storeToken('rövid', ME));
  await k.storeToken(TOK, ME);
  assert.strictEqual(vault['kapu:mcp-token:3-9'], TOK);
  assert.strictEqual(await k.hasToken(), true);
  const st = await k.status();
  assert.deepStrictEqual(st.map((s) => [s.engine, s.signedIn]), [['claude', true], ['codex', false], ['agy', false]]);
});

test('index: más felhasználónak kiadott token elutasítva', async () => {
  const { k, vault } = makeKapu();
  await assert.rejects(k.storeToken(TOK, { officeId: 3, userId: 10 }), /nem ehhez a bejelentkezéshez/);
  await assert.rejects(k.storeToken(TOK, { officeId: 4, userId: 9 }), /nem ehhez a bejelentkezéshez/);
  await assert.rejects(k.storeToken(TOK), /nem ehhez a bejelentkezéshez/);
  assert.deepStrictEqual(vault, {});
});

test('index: hatókör nélkül (kijelentkezve) nincs lista és küldés', async () => {
  const { k, server, runner } = await ready();
  await k.list();
  server.me = null;
  k.resetScope();
  await assert.rejects(k.list(), /Nem vagy bejelentkezve/);
  await assert.rejects(k.send({ text: 'szia' }), /Nem vagy bejelentkezve/);
  await assert.rejects(k.get('a'.repeat(32)), /Nem vagy bejelentkezve/);
  assert.strictEqual(runner.runs.length, 0);
});

test('index: send elment, eseményt továbbít, a beszélgetésenkénti kör megszakít és lecserél', async () => {
  const { k, events, runner } = makeKapu();
  await assert.rejects(k.send({ text: 'szia' }), /Kapu/); // ki van kapcsolva
  k.setConfig({ on: true, engine: 'claude' });
  await assert.rejects(k.send({ text: 'szia' }), /token/i);
  await k.storeToken(TOK, ME);
  const { convId } = await k.send({ text: 'Mi újság?' });
  assert.strictEqual(runner.runs.length, 1);
  const o = runner.runs[0].opts;
  assert.strictEqual(o.engine, 'claude');
  assert.strictEqual(o.message, 'Mi újság?');
  assert.strictEqual(o.sessionId, undefined);
  assert.deepStrictEqual(o.conv.mcp, { mode: 'stdio', php: 'php', artisan: '/app/artisan', token: TOK });
  o.onEvent({ type: 'session', id: SID });
  o.onEvent({ type: 'activity', text: 'Keresem…' });
  o.onEvent({ type: 'confirm', id: 'c-1' });
  o.onEvent({ type: 'final', text: 'Minden rendben.' });
  assert.deepStrictEqual(events.map((e) => [e.type, e.convId]), [['session', convId], ['activity', convId], ['confirm', convId], ['final', convId]]);
  const c = await k.get(convId);
  assert.strictEqual(c.sessionId, SID);
  assert.deepStrictEqual(c.messages.map((m) => [m.role, m.text, m.confirmId]), [['user', 'Mi újság?', undefined], ['kapu', 'Minden rendben.', 'c-1']]);
  // Folytatás: a beszélgetés motorja és munkamenete marad, akkor is, ha közben motort váltott.
  k.setConfig({ engine: 'codex' });
  await k.send({ convId, text: 'És holnap?' });
  await k.send({ convId, text: 'Bocs, inkább jövő héten?' });
  assert.strictEqual(runner.runs.length, 3);
  assert.strictEqual(runner.runs[1].cancelled, true, 'az új kérdés előtt a futó kör leáll');
  assert.strictEqual(runner.runs[2].cancelled, false);
  assert.strictEqual(runner.runs[2].opts.engine, 'claude');
  assert.strictEqual(runner.runs[2].opts.sessionId, SID);
  // A leállított kör késői eseménye nem kerül sem a felületre, sem az előzményekbe.
  const before = events.length;
  runner.runs[1].opts.onEvent({ type: 'final', text: 'késő' });
  assert.strictEqual(events.length, before);
  runner.runs[2].opts.onEvent({ type: 'error', code: 'failed', text: 'Hiba történt.' });
  assert.deepStrictEqual((await k.get(convId)).messages.slice(-1).map((m) => [m.role, m.text]), [['system', 'Hiba történt.']]);
  assert.strictEqual((await k.list())[0].title, 'Mi újság?');
});

test('index: cancel, cancelAll (kilépéskor azonnali takarítással), remove és clear elfelejti a CLI munkamenetét', async () => {
  const { k, runner, forgotten } = await ready();
  const a = (await k.send({ text: 'első' })).convId;
  runner.runs[0].opts.onEvent({ type: 'session', id: SID });
  await k.cancel(a);
  assert.strictEqual(runner.runs[0].cancelled, true);
  const b = (await k.send({ text: 'második' })).convId;
  k.cancelAll({ cleanupNow: true });
  assert.strictEqual(runner.runs[1].cancelled, true);
  assert.deepStrictEqual(runner.runs[1].cancelOpts, { cleanupNow: true });
  await k.remove(a);
  assert.deepStrictEqual(forgotten, [['claude', SID]]);
  assert.strictEqual(await k.get(a), null);
  const c = (await k.send({ text: 'harmadik' })).convId;
  runner.runs[2].opts.onEvent({ type: 'session', id: '22222222-2222-4333-8444-555555555555' });
  await k.clear();
  assert.strictEqual(runner.runs[2].cancelled, true);
  assert.deepStrictEqual(forgotten.slice(1), [['claude', '22222222-2222-4333-8444-555555555555']]);
  assert.deepStrictEqual(await k.list(), []);
  assert.strictEqual(await k.get(b), null);
  assert.strictEqual(await k.get(c), null);
});

test('index: navigáció / másik felhasználó: a futó körök leállnak, a régi kör eseményei nem jutnak tovább', async () => {
  const { k, runner, events, server } = await ready();
  const { convId } = await k.send({ text: 'első' });
  await k.list(); // ugyanaz a felhasználó: nincs leállítás
  assert.strictEqual(runner.runs[0].cancelled, false);
  k.resetScope(); // pl. a belépőoldalra navigált
  assert.strictEqual(runner.runs[0].cancelled, true);
  server.me = { officeId: 3, userId: 10 };
  assert.deepStrictEqual(await k.list(), []); // a másik felhasználó előzményei
  runner.runs[0].opts.onEvent({ type: 'activity', text: 'Keresem…' });
  runner.runs[0].opts.onEvent({ type: 'final', text: 'régi válasz' });
  assert.deepStrictEqual(events, []);
  // Az új felhasználónál nincs token: küldés elutasítva, a régi tokenje nem használható.
  await assert.rejects(k.send({ text: 'szia' }), /token/i);
  // Visszaváltva a régi beszélgetésben nincs „régi válasz”.
  server.me = { ...ME };
  k.resetScope();
  assert.deepStrictEqual((await k.get(convId)).messages.map((m) => m.role), ['user']);
});

test('index: a lekérdezés közbeni navigáció nem állít be elavult hatókört', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const x = makeKapu({ resolveScope: async () => { await gate; return { ...ME }; } });
  const p = x.k.list();
  x.k.resetScope();
  release();
  await assert.rejects(p, /megváltozott/);
});

test('index: a belépés parancsa a valódi providers szöveges alakjával is visszajön', async () => {
  const real = require('../kapu/providers');
  const { k } = makeKapu({ providers: { ENGINES: real.ENGINES, status: async (e) => ({ engine: e, installed: true, signedIn: false }), openSignIn: async () => ({ file: 'x' }), signInCommand: real.signInCommand } });
  assert.deepStrictEqual(await k.signIn('claude'), { ok: true, command: 'claude auth login' });
  assert.deepStrictEqual(await k.signIn('agy'), { ok: true, command: 'agy' });
});

test('index: rejtett belépés, ha elérhető; Terminál csak tmux nélkül; a rejtett hiba nem nyit Terminált', async () => {
  const real = require('../kapu/providers');
  const calls = [];
  const opened = [];
  const hidden = { start: async (e) => { calls.push(['start', e]); return e === 'codex' ? { ok: false, error: 'A belépés nem indult el.' } : { ok: true }; },
    state: async () => ({ running: true, engine: 'claude', url: 'https://claude.com/x', needsCode: false }), code: async (c) => ({ ok: c === 'abcd#1' }), stop: async () => { calls.push(['stop']); return { ok: true }; }, okUrl: (u) => u.startsWith('https://claude.com/') };
  const { k } = makeKapu({ hiddenSignIn: hidden, providers: { ENGINES: real.ENGINES, status: async () => ({}), openSignIn: async (e) => { opened.push(e); return {}; }, signInCommand: real.signInCommand } });
  assert.deepStrictEqual(await k.signIn('claude'), { ok: true, command: 'claude auth login', hidden: true });
  assert.deepStrictEqual(await k.signIn('codex'), { ok: false, command: 'codex login', error: 'A belépés nem indult el.' });
  assert.deepStrictEqual(opened, []);
  assert.strictEqual((await k.signInState()).url, 'https://claude.com/x');
  assert.deepStrictEqual(await k.signInCode('abcd#1'), { ok: true });
  assert.strictEqual(k.signInUrlOk('https://evil.example/'), false);
  await k.cancelSignIn();
  assert.deepStrictEqual(calls.at(-1), ['stop']);
});

test('index: a Kapu kikapcsolása törli a gépen tárolt Kapu-tokent; újra bekapcsolva új kell', async () => {
  const deleted = [];
  let vault = null;
  const x = makeKapu({ deleteSecret: (ref) => { deleted.push(ref); delete vault[ref]; } });
  vault = x.vault;
  x.k.setConfig({ on: true, engine: 'claude' });
  await x.k.storeToken(TOK, ME);
  assert.strictEqual(await x.k.hasToken(), true);
  x.k.setConfig({ engine: 'codex' }); // nem kikapcsolás: a token marad
  assert.deepStrictEqual(deleted, []);
  x.k.setConfig({ on: false });
  assert.deepStrictEqual(deleted, ['kapu:mcp-token:3-9']);
  assert.strictEqual(vault['kapu:mcp-token:3-9'], undefined);
  assert.strictEqual(await x.k.hasToken(), false); // újra bekapcsoláskor a felület (ensureToken) újat kér
  x.k.setConfig({ on: false }); // már ki volt kapcsolva: nincs újabb törlés
  assert.deepStrictEqual(deleted, ['kapu:mcp-token:3-9']);

  // Még le nem kérdezett hatókörnél a szervertől megkérdezi, kié a token, és azt törli.
  const deleted2 = [];
  const y = makeKapu({ deleteSecret: (ref) => deleted2.push(ref) });
  y.k.setConfig({ on: true });
  y.k.setConfig({ on: false });
  for (let i = 0; i < 20 && !deleted2.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual(deleted2, ['kapu:mcp-token:3-9']);
});

// --- szakmai MCP (jogi és könyvelői eszközök) ---------------------------------------------------

function fakePremium(results) {
  const calls = { get: 0, reset: 0 };
  let i = 0;
  let noticeQueue = [];
  return {
    calls,
    pushNotice(t) { noticeQueue.push(t); },
    api: {
      async get() { calls.get++; const r = results[Math.min(i++, results.length - 1)]; if (r instanceof Error) throw r; return r; },
      reason: () => null,
      notice: () => noticeQueue.shift() || null,
      reset() { calls.reset++; },
    },
  };
}

const PREM = { url: 'https://mcp.pelda.test/mcp/', token: 'KMT1.teszt.premium', ent: ['jog'], plan: 'trial' };

test('index: a szakmai token a körhöz kerül (conv.premium), és nem megy eseménybe', async () => {
  const p = fakePremium([PREM]);
  const { k, runner, events } = await ready({ premium: p.api });
  await k.send({ text: 'Mit mond az Art. 3. §?' });
  const o = runner.runs[0].opts;
  assert.deepStrictEqual(o.conv.premium, { url: PREM.url, token: PREM.token });
  o.onEvent({ type: 'final', text: 'kész' });
  assert.ok(!JSON.stringify(events).includes(PREM.token));
});

test('index: hibánál vagy null tokennél a kör szakmai szerver nélkül indul', async () => {
  const p = fakePremium([new Error('offline'), null]);
  const { k, runner } = await ready({ premium: p.api });
  await k.send({ text: 'első' });
  await k.send({ text: 'második' });
  assert.strictEqual(runner.runs.length, 2);
  assert.strictEqual(runner.runs[0].opts.conv.premium, null);
  assert.strictEqual(runner.runs[1].opts.conv.premium, null);
});

test('index: a szakmai jelzés egyszer, rendszerüzenetként a beszélgetésbe kerül', async () => {
  const p = fakePremium([null]);
  p.pushNotice('A jogi és könyvelői eszközökhöz előfizetés kell.');
  const { k } = await ready({ premium: p.api });
  const { convId } = await k.send({ text: 'Mit mond az Áfa tv.?' });
  await k.send({ convId, text: 'És a 3. §?' });
  const c = await k.get(convId);
  const sys = c.messages.filter((m) => m.role === 'system');
  assert.deepStrictEqual(sys.map((m) => m.text), ['A jogi és könyvelői eszközökhöz előfizetés kell.']);
});

test('index: premium nélkül (alapértelmezés) a conv.premium null', async () => {
  const { k, runner } = await ready();
  await k.send({ text: 'szia' });
  assert.strictEqual(runner.runs[0].opts.conv.premium, null);
});
