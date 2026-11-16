'use strict';
// Kapu-chat: egy kör környezetének előkészítése úgy, hogy a CLI a KapuMail MCP-szerverén (kapumail)
// kívül semmihez ne férjen hozzá. Munkamappa mindig az üres `<userData>/kapu/work`, a környezetből az
// API-kulcsok kiszűrve (cleanEnv). A CLI-k saját állapota (munkamenet, gyorsítótár) a program 0700-as
// mappájában (`<userData>/kapu/cli/<motor>/`), a felhasználó ~/.claude, ~/.codex mappájába nem kerül.
// Claude: 0600-as MCP-, beállítás- és személyiségfájl, CLAUDE_CONFIG_DIR + CLAUDE_CODE_OAUTH_TOKEN.
// Codex: saját CODEX_HOME az auth.json másolatával, `-c mcp_servers.kapumail.*` kapcsolók, a token csak
// környezeti változóban. Antigravity: saját,
// ideiglenes HOME (`<userData>/kapu/agy-home-<rand>`), oda kerül a belépési token másolata, az MCP-szerver
// és az `mcp(kapumail/*)` engedély – a felhasználó globális ~/.gemini-jébe soha nem írunk.
// Elektron nélküli modul; a kulcskarika-olvasás és a forrás-HOME tesztből állítható.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { cleanEnv } = require('./providers');

const SERVER = 'kapumail';
const HTTP_TOKEN_ENV = 'KAPUMAIL_MCP_TOKEN';
const STDIO_TOKEN_ENV = 'IRATKAPU_MCP_TOKEN';
const MCP_ARGS = ['mcp:start', 'iratkapu'];
// Antigravity: a saját olvasó-, parancs- és url-eszközök tiltva; a kapumail és a beépített keresés engedélyezett.
const AGY_DENY = ['read_file(*)', 'write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)'];
const AGY_ALLOW = [`mcp(${SERVER}/*)`, 'search_web(*)'];
const MAX_AUTH = 256 * 1024;
// Szakmai MCP (jogi és könyvelői eszközök, távoli átjáró): második szerver, ha a körhöz van érvényes token.
const PREMIUM_SERVER = 'kapumail_szakmai';
const PREMIUM_TOKEN_ENV = 'KAPUMAIL_SZAKMAI_TOKEN';

/** {url, token} | null: csak https-cím és parancssorba/fejlécbe biztonságosan írható token jöhet. */
function cleanPremium(p) {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.token !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(p.token)) return null;
  if (typeof p.url !== 'string' || !/^https:\/\/[^\s"'\\]+$/.test(p.url)) return null;
  try { new URL(p.url); } catch { return null; }
  return { url: p.url, token: p.token };
}

function fail(code, text) {
  const e = new Error(text);
  e.code = code;
  return e;
}

// A token sosem kerül shell-be vagy TOML-ba, de nem lehet benne szóköz vagy vezérlőkarakter sem.
function checkMcp(mcp) {
  if (!mcp || typeof mcp !== 'object') throw fail('failed', 'Hiányzik az MCP-kapcsolat beállítása.');
  if (typeof mcp.token !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(mcp.token)) throw fail('failed', 'Hiányzik vagy hibás a Kapu-token.');
  if (mcp.mode === 'stdio') {
    if (typeof mcp.php !== 'string' || !mcp.php || typeof mcp.artisan !== 'string' || !mcp.artisan) throw fail('failed', 'Hiányzik a helyi MCP-szerver útvonala.');
    return;
  }
  if (mcp.mode === 'http') {
    if (typeof mcp.url !== 'string' || !/^(https:\/\/[^\s"'\\]+|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/[^\s"'\\]*)$/.test(mcp.url)) {
      throw fail('failed', 'Az MCP-cím csak https lehet (vagy helyi http).');
    }
    return;
  }
  throw fail('failed', 'Ismeretlen MCP-mód.');
}

// Az üres munkamappa: ha valami mégis került bele, kiürítjük (a mappa a programé).
function workDir(userData) {
  const dir = path.join(userData, 'kapu', 'work');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  return dir;
}

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windowson nincs jelentősége */ }
  return dir;
}

function writePrivate(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
}

// --- Claude -------------------------------------------------------------------------------------

function claudeServer(mcp) {
  if (mcp.mode === 'stdio') return { type: 'stdio', command: mcp.php, args: [mcp.artisan, ...MCP_ARGS], env: { [STDIO_TOKEN_ENV]: mcp.token } };
  return { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } };
}

// --- Codex --------------------------------------------------------------------------------------

