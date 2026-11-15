'use strict';
// Kapu-chat, élő hang ChatGPT-vel: voice-codex (hamis `codex app-server` JSON-RPC-vel), voice-bridge, és a
// kapu/index.js hangkezelése. Hálózat és valódi codex nélkül fut.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { startCodexVoice, ERR } = require('../kapu/voice-codex');
const { createVoiceBridge, speakable, CONFIRM_SAY } = require('../kapu/voice-bridge');
const { createKapu } = require('../kapu');
const iso = require('../kapu/isolation');

const FAKE_BIN = path.join(__dirname, 'fake-codex-voice', 'codex');
const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';
const CODEX_AUTH = { auth_mode: 'chatgpt', OPENAI_API_KEY: 'sk-nem-kell', tokens: { id_token: 'id', access_token: 'acc', refresh_token: 'ref-1', account_id: 'a' } };

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-voice-'));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function fakeHome() {
  const h = tmp();
  fs.mkdirSync(path.join(h, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(h, '.codex', 'auth.json'), JSON.stringify(CODEX_AUTH), { mode: 0o600 });
  return h;
}
const readLog = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(20); }
  return false;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function voiceOpts(state = {}, extra = {}) {
  const log = path.join(tmp(), 'log.jsonl');
  const userData = tmp();
  const home = fakeHome();
  const env = {
    PATH: process.env.PATH, HOME: home,
    FAKE_VOICE: JSON.stringify({ log, ...state }),
    OPENAI_API_KEY: 'sk-titok', CODEX_API_KEY: 'sk-titok2', OPENAI_BASE_URL: 'https://idegen.example', CODEX_HOME: '/idegen', ELECTRON_RUN_AS_NODE: '1',
  };
  return { log, userData, home, opts: { sdpOffer: OFFER, userData, env, bin: FAKE_BIN, sourceHome: home, rpcTimeoutMs: 3000, answerTimeoutMs: 1500, ...extra } };
}

test('codex voice: JSON-RPC sorrend thread/start → realtime/start, SDP-válasz visszajön', async () => {
  const { log, userData, home, opts } = voiceOpts();
  const v = await startCodexVoice({ ...opts, history: [{ role: 'user', text: 'Szia' }, { role: 'assistant', text: 'Szia, miben segítsek?' }] });
  try {
    assert.strictEqual(v.answer, 'v=0\r\nfake-answer\r\n');
    const lines = readLog(log);
    const methods = lines.filter((l) => l.method).map((l) => l.method);
    assert.deepStrictEqual(methods, ['initialize', 'initialized', 'account/read', 'config/read', 'thread/start', 'thread/realtime/start']);
    const start = lines[0].start;
    assert.deepStrictEqual(start.args, ['app-server', '--listen', 'stdio://', '--enable', 'realtime_conversation', '-c', 'analytics.enabled=false', '-c', 'model_provider=openai']);
    // saját, ideiglenes CODEX_HOME a program mappájában, benne a ChatGPT-belépés másolata (API-kulcs nélkül)
    assert.ok(start.codexHome.startsWith(path.join(userData, 'kapu', 'voice', 'v-')), start.codexHome);
    assert.notStrictEqual(start.codexHome, path.join(home, '.codex'));
    assert.strictEqual(start.auth.tokens.refresh_token, 'ref-1');
    assert.strictEqual(start.auth.OPENAI_API_KEY, null);
    assert.ok(fs.realpathSync(start.cwd).startsWith(fs.realpathSync(start.codexHome)));
    const ts = lines.find((l) => l.method === 'thread/start').params;
    assert.strictEqual(ts.ephemeral, true);
    assert.strictEqual(ts.config['mcp_servers.mine.enabled'], false);
    assert.strictEqual(ts.config['features.shell_tool'], false);
    const rs = lines.find((l) => l.method === 'thread/realtime/start').params;
    assert.strictEqual(rs.threadId, 'thr-1');
    assert.strictEqual(rs.outputModality, 'audio');
    assert.deepStrictEqual(rs.transport, { type: 'webrtc', sdp: OFFER });
    assert.strictEqual(rs.clientManagedHandoffs, true);
    assert.deepStrictEqual(rs.initialItems.slice(1), [{ role: 'user', text: 'Szia' }, { role: 'assistant', text: 'Szia, miben segítsek?' }]);
    // a kapcsolat felépülése után a belépés másolata már nincs ott; a felhasználó eredetije érintetlen
    assert.ok(!fs.existsSync(path.join(start.codexHome, 'auth.json')));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8')).OPENAI_API_KEY, 'sk-nem-kell');
    // say → appendText fejlesztői szerepben
    assert.strictEqual(await v.say('KapuMail eredménye: péntek'), true);
    const app = readLog(log).find((l) => l.method === 'thread/realtime/appendText');
    assert.deepStrictEqual(app.params, { threadId: 'thr-1', role: 'developer', text: 'KapuMail eredménye: péntek' });
  } finally { v.stop(); }
});

