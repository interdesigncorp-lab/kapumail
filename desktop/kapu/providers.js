'use strict';
// Kapu-chat: a három AI-parancssor (claude, codex, agy) állapota és a terminálos belépés.
// Az ügyfél saját előfizetésével dolgozunk, ezért az API-kulcsok soha nem jutnak a parancsokhoz
// (cleanEnv), és shell nélkül indítunk. Elektron nélküli modul: a folyamatindítás (spawn) és az idő
// kívülről állítható, így a tesztek gyorsak és hálózat nélkül futnak.

const nodeSpawn = require('node:child_process').spawn;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENGINES = ['claude', 'codex', 'agy'];
const ENGINE_LABEL = { claude: 'Claude', codex: 'ChatGPT', agy: 'Antigravity' };
const API_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY'];
const MCP_TOKENS = ['IRATKAPU_MCP_TOKEN', 'KAPUMAIL_MCP_TOKEN', 'KAPUMAIL_SZAKMAI_TOKEN'];
// A gyerekfolyamatból kiszűrt változók: az API-kulcsok, MCP tokenek és ami az előfizetés helyett más fiókra,
// átjáróra vagy felhőre terelné a CLI-t (vagy más állapotmappára, mint amit a Kapu kezel).
const STRIP_ENV = [...API_KEYS, ...MCP_TOKENS, 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'OPENAI_BASE_URL', 'CODEX_HOME'];
const STATUS_TIMEOUT_MS = 8000;
const MODELS_TIMEOUT_MS = 5000;
const CLAUDE_CATALOG_URL = 'https://downloads.claude.ai/model-catalog/v1/catalog.json';
const CLAUDE_CACHE_MAX_BYTES = 512 * 1024;
const CLAUDE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const STATUS_ARGS = { claude: ['auth', 'status', '--json'], codex: ['login', 'status'], agy: ['models'] };
const SIGN_IN_ARGS = { claude: ['auth', 'login'], codex: ['login'], agy: [] };

function checkEngine(engine) {
  if (!ENGINES.includes(engine)) throw new Error(`Ismeretlen motor: ${engine}`);
}

function cleanEnv(env = process.env, platform = process.platform) {
  const out = { ...env };
  // Windowson a környezeti változók nevei kis- és nagybetűre érzéketlenek.
  const drop = platform === 'win32' ? new Set(STRIP_ENV.map((k) => k.toUpperCase())) : new Set(STRIP_ENV);
  for (const k of Object.keys(out)) if (drop.has(platform === 'win32' ? k.toUpperCase() : k)) delete out[k];
  return out;
}

function signInCommand(engine) {
  checkEngine(engine);
  return [engine, ...SIGN_IN_ARGS[engine]].join(' ');
}

// A parancs helye. A csomagolt app PATH-ja szegényes, ezért a szokásos telepítési mappákat is megnézzük.
function resolveBin(engine, env = process.env, platform = process.platform) {
  checkEngine(engine);
  const win = platform === 'win32';
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const dirs = [...(env.PATH || env.Path || '').split(path.delimiter), path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean);
  const names = win ? ['.exe', '.cmd', '.bat', ''].map((x) => engine + x) : [engine];
  for (const d of dirs) {
    for (const n of names) {
      const f = path.join(d, n);
      try {
        if (fs.statSync(f).isFile()) {
          if (!win) fs.accessSync(f, fs.constants.X_OK);
          return f;
        }
      } catch { /* tovább */ }
    }
  }
  return null;
}

// Lefuttat egy parancsot, korláttal. Sosem dob: {code, stdout, stderr, error?, timedOut?}.
function run(spawn, bin, args, { env, cwd, timeoutMs, verbatim }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let child;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ stdout, stderr, ...r }); };
    const timer = setTimeout(() => {
      try { child && child.kill('SIGKILL'); } catch { /* már kilépett */ }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    try {
      child = spawn(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...(verbatim ? { windowsVerbatimArguments: true } : {}) });
    } catch (e) {
      return finish({ code: null, error: e });
    }
    child.stdout && child.stdout.on('data', (d) => { if (stdout.length < 1 << 20) stdout += d; });
    child.stderr && child.stderr.on('data', (d) => { if (stderr.length < 1 << 20) stderr += d; });
    child.on('error', (e) => finish({ code: null, error: e }));
    child.on('close', (code) => finish({ code }));
  });
}

const shellQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
// cmd.exe: ezek a karakterek idézőjelen belül is mást jelentenének, az ilyen útvonalat nem írjuk le.
const UNSAFE_IN_BATCH = /["%^!\u0000-\u001f\u007f]/;
function batchWord(v) {
  if (UNSAFE_IN_BATCH.test(v)) throw new Error('Az útvonal nem írható biztonságosan batch-fájlba.');
  return `"${v}"`;
}

const batchArg = (v) => (/^[\w.-]+$/.test(v) ? v : batchWord(v));

// Windowson a .cmd/.bat (pl. npm-es) indítófájlt Node shell nélkül nem indítja (EINVAL): cmd.exe-n át
// hívjuk, a batch-biztos idézéssel; más fájlt közvetlenül.
function launch(bin, args, platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    return { bin: 'cmd.exe', args: ['/d', '/s', '/c', `"${['call', batchWord(bin), ...args.map(batchArg)].join(' ')}"`], verbatim: true };
  }
  return { bin, args };
}

// {engine, installed, signedIn, account?, error?}
async function status(engine, { bin, env, timeoutMs = STATUS_TIMEOUT_MS, spawn = nodeSpawn, platform = process.platform } = {}) {
  checkEngine(engine);
  const base = env || process.env;
  const file = bin || resolveBin(engine, base, platform);
  if (!file) return { engine, installed: false, signedIn: false };
  let cmd;
  try { cmd = launch(file, STATUS_ARGS[engine], platform); } catch { return { engine, installed: true, signedIn: false, error: `${ENGINE_LABEL[engine]} útvonala nem indítható biztonságosan.` }; }
  const r = await run(spawn, cmd.bin, cmd.args, { env: cleanEnv(base, platform), timeoutMs, verbatim: cmd.verbatim });
  if ((r.error && r.error.code === 'ENOENT') || r.code === 127) return { engine, installed: false, signedIn: false };
  const out = { engine, installed: true, signedIn: false };
  if (r.timedOut) return { ...out, error: `${ENGINE_LABEL[engine]} nem válaszolt időben.` };
  if (r.error) return { ...out, error: `${ENGINE_LABEL[engine]} nem indítható.` };
  // A codex az állapotot a hibakimenetre írja, ezért mindkettőt nézzük.
  const text = (engine === 'codex' ? `${r.stdout}\n${r.stderr}` : r.stdout).trim();
  // Az agy a „jelentkezz be” figyelmeztetést a hibakimenetre írja.
  const errText = String(r.stderr || '');
  if (engine === 'claude') {
    try {
      const d = JSON.parse(text);
      if (d && d.loggedIn === true && r.code === 0) {
        return { ...out, signedIn: true, ...(typeof d.subscriptionType === 'string' && d.subscriptionType ? { account: d.subscriptionType } : {}) };
      }
      if (d && d.loggedIn === false) return out;
    } catch { /* hiba lent */ }
    return { ...out, error: 'A Claude állapota nem olvasható.' };
  }
  if (engine === 'codex') {
    if (/^not logged in\b/im.test(text)) return out;
    if (r.code === 0 && /^logged in using ChatGPT\b/im.test(text)) return { ...out, signedIn: true, account: 'ChatGPT' };
    // API-kulccsal való belépés nem előfizetés; a kulcs végét sem adjuk tovább.
    if (r.code === 0 && /^logged in\b/im.test(text)) return { ...out, error: 'A Codex API-kulccsal van belépve, ChatGPT-fiókkal kell.' };
    return { ...out, error: 'A Codex állapota nem olvasható.' };
  }
  // agy: nincs állapotparancs, a modell-lista csak bejelentkezve nem üres.
  const models = text.split('\n').filter((l) => { const [id, name] = l.split('\t'); return id && id.trim() && name && name.trim(); }).length;
  // A lista a modellválasztóhoz is kell (models.parseAgyModels): egyszer futtatjuk, itt adjuk tovább.
  if (r.code === 0 && models > 0) return { ...out, signedIn: true, models: require('./models').parseAgyModels(text) };
  if (r.code === 0 || /not (logged|signed) in|not authenticated|authentication required|please (log|sign) ?in/i.test(`${text}\n${errText}`)) return out;
  return { ...out, error: 'Az Antigravity állapota nem olvasható.' };
}

