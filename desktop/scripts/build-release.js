'use strict';
// KapuMail kiadási csomagépítő (macOS arm64 + x64 aláírt és Apple által notarizált .dmg, valamint Windows x64 NSIS .exe).
//
// Lépések:
//  1. Ellenőrzi a macOS Developer ID Application tanúsítványt és a `kapumail-notary` kulcskarika-profilt (hivatalos kiadásnál).
//  2. Letölti / gyorsítótárazza a hordozható PHP 8.4 CLI futtatókörnyezetet (mac-arm64, mac-x64, win-x64 + vcruntime140 + cacert.pem).
//  3. Előkészíti a tiszta, fejlesztői csomagok nélküli Laravel alkalmazásszervert (`desktop/.stage/app-server`).
//  4. Kirendereli a Retina macOS .dmg ablak-hátteret (`desktop/.cache/dmg/background.png` + `@2x.png`).
//  5. Felépíti és Developer ID-val aláírja a `KapuMail.app` csomagokat (arm64 és x64), ellenőrzi a beépített PHP/SQLite
//     futását írásvédett programkönyvtár mellett, majd Apple-notarizálja és tűzi (`stapler`) mindkét `.app`-ot.
//  6. Becsomagolja, aláírja, notarizálja, tűzi és Gatekeeperrel (`spctl`) ellenőrzi a két `.dmg` lemezképet:
//       - desktop/dist/KapuMail-0.2.1-arm64.dmg
//       - desktop/dist/KapuMail-0.2.1-x64.dmg
//  7. Felépíti a Windows x64 telepítőt Kapu-plüss ikonnal:
//       - desktop/dist/KapuMail-Setup-0.2.1.exe
//  8. Frissíti a `marketing/landing/letoltes/` szimlinkeket és kiírja a SHA-256 ellenőrzőösszegeket.