test('codex voice: nem ChatGPT fiók → magyar hiba, a folyamat és a mappa eltűnik', async () => {
  const { log, userData, opts } = voiceOpts({ account: 'apikey' });
  await assert.rejects(startCodexVoice(opts), (e) => e.code === 'not_chatgpt' && e.message === ERR.not_chatgpt && /ChatGPT-fiókkal/.test(e.message));
  const start = readLog(log)[0].start;
  assert.ok(await until(() => !alive(start.pid)), 'a codex folyamat leállt');
  assert.deepStrictEqual(fs.readdirSync(path.join(userData, 'kapu', 'voice')), []);
  const { opts: o2 } = voiceOpts({ account: null });
  await assert.rejects(startCodexVoice(o2), (e) => e.code === 'signed_out' && /nem vagy belépve/.test(e.message));
  // saját szolgáltató a beállításban: nem indul
  const { opts: o3 } = voiceOpts({ config: { model_providers: { openai: { base_url: 'https://x' } } } });
  await assert.rejects(startCodexVoice(o3), (e) => e.code === 'config');
  // nincs SDP-válasz → általános hiba
  const { opts: o4 } = voiceOpts({ noAnswer: true });
  await assert.rejects(startCodexVoice(o4), (e) => e.code === 'failed');
  // nincs belépés a gépen
  const { opts: o5 } = voiceOpts();
  fs.rmSync(path.join(o5.sourceHome, '.codex', 'auth.json'));
  await assert.rejects(startCodexVoice(o5), (e) => e.code === 'signed_out');
});

test('codex voice: API-kulcs változók nincsenek a gyerek környezetében', async () => {
  const { log, opts } = voiceOpts();
  const v = await startCodexVoice(opts);
  v.stop();
  const env = readLog(log)[0].start.env;
  for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'ELECTRON_RUN_AS_NODE']) assert.ok(!env.includes(k), k);
  assert.ok(env.includes('CODEX_HOME')); // a saját, nem a hívó /idegen-je (lásd az első tesztet)
});

test('codex voice: átirat → transcript esemény, az ismételt befejezés nem új kérés', async () => {
  const { opts } = voiceOpts({ transcript: 'Mi jár le a héten?' });
  const evs = [];
  const v = await startCodexVoice({ ...opts, onEvent: (e) => evs.push(e) });
  try {
    assert.ok(await until(() => evs.some((e) => e.type === 'transcript')));
    await wait(80);
    assert.deepStrictEqual(evs.filter((e) => e.type !== 'closed'), [{ type: 'speaking', role: 'user' }, { type: 'transcript', role: 'user', text: 'Mi jár le a héten?' }]);
  } finally { v.stop(); }
});

test('stop: a folyamat leáll, a mappa törlődik, a codex-zár felszabadul', async () => {
  const { log, userData, opts } = voiceOpts();
  const evs = [];
  const v = await startCodexVoice({ ...opts, onEvent: (e) => evs.push(e) });
  const start = readLog(log)[0].start;
  assert.ok(alive(start.pid));
  v.stop();
  v.stop();
  assert.ok(await until(() => !alive(start.pid)), 'a codex folyamat leállt');
  assert.ok(readLog(log).some((l) => l.method === 'thread/realtime/stop'));
  assert.ok(await until(() => !fs.existsSync(start.codexHome)), 'a mappa törlődött');
  assert.deepStrictEqual(evs, [{ type: 'closed' }]);
  assert.strictEqual(await v.say('még?'), false);
  // a codex-zár szabad: a következő hang (és szöveges kör) azonnal indulhat
  const again = await startCodexVoice({ ...voiceOpts().opts, userData });
  again.stop();
});

