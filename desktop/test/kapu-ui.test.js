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
  assert.match(css, /\.kl-row\.on \.kl-open\{background:#fff;border-color:rgba\(255,255,255,\.95\);box-shadow:0 10px 26px -14px rgba\(60,35,120,\.5\)\}/, 'aktív beszélgetéskártya lila csík és lila keret nélkül');
});

test('md: GFM-táblázat – igazítások, automatikus számoszlop, kapu: chipek, escape-elt pipe és XSS-védelem', () => {
  const md = [
    '| Ügyfél | Esedékesség | Státusz | Összeg | Megjegyzés |',
    '| :--- | :---: | ---: | --- | --- |',
    '| [Borostyán Pékség Kft.](kapu:ugyfel/3) | 2026-11-20 | **Feldolgozott** | 1 250 000 Ft | `A | B` kód |',
    '| Minta Kft. | 2026-11-12 | Függő | -45 200 Ft | a \\| b <script>x</script> |',
  ].join('\n');
  const h = KapuMd.render(md);
  assert.ok(h.includes('<div class="ktbl-w"><div class="ktbl-sc"><table class="ktbl">'));
  assert.match(h, /<th class="al-l">Ügyfél<\/th>/);
  assert.match(h, /<th class="al-c">Esedékesség<\/th>/);
  assert.match(h, /<th class="al-r">Státusz<\/th>/);
  assert.match(h, /<th class="num">Összeg<\/th>/, 'az összegeket tartalmazó oszlop automatikusan jobbra igazított (num)');
  assert.match(h, /<th>Megjegyzés<\/th>/);
  assert.match(h, /<td class="al-l"><button class="kchip" data-cl="3">Borostyán Pékség Kft\.<\/button><\/td>/);
  assert.match(h, /<td class="num">1 250 000 Ft<\/td>/);
  assert.match(h, /<td class="num">-45 200 Ft<\/td>/);
  assert.match(h, /<td><code>A \| B<\/code> kód<\/td>/, 'kódon belüli pipe nem töri szét a cellát');
  assert.match(h, /<td>a \| b &lt;script&gt;x&lt;\/script&gt;<\/td>/, 'escape-elt pipe és XSS-szűrés cellán belül');

  // Külső pipe nélküli táblázat és dátum/adószám oszlop (nem válik számoszloppá)
  const md2 = 'Adószám | Határidő\n--- | ---\n12345678-2-41 | 2026. 11. 20.';
  const h2 = KapuMd.render(md2);
  assert.ok(h2.includes('<table class="ktbl">'));
  assert.ok(!h2.includes('class="num"'), 'adószám és dátum nem kap num osztályt');
});

test('md: címsorok, idézet, kódblokk, elválasztó és áthúzás', () => {
  const md = [
    '### 1. Konkrét teendők',
    '#### Részletek',
    '> Áfa tv. **120. §** szerinti levonási jog',
    '',
    '```',
    'Alap: 100 000 Ft <tag>',
    'Áfa:   27 000 Ft',
    '```',
    '',
    'Régi: ~~10 000 Ft~~ → **12 000 Ft**',
    '',
    '---',
    'Tájékoztató jellegű válasz.',
  ].join('\n');
  const h = KapuMd.render(md);
  assert.match(h, /<h3 class="kh3">1\. Konkrét teendők<\/h3>/);
  assert.match(h, /<h4 class="kh4">Részletek<\/h4>/);
  assert.match(h, /<blockquote class="kquote"><p>Áfa tv\. <strong>120\. §<\/strong> szerinti levonási jog<\/p><\/blockquote>/);
  assert.match(h, /<pre class="kpre"><code>Alap: 100 000 Ft &lt;tag&gt;\nÁfa:   27 000 Ft<\/code><\/pre>/);
  assert.match(h, /<del>10 000 Ft<\/del>/);
  assert.ok(h.includes('<hr class="khr">'));
});

