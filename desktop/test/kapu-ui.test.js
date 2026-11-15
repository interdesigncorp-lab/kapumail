'use strict';
const test = require('node:test');
const assert = require('node:assert');
const KapuMd = require('../../app/resources/ui/kapu-md.js');
const KapuTyping = require('../../app/resources/ui/kapu-typing.js');

test('md: script és img escape-elve', () => {
  const h = KapuMd.render('<script>alert(1)</script> <img src=x onerror=1> ![k](https://x.hu/a.png)');
  assert.ok(!/<script|<img/i.test(h));
  assert.ok(h.includes('&lt;script&gt;'));
});
test('md: kapu:irat/12 → data-goto="12" chip', () => {
  assert.match(KapuMd.render('[levél](kapu:irat/12)'), /<button class="kchip" data-goto="12">levél<\/button>/);
  assert.match(KapuMd.render('[h](kapu:hatarido/m-7)'), /data-goto="m-7"/);
});
test('md: kapu:ugyfel/3 → data-cl', () => {
  assert.match(KapuMd.render('[Kft](kapu:ugyfel/3)'), /<button class="kchip" data-cl="3">Kft<\/button>/);
});
test('md: kapu:beallitas/kapu → data-stab', () => {
  assert.match(KapuMd.render('[be](kapu:beallitas/kapu)'), /data-stab="kapu"/);
});
test('md: ismeretlen kapu: cél inaktív chip', () => {
  assert.match(KapuMd.render('[x](kapu:valami/1)'), /<span class="kchip off">x<\/span>/);
  assert.ok(!/<button/.test(KapuMd.render('[x](kapu:irat/1"onclick="a)')));
  assert.match(KapuMd.render('[x](kapu:beallitas/Ab1)'), /kchip off/);
});
test('md: javascript: link sima szöveg', () => {
  const h = KapuMd.render('[katt](javascript:alert(1)) [d](data:text/html,x)');
  assert.ok(!/href|javascript:/.test(h));
  assert.ok(h.includes('katt'));
});
test('md: https és mailto link külső', () => {
  assert.match(KapuMd.render('[a](https://x.hu/?a=1&b="2")'), /<a href="https:\/\/x\.hu\/\?a=1&amp;b=&quot;2&quot;" target="_blank" rel="noopener">a<\/a>/);
  assert.match(KapuMd.render('[m](mailto:a@b.hu)'), /<a href="mailto:a@b.hu"/);
  assert.ok(!/<a /.test(KapuMd.render('[h](http://x.hu)')));
});
test('md: lista és félkövér', () => {
  const h = KapuMd.render('Szia **Gábor** és *te*\n- egy\n- `kód <b>`\n\n1. első\n2. második');
  assert.ok(h.includes('<strong>Gábor</strong>') && h.includes('<em>te</em>'));
  assert.ok(h.includes('<ul><li>egy</li><li><code>kód &lt;b&gt;</code></li></ul>'));
  assert.ok(h.includes('<ol><li>első</li><li>második</li></ol>'));
  assert.match(KapuMd.render('a\nb'), /<p>a<br>b<\/p>/);
});

test('typing: duration határok (rövid 800 ms, hosszú 3000 ms)', () => {
  assert.strictEqual(KapuTyping.duration(10), 800);
  assert.strictEqual(KapuTyping.duration(100000), 3000);
  assert.strictEqual(KapuTyping.duration(400), 1400);
});
const seeded = (s) => () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const LONG = 'Ez az első mondat. Ez a második mondat!\nÚj sor következik. ' + 'Még egy hosszabb szöveg jön itt '.repeat(25) + 'vége.';
test('typing: mondatvégen szünet a megadott tartományban', () => {
  const p = KapuTyping.plan(LONG, seeded(7));
  assert.ok(p.filter((s) => s.pause > 0).length >= 3);
  // az első szünet előtti lépés a ponton ér véget; a szünet 60–150 (mondatvég) vagy 140–260 (sortörés)
  const ends = p.map((s, i) => [p[i - 1], s]).filter(([a, s]) => a && s.pause > 0);
  for (const [a, s] of ends) {
    const ch = LONG[a.n - 1];
    if (ch === '\n') assert.ok(s.pause >= 140 && s.pause <= 260, 'sortörés ' + s.pause);
    else { assert.ok('.!?…'.includes(ch)); assert.ok(s.pause >= 60 && s.pause <= 150, 'mondatvég ' + s.pause); }
  }
});
test('typing: a terv utolsó lépése a teljes hossz', () => {
  for (const t of ['Szia!', LONG, 'x'.repeat(5000)]) {
    const p = KapuTyping.plan(t, seeded(3));
    const last = p[p.length - 1];
    assert.strictEqual(last.n, t.length);
    assert.strictEqual(last.at, KapuTyping.duration(t.length));
    for (let i = 1; i < p.length; i++) assert.ok(p[i].at >= p[i - 1].at && p[i].n > p[i - 1].n);
  }
});
test('typing: a szünetek az idő legfeljebb 20%-át teszik ki', () => {
  const p = KapuTyping.plan(LONG, seeded(11));
  const sum = p.reduce((a, s) => a + s.pause, 0);
  assert.ok(sum <= KapuTyping.duration(LONG.length) * 0.2 + 1e-6);
});

