'use strict';
// Kapu-chat: egy kör futtatása a választott CLI-vel (claude, codex, agy), fejléc nélkül, shell nélkül,
// elszigetelve (isolation.js), és a JSON-sorok egyszerű eseményekké alakítása:
//   {type:'session', id} · {type:'activity', text} · {type:'confirm', id} ·
//   {type:'final', text} | {type:'error', code:'signed_out'|'missing'|'timeout'|'mcp_off'|'failed', text}
// Minden körnek pontosan egy záró eseménye van (final vagy error), kivéve ha megszakították.
// Az ismeretlen JSON-sorokat figyelmen kívül hagyjuk (a CLI-k kimenete verzióról verzióra változhat).
// Elektron nélküli modul: a folyamatindítás, a korlát és a kulcskarika tesztből állítható.

const nodeSpawn = require('node:child_process').spawn;
const fs = require('node:fs');
const path = require('node:path');
const { ENGINE_LABEL, resolveBin, launch } = require('./providers');
const isolation = require('./isolation');
const { MODEL_RE } = require('./models');

const TURN_TIMEOUT_MS = 150000;
const KILL_GRACE_MS = 2000;
const SERVER = isolation.SERVER;
const CLAUDE_TOOL_PREFIX = `mcp__${SERVER}__`;
// A szakmai MCP (jogi és könyvelői eszközök): második szerver, ha a körhöz van token.
const PREMIUM_SERVER = isolation.PREMIUM_SERVER;
const CLAUDE_PREMIUM_PREFIX = `mcp__${PREMIUM_SERVER}__`;
const OWN_SERVERS = new Set([SERVER, PREMIUM_SERVER]);
/** A Claude-eszköznévből a saját szerverek eszközneve; idegen eszköznél ''. */
function claudeTool(name) {
  if (name === 'WebSearch') return 'WebSearch';
  if (name.startsWith(CLAUDE_TOOL_PREFIX)) return name.slice(CLAUDE_TOOL_PREFIX.length);
  if (name.startsWith(CLAUDE_PREMIUM_PREFIX)) return name.slice(CLAUDE_PREMIUM_PREFIX.length);
  return '';
}

let personaCache = null;
function persona() {
  if (personaCache === null) personaCache = fs.readFileSync(path.join(__dirname, 'persona.md'), 'utf8').trim();
  return personaCache;
}