test('typing: data-notype eszköztár nem gépelődik ki karakterenként, és üres záróelem sem marad rejtve', () => {
  const d = stubDom();
  const root = d.el('div');
  const wrap = d.add(root, d.el('div'));
  const bar = d.add(wrap, d.el('div'));
  bar.dataset = { notype: '1' };
  d.add(bar, d.textNode('2 sor Másolás CSV'));
  const td = d.add(wrap, d.el('td'));
  d.add(td, d.textNode('Borostyán Pékség Kft.'));
  const emptyTd = d.add(wrap, d.el('td'));
  const hr = d.add(root, d.el('hr'));
  const clock = fakeClock();
  let done = 0;
  const r = new KapuTyping.Reveal(root, { clock, enabled: () => true, rand: seeded(9), onDone: () => done++ }).start();
  assert.strictEqual(r.text, 'Borostyán Pékség Kft.', 'a data-notype eszköztár szövege nem kerül a gépelt szövegbe');
  for (let i = 0; i < 100 && !done; i++) clock.advance(50);
  assert.strictEqual(done, 1);
  assert.ok(!emptyTd.classList.contains('kapu-type-hidden'), 'az üres cella sem marad rejtett a végén');
  assert.ok(!hr.classList.contains('kapu-type-hidden'), 'a záró hr sem marad rejtett a végén');
});

test('ui: táblázat TSV / CSV export (BOM, pontosvessző, képlet-injekció védelem) és magyar/szám/dátum rendezés', () => {
  const rows = [
    ['Ügyfél', 'Összeg', 'Megjegyzés'],
    ['Borostyán Pékség Kft.', '-45 200 Ft', 'Pontos; "idézett" szöveg'],
    ['Minta Kft.', '1 250 000 Ft', '=CMD|\' /C calc\'!A0'],
  ];
  const tsv = KV.tableToTsv(rows);
  assert.strictEqual(tsv.split('\n').length, 3);
  assert.strictEqual(tsv.split('\n')[1], 'Borostyán Pékség Kft.\t-45 200 Ft\tPontos; "idézett" szöveg');

  const csv = KV.tableToCsv(rows);
  assert.ok(csv.startsWith('\uFEFFÜgyfél;Összeg;Megjegyzés\r\n'), 'UTF-8 BOM + pontosvesszős magyar Excel-formátum');
  assert.ok(csv.includes(';-45 200 Ft;'), 'negatív számösszeg érintetlen marad');
  assert.ok(csv.includes('"Pontos; ""idézett"" szöveg"'), 'pontosvessző és idézőjel RFC-4180 szerint idézve');
  assert.ok(csv.includes(";'=CMD|"), 'Excel képlet-injekció hatástalanítva');

  // Számösszegek rendezése
  assert.ok(KV.compareTableCells('-45 200 Ft', '0 Ft', 'asc') < 0);
  assert.ok(KV.compareTableCells('1 250 000 Ft', '200 000 Ft', 'asc') > 0);
  assert.ok(KV.compareTableCells('1 250 000 Ft', '200 000 Ft', 'desc') < 0);
  // Magyar és ISO dátumok rendezése
  assert.ok(KV.compareTableCells('2026. 10. 20.', '2026. 11. 04.', 'asc') < 0);
  assert.ok(KV.compareTableCells('2026-11-16', '2026-10-16', 'asc') > 0);
  // Üres / kötőjeles helyőrző mindig a végére kerül (növekvőben és csökkenőben is)
  assert.ok(KV.compareTableCells('–', '0 Ft', 'asc') > 0);
  assert.ok(KV.compareTableCells('–', '0 Ft', 'desc') > 0);
});