// Kis DOM-csonk a Reveal-hez.
function stubDom() {
  const mk = (type, extra) => Object.assign({ nodeType: type, childNodes: [], parent: null, isConnected: true }, extra);
  const doc = { createElement: (tag) => { const e = el(tag); e.ownerDocument = doc; return e; } };
  function el(tag) {
    const classes = new Set();
    const e = mk(1, {
      tag, ownerDocument: doc, classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
      setAttribute() {},
      remove() { if (this.parent) { this.parent.childNodes = this.parent.childNodes.filter((c) => c !== this); this.parent = null; } },
      prepend(n) { n.remove && n.remove(); n.parent = this; this.childNodes.unshift(n); },
      after(n) { n.remove(); n.parent = this.parent; const i = this.parent.childNodes.indexOf(this); this.parent.childNodes.splice(i + 1, 0, n); },
      className: ''
    });
    return e;
  }
  const textNode = (v) => mk(3, { nodeValue: v, after(n) { n.remove(); n.parent = this.parent; const i = this.parent.childNodes.indexOf(this); this.parent.childNodes.splice(i + 1, 0, n); } });
  const add = (p, c) => { c.parent = p; p.childNodes.push(c); return c; };
  return { doc, el, textNode, add };
}
function fakeClock() {
  let t = 0, cb = null;
  return { now: () => t, frame: (f) => { cb = f; }, advance(ms) { t += ms; const f = cb; cb = null; if (f) f(); }, pending: () => !!cb };
}
function visibleText(root) {
  let s = '';
  (function w(n) { for (const c of n.childNodes) { if (c.nodeType === 3) s += c.nodeValue; else if (c.className !== 'kapu-caret') w(c); } })(root);
  return s;
}

test('typing: Reveal gépel, a végén kész és a kurzor eltűnik', () => {
  const d = stubDom();
  const root = d.el('div'); const p = d.add(root, d.el('p'));
  d.add(p, d.textNode('Szia világ. Ez egy próba.'));
  const clock = fakeClock(); let done = 0;
  const r = new KapuTyping.Reveal(root, { clock, enabled: () => true, rand: seeded(1), onDone: () => done++ }).start();
  assert.strictEqual(visibleText(root), '');
  assert.ok(root.childNodes.some((c) => c.className === 'kapu-caret') || p.childNodes.some((c) => c.className === 'kapu-caret'));
  clock.advance(400);
  const mid = visibleText(root);
  assert.ok(mid.length > 0 && mid.length < r.length);
  for (let i = 0; i < 100 && !done; i++) clock.advance(50);
  assert.strictEqual(done, 1);
  assert.strictEqual(visibleText(root), 'Szia világ. Ez egy próba.');
  assert.ok(!p.childNodes.some((c) => c.className === 'kapu-caret'));
});
test('typing: csökkentett mozgásnál vagy rejtett oldalon azonnal kész', () => {
  const d = stubDom();
  const root = d.el('div'); d.add(root, d.textNode('Kész.'));
  let done = 0;
  new KapuTyping.Reveal(root, { clock: fakeClock(), enabled: () => false, onDone: () => done++ }).start();
  assert.strictEqual(done, 1);
  assert.strictEqual(visibleText(root), 'Kész.');
});
test('typing: catchUp 600 ms-on belül végez', () => {
  const d = stubDom();
  const root = d.el('div'); d.add(root, d.textNode('Hosszú szöveg. '.repeat(60)));
  const clock = fakeClock(); let done = 0;
  const r = new KapuTyping.Reveal(root, { clock, enabled: () => true, rand: seeded(5), onDone: () => done++ }).start();
  clock.advance(300);
  assert.strictEqual(done, 0);
  r.catchUp(1);
  let spent = 0;
  while (!done && spent < 2000) { clock.advance(20); spent += 20; }
  assert.strictEqual(done, 1);
  assert.ok(spent <= 620, 'catchUp ' + spent);
  assert.strictEqual(visibleText(root).length, r.length);
});

test('md: kód a link szövegében nem hagy helyőrzőt', () => {
  const h = KapuMd.render('[`x`](https://a.b) és [**f** `k`](kapu:irat/5)');
  assert.ok(!h.includes('\u0000'));
  assert.ok(h.includes('<a href="https://a.b" target="_blank" rel="noopener"><code>x</code></a>'));
  assert.ok(h.includes('data-goto="5"><strong>f</strong> <code>k</code></button>'));
});