test('codex voice: a folyamat váratlan kilépése error eseményt ad', async () => {
  const { log, opts } = voiceOpts();
  const evs = [];
  const v = await startCodexVoice({ ...opts, onEvent: (e) => evs.push(e) });
  process.kill(readLog(log)[0].start.pid, 'SIGKILL');
  assert.ok(await until(() => evs.length > 0));
  assert.strictEqual(evs[0].type, 'error');
  assert.strictEqual(v.closed, true);
});

// --- híd ------------------------------------------------------------------------------------------

function bridgeHarness(convId = null) {
  const sent = [];
  const said = [];
  const out = [];
  const b = createVoiceBridge({
    convId,
    send: async ({ convId: c, text }) => { sent.push({ convId: c, text }); return { convId: c || 'uj-1' }; },
    say: (t) => { said.push(t); return Promise.resolve(true); },
    emit: (e) => out.push(e),
  });
  return { b, sent, said, out };
}

test('bridge: átirat → szöveges kör → say(final)', async () => {
  const { b, sent, said, out } = bridgeHarness();
  assert.strictEqual(b.transcript('assistant', 'Megnézem.'), false); // a hangmodell saját mondata nem kör
  assert.strictEqual(b.transcript('user', 'Mi jár le a héten?'), true);
  b.transcript('user', 'És a jövő héten?'); // sorban vár
  await wait(5);
  assert.deepStrictEqual(sent, [{ convId: null, text: 'Mi jár le a héten?' }]);
  assert.strictEqual(b.convId, 'uj-1');
  assert.deepStrictEqual(out.slice(0, 2), [{ type: 'think', on: true }, { type: 'conv', convId: 'uj-1' }]);
  b.event({ type: 'activity', convId: 'uj-1', text: 'Megnézem a határidőket…' });
  b.event({ type: 'final', convId: 'masik', text: 'idegen' }); // más beszélgetés: nem számít
  assert.strictEqual(said.length, 0);
  b.event({ type: 'final', convId: 'uj-1', text: 'A héten **két** határidő van: [Kovács Kft.](kapu:client/3).' });
  assert.strictEqual(said.length, 1);
  assert.match(said[0], /^KapuMail eredménye/);
  assert.match(said[0], /A héten két határidő van: Kovács Kft\./);
  assert.ok(!said[0].includes('kapu:client'));
  await wait(5);
  assert.deepStrictEqual(sent[1], { convId: 'uj-1', text: 'És a jövő héten?' });
  b.event({ type: 'error', convId: 'uj-1', text: 'ChatGPT hibával állt le.' });
  assert.match(said[1], /nem sikerült/);
  assert.deepStrictEqual(out.filter((e) => e.type === 'think').map((e) => e.on), [true, false, true, false]);
  b.close();
  assert.strictEqual(b.transcript('user', 'még?'), false);
});

test('bridge: confirm esemény továbbmegy, és a hangmodell kimondja, hogy jóváhagyás kell', async () => {
  const { b, said, out } = bridgeHarness('c-1');
  b.transcript('user', 'Állítsd az emlékeztetőt 5 és 1 napra.');
  await wait(5);
  b.event({ type: 'confirm', convId: 'c-1', id: '9f1c2a7e-0d3b-4c51-8e7a-2b6f4d9a1c30' });
  assert.deepStrictEqual(out.find((e) => e.type === 'confirm'), { type: 'confirm', id: '9f1c2a7e-0d3b-4c51-8e7a-2b6f4d9a1c30', convId: 'c-1' });
  b.event({ type: 'final', convId: 'c-1', text: 'Az emlékeztetőt 5 és 1 napra állítanám.' });
  assert.ok(said[0].includes(CONFIRM_SAY), said[0]);
  // a kártya „Mehet” gombja gépelt szövegként ugyanígy kört indít
  assert.strictEqual(b.text('Jóváhagytam.'), true);
});

test('bridge: a küldés hibája hangon jelez, és a sor megy tovább', async () => {
  const said = [];
  let n = 0;
  const b = createVoiceBridge({
    send: async () => { n++; if (n === 1) throw new Error('A Kapu ki van kapcsolva.'); return { convId: 'x' }; },
    say: (t) => { said.push(t); },
  });
  b.transcript('user', 'egy');
  b.transcript('user', 'kettő');
  await wait(10);
  assert.match(said[0], /A Kapu ki van kapcsolva/);
  assert.strictEqual(n, 2);
});

