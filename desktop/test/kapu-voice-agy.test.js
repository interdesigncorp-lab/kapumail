'use strict';
// Kapu-chat, élő hang Antigravityvel: voice-agy (hamis interaktív `agy` pszeudoterminálban, amely a
// ANTIGRAVITY_MIC címre kapcsolódik), az ideiglenes HOME, és a kapu/index.js agy-hangja. Hálózat és valódi agy nélkül fut.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { startAgyVoice, pasteText, ERR } = require('../kapu/voice-agy');
const { createKapu } = require('../kapu');
const iso = require('../kapu/isolation');

const FAKE_BIN = path.join(__dirname, 'fake-agy-voice', 'agy');
const LOGIN = { token: { access_token: 'acc-1', token_type: 'Bearer', refresh_token: 'ref-1', expiry: '2099-01-01T00:00:00Z' }, auth_method: 'consumer' };
const POSIX = process.platform !== 'win32';

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-agyv-'));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function fakeHome({ onboarding = true } = {}) {
  const h = tmp();
  const cli = path.join(h, '.gemini', 'antigravity-cli');
  fs.mkdirSync(path.join(cli, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(cli, 'antigravity-oauth-token'), JSON.stringify(LOGIN), { mode: 0o600 });
  fs.writeFileSync(path.join(cli, 'settings.json'), JSON.stringify({ colorScheme: 'light', permissions: { allow: ['command(*)'] } }));
  if (onboarding) fs.writeFileSync(path.join(cli, 'cache', 'onboarding.json'), JSON.stringify({ consumerOnboardingComplete: true, enterpriseOnboardingComplete: false, onboardingComplete: true }));
  return h;
}
const readLog = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(20); }
  return false;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const snapshot = (dir) => {
  const out = {};
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else out[p] = `${st.size}:${st.mtimeMs}`; } };
  walk(dir);
  return out;
};

function agyOpts(state = {}, extra = {}) {
  const log = path.join(tmp(), 'log.jsonl');
  const userData = tmp();
  const home = fakeHome(extra.home);
  const events = [];
  const env = {
    PATH: process.env.PATH, HOME: home,
    FAKE_AGY: JSON.stringify({ log, ...state }),
    GEMINI_API_KEY: 'g-titok', GOOGLE_API_KEY: 'g-titok2', OPENAI_API_KEY: 'sk-titok', ELECTRON_RUN_AS_NODE: '1', KAPUMAIL_MCP_TOKEN: 'mcp-titok',
  };
  const opts = {
    userData, env, bin: FAKE_BIN, sourceHome: home, readKeychain: async () => null,
    onEvent: (ev) => events.push(ev), readyTimeoutMs: 8000, liveDelayMs: 30, pollMs: 50,
    ...(extra.opts || {}),
  };
  return { log, userData, home, events, opts };
}
const startOf = (log) => (readLog(log).find((l) => l.start) || {}).start;