test('typing: stop() és a lecsatolt elem mindent megmutat, a kurzor eltűnik', () => {
  for (const mode of ['stop', 'detach']) {
    const d = stubDom();
    const root = d.el('div'); const p = d.add(root, d.el('p'));
    d.add(p, d.textNode('Hosszabb szöveg, amit félbehagyunk. '.repeat(10)));
    const clock = fakeClock(); let done = 0;
    const r = new KapuTyping.Reveal(root, { clock, enabled: () => true, rand: seeded(2), onDone: () => done++ }).start();
    clock.advance(200);
    assert.ok(visibleText(root).length < r.length);
    if (mode === 'stop') r.stop(); else { root.isConnected = false; clock.advance(50); }
    assert.strictEqual(visibleText(root).length, r.length, mode);
    assert.ok(!p.childNodes.some((c) => c.className === 'kapu-caret'));
    assert.ok(!p.classList.contains('kapu-type-hidden'));
    assert.strictEqual(done, 1);
  }
});

test('typing: blokkhatárokon (p, li, br) sortörés-szünet, a rejtett osztály is működik', () => {
  const d = stubDom();
  const root = d.el('div');
  const p = d.add(root, d.el('p')); d.add(p, d.textNode('Első bekezdés'));
  const ul = d.add(root, d.el('ul')); const li = d.add(ul, d.el('li')); d.add(li, d.textNode('Pont egy'));
  const p2 = d.add(root, d.el('p')); d.add(p2, d.textNode('sor egy')); d.add(p2, d.el('br')); d.add(p2, d.textNode('sor kettő'));
  const clock = fakeClock();
  const r = new KapuTyping.Reveal(root, { clock, enabled: () => true, rand: seeded(4), onDone() {} }).start();
  assert.strictEqual(r.length, 'Első bekezdés'.length + 'Pont egy'.length + 'sor egy'.length + 'sor kettő'.length);
  const bounds = [13, 13 + 8, 13 + 8 + 7];
  const pauses = r.plan.filter((s) => s.pause > 0);
  for (const b of bounds) {
    let i = r.plan.length - 1;
    while (i >= 0 && r.plan[i].n !== b) i--; // az utolsó lépés, amely a határnál ér véget (a '\n' jelölő lépése)
    assert.ok(i >= 0 && r.plan[i + 1] && r.plan[i + 1].pause > 0 && r.plan[i + 1].pause <= 260, 'szünet a ' + b + '. karakter után');
  }
  assert.ok(pauses.length >= 3);
  assert.strictEqual(r.plan[r.plan.length - 1].n, r.length);
  assert.strictEqual(r.plan[r.plan.length - 1].at, KapuTyping.duration(r.length));
  // a gépelés elején a későbbi elemek rejtve vannak
  assert.ok(ul.classList.contains('kapu-type-hidden') && p2.classList.contains('kapu-type-hidden'));
  for (let i = 0; i < 200; i++) clock.advance(50);
  assert.ok(!ul.classList.contains('kapu-type-hidden') && !p2.classList.contains('kapu-type-hidden'));
});

test('nézet: új beszélgetés küldése közben más beszélgetés eseménye nem kerül az újhoz', () => {
  const { createGate } = require('../../app/resources/ui/kapu.js');
  const g = createGate();
  const known = new Set(['A']); // A már fut, B lesz az új
  const isKnown = (id) => known.has(id);
  const passed = [];
  const feed = (ev) => { if (g.offer(ev, isKnown)) passed.push(ev); };
  // Zárt kapunál minden átmegy.
  feed({ convId: 'X', type: 'activity' });
  assert.deepStrictEqual(passed.map((e) => e.convId), ['X']);
  passed.length = 0;
  g.begin();
  feed({ convId: 'A', type: 'activity', text: 'A dolgozik' }); // ismert: azonnal az A-é
  feed({ convId: 'B', type: 'activity', text: 'B dolgozik' }); // ismeretlen: visszatartva
  feed({ convId: 'C', type: 'final' }); // ismeretlen, de nem a mienk
  feed({ convId: 'B', type: 'final' });
  assert.deepStrictEqual(passed.map((e) => e.convId), ['A']);
  assert.strictEqual(g.pending(), true);
  const held = g.end('B');
  assert.deepStrictEqual(held.mine.map((e) => e.type), ['activity', 'final']);
  assert.deepStrictEqual(held.other.map((e) => e.convId), ['C']);
  assert.strictEqual(g.pending(), false);
  // Sikertelen send: semmi sem a mienk, minden a többihez megy.
  g.begin(); feed({ convId: 'D', type: 'activity' });
  assert.deepStrictEqual(g.end(null), { mine: [], other: [{ convId: 'D', type: 'activity' }] });
});