// Eszköznév → mit lát a felhasználó, amíg Kapu dolgozik.
const ACTIVITY = {
  search_clients: 'Keresem az ügyfelet…',
  get_client: 'Megnézem az ügyfél adatait…',
  search_documents: 'Keresem az iratokat…',
  list_messages: 'Átnézem a beérkezett iratokat…',
  get_message: 'Megnyitom az iratot…',
  get_document_text: 'Olvasom az iratot…',
  list_deadlines: 'Megnézem a határidőket…',
  list_tasks: 'Megnézem a feladatokat…',
  list_users: 'Megnézem a munkatársakat…',
  get_settings: 'Megnézem a beállításokat…',
  update_settings: 'Előkészítem a beállítás módosítását…',
  app_guide: 'Utánanézek a súgóban…',
  connections_status: 'Megnézem a kapcsolatokat…',
  audit_log: 'Átnézem a naplót…',
  irat_teendok_elemzese: 'Elemzem az irat teendőit…',
  list_taxpayer_tables: 'Megnézem az adózói táblákat…',
  resolve_code: 'Feloldom a nyomtatvány- vagy adókódot…',
  resolve_tax_code: 'Feloldom a nyomtatvány- vagy adókódot…',
  // webes keresés
  WebSearch: 'Keresek a hivatalos oldalakon…',
  web_search: 'Keresek a hivatalos oldalakon…',
  search_web: 'Keresek a hivatalos oldalakon…',
  // szakmai MCP
  jog_kereses: 'Keresem a jogszabályt…',
  jog_szakasz: 'Megnézem a jogszabályhelyet…',
  jog_valtozasok: 'Megnézem a jogszabályváltozásokat…',
  jog_diff: 'Összevetem a jogszabály két állapotát…',
  jog_idoallapot_osszehasonlitas: 'Összevetem az anyagi és eljárási időállapotot…',
  official_exchange_rate: 'Megnézem a hivatalos MNB-árfolyamot…',
  official_vat_check: 'Ellenőrzöm a közösségi vagy hazai adószámot…',
  official_base_rate: 'Megnézem a jegybanki alapkamatot…',
  official_inflation: 'Megnézem a hivatalos inflációs adatokat…',
  official_teaor_lookup: 'Keresem a TEÁOR-kódot…',
  official_sources_search: 'Keresem a hivatalos könyvelői forrást…',
  official_source_get: 'Megnyitom a hivatalos forrást…',
  official_source_verify: 'Ellenőrzöm a forrás érvényességét…',
  official_source_history: 'Megnézem a forrás változásait…',
  official_source_status: 'Megnézem a források állapotát…',
  official_answer_check: 'Ellenőrzöm a választ a forrásokon…',
  ado_szamitas: 'Kiszámolom az adót és a járulékokat…',
  forras_ellentmondas_vizsgalat: 'Összevetem a források esetleges ellentmondásait…',
  jogszabaly_valtozas_hatasvizsgalat: 'Elemzem a jogszabályváltozás hatását…',
  szakmai_kutatas: 'Átfogó szakmai kutatást végzek…',
};
const BUSY = 'Dolgozom rajta…';
const activityFor = (tool) => ACTIVITY[tool] || BUSY;

const SIGNED_OUT = /not (?:logged|signed) in|please (?:run \/login|log ?in|sign ?in|login)|\/login\b|not authenticated|authentication (?:required|failed|error)|authentication_error|invalid api key|oauth token (?:has )?expired|token (?:has )?expired|could not be refreshed|unauthorized|\b401\b|login required|login_unavailable/i;
// A KapuMail MCP-szerverének hibaüzenete, ha a token érvénytelen vagy az irodánál ki van kapcsolva
// az AI-kapcsolat (IratkapuTool). Csak hibás eszközeredményben számít.
const MCP_OFF = /^\s*(?:Error:\s*)?Nincs érvényes MCP-hozzáférés/;
const MCP_LINE = /\bmcp\b|kapumail/i;
// Kijelentkezett CLI: a codex 401-nél percekig újrapróbál, az agy böngészős belépésre vár. Ezeket
// az első jelre lezárjuk, nem várjuk ki.
const EARLY_SIGNED_OUT = /\b401 Unauthorized\b|waiting for authentication|paste the authorization code|authentication failed or timed out|not logged in/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const errText = {
  signed_out: (e) => `${ENGINE_LABEL[e]}: nem vagy belépve. Lépj be a Kapu beállításainál.`,
  missing: (e) => `${ENGINE_LABEL[e]} nincs telepítve ezen a gépen.`,
  timeout: (e, sec) => `Kapu ${sec} másodperc alatt nem válaszolt. Próbáld újra, vagy kérdezz egyszerűbbet.`,
  mcp_off: () => 'Kapu most nem éri el az iroda adatait: az AI-kapcsolat ki van kapcsolva, vagy a Kapu-hozzáférés lejárt. Kapcsold be újra a Beállításokban.',
  failed: (e) => `${ENGINE_LABEL[e]} hibával állt le. Próbáld újra.`,
};

// --- Kapcsolók ----------------------------------------------------------------------------------

// Első körben a személyiség a kérdés elé kerül (a codex és az agy nem vesz át külön rendszerpromptot);
// folytatásnál már a beszélgetés része.
function withPersona(message, text, sessionId) {
  return sessionId ? message : `${text}\n\n---\n\nA felhasználó üzenete:\n${message}`;
}