test('agy voice: TCP kézfogás és keretek', { skip: !POSIX }, async () => {
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
  const { log, userData, home, events, opts } = agyOpts({ audio: pcm.toString('base64') });
  const before = snapshot(path.join(home, '.gemini'));
  const v = await startAgyVoice({ ...opts, history: [{ role: 'user', text: 'Mi jár le?' }, { role: 'assistant', text: 'Két határidő.' }] });
  try {
    assert.ok(readLog(log).some((l) => l.ok), 'a hangszóró-kapcsolat „JETSKI-AUDIO/1 OK” választ kapott');
    // 'A' keret → audio esemény (24 kHz s16le, base64)
    assert.ok(await until(() => events.some((e) => e.type === 'audio')));
    assert.strictEqual(events.find((e) => e.type === 'audio').pcm, pcm.toString('base64'));
    assert.ok(events.some((e) => e.type === 'speaking' && e.role === 'assistant'));
    // a felület mikrofonja → a mikrofon-kapcsolatra (16 kHz s16le)
    assert.strictEqual(v.pushMic(Buffer.from('HELLO-MIC!').toString('base64')), true);
    assert.ok(await until(() => readLog(log).some((l) => l.head && l.head.includes('HELLO-MIC!'))), 'a mikrofonadat megérkezett');
    assert.strictEqual(v.pushMic(Buffer.alloc(200000).toString('base64')), false, 'túl nagy darab nem megy át');

    // elszigetelés: saját HOME, pszeudoterminál, ANTIGRAVITY_MIC, API-kulcsok és MCP-token nélkül
    const st = startOf(log);
    assert.ok(st.home.startsWith(path.join(userData, 'kapu', 'voice', 'a-')), st.home);
    assert.ok(st.tty, 'az agy terminált lát');
    assert.match(st.mic, /^127\.0\.0\.1:\d+$/);
    assert.strictEqual(st.mic, `127.0.0.1:${v.port}`);
    for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE', 'KAPUMAIL_MCP_TOKEN']) assert.ok(!st.env.includes(k), k);
    const settings = JSON.parse(st.settings);
    assert.deepStrictEqual(settings.permissions.deny, iso.AGY_VOICE_DENY);
    assert.ok(!settings.permissions.allow, 'a felhasználó engedélyei nem jönnek át');
    assert.strictEqual(settings.telemetryEnabled, false);
    assert.ok(settings.trustedWorkspaces.includes(st.cwd) && settings.trustedWorkspaces.every((w) => w.endsWith(path.join('work'))), 'csak a saját munkamappa megbízható');
    assert.strictEqual(JSON.parse(st.onboarding).onboardingComplete, true);
    assert.strictEqual(JSON.parse(st.token).token.refresh_token, 'ref-1');
    assert.strictEqual(st.mcp, false, 'a hangnak nincs MCP-szervere');
    assert.match(st.agents, /Te Kapu vagy/);
    assert.match(st.agents, /Felhasználó: Mi jár le\?/);
    assert.ok(readLog(log).some((l) => l.typed === '/voice live'));
    assert.deepStrictEqual(snapshot(path.join(home, '.gemini')), before, 'a felhasználó ~/.gemini-je változatlan');
  } finally { v.stop({ now: true }); }
});

test("agy voice: 'C' keret → clear esemény", { skip: !POSIX }, async () => {
  const { events, opts } = agyOpts({ clear: true });
  const v = await startAgyVoice(opts);
  try {
    assert.ok(await until(() => events.some((e) => e.type === 'clear')));
  } finally { v.stop({ now: true }); }
});

test('agy voice: átirat-sor → transcript esemény', { skip: !POSIX }, async () => {
  const { log, events, opts } = agyOpts({ talker: [{ who: 'user', text: 'Szia Kapu! Mi jár le a héten?', n: 7 }, { who: 'talker', text: 'Megnézem a héten esedékeseket.', n: 9 }] });
  const v = await startAgyVoice(opts);
  try {
    assert.ok(await until(() => events.filter((e) => e.type === 'transcript').length >= 3));
    await wait(300);
    const tr = events.filter((e) => e.type === 'transcript').map((e) => `${e.role}:${e.text}`);
    assert.deepStrictEqual(tr, ['user:Szia Kapu! Mi jár le a héten?', 'assistant:Megnézem a héten esedékeseket.', 'assistant:Megnézem.'], 'az ismételt kontextus nem új kérdés');
    // say: beillesztésként, egy sorban, vezérlőkarakter és parancs nélkül
    assert.strictEqual(await v.say('/quit\nKapuMail eredménye: két\x1b[2J határidő'), true);
    assert.ok(await until(() => readLog(log).some((l) => l.typed && l.typed.includes('KapuMail eredménye'))));
    const typed = readLog(log).find((l) => l.typed && l.typed.includes('KapuMail eredménye')).typed;
    assert.strictEqual(typed, '\x1b[200~quit KapuMail eredménye: két [2J határidő\x1b[201~');
    assert.ok(!readLog(log).some((l) => l.typed === '/quit'), 'nem lett belőle parancs');
    assert.ok(await until(() => events.some((e) => e.type === 'transcript' && e.text === 'Két határidőd jár le a héten.')));
    assert.ok(!events.some((e) => e.type === 'transcript' && e.role === 'user' && /KapuMail/.test(e.text)), 'a beírt eredmény nem felhasználói mondat');
  } finally { v.stop({ now: true }); }
});

test('agy voice: windows → magyar hiba', async () => {
  const events = [];
  await assert.rejects(startAgyVoice({ platform: 'win32', userData: tmp(), onEvent: (e) => events.push(e) }), (e) => e.code === 'unsupported' && e.message === 'Antigravity-hang Windowson még nem elérhető.');
  assert.deepStrictEqual(events, [{ type: 'error', text: 'Antigravity-hang Windowson még nem elérhető.' }]);
  assert.strictEqual(ERR.unsupported, 'Antigravity-hang Windowson még nem elérhető.');
});