const { execFile, execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { Arch, build, Platform } = require('electron-builder');
const { createLocalServer } = require('../local-server');
const { userAgent } = require('../mode');

const execFileAsync = promisify(execFile);

const DESKTOP_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(DESKTOP_DIR, '..');
const APP_SRC_DIR = path.join(REPO_DIR, 'app');
const CACHE_DIR = path.join(DESKTOP_DIR, '.cache');
const STAGE_DIR = path.join(DESKTOP_DIR, '.stage');
const DIST_DIR = path.join(DESKTOP_DIR, 'dist');
const LANDING_DL_DIR = path.join(REPO_DIR, 'marketing', 'landing', 'letoltes');
const ENTITLEMENTS = path.join(DESKTOP_DIR, 'entitlements.mac.plist');
const ICON_PNG = path.join(DESKTOP_DIR, 'assets', 'icon.png');
const PKG = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8'));
const VERSION = PKG.version;
const ELECTRON_BIN = path.join(DESKTOP_DIR, 'node_modules', '.bin', 'electron');

const PHP_URLS = {
  macArm64: 'https://dl.static-php.dev/static-php-cli/common/php-8.4.23-cli-macos-aarch64.tar.gz',
  macX64: 'https://dl.static-php.dev/static-php-cli/common/php-8.4.23-cli-macos-x86_64.tar.gz',
  winX64: 'https://windows.php.net/downloads/releases/php-8.4.27-1-nts-Win32-vs17-x64.zip',
  pyEmbedWin: 'https://www.python.org/ftp/python/3.13.2/python-3.13.2-embed-amd64.zip',
  cacert: 'https://curl.se/ca/cacert.pem',
};

const WIN_PHP_FILES = [
  'php.exe',
  'php8.dll',
  'libsqlite3.dll',
  'libcrypto-3-x64.dll',
  'libssl-3-x64.dll',
  'libsodium.dll',
  'libssh2.dll',
  'nghttp2.dll',
  'brotlidec.dll',
  'brotlicommon.dll',
  'ext/php_curl.dll',
  'ext/php_fileinfo.dll',
  'ext/php_mbstring.dll',
  'ext/php_openssl.dll',
  'ext/php_pdo_sqlite.dll',
  'ext/php_sodium.dll',
  'ext/php_sqlite3.dll',
  'ext/php_zip.dll',
];

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function downloadFile(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  log(`Letöltés: ${url}`);
  const tmp = `${dest}.part`;
  execFileSync('curl', ['-fsSL', '--retry', '3', '-o', tmp, url], { stdio: 'inherit' });
  fs.renameSync(tmp, dest);
}

function detectMacSigning() {
  const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const matches = [...out.matchAll(/"(Developer ID Application: .+ \(([A-Z0-9]{10})\))"/g)]
    .map(([, identity, team]) => ({ identity, team }));
  const wanted = (process.env.KAPUMAIL_MAC_IDENTITY || '').trim();
  const filtered = wanted ? matches.filter((m) => m.team === wanted || m.identity === wanted) : matches;
  if (!filtered.length) {
    throw new Error('Nem található érvényes "Developer ID Application" tanúsítvány a macOS kulcskarikán.');
  }
  if (filtered.length > 1) {
    throw new Error(`Több Developer ID tanúsítvány található; válassz egyet a KAPUMAIL_MAC_IDENTITY változóval: ${filtered.map((m) => m.team).join(', ')}`);
  }
  const notaryProfile = (process.env.KAPUMAIL_NOTARY_PROFILE || 'kapumail-notary').trim();
  execFileSync('xcrun', ['notarytool', 'history', '--keychain-profile', notaryProfile, '--output-format', 'json'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return { ...filtered[0], notaryProfile, unsigned: false };
}

function preparePhpToolchains() {
  const dlDir = path.join(CACHE_DIR, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });

  // Ha a munkamenet ideiglenes mappájában már megvan, átvesszük, hogy ne töltsük le kétszer.
  const seedIfPresent = (src, dst) => {
    if (!fs.existsSync(dst) && fs.existsSync(src) && fs.statSync(src).size > 1024) {
      fs.copyFileSync(src, dst);
    }
  };
  seedIfPresent('/tmp/php-mac-check/arm64.tar.gz', path.join(dlDir, 'php-mac-arm64.tar.gz'));
  seedIfPresent('/tmp/php-win-check/official.zip', path.join(dlDir, 'php-win-x64.zip'));
  seedIfPresent('/tmp/php-win-check/py-embed.zip', path.join(dlDir, 'py-embed-win-x64.zip'));
  seedIfPresent('/tmp/php-mac-check/cacert.pem', path.join(dlDir, 'cacert.pem'));

  const caArchive = path.join(dlDir, 'cacert.pem');
  downloadFile(PHP_URLS.cacert, caArchive);

  // macOS arm64 + x64
  for (const [key, url, folder, expectedArch] of [
    ['php-mac-arm64.tar.gz', PHP_URLS.macArm64, 'mac-arm64', 'arm64'],
    ['php-mac-x64.tar.gz', PHP_URLS.macX64, 'mac-x64', 'x86_64'],
  ]) {
    const tarPath = path.join(dlDir, key);
    downloadFile(url, tarPath);
    const outDir = path.join(CACHE_DIR, 'php', folder);
    const binPath = path.join(outDir, 'php');
    if (!fs.existsSync(binPath)) {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
      execFileSync('tar', ['-xzf', tarPath, '-C', outDir]);
      fs.chmodSync(binPath, 0o755);
    }
    fs.copyFileSync(caArchive, path.join(outDir, 'cacert.pem'));
    const archs = execFileSync('lipo', ['-archs', binPath], { encoding: 'utf8' }).trim();
    if (archs !== expectedArch) {
      throw new Error(`Váratlan PHP architektúra (${binPath}): ${archs} !== ${expectedArch}`);
    }
  }

  // Windows x64
  const winZip = path.join(dlDir, 'php-win-x64.zip');
  const pyZip = path.join(dlDir, 'py-embed-win-x64.zip');
  downloadFile(PHP_URLS.winX64, winZip);
  downloadFile(PHP_URLS.pyEmbedWin, pyZip);

  const winOut = path.join(CACHE_DIR, 'php', 'win-x64');
  fs.rmSync(winOut, { recursive: true, force: true });
  fs.mkdirSync(path.join(winOut, 'ext'), { recursive: true });
  execFileSync('unzip', ['-q', '-o', winZip, ...WIN_PHP_FILES, '-d', winOut]);
  execFileSync('unzip', ['-q', '-o', pyZip, 'vcruntime140.dll', 'vcruntime140_1.dll', '-d', winOut]);
  fs.copyFileSync(caArchive, path.join(winOut, 'cacert.pem'));

  const winIni = [
    '[PHP]',
    'engine = On',
    'short_open_tag = Off',
    'expose_php = Off',
    'max_execution_time = 120',
    'memory_limit = 256M',
    'error_reporting = E_ALL & ~E_DEPRECATED & ~E_STRICT',
    'display_errors = Off',
    'log_errors = On',
    'post_max_size = 64M',
    'upload_max_filesize = 64M',
    'default_charset = "UTF-8"',
    'extension_dir = "ext"',
    'extension=curl',
    'extension=fileinfo',
    'extension=mbstring',
    'extension=openssl',
    'extension=pdo_sqlite',
    'extension=sodium',
    'extension=sqlite3',
    'extension=zip',
    '[Date]',
    'date.timezone = "Europe/Budapest"',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(winOut, 'php.ini'), winIni);

  return {
    macArm64: path.join(CACHE_DIR, 'php', 'mac-arm64'),
    macX64: path.join(CACHE_DIR, 'php', 'mac-x64'),
    winX64: winOut,
  };
}

function stageAppServer() {
  log('Laravel alkalmazásszerver előkészítése (fejlesztői függőségek nélkül)…');
  const dst = path.join(STAGE_DIR, 'app-server');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });

  const copyItems = ['app', 'config', 'public', 'resources', 'routes', 'artisan', 'composer.json', 'composer.lock'];
  for (const item of copyItems) {
    fs.cpSync(path.join(APP_SRC_DIR, item), path.join(dst, item), { recursive: true });
  }
  fs.mkdirSync(path.join(dst, 'bootstrap', 'cache'), { recursive: true });
  fs.copyFileSync(path.join(APP_SRC_DIR, 'bootstrap', 'app.php'), path.join(dst, 'bootstrap', 'app.php'));
  if (fs.existsSync(path.join(APP_SRC_DIR, 'bootstrap', 'providers.php'))) {
    fs.copyFileSync(path.join(APP_SRC_DIR, 'bootstrap', 'providers.php'), path.join(dst, 'bootstrap', 'providers.php'));
  }
  fs.mkdirSync(path.join(dst, 'database'), { recursive: true });
  for (const sub of ['migrations', 'seeders', 'factories', 'data']) {
    const s = path.join(APP_SRC_DIR, 'database', sub);
    if (fs.existsSync(s)) fs.cpSync(s, path.join(dst, 'database', sub), { recursive: true });
  }
  fs.mkdirSync(path.join(dst, 'storage', 'logs'), { recursive: true });

  // Tiszta production vendor telepítés; az ext-sodium macOS statikus common PHP-ban nem külön modul,
  // a Passport RSA-kulcsokat használ (az összes 355 teszt lefut vele).
  execFileSync('composer', [
    'install',
    '--no-dev',
    '--optimize-autoloader',
    '--no-interaction',
    '--no-scripts',
    '--ignore-platform-req=ext-sodium',
    '--working-dir',
    dst,
  ], { stdio: 'inherit' });

  // Biztonsági ellenőrzés: sem .env, sem adatbázis, sem bootstrap/cache fájl ne legyen a csomagban.
  for (const forbidden of [
    path.join(dst, '.env'),
    path.join(dst, 'database', 'database.sqlite'),
  ]) {
    fs.rmSync(forbidden, { force: true });
  }
  for (const f of fs.readdirSync(path.join(dst, 'bootstrap', 'cache'))) {
    if (f !== '.gitignore') fs.rmSync(path.join(dst, 'bootstrap', 'cache', f), { recursive: true, force: true });
  }
  if (process.env.KAPUMAIL_OFFICIAL_BUILD !== '0') {
    fs.writeFileSync(path.join(dst, 'bootstrap', 'official-build.json'), JSON.stringify({
      official: true,
      version: VERSION,
    }, null, 2) + '\n');
  } else {
    fs.rmSync(path.join(dst, 'bootstrap', 'official-build.json'), { force: true });
  }
  fs.chmodSync(path.join(dst, 'artisan'), 0o755);
  return dst;
}