// A `-c` értékét a Codex TOML-ként olvassa, és ha az nem sikerül, nyers szövegként. Az egyszerű
// értékeket (URL, szó) ezért idézőjel nélkül adjuk: így Windowson a cmd.exe-s indítás is biztonságos.
function codexMcpArgs(mcp) {
  const k = (key, value) => ['-c', `mcp_servers.${SERVER}.${key}=${value}`];
  const common = [...k('enabled', 'true'), ...k('default_tools_approval_mode', 'approve'), ...k('startup_timeout_sec', '30'), ...k('tool_timeout_sec', '60')];
  if (mcp.mode === 'stdio') {
    return [
      ...k('command', JSON.stringify(mcp.php)),
      ...k('args', JSON.stringify([mcp.artisan, ...MCP_ARGS])),
      // A token értéke nem kerül a parancssorba: csak a neve, a Codex a saját környezetéből adja tovább.
      ...k('env_vars', JSON.stringify([STDIO_TOKEN_ENV])),
      ...common,
    ];
  }
  return [...k('url', mcp.url), ...k('bearer_token_env_var', HTTP_TOKEN_ENV), ...common];
}

// A szakmai szerver: mindig távoli (https); a token itt is csak a környezeti változó nevén át megy.
function codexPremiumArgs(premium) {
  const k = (key, value) => ['-c', `mcp_servers.${PREMIUM_SERVER}.${key}=${value}`];
  return [
    ...k('url', premium.url), ...k('bearer_token_env_var', PREMIUM_TOKEN_ENV),
    ...k('enabled', 'true'), ...k('default_tools_approval_mode', 'approve'), ...k('startup_timeout_sec', '30'), ...k('tool_timeout_sec', '60'),
  ];
}

// --- Antigravity --------------------------------------------------------------------------------

function readKeychainDefault(service, account) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['find-generic-password', '-a', account, '-s', service, '-w'], {
      encoding: 'utf8', timeout: 10000, maxBuffer: MAX_AUTH, env: { PATH: '/usr/bin:/bin' },
    }, (error, stdout) => {
      if (!error) return resolve(String(stdout).trim() || null);
      if (error.code === 44) return resolve(null); // nincs ilyen elem
      reject(fail('failed', 'A kulcskarika nem olvasható.'));
    });
  });
}

// Csak sima fájl, link nélkül, ésszerű méretben.
async function readAuthFile(file) {
  let st;
  try { st = await fsp.lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_AUTH) return null;
  return fsp.readFile(file, 'utf8');
}

// Az agy előfizetéses (consumer) belépése, a natív OAuth-séma kiválogatott mezőivel.
function consumerLogin(encoded) {
  if (typeof encoded !== 'string' || !encoded || encoded.length > MAX_AUTH) return null;
  const prefix = 'go-keyring-base64:';
  let data;
  try {
    data = JSON.parse(encoded.startsWith(prefix) ? Buffer.from(encoded.slice(prefix.length), 'base64').toString('utf8') : encoded);
  } catch { return null; }
  if (!data || typeof data !== 'object' || data.auth_method !== 'consumer' || !data.token || typeof data.token !== 'object') return null;
  const t = data.token;
  if (typeof t.access_token !== 'string' || !t.access_token || t.token_type !== 'Bearer' || typeof t.expiry !== 'string' || !Number.isFinite(Date.parse(t.expiry))) return null;
  const token = { access_token: t.access_token, token_type: 'Bearer', refresh_token: typeof t.refresh_token === 'string' ? t.refresh_token : '', expiry: t.expiry };
  if (typeof t.expires_in === 'number' && Number.isFinite(t.expires_in)) token.expires_in = t.expires_in;
  const doc = { token, auth_method: 'consumer' };
  if (typeof data.id_token === 'string' && data.id_token) doc.id_token = data.id_token;
  return JSON.stringify(doc);
}

// A felhasználó saját agy-belépése (kulcskarika vagy fájl) és beállításai; a ~/.gemini-be nem írunk.
async function readAgyLogin({ sourceHome, platform, readKeychain }) {
  const cli = path.join(sourceHome, '.gemini', 'antigravity-cli');
  let userSettings = {};
  try {
    const raw = await readAuthFile(path.join(cli, 'settings.json'));
    if (raw) userSettings = JSON.parse(raw);
  } catch { userSettings = {}; }
  const provider = userSettings && typeof userSettings === 'object' ? userSettings.modelProvider : undefined;
  if (provider !== undefined && provider !== '' && provider !== 'antigravity') {
    throw fail('signed_out', 'Az Antigravity nem előfizetéssel van beállítva. Lépj be újra a Kapu beállításainál.');
  }
  let encoded = null;
  const keychain = readKeychain || (platform === 'darwin' ? readKeychainDefault : null);
  if (keychain) {
    try { encoded = await keychain('gemini', 'antigravity'); } catch { encoded = null; }
  }
  let login = consumerLogin(encoded);
  if (!login) login = consumerLogin(await readAuthFile(path.join(cli, 'antigravity-oauth-token')).catch(() => null));
  if (!login) throw fail('signed_out', 'Antigravity: nem vagy belépve. Lépj be a Kapu beállításainál.');
  return { login, cli, userSettings: userSettings && typeof userSettings === 'object' ? userSettings : {} };
}

