'use strict';
// Kapu-chat: élő hang ChatGPT-vel. A felhasználó saját codex parancssora
// `codex app-server --listen stdio:// --enable realtime_conversation` módban fut, JSON-RPC-vel a szabványos
// be- és kimeneten: initialize → account/read (csak ChatGPT-fiók) → config/read → thread/start (eszköz,
// MCP, web nélkül) → thread/realtime/start WebRTC-vel. A hang a felület RTCPeerConnection-je és az OpenAI
// között megy; a főfolyamat csak az SDP-t adja át, és fejlesztői szöveget fűz a beszélgetéshez (say).
// Elszigetelés: saját, ideiglenes CODEX_HOME (isolation.prepareCodexVoice), az API-kulcsok kiszűrve; a
// belépés másolata a kapcsolat felépülése után törlődik, a mappa a beszélgetés végén.
// Elektron nélküli modul: a folyamatindítás és az elszigetelés tesztből állítható.

const nodeSpawn = require('node:child_process').spawn;
const { resolveBin, launch } = require('./providers');
const isolation = require('./isolation');
const { killTree } = require('./run');

const RPC_TIMEOUT_MS = 15000;
const ANSWER_TIMEOUT_MS = 15000;
const MAX_SESSION_MS = 30 * 60 * 1000;
const STOP_GRACE_MS = 600; // a realtime/stop és a bemenet lezárása után ennyit vár a magától kilépésre
const KILL_GRACE_MS = 2000;
const MAX_TEXT = 12000;

const ERR = {
  missing: 'A ChatGPT (codex) nincs telepítve ezen a gépen.',
  signed_out: 'ChatGPT: nem vagy belépve. Lépj be a Kapu beállításainál.',
  not_chatgpt: 'Az élő beszélgetéshez ChatGPT-fiókkal kell belépni a codexbe (API-kulccsal nem megy).',
  config: 'A codex beállítása (saját szolgáltató vagy realtime-cím) nem engedi az élő beszélgetést.',
  failed: 'Az élő beszélgetés most nem indult el. Próbáld újra.',
};

function voiceError(code, text) {
  const e = new Error(text || ERR[code] || ERR.failed);
  e.code = code;
  return e;
}

const INSTRUCTIONS = [
  'Te Kapu vagy, a KapuMail könyvelőirodai alkalmazás asszisztense, az iroda iratfelelőse. A neved Kapu; a ChatGPT csak a hangot adó motor.',
  'Magyarul beszélj, tegeződve, röviden és barátságosan. Felsorolást, linket, Markdownt ne mondj fel; azonosítókat ne olvass fel.',
  'Az iroda adataihoz (iratok, határidők, ügyfelek, beállítások) te közvetlenül nem férsz hozzá. A felhasználó minden befejezett mondatát a KapuMail automatikusan továbbítja Kapu szöveges motorjának, amely eléri az iroda adatait.',
  'Ezért kérdésre csak nagyon röviden nyugtázz (például „Megnézem.”), és várd meg a „KapuMail eredménye” kezdetű fejlesztői üzenetet. Abból válaszolj tömören, a saját szavaiddal. Soha ne találj ki adatot, és ne mondd, hogy nem férsz hozzá: várd meg az eredményt.',
  'Beállítás módosítását csak a felhasználó hagyhatja jóvá a képernyőn megjelenő kártyán; ilyenkor mondd: „Jóváhagyás kell, a képernyőn látod.”',
].join('\n');

/**
 * startCodexVoice({sdpOffer, onEvent, userData, history?, instructions?, voice?,
 *                  env?, platform?, bin?, spawn?, sourceHome?, rpcTimeoutMs?, answerTimeoutMs?, maxSessionMs?})
 *   → Promise<{answer, stop(), say(text), closed}>
 * Események (onEvent): {type:'transcript', role:'user'|'assistant', text} · {type:'speaking', role} (első delta) ·
 *   {type:'closed'} · {type:'error', text}. Minden munkamenetnek pontosan egy záró eseménye van (closed vagy error),
 *   kivéve ha a hívó állította le (stop) – akkor closed.
 * Hiba esetén `code`-dal ellátott Error: 'missing' | 'signed_out' | 'not_chatgpt' | 'config' | 'failed'.
 */
