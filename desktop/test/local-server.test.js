'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { resolvePaths, preparePackagedState, pickFreePort, createLocalServer, buildPhpEnvMap, runPhpCommand } = require('../local-server');
const { userAgent } = require('../mode');

test('resolvePaths: fejlesztői és csomagolt útvonalak elválasztása', () => {
  const dev = resolvePaths({
    isPackaged: false,
    appDir: '/repo/desktop',
    resourcesPath: '/ignored',
    userData: '/user/KapuMail',
    platform: 'darwin',
  });
  assert.equal(dev.php, 'php');
  assert.equal(dev.artisan, path.join('/repo', 'app', 'artisan'));
  assert.equal(dev.stateDir, null);

  const mac = resolvePaths({
    isPackaged: true,
    appDir: '/Applications/KapuMail.app/Contents/Resources/app.asar',
    resourcesPath: '/Applications/KapuMail.app/Contents/Resources',
    userData: '/Users/teszt/Library/Application Support/KapuMail',
    platform: 'darwin',
  });
  assert.equal(mac.php, '/Applications/KapuMail.app/Contents/Resources/php/php');
  assert.equal(mac.appRoot, '/Applications/KapuMail.app/Contents/Resources/app-server');
  assert.equal(mac.artisan, '/Users/teszt/Library/Application Support/KapuMail/local-server/artisan');
  assert.equal(mac.dbFile, '/Users/teszt/Library/Application Support/KapuMail/local-server/database.sqlite');

  const win = resolvePaths({
    isPackaged: true,
    appDir: 'C:\\App\\resources\\app.asar',
    resourcesPath: 'C:\\App\\resources',
    userData: 'C:\\Users\\Teszt\\AppData\\Roaming\\KapuMail',
    platform: 'win32',
  });
  assert.ok(win.php.endsWith('php.exe'));
});

test('preparePackagedState: létrehozza az írható adatmappát, .env-et, router.php-t és artisan burkolót', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-ls-'));
  try {
    const resDir = path.join(tmp, 'resources');
    const userDir = path.join(tmp, 'userData');
    fs.mkdirSync(path.join(resDir, 'php'), { recursive: true });
    fs.mkdirSync(path.join(resDir, 'app-server', 'public'), { recursive: true });
    fs.writeFileSync(path.join(resDir, 'php', 'cacert.pem'), 'CERT');

    const paths = resolvePaths({
      isPackaged: true,
      appDir: resDir,
      resourcesPath: resDir,
      userData: userDir,
      platform: 'darwin',
    });

    const first = preparePackagedState(paths);
    assert.equal(first.isNewDb, true);
    assert.ok(fs.existsSync(path.join(paths.stateDir, '.env')));
    assert.ok(fs.existsSync(paths.artisan));
    assert.ok(fs.existsSync(paths.router));
    assert.ok(fs.existsSync(paths.dbFile));
    assert.ok(fs.existsSync(path.join(paths.stateDir, 'storage', 'framework', 'views')));

    const envText = fs.readFileSync(path.join(paths.stateDir, '.env'), 'utf8');
    assert.match(envText, /^APP_KEY=base64:/m);
    assert.match(envText, /^DB_CONNECTION=sqlite$/m);

    // Második futás nem írja felül az APP_KEY-t, és jelzi, ha már nem üres az adatbázis.
    fs.writeFileSync(paths.dbFile, 'sqlite-bytes');
    const second = preparePackagedState(paths);
    assert.equal(second.isNewDb, false);
    assert.equal(fs.readFileSync(path.join(paths.stateDir, '.env'), 'utf8'), envText);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runPhpCommand: a szabványos kimenetre írt hibát is visszaadja (az artisan oda írja a hibáit)', async () => {
  const paths = { isPackaged: false, php: 'php', appRoot: os.tmpdir() };
  const failed = await runPhpCommand(paths, ['-r', 'echo "In PackageManifest.php line 179:\n\n  A cache mappa nem irhato.  \n"; exit(1);']);
  assert.equal(failed.ok, false);
  assert.match(failed.stderr, /PackageManifest\.php line 179: A cache mappa nem irhato\./);

  const viaStderr = await runPhpCommand(paths, ['-r', 'echo "zaj"; fwrite(STDERR, "valodi hiba"); exit(1);']);
  assert.equal(viaStderr.stderr, 'valodi hiba');

  const fine = await runPhpCommand(paths, ['-r', 'echo "minden rendben";']);
  assert.deepEqual({ ok: fine.ok, stderr: fine.stderr }, { ok: true, stderr: '' });
});

