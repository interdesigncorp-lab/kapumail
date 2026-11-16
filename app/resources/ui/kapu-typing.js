/* KapuTyping: a kész Kapu-válasz lassú, „emberi” legépelése.
   A CSS-t a KapuTyping.CSS string adja; a felület (7. lépés) beilleszti a stíluslapjába. */
(function (root) {
  'use strict';

  var HIDDEN = 'kapu-type-hidden', CARET = 'kapu-caret';
  var CSS = '.' + HIDDEN + '{display:none!important}'
    + '.' + CARET + '{display:inline-block;width:2px;height:1.05em;margin-left:1px;vertical-align:-0.15em;border-radius:2px;background:var(--brand,#2563eb);animation:kapuCaret .9s ease-in-out infinite}'
    + '@keyframes kapuCaret{0%,100%{opacity:.9}50%{opacity:.25}}'
    + '@media (prefers-reduced-motion:reduce){.' + CARET + '{animation:none}}';

  var clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };

  /* Teljes gépelési idő ms-ban: clamp(0,4 + hossz/400, 0,8, 3) mp. */
  function duration(len) { return clamp(0.4 + len / 400, 0.8, 3) * 1000; }

  var isSentenceEnd = function (text, i) {
    // Sortörés előtt a sortörés hosszabb szünete érvényes, nem a mondatvégé.
    return '.!?…'.indexOf(text[i]) >= 0 && (i + 1 >= text.length || text[i + 1] === ' ');
  };

  /* Terv: [{at, n, pause}] – `at` ms-nál `n` karakter látszik; `pause` az e lépés előtti szünet.
     Az idő 80%-a gépelés (0,55–1,5 ritmusszorzóval), 20%-a szünet; az utolsó lépés a teljes hossz. */
  function plan(text, rand, visibleLen) {
    rand = rand || Math.random;
    var len = text.length, total = duration(visibleLen == null ? len : visibleLen);
    if (!len) return [{ at: 0, n: 0, pause: 0 }];
    var steps = [], pos = 0, pending = 0;
    while (pos < len) {
      var size = 1 + Math.floor(rand() * 4), end = Math.min(len, pos + size), pause = 0;
      for (var i = pos; i < end; i++) {
        if (isSentenceEnd(text, i)) { end = i + 1; pause = 60 + rand() * 90; break; }
        if (text[i] === '\n' && i > 0 && text[i - 1] !== '\n') { end = i + 1; pause = 140 + rand() * 120; break; }
      }
      var mult = 0.55 + rand() * 0.95;
      steps.push({ n: end, w: (end - pos) / mult, pausePrev: pending });
      pending = pause; pos = end;
    }
    var pauseSum = 0;
    steps.forEach(function (s) { pauseSum += s.pausePrev; });
    var budget = total * 0.2, k = pauseSum > budget ? budget / pauseSum : 1;
    var typing = Math.max(0, total - pauseSum * k), wSum = 0;
    steps.forEach(function (s) { wSum += s.w; });
    var t = 0;
    var out = steps.map(function (s) {
      var p = s.pausePrev * k;
      t += p + typing * s.w / wSum;
      return { at: t, n: s.n, pause: p };
    });
    out[out.length - 1].at = total;
    return out;
  }

  var browserClock = {
    now: function () { return performance.now(); },
    frame: function (run) {
      var ran = false, once = function () { if (!ran) { ran = true; run(); } };
      requestAnimationFrame(once); setTimeout(once, 50);
    }
  };

  function motionOk() {
    try { return !document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  /* Egy renderelt válasz: a szöveg olvasási sorrendben, egy előtagja mutatható a helyén. */
  function Reveal(el, opts) {
    opts = opts || {};
    var self = this;
    var doc = el.ownerDocument || document;
    var texts = [], elements = [], text = '', shown = -1, done = false, stopped = false;
    var ptext = '', vis = [0]; // ptext: a terv szövege blokkhatáron '\n'-nel; vis[i]: látható karakterek ptext i. pozíciója előtt
    var BLOCK = /^(P|LI|UL|OL|DIV|H[1-6]|PRE|BLOCKQUOTE|TR|TABLE)$/;
    var mark = function () {
      if (ptext && ptext[ptext.length - 1] !== '\n') { ptext += '\n'; vis.push(vis[vis.length - 1]); }
    };
    var clock = opts.clock || browserClock;
    var enabled = opts.enabled || motionOk;
    var rand = opts.rand || Math.random;
    var caret = doc.createElement('span');
    caret.className = CARET;
    caret.setAttribute('aria-hidden', 'true');

    (function walk(parent) {
      Array.prototype.slice.call(parent.childNodes).forEach(function (c) {
        if (c.nodeType === 3) {
          var v = c.nodeValue || '';
          texts.push({ node: c, text: v, start: text.length }); text += v;
          for (var k = 0; k < v.length; k++) { ptext += v[k]; vis.push(vis[vis.length - 1] + 1); }
        } else if (c.nodeType === 1) {
          var tg = String(c.tagName || c.tag || '').toUpperCase(), blk = BLOCK.test(tg);
          elements.push({ el: c, start: text.length });
          if ((c.getAttribute && c.getAttribute('data-notype') !== null) || (c.dataset && c.dataset.notype)) return;
          if (blk) mark();
          walk(c);
          if (blk || tg === 'BR') mark();
        }
      });
    })(el);
    self.text = text;
    self.length = text.length;

    self.show = function (count) {
      if (count === shown) return;
      shown = count;
      var last = null;
      texts.forEach(function (t) {
        var vis = clamp(count - t.start, 0, t.text.length);
        var v = vis === t.text.length ? t.text : t.text.slice(0, vis);
        if (t.node.nodeValue !== v) t.node.nodeValue = v;
        if (vis > 0) last = t.node;
      });
      elements.forEach(function (e) { e.el.classList.toggle(HIDDEN, count < self.length && e.start >= count); });
      if (count >= self.length) caret.remove();
      else if (last) last.after(caret);
      else el.prepend(caret);
    };

    var steps = null, t0 = 0, catching = null;
    var nAt = function (ms) {
      var n = 0;
      for (var i = 0; i < steps.length; i++) { if (steps[i].at <= ms) n = steps[i].n; else break; }
      return n;
    };
    self.finish = function () {
      if (done) return;
      done = true;
      self.show(self.length);
      if (opts.onDone) opts.onDone();
    };
    // Leállítás: ami még rejtett, megjelenik, a kurzor eltűnik – semmi sem marad félig.
    self.stop = function () { if (!done) { stopped = true; self.finish(); } };

    /* Vár egy másik válasz: ~0,6 mp alatt a végére ér, szünetek nélkül. */
    self.catchUp = function (waiting) {
      if (done || !steps) return;
      var now = clock.now() - t0;
      var n0 = self.length ? nAt(now) : 0;
      // Gyorsítás: max(sebesség * (1 + 2 * várakozó), hátralévő / 0,6 mp) karakter/mp.
      var speed = self.length / (duration(self.length) * 0.8 / 1000);
      var rate = Math.max(speed * (1 + 2 * (waiting || 0)), (self.length - n0) / 0.6);
      catching = { from: now, n: n0, ms: Math.min(600, (self.length - n0) / rate * 1000) };
    };

    var tick = function () {
      if (done || stopped) return;
      if (el.isConnected === false) return self.finish(); // a lap elhagyva: mindent megmutatunk
      var ms = clock.now() - t0, n;
      if (catching) {
        var f = clamp((ms - catching.from) / catching.ms, 0, 1);
        n = Math.floor(catching.n + (self.length - catching.n) * f);
        if (f >= 1) return self.finish();
      } else {
        if (ms >= steps[steps.length - 1].at) return self.finish();
        n = nAt(ms);
      }
      self.show(n);
      clock.frame(tick);
    };

    self.start = function () {
      if (done) return self;
      if (!self.length || !enabled()) { self.finish(); return self; }
      steps = plan(ptext, rand, self.length).map(function (s) { return { at: s.at, n: vis[s.n], pause: s.pause }; });
      self.plan = steps;
      t0 = clock.now();
      self.show(0);
      clock.frame(tick);
      return self;
    };
  }

  var api = { duration: duration, plan: plan, Reveal: Reveal, CSS: CSS, HIDDEN: HIDDEN, CARET: CARET };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapuTyping = api;
})(typeof window !== 'undefined' ? window : globalThis);
