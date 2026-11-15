'use strict';
// Helyi PHP/Laravel-szerver indítása és életciklusa (fejlesztői és telepített alkalmazásban).
// Csomagolt módban a programkönyvtár (`resources/app-server` és `resources/php`) csak olvasható
// (macOS aláírás és notarizáció, Windows telepítő), ezért minden írható állapot – `.env`, SQLite
// adatbázis, `storage/`, gyorsítótár és az `artisan` / `router.php` belépési burkoló – a felhasználó
// saját adatmappájában (`<userData>/local-server`, 0700) jön létre.

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8000;

function resolvePaths({ isPackaged, appDir, resourcesPath, userData, platform = process.platform }) {
  if (!isPackaged) {
    const appRoot = path.join(appDir, '..', 'app');
    return {
      isPackaged: false,
      platform,
      php: 'php',
      caFile: null,
      appRoot,
      publicDir: path.join(appRoot, 'public'),
      artisan: path.join(appRoot, 'artisan'),
      stateDir: null,
      router: null,
      dbFile: null,
    };
  }
  const phpDir = path.join(resourcesPath, 'php');
  const appRoot = path.join(resourcesPath, 'app-server');
  const stateDir = path.join(userData, 'local-server');
  return {
    isPackaged: true,
    platform,
    php: path.join(phpDir, platform === 'win32' ? 'php.exe' : 'php'),
    caFile: path.join(phpDir, 'cacert.pem'),
    appRoot,
    publicDir: path.join(appRoot, 'public'),
    artisan: path.join(stateDir, 'artisan'),
    bundledArtisan: path.join(appRoot, 'artisan'),
    stateDir,
    router: path.join(stateDir, 'router.php'),
    dbFile: path.join(stateDir, 'database.sqlite'),
  };
}

function phpLiteral(str) {
  return "'" + String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function buildPhpEnvMap(paths, appUrl) {
  if (!paths.isPackaged) return {};
  const cacheDir = path.join(paths.stateDir, 'cache');
  const env = {
    IRATKAPU_ENV_DIR: paths.stateDir,
    IRATKAPU_STORAGE_PATH: path.join(paths.stateDir, 'storage'),
    IRATKAPU_ARTISAN_PATH: paths.artisan,
    DB_CONNECTION: 'sqlite',
    DB_DATABASE: paths.dbFile,
    APP_SERVICES_CACHE: path.join(cacheDir, 'services.php'),
    APP_PACKAGES_CACHE: path.join(cacheDir, 'packages.php'),
    APP_CONFIG_CACHE: path.join(cacheDir, 'config.php'),
    APP_ROUTES_CACHE: path.join(cacheDir, 'routes-v7.php'),
    APP_EVENTS_CACHE: path.join(cacheDir, 'events.php'),
  };
  if (appUrl) env.APP_URL = appUrl;
  if (paths.caFile && fs.existsSync(paths.caFile)) {
    env.SSL_CERT_FILE = paths.caFile;
    env.CURL_CA_BUNDLE = paths.caFile;
  }
  return env;
}

function buildPhpPreamble(paths) {
  const vars = buildPhpEnvMap(paths);
  const lines = ['<?php'];
  for (const [k, v] of Object.entries(vars)) {
    const kv = phpLiteral(`${k}=${v}`);
    const kLit = phpLiteral(k);
    const vLit = phpLiteral(v);
    lines.push(`if (getenv(${kLit}) === false || getenv(${kLit}) === '') { putenv(${kv}); $_ENV[${kLit}] = $_SERVER[${kLit}] = ${vLit}; }`);
  }
  if (paths.caFile && fs.existsSync(paths.caFile)) {
    lines.push(`@ini_set('openssl.cafile', ${phpLiteral(paths.caFile)});`);
  }
  return lines.join('\n');
}

function writeAtomic(file, content, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  try { fs.chmodSync(tmp, mode); } catch { /* Windows */ }
  fs.renameSync(tmp, file);
}

function preparePackagedState(paths) {
  const dirs = [
    paths.stateDir,
    path.join(paths.stateDir, 'cache'),
    path.join(paths.stateDir, 'storage'),
    path.join(paths.stateDir, 'storage', 'app', 'private'),
    path.join(paths.stateDir, 'storage', 'app', 'public'),
    path.join(paths.stateDir, 'storage', 'app', 'legal'),
    path.join(paths.stateDir, 'storage', 'framework', 'cache', 'data'),
    path.join(paths.stateDir, 'storage', 'framework', 'cache', 'locks'),
    path.join(paths.stateDir, 'storage', 'framework', 'sessions'),
    path.join(paths.stateDir, 'storage', 'framework', 'views'),
    path.join(paths.stateDir, 'storage', 'logs'),
  ];
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  try { fs.chmodSync(paths.stateDir, 0o700); } catch { /* Windows */ }

  const envFile = path.join(paths.stateDir, '.env');
  if (!fs.existsSync(envFile)) {
    const appKey = 'base64:' + crypto.randomBytes(32).toString('base64');
    const dbPosix = paths.dbFile.replace(/\\/g, '/');
    const envBody = [
      'APP_NAME=KapuMail',
      'APP_ENV=local',
      `APP_KEY=${appKey}`,
      'APP_DEBUG=false',
      'APP_TIMEZONE=Europe/Budapest',
      'APP_LOCALE=hu',
      'APP_FALLBACK_LOCALE=hu',
      'LOG_CHANNEL=single',
      'LOG_LEVEL=warning',
      'DB_CONNECTION=sqlite',
      `DB_DATABASE="${dbPosix}"`,
      'SESSION_DRIVER=database',
      'SESSION_LIFETIME=10080',
      'CACHE_STORE=database',
      'QUEUE_CONNECTION=database',
      'MAIL_MAILER=log',
      'IRATKAPU_MODE=demo',
      '',
    ].join('\n');
    writeAtomic(envFile, envBody, 0o600);
  }

  const preamble = buildPhpPreamble(paths);
  const artisanWrapper = [
    '#!/usr/bin/env php',
    preamble,
    `require ${phpLiteral(paths.bundledArtisan)};`,
    '',
  ].join('\n');
  writeAtomic(paths.artisan, artisanWrapper, 0o700);

  const routerBody = [
    preamble,
    `$pub = ${phpLiteral(paths.publicDir)};`,
    "$uri = urldecode(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/');",
    "if ($uri !== '/' && !str_contains($uri, \"\\0\") && is_file($pub . $uri)) { return false; }",
    "$_SERVER['SCRIPT_NAME'] = '/index.php';",
    "$_SERVER['SCRIPT_FILENAME'] = $pub . '/index.php';",
    "require $pub . '/index.php';",
    '',
  ].join('\n');
  writeAtomic(paths.router, routerBody, 0o600);

  const isNewDb = !fs.existsSync(paths.dbFile) || fs.statSync(paths.dbFile).size === 0;
  if (!fs.existsSync(paths.dbFile)) {
    fs.closeSync(fs.openSync(paths.dbFile, 'a', 0o600));
  }
  return { isNewDb };
}

function phpIniArgs(paths) {
  if (!paths.isPackaged || !paths.caFile || !fs.existsSync(paths.caFile)) return [];
  return ['-d', `curl.cainfo=${paths.caFile}`, '-d', `openssl.cafile=${paths.caFile}`];
}

function spawnEnv(paths, appUrl, baseEnv = process.env) {
  const extra = buildPhpEnvMap(paths, appUrl);
  return { ...baseEnv, ...extra };
}

function runPhpCommand(paths, args, { timeoutMs = 60000, env = process.env } = {}) {
  return new Promise((resolve) => {
    try {
      const child = spawn(paths.php, [...phpIniArgs(paths), ...args], {
        cwd: paths.appRoot,
        env: spawnEnv(paths, null, env),
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      if (child.stderr) {
        child.stderr.on('data', (c) => { if (stderr.length < 4096) stderr += c.toString('utf8'); });
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve({ ok: false, stderr: stderr || 'Időtúllépés.' });
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, stderr: (err && err.message) || String(err) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, code, stderr: stderr.trim() });
      });
    } catch (err) {
      resolve({ ok: false, stderr: (err && err.message) || String(err) });
    }
  });
}