test('buildPhpEnvMap: ha a PHP mellett van openssl.cnf (Windows), OPENSSL_CONF rámutat', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-ls-ssl-'));
  try {
    const paths = resolvePaths({ isPackaged: true, appDir: tmp, resourcesPath: tmp, userData: path.join(tmp, 'u'), platform: 'darwin' });
    assert.equal('OPENSSL_CONF' in buildPhpEnvMap(paths), false);
    const conf = path.join(tmp, 'php', 'extras', 'ssl', 'openssl.cnf');
    fs.mkdirSync(path.dirname(conf), { recursive: true });
    fs.writeFileSync(conf, '# teszt');
    assert.equal(buildPhpEnvMap(paths).OPENSSL_CONF, conf);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('pickFreePort: ha a kívánt port foglalt, szabad tartalékportot ad vissza', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busyPort = blocker.address().port;
  try {
    const fallback = await pickFreePort('127.0.0.1', busyPort);
    assert.ok(Number.isInteger(fallback) && fallback > 0);
    assert.notEqual(fallback, busyPort);
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

test('createLocalServer: csomagolt módban írásvédett app-server mellett migrál, seedel és válaszol', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-ls-e2e-'));
  const resDir = path.join(tmp, 'resources');
  const userDir = path.join(tmp, 'userData');
  fs.mkdirSync(path.join(resDir, 'php'), { recursive: true });
  const appSrc = path.resolve(__dirname, '..', '..', 'app');
  const appDst = path.join(resDir, 'app-server');

  // Szimlinkelt programkönyvtár .env és database.sqlite nélkül: garantálja, hogy az app-serverbe nem ír semmi.
  fs.mkdirSync(appDst, { recursive: true });
  for (const entry of ['app', 'bootstrap', 'config', 'database', 'public', 'resources', 'routes', 'vendor', 'artisan', 'composer.json']) {
    if (entry === 'database') {
      fs.mkdirSync(path.join(appDst, 'database'), { recursive: true });
      for (const sub of ['migrations', 'seeders', 'factories', 'data']) {
        const s = path.join(appSrc, 'database', sub);
        if (fs.existsSync(s)) fs.symlinkSync(s, path.join(appDst, 'database', sub));
      }
      continue;
    }
    if (entry === 'bootstrap') {
      fs.mkdirSync(path.join(appDst, 'bootstrap', 'cache'), { recursive: true });
      fs.copyFileSync(path.join(appSrc, 'bootstrap', 'app.php'), path.join(appDst, 'bootstrap', 'app.php'));
      if (fs.existsSync(path.join(appSrc, 'bootstrap', 'providers.php'))) {
        fs.copyFileSync(path.join(appSrc, 'bootstrap', 'providers.php'), path.join(appDst, 'bootstrap', 'providers.php'));
      }
      continue;
    }
    fs.symlinkSync(path.join(appSrc, entry), path.join(appDst, entry));
  }
  // A bootstrap/cache-t csak olvashatóvá tesszük, mint a macOS aláírt .app csomagban.
  fs.chmodSync(path.join(appDst, 'bootstrap', 'cache'), 0o555);

  // Rendszer vagy letöltött statikus PHP bináris szimlinkelése
  const whichPhp = fs.existsSync('/tmp/php-mac-check/php')
    ? '/tmp/php-mac-check/php'
    : require('node:child_process').execFileSync('which', ['php'], { encoding: 'utf8' }).trim();
  fs.symlinkSync(whichPhp, path.join(resDir, 'php', 'php'));

  const srv = createLocalServer({
    isPackaged: true,
    appDir: resDir,
    resourcesPath: resDir,
    userData: userDir,
    smoke: false,
  });

  // Foglaljuk le ideiglenesen a 8000-es portot, vagy hagyjuk szabadon; a szerver mindenhogy elindul.
  try {
    const started = await srv.ensure('http://127.0.0.1:8000');
    assert.equal(started.ok, true, 'Hiba: ' + srv.getLastError());
    assert.match(started.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

    const legalRes = await fetch(started.origin + '/legal/aszf');
    assert.equal(legalRes.status, 200);
    const legalHtml = await legalRes.text();
    assert.match(legalHtml, /Általános Szerződési Feltételek|KapuMail/i);

    const enterRes = await fetch(started.origin + '/local/enter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': userAgent('Mozilla/5.0', '0.1.0', 'local'),
      },
      body: JSON.stringify({ secret: 'teszt-titok-minimum-harmincket-karakter-1234567890', terms: true }),
    });
    assert.equal(enterRes.status, 200);

    // Az app-server alatt nem jöhetett létre sem .env, sem database.sqlite, sem bootstrap/cache fájl.
    assert.equal(fs.existsSync(path.join(appDst, '.env')), false);
    assert.equal(fs.existsSync(path.join(appDst, 'database', 'database.sqlite')), false);
    assert.deepEqual(fs.readdirSync(path.join(appDst, 'bootstrap', 'cache')), []);
  } finally {
    srv.stop();
    try { fs.chmodSync(path.join(appDst, 'bootstrap', 'cache'), 0o755); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
