'use strict';
// Kapu-chat: egykattintásos belépés az AI-előfizetésbe, látható terminál nélkül.
// A belépőparancs (claude auth login / codex login / agy) egy saját, rejtett tmux-munkamenetben fut
// (külön socket: -L kapumail, így a felhasználó saját tmux-ához nem nyúl). A parancs maga nyitja meg
// a böngészőt, és a szolgáltató OAuth-oldala a parancs helyi visszahívására (localhost) tér vissza;
// a felület csak az állapotot figyeli. Ha a szolgáltató kódot ad (kézi visszahívás), a felhasználó
// beilleszti, és mi gépeljük be a rejtett munkamenetbe. Ha nincs tmux, a régi Terminál-ablakos út marad.
// Elektron nélküli modul: a folyamatindítás kívülről állítható, a tesztek hálózat és tmux nélkül futnak.

const nodeSpawn = require('node:child_process').spawn;
const fs = require('node:fs');
const path = require('node:path');
const P = require('./providers');

const SOCKET = 'kapumail';
const SESSION = 'kapu-signin';
const SIGN_IN_ARGS = { claude: ['auth', 'login'], codex: ['login'], agy: [] };
// Csak a szolgáltatók saját belépőoldala nyitható meg újra a felületről.
const URL_HOSTS = { claude: ['claude.com', 'claude.ai', 'platform.claude.com', 'console.anthropic.com'], codex: ['auth.openai.com'], agy: ['accounts.google.com'] };
const CODE_RE = /^[A-Za-z0-9#._~%\/+=-]{4,512}$/;

const shellQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

function resolveTmux(env = process.env) {
  const dirs = [...(env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].filter(Boolean);
  for (const d of dirs) {
    const f = path.join(d, 'tmux');
    try { if (fs.statSync(f).isFile()) { fs.accessSync(f, fs.constants.X_OK); return f; } } catch { /* tovább */ }
  }
  return null;
}

// Rövid parancs futtatása; sosem dob: {code, stdout, error?}.
function run(spawn, bin, args, { env, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let done = false;
    let child;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ stdout, ...r }); };
    const timer = setTimeout(() => { try { child && child.kill('SIGKILL'); } catch { /* már kilépett */ } finish({ code: null, timedOut: true }); }, timeoutMs);
    try { child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return finish({ code: null, error: e }); }
    child.stdout && child.stdout.on('data', (d) => { if (stdout.length < 1 << 18) stdout += d; });
    child.on('error', (e) => finish({ code: null, error: e }));
    child.on('close', (code) => finish({ code }));
  });
}

/**
 * A rejtett munkamenet képernyőjéből: a belépő URL (a tördelt sorokat összefűzve), kér-e kódot,
 * és az Antigravity választómenüje látszik-e még.
 */
function parsePane(engine, text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\s+$/, ''));
  let url = '';
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].indexOf('https://');
    if (at < 0) continue;
    let u = lines[i].slice(at).trim();
    // Tördelt URL: a következő sorok szóköz nélküli folytatásai hozzátartoznak.
    for (let j = i + 1; j < lines.length; j++) {
      const n = lines[j].trim();
      if (!n || /\s/.test(n)) break;
      u += n;
    }
    u = u.split(/\s/)[0];
    if (okUrl(engine, u)) { url = u; break; }
  }
  const all = lines.join('\n');
  return {
    url,
    needsCode: /paste (the )?(authorization )?code|authorization code\.\.\.|enter (the )?code/i.test(all),
    menu: engine === 'agy' && /select login method/i.test(all),
  };
}

function okUrl(engine, u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && (URL_HOSTS[engine] || []).includes(x.hostname);
  } catch { return false; }
}

/**
 * A rejtett belépés kezelője egy gépre. opts: tmux (útvonal vagy null), spawn, env, bin(engine) → útvonal.
 */
function create({ tmux = resolveTmux(), spawn = nodeSpawn, env = process.env, bin = (e) => P.resolveBin(e, env), platform = process.platform } = {}) {
  let active = null; // {engine, t0}
  const tm = (args, o) => run(spawn, tmux, ['-L', SOCKET, ...args], { env, ...o });
  const available = () => !!tmux && platform !== 'win32';

  async function kill() {
    if (!tmux) return;
    await tm(['kill-session', '-t', SESSION], { timeoutMs: 4000 });
  }

  async function start(engine) {
    if (!P.ENGINES.includes(engine)) throw new Error('Ismeretlen motor.');
    if (!available()) return { ok: false, unavailable: true };
    const file = bin(engine);
    if (!file) return { ok: false, error: `${P.ENGINE_LABEL[engine]} nincs telepítve ezen a gépen.` };
    await kill();
    // Az API-kulcsokat és a más fiókra terelő változókat a parancs elől is elvesszük (env -u), ahogy a kérdéseknél.
    const unset = P.STRIP_ENV.flatMap((k) => ['-u', k]);
    const cmd = ['env', ...unset, file, ...SIGN_IN_ARGS[engine]].map(shellQuote).join(' ');
    const r = await tm(['new-session', '-d', '-s', SESSION, '-x', '220', '-y', '60', cmd], { env: P.cleanEnv(env, platform) });
    if (r.code !== 0) return { ok: false, error: 'A belépés nem indult el.' };
    active = { engine, t0: Date.now(), menuSent: false };
    return { ok: true };
  }

  /** {running, engine, url, needsCode} – a felület 1–2 mp-enként kérdezi. */
  async function state() {
    if (!active) return { running: false };
    const r = await tm(['capture-pane', '-p', '-J', '-t', SESSION, '-S', '-200'], { timeoutMs: 4000 });
    if (r.code !== 0) { active = null; return { running: false }; }
    const p = parsePane(active.engine, r.stdout);
    // Antigravity: a belépési mód menüjében az első (Google OAuth) a jó, ezt egyszer kiválasztjuk.
    if (p.menu && !active.menuSent) { active.menuSent = true; await tm(['send-keys', '-t', SESSION, 'Enter'], { timeoutMs: 4000 }); }
    return { running: true, engine: active.engine, url: p.url, needsCode: p.needsCode };
  }

  /** A szolgáltató oldaláról kimásolt kód begépelése a rejtett munkamenetbe. */
  async function code(text) {
    if (!active) return { ok: false, error: 'Nincs folyamatban belépés.' };
    const c = String(text || '').trim();
    if (!CODE_RE.test(c)) return { ok: false, error: 'Ez nem tűnik belépési kódnak.' };
    const a = await tm(['send-keys', '-t', SESSION, '-l', c], { timeoutMs: 4000 });
    const b = await tm(['send-keys', '-t', SESSION, 'Enter'], { timeoutMs: 4000 });
    return a.code === 0 && b.code === 0 ? { ok: true } : { ok: false, error: 'A kód nem küldhető el.' };
  }

  async function stop() {
    active = null;
    await kill();
    return { ok: true };
  }

  return { available, start, state, code, stop, okUrl: (u) => !!active && okUrl(active.engine, u) };
}

module.exports = { create, parsePane, okUrl, resolveTmux, SOCKET, SESSION, SIGN_IN_ARGS, URL_HOSTS };
