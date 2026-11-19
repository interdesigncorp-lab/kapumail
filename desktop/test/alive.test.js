const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { aliveFile, launchInfo, writeAlive, payload } = require('../alive');

test('az életjel-fájl a PHP storage/app mappájában van (csomagolt és fejlesztői módban)', () => {
  assert.equal(aliveFile({ isPackaged: true, stateDir: '/u/local-server', appRoot: '/r/app-server' }), path.join('/u/local-server', 'storage', 'app', 'desktop-alive.json'));
  assert.equal(aliveFile({ isPackaged: false, stateDir: null, appRoot: '/repo/app' }), path.join('/repo/app', 'storage', 'app', 'desktop-alive.json'));
});

test('indítási adat: macOS-en a .app csomag, Windowson az exe, fejlesztői módban nincs', () => {
  assert.deepEqual(launchInfo({ platform: 'darwin', execPath: '/Applications/KapuMail.app/Contents/MacOS/KapuMail', isPackaged: true }), { platform: 'darwin', path: '/Applications/KapuMail.app' });
  assert.deepEqual(launchInfo({ platform: 'win32', execPath: 'C:\\Program Files\\KapuMail\\KapuMail.exe', isPackaged: true }), { platform: 'win32', path: 'C:\\Program Files\\KapuMail\\KapuMail.exe' });
  assert.equal(launchInfo({ platform: 'darwin', execPath: '/x/Electron.app/Contents/MacOS/Electron', isPackaged: false }), null);
});

test('az életjel atomian íródik és visszaolvasható; leálláskor at=0, de az indítási adat megmarad', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-'));
  const file = path.join(dir, 'storage', 'app', 'desktop-alive.json');
  const launch = { platform: 'darwin', path: '/Applications/KapuMail.app' };
  writeAlive(file, payload({ now: 1000, pid: 42, isPackaged: true, launch }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { at: 1000, pid: 42, packaged: true, launch });
  writeAlive(file, payload({ now: 2000, pid: 42, isPackaged: true, launch, stopped: true }));
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(back.at, 0);
  assert.deepEqual(back.launch, launch);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['desktop-alive.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});