async function agyHome({ userData, mcp, premium, sourceHome, platform, readKeychain }) {
  const { login } = await readAgyLogin({ sourceHome, platform, readKeychain });
  const base = privateDir(path.join(userData, 'kapu'));
  const home = fs.mkdtempSync(path.join(base, 'agy-home-'));
  try {
    fs.chmodSync(home, 0o700);
    const cfgDir = privateDir(path.join(home, '.gemini', 'antigravity-cli'));
    const mcpDir = privateDir(path.join(home, '.gemini', 'config'));
    writePrivate(path.join(cfgDir, 'antigravity-oauth-token'), login);
    const allow = premium ? [...AGY_ALLOW, `mcp(${PREMIUM_SERVER}/*)`] : AGY_ALLOW;
    writePrivate(path.join(cfgDir, 'settings.json'), JSON.stringify({ permissions: { allow, deny: AGY_DENY } }));
    const server = mcp.mode === 'stdio'
      ? { command: mcp.php, args: [mcp.artisan, ...MCP_ARGS], env: { [STDIO_TOKEN_ENV]: mcp.token } }
      : { serverUrl: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } };
    const servers = { [SERVER]: server };
    if (premium) servers[PREMIUM_SERVER] = { serverUrl: premium.url, headers: { Authorization: `Bearer ${premium.token}` } };
    writePrivate(path.join(mcpDir, 'mcp_config.json'), JSON.stringify({ mcpServers: servers }));
  } catch (e) {
    fs.rmSync(home, { recursive: true, force: true });
    throw e;
  }
  return home;
}

// --- Claude belépése ---------------------------------------------------------------------------

// A Claude saját, előfizetéses belépése (macOS: kulcskarika, máshol a .credentials.json). A futás csak
// a hozzáférési tokent kapja környezeti változóban (CLAUDE_CODE_OAUTH_TOKEN), a frissítő token a
// gépen marad. Lejáró tokennél egyszer a felhasználó saját claude-ja frissít (renewClaude), majd újraolvassuk.
function claudeOAuth(encoded) {
  if (typeof encoded !== 'string' || !encoded || encoded.length > MAX_AUTH) return null;
  let d;
  try { d = JSON.parse(encoded); } catch { return null; }
  const o = d && typeof d === 'object' ? d.claudeAiOauth : null;
  if (!o || typeof o !== 'object' || typeof o.accessToken !== 'string' || !o.accessToken || typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt)) return null;
  return { accessToken: o.accessToken, expiresAt: o.expiresAt, subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : undefined };
}

function sourceDirs(env, platform) {
  const home = (platform === 'win32' ? (env.USERPROFILE || env.HOME) : env.HOME) || os.homedir();
  return {
    home,
    claude: env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude'),
    // A CODEX_HOME-ot a cleanEnv kiszűri (az állapotlekérdezés is a ~/.codex-et nézi), ezért itt sem követjük.
    codex: path.join(home, '.codex'),
  };
}

async function readClaudeLogin({ env, platform, readKeychain, src }) {
  const suffix = env.CLAUDE_CONFIG_DIR ? `-${crypto.createHash('sha256').update(src.claude).digest('hex').slice(0, 8)}` : '';
  let account = env.USER;
  if (!account) { try { account = os.userInfo().username; } catch { account = 'claude-code-user'; } }
  const keychain = readKeychain || (platform === 'darwin' ? readKeychainDefault : null);
  let login = null;
  if (keychain) {
    try { login = claudeOAuth(await keychain(`Claude Code-credentials${suffix}`, account)); } catch { login = null; }
  }
  if (!login) login = claudeOAuth(await readAuthFile(path.join(src.claude, '.credentials.json')).catch(() => null));
  return login;
}

// A felhasználó saját claude-ja egy apró, mentés nélküli kérdéssel frissíti a saját belépését (a natív
// frissítés a saját zárolásával és tárolásával fut). Eszköz, MCP, beállítás és munkamenet nélkül.
function renewClaudeDefault({ bin, env, cwd, platform, signal }) {
  return new Promise((resolve) => {
    if (!bin || (signal && signal.aborted)) return resolve();
    const settings = JSON.stringify({ autoMemoryEnabled: false });
    const args = ['-p', '.', '--model', 'haiku', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--settings', settings, '--output-format', 'json'];
    let child;
    try {
      const { launch } = require('./providers');
      const cmd = launch(bin, args, platform);
      child = require('node:child_process').spawn(cmd.bin, cmd.args, { cwd, env, stdio: 'ignore', windowsHide: true, ...(cmd.verbatim ? { windowsVerbatimArguments: true } : {}) });
    } catch { return resolve(); }
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* már kilépett */ } };
    const t = setTimeout(kill, 60000);
    // Megszakításkor (vagy ha a kör korlátja lejár) a frissítő folyamat is leáll.
    if (signal) signal.addEventListener('abort', kill, { once: true });
    const done = () => { clearTimeout(t); if (signal) signal.removeEventListener('abort', kill); resolve(); };
    child.on('error', done);
    child.on('close', done);
  });
}

// --- Codex belépése ----------------------------------------------------------------------------