test('speakable: Markdown nélküli, felolvasható szöveg', () => {
  assert.strictEqual(speakable('# Cím\n\n- **egy** [Irat](kapu:doc/12)\n- `kettő`'), 'Cím\negy Irat\nkettő');
});

// --- index.js -------------------------------------------------------------------------------------

const KEY = 0x5a;
const encrypt = (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ KEY));
const decrypt = (b) => Buffer.from(b.map((x) => x ^ KEY)).toString('utf8');

function makeKapu() {
  const userData = tmp();
  const cfg = {};
  const vault = {};
  const events = [];
  const voiceEvents = [];
  const runs = [];
  const sessions = [];
  const gate = { hold: null };
  const k = createKapu({
    userData, encrypt, decrypt,
    readCfg: () => cfg, saveCfg: (p) => Object.assign(cfg, p),
    readSecret: (ref) => vault[ref] || null, writeSecret: (ref, v) => { vault[ref] = v; },
    mcpBase: () => ({ mode: 'stdio', php: 'php', artisan: '/app/artisan' }),
    resolveScope: async () => ({ officeId: 3, userId: 9 }),
    emit: (ev) => events.push(ev),
    emitVoice: (ev) => voiceEvents.push(ev),
    startRun: (opts) => { const r = { opts, cancelled: false }; runs.push(r); return { cancel() { r.cancelled = true; } }; },
    startVoice: async (opts) => {
      const s = { opts, said: [], stopped: false, answer: 'v=0\r\nanswer\r\n' };
      sessions.push(s);
      if (gate.hold) await gate.hold;
      return { answer: s.answer, say: (t) => { s.said.push(t); return Promise.resolve(true); }, stop: (o) => { if (!s.stopped) { s.stopped = true; s.stopOpts = o; } } };
    },
    isolation: { sweep: () => {}, forgetSession: () => {} },
    providers: { ENGINES: ['claude', 'codex', 'agy'], status: async () => ({}), openSignIn: async () => ({}), signInCommand: () => 'x' },
  });
  return { k, cfg, events, voiceEvents, runs, sessions, gate };
}

test('index: lockStop – a leállított szöveges kör záró hibaeseményt kap (a felület „gondolkodik” állapota véget ér)', async () => {
  const x = makeKapu();
  x.k.setConfig({ on: true, engine: 'codex' });
  await x.k.storeToken('kapu-token-0123456789', { officeId: 3, userId: 9 });
  const { convId } = await x.k.send({ text: 'Mi jár le a héten?' });
  const run = x.runs[x.runs.length - 1];
  x.k.lockStop();
  assert.strictEqual(run.cancelled, true);
  const errs = x.events.filter((e) => e.type === 'error');
  assert.deepStrictEqual(errs, [{ type: 'error', code: 'failed', text: 'Zárolás miatt leállt.', convId }]);
  const conv = await x.k.get(convId);
  assert.deepStrictEqual(conv.messages.map((m) => m.role), ['user', 'system']);
  // a leállított kör késői eseménye már nem jut ki
  run.opts.onEvent({ type: 'final', text: 'késő' });
  assert.strictEqual(x.events.filter((e) => e.type === 'final').length, 0);
  x.k.lockStop();
  assert.strictEqual(x.events.filter((e) => e.type === 'error').length, 1);
});

