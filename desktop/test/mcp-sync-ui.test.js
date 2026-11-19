// MI-ből (MCP) indított szinkron a felületen (ADR-016): a kérés felvétele, a futás és a Beállítások → MCP magyarázó szövege,
// közvetlenül az app.html forrásából.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'resources', 'ui', 'app.html'), 'utf8');
const fnBody = name => { const i = html.indexOf(`async function ${name}(`); assert.ok(i > 0, `nincs ${name}`); return html.slice(i, html.indexOf('\n}', i)); };

test('a felület 20 mp-enként felveszi és a három végponttal lezárja az MI-kérést', () => {
  const t = fnBody('mcpSyncTick');
  for (const p of ['desktop/mcp-sync/next', '/start', '/finish']) assert.ok(t.includes(p), p);
  assert.ok(t.includes("runAutoAll('mcp')"));
  assert.ok(t.includes('canAdmin()'));
  assert.ok(t.includes('iratkapuDesktop.mcpSync'));
  assert.match(t, /\bD\.begin\(id\)/);
  assert.match(t, /finally\s*\{[^}]*\bD\.end\(id\)/);
  assert.match(html, /setInterval\(mcpSyncTick,\s*20000\)/);
});

test('futtathatatlan helyzetben a kérés okkal együtt sikertelenként zárul, nem marad függőben', () => {
  const t = fnBody('mcpSyncTick');
  assert.ok(t.includes('trialBlocked()'));
  assert.ok(t.includes('OFFICE.live_listing'));
  assert.ok(t.includes('schedPortals().length'));
});

test('az MI-futás úgy fut, mint az ütemezett, saját előtaggal', () => {
  const r = fnBody('runAutoAll');
  assert.match(r, /const sched=source==='scheduled'\|\|source==='mcp'/);
  assert.ok(r.includes('MI-kérésre indított szinkron: '));
});

test('a Beállítások → MCP lap elmondja, mire képes a munka/admin szintű kapcsolat', () => {
  const r = fnBody('renderMcp');
  assert.ok(r.includes('Szinkron indítása MI-ből.'));
  assert.ok(r.includes('A zárolóképernyő végig fent marad'));
  assert.ok(r.includes('Az <i>olvasás</i> szintű kapcsolat erre nem képes.'));
});

test('zárolt indulásnál is betölti az ütemezés kizárásait, különben nem fut', () => {
  const t = fnBody('mcpSyncTick');
  const b = t.indexOf('D.begin(id)'), r = t.indexOf('await schedRefresh()'), d = t.indexOf('SCHED.defaults');
  assert.ok(b > 0 && r > b && d > r, 'a schedRefresh a begin után, a betöltés ellenőrzése utána jön');
});

test('ha egy belépő sem futott, vagy mind hibázott, az MI-futás sikertelen', () => {
  const r = fnBody('runAutoAll');
  assert.match(r, /else if\(!sum\.ran\)\{AUTO\.ok=false;/);
  assert.match(r, /if\(fails\.length&&!done\)AUTO\.ok=false/);
});