// A codex ChatGPT-belépése (auth.json) a program saját CODEX_HOME-jába másolva, az esetleges API-kulcs nélkül.
async function codexAuth(src) {
  const file = path.join(src.codex, 'auth.json');
  const raw = await readAuthFile(file).catch(() => null);
  let d = null;
  try { d = raw ? JSON.parse(raw) : null; } catch { d = null; }
  if (!d || typeof d !== 'object' || !d.tokens || typeof d.tokens !== 'object' || typeof d.tokens.refresh_token !== 'string' || (d.auth_mode && d.auth_mode !== 'chatgpt')) {
    throw fail('signed_out', 'ChatGPT: nem vagy belépve. Lépj be a Kapu beállításainál.');
  }
  return { file, raw, doc: { ...d, OPENAI_API_KEY: null } };
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  try { fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

// Ha a futás közben a codex frissítette a belépést, és a felhasználó eredeti auth.json-ja azóta nem
// változott, visszaírjuk oda (különben a régi frissítő token érvénytelenné válhat). Ha az eredeti
// közben változott, nem írunk: a következő kör úgyis a frisset másolja.
function codexWriteBack(auth, privateFile, written) {
  try {
    const fresh = JSON.parse(fs.readFileSync(privateFile, 'utf8'));
    if (!fresh || typeof fresh !== 'object' || !fresh.tokens || typeof fresh.tokens !== 'object') return;
    // Csak ha a tokenek ténylegesen változtak (a fájl átformázása, más mező nem számít).
    if (JSON.stringify(fresh.tokens) === JSON.stringify(JSON.parse(written).tokens)) return;
    if (fs.readFileSync(auth.file, 'utf8') !== auth.raw) return;
    const orig = JSON.parse(auth.raw);
    atomicWrite(auth.file, JSON.stringify({ ...fresh, OPENAI_API_KEY: orig.OPENAI_API_KEY ?? null }, null, 2));
  } catch { /* nem biztonságos, kihagyjuk */ }
}

// Alkalmazásszintű codex-zár: a második kör megvárja, amíg az első lezárul (cleanup).
let codexBusy = false;
const codexQueue = [];
function acquireCodex(signal) {
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = codexQueue.shift();
      if (next) next.grant(); else codexBusy = false;
    };
    const waiter = { grant: () => { codexBusy = true; resolve(release); } };
    if (signal && signal.aborted) return reject(fail('failed', 'Megszakítva.'));
    if (!codexBusy) return waiter.grant();
    codexQueue.push(waiter);
    if (signal) signal.addEventListener('abort', () => {
      const i = codexQueue.indexOf(waiter);
      if (i >= 0) { codexQueue.splice(i, 1); reject(fail('failed', 'Megszakítva.')); }
    }, { once: true });
  });
}

// --- Közös --------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SWEEP_AGE_MS = 10 * 60 * 1000;
const VOICE_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const AGY_VOICE_TOKEN_AGE_MS = 40 * 60 * 1000;

// A codex-mappa, amelyben a szál rollout-fájlja (`sessions/ÉÉÉÉ/HH/NN/rollout-…-<id>.jsonl`) van.
function hasRollout(home, id) {
  let found = false;
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found) return;
      if (e.isFile() && e.name.startsWith('rollout-') && (id ? e.name.includes(id) : true)) { found = true; return; }
      if (e.isDirectory() && !e.isSymbolicLink() && depth < 4) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(path.join(home, 'sessions'), 0);
  return found;
}
function codexHomeOf(root, id) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return null; }
  for (const n of names) {
    const home = path.join(root, n);
    if (n.startsWith('h-') && hasRollout(home, id)) return home;
  }
  return null;
}

function plainFile(file) {
  try { const st = fs.lstatSync(file); return st.isFile() && !st.isSymbolicLink(); } catch { return false; }
}

// A CLI-k saját állapota (munkamenetek, gyorsítótár) a program 0700-as mappájában, nem a ~/.claude, ~/.codex alatt.
const cliDir = (userData, engine) => privateDir(path.join(userData, 'kapu', 'cli', engine));