test('index: élő hang – átirat → kör voice:true jelöléssel → felolvasás; navigáció leállítja', async () => {
  const x = makeKapu();
  x.k.setConfig({ on: true, engine: 'codex' });
  await x.k.storeToken('kapu-token-0123456789', { officeId: 3, userId: 9 });
  const r = await x.k.voiceStart({ engine: 'codex', sdp: OFFER });
  assert.deepStrictEqual(r, { sdpAnswer: 'v=0\r\nanswer\r\n', convId: null });
  assert.strictEqual(x.k.voiceActive, true);
  const s = x.sessions[0];
  s.opts.onEvent({ type: 'transcript', role: 'user', text: 'Mi jár le a héten?' });
  await wait(10);
  assert.strictEqual(x.runs.length, 1);
  assert.strictEqual(x.runs[0].opts.engine, 'codex');
  const convId = x.voiceEvents.find((e) => e.type === 'conv').convId;
  x.runs[0].opts.onEvent({ type: 'final', text: 'Péntek.' });
  assert.match(s.said[0], /Péntek\./);
  const conv = await x.k.get(convId);
  assert.deepStrictEqual(conv.messages.map((m) => [m.role, m.text, m.voice]), [['user', 'Mi jár le a héten?', true], ['kapu', 'Péntek.', true]]);
  assert.ok(x.voiceEvents.some((e) => e.type === 'transcript' && e.text === 'Mi jár le a héten?'));
  // a folytatott beszélgetés előzménye a hangmodellhez kerül
  x.k.voiceStop();
  assert.ok(s.stopped);
  await x.k.voiceStart({ engine: 'codex', sdp: OFFER, convId });
  assert.deepStrictEqual(x.sessions[1].opts.history, [{ role: 'user', text: 'Mi jár le a héten?' }, { role: 'assistant', text: 'Péntek.' }]);
  x.k.resetScope();
  assert.ok(x.sessions[1].stopped);
  assert.strictEqual(x.k.voiceActive, false);
  assert.deepStrictEqual(x.voiceEvents.filter((e) => e.type === 'state').map((e) => e.state), ['closed', 'closed']);
});

test('index: élő hang ChatGPT-vel vagy Antigravityvel, bekapcsolt Kapuval, a beszélgetés motorjával', async () => {
  const x = makeKapu();
  await assert.rejects(x.k.voiceStart({ engine: 'codex', sdp: OFFER }), /ki van kapcsolva/);
  x.k.setConfig({ on: true, engine: 'claude' });
  await x.k.storeToken('kapu-token-0123456789', { officeId: 3, userId: 9 });
  await assert.rejects(x.k.voiceStart({ engine: 'claude', sdp: OFFER }), /Hangon ChatGPT-vel vagy Antigravityvel beszélhetsz\./);
  await assert.rejects(x.k.voiceStart({ engine: 'agy', sdp: OFFER }), /nem az Antigravity/);
  await assert.rejects(x.k.voiceStart({ engine: 'codex', sdp: OFFER }), /nem a ChatGPT/);
  assert.throws(() => x.k.voiceText('Jóváhagytam.'), /Nincs élő beszélgetés/);
  assert.strictEqual(x.sessions.length, 0);
});

test('stop({now}): kilépéskor azonnal leáll, a mappa szinkron törlődik', async () => {
  const { log, opts } = voiceOpts();
  const v = await startCodexVoice(opts);
  const start = readLog(log)[0].start;
  v.stop({ now: true });
  assert.ok(!fs.existsSync(start.codexHome));
  assert.ok(await until(() => !alive(start.pid)));
});

test('abort: a codex-zárra várva megszakítva → nincs folyamat, nincs hangmappa, a zár szabad', async () => {
  const { log, userData, home, opts } = voiceOpts();
  // egy szöveges codex-kör tartja a zárat
  const text = await iso.prepare({ engine: 'codex', userData, mcp: { mode: 'http', url: 'https://iroda.kapumail.hu/mcp', token: 'kapu-teszt-token-0123456789' }, sourceHome: home });
  const ac = new AbortController();
  const p = startCodexVoice({ ...opts, signal: ac.signal });
  await wait(100);
  ac.abort();
  await assert.rejects(p, (e) => e.code === 'aborted');
  assert.ok(!fs.existsSync(log), 'nem indult codex');
  const vdir = path.join(userData, 'kapu', 'voice');
  assert.deepStrictEqual(fs.existsSync(vdir) ? fs.readdirSync(vdir) : [], []);
  text.cleanup();
  // a megszakított várakozó nem foglalja a zárat: a következő hang elindul
  const v = await startCodexVoice({ ...voiceOpts().opts, userData });
  v.stop({ now: true });
});

