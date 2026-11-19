'use strict';
// Kapu-chat: a hiányzó AI-parancssor (claude, codex, agy) telepítése a háttérben, a szolgáltató saját,
// hivatalos telepítőjével. Csak a felhasználó kattintására fut; rendszergazdai jog nem kell (mindhárom
// telepítő a felhasználó saját mappájába tesz). Az előfizetést nem itt nézzük: az a belépésnél derül ki.
// Elektron nélküli modul: a folyamatindítás kívülről állítható, a tesztek hálózat nélkül futnak.

const nodeSpawn = require('node:child_process').spawn;
const path = require('node:path');
const P = require('./providers');

// Csak ezek a címek futhatnak (a szolgáltatók dokumentációja szerint, 2026-11).
const SOURCES = {
  claude: { sh: 'https://claude.ai/install.sh', ps1: 'https://claude.ai/install.ps1', shell: 'bash', host: 'claude.ai' },
  codex: { sh: 'https://chatgpt.com/codex/install.sh', ps1: 'https://chatgpt.com/codex/install.ps1', shell: 'sh', host: 'chatgpt.com' },
  agy: { sh: 'https://antigravity.google/cli/install.sh', ps1: 'https://antigravity.google/cli/install.ps1', shell: 'bash', host: 'antigravity.google' },
};
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const LOG_MAX = 1 << 16;

/** A telepítőparancs: {bin, args, source}. Shell-változót, felhasználói szöveget nem fűzünk bele. */
function installCommand(engine, { platform = process.platform, env = process.env } = {}) {
  if (!P.ENGINES.includes(engine)) throw new Error(`Ismeretlen motor: ${engine}`);
  const s = SOURCES[engine];
  if (platform === 'win32') {
    const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    return {
      bin: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; irm ${s.ps1} | iex`],
      source: s.host,
    };
  }
  return { bin: '/bin/bash', args: ['-c', `set -o pipefail; curl -fsSL --proto '=https' --tlsv1.2 ${s.sh} | ${s.shell}`], source: s.host };
}

// Kérdés nélkül fusson (a codex különben rákérdez, hogy elindítsa-e), API-kulcs nélkül.
function installEnv(env, platform) {
  const e = P.cleanEnv(env, platform);
  e.CODEX_NON_INTERACTIVE = '1';
  e.CI = e.CI || '1';
  return e;
}

/**
 * Egy telepítés egyszerre. {start(engine), state()}: a start nem várja meg a végét (a felület figyeli az állapotot).
 * Az állapot: {running, engine, installed?, error?, source?}.
 */
function createInstaller({ spawn = nodeSpawn, platform = process.platform, env = process.env, timeoutMs = INSTALL_TIMEOUT_MS, resolveBin = P.resolveBin } = {}) {
  let cur = { running: false, engine: null };
  let job = null;

  function run(engine) {
    const cmd = installCommand(engine, { platform, env });
    return new Promise((resolve) => {
      let log = '';
      let done = false;
      let child;
      const add = (d) => { if (log.length < LOG_MAX) log += d; };
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ ...r, log }); };
      const timer = setTimeout(() => { try { child && child.kill('SIGKILL'); } catch { /* már kilépett */ } finish({ code: null, timedOut: true }); }, timeoutMs);
      try {
        child = spawn(cmd.bin, cmd.args, { env: installEnv(env, platform), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) { return finish({ code: null, error: e }); }
      child.stdout && child.stdout.on('data', add);
      child.stderr && child.stderr.on('data', add);
      child.on('error', (e) => finish({ code: null, error: e }));
      child.on('close', (code) => finish({ code }));
    });
  }

  function start(engine) {
    if (!P.ENGINES.includes(engine)) return { ok: false, error: 'Ismeretlen motor.' };
    if (cur.running) return cur.engine === engine ? { ok: true, running: true } : { ok: false, error: 'Már fut egy telepítés, várd meg a végét.' };
    if (platform !== 'win32' && platform !== 'darwin') return { ok: false, error: 'A telepítés csak macOS-en és Windowson érhető el.' };
    const label = P.ENGINE_LABEL[engine];
    const source = SOURCES[engine].host;
    cur = { running: true, engine, source };
    job = run(engine).then((r) => {
      // A telepítők néha 0-val lépnek ki akkor is, ha a fájl nem jött létre: a végén mindig megnézzük.
      const found = resolveBin(engine, env, platform);
      if (found) cur = { running: false, engine, installed: true, source };
      else {
        const why = r.timedOut ? 'tíz perc alatt nem ért véget'
          : r.error ? 'nem indult el'
            : /could not resolve|failed to connect|timed out|unable to connect|nem siker/i.test(r.log) ? 'nem érte el a szolgáltatót (nincs internet, vagy tűzfal tiltja)'
              : 'nem sikerült';
        cur = { running: false, engine, installed: false, source, error: `A(z) ${label} telepítése ${why}. Próbáld újra, vagy telepítsd kézzel a ${source} oldaláról.` };
      }
      return cur;
    });
    return { ok: true, running: true, source };
  }

  return {
    start,
    state: () => ({ ...cur }),
    /** Teszteknek: megvárja a futó telepítést. */
    wait: () => job || Promise.resolve(cur),
  };
}

module.exports = { SOURCES, INSTALL_TIMEOUT_MS, installCommand, createInstaller };