/* --- KapuAvatar videós lejátszója: csonk DOM és kézi időzítő ------------------------------------- */
function fakeEl(tag) {
  const cls = new Set();
  const ls = {};
  const e = {
    tagName: tag.toUpperCase(), children: [], parentNode: null, attrs: {}, style: { setProperty() {} },
    isConnected: true, paused: true, currentTime: 0, duration: NaN, readyState: 4, loop: false, src: '',
    plays: 0, loads: 0,
    classList: {
      add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)),
      contains: (x) => cls.has(x), toggle: (x, on) => { if (on === undefined ? !cls.has(x) : on) cls.add(x); else cls.delete(x); },
    },
    appendChild(c) { c.parentNode = e; e.children.push(c); return c; },
    removeChild(c) { e.children = e.children.filter((x) => x !== c); c.parentNode = null; return c; },
    setAttribute(k, v) { e.attrs[k] = String(v); if (k === 'src') e.src = String(v); },
    removeAttribute(k) { delete e.attrs[k]; if (k === 'src') e.src = ''; },
    addEventListener(t, f) { (ls[t] = ls[t] || []).push(f); },
    removeEventListener(t, f) { ls[t] = (ls[t] || []).filter((x) => x !== f); },
    emit(t) { (ls[t] || []).slice().forEach((f) => f({ type: t, target: e })); },
    play() { e.paused = false; e.plays++; return Promise.resolve(); },
    pause() { e.paused = true; },
    load() { e.loads++; },
  };
  return e;
}
function avatarEnv() {
  const timers = [];
  const env = {
    doc: { createElement: fakeEl },
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].f = null; },
    src: (s) => '/kapu/' + s + '.webm', poster: '/kapu/poster.png', plush: '/kapu/plush.png',
    flush() { while (timers.some((t) => t.f)) { const t = timers.find((x) => x.f); const f = t.f; t.f = null; f(); } },
  };
  return env;
}
const vids = (w) => w.children.filter((c) => c.tagName === 'VIDEO');
const onVid = (w) => vids(w).find((v) => v.classList.contains('on'));

test('avatar: állapotgép – think közben érkező talk a hurok végén vált', () => {
  const { createAvatarPlayer } = require('../../app/resources/ui/kapu.js');
  const env = avatarEnv();
  const w = fakeEl('span');
  const p = createAvatarPlayer(w, env);
  p.set('think');
  assert.strictEqual(p.mode, 'video');
  assert.strictEqual(vids(w).length, 2);
  const a = onVid(w);
  assert.ok(a.src.endsWith('/kapu/think.webm') && a.loop && !a.paused);
  assert.ok(w.classList.contains('think'));
  // A hurok vége közel (0,6 mp): a talk a hátsó videóba töltődik, a think befejezi a kört.
  a.duration = 4.8; a.currentTime = 4.2;
  p.set('talk');
  const b = vids(w).find((v) => v !== a);
  assert.strictEqual(onVid(w), a, 'még a think látszik');
  assert.strictEqual(a.loop, false, 'a think nem kezd új kört');
  assert.ok(b.src.endsWith('/kapu/talk.webm') && b.paused, 'a talk előtöltve, áll');
  a.emit('ended');
  assert.strictEqual(onVid(w), b, 'a hurok végén a talk látszik');
  assert.ok(b.classList.contains('cut'), 'áttűnés nélkül, vágással');
  assert.ok(!b.paused && b.loop);
  assert.ok(a.paused && a.src === '', 'a régi videó elengedve');
  assert.strictEqual(p.state, 'talk');
  assert.ok(w.classList.contains('talk') && !w.classList.contains('think'));
  // Kör közepén (még 3 mp van hátra) érkező váltás: 250 ms-os áttűnés azonnal.
  b.duration = 7.9; b.currentTime = 2;
  p.set('idle');
  assert.ok(a.src.endsWith('/kapu/idle.webm') && !a.paused);
  assert.strictEqual(onVid(w), a);
  assert.ok(!a.classList.contains('cut'), 'áttűnéssel');
  assert.strictEqual(b.paused, false, 'az áttűnés alatt a régi még megy');
  env.flush();
  assert.ok(b.paused && b.src === '');
  assert.strictEqual(p.state, 'idle');
  // Csak két videóelem: legfeljebb a mostani és a következő állapot töltődik.
  assert.strictEqual(vids(w).length, 2);
});

