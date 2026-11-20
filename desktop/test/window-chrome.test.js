const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { windowChrome, WINBAR_HEIGHT } = require('../window-chrome');

test('macOS-en a közlekedési lámpák maradnak, nincs overlay', () => {
  const c = windowChrome('darwin');
  assert.equal(c.titleBarStyle, 'hidden');
  assert.deepEqual(c.trafficLightPosition, { x: 13, y: 7 });
  assert.equal(c.titleBarOverlay, undefined);
});

for (const platform of ['win32', 'linux']) {
  test(`${platform}: a rejtett címsor mellett visszakerülnek a rendszer ablakgombjai`, () => {
    const c = windowChrome(platform);
    assert.equal(c.titleBarStyle, 'hidden');
    assert.ok(c.titleBarOverlay, 'titleBarOverlay nélkül nincs bezárás gomb');
    assert.equal(c.titleBarOverlay.height, WINBAR_HEIGHT);
    assert.equal(c.trafficLightPosition, undefined);
  });
}

test('a főablak a platformfüggő címsor-beállítást használja, és a fájl bekerül a csomagba', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /\.\.\.windowChrome\(\)/);
  assert.doesNotMatch(main, /titleBarStyle: 'hidden', trafficLightPosition/);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('window-chrome.js'));
});

test('a felső sáv a Windows ablakgombjai mellett is helyet hagy', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'resources', 'ui', 'app.html'), 'utf8');
  assert.match(app, /\.winbar\{[^}]*env\(titlebar-area-width/);
  const welcome = fs.readFileSync(path.join(__dirname, '..', 'welcome.html'), 'utf8');
  assert.match(welcome, /\.tag\{[^}]*env\(titlebar-area-width/);
});