function renderDmgBackground() {
  const assetBg1 = path.join(DESKTOP_DIR, 'assets', 'dmg', 'background.png');
  const assetBg2 = path.join(DESKTOP_DIR, 'assets', 'dmg', 'background@2x.png');
  if (fs.existsSync(assetBg1) && fs.existsSync(assetBg2)) return assetBg1;
  const outDir = path.join(CACHE_DIR, 'dmg');
  const bg1 = path.join(outDir, 'background.png');
  const bg2 = path.join(outDir, 'background@2x.png');
  if (fs.existsSync(bg1) && fs.existsSync(bg2)) return bg1;
  log('macOS .dmg háttérkép kirajzolása…');
  execFileSync(ELECTRON_BIN, [path.join(__dirname, 'make-dmg-bg.js'), `--out=${outDir}`], { stdio: 'inherit' });
  if (!fs.existsSync(bg1) || !fs.existsSync(bg2)) {
    throw new Error('A .dmg háttérkép nem jött létre.');
  }
  return bg1;
}

function verifySignedBinary(binPath, signing) {
  const details = spawnSync('codesign', ['--display', '--verbose=2', binPath], { encoding: 'utf8' }).stderr || '';
  const ents = execFileSync('codesign', ['--display', '--entitlements', '-', '--xml', binPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (!details.includes(`TeamIdentifier=${signing.team}`) || !/flags=0x\w*\(runtime\)/.test(details) || !ents.includes('com.apple.security.cs.allow-jit')) {
    throw new Error(`A bináris nincs megfelelően aláírva (${binPath}):\n${details}`);
  }
}

async function verifyPackagedRuntime(appBundlePath, signing = {}) {
  const resourcesPath = path.join(appBundlePath, 'Contents', 'Resources');
  const tmpUser = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-release-verify-'));
  const srv = createLocalServer({
    isPackaged: true,
    appDir: path.join(resourcesPath, 'app.asar'),
    resourcesPath,
    userData: tmpUser,
    smoke: false,
  });
  try {
    const started = await srv.ensure('http://127.0.0.1:8000');
    if (!started.ok) throw new Error(`A csomagolt helyi szerver nem indult el: ${srv.getLastError()}`);
    const legal = await fetch(started.origin + '/legal/aszf');
    if (legal.status !== 200) throw new Error(`/legal/aszf váratlan státusz: ${legal.status}`);
    const enter = await fetch(started.origin + '/local/enter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': userAgent('Mozilla/5.0', VERSION, 'local'),
      },
      body: JSON.stringify({ secret: crypto.randomBytes(32).toString('base64url'), terms: true }),
    });
    if (enter.status !== 200) throw new Error(`/local/enter váratlan státusz: ${enter.status}`);
  } finally {
    srv.stop();
    fs.rmSync(tmpUser, { recursive: true, force: true });
  }
  // A futás egyetlen bájtot sem módosíthatott az aláírt .app csomagon belül!
  if (!signing.unsigned) {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appBundlePath], { stdio: 'inherit' });
  }
}