/** Egy összeomlott vagy megszakított kör maradékai: 10 percnél régebbi agy-home-*, run/* és szál nélküli cli/codex/h-* törölve. */
function sweep(userData, { now = Date.now(), maxAgeMs = SWEEP_AGE_MS } = {}) {
  const base = path.join(userData, 'kapu');
  const old = (p) => { try { return now - fs.lstatSync(p).mtimeMs > maxAgeMs; } catch { return false; } };
  const removed = [];
  const visit = (dir, match) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      if (match(n) && old(p)) { try { fs.rmSync(p, { recursive: true, force: true }); removed.push(p); } catch { /* következő alkalommal */ } }
    }
  };
  visit(base, (n) => n.startsWith('agy-home-'));
  // Élő hang (voice-codex): a belépés másolata csak az indulás idejére kell; a teljes mappa a beszélgetés
  // végén törlődik. Összeomlás után: az auth.json 10 perc, a mappa 3 óra után (egy hangbeszélgetés legfeljebb 30 perc).
  const voiceRoot = path.join(base, 'voice');
  visit(voiceRoot, (n) => (n.startsWith('v-') || n.startsWith('a-')) && (() => { try { return now - fs.lstatSync(path.join(voiceRoot, n)).mtimeMs > VOICE_MAX_AGE_MS; } catch { return false; } })());
  // Antigravity-hang (voice-agy): a belépés másolata a beszélgetés végéig kell (legfeljebb 30 perc), utána nem maradhat.
  let agyVoices = [];
  try { agyVoices = fs.readdirSync(voiceRoot).filter((n) => n.startsWith('a-')); } catch { /* nincs hangmappa */ }
  for (const n of agyVoices) {
    const tok = path.join(voiceRoot, n, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    try { if (now - fs.lstatSync(tok).mtimeMs > AGY_VOICE_TOKEN_AGE_MS) { fs.rmSync(tok, { force: true }); removed.push(tok); } } catch { /* nincs ilyen */ }
  }
  let voices = [];
  try { voices = fs.readdirSync(voiceRoot).filter((n) => n.startsWith('v-')); } catch { /* nincs hangmappa */ }
  for (const n of voices) {
    const auth = path.join(voiceRoot, n, 'auth.json');
    if (old(auth)) { try { fs.rmSync(auth, { force: true }); removed.push(auth); } catch { /* következő alkalommal */ } }
  }
  visit(path.join(base, 'run'), () => true);
  // Félbemaradt új codex-beszélgetés: van mappája, de nincs benne szál.
  const codexRoot = path.join(base, 'cli', 'codex');
  visit(codexRoot, (n) => n.startsWith('h-') && !hasRollout(path.join(codexRoot, n)));
  // Kör közben összeomlott codex: a belépés (frissítő token) másolata ne maradjon a megtartott mappában.
  let homes = [];
  try { homes = fs.readdirSync(codexRoot).filter((n) => n.startsWith('h-')); } catch { /* nincs codex-mappa */ }
  for (const n of homes) {
    const auth = path.join(codexRoot, n, 'auth.json');
    if (old(auth)) { try { fs.rmSync(auth, { force: true }); removed.push(auth); } catch { /* következő alkalommal */ } }
  }
  return removed;
}

/**
 * Egy beszélgetés CLI-oldali fájljainak törlése (a felhasználó törölte a beszélgetést): minden fájl és
 * mappa a motor saját mappájában, amelynek a nevében a munkamenet-azonosító szerepel. Claude:
 * `projects/<mappa>/<id>.jsonl` és `<id>/`; Codex: a beszélgetés teljes `cli/codex/h-*` mappája
 * (benne az SQLite-adatbázisai); Antigravity: `conversations/<id>.db`.
 */
function forgetSession(userData, engine, sessionId) {
  if (!['claude', 'codex', 'agy'].includes(engine) || typeof sessionId !== 'string' || !UUID.test(sessionId)) return 0;
  const root = path.join(userData, 'kapu', 'cli', engine);
  let removed = 0;
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.name.includes(sessionId)) { fs.rmSync(p, { recursive: true, force: true }); removed++; continue; }
      if (e.isDirectory() && !e.isSymbolicLink() && depth < 6) walk(p, depth + 1);
    }
  };
  if (engine === 'codex') {
    const home = codexHomeOf(root, sessionId);
    if (home) { fs.rmSync(home, { recursive: true, force: true }); removed++; }
    return removed;
  }
  walk(root, 0);
  return removed;
}

/**
 * prepare({engine, userData, mcp, premium?, sessionId?, persona?, env?, platform?, sourceHome?, readKeychain?,
 *          claudeBin?, renewClaude?, now?, timeoutMs?, signal?})
 *   → Promise<{cwd, env, args0, premium, mcpFile?, personaFile?, home?, cleanup({sessionId?})}>
 * A cleanup a kör végén hívandó, a CLI által adott munkamenet-azonosítóval (a codex mappáját erre nevezi át).
 * mcp = {mode:'stdio', php, artisan, token} | {mode:'http', url, token}
 * premium = {url, token} | null: a szakmai MCP (második szerver); hibás értéknél kimarad. A `premium` a
 * visszatérési értékben jelzi, hogy bekerült-e.
 * Hiba esetén `code`-dal ellátott Error: 'signed_out' (nincs használható belépés) vagy 'failed'.
 */