const CODEX_DISABLE = ['shell_tool', 'unified_exec', 'view_image', 'apps', 'browser_use', 'computer_use', 'in_app_browser',
  'multi_agent', 'hooks', 'goals', 'memories', 'plugins', 'image_generation', 'tool_suggest', 'skill_mcp_dependency_install'];

/**
 * buildArgs(engine, {message, sessionId?, mcpFile?, persona?, cwd?, extra?, model?, timeoutSec?}) → string[]
 * `model`: claude `--model`, codex `-m`, agy `--model` (az erőfokkal együtt, pl. gemini-4-argon-medium).
 * `extra`: a prepare() által adott kapcsolók (args0), a CLI saját helyén.
 */
function buildArgs(engine, { sessionId, mcpFile, persona: p, personaFile, cwd, extra = [], model, premium = false, timeoutSec = TURN_TIMEOUT_MS / 1000 } = {}) {
  // `model`: a models.resolve által engedélyezett azonosító (argv alak); itt csak az alakját ellenőrizzük még egyszer.
  if (model !== undefined && model !== null && (typeof model !== 'string' || !MODEL_RE.test(model))) throw new Error('Érvénytelen modell.');
  // A kérdés (és codexnél, agy-nál az első körben a személyiség is) a szabványos bemeneten megy
  // (stdinFor): így sortörés, idézőjel, kötőjel sem kerül a parancssorba (Windowson a cmd.exe-s indítás
  // ezeket nem engedné át).
  if (engine === 'claude') {
    if (!mcpFile) throw new Error('Hiányzik az MCP-konfiguráció.');
    return [
      '-p', // a kérdés a bemeneten
      '--output-format', 'stream-json',
      '--verbose',
      '--strict-mcp-config', '--mcp-config', mcpFile,
      '--setting-sources', '',
      // Vesszővel (nem szóközzel) elválasztva: Windowson a cmd.exe-s indítás így sem bont szét egy kapcsolót.
      '--allowedTools', premium ? `${CLAUDE_TOOL_PREFIX}*,${CLAUDE_PREMIUM_PREFIX}*,WebSearch` : `${CLAUDE_TOOL_PREFIX}*,WebSearch`,
      '--tools', 'WebSearch',
      '--permission-prompts', 'none', // ami engedélyt kérne, azt elutasítja
      '--disable-slash-commands',
      ...(model ? ['--model', model] : []),
      ...extra,
      ...(personaFile ? ['--append-system-prompt-file', personaFile] : ['--append-system-prompt', p === undefined ? persona() : p]),
      ...(sessionId ? ['--resume', sessionId] : []),
    ];
  }
  if (engine === 'codex') {
    const common = [
      '--json',
      '--skip-git-repo-check',
      '--ignore-user-config', // a felhasználó saját MCP-szerverei, profiljai nem jönnek
      '--ignore-rules',
      '-c', 'sandbox_mode=read-only',
      '-c', 'approval_policy=never',
      '-c', 'web_search=live',
      '-c', 'shell_environment_policy.inherit=core',
      '-c', 'project_doc_max_bytes=0',
      '-c', 'skills.include_instructions=false',
      '-c', 'skills.bundled.enabled=false',
      '-c', 'model_reasoning_effort=medium',
      ...(model ? ['-m', model] : []),
      ...CODEX_DISABLE.flatMap((f) => ['--disable', f]),
      ...extra,
    ];
    // A kérdés a szabványos bemeneten jön (`-`).
    if (sessionId) return ['exec', 'resume', ...common, sessionId, '-'];
    if (!cwd) throw new Error('Hiányzik a munkamappa.');
    return ['exec', ...common, '--sandbox', 'read-only', '--cd', cwd, '-'];
  }
  if (engine === 'agy') {
    // `--mode plan`: tervező mód, szerkesztés nélkül. A --disable-slash-commands szándékosan hiányzik:
    // mellette az agy 1.5.8 a `--mode plan`-t figyelmen kívül hagyná („--mode plan has no effect while
    // slash command expansion is disabled”).
    return [
      '-p', '', // a kérdés a bemeneten, NDJSON-ként
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--mode', 'plan',
      '--sandbox',
      '--print-timeout', `${Math.max(1, Math.ceil(timeoutSec))}s`,
      ...(model ? ['--model', model] : []),
      ...extra,
      ...(sessionId ? ['--conversation', sessionId] : []),
    ];
  }
  throw new Error(`Ismeretlen motor: ${engine}`);
}