async function startCodexVoice({
  sdpOffer, onEvent = () => {}, userData, history = [], instructions = INSTRUCTIONS, voice,
  env = process.env, platform = process.platform, bin: binOpt, spawn = nodeSpawn, sourceHome,
  rpcTimeoutMs = RPC_TIMEOUT_MS, answerTimeoutMs = ANSWER_TIMEOUT_MS, maxSessionMs = MAX_SESSION_MS,
  prepare = isolation.prepareCodexVoice, signal,
} = {}) {
  if (typeof sdpOffer !== 'string' || !/^v=0/.test(sdpOffer) || sdpOffer.length > 200000) throw voiceError('failed', 'Hibás hangajánlat (SDP).');
  const bin = binOpt || resolveBin('codex', env, platform);
  if (!bin) throw voiceError('missing');
  let prep;
  try {
    if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' });
    prep = await prepare({ userData, env, platform, sourceHome, signal });
  } catch (e) {
    if (signal && signal.aborted) throw voiceError('aborted', 'Az élő beszélgetés indítása megszakítva.');
    throw voiceError(e && e.code === 'signed_out' ? 'signed_out' : 'failed', e && e.code === 'signed_out' ? ERR.signed_out : undefined);
  }

  let child = null;
  let closed = false; // a folyamat (vagy a munkamenet) véget ért
  let ready = false;
  let threadId = null;
  let answer = null;
  let wake = null;
  let seq = 0;
  let buf = '';
  let sessionTimer = null;
  const pending = new Map();
  const partial = {};
  const active = new Set();
  const last = {};

  const emit = (ev) => { try { onEvent(ev); } catch { /* a hívó hibája nem állítja meg a hangot */ } };
  const rejectAll = () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(voiceError('failed')); }
    pending.clear();
  };
  const send = (value) => {
    if (closed || !child || !child.stdin || child.stdin.destroyed) return;
    try { child.stdin.write(`${JSON.stringify(value)}\n`); } catch { /* lent: exit */ }
  };
  let exited = false;
  const terminate = (now) => {
    if (!child || exited) return;
    const c = child;
    if (now) { killTree(c, 'SIGTERM', platform, spawn); removeHome(); }
    const t1 = setTimeout(() => killTree(c, 'SIGTERM', platform, spawn), now ? 0 : STOP_GRACE_MS);
    const t2 = setTimeout(() => killTree(c, 'SIGKILL', platform, spawn), STOP_GRACE_MS + KILL_GRACE_MS);
    if (t1.unref) t1.unref();
    if (t2.unref) t2.unref();
    c.once('exit', () => { clearTimeout(t1); clearTimeout(t2); });
  };
  // A mappa a folyamat kilépése után törlődik (addig a codex még írhat bele); a belépés másolata azonnal.
  const removeHome = () => { try { prep.cleanup(); } catch { /* sweep */ } };
  // Egyetlen lezárás: folyamat le, belépés-másolat és mappa törölve, egy záró esemény.
  const finish = (ev, now = false) => {
    if (closed) return;
    if (threadId && child) { try { child.stdin.write(`${JSON.stringify({ id: ++seq, method: 'thread/realtime/stop', params: { threadId } })}\n`); } catch { /* már zárva */ } }
    closed = true;
    clearTimeout(sessionTimer);
    rejectAll();
    if (wake) wake();
    try { child && child.stdin && child.stdin.end(); } catch { /* már zárva */ }
    try { prep.releaseAuth(); } catch { /* cleanup úgyis törli */ }
    if (!child || exited) removeHome(); else terminate(now);
    if (ready && ev) emit(ev);
  };

  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (closed) return reject(voiceError('failed'));
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(voiceError('failed')); }, rpcTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });

  const onNotify = (method, p) => {
    if (!p || typeof p !== 'object') return;
    if (!threadId || p.threadId !== threadId) return;
    if (method === 'thread/realtime/sdp' && typeof p.sdp === 'string') { answer = p.sdp; if (wake) wake(); return; }
    if (!ready) {
      if (method === 'thread/realtime/error' || method === 'thread/realtime/closed') finish(null);
      return;
    }
    if (method === 'thread/realtime/error') return finish({ type: 'error', text: 'Megszakadt az élő beszélgetés.' });
    if (method === 'thread/realtime/closed') return finish({ type: 'closed' });
    const role = p.role === 'user' || p.role === 'assistant' ? p.role : null;
    if (!role) return;
    if (method === 'thread/realtime/transcript/delta' && typeof p.delta === 'string') {
      if (!active.has(role)) emit({ type: 'speaking', role });
      active.add(role);
      partial[role] = ((partial[role] || '') + p.delta).slice(0, MAX_TEXT);
      return;
    }
    if (method === 'thread/realtime/transcript/done' && typeof p.text === 'string') {
      const text = p.text.slice(0, MAX_TEXT).trim();
      // Az ismételt befejező értesítés nem új kérés; új delta után ugyanaz a mondat újra számít.
      if (!text || (!active.has(role) && last[role] === text)) return;
      active.delete(role);
      delete partial[role];
      last[role] = text;
      emit({ type: 'transcript', role, text });
    }
  };

  const onLine = (line) => {
    let v;
    try { v = JSON.parse(line); } catch { return; }
    if (!v || typeof v !== 'object') return;
    if (v.id !== undefined && !v.method) {
      const p = pending.get(v.id);
      if (!p) return;
      pending.delete(v.id);
      clearTimeout(p.timer);
      if (v.error) p.reject(Object.assign(voiceError('failed'), { rpc: v.error })); else p.resolve(v.result || {});
      return;
    }
    // A szerver kérésére (pl. jóváhagyás, eszközhívás) nem adunk engedélyt.
    if (v.id !== undefined && v.method) { send({ id: v.id, error: { code: -32601, message: 'unsupported' } }); return; }
    if (typeof v.method === 'string') onNotify(v.method, v.params || {});
  };

  // Megszakítás az indulás alatt (a felület feladta, navigáció, kilépés): nincs új folyamat, ami elindult,
  // azonnal leáll, a mappa szinkron törlődik, a codex-zár felszabadul.
  if (signal && signal.aborted) { try { prep.cleanup(); } catch { /* sweep */ } throw voiceError('aborted', 'Az élő beszélgetés indítása megszakítva.'); }
  const onAbort = () => { if (!ready) finish(null, true); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let cmd;
  try {
    cmd = launch(bin, ['app-server', '--listen', 'stdio://', '--enable', 'realtime_conversation',
      '-c', 'analytics.enabled=false', '-c', 'model_provider=openai'], platform);
    child = spawn(cmd.bin, cmd.args, {
      cwd: prep.cwd, env: prep.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      detached: platform !== 'win32', ...(cmd.verbatim ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (e) {
    try { prep.cleanup(); } catch { /* sweep */ }
    throw voiceError(e && e.code === 'ENOENT' ? 'missing' : 'failed');
  }
  const died = () => {
    if (closed) return;
    exited = true;
    finish(ready ? { type: 'error', text: 'A ChatGPT-hang leállt.' } : null);
  };
  child.on('error', died);
  child.on('exit', () => { exited = true; died(); removeHome(); });
  if (child.stdin) child.stdin.on('error', () => {});
  if (child.stderr) child.stderr.resume(); // a szolgáltató hibaüzenetei titkot is tartalmazhatnak: nem továbbítjuk
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); }
      if (buf.length > 4 << 20) buf = '';
    });
  }

  const alive = () => { if (closed) throw voiceError('failed'); };
  try {
    await rpc('initialize', { clientInfo: { name: 'kapumail_voice', version: '1.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    alive();
    send({ method: 'initialized' });
    const acc = await rpc('account/read', { refreshToken: false });
    alive();
    if (!acc.account) throw voiceError('signed_out');
    if (acc.account.type !== 'chatgpt') throw voiceError('not_chatgpt');
    const { config } = await rpc('config/read', { includeLayers: false });
    alive();
    if (!config || (config.model_providers && config.model_providers.openai) || config.experimental_realtime_ws_base_url || config.experimental_realtime_webrtc_call_base_url) {
      throw voiceError('config');
    }
    const started = await rpc('thread/start', {
      ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', baseInstructions: instructions,
      config: {
        'features.apps': false, 'features.memories': false, 'features.multi_agent': false, 'features.shell_tool': false, web_search: 'disabled',
        ...Object.fromEntries(Object.keys(config.mcp_servers || {}).map((n) => [`mcp_servers.${n}.enabled`, false])),
      },
    });
    alive();
    threadId = started.thread && typeof started.thread.id === 'string' ? started.thread.id : null;
    if (!threadId) throw voiceError('failed');
    const items = (Array.isArray(history) ? history : [])
      .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string' && h.text.trim())
      .slice(-12).map((h) => ({ role: h.role, text: h.text.slice(0, 1500) }));
    await rpc('thread/realtime/start', {
      threadId, version: 'v3', outputModality: 'audio', prompt: instructions,
      ...(voice ? { voice } : {}),
      initialItems: [{ role: 'developer', text: instructions }, ...items],
      transport: { type: 'webrtc', sdp: sdpOffer }, clientManagedHandoffs: true,
      includeStartupContext: false, flushTranscriptTailOnSessionEnd: false,
    });
    alive();
    if (!answer) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, answerTimeoutMs);
        wake = () => { clearTimeout(t); resolve(); };
      });
      wake = null;
    }
    alive();
    if (!answer) throw voiceError('failed');
  } catch (e) {
    finish(null);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (signal && signal.aborted) throw voiceError('aborted', 'Az élő beszélgetés indítása megszakítva.');
    throw e && e.code && ERR[e.code] ? voiceError(e.code, e.message) : voiceError('failed');
  }
  if (signal) signal.removeEventListener('abort', onAbort);
  // A kapcsolat él: a belépés másolata törlődik, a codex-zár felszabadul (a szöveges körök futhatnak).
  try { prep.releaseAuth(); } catch { /* cleanup úgyis törli */ }
  ready = true;
  sessionTimer = setTimeout(() => finish({ type: 'closed', reason: 'limit' }), maxSessionMs);
  if (sessionTimer.unref) sessionTimer.unref();

  let sayQueue = Promise.resolve();
  return {
    answer,
    get closed() { return closed; },
    get pid() { return child ? child.pid : undefined; },
    /** Fejlesztői szöveg a hangmodellnek (pl. a szöveges kör eredménye felolvasásra), sorban. */
    say(text) {
      const t = typeof text === 'string' ? text.slice(0, 16000) : '';
      if (!t) return Promise.resolve(false);
      sayQueue = sayQueue.then(async () => {
        if (closed) return false;
        await rpc('thread/realtime/appendText', { threadId, role: 'developer', text: t });
        return true;
      }).catch(() => false);
      return sayQueue;
    },
    /** now: kilépéskor azonnal (szinkron) leáll és töröl, nem vár a codex magától kilépésére. */
    stop({ now = false } = {}) { finish({ type: 'closed' }, now === true); },
  };
}

module.exports = { startCodexVoice, INSTRUCTIONS, ERR };
