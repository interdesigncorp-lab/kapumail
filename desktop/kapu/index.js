'use strict';
// Kapu-chat: a modulok összefogása az asztali híd számára (main.js csak az IPC-t köti be).
// Electron nélkül tesztelhető: a titkosítást, a konfigurációt, a titoktárat, a hatókör lekérdezését és
// az események továbbítását a hívó adja. Feladata:
//  - a hatókör (iroda + felhasználó): a szerver mondja meg a felület munkamenetéből (`GET /api/kapu/me`,
//    `resolveScope`), a felület által küldött azonosítóban nem bízunk; navigációkor (`resetScope`) törlődik;
//  - az előzmények és a Kapu-token felhasználónként külön (`kapu:mcp-token:<officeId>-<userId>`);
//  - a beállítás (`kapu: {on, engine, readAloud, model: {<motor>: <modell>}}`);
//  - modellválasztás (models.js): beszélgetésenként tárolva, motoronkénti alapértékkel a beállításban; a CLI-nek
//    csak az engedélyezett listán lévő modell megy (models.resolve), ismeretlen azonosító hibát ad;
//  - körök indítása beszélgetésenként: új kérdés előtt a futó kör leáll (megszakít és lecserél);
//  - törléskor a CLI-oldali munkamenet is törlődik (forgetSession); induláskor sweep;
//  - élő hang (voiceStart/voiceStop): egyszerre egy, ChatGPT-vel (voice-codex, WebRTC) vagy Antigravityvel
//    (voice-agy, PCM a felület és a főfolyamat között: voiceAudio be, audio/clear események ki); az elhangzott
//    kérdések a szöveges körön át futnak (voice-bridge), navigációkor, kikapcsoláskor és kilépéskor leáll.

const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('./store');
const { createVoiceBridge } = require('./voice-bridge');

const TOKEN_RE = /^[\x21-\x7e]{8,512}$/;
const PROMPT_ID_RE = /^[a-zA-Z0-9_-]{1,48}$/;
const MAX_PROMPTS = 50;
const MAX_QUESTION = 8000;
const MIC_PER_SEC = 50;
const posInt = (v) => Number.isSafeInteger(v) && v > 0;

function cleanPrompts(list, strict = false) {
  if (!Array.isArray(list)) { if (strict) throw new Error('Hibás gyors prompt lista.'); return []; }
  if (strict && list.length > MAX_PROMPTS) throw new Error(`Legfeljebb ${MAX_PROMPTS} gyors prompt menthető.`);
  const out = [], seen = new Set();
  for (const raw of list.slice(0, MAX_PROMPTS)) {
    const id = raw && typeof raw.id === 'string' ? raw.id.trim() : '';
    const title = raw && typeof raw.title === 'string' ? raw.title.trim().slice(0, 120) : '';
    const prompt = raw && typeof raw.prompt === 'string' ? raw.prompt.trim().slice(0, 2000) : '';
    if (!PROMPT_ID_RE.test(id) || !title || !prompt || seen.has(id)) {
      if (strict) throw new Error('Adj meg érvényes címet és promptot.');
      continue;
    }
    seen.add(id);
    out.push({ id, title, prompt });
  }
  return out;
}

function scopeKey(scope) {
  if (!scope || !posInt(scope.officeId) || !posInt(scope.userId)) throw new Error('Érvénytelen iroda- vagy felhasználóazonosító.');
  return `${scope.officeId}-${scope.userId}`;
}
const tokenRef = (scope) => `kapu:mcp-token:${scopeKey(scope)}`;