test('agy voice: stop után nincs futó folyamat, ideiglenes HOME törölve', { skip: !POSIX }, async () => {
  const { log, userData, events, opts } = agyOpts();
  const v = await startAgyVoice(opts);
  const st = startOf(log);
  assert.ok(fs.existsSync(st.home));
  assert.ok(alive(v.pid) && alive(st.pid));
  v.stop();
  assert.ok(await until(() => !alive(v.pid) && !alive(st.pid), 6000), 'a python-segéd és az agy is leállt');
  assert.ok(await until(() => !fs.existsSync(st.home), 6000), 'az ideiglenes HOME törölve');
  await wait(1200);
  assert.deepStrictEqual(fs.readdirSync(path.join(userData, 'kapu', 'voice')), [], 'a leállás közben írt napló sem marad');
  assert.ok(readLog(log).some((l) => l.typed === '/voice stop'));
  assert.deepStrictEqual(events.filter((e) => e.type === 'closed').length, 1);
  assert.strictEqual(v.pushMic(Buffer.from('x').toString('base64')), false);
  assert.strictEqual(await v.say('valami'), false);
});

test('agy voice: stop({now}) szinkron töröl és leállít', { skip: !POSIX }, async () => {
  const { log, opts } = agyOpts();
  const v = await startAgyVoice(opts);
  const st = startOf(log);
  v.stop({ now: true });
  assert.ok(!fs.existsSync(st.home), 'a mappa azonnal törölve');
  assert.ok(await until(() => !alive(v.pid) && !alive(st.pid), 4000));
});

test('agy voice: „nem elérhető” → újrapróbál; tartósan → magyar hiba, takarítás', { skip: !POSIX }, async () => {
  const a = agyOpts({ notAvailable: 2 });
  const v = await startAgyVoice(a.opts);
  assert.strictEqual(readLog(a.log).filter((l) => l.typed === '/voice live').length, 3);
  v.stop({ now: true });

  const b = agyOpts({ notAvailable: 99 }, { opts: { liveRetries: 3 } });
  await assert.rejects(startAgyVoice(b.opts), (e) => e.code === 'unavailable' && e.message === ERR.unavailable);
  const st = startOf(b.log);
  assert.ok(!fs.existsSync(st.home));
  assert.ok(await until(() => !alive(st.pid)));
});

test('agy voice: belépés/első indítás kérése → hiba, nincs folyamat; kész első indítás nélkül el sem indul', { skip: !POSIX }, async () => {
  const a = agyOpts({ gate: true });
  await assert.rejects(startAgyVoice(a.opts), (e) => e.code === 'onboarding');
  const st = startOf(a.log);
  assert.ok(!fs.existsSync(st.home));
  assert.ok(await until(() => !alive(st.pid)));

  const b = agyOpts({}, { home: { onboarding: false } });
  await assert.rejects(startAgyVoice(b.opts), (e) => e.code === 'onboarding' && /agy parancsot/.test(e.message));
  assert.strictEqual(readLog(b.log).length, 0, 'az agy el sem indult');
  assert.ok(!fs.existsSync(path.join(b.userData, 'kapu', 'voice')) || fs.readdirSync(path.join(b.userData, 'kapu', 'voice')).length === 0);
});

test('agy voice: megszakítás az indulás alatt → nincs folyamat, nincs mappa', { skip: !POSIX }, async () => {
  const { log, userData, opts } = agyOpts({ notAvailable: 99 }, { opts: { liveDelayMs: 200, liveRetries: 50 } });
  const ac = new AbortController();
  const p = startAgyVoice({ ...opts, signal: ac.signal });
  assert.ok(await until(() => !!startOf(log)));
  ac.abort();
  await assert.rejects(p, (e) => e.code === 'aborted');
  const st = startOf(log);
  assert.ok(!fs.existsSync(st.home));
  assert.ok(await until(() => !alive(st.pid)));
  assert.deepStrictEqual(fs.readdirSync(path.join(userData, 'kapu', 'voice')), []);
});

test('agy voice: a hívás vége az agy-ban → closed esemény, takarítás', { skip: !POSIX }, async () => {
  const { log, events, opts } = agyOpts({ hangup: 400 });
  const v = await startAgyVoice(opts);
  assert.ok(await until(() => events.some((e) => e.type === 'closed')));
  assert.ok(v.closed);
  const st = startOf(log);
  assert.ok(await until(() => !fs.existsSync(st.home) && !alive(st.pid), 6000));
});

