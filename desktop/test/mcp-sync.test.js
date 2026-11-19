const test = require('node:test');
const assert = require('node:assert');
const { SYNC_CHANNELS, makeMcpRun } = require('../mcp-sync');

test('a zárolt kivétel csak a szinkron hét csatornájára vonatkozik', () => {
  assert.deepEqual([...SYNC_CHANNELS].sort(), ['asp:readOwnAuto', 'auto:ack', 'auto:clients', 'auto:downloadOne', 'auto:run', 'nav:readOwn', 'schedule:get']);
});

test('futás nélkül semmit nem enged; futás alatt csak a szinkron csatornáit', () => {
  const run = makeMcpRun();
  assert.equal(run.allows('auto:run'), false);
  run.begin(7);
  assert.equal(run.active(), true);
  assert.equal(run.allows('auto:run'), true);
  assert.equal(run.allows('kapu:send'), false);
  assert.equal(run.allows(undefined), false);
});

test('csak a saját azonosítóval zárható', () => {
  const run = makeMcpRun();
  run.begin(7);
  run.end(8);
  assert.equal(run.active(), true);
  run.end(7);
  assert.equal(run.active(), false);
  assert.equal(run.allows('auto:run'), false);
});

test('120 perc után magától lezár', () => {
  let t = 0;
  const run = makeMcpRun({ now: () => t });
  run.begin(1);
  t = 120 * 60000;
  assert.equal(run.active(), true);
  t = 120 * 60000 + 1;
  assert.equal(run.active(), false);
  assert.equal(run.allows('auto:run'), false);
});

// Bekötés a főfolyamatba és a hídba (forrásszintű ellenőrzés, mint a *-ui.test.js-ek).
const fs = require('fs');
const path = require('path');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

test('a szinkron hét csatornájának kezelője csatornanévvel hívja a guardot', () => {
  for (const ch of SYNC_CHANNELS) {
    const at = MAIN.indexOf(`ipcMain.handle('${ch}'`);
    assert.ok(at > 0, `nincs kezelő: ${ch}`);
    assert.ok(MAIN.slice(at, at + 400).includes(`guard(e, '${ch}')`), `a(z) ${ch} kezelője nem adja át a csatornát a guardnak`);
  }
  assert.match(MAIN, /const guard = \(e, channel\) =>/);
  assert.match(MAIN, /mcpRun\.allows\(channel\)/);
});

test('az MCP-ből indított app ablak nélkül indul, és a második példány sem hozza előre', () => {
  assert.match(MAIN, /const MCP_BG = process\.argv\.includes\('--mcp-hatter'\)/);
  assert.match(MAIN, /show: !SMOKE && !MCP_BG/);
  const si = MAIN.slice(MAIN.indexOf("app.on('second-instance'"), MAIN.indexOf("app.on('second-instance'") + 200);
  assert.ok(si.includes("--mcp-hatter"));
});

test('életjel indításkor és leálláskor, híd az MCP-futáshoz', () => {
  assert.match(MAIN, /writeAlive\(/);
  assert.match(MAIN, /stopped: true/);
  assert.match(MAIN, /ipcMain\.handle\('mcpsync:begin'/);
  assert.match(MAIN, /ipcMain\.handle\('mcpsync:end'/);
  assert.match(PRELOAD, /mcpSync: \{/);
  assert.match(PRELOAD, /ipcRenderer\.invoke\('mcpsync:begin'/);
  assert.match(PRELOAD, /ipcRenderer\.invoke\('mcpsync:end'/);
});

test('futó MCP-futás közben más azonosítóval nem nyitható újra', () => {
  const run = makeMcpRun();
  assert.equal(run.begin(1), true);
  assert.equal(run.begin(2), false);
  assert.equal(run.begin(1), true);
  run.end(1);
  assert.equal(run.begin(2), true);
});

test('a főfolyamat a szervertől ellenőrzi a kérést, mielőtt átengedi a zárat', () => {
  const at = MAIN.indexOf("ipcMain.handle('mcpsync:begin'");
  const body = MAIN.slice(at, at + 600);
  assert.ok(body.includes('/api/desktop/mcp-sync/'));
  assert.ok(body.indexOf('/api/desktop/mcp-sync/') < body.indexOf('mcpRun.begin('));
});