async function notarizeAndStaple(targetPath, signing) {
  const isApp = targetPath.endsWith('.app');
  const label = path.basename(targetPath);
  if (!isApp) {
    const pre = spawnSync('xcrun', ['stapler', 'staple', targetPath], { stdio: 'pipe' });
    if (pre.status === 0) {
      execFileSync('xcrun', ['stapler', 'validate', targetPath], { stdio: 'inherit' });
      log(`Meglévő Apple notarizációs jegy tűzve: ${label}`);
      return;
    }
  }
  const uploadPath = isApp ? `${targetPath}.zip` : targetPath;
  if (isApp) {
    fs.rmSync(uploadPath, { force: true });
    execFileSync('ditto', ['-c', '-k', '--keepParent', targetPath, uploadPath]);
  }
  try {
    log(`Apple notarizáció beküldése: ${label}…`);
    let stdout = '';
    try {
      const res = await execFileAsync('xcrun', [
        'notarytool', 'submit', uploadPath,
        '--keychain-profile', signing.notaryProfile,
        '--wait',
        '--output-format', 'json',
      ], { maxBuffer: 10 * 1024 * 1024 });
      stdout = res.stdout;
    } catch (err) {
      stdout = (err && err.stdout) || String(err);
    }
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch {}
    if (!parsed || parsed.status !== 'Accepted') {
      let detail = stdout;
      if (parsed && parsed.id) {
        try {
          detail = execFileSync('xcrun', ['notarytool', 'log', parsed.id, '--keychain-profile', signing.notaryProfile], { encoding: 'utf8' });
        } catch {}
      }
      throw new Error(`Az Apple notarizáció elutasította (${label}): ${parsed ? parsed.status : 'ismeretlen'}\n${detail}`);
    }
    log(`Notarizáció elfogadva (${label}, id=${parsed.id}), jegy tűzése (stapler)…`);
  } finally {
    if (isApp) fs.rmSync(uploadPath, { force: true });
  }
  execFileSync('xcrun', ['stapler', 'staple', targetPath], { stdio: 'inherit' });
  execFileSync('xcrun', ['stapler', 'validate', targetPath], { stdio: 'inherit' });
}

