const test = require('node:test');
const assert = require('node:assert');
const { resolveMode, userAgent } = require('../mode');

test('első indításkor nincs mód: a program rákérdez', () => {
  assert.equal(resolveMode({}), null);
  assert.equal(resolveMode(undefined), null);
  assert.equal(resolveMode({ mode: 'valami' }), null);
});

test('a kiválasztott mód megmarad', () => {
  assert.equal(resolveMode({ mode: 'local' }), 'local');
  assert.equal(resolveMode({ mode: 'server', url: 'https://x.example' }), 'server');
  assert.equal(resolveMode({ mode: 'local', url: 'https://x.example' }), 'local');
});

test('akinek már van mentett szervercíme vagy környezeti címe, annak nem kell választania', () => {
  assert.equal(resolveMode({ url: 'https://iroda.example' }), 'server');
  assert.equal(resolveMode({}, { IRATKAPU_URL: 'http://127.0.0.1:8000' }), 'server');
});

test('a kérések jelölése tartalmazza a verziót és a módot, és nem halmozódik', () => {
  const ua = userAgent('Mozilla/5.0 Chrome/130', '0.1.0', 'local');
  assert.equal(ua, 'Mozilla/5.0 Chrome/130 KapuMail-Desktop/0.1.0 (local)');
  assert.equal(userAgent(ua, '0.1.0', 'server'), 'Mozilla/5.0 Chrome/130 KapuMail-Desktop/0.1.0 (server)');
  assert.match(userAgent('X', '0.1.0', 'akarmi'), /\(server\)$/);
});