test('avatar: a köszönés egyszer fut le, utána alapállapot; rejtve megáll', () => {
  const { createAvatarPlayer } = require('../../app/resources/ui/kapu.js');
  const env = avatarEnv();
  const w = fakeEl('span');
  const p = createAvatarPlayer(w, env);
  p.set('hello');
  const a = onVid(w);
  assert.strictEqual(a.loop, false);
  a.duration = 7.9; a.currentTime = 1;
  p.set('idle'); // a köszönés közben érkező idle megvárja a köszönés végét
  assert.strictEqual(onVid(w), a);
  a.emit('ended');
  assert.ok(onVid(w).src.endsWith('/kapu/idle.webm') && onVid(w).loop);
  assert.strictEqual(p.state, 'idle');
  p.hold('doc', true);
  assert.ok(vids(w).every((v) => v.paused));
  p.hold('doc', false);
  assert.ok(!onVid(w).paused);
  w.isConnected = false; onVid(w).emit('timeupdate');
  assert.ok(vids(w).every((v) => v.paused && v.src === ''), 'lecsatolva minden videó elengedve');
});

test('avatar: hiányzó videó → CSS-tartalék', () => {
  const { createAvatarPlayer } = require('../../app/resources/ui/kapu.js');
  const env = avatarEnv();
  let failed = 0;
  env.onFail = () => { failed++; };
  const w = fakeEl('span');
  const p = createAvatarPlayer(w, env);
  p.set('listen');
  onVid(w).emit('error');
  assert.strictEqual(p.mode, 'css');
  assert.strictEqual(failed, 1);
  assert.strictEqual(vids(w).length, 0, 'a videók eltűntek');
  const img = w.children.find((c) => c.tagName === 'IMG');
  assert.ok(img && img.src === '/kapu/plush.png');
  assert.ok(w.classList.contains('listen') && !w.classList.contains('kav-v'));
  p.set('talk'); // a CSS-változat tovább követi az állapotot
  assert.ok(w.classList.contains('talk') && !w.classList.contains('listen'));
  env.flush();
});

test('avatar: a váltás alatt feloldott szünet után az új klip játszik (nincs álló kocka)', () => {
  const { createAvatarPlayer } = require('../../app/resources/ui/kapu.js');
  const env = avatarEnv();
  const w = fakeEl('span');
  const p = createAvatarPlayer(w, env);
  p.set('idle');
  const a = onVid(w);
  a.duration = 7.9; a.currentTime = 1;
  const b = vids(w).find((v) => v !== a);
  b.readyState = 0; // még tölt
  p.hold('doc', true); // rejtve indul a váltás: a play() kimarad
  p.set('listen');
  assert.ok(b.paused);
  p.hold('doc', false); // a régi indul újra…
  b.readyState = 4; b.emit('loadeddata'); // …és közben betölt az új
  assert.strictEqual(onVid(w), b);
  assert.ok(!b.paused, 'az új klip megy');
  env.flush();
  assert.strictEqual(p.state, 'listen');
});

test('avatar: be nem töltött következő klip – a régi marad, a következő hurokvégen újra', () => {
  const { createAvatarPlayer } = require('../../app/resources/ui/kapu.js');
  const env = avatarEnv();
  const w = fakeEl('span');
  const p = createAvatarPlayer(w, env);
  p.set('think');
  const a = onVid(w);
  const b = vids(w).find((v) => v !== a);
  a.duration = 4.8; a.currentTime = 1;
  b.readyState = 0;
  p.set('talk');
  env.flush(); // lejár az 1,5 mp-es várakozás, a talk még mindig nem töltött be
  assert.strictEqual(onVid(w), a, 'a think látszik tovább, nem üres kép');
  assert.ok(!b.classList.contains('on'));
  assert.strictEqual(p.state, 'think');
  assert.strictEqual(a.loop, false, 'a hurok végén újrapróbálja');
  assert.ok(b.src.endsWith('/kapu/talk.webm'), 'a talk tovább tölt');
  b.readyState = 4;
  a.emit('ended');
  assert.strictEqual(onVid(w), b);
  assert.strictEqual(p.state, 'talk');
  // a hurok végén is betöltetlen klip: a régi elölről indul, és újra vár
  a.duration = 7.9;
  b.duration = 7.9; b.currentTime = 7.5;
  a.readyState = 0;
  p.set('idle');
  b.ended = true; b.emit('ended');
  env.flush();
  assert.strictEqual(onVid(w), b);
  assert.ok(!b.paused && b.currentTime === 0 && b.loop === false);
});