async function buildMacApp(archName, phpDir, appServerDir, signing) {
  const ebArch = archName === 'arm64' ? Arch.arm64 : Arch.x64;
  const outRoot = path.join(STAGE_DIR, `mac-${archName}`);
  fs.rmSync(outRoot, { recursive: true, force: true });
  log(`macOS ${archName} .app építése${signing.unsigned ? ' (aláírás nélkül)' : ' és Developer ID aláírása'}…`);

  await build({
    publish: 'never',
    projectDir: DESKTOP_DIR,
    targets: Platform.MAC.createTarget(['dir'], ebArch),
    config: {
      ...PKG.build,
      afterPack: async (context) => {
        const huDir = path.join(context.appOutDir, 'KapuMail.app', 'Contents', 'Resources', 'hu.lproj');
        fs.mkdirSync(huDir, { recursive: true });
        fs.writeFileSync(
          path.join(huDir, 'InfoPlist.strings'),
          '"NSMicrophoneUsageDescription" = "A KapuMail a mikrofont csak akkor használja, ha élő beszélgetést indítasz Kapuval.";\n',
        );
      },
      directories: { output: outRoot },
      extraResources: [
        { from: appServerDir, to: 'app-server' },
        { from: phpDir, to: 'php' },
      ],
      mac: {
        ...PKG.build.mac,
        icon: ICON_PNG,
        identity: signing.unsigned ? null : (signing.identity ? signing.identity.replace(/^Developer ID Application: /, '') : null),
        hardenedRuntime: !signing.unsigned,
        entitlements: ENTITLEMENTS,
        entitlementsInherit: ENTITLEMENTS,
        gatekeeperAssess: false,
        notarize: false,
      },
    },
  });

  const subDir = fs.readdirSync(outRoot).find((n) => n.startsWith('mac'));
  const appPath = path.join(outRoot, subDir, 'KapuMail.app');
  if (!fs.existsSync(appPath)) throw new Error(`Nem található a felépített KapuMail.app: ${outRoot}`);
  if (!fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'app-server', 'vendor', 'autoload.php'))) {
    throw new Error(`Hiányzik a vendor/autoload.php a csomagból: ${appPath}`);
  }

  if (!signing.unsigned) {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
    verifySignedBinary(path.join(appPath, 'Contents', 'Resources', 'php', 'php'), signing);
  }

  if (archName === 'arm64') {
    log('Csomagolt arm64 KapuMail.app helyi PHP + SQLite működésének élő ellenőrzése…');
    await verifyPackagedRuntime(appPath, signing);
  }
  return appPath;
}