async function prepare({ engine, userData, mcp, premium: premiumIn, sessionId, persona, env = process.env, platform = process.platform, sourceHome, readKeychain,
  claudeBin, renewClaude = renewClaudeDefault, now = Date.now, timeoutMs = 150000, signal } = {}) {
  if (!['claude', 'codex', 'agy'].includes(engine)) throw fail('failed', `Ismeretlen motor: ${engine}`);
  if (typeof userData !== 'string' || !userData) throw fail('failed', 'Hiányzik a userData mappa.');
  checkMcp(mcp);
  const premium = cleanPremium(premiumIn);
  sweep(userData);
  const cwd = workDir(userData);
  const src = sourceDirs(sourceHome ? { ...env, HOME: sourceHome, USERPROFILE: sourceHome } : env, platform);
  const baseEnv = cleanEnv(env, platform);
  for (const k of [HTTP_TOKEN_ENV, STDIO_TOKEN_ENV, PREMIUM_TOKEN_ENV, 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']) delete baseEnv[k];
  const removals = [];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const p of removals) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* már nincs */ } }
  };

  if (engine === 'claude') {
    let login = await readClaudeLogin({ env, platform, readKeychain, src });
    const fresh = (l) => l && l.expiresAt > now() + timeoutMs + 60000;
    if (login && !fresh(login)) {
      await renewClaude({ bin: claudeBin, env: cleanEnv(env, platform), cwd, platform, signal });
      if (signal && signal.aborted) throw fail('failed', 'Megszakítva.');
      login = await readClaudeLogin({ env, platform, readKeychain, src });
    }
    if (!login) throw fail('signed_out', 'Claude: nem vagy belépve. Lépj be a Kapu beállításainál.');
    if (!fresh(login)) throw fail('signed_out', 'A Claude-belépés lejárt. Lépj be újra a Kapu beállításainál.');
    const dir = privateDir(path.join(userData, 'kapu', 'run'));
    const id = crypto.randomUUID();
    const mcpFile = path.join(dir, `${id}.mcp.json`);
    const settingsFile = path.join(dir, `${id}.settings.json`);
    const personaFile = path.join(dir, `${id}.persona.md`);
    removals.push(mcpFile, settingsFile, personaFile);
    try {
      const servers = { [SERVER]: claudeServer(mcp) };
      if (premium) servers[PREMIUM_SERVER] = { type: 'http', url: premium.url, headers: { Authorization: `Bearer ${premium.token}` } };
      writePrivate(mcpFile, JSON.stringify({ mcpServers: servers }));
      // Az automatikus memória a --setting-sources "" mellett is bekapcsolva maradna.
      writePrivate(settingsFile, JSON.stringify({ autoMemoryEnabled: false }));
      if (typeof persona === 'string') writePrivate(personaFile, persona);
    } catch (e) { cleanup(); throw e; }
    const claudeEnv = { ...baseEnv, CLAUDE_CONFIG_DIR: cliDir(userData, 'claude'), CLAUDE_CODE_OAUTH_TOKEN: login.accessToken };
    if (login.subscriptionType) claudeEnv.CLAUDE_CODE_SUBSCRIPTION_TYPE = login.subscriptionType;
    const args0 = ['--settings', settingsFile];
    return { cwd, env: claudeEnv, args0, premium: Boolean(premium), mcpFile, personaFile: typeof persona === 'string' ? personaFile : undefined, cleanup };
  }

  if (engine === 'codex') {
    const auth = await codexAuth(src);
    // Egyszerre csak egy codex-kör tart belépés-másolatot (a frissítés visszaírása így nem versenyez).
    const release = await acquireCodex(signal);
    try {
    // A codex a beszélgetés szövegét a saját SQLite-adatbázisaiba is írja (abszolút útvonalakkal), ezért
    // beszélgetésenként külön, végig ugyanott maradó CODEX_HOME: `cli/codex/h-<rand>`. Folytatásnál azt a
    // mappát keressük, amelyben a szál rollout-fájlja van; a beszélgetés törlése a mappa törlése.
    const root = cliDir(userData, 'codex');
    const known = sessionId && UUID.test(sessionId) ? codexHomeOf(root, sessionId) : null;
    const home = known || fs.mkdtempSync(path.join(root, 'h-'));
    try { fs.chmodSync(home, 0o700); } catch { /* Windows */ }
    const fresh = !known;
    const privateFile = path.join(home, 'auth.json');
    const written = JSON.stringify(auth.doc, null, 2);
    try { atomicWrite(privateFile, written); } catch (e) { if (fresh) fs.rmSync(home, { recursive: true, force: true }); throw e; }
    if (signal && signal.aborted) {
      fs.rmSync(privateFile, { force: true });
      if (fresh) fs.rmSync(home, { recursive: true, force: true });
      throw fail('failed', 'Megszakítva.');
    }
    const tokenEnv = mcp.mode === 'stdio' ? STDIO_TOKEN_ENV : HTTP_TOKEN_ENV;
    const codexCleanup = ({ sessionId: id } = {}) => {
      if (cleaned) return;
      codexWriteBack(auth, privateFile, written);
      // A belépés másolata nem marad a mappában a körök között.
      try { fs.rmSync(privateFile, { force: true }); } catch { /* már nincs */ }
      // Új beszélgetés, amely azonosítót sem kapott: nincs mit megtartani.
      if (fresh && !(typeof id === 'string' && UUID.test(id))) {
        try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* a sweep később eltakarítja */ }
      }
      cleanup();
      release();
    };
    const codexEnv = { ...baseEnv, CODEX_HOME: home, [tokenEnv]: mcp.token };
    if (premium) codexEnv[PREMIUM_TOKEN_ENV] = premium.token;
    const args0 = premium ? [...codexMcpArgs(mcp), ...codexPremiumArgs(premium)] : codexMcpArgs(mcp);
    return { cwd, env: codexEnv, args0, premium: Boolean(premium), home, cleanup: codexCleanup };
    } catch (e) { release(); throw e; }
  }

  const home = await agyHome({ userData, mcp, premium, sourceHome: src.home, platform, readKeychain });
  removals.push(home);
  // A beszélgetés folytatásához az agy a saját HOME-ja alatti `conversations/<id>.db`-t keresi.
  // Az ideiglenes HOME minden kör végén törlődik, ezért a beszélgetés-adatbázist a kör előtt
  // visszamásoljuk, utána elmentjük a program saját mappájába (nem a felhasználó ~/.gemini-jébe).
  const store = path.join(cliDir(userData, 'agy'), 'conversations');
  const convDir = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
  try {
    if (sessionId && UUID.test(sessionId)) {
      const saved = path.join(store, `${sessionId}.db`);
      if (plainFile(saved)) { privateDir(convDir); fs.copyFileSync(saved, path.join(convDir, `${sessionId}.db`)); }
    }
  } catch (e) { cleanup(); throw e; }
  const agyCleanup = () => {
    if (cleaned) return;
    try {
      for (const name of fs.readdirSync(convDir)) {
        const m = /^([0-9a-f-]{36})\.db$/i.exec(name);
        if (!m || !UUID.test(m[1]) || !plainFile(path.join(convDir, name))) continue;
        privateDir(store);
        const tmp = path.join(store, `.${name}.${process.pid}.tmp`);
        fs.copyFileSync(path.join(convDir, name), tmp);
        try { fs.chmodSync(tmp, 0o600); } catch { /* Windows */ }
        fs.renameSync(tmp, path.join(store, name));
      }
    } catch { /* nincs mit menteni */ }
    cleanup();
  };
  const agyEnv = { ...baseEnv, HOME: home };
  if (platform === 'win32') agyEnv.USERPROFILE = home;
  return { cwd, env: agyEnv, args0: [], premium: Boolean(premium), home, cleanup: agyCleanup };
}

