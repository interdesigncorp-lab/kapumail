/* Kapu-chat (ADR-014): Beállítások → „Kapu” lap. Kapu be/ki (bekapcsoláskor Kapu-hozzáférés kérése), a három
   AI-motor állapota és belépése (rejtett munkamenetben, a böngészőben; tmux nélkül a Terminálban) (2 mp-enként figyelve, legfeljebb 10 percig), motorválasztás,
   adatvédelmi figyelmeztetés, felolvasás. Kifelé: window.KapuSettings. */
(function () {
  'use strict';

  var ENG = { claude: 'Claude', codex: 'ChatGPT', agy: 'Antigravity' };
  var MARK = { claude: 'C', codex: 'G', agy: 'A' };
  var MAKER = { claude: 'Anthropic', codex: 'OpenAI', agy: 'Google' };
  var ORDER = ['claude', 'codex', 'agy'];
  var POLL_MS = 2000, POLL_MAX_MS = 10 * 60 * 1000;
  var bridge = function () { return window.iratkapuDesktop && window.iratkapuDesktop.kapu; };

  var SS = { cfg: null, engines: null, err: '', tokenErr: '', busy: false, signing: null, loaded: 0 };

  var cap = function (s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };

  function engCard(e) {
    var s = (SS.engines || []).filter(function (x) { return x.engine === e; })[0];
    var sel = SS.cfg && SS.cfg.engine === e;
    var st = !SS.engines ? '<span class="st na"><span class="ks-spin" style="width:11px;height:11px;border-width:1.5px"></span>Ellenőrzés…</span>'
      : !s || !s.installed ? '<span class="st na">Nincs telepítve</span>'
        : !s.signedIn ? '<span class="st wait">' + ic('alert') + 'Nincs bejelentkezve</span>'
          : '<span class="st ok">' + ic('check') + 'Bejelentkezve' + (s.account ? ': ' + esc(cap(s.account)) : '') + '</span>';
    var acts = '';
    if (s && s.installed && !s.signedIn) acts += '<button type="button" class="kbtn sec" data-kssign="' + e + '"' + (SS.signing ? ' disabled' : '') + '>' + ic('k-login') + 'Belépés</button>';
    if (SS.engines && (!s || !s.installed)) acts += '<button type="button" class="kbtn sec" data-ksrecheck>Újra ellenőrzöm</button>';
    return '<div class="ks-e' + (sel ? ' on' : '') + '"><label class="hd">' + (window.KapuMark ? KapuMark(e) : '<span class="keng ' + e + '">' + MARK[e] + '</span>') + '<span><b>' + ENG[e] + '</b><br><span class="mut" style="font-size:12px;font-weight:500">' + MAKER[e] + '</span></span>' +
      '<input type="radio" name="kseng" value="' + e + '"' + (sel ? ' checked' : '') + (s && s.signedIn ? '' : ' disabled') + ' aria-label="' + ENG[e] + ' használata"></label>' +
      st + (s && s.error ? '<span class="er">' + esc(s.error) + '</span>' : '') +
      (!s || !s.installed ? (SS.engines ? '<span class="mut" style="font-size:12px">Telepítsd a(z) ' + ENG[e] + ' parancssori eszközét, majd ellenőrizd újra.</span>' : '') : '') +
      (acts ? '<div class="acts">' + acts + '</div>' : '') + '</div>';
  }

  function signPanel() {
    var g = SS.signing;
    if (!g) return '';
    var txt = g.error ? esc(g.error) + ' '
      : g.hidden ? 'Megnyitottuk a(z) <b>' + ENG[g.engine] + '</b> belépőoldalát a böngésződben. Lépj be az előfizetéses fiókoddal, és engedélyezd a hozzáférést; utána magától továbblépünk. '
        : 'Megnyitottuk a Terminált a(z) <b>' + ENG[g.engine] + '</b> belépéséhez. Lépj be ott; figyeljük, és magától továbblépünk. ';
    return '<div class="ks-sign" role="status"><span class="ks-spin"></span><p>' + txt +
      (!g.hidden && g.command ? 'Ha nem nyílt meg, futtasd a Terminálban: <code>' + esc(g.command) + '</code>' : '') + '</p>' +
      (g.hidden && g.code ? '<form data-kscode style="display:flex;gap:6px;flex-wrap:wrap"><input name="c" placeholder="A böngészőben kapott kód" autocomplete="off" spellcheck="false" required style="padding:7px 10px;border-radius:10px;border:1px solid var(--line)"><button class="kbtn sec">Kód elküldése</button></form>' : '') +
      (g.hidden && g.url ? '<button type="button" class="kbtn sec" data-ksopen>' + ic('k-login') + 'Belépőoldal újranyitása</button>' : '') +
      (!g.hidden && g.command ? '<button type="button" class="kbtn sec" data-kscopy>' + ic('copy') + 'Parancs másolása</button>' : '') +
      '<button type="button" class="kbtn sec" data-kscancel>Mégse</button></div>';
  }

  function body() {
    var b = bridge();
    if (!b) return '<div class="card"><p class="mut" style="margin:0">Kapu csak a KapuMail asztali alkalmazásában érhető el.</p></div>';
    var c = SS.cfg || {};
    return '<div class="card"><div class="ks-hero"><span class="ks-av"></span><div><h4>Kapu, az iroda AI-segédje</h4>' +
      '<p class="mut">Kérdezz Kaputól az iratokról, határidőkről, ügyfelekről. A saját AI-előfizetéseddel válaszol, és a beállításokat csak a jóváhagyásoddal állítja át. A beszélgetések csak ezen a gépen maradnak.</p></div></div>' +
      '<label class="task" style="margin-top:14px"><input type="checkbox" data-kson' + (c.on ? ' checked' : '') + (SS.busy ? ' disabled' : '') + '><span>Kapu bekapcsolása' +
      '<small>Bekapcsoláskor a KapuMail a nevedben egy Kapu-hozzáférést kér: csak olvasni tud, és a beállításokat csak jóváhagyással módosíthatja. Az iroda adminja az AI-kapcsolat lapon látja és visszavonhatja.</small></span></label>' +
      (SS.err ? '<div class="ks-warn" style="background:var(--red-bg);color:var(--red)">' + ic('alert') + '<span>' + esc(SS.err) + '</span></div>' : '') +
      (c.on && SS.tokenErr ? '<div class="ks-warn" style="background:var(--red-bg);color:var(--red)">' + ic('alert') + '<span>' + esc(SS.tokenErr) + ' <button type="button" class="lnk" data-ksrenew>Újrapróbálom</button></span></div>' : '') +
      '</div>' +
      '<div class="card"><h4>' + ic('k-spark') + 'Melyik AI-val beszéljen Kapu?</h4><p class="mut" style="margin:0 0 10px">A választott szolgáltató parancssori eszköze fut ezen a gépen, a te előfizetéseddel. Belépni egyszer kell, a böngészőben.</p>' +
      '<div class="ks-eng" role="radiogroup" aria-label="Kapu motorja">' + ORDER.map(engCard).join('') + '</div>' + signPanel() + '</div>' +
      '<div class="card"><h4>' + ic('k-vol') + 'Felolvasás</h4><label class="task"><input type="checkbox" data-ksread' + (c.readAloud ? ' checked' : '') + '><span>Kapu válaszainak felolvasása' +
      '<small>A kész választ a gép magyar hangja felolvassa. Új üzenet, vagy a beszélgetésbe kattintás leállítja.</small></span></label></div>' +
      '<div class="ks-warn">' + ic('shield') + '<span><b>Adatvédelem.</b> Amit Kaputól kérdezel, és amit Kapu ehhez az iroda adataiból lekér, a választott AI-szolgáltatóhoz (Anthropic, OpenAI vagy Google) kerül. ' +
      'A szolgáltató ezekre nézve adatfeldolgozó: használat előtt az irodának adatfeldolgozói szerződés és adatvédelmi hatásvizsgálat (DPIA) kell, ahogy az AI-kapcsolatnál. Ügyféladatot csak annyit kérdezz, amennyi a munkához kell.</span></div>';
  }

  function paint() {
    var el = document.getElementById('kapuset');
    if (!el) return;
    el.innerHTML = body();
    var slot = el.querySelector('.ks-av');
    if (slot && window.KapuAvatar) KapuAvatar.mount(slot, { size: 68, live: false, state: 'idle' });
  }

  async function refresh(force) {
    var b = bridge();
    if (!b) return;
    if (!force && Date.now() - SS.loaded < 3000) return;
    SS.loaded = Date.now();
    var c = await b.config().catch(function (e) { return { ok: false, error: e && e.message }; });
    if (c && c.ok) { SS.cfg = c; SS.err = ''; } else SS.err = (c && c.error) || 'A Kapu beállításai nem olvashatók.';
    paint();
    var r = await b.status().catch(function () { return null; });
    if (r && r.ok) SS.engines = r.engines || [];
    if (window.KapuView) KapuView.sync(SS.cfg, r && r.ok ? SS.engines : null);
    paint();
  }

  async function setCfg(patch) {
    var r = await bridge().setConfig(patch).catch(function (e) { return { ok: false, error: e && e.message }; });
    if (!r || !r.ok) { toast(esc((r && r.error) || 'A beállítás nem menthető.'), true); return false; }
    SS.cfg = Object.assign({}, SS.cfg, r);
    if (window.KapuView) KapuView.sync(SS.cfg, SS.engines.length ? SS.engines : null);
    return true;
  }

  async function token(renew) {
    var r = await bridge().ensureToken(renew ? { renew: true } : undefined).catch(function (e) { return { ok: false, error: e && e.message }; });
    SS.tokenErr = r && r.ok ? '' : (r && r.error) || 'A Kapu-hozzáférés most nem kérhető.';
    if (!SS.tokenErr && SS.cfg) SS.cfg.hasToken = true;
    if (window.KapuView) KapuView.sync({ hasToken: !SS.tokenErr });
    return !SS.tokenErr;
  }

  function stopSign() {
    if (SS.signing && SS.signing.timer) clearTimeout(SS.signing.timer);
    SS.signing = null;
  }

  async function signIn(engine) {
    var b = bridge();
    if (!b || !ENG[engine]) return;
    stopSign();
    var g = SS.signing = { engine: engine, command: '', t0: Date.now(), timer: 0 };
    paint();
    var r = await b.signIn(engine).catch(function (e) { return { ok: false, error: e && e.message }; });
    if (SS.signing !== g) return;
    g.command = (r && r.command) || '';
    g.hidden = !!(r && r.hidden);
    if (!r || !r.ok) g.error = (r && r.error) || 'A belépés nem indult el.';
    paint();
    var tick = async function () {
      if (SS.signing !== g) return;
      // A Beállítások → Kapu lap elhagyásakor a figyelés leáll.
      if (!document.getElementById('kapuset')) { stopSign(); b.cancelSignIn().catch(function () {}); return; }
      if (Date.now() - g.t0 > POLL_MAX_MS) { stopSign(); toast('A belépést 10 percig nem láttuk. Próbáld újra.', true); paint(); return; }
      if (g.hidden && b.signInState) {
        var hs = await b.signInState().catch(function () { return null; });
        if (SS.signing !== g) return;
        if (hs && hs.ok && hs.running && ((hs.url || '') !== (g.url || '') || !!hs.needsCode !== !!g.code)) { g.url = hs.url || ''; g.code = !!hs.needsCode; paint(); }
      }
      var s = await b.status().catch(function () { return null; });
      if (SS.signing !== g) return;
      if (s && s.ok) {
        SS.engines = s.engines || [];
        var me = SS.engines.filter(function (x) { return x.engine === engine; })[0];
        if (me && me.signedIn) {
          stopSign();
          b.cancelSignIn().catch(function () {});
          toast('Bejelentkeztél: ' + ENG[engine] + '.');
          if (!SS.cfg || !SS.cfg.engine) await setCfg({ engine: engine });
          else if (window.KapuView) KapuView.sync(SS.cfg, SS.engines);
          paint();
          return;
        }
      }
      if (!g.code) paint();
      g.timer = setTimeout(tick, POLL_MS);
    };
    g.timer = setTimeout(tick, POLL_MS);
  }

  document.addEventListener('change', async function (e) {
    var t = e.target;
    if (!t.closest || !t.closest('#kapuset')) return;
    if ('kson' in t.dataset) {
      SS.busy = true; paint();
      if (await setCfg({ on: t.checked })) {
        if (SS.cfg.on) {
          if (await token(false)) toast('Kapu bekapcsolva.');
          if (!SS.cfg.engine && SS.engines) {
            var first = SS.engines.filter(function (x) { return x.signedIn; })[0];
            if (first) await setCfg({ engine: first.engine });
          }
        } else toast('Kapu kikapcsolva.');
      }
      SS.busy = false; paint();
      return;
    }
    if (t.name === 'kseng') { if (await setCfg({ engine: t.value })) { toast('Kapu motorja: ' + ENG[t.value] + '.'); paint(); } return; }
    if ('ksread' in t.dataset) { if (await setCfg({ readAloud: t.checked })) paint(); }
  });

  document.addEventListener('click', async function (e) {
    var t = e.target.closest && e.target.closest('#kapuset button');
    if (!t) return;
    var d = t.dataset;
    if (d.kssign) { signIn(d.kssign); return; }
    if ('kscancel' in d) { stopSign(); bridge().cancelSignIn().catch(function () {}); paint(); return; }
    if ('kscopy' in d) {
      var cmd = SS.signing && SS.signing.command;
      if (cmd) navigator.clipboard.writeText(cmd).then(function () { toast('Parancs a vágólapon.'); }, function () { toast('A másolás nem sikerült.', true); });
      return;
    }
    if ('ksopen' in d) {
      var u = SS.signing && SS.signing.url;
      if (u) bridge().signInOpen(u).then(function (r) { if (!r || !r.ok) toast('A belépőoldal nem nyitható meg.', true); });
      return;
    }
    if ('ksrecheck' in d) { SS.engines = null; paint(); refresh(true); return; }
    if ('ksrenew' in d) { t.disabled = true; if (await token(true)) toast('Kapu-hozzáférés megújítva.'); paint(); }
  });

  document.addEventListener('submit', async function (e) {
    var f = e.target;
    if (!f.closest || !f.closest('#kapuset') || !('kscode' in f.dataset)) return;
    e.preventDefault();
    var r = await bridge().signInCode(f.c.value).catch(function (x) { return { ok: false, error: x && x.message }; });
    if (!r || !r.ok) { toast(esc((r && r.error) || 'A kód nem küldhető el.'), true); return; }
    toast('Kód elküldve, a belépés folytatódik…');
  });

  window.KapuSettings = {
    html: function () { return '<div id="kapuset" class="stack">' + body() + '</div>'; },
    mount: function () { paint(); refresh(false); },
    signIn: function (engine) { setTimeout(function () { signIn(engine); }, 0); },
    sync: function (cfg) { SS.cfg = Object.assign({}, SS.cfg, cfg); paint(); },
  };
})();