async function packMacDmg(archName, appPath, dmgBgPath, signing) {
  const ebArch = archName === 'arm64' ? Arch.arm64 : Arch.x64;
  const dmgWork = path.join(STAGE_DIR, `dmg-work-${archName}`);
  fs.rmSync(dmgWork, { recursive: true, force: true });
  fs.mkdirSync(dmgWork, { recursive: true });
  fs.writeFileSync(path.join(dmgWork, 'package.json'), JSON.stringify({
    name: 'kapumail',
    productName: 'KapuMail',
    version: VERSION,
    private: true,
  }, null, 2) + '\n');

  const fileName = `KapuMail-${VERSION}-${archName}.dmg`;
  const electronPkg = JSON.parse(fs.readFileSync(path.join(DESKTOP_DIR, 'node_modules', 'electron', 'package.json'), 'utf8'));

  log(`macOS ${archName} .dmg csomagolása (${fileName})…`);
  await build({
    publish: 'never',
    projectDir: dmgWork,
    prepackaged: appPath,
    targets: Platform.MAC.createTarget(['dmg'], ebArch),
    config: {
      appId: PKG.build.appId,
      productName: 'KapuMail',
      electronVersion: electronPkg.version,
      directories: { output: path.join(dmgWork, 'out') },
      mac: { identity: null, icon: ICON_PNG },
      dmg: {
        title: 'KapuMail',
        background: dmgBgPath,
        window: { width: 680, height: 400 },
        iconSize: 112,
        contents: [
          { x: 204, y: 176, type: 'file' },
          { x: 476, y: 176, type: 'link', path: '/Applications' },
        ],
        format: 'ULFO',
        artifactName: fileName,
        writeUpdateInfo: false,
      },
    },
  });

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const finalDmg = path.join(DIST_DIR, fileName);
  fs.rmSync(finalDmg, { force: true });
  fs.renameSync(path.join(dmgWork, 'out', fileName), finalDmg);
  fs.rmSync(dmgWork, { recursive: true, force: true });

  if (!signing.unsigned && signing.identity) {
    execFileSync('codesign', ['--sign', signing.identity, '--timestamp', finalDmg], { stdio: 'inherit' });
  }
  return finalDmg;
}

async function buildWindowsInstaller(winPhpDir, appServerDir) {
  log('Windows x64 NSIS telepítő építése (KapuMail-Setup-' + VERSION + '.exe)…');
  await build({
    publish: 'never',
    projectDir: DESKTOP_DIR,
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    config: {
      ...PKG.build,
      directories: { output: DIST_DIR },
      extraResources: [
        { from: appServerDir, to: 'app-server' },
        { from: winPhpDir, to: 'php' },
      ],
      nsis: {
        ...PKG.build.nsis,
        artifactName: 'KapuMail-Setup-${version}.${ext}',
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
      },
    },
  });

  const unpackedRes = path.join(DIST_DIR, 'win-unpacked', 'resources');
  for (const rel of [
    'php/php.exe',
    'php/php8.dll',
    'php/vcruntime140.dll',
    'php/vcruntime140_1.dll',
    'php/php.ini',
    'php/cacert.pem',
    'php/ext/php_pdo_sqlite.dll',
    'app-server/vendor/autoload.php',
    'app-server/artisan',
  ]) {
    if (!fs.existsSync(path.join(unpackedRes, rel))) {
      throw new Error(`Hiányzó Windows csomagelem: ${rel}`);
    }
  }
  const exeInstaller = path.join(DIST_DIR, `KapuMail-Setup-${VERSION}.exe`);
  if (!fs.existsSync(exeInstaller)) throw new Error(`Nem jött létre: ${exeInstaller}`);
  return exeInstaller;
}

function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