/**
 * prepareCodexVoice({userData, env?, platform?, sourceHome?, signal?})
 *   → Promise<{home, cwd, env, releaseAuth(), cleanup()}>
 * Az élő hang (`codex app-server`) saját, ideiglenes CODEX_HOME-ja: `<userData>/kapu/voice/v-<rand>` (0700),
 * benne a ChatGPT-belépés 0600-as másolata – a felhasználó ~/.codex mappáját a codex nem látja.
 * A codex-zárat (acquireCodex) csak az indulás idejére tartjuk: a releaseAuth() a hangkapcsolat felépülése
 * után visszaírja a közben frissített belépést, törli a másolatot és elengedi a zárat (így a hang közbeni
 * szöveges körök futhatnak). A cleanup() a teljes mappát törli; mindkettő többször is hívható.
 */
async function prepareCodexVoice({ userData, env = process.env, platform = process.platform, sourceHome, signal } = {}) {
  if (typeof userData !== 'string' || !userData) throw fail('failed', 'Hiányzik a userData mappa.');
  sweep(userData);
  const src = sourceDirs(sourceHome ? { ...env, HOME: sourceHome, USERPROFILE: sourceHome } : env, platform);
  const auth = await codexAuth(src);
  const release = await acquireCodex(signal);
  let home;
  try {
    const root = privateDir(path.join(userData, 'kapu', 'voice'));
    home = fs.mkdtempSync(path.join(root, 'v-'));
    try { fs.chmodSync(home, 0o700); } catch { /* Windows */ }
    const cwd = privateDir(path.join(home, 'work'));
    const privateFile = path.join(home, 'auth.json');
    const written = JSON.stringify(auth.doc, null, 2);
    atomicWrite(privateFile, written);
    if (signal && signal.aborted) throw fail('failed', 'Megszakítva.');
    const baseEnv = cleanEnv(env, platform);
    for (const k of [HTTP_TOKEN_ENV, STDIO_TOKEN_ENV, 'CODEX_API_KEY', 'ELECTRON_RUN_AS_NODE', 'CLAUDE_CODE_OAUTH_TOKEN']) delete baseEnv[k];
    let authGone = false;
    let gone = false;
    let onAbort = null;
    const releaseAuth = () => {
      if (authGone) return;
      authGone = true;
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      codexWriteBack(auth, privateFile, written);
      try { fs.rmSync(privateFile, { force: true }); } catch { /* már nincs */ }
      release();
    };
    const cleanup = () => {
      releaseAuth();
      if (gone) return;
      gone = true;
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* a sweep később eltakarítja */ }
    };
    // Az indulás alatt (amíg a belépés másolata itt van) a megszakítás azonnal, szinkron töröl: így kilépéskor
    // sem marad a mappában belépés, akkor sem, ha a hívó még nem kapta meg ezt a visszatérési értéket.
    if (signal) { onAbort = () => cleanup(); signal.addEventListener('abort', onAbort, { once: true }); }
    return { home, cwd, env: { ...baseEnv, CODEX_HOME: home }, releaseAuth, cleanup };
  } catch (e) {
    if (home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* sweep */ } }
    release();
    throw e;
  }
}