// Látható terminálablakban elindítja a belépést; a beírtakat az app nem látja.
async function openSignIn(engine, { dir, platform = process.platform, spawn = nodeSpawn, env, bin: binOpt } = {}) {
  checkEngine(engine);
  const e = env || process.env;
  const bin = binOpt || resolveBin(engine, e, platform) || engine;
  const args = SIGN_IN_ARGS[engine];
  fs.mkdirSync(dir, { recursive: true });
  let file;
  let r;
  if (platform === 'win32') {
    file = path.join(dir, `${engine}-sign-in.cmd`);
    const word = batchArg;
    const lines = ['@echo off', 'chcp 65001 >nul', ...API_KEYS.map((k) => `set ${k}=`), ['call', word(bin), ...args.map(word)].join(' '), 'pause', ''];
    fs.writeFileSync(file, lines.join('\r\n'));
    r = await run(spawn, 'cmd.exe', ['/d', '/c', 'start', '', `.\\${path.win32.basename(file)}`], { cwd: dir, env: e, timeoutMs: 15000 });
  } else if (platform === 'darwin') {
    file = path.join(dir, `${engine}-sign-in.command`);
    fs.writeFileSync(file, `#!/bin/zsh -l\nunset ${API_KEYS.join(' ')}\n${[bin, ...args].map(shellQuote).join(' ')}\n`, { mode: 0o700 });
    fs.chmodSync(file, 0o700);
    r = await run(spawn, 'open', ['-a', 'Terminal', file], { env: e, timeoutMs: 15000 });
  } else {
    throw new Error('A terminálos belépés csak macOS-en és Windowson érhető el.');
  }
  if (r.error || r.timedOut || r.code !== 0) throw new Error('A terminál nem nyílt meg.');
  return { file };
}

// Élő modell-azonosítók lekérése induláskor és összekötéskor. Sosem dob; hiba esetén null (a KNOWN tartalék lép életbe).
function readClaudeCache(dirs, now = Date.now()) {
  const { parseClaudeCatalog } = require('./models');
  const candidates = [];
  for (const dir of dirs) {
    if (!dir) continue;
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const f = path.join(dir, n);
      try {
        const st = fs.lstatSync(f);
        if (st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size <= CLAUDE_CACHE_MAX_BYTES) candidates.push({ f, mtimeMs: st.mtimeMs });
      } catch { /* tovább */ }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of candidates) {
    try {
      const doc = JSON.parse(fs.readFileSync(c.f, 'utf8'));
      const ids = parseClaudeCatalog(doc);
      if (ids.length) {
        const fresh = (doc && typeof doc.staleAt === 'number' && doc.staleAt > now) || (now - c.mtimeMs < CLAUDE_CACHE_TTL_MS);
        return { ids, fresh };
      }
    } catch { /* sérült cache-fájl */ }
  }
  return null;
}

async function fetchModels(engine, {
  bin, env, userData, force = false, timeoutMs = MODELS_TIMEOUT_MS, spawn = nodeSpawn, platform = process.platform,
  fetchImpl = globalThis.fetch, now = () => Date.now(),
} = {}) {
  checkEngine(engine);
  const base = env || process.env;
  if (engine === 'claude') {
    const home = (platform === 'win32' ? (base.USERPROFILE || base.HOME) : base.HOME) || os.homedir();
    const claudeDir = base.CLAUDE_CONFIG_DIR ? path.resolve(base.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
    const dirs = [
      userData ? path.join(userData, 'kapu', 'cli', 'claude', 'cache', 'model-catalog') : null,
      path.join(claudeDir, 'cache', 'model-catalog'),
    ];
    const cached = readClaudeCache(dirs, now());
    if (cached && cached.fresh && !force) return cached.ids;
    if (typeof fetchImpl === 'function') {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, 3500));
      try {
        const res = await fetchImpl(CLAUDE_CATALOG_URL, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (res && res.ok) {
          const text = await res.text();
          if (text.length <= CLAUDE_CACHE_MAX_BYTES) {
            const ids = require('./models').parseClaudeCatalog(text);
            if (ids.length) return ids;
          }
        }
      } catch { /* offline vagy időkorlát */ } finally { clearTimeout(timer); }
    }
    return cached ? cached.ids : null;
  }
  if (engine === 'codex') {
    const file = bin || resolveBin('codex', base, platform);
    if (!file) return null;
    let cmd;
    try { cmd = launch(file, ['debug', 'models'], platform); } catch { return null; }
    const r = await run(spawn, cmd.bin, cmd.args, { env: cleanEnv(base, platform), timeoutMs, verbatim: cmd.verbatim });
    if (r.error || r.timedOut || r.code !== 0 || !r.stdout) return null;
    const ids = require('./models').parseCodexModels(r.stdout);
    return ids.length ? ids : null;
  }
  const r = await status('agy', { bin, env: base, timeoutMs, spawn, platform });
  return r && Array.isArray(r.models) && r.models.length ? r.models : null;
}

module.exports = { ENGINES, ENGINE_LABEL, API_KEYS, STRIP_ENV, CLAUDE_CATALOG_URL, status, fetchModels, signInCommand, openSignIn, cleanEnv, resolveBin, launch };