test('agy voice: pasteText és sweep (a-* belépés-másolat 40 perc után)', () => {
  assert.strictEqual(pasteText('  /voice stop\r\n🎤 Stopped voice chat · 00:01'), 'voice stop Stopped voice chat · 00:01');
  assert.strictEqual(pasteText('x'.repeat(5000)).length, 4000);
  const ud = tmp();
  const tok = path.join(ud, 'kapu', 'voice', 'a-abc', '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  fs.mkdirSync(path.dirname(tok), { recursive: true });
  fs.writeFileSync(tok, '{}');
  assert.deepStrictEqual(iso.sweep(ud, { now: Date.now() + 20 * 60 * 1000 }), []);
  assert.deepStrictEqual(iso.sweep(ud, { now: Date.now() + 41 * 60 * 1000 }), [tok]);
  assert.deepStrictEqual(iso.sweep(ud, { now: Date.now() + 4 * 60 * 60 * 1000 }), [path.join(ud, 'kapu', 'voice', 'a-abc')]);
});

// --- index: az agy-hang a hídon át -------------------------------------------------------------

function kapuWith({ startAgyVoice: sav, sends }) {
  const userData = tmp();
  const cfg = { kapu: { on: true, engine: 'agy' } };
  const voiceEvents = [];
  const secrets = { 'kapu:mcp-token:1-2': 'tok-12345678' };
  const k = createKapu({
    userData, encrypt: (s) => s, decrypt: (s) => s, readCfg: () => cfg, saveCfg: (c) => Object.assign(cfg, c),
    readSecret: (r) => secrets[r], writeSecret: (r, v) => { secrets[r] = v; }, mcpBase: () => ({ mode: 'http', url: 'http://127.0.0.1:1/mcp' }),
    resolveScope: async () => ({ officeId: 1, userId: 2 }),
    emitVoice: (ev) => voiceEvents.push(ev),
    startRun: ({ message, onEvent }) => { sends.push(message); setTimeout(() => onEvent({ type: 'final', text: `Válasz: ${message}` }), 10); return { cancel() {} }; },
    startVoice: async () => { throw new Error('codex nem kell'); },
    startAgyVoice: sav,
    isolation: { sweep() {}, forgetSession() {} },
  });
  return { k, voiceEvents, cfg };
}

test('agy voice az indexben: PCM-út, átirat → szöveges kör → say, audio/clear a felületre, stop', async () => {
  const said = [];
  const mic = [];
  let session = null;
  let opts = null;
  const sends = [];
  const { k, voiceEvents } = kapuWith({
    sends,
    startAgyVoice: async (o) => {
      opts = o;
      session = { stopped: null, say: async (t) => { said.push(t); return true; }, pushMic: (b) => { mic.push(b); return true; }, stop(x) { this.stopped = x || {}; } };
      return session;
    },
  });
  const r = await k.voiceStart({ engine: 'agy' });
  assert.deepStrictEqual(r, { convId: null, mode: 'pcm' });
  assert.ok(opts.signal && typeof opts.onEvent === 'function');
  assert.deepStrictEqual(k.voiceAudio('AAAA'), { ok: true });
  assert.deepStrictEqual(mic, ['AAAA']);
  opts.onEvent({ type: 'audio', pcm: 'BBBB' });
  opts.onEvent({ type: 'clear' });
  assert.ok(voiceEvents.some((e) => e.type === 'audio' && e.pcm === 'BBBB'));
  assert.ok(voiceEvents.some((e) => e.type === 'clear'));
  opts.onEvent({ type: 'transcript', role: 'user', text: 'Mi jár le a héten?' });
  assert.ok(await until(() => said.length === 1));
  assert.deepStrictEqual(sends, ['Mi jár le a héten?']);
  assert.match(said[0], /KapuMail eredménye/);
  assert.match(said[0], /Válasz: Mi jár le a héten\?/);
  const conv = voiceEvents.find((e) => e.type === 'conv');
  assert.ok(conv && conv.convId);
  const saved = await k.get(conv.convId);
  assert.strictEqual(saved.engine, 'agy');
  assert.ok(saved.messages.every((m) => m.voice === true));
  k.cancelAll({ cleanupNow: true });
  assert.deepStrictEqual(session.stopped, { now: true });
  assert.deepStrictEqual(k.voiceAudio('AAAA'), { ok: false });
});

test('agy voice az indexben: windowsos hiba átmegy, codex-beszélgetésben nem indul agy', async () => {
  const { k, cfg } = kapuWith({
    sends: [],
    startAgyVoice: async (o) => { o.onEvent({ type: 'error', text: 'Antigravity-hang Windowson még nem elérhető.' }); throw Object.assign(new Error('Antigravity-hang Windowson még nem elérhető.'), { code: 'unsupported' }); },
  });
  await assert.rejects(k.voiceStart({ engine: 'agy' }), /Antigravity-hang Windowson még nem elérhető\./);
  assert.strictEqual(k.voiceActive, false);
  cfg.kapu.engine = 'codex';
  await assert.rejects(k.voiceStart({ engine: 'agy' }), /nem az Antigravity/);
});

test('agy voice: a /voice live előtti kapcsolat bontva; a két hely után nincs több kapcsolat', { skip: !POSIX }, async () => {
  const { log, opts } = agyOpts({ early: true }, { opts: { liveDelayMs: 400 } });
  const v = await startAgyVoice(opts);
  try {
    assert.ok(await until(() => readLog(log).some((l) => l.early)));
    assert.strictEqual(readLog(log).find((l) => l.early).early, 'closed', 'a korai kapcsolat nem kapott OK-t');
    assert.ok(readLog(log).some((l) => l.ok), 'az agy saját kapcsolata a /voice live után átment');
    // harmadik kapcsolat: a szerver már nem figyel (vagy azonnal bont), adatot nem kap
    const third = await new Promise((resolve) => {
      const c = net.connect(v.port, '127.0.0.1');
      let got = 0;
      c.on('data', (d) => { got += d.length; });
      c.on('error', (e) => resolve(e.code));
      c.on('close', () => resolve(got ? `data:${got}` : 'closed'));
      c.on('connect', () => c.write('JETSKI-AUDIO/1 speaker rate=24000\n'));
    });
    assert.ok(third === 'ECONNREFUSED' || third === 'closed', String(third));
    assert.strictEqual(v.closed, false, 'a hívás él tovább');
  } finally { v.stop({ now: true }); }
});

test('agy voice: a hangcsatorna megszakadása a felépülés után → a hívás véget ér (error), takarítás', { skip: !POSIX }, async () => {
  const { log, events, opts } = agyOpts({ dropMic: 300 });
  const v = await startAgyVoice(opts);
  assert.ok(await until(() => events.some((e) => e.type === 'error')));
  assert.strictEqual(events.find((e) => e.type === 'error').text, 'Megszakadt az élő beszélgetés.');
  assert.ok(v.closed);
  assert.strictEqual(v.pushMic(Buffer.from('xx').toString('base64')), false);
  const st = startOf(log);
  assert.ok(await until(() => !fs.existsSync(st.home) && !alive(st.pid), 6000));
  assert.strictEqual(events.filter((e) => e.type === 'closed' || e.type === 'error').length, 1);
});

test('agy voice: azonnali letétel a felépüléskor → egy closed esemény, nem dob hibát', { skip: !POSIX }, async () => {
  const { log, events, opts } = agyOpts({ instantHangup: true });
  const v = await startAgyVoice(opts);
  assert.ok(v.closed);
  assert.deepStrictEqual(events.filter((e) => e.type === 'closed' || e.type === 'error').map((e) => e.type), ['closed']);
  const st = startOf(log);
  assert.ok(await until(() => !fs.existsSync(st.home) && !alive(st.pid), 6000));
});

test('agy voice az indexben: a mikrofondarabok száma másodpercenként legfeljebb 50', async () => {
  let pushed = 0;
  const { k } = kapuWith({ sends: [], startAgyVoice: async () => ({ say: async () => true, pushMic: () => { pushed++; return true; }, stop() {} }) });
  await k.voiceStart({ engine: 'agy' });
  const oks = Array.from({ length: 80 }, () => k.voiceAudio('AAAA').ok).filter(Boolean).length;
  assert.strictEqual(oks, 50);
  assert.strictEqual(pushed, 50);
  k.voiceStop();
});

test('hangcsatorna: ha az agy nem olvas, a mikrofondarabok elmaradnak (nincs korlátlan puffer)', async () => {
  const { createAudioServer } = require('../kapu/voice-agy');
  const srv = await createAudioServer({});
  const c = net.connect(srv.port, '127.0.0.1');
  c.pause(); // nem olvas
  await until(() => srv.mic, 2000);
  let dropped = 0;
  for (let i = 0; i < 200; i++) if (!srv.push(Buffer.alloc(128 * 1024))) dropped++;
  assert.ok(srv.mic);
  assert.ok(dropped > 0, 'a 256 KB-os tartalék felett eldobja');
  c.destroy();
  srv.close();
});