/** Amit a CLI a szabványos bemeneten kap. */
function stdinFor(engine, message, p, sessionId) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('Üres üzenet.');
  const text = p === undefined ? persona() : p;
  if (engine === 'claude') return message;
  if (engine === 'codex') return withPersona(message, text, sessionId);
  if (engine === 'agy') {
    // `/`-rel kezdődő üzenetet az agy parancsként bontana ki.
    const m = withPersona(message, text, sessionId);
    return `${JSON.stringify({ event: 'user', message: { role: 'user', content: m.startsWith('/') ? ` ${m}` : m } })}\n`;
  }
  throw new Error(`Ismeretlen motor: ${engine}`);
}

// --- Kimenet értelmezése ------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : undefined);

// Egy eszközeredmény szövege, bármilyen formában jön (szöveg, tartalomblokkok, {content:[…]}).
function resultText(v, depth = 0) {
  if (depth > 4 || v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => resultText(x, depth + 1)).join('\n');
  if (isObj(v)) {
    if (typeof v.text === 'string') return v.text;
    const parts = [];
    for (const k of ['content', 'structured_content', 'structuredContent', 'result', 'output', 'response', 'message', 'error']) {
      if (k in v) parts.push(resultText(v[k], depth + 1));
    }
    return parts.filter(Boolean).join('\n');
  }
  return '';
}

function confirmId(text) {
  if (!text || !/needs_approval/.test(text)) return null;
  const tryObj = (o) => (isObj(o) && o.needs_approval === true && typeof o.confirm_id === 'string' && UUID.test(o.confirm_id) ? o.confirm_id : null);
  try {
    const id = tryObj(JSON.parse(text));
    if (id) return id;
  } catch { /* lent szövegként */ }
  if (!/"needs_approval"\s*:\s*true/.test(text)) return null;
  const m = /"confirm_id"\s*:\s*"([0-9a-f-]{36})"/i.exec(text);
  return m && UUID.test(m[1]) ? m[1] : null;
}

/**
 * createParser(engine) → {line(obj) → event[], end({code, stderr}) → záró esemény}
 * A záró esemény: final, vagy error a megfelelő kóddal.
 */