test('avatar: az élő hang ablaka alatt a többi videós avatar áll, bezárás után újraindul', () => {
  const { createAvatarPlayer, overlayHold } = require('../../app/resources/ui/kapu.js');
  const env = avatarEnv();
  const hero = fakeEl('span'), own = fakeEl('span');
  hero.__kp = createAvatarPlayer(hero, env); hero.__kp.set('idle');
  own.__kp = createAvatarPlayer(own, env); own.__kp.set('hello');
  const isOwn = (w) => w === own;
  overlayHold(new Set([hero, own]), true, isOwn);
  assert.ok(vids(hero).every((v) => v.paused), 'a nagy Kapu áll');
  assert.ok(!onVid(own).paused, 'az ablak Kapuja megy');
  overlayHold(new Set([hero, own]), false, isOwn);
  assert.ok(!onVid(hero).paused);
  // lecsatolás után a hold nem indít el semmit
  let gone = 0; env.onDestroy = () => { gone++; };
  const w = fakeEl('span'); w.__kp = createAvatarPlayer(w, env); w.__kp.set('idle');
  w.__kp.destroy(); w.__kp.destroy();
  assert.strictEqual(gone, 1);
  w.__kp.hold('x', false);
  assert.ok(vids(w).every((v) => v.paused));
});

