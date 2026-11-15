const test = require('node:test'); const assert = require('node:assert'); const path = require('path');
const c = require('../connector');
const CLI = path.join(__dirname, 'fake-tarhely-cli', 'dist', 'cli.js');

test('csak a tarhely-cli belépési pontját fogadja el', () => {
  assert.equal(c.validateCli(CLI).ok, true);
  assert.equal(c.validateCli(__filename).ok, false);
  assert.equal(c.validateCli(path.join(__dirname, '..', 'main.js')).ok, false);
});
test('letöltés és minden más parancs tiltott', async () => {
  for (const cmd of ['download', 'init', 'forget', 'list; rm -rf /']) assert.equal((await c.run(CLI, cmd)).ok, false);
  assert.deepEqual(Object.keys(c.ALLOWED).sort(), ['doctor', 'list', 'mailboxes']);
});
test('postafiókok és levéllista', async () => {
  const m = await c.run(CLI, 'mailboxes'); assert.equal(m.ok, true); assert.equal(m.mailboxes.length, 2);
  const l = await c.run(CLI, 'list'); const slim = c.slimLetters(l);
  assert.equal(slim.length, 2); // azonosító nélküli levél kimarad
  assert.deepEqual(Object.keys(slim[0]).sort(), ['desc', 'eid', 'mailbox', 'receivedAt', 'sender', 'senderFull', 'type']);
});
test('--since csak érvényes dátummal és csak listánál', async () => {
  assert.equal((await c.run(CLI, 'list', { since: '2026-11-09' })).letters.filter(x => x.eid).length, 1);
  assert.equal((await c.run(CLI, 'list', { since: '2026-11-09; echo x' })).ok, false);
  assert.equal((await c.run(CLI, 'mailboxes', { since: '2026-11-09' })).ok, false);
});
test('a belépési hiba kódja és üzenete megmarad', async () => {
  process.env.FAKE_FAIL = 'login'; const r = await c.run(CLI, 'list'); delete process.env.FAKE_FAIL;
  assert.equal(r.ok, false); assert.equal(r.code, 3);
});