test('abort: a kézfogás közben megszakítva → a codex leáll, a mappa azonnal törlődik', async () => {
  const { log, userData, opts } = voiceOpts({ noAnswer: true });
  const ac = new AbortController();
  const p = startCodexVoice({ ...opts, signal: ac.signal, answerTimeoutMs: 5000 });
  assert.ok(await until(() => readLog(log).some((l) => l.method === 'thread/realtime/start')));
  const start = readLog(log)[0].start;
  ac.abort();
  assert.ok(!fs.existsSync(start.codexHome), 'szinkron törölve');
  await assert.rejects(p, (e) => e.code === 'aborted');
  assert.ok(await until(() => !alive(start.pid)));
  assert.deepStrictEqual(fs.readdirSync(path.join(userData, 'kapu', 'voice')), []);
});

test('bridge: az új beszélgetés azonnali hibája (a send válasza előtt) is lezárja a kört, a sor megy tovább', async () => {
  const said = [];
  const sent = [];
  let b;
  b = createVoiceBridge({
    send: async ({ convId, text }) => {
      sent.push(text);
      const id = convId || 'uj-9';
      if (sent.length === 1) b.event({ type: 'error', convId: id, code: 'missing', text: 'ChatGPT nincs telepítve ezen a gépen.' });
      return { convId: id };
    },
    say: (t) => { said.push(t); },
  });
  b.transcript('user', 'egy');
  b.transcript('user', 'kettő');
  await wait(10);
  assert.match(said[0], /nincs telepítve/);
  assert.deepStrictEqual(sent, ['egy', 'kettő']);
});

test('bridge: betelt sor → dropped esemény; Mégse → visszajelzés a hangmodellnek', async () => {
  const { b, said, out } = bridgeHarness('c-1');
  for (let i = 0; i < 8; i++) b.transcript('user', `kérdés ${i}`);
  await wait(5);
  assert.deepStrictEqual(out.filter((e) => e.type === 'dropped').map((e) => e.text), ['kérdés 1']);
  assert.strictEqual(b.declined(), true);
  assert.match(said[0], /elvetette/);
});

test('index: indulás közben leállítva → a codex-indítás megszakad; kilépéskor azonnali leállítás', async () => {
  const x = makeKapu();
  x.k.setConfig({ on: true, engine: 'codex' });
  await x.k.storeToken('kapu-token-0123456789', { officeId: 3, userId: 9 });
  let release;
  const hold = new Promise((r) => { release = r; });
  x.gate.hold = hold;
  // a hamis startVoice a jelzésre vár; a valódi a signal-ra áll le
  const orig = x.k.voiceStart;
  const p = orig({ engine: 'codex', sdp: OFFER });
  await wait(5);
  const s0 = x.sessions[0];
  assert.ok(s0.opts.signal instanceof AbortSignal);
  x.k.voiceStop();
  assert.strictEqual(s0.opts.signal.aborted, true);
  release();
  await assert.rejects(p, /közben leállt/);
  assert.ok(s0.stopped, 'a későn megérkezett munkamenet is leáll');
  x.gate.hold = null;
  await x.k.voiceStart({ engine: 'codex', sdp: OFFER });
  x.k.cancelAll({ cleanupNow: true });
  assert.deepStrictEqual(x.sessions[1].stopOpts, { now: true });
  assert.strictEqual(x.k.voiceActive, false);
});

test('index: lockStop (zárolás, háttérbe rejtett ablak) – az élő hang azonnal leáll, a felület closed állapotot kap, a futó kör is leáll', async () => {
  const x = makeKapu();
  x.k.setConfig({ on: true, engine: 'codex' });
  await x.k.storeToken('kapu-token-0123456789', { officeId: 3, userId: 9 });
  await x.k.voiceStart({ engine: 'codex', sdp: OFFER });
  await x.k.send({ text: 'Mi jár le a héten?' });
  const textRun = x.runs[x.runs.length - 1];
  assert.strictEqual(textRun.cancelled, false);
  x.k.lockStop();
  assert.strictEqual(x.k.voiceActive, false);
  assert.ok(x.sessions[0].stopped);
  assert.deepStrictEqual(x.sessions[0].stopOpts, { now: true });
  assert.strictEqual(textRun.cancelled, true);
  assert.deepStrictEqual(x.voiceEvents.filter((e) => e.type === 'state').map((e) => e.state), ['closed']);
  // Hang nélkül is biztonságosan hívható (többszöri zárolás).
  x.k.lockStop();
  assert.deepStrictEqual(x.voiceEvents.filter((e) => e.type === 'state').map((e) => e.state), ['closed']);
});