// --- modellválasztó (11. lépés) ---
const KV = require('../../app/resources/ui/kapu.js');
const CAT = {
  codex: { options: [{ id: 'gpt-6-luna', label: 'GPT-6 Luna', hint: 'gyors' }, { id: 'gpt-6-sol', label: 'GPT-6 Sol', hint: 'kiegyensúlyozott' }], default: 'gpt-6-sol', selected: 'gpt-6-luna' },
  claude: { options: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'kiegyensúlyozott' }], default: 'claude-sonnet-5-5', selected: 'claude-sonnet-5-5' },
};
test('ui: pickModel – a beszélgetésé, ha választható; különben a beállított alap, végül a kiegyensúlyozott', () => {
  assert.strictEqual(KV.pickModel(CAT, 'codex', 'gpt-6-sol'), 'gpt-6-sol');
  assert.strictEqual(KV.pickModel(CAT, 'codex', null), 'gpt-6-luna');
  assert.strictEqual(KV.pickModel(CAT, 'codex', 'gpt-9'), 'gpt-6-luna');
  assert.strictEqual(KV.pickModel({ codex: { ...CAT.codex, selected: 'x' } }, 'codex', null), 'gpt-6-sol');
  assert.strictEqual(KV.pickModel(null, 'codex', 'gpt-6-sol'), 'gpt-6-sol'); // katalógus nélkül a tárolt
  assert.strictEqual(KV.pickModel(CAT, null, null), null);
});
test('ui: a válasz fejléce motorral és modellel („Kapu · ChatGPT · GPT-6 Sol”)', () => {
  assert.deepStrictEqual(KV.metaParts(CAT, 'codex', 'gpt-6-sol'), ['Kapu', 'ChatGPT', 'GPT-6 Sol']);
  assert.deepStrictEqual(KV.metaParts(null, 'codex', 'gpt-6-astra'), ['Kapu', 'ChatGPT', 'GPT-6 Astra']);
  assert.deepStrictEqual(KV.metaParts(null, 'agy', 'gemini-3.8-flash'), ['Kapu', 'Antigravity', 'Gemini 3.8 Flash']);
  assert.deepStrictEqual(KV.metaParts(CAT, 'claude', undefined), ['Kapu', 'Claude']); // régi válasz: modell nélkül
});
test('ui: élő hang csak ChatGPT-vel és Antigravityvel (logó, hívásgomb)', () => {
  assert.deepStrictEqual(['codex', 'agy', 'claude', null].map(KV.canVoice), [true, true, false, false]);
});
test('ui: voiceTarget – aktív élő hangos motort megtart, Claude-ról átvált az elérhető ChatGPT/Antigravity motorra, különben null', () => {
  const BOTH = [
    { engine: 'claude', installed: true, signedIn: true },
    { engine: 'codex', installed: true, signedIn: true },
    { engine: 'agy', installed: true, signedIn: true },
  ];
  const ONLY_AGY = [
    { engine: 'claude', installed: true, signedIn: true },
    { engine: 'codex', installed: true, signedIn: false },
    { engine: 'agy', installed: true, signedIn: true },
  ];
  const ONLY_CLAUDE = [
    { engine: 'claude', installed: true, signedIn: true },
    { engine: 'codex', installed: true, signedIn: false },
    { engine: 'agy', installed: true, signedIn: false },
  ];
  // Aktív élő hangos motor: marad a választotton.
  assert.strictEqual(KV.voiceTarget('codex', BOTH, 'darwin'), 'codex');
  assert.strictEqual(KV.voiceTarget('agy', BOTH, 'darwin'), 'agy');
  // Claude-ról automatikusan az elérhető élő hangos motorra vált (ChatGPT, majd Antigravity).
  assert.strictEqual(KV.voiceTarget('claude', BOTH, 'darwin'), 'codex');
  assert.strictEqual(KV.voiceTarget('claude', ONLY_AGY, 'darwin'), 'agy');
  // Windowson az Antigravity élő hang nem érhető el: ha nincs ChatGPT sem, null.
  assert.strictEqual(KV.voiceTarget('claude', ONLY_AGY, 'win32'), null);
  assert.strictEqual(KV.voiceTarget('agy', BOTH, 'win32'), 'codex');
  // Ha egyik élő hangos motor sincs összekötve: null (marad a magyarázó kiírás).
  assert.strictEqual(KV.voiceTarget('claude', ONLY_CLAUDE, 'darwin'), null);
  // Míg a státusz töltődik (engines === null), csak az eleve élő hangos aktív motort előlegezi meg.
  assert.strictEqual(KV.voiceTarget('codex', null, 'darwin'), 'codex');
  assert.strictEqual(KV.voiceTarget('agy', null, 'darwin'), 'agy');
  assert.strictEqual(KV.voiceTarget('agy', null, 'win32'), null);
  assert.strictEqual(KV.voiceTarget('claude', null, 'darwin'), null);
});
test('ui: logoMode – telefonos élő hang (voice), ha Kapu be van kapcsolva és van összekötött ChatGPT/Antigravity, egyébként chat', () => {
  const ENGS = [
    { engine: 'claude', installed: true, signedIn: true },
    { engine: 'codex', installed: true, signedIn: true },
    { engine: 'agy', installed: true, signedIn: false },
  ];
  const ONLY_CLAUDE = [
    { engine: 'claude', installed: true, signedIn: true },
    { engine: 'codex', installed: true, signedIn: false },
    { engine: 'agy', installed: true, signedIn: false },
  ];
  assert.strictEqual(KV.logoMode(null, ENGS, 'darwin', true), 'chat');
  assert.strictEqual(KV.logoMode({ on: false, engine: 'codex' }, ENGS, 'darwin', true), 'chat');
  assert.strictEqual(KV.logoMode({ on: true, engine: 'claude' }, ENGS, 'darwin', true), 'voice'); // Claude mellett is van összekötött ChatGPT → átvált és indul
  assert.strictEqual(KV.logoMode({ on: true, engine: 'claude' }, ONLY_CLAUDE, 'darwin', true), 'chat'); // nincs összekötött élő hangos motor
  assert.strictEqual(KV.logoMode({ on: true, engine: 'agy' }, ONLY_CLAUDE, 'darwin', true), 'chat');
  assert.strictEqual(KV.logoMode({ on: true, engine: 'codex' }, null, 'darwin', true), 'chat'); // még nem töltődött be a státusz
  assert.strictEqual(KV.logoMode({ on: true, engine: 'codex' }, ENGS, 'darwin', false), 'chat'); // nincs KapuVoice
  assert.strictEqual(KV.logoMode({ on: true, engine: 'codex' }, ENGS, 'darwin', true), 'voice');
  const ENGS_AGY = [{ engine: 'agy', installed: true, signedIn: true }];
  assert.strictEqual(KV.logoMode({ on: true, engine: 'agy' }, ENGS_AGY, 'darwin', true), 'voice');
  assert.strictEqual(KV.logoMode({ on: true, engine: 'claude' }, ENGS_AGY, 'darwin', true), 'voice');
  assert.strictEqual(KV.logoMode({ on: true, engine: 'agy' }, ENGS_AGY, 'win32', true), 'chat'); // Windowson nincs Antigravity élő hang
});
test('ui: motorváltás és élő hang gombok – a renderBar szinkronban tartja a felső hívásgombot (syncCall), a hívásgomb/mikrofon/logó pedig az activateVoice-t hívja', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../../app/resources/ui/kapu.js'), 'utf8');
  assert.match(src, /function renderBar\(\)[\s\S]*?syncCall\(\);\s*\}/, 'renderBar végén lefut a syncCall(), így motorváltáskor a felső live gomb is átvált');
  assert.match(src, /if \('kcall' in d \|\| 'kmic' in d\) \{\s*await activateVoice\(\);\s*return;\s*\}/, 'a felső hívásgomb és az alsó mikrofon egyaránt az activateVoice()-on át vált motort / indít hangot');
  assert.match(src, /var VOICE_UNAVAIL = 'Hangon ChatGPT-vel vagy Antigravityvel beszélhetsz\.';/);
});
test('ui: a sín hover-logói (chat és phone) az alap logóval megegyező 176×162 RGBA PNG-k', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const pub = path.join(__dirname, '../../app/public');
  for (const name of ['iratkapu-logo.png', 'iratkapu-logo-chat.png', 'iratkapu-logo-phone.png']) {
    const buf = fs.readFileSync(path.join(pub, name));
    assert.strictEqual(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', name);
    assert.strictEqual(buf.readUInt32BE(16), 176, name + ' width');
    assert.strictEqual(buf.readUInt32BE(20), 162, name + ' height');
    assert.strictEqual(buf[25], 6, name + ' RGBA');
  }
  const html = fs.readFileSync(path.join(__dirname, '../../app/resources/ui/app.html'), 'utf8');
  assert.match(html, /iratkapu-logo-\$\{kmode==='voice'\?'phone':'chat'\}\.png/);
});