function pingHealth(origin, pathName = '/login', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(origin + pathName, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500 && res.statusCode !== 404);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

function tryListenPort(host, port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(null));
    srv.listen(port, host, () => {
      const addr = srv.address();
      const chosen = addr && typeof addr === 'object' ? addr.port : null;
      srv.close(() => resolve(chosen));
    });
  });
}

async function pickFreePort(host = DEFAULT_HOST, preferred = DEFAULT_PORT) {
  const first = await tryListenPort(host, preferred);
  if (first) return first;
  return tryListenPort(host, 0);
}

function createLocalServer(opts) {
  let child = null;
  let activeOrigin = null;
  let migrated = false;
  let lastError = '';
  let booting = null;

  const getPaths = () => resolvePaths(opts);

  async function ensureMigrated(paths, isNewDb) {
    if (migrated || opts.smoke) return true;
    const targetArtisan = paths.isPackaged ? paths.bundledArtisan : paths.artisan;
    if (!fs.existsSync(targetArtisan)) {
      lastError = 'A helyi alkalmazásszerver fájljai nem találhatók.';
      return false;
    }
    if (paths.isPackaged && !fs.existsSync(paths.php)) {
      lastError = 'A beépített PHP futtatókörnyezet nem található.';
      return false;
    }
    const mig = await runPhpCommand(paths, [paths.artisan, 'migrate', '--force'], { timeoutMs: 60000 });
    if (!mig.ok) {
      lastError = mig.stderr || 'Az adatbázis előkészítése nem sikerült.';
      return false;
    }
    if (paths.isPackaged) {
      const seedStamp = path.join(paths.stateDir, '.seeded-v1');
      if (isNewDb || !fs.existsSync(seedStamp)) {
        const seeded = await runPhpCommand(paths, [paths.artisan, 'db:seed', '--force'], { timeoutMs: 60000 });
        if (!seeded.ok) {
          lastError = seeded.stderr || 'Az alapadatok betöltése nem sikerült.';
          return false;
        }
        try { writeAtomic(seedStamp, new Date().toISOString() + '\n', 0o600); } catch {}
      }
    }
    migrated = true;
    return true;
  }

  async function boot(requestedOrigin) {
    const paths = getPaths();
    const defaultOrigin = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

    // Ha saját indítású helyi szerverünk már fut és válaszol, maradunk annál az origónál.
    if (child && activeOrigin && await pingHealth(activeOrigin, '/up')) {
      return { ok: true, origin: activeOrigin };
    }

    // Ha külső szervert adtak meg (pl. https://... vagy egyedi IRATKAPU_URL), csak ellenőrizzük.
    if (requestedOrigin && requestedOrigin !== defaultOrigin && requestedOrigin !== activeOrigin) {
      const up = await pingHealth(requestedOrigin, '/login');
      return { ok: up, origin: requestedOrigin };
    }

    // Fejlesztői módban, ha már fut egy külső `php artisan serve` a 8000-es porton, használjuk azt.
    if (!paths.isPackaged && await pingHealth(defaultOrigin, '/up')) {
      await ensureMigrated(paths, false);
      activeOrigin = defaultOrigin;
      return { ok: true, origin: defaultOrigin };
    }

    let isNewDb = false;
    if (paths.isPackaged) {
      try {
        ({ isNewDb } = preparePackagedState(paths));
      } catch (err) {
        lastError = (err && err.message) || 'A helyi adatmappa nem készíthető elő.';
        return { ok: false, origin: requestedOrigin || defaultOrigin, error: lastError };
      }
    }

    if (!(await ensureMigrated(paths, isNewDb))) {
      return { ok: false, origin: requestedOrigin || defaultOrigin, error: lastError };
    }

    const port = await pickFreePort(DEFAULT_HOST, DEFAULT_PORT);
    if (!port) {
      lastError = 'Nem sikerült szabad helyi portot nyitni (127.0.0.1).';
      return { ok: false, origin: requestedOrigin || defaultOrigin, error: lastError };
    }
    const origin = `http://${DEFAULT_HOST}:${port}`;
    const args = paths.isPackaged
      ? [...phpIniArgs(paths), '-S', `${DEFAULT_HOST}:${port}`, '-t', paths.publicDir, paths.router]
      : [paths.artisan, 'serve', `--host=${DEFAULT_HOST}`, `--port=${port}`];

    let stderr = '';
    try {
      child = spawn(paths.php, args, {
        cwd: paths.isPackaged ? paths.publicDir : paths.appRoot,
        env: spawnEnv(paths, origin),
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      child = null;
      lastError = (err && err.message) || 'A helyi szerver nem indítható el.';
      return { ok: false, origin, error: lastError };
    }

    if (child.stderr) {
      child.stderr.on('data', (c) => { if (stderr.length < 2048) stderr += c.toString('utf8'); });
    }
    child.on('error', (err) => {
      lastError = (err && err.message) || 'Helyi szerver folyamat-hiba.';
      child = null;
    });
    child.on('exit', () => { child = null; });

    for (let i = 0; i < 60; i++) {
      if (!child) break;
      await new Promise((r) => setTimeout(r, 200));
      if (await pingHealth(origin, '/up')) {
        activeOrigin = origin;
        lastError = '';
        return { ok: true, origin };
      }
    }

    stop();
    lastError = stderr.trim() || 'A helyi szerver nem válaszolt időben.';
    return { ok: false, origin, error: lastError };
  }

  async function ensure(requestedOrigin) {
    if (booting) return booting;
    booting = boot(requestedOrigin).finally(() => { booting = null; });
    return booting;
  }

  async function runArtisan(cmd, extraArgs = [], timeoutMs = 10 * 60 * 1000) {
    const paths = getPaths();
    const target = paths.isPackaged ? paths.bundledArtisan : paths.artisan;
    if (!fs.existsSync(target)) return false;
    if (paths.isPackaged && !fs.existsSync(paths.artisan)) {
      try { preparePackagedState(paths); } catch { return false; }
    }
    const res = await runPhpCommand(paths, [paths.artisan, cmd, ...extraArgs], { timeoutMs });
    return res.ok;
  }

  function mcpStdio() {
    const paths = getPaths();
    if (paths.isPackaged && !fs.existsSync(paths.artisan)) {
      try { preparePackagedState(paths); } catch { /* ellenőrzéskor kiderül */ }
    }
    return { mode: 'stdio', php: paths.php, artisan: paths.artisan };
  }

  function stop() {
    const p = child;
    child = null;
    if (!p) return;
    try { if (p.stderr) p.stderr.destroy(); } catch {}
    try { p.kill(); } catch {}
  }

  return {
    ensure,
    runArtisan,
    mcpStdio,
    stop,
    getOrigin: () => activeOrigin,
    getLastError: () => lastError,
    resolvePaths: getPaths,
  };
}

module.exports = {
  createLocalServer,
  resolvePaths,
  preparePackagedState,
  pickFreePort,
  pingHealth,
};