function createParser(engine) {
  const st = { lastActivity: null, early: null, session: null, confirms: new Set(), activities: new Set(), mcpOff: false, final: null, failure: null, lastError: '', agyText: '', claudeTools: new Map() };

  const session = (id) => {
    if (typeof id !== 'string' || !id || st.session) return [];
    st.session = id;
    return [{ type: 'session', id }];
  };
  const activity = (tool, key) => {
    const k = key === undefined ? `${tool}:${st.activities.size}` : key;
    if (st.activities.has(k)) return [];
    st.activities.add(k);
    const text = activityFor(tool);
    if (text === st.lastActivity) return []; // ugyanaz a felirat egymás után nem villog újra
    st.lastActivity = text;
    return [{ type: 'activity', text }];
  };
  const toolResult = (v, isError = false) => {
    const text = resultText(v);
    if (isError && MCP_OFF.test(text)) st.mcpOff = true;
    const id = confirmId(text);
    if (!id || st.confirms.has(id)) return [];
    st.confirms.add(id);
    return [{ type: 'confirm', id }];
  };
  const execToolResults = (v, failed = false) => {
    const out = [...toolResult(v, failed)];
    for (const line of resultText(v).split('\n')) {
      const t = line.trim();
      if (!t || (t[0] !== '{' && t[0] !== '[')) continue;
      try {
        const parsed = JSON.parse(t);
        for (const p of (Array.isArray(parsed) ? parsed : [parsed])) {
          if (!isObj(p)) continue;
          const innerFailed = failed || p.isError === true || p.is_error === true || Boolean(p.error);
          out.push(...toolResult(p, innerFailed));
        }
      } catch { /* nem JSON sor */ }
    }
    return out;
  };
  const recordError = (msg) => {
    if (!msg) return;
    st.lastError = st.lastError ? `${st.lastError}\n${msg}`.slice(-4096) : msg;
    if (EARLY_SIGNED_OUT.test(msg) && !MCP_LINE.test(msg)) st.early = 'signed_out';
  };

  function claude(o) {
    const out = [];
    if (o.type === 'system' && o.subtype === 'init') {
      out.push(...session(o.session_id));
      const servers = Array.isArray(o.mcp_servers) ? o.mcp_servers : [];
      const k = servers.find((s) => isObj(s) && s.name === SERVER);
      if (k && k.status === 'failed') st.lastError = 'MCP-szerver nem indult';
      return out;
    }
    const content = isObj(o.message) && Array.isArray(o.message.content) ? o.message.content : [];
    if (o.type === 'assistant') {
      for (const b of content) {
        if (!isObj(b) || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
        const tool = claudeTool(b.name);
        if (typeof b.id === 'string') st.claudeTools.set(b.id, tool);
        out.push(...activity(tool, b.id));
      }
    } else if (o.type === 'user') {
      for (const b of content) if (isObj(b) && b.type === 'tool_result') out.push(...toolResult(b.content, b.is_error === true));
    } else if (o.type === 'result') {
      out.push(...session(o.session_id));
      const text = str(o.result) || '';
      if (o.is_error === true || (o.subtype && o.subtype !== 'success')) {
        st.failure = text || str(o.subtype) || 'error';
      } else {
        st.final = text;
      }
    }
    return out;
  }

  function mapExecTool(raw) {
    if (raw === 'web_search' || raw === 'WebSearch' || raw === 'web__run') return 'web_search';
    const m = /^(?:mcp__)?([a-z0-9_]+?)__([a-z0-9_]+)$/i.exec(raw);
    if (!m) return null;
    return OWN_SERVERS.has(m[1]) ? m[2] : '';
  }

  function codexExecTools(src) {
    if (!src) return [];
    const clean = src.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '/' ? ' ' : m));
    const found = [];
    const re = /\btools\s*(?:\.\s*([A-Za-z0-9_]+)|\[\s*['"`]([A-Za-z0-9_]+)['"`]\s*\])|\{\s*([^}]+)\}\s*=\s*tools\b/g;
    let m;
    while ((m = re.exec(clean)) !== null) {
      const names = m[3]
        ? m[3].split(',').map((p) => p.split(':')[0].split('=')[0].trim()).filter(Boolean)
        : [m[1] || m[2]];
      for (const n of names) {
        const mapped = mapExecTool(n);
        if (mapped !== null) found.push(mapped);
      }
    }
    return found;
  }

  function codex(o) {
    const out = [];
    if (o.type === 'thread.started') return session(o.thread_id);
    const item = isObj(o.item) ? o.item : null;
    if (item && item.type === 'error') {
      recordError(str(item.message) || resultText(item.error));
      return out;
    }
    if (item && item.type === 'mcp_tool_call') {
      const tool = OWN_SERVERS.has(item.server) && typeof item.tool === 'string' ? item.tool : '';
      out.push(...activity(tool, item.id));
      if (o.type === 'item.completed') {
        const failed = item.status === 'failed' || Boolean(item.error);
        out.push(...toolResult(item.result, failed));
        if (item.error) out.push(...toolResult(item.error, true));
      }
      return out;
    }
    if (item && item.type === 'custom_tool_call' && item.name === 'exec') {
      const baseKey = str(item.id) || str(item.call_id) || `exec:${st.activities.size}`;
      const tools = codexExecTools(str(item.input) || str(item.arguments) || '');
      if (tools.length) tools.forEach((t, idx) => out.push(...activity(t, `${baseKey}:${idx}`)));
      else out.push(...activity('', baseKey));
      if (o.type === 'item.completed') {
        const failed = item.status === 'failed' || Boolean(item.error);
        out.push(...execToolResults(item.output ?? item.result, failed));
        if (item.error) out.push(...toolResult(item.error, true));
      }
      return out;
    }
    if (item && (item.type === 'web_search' || item.type === 'web_search_call' || (item.type === 'tool_call' && item.name === 'web_search'))) {
      out.push(...activity('web_search', item.id));
      return out;
    }
    if (item && o.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') st.final = item.text;
    if (o.type === 'turn.failed') st.failure = resultText(o.error) || 'turn.failed';
    // A felső szintű `error` sor nem mindig végzetes (újrapróbálás): csak megjegyezzük.
    if (o.type === 'error') {
      recordError(str(o.message) || resultText(o.error));
    }
    if (o.type === 'turn.completed' && st.final === null) st.final = '';
    return out;
  }

  function agy(o) {
    const out = [];
    if (typeof o.conversation_id === 'string') out.push(...session(o.conversation_id));
    if (o.event === 'init' && isObj(o.init)) out.push(...session(o.init.conversation_id));
    const step = isObj(o.step_update) ? o.step_update : null;
    if (o.event === 'step_update' && step) {
      if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') st.agyText += step.text_delta;
      if (step.step_type === 'tool' && step.tool_name === 'search_web') {
        out.push(...activity('search_web', `step:${step.step_index}`));
      }
      // Csak az MCP-hívás és a webes keresés érdekes: az agy egyéb saját eszközeit (fájl, parancs) a beállítás tiltja.
      if (step.step_type === 'tool' && step.tool_name === 'call_mcp_tool') {
        const info = isObj(step.tool_info) ? step.tool_info : {};
        const params = isObj(info.parameters) ? info.parameters : {};
        const server = str(params.ServerName) || str(params.server);
        const name = str(params.ToolName) || str(params.tool);
        const tool = OWN_SERVERS.has(server) && name ? name : '';
        out.push(...activity(tool, `step:${step.step_index}`));
        if (step.state === 'DONE' || step.state === 'ERROR') {
          const failed = step.state === 'ERROR' || Boolean(info.error);
          out.push(...toolResult(info.result ?? info.output ?? step.result ?? step.output, failed));
          if (info.error) out.push(...toolResult(info.error, true));
        }
      }
    }
    if (o.event === 'result' && isObj(o.result)) {
      out.push(...session(o.result.conversation_id));
      const r = o.result;
      if (str(r.status) === 'SUCCESS') st.final = str(r.response) ?? st.agyText;
      else st.failure = resultText(r.error) || str(r.response) || str(r.status) || 'error';
    }
    if (o.event === 'error') st.failure = resultText(o) || 'error';
    return out;
  }

  const handlers = { claude, codex, agy };
  return {
    // A hibakimenet egy darabja: ha egyértelműen kijelentkezett, a kör azonnal lezárható.
    stderr(chunk) {
      // Az MCP-szerverről szóló sor (pl. a kapumail 401-e) nem a CLI belépéséről szól.
      if (!st.early && String(chunk).split('\n').some((l) => EARLY_SIGNED_OUT.test(l) && !MCP_LINE.test(l))) st.early = 'signed_out';
    },
    line(o) {
      if (!isObj(o)) return [];
      try { return handlers[engine](o); } catch { return []; }
    },
    end({ code, stderr = '' } = {}) {
      const err = (c) => ({ type: 'error', code: c, text: errText[c](engine) });
      // Az MCP-szerverről szóló sorok (pl. a kapumail 401-e) nem a CLI belépéséről szólnak.
      const evidence = `${st.failure || ''}\n${st.lastError}\n${stderr}`.split('\n').filter((l) => !MCP_LINE.test(l)).join('\n');
      if (st.mcpOff) return err('mcp_off');
      if (st.final !== null && st.failure === null && (code === 0 || code === null)) {
        const text = st.final.trim();
        if (text) return { type: 'final', text };
      }
      if (SIGNED_OUT.test(evidence)) return err('signed_out');
      return err('failed');
    },
    state: st,
  };
}

// --- Futtatás -----------------------------------------------------------------------------------

function killTree(child, signal, platform, spawn) {
  if (!child) return;
  if (platform === 'win32' && child.pid) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {}); } catch { /* lent */ }
    try { child.kill(); } catch { /* már kilépett */ }
    return;
  }
  // Saját folyamatcsoportban indult: a csoporttal együtt állnak le a gyerekei (pl. a helyi MCP-szerver),
  // akkor is, ha a csoport vezetője már kilépett.
  try { if (child.pid) { process.kill(-child.pid, signal); return; } } catch { /* nincs (már) csoport */ }
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill(signal); } catch { /* már kilépett */ }
}