test('ui: táblázat-eszköztár, válasz-másolás és persona táblázatszabály bekötve', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const js = fs.readFileSync(path.join(__dirname, '../../app/resources/ui/kapu.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../app/resources/ui/kapu.css'), 'utf8');
  const persona = fs.readFileSync(path.join(__dirname, '../kapu/persona.md'), 'utf8');

  assert.match(js, /function enhanceTables\(el\)/);
  assert.match(js, /data-ktcopy/);
  assert.match(js, /data-ktcsv/);
  assert.match(js, /data-ktsort/);
  assert.match(js, /data-kcopy="/);
  assert.match(css, /\.ktbl-w\{/);
  assert.match(css, /\.ktbl \.num,\.ktbl \.al-r\{text-align:right;font-variant-numeric:tabular-nums/);
  assert.match(persona, /Markdown-táblázat/);
});

test('ui: beszélgetéslista 3 fázisú nézetválasztó (részletes, kétsoros, kompakt hoverre nyíló)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const js = fs.readFileSync(path.join(__dirname, '../../app/resources/ui/kapu.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../app/resources/ui/kapu.css'), 'utf8');

  assert.deepStrictEqual(KV.LIST_VIEWS.map((v) => v.id), ['compact', 'two', 'full']);
  assert.strictEqual(KV.resolveListView('two'), 'two');
  assert.strictEqual(KV.resolveListView('compact'), 'compact');
  assert.strictEqual(KV.resolveListView('full'), 'full');
  assert.strictEqual(KV.resolveListView('ismeretlen'), 'compact');
  assert.strictEqual(KV.resolveListView(null), 'compact');

  assert.match(js, /class="kl-day-bar"/, 'az első napfejléc sora tartalmazza a jobbra igazított nézetválasztót');
  assert.match(js, /data-kvbtn/, 'a nézetválasztó ikon gombja');
  assert.match(js, /class="kl-vmenu" role="menu"/, 'lenyíló választómenü');
  assert.match(js, /data-kview="' \+ o\.id \+ '"/, 'mindhárom fázis választható a menüből');
  assert.match(js, /l\.dataset\.kview = view/, 'az aktív fázis a #kapulist data-kview attribútumára kerül');
  assert.match(js, /e\.__inKapuList = true/, 'a belső kattintás megjelölt, hogy az újrarenderelés után se zárja vissza a globális figyelő');
  assert.match(js, /K\.vdd = false; K\.menu = null; renderList\(\);\s*\}, true\)/, 'a külső kattintás-figyelő capture fázisban fut az innerHTML csere előtt');

  assert.match(css, /#kapulist\[data-kview="two"\] \.kl-meta\{display:none\}/, 'kétsoros nézetben a középső motorsor rejtve');
  assert.match(css, /#kapulist\[data-kview="two"\] \.kl-when\{display:inline/, 'kétsoros nézetben az időpont a cím mellett látszik');
  assert.match(css, /#kapulist\[data-kview="compact"\] \.kl-extra\{display:grid;grid-template-rows:0fr;opacity:0/, 'kompakt nézetben alapból 1 soros (összecsukott)');
  assert.match(css, /#kapulist\[data-kview="compact"\] \.kl-row:hover \.kl-extra[\s\S]*?grid-template-rows:1fr;opacity:1/, 'kompakt nézetben rámutatásra kinyílik');
});

test('easter egg: hullámozva felszálló pasztell szívecskék, csillámok, kedves és könyvelős emojik a nagy Kapu felett', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const js = fs.readFileSync(path.join(__dirname, '../../app/resources/ui/kapu.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../app/resources/ui/kapu.css'), 'utf8');

  // Készletek pontos ellenőrzése (A változat + jóváhagyott könyvelős/irodai készlet)
  assert.deepStrictEqual(KV.EASTER_CUTE, ['🥰', '😊', '☺️', '🤗', '✨', '🌸', '🩷', '💜']);
  assert.deepStrictEqual(KV.EASTER_OFFICE, ['💌', '🧮', '🧾', '📬', '📊', '🗂️', '📎', '☕', '✅', '🤓', '📈']);
  assert.strictEqual(KV.EASTER_COLORS.length, 5);

  // Hullámzó röppálya: felfelé emelkedik, oldalirányban szinuszosan leng, az elején előtűnik, a végén elhalványul
  const sample = { x0: 78, y0: 44, rise: 90, drift: 6, amp: 12, freq: 2, phase: 0, maxAlpha: 0.9 };
  const s0 = KV.stepEasterParticle(sample, 0);
  const sMid1 = KV.stepEasterParticle(sample, 0.25);
  const sMid2 = KV.stepEasterParticle(sample, 0.75);
  const sEnd = KV.stepEasterParticle(sample, 1);
  assert.strictEqual(s0.alpha, 0);
  assert.ok(sMid1.alpha > 0.85);
  assert.strictEqual(sEnd.alpha, 0);
  assert.ok(sMid1.y < s0.y && sMid2.y < sMid1.y && sEnd.y < sMid2.y, 'monoton felfelé száll');
  assert.ok(sMid1.x > sample.x0 && sMid2.x < sample.x0 + sample.drift * 0.75, 'oldalirányban hullámzik');

  // Interaktív vezérlő tesztelése kézi órával és csonk DOM-mal
  let now = 1000;
  let nextId = 1;
  const tasks = new Map();
  let rafCb = null;
  let reduced = false;
  const env = {
    doc: { createElement: fakeEl },
    now: () => now,
    rand: seeded(42),
    disabled: () => reduced,
    setTimeout: (fn, ms) => { const id = nextId++; tasks.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => { tasks.delete(id); },
    raf: (fn) => { rafCb = fn; return 999; },
    caf: () => { rafCb = null; },
  };
  function advance(ms) {
    const target = now + ms;
    while (true) {
      let earliest = null;
      for (const [id, t] of tasks) {
        if (t.at <= target && (!earliest || t.at < earliest.at)) earliest = { id, ...t };
      }
      if (!earliest) break;
      now = earliest.at;
      tasks.delete(earliest.id);
      earliest.fn();
    }
    now = target;
    if (rafCb) { const f = rafCb; rafCb = null; f(now); }
  }

  const slot = fakeEl('span');
  const hero = fakeEl('span');
  slot.appendChild(hero);
  const fx = KV.createHeroEasterEgg(slot, hero, env);

  assert.ok(slot.classList.contains('kav-hero-slot'));
  assert.strictEqual(fx.layer.className, 'kav-fx');
  assert.strictEqual(fx.count(), 0);

  // Ráhúzáskor: k-hover + k-happy rugózás, azonnali részecske, majd folyamatos utánpótlás
  hero.emit('mouseenter');
  assert.ok(hero.classList.contains('k-hover'));
  assert.ok(hero.classList.contains('k-happy'));
  assert.strictEqual(fx.count(), 1);

  advance(900);
  assert.ok(fx.count() >= 3, 'hover közben folyamatosan születnek az új részecskék');
  assert.ok(!hero.classList.contains('k-happy'), 'a rugózás 680 ms után visszaáll');

  // Mind a szívecskék/csillámok, mind az emojik előfordulnak nagyobb mintán
  const kinds = new Set();
  for (let i = 0; i < 40; i++) {
    advance(250);
    const p = fx.spawnOne();
    if (p) kinds.add(p.kind);
  }
  assert.ok(kinds.has('heart'), 'van pasztell szív');
  assert.ok(kinds.has('cute'), 'van kedves emoji');
  assert.ok(kinds.has('office'), 'van könyvelős/irodai emoji');

  // Elhúzáskor: k-hover lekerül, új részecske már nem indul, a meglévők szépen elhalványulva eltűnnek
  hero.emit('mouseleave');
  assert.ok(!hero.classList.contains('k-hover'));
  for (let i = 0; i < 20; i++) advance(200);
  assert.strictEqual(fx.count(), 0);
  assert.strictEqual(fx.layer.children.length, 0);

  // Kattintásra 4 részecskés örömbuborék-sorozat + minimalista tejüveg idézet-buborék jelenik meg
  hero.emit('click');
  advance(350);
  assert.strictEqual(fx.count(), 4);
  const firstQ = fx.quoteEl();
  assert.ok(firstQ && firstQ.className === 'kav-q' && firstQ.parentNode === slot);
  assert.match(firstQ.children[0].textContent, /^„.+”$/);
  assert.ok(firstQ.children[1].textContent.length > 0);

  // Újabb kattintás azonnal cseréli a buborékot másik idézetre és másik szerzőre
  hero.emit('click');
  const secondQ = fx.quoteEl();
  assert.ok(secondQ && secondQ !== firstQ && !firstQ.parentNode);
  assert.notStrictEqual(secondQ.children[0].textContent, firstQ.children[0].textContent);
  assert.notStrictEqual(secondQ.children[1].textContent, firstQ.children[1].textContent);

  // 6,8 mp után elhalványul (.out), majd lekerül a DOM-ból
  advance(6800);
  assert.ok(secondQ.classList.contains('out'));
  advance(400);
  assert.strictEqual(fx.quoteEl(), null);
  assert.ok(!secondQ.parentNode);

  // prefers-reduced-motion mellett a mozgó részecskék leállnak, de kattintásra az idézet továbbra is olvasható
  reduced = true;
  advance(50);
  assert.strictEqual(fx.count(), 0);
  hero.emit('mouseenter');
  assert.strictEqual(fx.count(), 0);
  hero.emit('click');
  assert.strictEqual(fx.count(), 0);
  assert.ok(fx.quoteEl() !== null, 'csökkentett mozgásnál is megjelenik az idézet');

  reduced = false;
  hero.emit('click');
  assert.strictEqual(fx.count(), 1);
  hero.isConnected = false;
  advance(50);
  assert.strictEqual(fx.count(), 0);
  assert.strictEqual(fx.quoteEl(), null);

  // Bekötés és stílus ellenőrzése
  assert.match(js, /if \(opts\.hero\) \{\s*w\.__ke = createHeroEasterEgg\(el, w,/);
  assert.match(css, /\.kav-hero\.k-happy\{animation:khappy/);
  assert.match(css, /\.kav-q\{[^}]*background:rgba\(255,255,255,\.80\)/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{[^\n]*\.kav-fx\{display:none\}/);
});

test('easter egg idézetek: 12 szerző, összesen 130 tétel, kevert ismétlésmentes húzás', () => {
  assert.strictEqual(KV.EASTER_QUOTE_GROUPS.length, 12);
  assert.strictEqual(KV.EASTER_QUOTES.length, 130);
  assert.deepStrictEqual(KV.EASTER_QUOTE_GROUPS.map((g) => g.a), [
    'Warren Buffett · Berkshire Hathaway',
    'Peter Drucker · Drucker Institute',
    'Jeff Bezos · Amazon',
    'Steve Jobs · Apple',
    'Paul Graham · Y Combinator',
    'Charlie Munger · Berkshire Hathaway',
    'Bojár Gábor · Graphisoft',
    'Rubik Ernő · Rubik-kocka',
    'Sam Walton · Walmart',
    'Satya Nadella · Microsoft',
    'Balogh Petya · STRT',
    'Laczkovszki Gábor · WiredSign',
  ]);
  for (const g of KV.EASTER_QUOTE_GROUPS) {
    assert.strictEqual(g.qs.length, g.a === 'Laczkovszki Gábor · WiredSign' ? 20 : 10, g.a);
    for (const q of g.qs) assert.ok(q.length >= 15 && !q.includes('Másolás') && !q.includes('javasolt idézet') && !q.includes('Kedvencem'), q);
  }

  const pick = KV.createQuotePicker(KV.EASTER_QUOTES, seeded(19));
  const seen = new Set();
  for (let i = 0; i < 130; i++) {
    const item = pick();
    assert.ok(item && item.q && item.a);
    seen.add(item.a + '::' + item.q);
  }
  assert.strictEqual(seen.size, 130, 'egy teljes 130-as körben minden idézet pontosan egyszer kerül sorra');
  // Újrakeverés után is érvényes elemet ad
  const nextCycle = pick();
  assert.ok(nextCycle && nextCycle.q && nextCycle.a);
});