test('ui: gyors promptok – 3 eredeti + 5 könyvelőirodai tipp, saját felvétel, szerkesztés (előre felvett és saját is) és törlés', () => {
  assert.strictEqual(KV.DEFAULT_PROMPTS.length, 8);
  assert.deepStrictEqual(KV.DEFAULT_PROMPTS.slice(0, 3).map((p) => p.title), [
    'Mi jár le a héten?',
    'Melyik ügyfélnél van olvasatlan irat?',
    'Állítsd az emlékeztetőt 5 és 1 napra.',
  ]);
  for (const p of KV.DEFAULT_PROMPTS) {
    assert.ok(p.id && p.title && p.prompt, p.id);
  }

  // Testreszabás nélkül az alap 8 gyors promptot adja vissza (másolatként)
  const initial = KV.resolvePrompts(null);
  assert.strictEqual(initial.length, 8);
  initial[0].title = 'Átírva';
  assert.strictEqual(KV.DEFAULT_PROMPTS[0].title, 'Mi jár le a héten?');

  // Előre felvett gyors prompt szerkesztése helyben
  const editedBuiltin = KV.upsertPrompt(KV.resolvePrompts(null), {
    id: 'p-week',
    title: '  Heti lejáratok  ',
    prompt: '  Milyen határidők járnak le ezen a héten?  ',
  });
  assert.strictEqual(editedBuiltin.length, 8);
  assert.deepStrictEqual(editedBuiltin[0], {
    id: 'p-week',
    title: 'Heti lejáratok',
    prompt: 'Milyen határidők járnak le ezen a héten?',
  });

  // Saját gyors prompt hozzáadása és későbbi szerkesztése
  const withCustom = KV.upsertPrompt(editedBuiltin, {
    title: 'ÁFA-státusz',
    prompt: 'Ellenőrizd az esedékes ÁFA-bevallásokat ügyfelenként.',
  });
  assert.strictEqual(withCustom.length, 9);
  const custom = withCustom[8];
  assert.match(custom.id, /^u-[a-z0-9]+-[a-z0-9]+$/);
  assert.strictEqual(custom.title, 'ÁFA-státusz');

  const editedCustom = KV.upsertPrompt(withCustom, {
    id: custom.id,
    title: 'Havi ÁFA-státusz',
    prompt: 'Listázd a havi ÁFA-bevallások állapotát.',
  });
  assert.strictEqual(editedCustom.length, 9);
  assert.deepStrictEqual(editedCustom[8], {
    id: custom.id,
    title: 'Havi ÁFA-státusz',
    prompt: 'Listázd a havi ÁFA-bevallások állapotát.',
  });

  // Üres cím vagy prompt elutasítva
  assert.strictEqual(KV.upsertPrompt(editedCustom, { title: '   ', prompt: 'valami' }), null);
  assert.strictEqual(KV.upsertPrompt(editedCustom, { title: 'Cím', prompt: '' }), null);

  // Előre felvett és saját gyors prompt törlése (akár üres listáig)
  const afterDel = KV.removePrompt(editedCustom, 'p-week');
  assert.strictEqual(afterDel.some((p) => p.id === 'p-week'), false);
  assert.strictEqual(afterDel.length, 8);
  assert.deepStrictEqual(KV.resolvePrompts([]), []);
});

test('ui: gyors promptok DOM-sablonja és modáljai – hover ceruza + kuka minden elemen, szaggatott + karika és törlés-megerősítő modal', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const js = fs.readFileSync(path.join(__dirname, '../../app/resources/ui/kapu.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../app/resources/ui/kapu.css'), 'utf8');

  assert.match(js, /data-ksedit="/, 'minden gyors prompt kap szerkesztő gombot');
  assert.match(js, /data-ksdel="/, 'minden gyors prompt kap törlő (kuka) gombot');
  assert.match(js, /class="ke-add" data-ksadd/, 'a gyors promptok után ott a + gomb');
  assert.match(js, /function openPromptModal\(id\)/, 'hozzáadás / szerkesztés modal');
  assert.match(js, /function openDeletePromptModal\(id\)[\s\S]*?Gyors prompt törlése\?[\s\S]*?data-ksdelok="/, 'kuka kattintásra megerősítő modal nyílik');
  assert.match(css, /\.ke-add\{[^}]*border-radius:50%[^}]*border:1\.5px dashed/, 'a + gomb szaggatott körvonalas karika');
  assert.match(css, /\.ke-p:hover \.ke-pa,\.ke-p:focus-within \.ke-pa\{max-width:60px;opacity:1/, 'hoverre jelenik meg a szerkesztés + kuka ikonsor');
});