function createKapu({
  userData, encrypt, decrypt, readCfg, saveCfg, readSecret, writeSecret, deleteSecret = () => {}, mcpBase, resolveScope, emit = () => {},
  emitVoice = () => {},
  // Szakmai MCP (premium.js create()): {get, notice, reset}; null = nincs (a kör csak a kapumail szerverrel fut).
  premium = null,
  startRun = require('./run').startRun,
  startVoice = (o) => require('./voice-codex').startCodexVoice(o),
  startAgyVoice = (o) => require('./voice-agy').startAgyVoice(o),
  isolation = require('./isolation'),
  providers = require('./providers'),
  models = require('./models'),
  hiddenSignIn = require('./signin').create(),
}) {
  const ENGINES = providers.ENGINES;
  let scope = null;
  let store = null;
  let epoch = 0; // minden hatókör-váltásnál nő; a régebbi körök eseményei nem jutnak tovább
  let pending = null;
  const running = new Map(); // convId -> az éppen futó kör (egy beszélgetésben egyszerre egy)
  let voice = null; // az élő hang: {session, bridge}
  const liveModels = { claude: null, codex: null, agy: null }; // motoronkénti élő modell-azonosítók (induláskor és belépéskor frissítve)
  const liveTried = { claude: false, codex: false, agy: false };
  const livePending = { claude: null, codex: null, agy: null };
  const wasSigned = { claude: null, codex: null, agy: null };

  function stopTurn(convId, opts) {
    const t = running.get(convId);
    if (!t) return false;
    running.delete(convId);
    try { t.handle.cancel(opts); } catch { /* már leállt */ }
    return true;
  }
  function cancelAll(opts) {
    voiceStop({ now: !!(opts && opts.cleanupNow) });
    for (const id of [...running.keys()]) stopTurn(id, opts);
  }

  /**
   * Zárolás (tétlenség, a gép zárképernyője, alvás) és a háttérbe rejtett ablak: az élő hang azonnal leáll (a felület
   * ablaka a `closed` állapotra bezárul), a futó szöveges körök is. A főfolyamat hívja közvetlenül, nem IPC-n át,
   * mert zárolt állapotban a felület hívásai tiltva vannak.
   */
  function lockStop() {
    voiceStop({ now: true });
    // A felület „gondolkodik” állapota is véget érjen (feloldás után ne pörögjön tovább): záró hibaesemény.
    for (const id of [...running.keys()]) {
      const text = 'Zárolás miatt leállt.';
      try { if (store) store.append(id, { role: 'system', text }); } catch { /* a beszélgetést közben törölték */ }
      try { emit({ type: 'error', code: 'failed', text, convId: id }); } catch { /* nincs ablak */ }
      stopTurn(id);
    }
  }

  function voiceStop({ now = false } = {}) {
    const v = voice;
    if (!v) return { ok: true, stopped: false };
    voice = null;
    v.stopped = true;
    try { v.abort.abort(); } catch { /* már megszakítva */ } // indulás közben: nincs új codex, a zár és a mappa felszabadul
    try { v.bridge.close(); } catch { /* már zárva */ }
    if (v.session) { try { v.session.stop({ now }); } catch { /* már leállt */ } }
    try { emitVoice({ type: 'state', state: 'closed' }); } catch { /* nincs ablak */ }
    return { ok: true, stopped: true };
  }

  /** Kijelentkezés, belépőoldal, másik felhasználó: a futó körök leállnak, a hatókört újra le kell kérdezni. */
  function resetScope() {
    cancelAll();
    scope = null;
    store = null;
    pending = null;
    epoch++;
    if (premium) { try { premium.reset(); } catch { /* nincs mit törölni */ } } // a token irodához kötött
  }

  /** A kör szakmai MCP-tokenje ({url, token}) vagy null; soha nem dob, és a kört nem állítja meg. */
  async function premiumFor() {
    if (!premium) return { value: null, note: null };
    let p = null;
    try { p = await premium.get(); } catch { p = null; }
    let note = null;
    try { note = premium.notice(); } catch { note = null; }
    return { value: p && typeof p.url === 'string' && typeof p.token === 'string' ? { url: p.url, token: p.token } : null, note };
  }

  function useScope(next) {
    const key = scopeKey(next);
    if (scope && scopeKey(scope) === key) return;
    resetScope();
    scope = { officeId: next.officeId, userId: next.userId };
    store = createStore({ dir: path.join(userData, 'kapu', key), encrypt, decrypt });
  }

  /** A szervertől kérdezett hatókör (gyorsítótárazva, amíg nincs navigáció). */
  async function ready() {
    if (scope) return { scope, store };
    if (!pending) {
      const ep = epoch;
      const p = (async () => {
        let s;
        try { s = await resolveScope(); } catch { s = null; }
        if (ep !== epoch) throw new Error('Közben megváltozott a bejelentkezés, próbáld újra.');
        if (!s || !posInt(s.officeId) || !posInt(s.userId)) throw new Error('Nem vagy bejelentkezve, vagy a szerver nem érhető el.');
        useScope(s);
      })();
      pending = p;
      p.catch(() => {}).finally(() => { if (pending === p) pending = null; });
    }
    await pending;
    if (!scope) throw new Error('Közben megváltozott a bejelentkezés, próbáld újra.');
    return { scope, store };
  }

  function config() {
    const c = (readCfg() || {}).kapu || {};
    const model = {};
    if (c.model && typeof c.model === 'object') {
      for (const e of ENGINES) if (typeof c.model[e] === 'string' && models.MODEL_RE.test(c.model[e])) model[e] = c.model[e];
    }
    return {
      on: c.on === true,
      engine: ENGINES.includes(c.engine) ? c.engine : null,
      readAloud: c.readAloud === true,
      model,
      ...(Array.isArray(c.prompts) ? { prompts: cleanPrompts(c.prompts) } : {}),
    };
  }
  const liveOf = (engine) => liveModels[engine] || undefined;
  /** Egy motor élő modelljeinek lekérése (párhuzamos hívások összevonásával); hibánál az ismert tartalék marad. */
  async function refreshEngine(engine, { force = false } = {}) {
    if (!ENGINES.includes(engine)) return;
    if (!force && (liveModels[engine] || liveTried[engine])) return;
    if (livePending[engine] && !force) return livePending[engine];
    const p = (async () => {
      liveTried[engine] = true;
      try {
        if (engine === 'agy') {
          const r = await providers.status('agy');
          if (r && Array.isArray(r.models) && r.models.length) liveModels.agy = r.models;
        } else if (typeof providers.fetchModels === 'function') {
          const ids = await providers.fetchModels(engine, { userData, force });
          if (Array.isArray(ids) && ids.length) liveModels[engine] = ids;
        }
      } catch { /* ismert tartaléklista */ }
    })();
    livePending[engine] = p;
    try { await p; } finally { if (livePending[engine] === p) livePending[engine] = null; }
  }
  async function ensureLive(onlyEngine) {
    const list = onlyEngine ? [onlyEngine] : ENGINES.filter((e) => e === 'agy' || typeof providers.fetchModels === 'function');
    await Promise.all(list.map((e) => refreshEngine(e)));
  }
  /** A ténylegesen futó modell: a kért (ha engedélyezett), a motor beállított alapja, vagy a kiegyensúlyozott. */
  function effectiveModel(engine, wanted) {
    const live = liveOf(engine);
    return models.resolve(engine, wanted, live) || models.resolve(engine, config().model[engine], live) || models.resolve(engine, models.defaultModel(engine, live), live);
  }
  async function checkModel(engine, id) {
    if (models.resolve(engine, id, liveOf(engine))) return id;
    await ensureLive(engine);
    if (models.resolve(engine, id, liveOf(engine))) return id;
    throw new Error('Ismeretlen modell.');
  }
  function setConfig(patch = {}) {
    const next = { ...config() };
    if ('on' in patch) next.on = patch.on === true;
    if ('readAloud' in patch) next.readAloud = patch.readAloud === true;
    if ('engine' in patch) {
      if (patch.engine !== null && !ENGINES.includes(patch.engine)) throw new Error('Ismeretlen motor.');
      next.engine = patch.engine;
    }
    if ('model' in patch) {
      // {engine, id}: a motor alapmodellje (id null: a kiegyensúlyozott). Csak engedélyezett azonosító.
      const m = patch.model || {};
      if (!ENGINES.includes(m.engine)) throw new Error('Ismeretlen motor.');
      next.model = { ...next.model };
      if (m.id === null) delete next.model[m.engine];
      else if (models.resolve(m.engine, m.id, liveOf(m.engine))) next.model[m.engine] = m.id;
      else throw new Error('Ismeretlen modell.');
    }
    if ('prompts' in patch) {
      if (patch.prompts === null) delete next.prompts;
      else next.prompts = cleanPrompts(patch.prompts, true);
    }
    const wasOn = config().on;
    saveCfg({ kapu: next });
    if (!next.on) cancelAll();
    // Kikapcsolás: a gépen tárolt Kapu-token törlődik (a szerveren a felület vonja vissza: DELETE /api/kapu/token),
    // újra bekapcsoláskor friss token kerül a titoktárba.
    if (wasOn && !next.on) forgetToken();
    return next;
  }
  function forgetToken() {
    const drop = (s) => { try { deleteSecret(tokenRef(s)); } catch { /* nincs mit törölni */ } };
    if (scope) { drop(scope); return; }
    ready().then(({ scope: s }) => drop(s), () => { /* nincs bejelentkezve: nincs ismert token */ });
  }

  const tokenOf = (s) => { const t = readSecret(tokenRef(s)); return typeof t === 'string' && TOKEN_RE.test(t) ? t : null; };
  async function hasToken() { const { scope: s } = await ready(); return tokenOf(s) !== null; }
  /** A token csak akkor kerül a titoktárba, ha a szerver ugyanannak a felhasználónak adta ki, akinek a hatóköre él. */
  async function storeToken(t, ids = {}) {
    if (typeof t !== 'string' || !TOKEN_RE.test(t)) throw new Error('Hibás Kapu-token.');
    const { scope: s } = await ready();
    if (!ids || ids.officeId !== s.officeId || ids.userId !== s.userId) throw new Error('A token nem ehhez a bejelentkezéshez tartozik.');
    writeSecret(tokenRef(s), t);
    return true;
  }

  async function status() {
    return Promise.all(ENGINES.map(async (engine) => {
      try {
        const r = await providers.status(engine);
        const signed = !!(r && r.signedIn);
        const justConnected = wasSigned[engine] === false && signed;
        wasSigned[engine] = signed;
        if (engine === 'agy' && r && Array.isArray(r.models) && r.models.length) {
          liveModels.agy = r.models;
          liveTried.agy = true;
        } else if (signed && (justConnected || !liveTried[engine])) {
          await refreshEngine(engine, { force: justConnected });
        } else if (engine === 'claude' && !liveTried.claude && r && r.installed) {
          await refreshEngine('claude');
        }
        if (r && 'models' in r) { const { models: _m, ...rest } = r; return rest; }
        return r;
      } catch { return { engine, installed: false, signedIn: false, error: 'Az állapot nem kérdezhető le.' }; }
    }));
  }

  /** Alkalmazásindításkor a háttérben előmelegíti a motorállapotokat és az élő modellkatalógust. */
  async function warmup() {
    await status().catch(() => {});
  }

  /** A választó: motoronként {options:[{id,label,hint}], default, selected} (selected: a beállított alap). */
  async function modelCatalog() {
    await ensureLive();
    const cat = models.catalog(ENGINES, liveModels);
    const cfgModel = config().model;
    for (const e of ENGINES) {
      const sel = models.resolve(e, cfgModel[e], liveOf(e));
      cat[e].selected = sel ? sel.id : cat[e].default;
    }
    return cat;
  }

  /** A beszélgetés modelljének átállítása (a következő kérdéstől). */
  async function setModel(convId, id) {
    const { store: st } = await ready();
    const conv = st.get(String(convId));
    if (!conv) throw new Error('Nincs ilyen beszélgetés.');
    await checkModel(conv.engine, id);
    st.setModel(conv.id, id);
    return { ok: true, model: id };
  }

  const signInDir = () => path.join(userData, 'kapu', 'signin');
  // Belépés: először rejtett tmux-munkamenetben (a parancs maga nyitja meg a böngészőt, a visszahívás helyi);
  // ha ez nem érhető el (nincs tmux, Windows), a régi út: látható Terminál-ablak a belépőparanccsal.
  async function signIn(engine) {
    if (!ENGINES.includes(engine)) throw new Error('Ismeretlen motor.');
    // A providers.signInCommand szöveget ad (pl. „claude auth login”); a régi {bin, args} alakot is elfogadjuk.
    const cmd = providers.signInCommand(engine);
    const command = typeof cmd === 'string' ? cmd : [cmd.bin, ...(cmd.args || [])].join(' ');
    const h = await hiddenSignIn.start(engine).catch((e) => ({ ok: false, error: e && e.message }));
    if (h && h.ok) return { ok: true, command, hidden: true };
    if (h && h.error && !h.unavailable) return { ok: false, command, error: h.error };
    try {
      await providers.openSignIn(engine, { dir: signInDir() });
      return { ok: true, command };
    } catch (e) {
      return { ok: false, command, error: (e && e.message) || 'A terminál nem nyílt meg.' };
    }
  }
  /** A rejtett belépés állapota: {running, engine, url, needsCode}. */
  const signInState = () => hiddenSignIn.state();
  /** A szolgáltató oldalán kapott kód továbbítása a rejtett belépésnek. */
  const signInCode = (code) => hiddenSignIn.code(code);
  /** A belépőoldal újranyitásához: csak a futó belépés szolgáltatójának saját címe engedett. */
  const signInUrlOk = (u) => hiddenSignIn.okUrl(u);
  /** Mégse vagy kész: a rejtett munkamenet leáll, a belépőfájlok törlődnek (a Terminál-ablakot a felhasználó zárja be). */
  async function cancelSignIn() {
    await hiddenSignIn.stop().catch(() => {});
    fs.rmSync(signInDir(), { recursive: true, force: true });
    return { ok: true };
  }

  function forget(gone) {
    if (gone && gone.sessionId) { try { isolation.forgetSession(userData, gone.engine, gone.sessionId); } catch { /* következő sweep */ } }
  }

  async function send({ convId, text, voice: spoken, model: wanted } = {}) {
    const { scope: s, store: st } = await ready();
    const cfg = config();
    if (!cfg.on) throw new Error('A Kapu ki van kapcsolva.');
    const question = typeof text === 'string' ? text.trim() : '';
    if (!question) throw new Error('Üres kérdés.');
    if (question.length > MAX_QUESTION) throw new Error(`A kérdés legfeljebb ${MAX_QUESTION} karakter lehet.`);
    const t = tokenOf(s);
    if (!t) throw new Error('Hiányzik a Kapu-token: kapcsold ki és be a Kaput a Beállításokban.');
    const sendEpoch = epoch;
    const prem = await premiumFor();
    if (sendEpoch !== epoch) throw new Error('Megszakítva: közben másik felhasználó lépett be.');
    let conv;
    if (convId != null) {
      conv = st.get(convId);
      if (!conv) throw new Error('Nincs ilyen beszélgetés.');
    }
    const engine = conv ? conv.engine : cfg.engine;
    if (!engine) throw new Error('Válassz motort a Beállításokban.');
    // A kért modell csak az engedélyezett listáról jöhet; ismeretlen azonosítóval a kör el sem indul.
    if (wanted !== undefined && wanted !== null && wanted !== '') await checkModel(engine, wanted);
    else wanted = null;
    if (!conv) conv = st.get(st.create(engine, wanted || (effectiveModel(engine, null) || {}).id || null));
    else if (wanted && wanted !== conv.model) { st.setModel(conv.id, wanted); conv.model = wanted; }
    if (conv.model && !models.resolve(conv.engine, conv.model, liveOf(conv.engine))) await ensureLive(conv.engine);
    const runModel = effectiveModel(conv.engine, conv.model);
    const id = conv.id;
    stopTurn(id); // megszakít és lecserél: az új kérdés előtt a futó kör leáll
    st.append(id, { role: 'user', text: question, ...(spoken === true ? { voice: true } : {}) });
    if (prem.note) st.append(id, { role: 'system', text: prem.note });

    const turn = { handle: null, epoch };
    let confirmId;
    const onEvent = (ev) => {
      if (!ev || typeof ev.type !== 'string') return;
      // A munkamenet akkor is mentődik (a kör saját tárolójába), ha a kört közben leállították: így a CLI fájljai később törölhetők.
      if (ev.type === 'session') {
        if (!st.setSession(id, ev.id)) forget({ engine: conv.engine, sessionId: ev.id });
      }
      if (turn.epoch !== epoch || running.get(id) !== turn) return; // leállított vagy korábbi hatókörbeli kör
      if (ev.type === 'confirm') confirmId = ev.id;
      if (ev.type === 'final' || ev.type === 'error') {
        running.delete(id);
        try {
          if (ev.type === 'final') st.append(id, { role: 'kapu', text: ev.text, ...(confirmId ? { confirmId } : {}), ...(spoken === true ? { voice: true } : {}), ...(runModel ? { model: runModel.id } : {}) });
          else st.append(id, { role: 'system', text: ev.text || 'Hiba történt.' });
        } catch { /* a beszélgetést közben törölték */ }
      }
      emit({ ...ev, convId: id });
      if (voice) { try { voice.bridge.event({ ...ev, convId: id }); } catch { /* a hang már zárva */ } }
    };
    running.set(id, turn);
    turn.handle = startRun({
      engine: conv.engine, message: question, sessionId: conv.sessionId || undefined, model: runModel ? runModel.argv : undefined,
      conv: { userData, mcp: { ...mcpBase(), token: t }, premium: prem.value }, onEvent,
    });
    return { convId: id };
  }

  /**
   * Élő hang indítása: {engine, sdp?, convId?} → ChatGPT: {sdpAnswer, convId} (a felület SDP-ajánlatára a
   * codex válasza); Antigravity: {convId, mode:'pcm'} (a mikrofon a voiceAudio-n jön, Kapu hangja `audio`
   * eseményként megy). Az átiratokat, az állapotot és a jóváhagyást az emitVoice eseményei viszik a felületre.
   */
  async function voiceStart({ engine, sdp, convId } = {}) {
    const { scope: s, store: st } = await ready();
    const cfg = config();
    if (!cfg.on) throw new Error('A Kapu ki van kapcsolva.');
    if (!tokenOf(s)) throw new Error('Hiányzik a Kapu-token: kapcsold ki és be a Kaput a Beállításokban.');
    let conv = null;
    if (convId != null) {
      conv = st.get(String(convId));
      if (!conv) throw new Error('Nincs ilyen beszélgetés.');
    }
    const eng = conv ? conv.engine : engine;
    if (eng === 'claude') throw new Error('Hangon ChatGPT-vel vagy Antigravityvel beszélhetsz.');
    if (eng !== 'codex' && eng !== 'agy') throw new Error('Válassz motort a Beállításokban.');
    if (!conv && cfg.engine !== eng) throw new Error(`Az új beszélgetés motorja nem ${eng === 'agy' ? 'az Antigravity' : 'a ChatGPT'}.`);
    voiceStop();
    const history = conv ? conv.messages
      .filter((m) => m.role === 'user' || m.role === 'kapu')
      .map((m) => ({ role: m.role === 'kapu' ? 'assistant' : 'user', text: m.text })) : [];
    const v = { session: null, stopped: false, epoch, abort: new AbortController() };
    const out = (ev) => { if (voice === v || ev.type === 'state') { try { emitVoice(ev); } catch { /* nincs ablak */ } } };
    v.bridge = createVoiceBridge({
      convId: conv ? conv.id : null,
      send: ({ convId: cid, text }) => send({ convId: cid, text, voice: true }),
      say: (t) => (v.session ? v.session.say(t) : false),
      emit: out,
    });
    voice = v;
    let session;
    try {
      const start = eng === 'agy' ? startAgyVoice : startVoice;
      session = await start({
        ...(eng === 'agy' ? {} : { sdpOffer: sdp }), userData, history, signal: v.abort.signal,
        onEvent: (ev) => {
          if (voice !== v || !ev) return;
          if (ev.type === 'audio') { if (typeof ev.pcm === 'string') out({ type: 'audio', pcm: ev.pcm }); return; }
          if (ev.type === 'clear') { out({ type: 'clear' }); return; }
          if (ev.type === 'transcript') { out({ type: 'transcript', role: ev.role, text: ev.text }); v.bridge.transcript(ev.role, ev.text); return; }
          if (ev.type === 'speaking') { out({ type: 'speaking', role: ev.role }); return; }
          if (ev.type === 'closed' || ev.type === 'error') {
            voice = null;
            v.bridge.close();
            out({ type: 'state', state: ev.type === 'error' ? 'error' : 'closed', ...(ev.text ? { text: ev.text } : {}) });
          }
        },
      });
    } catch (e) {
      if (voice === v) voice = null;
      v.bridge.close();
      if (v.stopped) throw new Error('Az élő beszélgetés közben leállt.');
      throw e;
    }
    v.session = session;
    if (voice !== v || v.stopped || v.epoch !== epoch) { try { session.stop(); } catch { /* már leállt */ } throw new Error('Az élő beszélgetés közben leállt.'); }
    if (eng === 'agy') return { convId: conv ? conv.id : null, mode: 'pcm' };
    return { sdpAnswer: session.answer, convId: conv ? conv.id : null };
  }

  /** Az Antigravity-hang mikrofonja: 16 kHz mono s16le base64-ben, ~60 ms-onként. */
  const micRate = { at: 0, n: 0 };
  function voiceAudio(b64) {
    const s = voice && voice.session;
    if (!s || typeof s.pushMic !== 'function' || typeof b64 !== 'string' || !b64) return { ok: false };
    // Legfeljebb 50 darab másodpercenként (a felület 60 ms-onként küld): a többi elmarad.
    const now = Date.now();
    if (now - micRate.at >= 1000) { micRate.at = now; micRate.n = 0; }
    if (++micRate.n > MIC_PER_SEC) return { ok: false };
    return { ok: s.pushMic(b64) === true };
  }

  /** A hangréteg jóváhagyó kártyáján „Mégse”: a hangmodell megtudja, hogy nem állítunk át semmit. */
  function voiceDeclined() {
    if (!voice) throw new Error('Nincs élő beszélgetés.');
    return { ok: voice.bridge.declined() };
  }

  /** Gépelt szöveg az élő beszélgetésbe (a jóváhagyó kártya „Mehet” gombja: „Jóváhagytam.”). */
  function voiceText(text) {
    if (!voice) throw new Error('Nincs élő beszélgetés.');
    const t = String(text || '').trim();
    const ok = voice.bridge.text(t);
    if (ok) { try { emitVoice({ type: 'transcript', role: 'user', text: t }); } catch { /* nincs ablak */ } }
    return { ok };
  }

  async function cancel(convId) { await ready(); return { ok: stopTurn(convId) }; }

  async function remove(convId) {
    const { store: st } = await ready();
    if (voice && voice.bridge.convId === convId) voiceStop();
    stopTurn(convId);
    const gone = st.remove(convId);
    forget(gone);
    return { ok: !!gone };
  }

  async function clear() {
    const { store: st } = await ready();
    cancelAll();
    for (const gone of st.clear()) forget(gone);
    return { ok: true };
  }

  return {
    start() { try { isolation.sweep(userData); } catch { /* következő indításkor */ } },
    warmup,
    resetScope, config, setConfig, hasToken, storeToken, status, signIn, signInState, signInCode, signInUrlOk, cancelSignIn, lockStop, modelCatalog, setModel,
    scope: async () => ({ ...(await ready()).scope }),
    list: async () => (await ready()).store.list(),
    get: async (id) => (await ready()).store.get(id),
    send, cancel, cancelAll, remove, clear,
    voiceStart, voiceStop, voiceText, voiceDeclined, voiceAudio,
    get voiceActive() { return voice !== null; },
  };
}

module.exports = { createKapu, scopeKey, tokenRef };