// Az élő Antigravity-hang interaktív agy-ja: a saját olvasó-, író-, parancs-, web- és MCP-eszközei mind tiltva
// (a hangmodell az iroda adataihoz sem fér hozzá: azt a szöveges kör hozza, voice-bridge).
const AGY_VOICE_DENY = ['read_file(*)', 'write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)', 'download_url(*)', 'mcp(*)'];

/**
 * prepareAgyVoice({userData, instructions?, env?, platform?, sourceHome?, readKeychain?, signal?})
 *   → Promise<{home, cwd, env, cleanup()}>
 * Az élő Antigravity-hang saját, ideiglenes HOME-ja: `<userData>/kapu/voice/a-<rand>` (0700), benne a belépés
 * 0600-as másolata, a beállítás (minden saját eszköz tiltva, nincs MCP-szerver, a munkamappa megbízható, a
 * használati adatok küldése kikapcsolva) és az első indítás állapota – ezt a felhasználó saját agy-jából vesszük
 * át, helyette nem fogadunk el semmit: ha ő még nem fejezte be az első indítást, hibát adunk. A munkamappa
 * (`work/`) AGENTS.md-je a hang személyisége. A felhasználó ~/.gemini-jébe nem írunk. A cleanup() mindent töröl.
 */
async function prepareAgyVoice({ userData, instructions = '', env = process.env, platform = process.platform, sourceHome, readKeychain, signal } = {}) {
  if (typeof userData !== 'string' || !userData) throw fail('failed', 'Hiányzik a userData mappa.');
  sweep(userData);
  const src = sourceDirs(sourceHome ? { ...env, HOME: sourceHome, USERPROFILE: sourceHome } : env, platform);
  const { login, cli, userSettings } = await readAgyLogin({ sourceHome: src.home, platform, readKeychain });
  let onboarding = null;
  try { onboarding = JSON.parse(await readAuthFile(path.join(cli, 'cache', 'onboarding.json')) || 'null'); } catch { onboarding = null; }
  if (!onboarding || onboarding.onboardingComplete !== true) {
    throw fail('onboarding', 'Az Antigravity első indítása még nincs kész: indítsd el egyszer a Terminálban az agy parancsot, és fejezd be a beállítást.');
  }
  if (signal && signal.aborted) throw fail('failed', 'Megszakítva.');
  const root = privateDir(path.join(userData, 'kapu', 'voice'));
  const home = fs.mkdtempSync(path.join(root, 'a-'));
  // Többször is hívható, és minden hívás újra töröl: a leálló agy kilépés közben még írhat a mappába
  // (voice_chats, history), ezért a hívó a végleges leállítás után még egyszer hívja.
  const cleanup = () => {
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* újra, vagy a sweep */ }
  };
  try {
    try { fs.chmodSync(home, 0o700); } catch { /* Windows */ }
    const cwd = privateDir(path.join(home, 'work'));
    const cfgDir = privateDir(path.join(home, '.gemini', 'antigravity-cli'));
    writePrivate(path.join(cfgDir, 'antigravity-oauth-token'), login);
    writePrivate(path.join(cfgDir, 'settings.json'), JSON.stringify({
      colorScheme: typeof userSettings.colorScheme === 'string' && userSettings.colorScheme.length < 64 ? userSettings.colorScheme : 'light',
      telemetryEnabled: false,
      // Az agy a valódi (linkek nélküli) útvonalat is nézheti (macOS: /var → /private/var).
      trustedWorkspaces: [...new Set([cwd, fs.realpathSync(cwd)])],
      permissions: { deny: AGY_VOICE_DENY },
    }));
    writePrivate(path.join(privateDir(path.join(cfgDir, 'cache')), 'onboarding.json'), JSON.stringify({
      consumerOnboardingComplete: onboarding.consumerOnboardingComplete === true,
      enterpriseOnboardingComplete: onboarding.enterpriseOnboardingComplete === true,
      onboardingComplete: true,
    }));
    writePrivate(path.join(cwd, 'AGENTS.md'), String(instructions || '').slice(0, 60000));
    if (signal && signal.aborted) throw fail('failed', 'Megszakítva.');
    const baseEnv = cleanEnv(env, platform);
    for (const k of [HTTP_TOKEN_ENV, STDIO_TOKEN_ENV, 'ELECTRON_RUN_AS_NODE', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY']) delete baseEnv[k];
    const voiceEnv = { ...baseEnv, HOME: home };
    if (platform === 'win32') voiceEnv.USERPROFILE = home;
    // Megszakításkor (kilépés az indulás alatt) szinkron törlés, akkor is, ha a hívó még nem kapta meg az eredményt.
    if (signal) signal.addEventListener('abort', cleanup, { once: true });
    return { home, cwd, env: voiceEnv, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

module.exports = { prepare, prepareCodexVoice, prepareAgyVoice, AGY_VOICE_DENY, sweep, forgetSession, codexMcpArgs, consumerLogin, claudeOAuth, SERVER, AGY_ALLOW, AGY_DENY, HTTP_TOKEN_ENV, STDIO_TOKEN_ENV, PREMIUM_SERVER, PREMIUM_TOKEN_ENV };
