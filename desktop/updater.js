'use strict';
// KapuMail alkalmazás-frissítő:
// - indulás után 10 mp-cel, majd 6 óránként és kézi kérésre lekéri a nyilvános https://kapumail.hu/letoltes/latest.json fájlt
//   (süti, munkamenet és bármiféle személyes vagy ügyféladat küldése nélkül);
// - letöltéskor ellenőrzi a csomag SHA-256 lenyomatát és a https://kapumail.hu forrást;
// - Developer ID-val aláírt, írható helyen lévő macOS KapuMail.app esetén ellenőrzi a kódaláírás TeamIdentifier-jét,
//   mellé készíti elő az új verziót (.KapuMail-<verzió>.app), és kilépéskor / újraindításkor atomikusan kicseréli;
// - Windows telepítőnél (.exe) vagy nem helyben cserélhető .dmg-nél a Letöltések mappába teszi az ellenőrzött telepítőt,
//   és az „Újraindítás most” gombra leállítja a helyi szervert, majd megnyitja a telepítőt.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DEFAULT_UPDATE_URL = 'https://kapumail.hu/letoltes/latest.json';
const UPDATE_INTERVAL_MS = 6 * 60 * 60_000;
const START_DELAY_MS = 10_000;
const FETCH_TIMEOUT_MS = 10_000;