function updateLandingLinks(files) {
  const landingDir = path.dirname(LANDING_DL_DIR);
  if (!fs.existsSync(landingDir)) {
    log('marketing/landing könyvtár nem létezik, letöltési szimlinkek frissítése kihagyva.');
    return;
  }
  fs.mkdirSync(LANDING_DL_DIR, { recursive: true });
  for (const existing of fs.readdirSync(LANDING_DL_DIR)) {
    const p = path.join(LANDING_DL_DIR, existing);
    try { fs.unlinkSync(p); } catch { fs.rmSync(p, { recursive: true, force: true }); }
  }
  for (const f of files) {
    const name = path.basename(f);
    const linkPath = path.join(LANDING_DL_DIR, name);
    try { fs.unlinkSync(linkPath); } catch {}
    const relTarget = path.relative(LANDING_DL_DIR, f);
    fs.symlinkSync(relTarget, linkPath);
  }
}

function cleanOldDistArtifacts() {
  if (!fs.existsSync(DIST_DIR)) return;
  const keep = new Set([
    `KapuMail-${VERSION}-arm64.dmg`,
    `KapuMail-${VERSION}-x64.dmg`,
    `KapuMail-Setup-${VERSION}.exe`,
    'latest.json',
  ]);
  for (const name of fs.readdirSync(DIST_DIR)) {
    if (!keep.has(name)) {
      fs.rmSync(path.join(DIST_DIR, name), { recursive: true, force: true });
    }
  }
}