/**
 * startRun({engine, message, sessionId?, model?, conv, onEvent, ...}) → {cancel()}
 * model: a CLI-nek átadott modell (models.resolve(...).argv); üresen a CLI alapmodellje.
 * conv: {userData, mcp} – a beszélgetés környezete (mcp: lásd isolation.prepare).
 * Tesztből/hívótól állítható: bin, env, platform, spawn, timeoutMs (150 000), killGraceMs (2000),
 * persona, sourceHome, readKeychain.
 */
function startRun({ engine, message, sessionId, model, conv = {}, onEvent = () => {}, ...opts } = {}) {
  const o = { ...conv, ...opts };
  const platform = o.platform || process.platform;
  const spawn = o.spawn || nodeSpawn;
  const env = o.env || process.env;
  const timeoutMs = o.timeoutMs ?? TURN_TIMEOUT_MS;
  const killGraceMs = o.killGraceMs ?? KILL_GRACE_MS;
  let child = null;
  let prep = null;
  let done = false;
  let cancelled = false;
  let timer = null;
  let graceTimer = null;

  const emit = (ev) => { try { onEvent(ev); } catch { /* a hívó hibája nem állítja meg a kört */ } };
  let sessionSeen;
  const cleanup = () => { if (prep) { try { prep.cleanup({ sessionId: sessionSeen }); } catch { /* már törölve */ } } };
  // now: kilépéskor nem bízunk az (unref-elt) időzítőben – SIGTERM után azonnal SIGKILL a csoportnak (mint a voice-agy).
  const stop = (now = false) => {
    if (!child) return;
    killTree(child, 'SIGTERM', platform, spawn);
    const c = child;
    if (now) { if (graceTimer) clearTimeout(graceTimer); graceTimer = null; killTree(c, 'SIGKILL', platform, spawn); return; }
    graceTimer = setTimeout(() => killTree(c, 'SIGKILL', platform, spawn), killGraceMs);
    if (graceTimer.unref) graceTimer.unref();
  };
  const finish = (ev) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (ev && !cancelled) emit(ev);
    if (!child) cleanup();
  };
  const error = (code, text) => finish({ type: 'error', code, text: text || errText[code](engine, Math.round(timeoutMs / 1000)) });

  // A kör korlátja a felkészüléssel (pl. a Claude-belépés frissítésével, a codex-zárra várással) együtt számít.
  const abort = new AbortController();
  timer = setTimeout(() => { error('timeout'); abort.abort(); stop(); }, timeoutMs);

  (async () => {
    if (!['claude', 'codex', 'agy'].includes(engine)) return error('failed', 'Ismeretlen motor.');
    const bin = o.bin || resolveBin(engine, env, platform);
    if (!bin) return error('missing');
    try {
      prep = await isolation.prepare({
        engine, userData: o.userData, mcp: o.mcp, premium: o.premium, sessionId, env, platform, sourceHome: o.sourceHome, readKeychain: o.readKeychain,
        persona: engine === 'claude' ? (o.persona === undefined ? persona() : o.persona) : undefined,
        claudeBin: bin, renewClaude: o.renewClaude, timeoutMs, signal: abort.signal,
      });
    } catch (e) {
      if (cancelled || done) return finish(null);
      return error(e && e.code === 'signed_out' ? 'signed_out' : 'failed', e && e.code ? e.message : undefined);
    }
    // Megszakítás vagy korlát a felkészülés alatt: a tokenes fájlok azonnal törlődnek.
    if (cancelled || done) { cleanup(); return finish(null); }
    let cmd;
    let input;
    try {
      const args = buildArgs(engine, { sessionId, mcpFile: prep.mcpFile, personaFile: prep.personaFile, cwd: prep.cwd, extra: prep.args0, model, premium: prep.premium === true, persona: o.persona, timeoutSec: timeoutMs / 1000 });
      input = stdinFor(engine, message, o.persona, sessionId);
      cmd = launch(bin, args, platform);
    } catch {
      return error('failed', `${ENGINE_LABEL[engine]} nem indítható biztonságosan ezzel az üzenettel.`);
    }
    const parser = createParser(engine);
    let stderr = '';
    let buf = '';
    const onLine = (line) => {
      const t = line.trim();
      if (!t || t[0] !== '{') return;
      let obj;
      try { obj = JSON.parse(t); } catch { return; }
      if (done) return;
      for (const ev of parser.line(obj)) { if (ev.type === 'session') sessionSeen = ev.id; emit(ev); }
      checkEarly();
    };
    const checkEarly = () => {
      if (done || !parser.state.early) return;
      error(parser.state.early);
      stop();
    };
    try {
      child = spawn(cmd.bin, cmd.args, {
        cwd: prep.cwd, env: prep.env, stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true, detached: platform !== 'win32', ...(cmd.verbatim ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (e) {
      child = null;
      return error(e && e.code === 'ENOENT' ? 'missing' : 'failed');
    }
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    child.stdout && child.stdout.setEncoding('utf8');
    child.stdout && child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
      if (buf.length > 8 << 20) buf = ''; // egy sor sem lehet ekkora
    });
    child.stderr && child.stderr.on('data', (d) => {
      if (stderr.length < 64 * 1024) stderr += d;
      parser.stderr(d);
      checkEarly();
    });
    child.on('error', (e) => {
      if (e && e.code === 'ENOENT') error('missing'); else error('failed');
      clearTimeout(graceTimer);
      cleanup();
    });
    child.on('close', (code) => {
      clearTimeout(graceTimer);
      if (buf) { onLine(buf); buf = ''; }
      if (!done) finish(cancelled ? null : parser.end({ code, stderr }));
      cleanup();
    });
  })().catch(() => error('failed'));

  return {
    // cleanupNow: a tokenes fájlok azonnal (szinkron) törlődnek, nem a folyamat bezárásakor – kilépéskor ez kell,
    // mert az app előbb leáll, mint ahogy a gyerekfolyamat 'close' eseménye megérkezne.
    cancel({ cleanupNow = false } = {}) {
      if (cancelled) { if (cleanupNow) { stop(true); cleanup(); } return; }
      cancelled = true;
      finish(null);
      abort.abort(); // a felkészülés (Claude-frissítés, codex-zárra várás) is leáll
      stop(cleanupNow);
      if (cleanupNow) cleanup();
    },
    get pid() { return child ? child.pid : undefined; },
  };
}

module.exports = { startRun, killTree, buildArgs, stdinFor, createParser, activityFor, ACTIVITY, TURN_TIMEOUT_MS, KILL_GRACE_MS };