const SWAP_SCRIPT = [
  'pid=$1 app=$2 staged=$3 backup=$4 relaunch=$5',
  'i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 300 ]; do sleep 0.2; i=$((i+1)); done',
  'if [ -d "$staged" ] && mv "$app" "$backup"; then',
  '  if mv "$staged" "$app"; then rm -rf "$backup"; else mv "$backup" "$app"; fi',
  'fi',
  'rm -rf "$staged"',
  '[ "$relaunch" = 1 ] && open "$app"',
  'exit 0',
].join('\n');

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function isAllowedUrl(rawUrl, allowLocal = false) {
  try {
    const u = new URL(String(rawUrl || ''));
    if (u.protocol === 'https:' && u.hostname === 'kapumail.hu') return true;
    if (allowLocal && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return true;
    return false;
  } catch {
    return false;
  }
}

function parseArtifact(raw, ext, allowLocal) {
  if (!raw || typeof raw !== 'object') return null;
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : '';
  const bytes = typeof raw.bytes === 'number' && Number.isFinite(raw.bytes) && raw.bytes > 0 ? Math.floor(raw.bytes) : null;
  if (!isAllowedUrl(url, allowLocal)) return null;
  try {
    if (!new URL(url).pathname.toLowerCase().endsWith(ext)) return null;
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  return { url, sha256, bytes };
}

function parseLatestRelease(raw, { allowLocal = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  const date = typeof raw.date === 'string' ? raw.date.trim() : '';
  const download = typeof raw.download === 'string' ? raw.download.trim() : 'https://kapumail.hu/#letoltes';
  const notesRaw = typeof raw.notes === 'string' ? raw.notes.trim() : '';
  if (!parseSemver(version)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!isAllowedUrl(download, allowLocal)) return null;
  const notes = notesRaw && isAllowedUrl(notesRaw, allowLocal) ? notesRaw : null;
  const described = raw.described === false ? false : Boolean(notes);

  const macArm64 = raw.mac && parseArtifact(raw.mac.arm64, '.dmg', allowLocal);
  const macX64 = raw.mac && parseArtifact(raw.mac.x64, '.dmg', allowLocal);
  const winX64 = raw.windows && parseArtifact(raw.windows.x64, '.exe', allowLocal);
  if (!macArm64 && !macX64 && !winX64) return null;

  return {
    version,
    date,
    download,
    notes,
    described,
    mac: {
      ...(macArm64 ? { arm64: macArm64 } : {}),
      ...(macX64 ? { x64: macX64 } : {}),
    },
    windows: {
      ...(winX64 ? { x64: winX64 } : {}),
    },
  };
}

function pickArtifact(latest, { platform = process.platform, arch = process.arch } = {}) {
  if (!latest) return null;
  if (platform === 'win32') return (latest.windows && latest.windows.x64) || null;
  if (platform === 'darwin') {
    const m = latest.mac || {};
    return (arch === 'arm64' ? m.arm64 : m.x64) || m.arm64 || m.x64 || null;
  }
  return null;
}

function appBundle(execPath) {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(execPath || ''));
  return m ? m[1] : null;
}

const runCmd = (cmd, args) => execFileAsync(cmd, args, { encoding: 'utf8', timeout: 120_000 });

async function signingTeam(bundle, execFn = runCmd) {
  if (!bundle) return null;
  try {
    const { stderr } = await execFn('codesign', ['-dv', '--verbose=2', bundle]);
    const m = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(String(stderr || ''));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function canReplace(bundle, team, accessFn = p => fs.accessSync(p, fs.constants.W_OK)) {
  if (!bundle || !team) return false;
  try {
    accessFn(path.dirname(bundle));
    accessFn(bundle);
    return true;
  } catch {
    return false;
  }
}

async function detectReplaceable({ platform = process.platform, execPath = process.execPath, execFn = runCmd, accessFn } = {}) {
  if (platform !== 'darwin') return null;
  const bundle = appBundle(execPath);
  if (!bundle) return null;
  const team = await signingTeam(bundle, execFn);
  if (!canReplace(bundle, team, accessFn)) return null;
  return { bundle, team };
}

async function stageMacUpdate({ dmgPath, bundle, version, team, execFn = runCmd, tempDir }) {
  const baseTmp = tempDir || path.dirname(dmgPath);
  const mount = fs.mkdtempSync(path.join(baseTmp, '.kapumail-update-'));
  const staged = path.join(path.dirname(bundle), `.KapuMail-${version}.app`);
  const req = `anchor apple generic and certificate leaf[subject.OU] = "${team}"`;
  const verify = targetApp => execFn('codesign', ['--verify', '--deep', '--strict', `-R=${req}`, targetApp]);
  try {
    await execFn('hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount]);
    let copying = false;
    try {
      const mountedApp = path.join(mount, 'KapuMail.app');
      await verify(mountedApp);
      const { stdout } = await execFn('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(mountedApp, 'Contents', 'Info.plist')]);
      const found = String(stdout || '').trim();
      if (found !== version) throw new Error(`A csomag verziója (${found}) eltér a várt verziótól (${version}).`);
      copying = true;
      fs.rmSync(staged, { recursive: true, force: true });
      await execFn('ditto', [mountedApp, staged]);
      await verify(staged);
    } catch (err) {
      if (copying) fs.rmSync(staged, { recursive: true, force: true });
      throw err;
    } finally {
      await execFn('hdiutil', ['detach', mount, '-force']).catch(() => undefined);
    }
  } finally {
    fs.rmSync(mount, { recursive: true, force: true });
  }
  return staged;
}

function swapAfterExit({ pid = process.pid, bundle, stagedPath, relaunch = false, spawnFn = spawn }) {
  spawnFn('/bin/sh', ['-c', SWAP_SCRIPT, 'kapumail-update', String(pid), bundle, stagedPath, `${stagedPath}.old`, relaunch ? '1' : '0'], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

async function downloadAndVerify(url, expectedSha256, destPath, { fetchImpl = globalThis.fetch, allowLocal = false, onProgress, expectedBytes = null } = {}) {
  if (!isAllowedUrl(url, allowLocal)) throw new Error('Nem engedélyezett frissítési cím.');
  const res = await fetchImpl(url, { cache: 'no-store', credentials: 'omit', redirect: 'follow' });
  if (!res || !res.ok) throw new Error(`A letöltés sikertelen (HTTP ${(res && res.status) || 'hiba'}).`);
  if (res.url && !isAllowedUrl(res.url, allowLocal)) throw new Error('Nem engedélyezett átirányítás.');

  const totalHeader = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
  const total = totalHeader > 0 ? totalHeader : (expectedBytes && expectedBytes > 0 ? expectedBytes : 0);

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const partPath = `${destPath}.part-${process.pid}-${Date.now()}`;
  const hash = crypto.createHash('sha256');
  let received = 0;
  const out = fs.createWriteStream(partPath);

  try {
    if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of res.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buf);
        received += buf.length;
        if (!out.write(buf)) await new Promise(r => out.once('drain', r));
        if (onProgress) onProgress(received, total);
      }
    } else {
      const ab = await res.arrayBuffer();
      const buf = Buffer.from(ab);
      hash.update(buf);
      received = buf.length;
      out.write(buf);
      if (onProgress) onProgress(received, total || buf.length);
    }
    await new Promise((resolve, reject) => {
      out.end(err => (err ? reject(err) : resolve()));
    });
    const digest = hash.digest('hex').toLowerCase();
    if (digest !== String(expectedSha256 || '').toLowerCase()) {
      throw new Error('A letöltött telepítő ellenőrzőösszege nem egyezik.');
    }
    fs.rmSync(destPath, { force: true });
    fs.renameSync(partPath, destPath);
    return destPath;
  } catch (err) {
    try { out.destroy(); } catch {}
    fs.rmSync(partPath, { force: true });
    throw err;
  }
}

function noticeOnce(noticeFile, version) {
  if (!noticeFile || !version) return false;
  try {
    const prev = JSON.parse(fs.readFileSync(noticeFile, 'utf8'));
    if (prev && prev.notifiedVersion === version) return false;
  } catch {}
  try {
    fs.mkdirSync(path.dirname(noticeFile), { recursive: true });
    fs.writeFileSync(noticeFile, JSON.stringify({ notifiedVersion: version, at: new Date().toISOString() }) + '\n');
  } catch {}
  return true;
}

function createUpdater({
  currentVersion,
  isPackaged = false,
  envUpdateUrl = process.env.KAPUMAIL_UPDATE_URL || '',
  platform = process.platform,
  arch = process.arch,
  userDataDir = '',
  tempDir = '',
  downloadsDir = '',
  fetchImpl = globalThis.fetch,
  now = Date.now,
  startDelayMs = START_DELAY_MS,
  intervalMs = UPDATE_INTERVAL_MS,
  timeoutMs = FETCH_TIMEOUT_MS,
  replaceablePromise = null,
  stageFn = stageMacUpdate,
  swapFn = swapAfterExit,
  openInstaller = async () => '',
  stopServices = async () => {},
  quitApp = () => {},
  onState = () => {},
  onProgress = () => {},
  onWindowProgress = () => {},
  onNotifyAvailable = () => {},
} = {}) {
  const customUrl = String(envUpdateUrl || '').trim();
  const allowLocal = !isPackaged && Boolean(customUrl);
  const url = customUrl ? (isAllowedUrl(customUrl, allowLocal) ? customUrl : null) : (isPackaged ? DEFAULT_UPDATE_URL : null);

  let replaceable = null;
  let replaceableReady = Promise.resolve(replaceablePromise !== null ? replaceablePromise : detectReplaceable({ platform })).then(r => {
    replaceable = r || null;
    return replaceable;
  }).catch(() => null);

  let checkedAt = null;
  let failed = false;
  let latest = null;
  let inFlight = null;
  let installInFlight = null;
  let timer = null;
  let interval = null;
  let staged = null; // { version, path }
  let pendingInstaller = null; // { version, path }
  let lastProgress = null;
  let relaunchOnQuit = false;
  let swapTriggered = false;

  const noticeFile = userDataDir ? path.join(userDataDir, 'update-notice.json') : '';

  function state() {
    const enabled = url !== null;
    const artifact = pickArtifact(latest, { platform, arch });
    const available = Boolean(enabled && latest && artifact && compareVersions(latest.version, currentVersion) === 1);
    return {
      current: currentVersion,
      enabled,
      canInstall: Boolean(replaceable && platform === 'darwin'),
      checkedAt,
      failed,
      available,
      latest: available || latest ? {
        version: latest.version,
        date: latest.date,
        notes: latest.notes,
        described: latest.described,
        download: (artifact && artifact.url) || latest.download,
      } : null,
      progress: lastProgress,
    };
  }

  function emitState() {
    const s = state();
    onState(s);
    return s;
  }

  function emitProgress(p) {
    lastProgress = p;
    onProgress(p);
  }

  async function look() {
    await replaceableReady;
    let found = null;
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
        credentials: 'omit',
      });
      if (res && res.ok) {
        const parsed = parseLatestRelease(JSON.parse(await res.text()), { allowLocal });
        if (parsed) found = parsed;
      }
    } catch {
      // Hálózati hiba vagy időtúllépés: a következő ellenőrzés újra megpróbálja.
    }
    checkedAt = new Date(now()).toISOString();
    failed = found === null;
    if (found) latest = found;
    const s = emitState();
    if (s.available && s.latest && noticeOnce(noticeFile, s.latest.version)) {
      onNotifyAvailable(s.latest);
    }
    return s;
  }

  function check() {
    if (url === null) return replaceableReady.then(() => emitState());
    if (!inFlight) {
      inFlight = look().finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  function start() {
    if (timer || interval || url === null) return;
    timer = setTimeout(() => {
      timer = null;
      void check();
      interval = setInterval(() => void check(), intervalMs);
      if (interval && typeof interval.unref === 'function') interval.unref();
    }, startDelayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    if (interval) clearInterval(interval);
    timer = null;
    interval = null;
  }

  function install() {
    if (installInFlight) return installInFlight;
    installInFlight = (async () => {
      await replaceableReady;
      const s = await check();
      if (!s.enabled || s.failed || !s.available || !latest) {
        return { ok: false, error: 'A frissítési kiszolgáló jelenleg nem érhető el.' };
      }
      const artifact = pickArtifact(latest, { platform, arch });
      if (!artifact) return { ok: false, error: 'Ehhez a rendszerhez nem található telepítőcsomag.' };

      const version = latest.version;
      if (staged && staged.version === version && fs.existsSync(staged.path)) {
        emitProgress({ phase: 'ready', version, mode: 'replace' });
        return { ok: true, version, mode: 'replace' };
      }
      if (pendingInstaller && pendingInstaller.version === version && fs.existsSync(pendingInstaller.path)) {
        emitProgress({ phase: 'ready', version, mode: 'installer' });
        return { ok: true, version, mode: 'installer' };
      }

      const fileName = path.basename(new URL(artifact.url).pathname);
      const targetDir = replaceable && platform === 'darwin' ? (tempDir || downloadsDir) : (downloadsDir || tempDir);
      const destPath = path.join(targetDir, fileName);

      let shownPct = -1;
      emitProgress({ phase: 'downloading', version, percent: null });
      let downloaded = null;
      try {
        downloaded = await downloadAndVerify(artifact.url, artifact.sha256, destPath, {
          fetchImpl,
          allowLocal,
          expectedBytes: artifact.bytes,
          onProgress: (received, total) => {
            const pct = total > 0 ? Math.min(100, Math.max(0, Math.floor((received / total) * 100))) : null;
            const key = pct === null ? -2 : pct;
            if (key === shownPct) return;
            shownPct = key;
            onWindowProgress(pct === null ? 2 : pct / 100);
            emitProgress({ phase: 'downloading', version, percent: pct });
          },
        });
      } catch (err) {
        onWindowProgress(-1);
        emitProgress({ phase: 'failed', version });
        return { ok: false, error: String((err && err.message) || err) };
      }
      onWindowProgress(-1);

      if (replaceable && platform === 'darwin') {
        emitProgress({ phase: 'verifying', version });
        try {
          const stagedPath = await stageFn({
            dmgPath: downloaded,
            bundle: replaceable.bundle,
            version,
            team: replaceable.team,
            tempDir: tempDir || path.dirname(downloaded),
          });
          staged = { version, path: stagedPath };
          fs.rmSync(downloaded, { force: true });
          emitProgress({ phase: 'ready', version, mode: 'replace' });
          return { ok: true, version, mode: 'replace' };
        } catch (err) {
          // Ha az automatikus csere nem sikerült (pl. jogosultság), áttesszük a Letöltésekbe kézi telepítéshez.
          try {
            if (downloadsDir && path.dirname(downloaded) !== downloadsDir) {
              fs.mkdirSync(downloadsDir, { recursive: true });
              const kept = path.join(downloadsDir, fileName);
              fs.rmSync(kept, { force: true });
              fs.renameSync(downloaded, kept);
              downloaded = kept;
            }
          } catch {}
          if (downloaded && fs.existsSync(downloaded)) {
            pendingInstaller = { version, path: downloaded };
            emitProgress({ phase: 'ready', version, mode: 'installer' });
            return { ok: true, version, mode: 'installer' };
          }
          emitProgress({ phase: 'failed', version });
          return { ok: false, error: String((err && err.message) || err) };
        }
      }

      pendingInstaller = { version, path: downloaded };
      emitProgress({ phase: 'ready', version, mode: 'installer' });
      return { ok: true, version, mode: 'installer' };
    })().finally(() => {
      installInFlight = null;
    });
    return installInFlight;
  }

  async function restartToUpdate() {
    if (staged && replaceable && fs.existsSync(staged.path)) {
      emitProgress({ phase: 'restarting', version: staged.version });
      relaunchOnQuit = true;
      quitApp();
      return { ok: true, mode: 'replace' };
    }
    if (pendingInstaller && fs.existsSync(pendingInstaller.path)) {
      emitProgress({ phase: 'restarting', version: pendingInstaller.version });
      await stopServices();
      await openInstaller(pendingInstaller.path);
      quitApp();
      return { ok: true, mode: 'installer' };
    }
    return { ok: false, error: 'Nincs előkészített frissítés.' };
  }

  function applyStagedOnQuit() {
    if (swapTriggered || !staged || !replaceable || !fs.existsSync(staged.path)) return false;
    swapTriggered = true;
    swapFn({
      pid: process.pid,
      bundle: replaceable.bundle,
      stagedPath: staged.path,
      relaunch: relaunchOnQuit,
    });
    return true;
  }

  return {
    state: () => replaceableReady.then(() => state()),
    stateSync: state,
    check,
    start,
    stop,
    install,
    restartToUpdate,
    applyStagedOnQuit,
  };
}

module.exports = {
  DEFAULT_UPDATE_URL,
  UPDATE_INTERVAL_MS,
  START_DELAY_MS,
  SWAP_SCRIPT,
  compareVersions,
  isAllowedUrl,
  parseLatestRelease,
  pickArtifact,
  appBundle,
  signingTeam,
  canReplace,
  detectReplaceable,
  stageMacUpdate,
  swapAfterExit,
  downloadAndVerify,
  noticeOnce,
  createUpdater,
};