async function main() {
  const isUnsigned = process.argv.includes('--unsigned') || process.env.KAPUMAIL_OFFICIAL_BUILD === '0';
  if (isUnsigned) {
    process.env.KAPUMAIL_OFFICIAL_BUILD = '0';
  }
  const finishOnly = process.argv.includes('--finish');
  const repackDmgOnly = process.argv.includes('--repack-dmg');
  const signing = isUnsigned
    ? { identity: null, team: null, notaryProfile: null, unsigned: true }
    : detectMacSigning();
  if (signing.unsigned) {
    log('Közösségi / aláírásmentes építési mód (--unsigned)');
  } else {
    log(`macOS aláírás: ${signing.identity} (notary profil: ${signing.notaryProfile})`);
  }

  const phpDirs = preparePhpToolchains();
  const stagedAppServer = path.join(STAGE_DIR, 'app-server');
  const appServerDir = ((finishOnly || repackDmgOnly) && fs.existsSync(path.join(stagedAppServer, 'vendor', 'autoload.php')))
    ? stagedAppServer
    : stageAppServer();
  const dmgBgPath = renderDmgBackground();

  const existingArmDmg = path.join(DIST_DIR, `KapuMail-${VERSION}-arm64.dmg`);
  const existingX64Dmg = path.join(DIST_DIR, `KapuMail-${VERSION}-x64.dmg`);
  const existingWinExe = path.join(DIST_DIR, `KapuMail-Setup-${VERSION}.exe`);
  const stagedArmApp = path.join(STAGE_DIR, 'mac-arm64', 'mac-arm64', 'KapuMail.app');
  const stagedX64App = path.join(STAGE_DIR, 'mac-x64', 'mac', 'KapuMail.app');
  let armDmg;
  let x64Dmg;

  if (repackDmgOnly && fs.existsSync(stagedArmApp) && fs.existsSync(stagedX64App)) {
    log('Meglévő notarizált .app csomagok újracsomagolása új .dmg háttérrel (--repack-dmg)…');
    if (!signing.unsigned) {
      execFileSync('xcrun', ['stapler', 'validate', stagedArmApp], { stdio: 'inherit' });
      execFileSync('xcrun', ['stapler', 'validate', stagedX64App], { stdio: 'inherit' });
    }
    armDmg = await packMacDmg('arm64', stagedArmApp, dmgBgPath, signing);
    x64Dmg = await packMacDmg('x64', stagedX64App, dmgBgPath, signing);
  } else if (finishOnly && fs.existsSync(existingArmDmg) && fs.existsSync(existingX64Dmg)) {
    log('Meglévő aláírt macOS .dmg csomagok folytatása (--finish)…');
    armDmg = existingArmDmg;
    x64Dmg = existingX64Dmg;
  } else {
    // Töröljük a régi Iratkapu* maradványokat az építés előtt.
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    fs.mkdirSync(DIST_DIR, { recursive: true });

    const armApp = await buildMacApp('arm64', phpDirs.macArm64, appServerDir, signing);
    const x64App = await buildMacApp('x64', phpDirs.macX64, appServerDir, signing);

    if (!signing.unsigned) {
      log('Mindkét macOS .app párhuzamos Apple-notarizálása…');
      await Promise.all([
        notarizeAndStaple(armApp, signing),
        notarizeAndStaple(x64App, signing),
      ]);
      execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', armApp], { stdio: 'inherit' });
      execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', x64App], { stdio: 'inherit' });
    }

    armDmg = await packMacDmg('arm64', armApp, dmgBgPath, signing);
    x64Dmg = await packMacDmg('x64', x64App, dmgBgPath, signing);
  }

  if (!signing.unsigned) {
    log('Mindkét macOS .dmg párhuzamos Apple-notarizálása…');
  }
  const [, , winExe] = await Promise.all([
    signing.unsigned ? Promise.resolve(null) : notarizeAndStaple(armDmg, signing),
    signing.unsigned ? Promise.resolve(null) : notarizeAndStaple(x64Dmg, signing),
    (repackDmgOnly && fs.existsSync(existingWinExe))
      ? Promise.resolve(existingWinExe)
      : buildWindowsInstaller(phpDirs.winX64, appServerDir),
  ]);

  if (!signing.unsigned) {
    execFileSync('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', armDmg], { stdio: 'inherit' });
    execFileSync('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', x64Dmg], { stdio: 'inherit' });
  }

  cleanOldDistArtifacts();
  const allInstallers = [armDmg, x64Dmg, winExe];

  const summary = allInstallers.map((f) => {
    const st = fs.statSync(f);
    return {
      file: path.basename(f),
      sizeMB: +(st.size / (1024 * 1024)).toFixed(1),
      bytes: st.size,
      sha256: sha256File(f),
    };
  });
  const byFile = Object.fromEntries(summary.map((s) => [s.file, s]));
  const armItem = byFile[`KapuMail-${VERSION}-arm64.dmg`];
  const x64Item = byFile[`KapuMail-${VERSION}-x64.dmg`];
  const winItem = byFile[`KapuMail-Setup-${VERSION}.exe`];
  const latestManifest = {
    version: VERSION,
    date: new Date().toISOString().slice(0, 10),
    notes: 'https://kapumail.hu/#letoltes',
    described: true,
    download: 'https://kapumail.hu/#letoltes',
    mac: {
      arm64: { url: `https://kapumail.hu/letoltes/${armItem.file}`, sha256: armItem.sha256, bytes: armItem.bytes },
      x64: { url: `https://kapumail.hu/letoltes/${x64Item.file}`, sha256: x64Item.sha256, bytes: x64Item.bytes },
    },
    windows: {
      x64: { url: `https://kapumail.hu/letoltes/${winItem.file}`, sha256: winItem.sha256, bytes: winItem.bytes },
    },
  };
  const latestJsonPath = path.join(DIST_DIR, 'latest.json');
  fs.writeFileSync(latestJsonPath, JSON.stringify(latestManifest, null, 2) + '\n');
  updateLandingLinks([...allInstallers, latestJsonPath]);

  fs.writeFileSync(path.join(CACHE_DIR, 'release-manifest.json'), JSON.stringify(summary, null, 2) + '\n');
  log('Kiadási csomagok elkészültek:');
  for (const s of summary) {
    console.log(`  ✔ ${s.file} (${s.sizeMB} MB)  SHA-256: ${s.sha256}`);
  }
}

main().catch((err) => {
  console.error('\n✗ Kiadás építési hiba:', err && err.stack ? err.stack : err);
  process.exit(1);
});
