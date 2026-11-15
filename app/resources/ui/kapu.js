/* Kapu-chat (ADR-014): a Kapu nézet. Középen a beszélgetések listája (a lista oszlopában), jobbra maga a
   beszélgetés a lebegő beviteli dobozzal. Az asztali híd (window.iratkapuDesktop.kapu) futtatja a köröket a
   felhasználó saját AI-előfizetésével; ez a fájl csak megjelenít. Az app.html globális segédeit használja
   (S, M, C, MEU, api, esc, ic, toast, simpleDlg). Kifelé: window.KapuView, window.KapuAvatar. */
(function () {
  'use strict';

  /* Új beszélgetés küldése közben még nem tudjuk az azonosítóját: az ismeretlen beszélgetéshez érkező
     eseményeket a send válaszáig visszatartjuk, és csak azután osztjuk szét. Más (ismert) beszélgetés
     eseményét soha nem tekintjük az újénak. DOM nélkül tesztelhető (desktop/test/kapu-ui.test.js). */
  function createGate() {
    var open = false, buf = [];
    return {
      begin: function () { open = true; buf = []; },
      /* true: mehet tovább most; false: visszatartva */
      offer: function (ev, known) {
        if (!open || !ev || !ev.convId || known(ev.convId)) return true;
        buf.push(ev);
        return false;
      },
      /* A send válasza után: a saját (convId) és a többi visszatartott esemény, érkezési sorrendben. */
      end: function (convId) {
        open = false;
        var b = buf; buf = [];
        return { mine: b.filter(function (e) { return e.convId === convId; }), other: b.filter(function (e) { return e.convId !== convId; }) };
      },
      pending: function () { return open; },
    };
  }
  /* A Kapu videós lejátszója egy avatarhoz (10. lépés). Két <video> elem: az elöl lévő játssza a mostani
     állapot hurkát, a hátsó csak váltáskor kapja meg a következőét (így egy avatar legfeljebb két klipet
     dekódol). Ha a hurok vége AV_WAIT mp-en belül van, megvárja (a klipek ugyanabból a pózból indulnak és
     oda érnek vissza, a vágás nem látszik); különben AV_FADE ms-os áttűnés. A „hello” egyszer fut, utána
     idle. Bármely videó hibájára a Task 7 CSS-változatára (plüss kép, CSS-mozgás) vált. A hold(ok, be)
     szünetelteti (rejtett oldal, képernyőn kívül). env: {doc, setTimeout, clearTimeout, src(állapot),
     poster, plush, onFail}. DOM nélkül tesztelhető (desktop/test/kapu-ui.test.js). */
  var AV_FADE = 250, AV_WAIT = 1.2, AV_READY = 1500;
  var AV_STATES = ['idle', 'listen', 'think', 'talk', 'hello', 'still'];
  function createAvatarPlayer(w, env) {
    var later = env.setTimeout || setTimeout, cancel = env.clearTimeout || clearTimeout;
    var P = { mode: 'video', state: null, target: null };
    var v = [], cur = 0, pend = null, busy = false, fadeT = 0, readyT = 0, holds = {}, dead = false;
    var cls = function (s) { AV_STATES.forEach(function (x) { w.classList.toggle(x, x === s); }); };
    var held = function () { for (var k in holds) if (holds[k]) return true; return false; };
    var play = function (e) {
      if (dead || held() || !e.src) return;
      try { var r = e.play(); if (r && r.catch) r.catch(function () {}); } catch (_) { /* a hibát az error esemény jelzi */ }
    };
    var release = function (e) { try { e.pause(); e.removeAttribute('src'); e.load(); } catch (_) {} };
    var load = function (e, s) {
      e.classList.remove('on');
      e.loop = s !== 'hello';
      e.setAttribute('src', env.src(s));
    };
    function mk() {
      var e = env.doc.createElement('video');
      e.muted = true; e.defaultMuted = true; e.playsInline = true; e.preload = 'auto';
      e.setAttribute('muted', ''); e.setAttribute('playsinline', ''); e.setAttribute('aria-hidden', 'true');
      e.addEventListener('error', function () { if (e.getAttribute ? e.getAttribute('src') : e.src) fail(); });
      e.addEventListener('ended', function () { if (e === v[cur]) ended(); });
      e.addEventListener('timeupdate', function () { if (!w.isConnected) destroy(); });
      w.appendChild(e);
      return e;
    }
    function fail() {
      if (P.mode !== 'video') return;
      P.mode = 'css';
      cancel(fadeT); cancel(readyT); busy = false; pend = null;
      v.forEach(function (e) { release(e); if (e.parentNode) e.parentNode.removeChild(e); });
      v = [];
      w.classList.remove('kav-v');
      var img = env.doc.createElement('img');
      img.src = env.plush; img.alt = ''; img.draggable = false;
      w.appendChild(img);
      cls(P.target || P.state || 'idle');
      if (env.onFail) env.onFail();
    }
    function destroy() {
      if (dead) return;
      dead = true; cancel(fadeT); cancel(readyT); v.forEach(release);
      if (env.onDestroy) env.onDestroy();
    }
    /* a hátsó videó (már betöltve pend-re) elölre kerül; cut: vágás áttűnés nélkül (hurok végén) */
    function swap(cut) {
      var c = v[cur], n = v[1 - cur], s = pend, fired = false;
      busy = true;
      v.forEach(function (e) { e.classList.toggle('cut', !!cut); });
      play(n);
      var go = function () {
        if (fired) return;
        fired = true; cancel(readyT); n.removeEventListener('loadeddata', go);
        if (dead || P.mode !== 'video') return;
        n.classList.add('on'); c.classList.remove('on');
        cur = 1 - cur; P.state = s; pend = null; cls(s);
        play(v[cur]); // ha a váltás alatt változott a hold, ne maradjon álló kocka
        var done = function () {
          release(c); busy = false;
          if (P.target && P.target !== P.state) api.set(P.target);
        };
        if (cut) done(); else fadeT = later(done, AV_FADE);
      };
      /* Ha 1,5 mp alatt sem töltött be a következő klip, nem fedünk fel üres képet: a régi marad, és a
         következő hurokvégen újrapróbáljuk (ha még semmi sem látszik, nincs mit megtartani). */
      var stall = function () {
        if (fired) return;
        if (n.readyState >= 2 || !(c.readyState >= 2)) { go(); return; }
        fired = true; n.removeEventListener('loadeddata', go);
        busy = false;
        c.loop = false;
        if (c.ended) c.currentTime = 0;
        play(c);
      };
      if (n.readyState >= 2) go();
      else { n.addEventListener('loadeddata', go); readyT = later(stall, AV_READY); }
    }
    function ended() {
      if (!pend && P.state === 'hello') { pend = 'idle'; load(v[1 - cur], 'idle'); }
      if (pend) swap(true);
      else { v[cur].currentTime = 0; play(v[cur]); }
    }
    var api = {
      get mode() { return P.mode; },
      get state() { return P.mode === 'video' ? P.state : P.target; },
      set: function (s) {
        if (AV_STATES.indexOf(s) < 0) return;
        if (s === 'still') s = 'idle';
        P.target = s;
        if (P.mode !== 'video') { cls(s); return; }
        if (dead) return;
        if (!v.length) {
          v = [mk(), mk()];
          v[0].poster = env.poster;
          w.classList.add('kav-v');
          load(v[0], s); v[0].classList.add('on'); P.state = s; cls(s); play(v[0]);
          return;
        }
        if (busy) return; // a futó váltás végén a done() hívja újra a P.target-tel
        var c = v[cur];
        if (s === P.state) { if (pend) { pend = null; c.loop = s !== 'hello'; release(v[1 - cur]); } return; } // a várakozó váltás elmarad
        if (P.state === 'hello' && s === 'idle') { pend = 'idle'; load(v[1 - cur], 'idle'); return; } // a köszönés végigfut
        pend = s;
        load(v[1 - cur], s);
        var rem = (c.duration || 0) - (c.currentTime || 0);
        if (c.duration > 0 && rem >= 0 && rem <= AV_WAIT && !held() && !c.paused) c.loop = false; // a hurok végén vált
        else { c.loop = P.state !== 'hello'; swap(!(c.readyState >= 2)); }
      },
      hold: function (key, on) {
        holds[key] = !!on;
        if (dead || P.mode !== 'video') return;
        if (held()) v.forEach(function (e) { try { e.pause(); } catch (_) {} });
        else if (v[cur]) play(v[cur]);
      },
      destroy: destroy,
    };
    return api;
  }

  /* Az élő hang ablaka alatt a többi videós avatar (pl. az üres nézet nagy Kapuja) megáll: takarásban
     van, az IntersectionObserver ezt nem látja. own(w): az ablak saját avatarja-e. */
  function overlayHold(wrappers, on, own) {
    wrappers.forEach(function (w) { if (w.__kp) w.__kp.hold('overlay', on && !own(w)); });
  }

  /* --- modellválasztó: tiszta segédek (desktop/test/kapu-ui.test.js) ---------------------------------
     cat: a híd models() válasza motoronként {options:[{id,label,hint}], default, selected}. */
  var ENG_NAME = { claude: 'Claude', codex: 'ChatGPT', agy: 'Antigravity' };
  /* A beszélgetésé, ha van és választható; különben a motor beállított alapja, végül a kiegyensúlyozott. */
  function pickModel(cat, engine, convModel) {
    var c = cat && engine && cat[engine];
    if (!c) return convModel || null;
    var has = function (id) { return !!id && (c.options || []).some(function (o) { return o.id === id; }); };
    if (has(convModel)) return convModel;
    if (has(c.selected)) return c.selected;
    return c.default || null;
  }
  /* „gpt-6-sol” → „GPT-6 Sol” a katalógusból; ismeretlennél a nyers azonosító szépítve. */
  function modelName(cat, engine, id) {
    if (!id) return '';
    var c = cat && engine && cat[engine];
    var o = c && (c.options || []).filter(function (x) { return x.id === id; })[0];
    if (o) return o.label;
    var g = /^gpt-([\d.]+)-([a-z]+)$/.exec(id);
    if (g) return 'GPT-' + g[1] + ' ' + g[2].charAt(0).toUpperCase() + g[2].slice(1);
    return String(id).replace(/(\d+)-(\d+)(?=$|-)/g, '$1.$2').split('-').filter(Boolean)
      .map(function (w) { return /^(gpt|oss)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  }
  /* A válasz fejléce: „Kapu · ChatGPT · GPT-6 Sol” elemei. */
  function metaParts(cat, engine, model) {
    var p = ['Kapu'];
    if (ENG_NAME[engine]) p.push(ENG_NAME[engine]);
    var m = modelName(cat, engine, model);
    if (m) p.push(m);
    return p;
  }
  /* Élő hangra képes motor (a logó kattintása és a hívásgomb ehhez igazodik). */
  function canVoice(engine) { return engine === 'codex' || engine === 'agy'; }
  function canVoiceOs(engine, os) { return engine === 'codex' || (engine === 'agy' && os !== 'win32'); }
  /* Melyik élő hangos motor indítható: ha az aktuális alkalmas és be van jelentkezve, marad az; különben az
     első bejelentkezett élő hangos motor (ChatGPT, majd Antigravity). Míg a státusz töltődik, csak az eleve
     élő hangra képes aktív motort előlegezzük meg. */
  function voiceTarget(curEngine, engines, os) {
    if (!Array.isArray(engines)) return canVoiceOs(curEngine, os) ? curEngine : null;
    var ok = function (e) {
      if (!canVoiceOs(e, os)) return false;
      var s = engines.filter(function (x) { return x && x.engine === e; })[0];
      return !!(s && s.signedIn);
    };
    if (ok(curEngine)) return curEngine;
    var order = ['codex', 'agy'];
    for (var i = 0; i < order.length; i++) if (ok(order[i])) return order[i];
    return null;
  }
  /* A felső Kapu-logó módja: 'voice', ha Kapu aktív és van összekötött ChatGPT/Antigravity élő hang; különben 'chat'. */
  function logoMode(cfg, engines, os, hasVoice) {
    if (!cfg || !cfg.on || !hasVoice || !Array.isArray(engines)) return 'chat';
    return voiceTarget(cfg.engine, engines, os) ? 'voice' : 'chat';
  }

  /* --- gyors promptok (előre felvett tippek + saját promptok: hozzáadás, szerkesztés, törlés) ------- */
  var DEFAULT_PROMPTS = [
    { id: 'p-week', title: 'Mi jár le a héten?', prompt: 'Mi jár le a héten?' },
    { id: 'p-unread', title: 'Melyik ügyfélnél van olvasatlan irat?', prompt: 'Melyik ügyfélnél van olvasatlan irat?' },
    { id: 'p-rem', title: 'Állítsd az emlékeztetőt 5 és 1 napra.', prompt: 'Állítsd az emlékeztetőt 5 és 1 napra.' },
    { id: 'p-ack', title: 'Átvételre váró iratok', prompt: 'Mely ügyfeleknél van még átvételre váró vagy sürgős irat, amivel ma foglalkozni kell?' },
    { id: 'p-nav', title: 'Hiányzó NAV-bevallások', prompt: 'Nézd meg az adónaptárban, melyik ügyfélnél van hiányzó, elutasított vagy a napokban esedékes NAV-bevallás.' },
    { id: 'p-tasks', title: 'Nyitott feladataim mára', prompt: 'Foglald össze a nyitott és rám kiosztott feladatokat határidő szerinti sorrendben.' },
    { id: 'p-sync', title: 'Tárhelyek állapota', prompt: 'Melyik tárhely szinkronja nem naprakész, és hol kér újrahitelesítést?' },
    { id: 'p-brief', title: 'Napi irodai összefoglaló', prompt: 'Adj egy rövid napi összefoglalót: sürgős bejövő iratok, közelgő határidők és nyitott teendők.' },
  ];
  var PROMPT_ID_RE = /^[a-zA-Z0-9_-]{1,48}$/;
  function resolvePrompts(saved) {
    if (!Array.isArray(saved)) return DEFAULT_PROMPTS.map(function (p) { return { id: p.id, title: p.title, prompt: p.prompt }; });
    var out = [], seen = {};
    for (var i = 0; i < saved.length && out.length < 50; i++) {
      var r = saved[i];
      var id = r && typeof r.id === 'string' ? r.id.trim() : '';
      var title = r && typeof r.title === 'string' ? r.title.trim().slice(0, 120) : '';
      var prompt = r && typeof r.prompt === 'string' ? r.prompt.trim().slice(0, 2000) : '';
      if (!PROMPT_ID_RE.test(id) || !title || !prompt || seen[id]) continue;
      seen[id] = 1;
      out.push({ id: id, title: title, prompt: prompt });
    }
    return out;
  }
  function upsertPrompt(list, entry) {
    var title = entry && typeof entry.title === 'string' ? entry.title.trim().slice(0, 120) : '';
    var prompt = entry && typeof entry.prompt === 'string' ? entry.prompt.trim().slice(0, 2000) : '';
    if (!title || !prompt) return null;
    var cur = resolvePrompts(Array.isArray(list) ? list : null);
    var wantId = entry && typeof entry.id === 'string' ? entry.id.trim() : '';
    if (wantId && cur.some(function (p) { return p.id === wantId; })) {
      return cur.map(function (p) { return p.id === wantId ? { id: p.id, title: title, prompt: prompt } : p; });
    }
    if (cur.length >= 50) return null;
    var id = '';
    do {
      id = 'u-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    } while (cur.some(function (p) { return p.id === id; }));
    return cur.concat([{ id: id, title: title, prompt: prompt }]);
  }
  function removePrompt(list, id) {
    return resolvePrompts(Array.isArray(list) ? list : null).filter(function (p) { return p.id !== id; });
  }

  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) module.exports = { createGate: createGate, createAvatarPlayer: createAvatarPlayer, overlayHold: overlayHold, pickModel: pickModel, modelName: modelName, metaParts: metaParts, canVoice: canVoice, voiceTarget: voiceTarget, logoMode: logoMode, DEFAULT_PROMPTS: DEFAULT_PROMPTS, resolvePrompts: resolvePrompts, upsertPrompt: upsertPrompt, removePrompt: removePrompt };
    return;
  }

  var ENG = { claude: 'Claude', codex: 'ChatGPT', agy: 'Antigravity' };
  var ENG_MARK = { claude: 'C', codex: 'G', agy: 'A' };
  // A motor jelvénye: színes négyzet a szolgáltató fehér jelével (betű csak, ha nincs ilyen jel).
  var engMark = function (e) { return '<span class="keng ' + e + '">' + (ENG_MARK[e] ? '<svg class="pm" aria-hidden="true"><use href="#p-' + e + '"/></svg>' : '') + '</span>'; };
  window.KapuMark = engMark;
  var ORDER = ['claude', 'codex', 'agy'];
  var PLUSH = '/kapu/plush.png';
  var bridge = function () { return window.iratkapuDesktop && window.iratkapuDesktop.kapu; };
  var $q = function (sel, el) { return (el || document).querySelector(sel); };

  /* --- saját ikonok és a gépelés stílusa --------------------------------------------------------- */
  (function inject() {
    if (window.KapuTyping && KapuTyping.CSS) {
      var st = document.createElement('style');
      st.textContent = KapuTyping.CSS;
      document.head.insertBefore(st, document.head.querySelector('link[href="/ui/kapu.css"]'));
    }
    var sym = {
      'k-plus': '<path d="M12 5v14M5 12h14"/>',
      'k-up': '<path d="M12 19V5.5M6 11l6-6 6 6"/>',
      'k-stop': '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
      'k-mic': '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v2.5"/>',
      'k-vol': '<path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z"/><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11"/>',
      'k-voloff': '<path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
      'k-dots': '<circle cx="6" cy="12" r=".9"/><circle cx="12" cy="12" r=".9"/><circle cx="18" cy="12" r=".9"/>',
      'k-edit': '<path d="M15.8 4.6a2.1 2.1 0 013 3L8.3 18.1 4 19.5l1.4-4.3L15.8 4.6z"/><path d="M14.2 6.2l3 3"/>',
      'k-trash': '<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l1 12.5h9l1-12.5"/><path d="M10.2 10.5v6M13.8 10.5v6"/>',
      'k-list': '<path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11"/><circle cx="4.5" cy="6.5" r=".6"/><circle cx="4.5" cy="12" r=".6"/><circle cx="4.5" cy="17.5" r=".6"/>',
      // A szolgáltatók jelei (CLI_MARK): Claude – Simple Icons (CC0), Codex/OpenAI és Antigravity – LobeHub icons (MIT).
      'p-claude': '<path fill-rule="nonzero" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/>',
      'p-codex': '<path fill-rule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"/>',
      'p-agy': '<path fill-rule="evenodd" d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z"/>',
      'k-spark': '<path d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5z"/><path d="M18.5 15.5c.25 1.4.95 2.1 2.3 2.3-1.35.25-2.05.95-2.3 2.3-.25-1.35-.95-2.05-2.3-2.3 1.35-.2 2.05-.9 2.3-2.3z"/>',
      'k-phone': '<path d="M6.6 3.8l2.6-.3 1.5 4.1-1.9 1.4a11.5 11.5 0 005.2 5.2l1.4-1.9 4.1 1.5-.3 2.6a2.2 2.2 0 01-2.3 1.9C10.6 18 6 13.4 4.7 6.1a2.2 2.2 0 011.9-2.3z"/>',
      'k-login': '<path d="M14 4h4a1.5 1.5 0 011.5 1.5v13A1.5 1.5 0 0118 20h-4"/><path d="M4.5 12h10M11 8.5l3.5 3.5-3.5 3.5"/>',
    };
    var svg = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' +
      Object.keys(sym).map(function (k) { return '<symbol id="' + k + '" viewBox="0 0 24 24">' + sym[k] + '</symbol>'; }).join('') + '</defs></svg>';
    var add = function () { document.body.insertAdjacentHTML('beforeend', svg); };
    if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
  })();

  /* --- KapuAvatar: átlátszó videóhurkok (createAvatarPlayer), tartalékként a plüss Kapu CSS-mozgással.
     Videó csak AV_VIDEO_MIN px-től (a 44 px-es üzenet-avatarban és a 68 px-es beállítás-fejlécben a
     klip nem látszana, csak dekódolna), mozgó állapotban, csökkentett mozgás nélkül és ha a gép tud VP9-et;
     egy videóhiba után az app többi avatarja is CSS-es marad. --- */
  var LIVE = new Set();
  var PLAYERS = new Set();
  var avState = 'idle';
  var STATES = AV_STATES;
  var AV_VIDEO_MIN = 96;
  /* Egy videóhiba után a munkamenet végéig CSS-es marad minden új avatar: ugyanaz a hiányzó vagy
     dekódolhatatlan fájl minden avatarnál újra hibázna, és minden mountnál villanna egy félbehagyott videó. */
  var avVideoOff = false;
  function avApply(w, s) {
    if (w.__kp) { w.__kp.set(s); return; }
    STATES.forEach(function (x) { w.classList.toggle(x, x === s); });
  }
  function avCanVideo(size, state) {
    if (avVideoOff || state === 'still' || size < AV_VIDEO_MIN) return false;
    try {
      if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
      return !!document.createElement('video').canPlayType('video/webm; codecs="vp9"');
    } catch (_) { return false; }
  }
  var avIO = typeof IntersectionObserver === 'function' ? new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.target.__kp) e.target.__kp.hold('off', !e.isIntersecting); });
  }) : null;
  var avOverlayOn = function () { return document.body && document.body.classList.contains('kvo-on'); };
  var avOwn = function (w) { return !!(w.closest && w.closest('.kvo')); };
  if (typeof MutationObserver === 'function') {
    var avSyncOverlay = function () { overlayHold(PLAYERS, avOverlayOn(), avOwn); };
    var avWatch = function () { new MutationObserver(avSyncOverlay).observe(document.body, { attributes: true, attributeFilter: ['class'] }); };
    if (document.body) avWatch(); else document.addEventListener('DOMContentLoaded', avWatch);
  }
  document.addEventListener('visibilitychange', function () {
    PLAYERS.forEach(function (w) { if (!w.isConnected) { PLAYERS.delete(w); w.__kp.destroy(); } else w.__kp.hold('doc', document.hidden); });
  });
  var KapuAvatar = {
    /* mount(el, {size, hero, live, state}): live avatar a közös állapotot követi; a régi üzenetek avatarja álló. */
    mount: function (el, opts) {
      opts = opts || {};
      var w = document.createElement('span');
      w.className = 'kav' + (opts.hero ? ' kav-hero' : '');
      if (opts.size) w.style.setProperty('--kav', opts.size + 'px');
      w.setAttribute('aria-hidden', 'true');
      var live = opts.live !== false;
      var st = opts.state || (live ? avState : 'still');
      PLAYERS.forEach(function (x) { if (!x.isConnected) { PLAYERS.delete(x); x.__kp.destroy(); } });
      if (avCanVideo(opts.size || (opts.hero ? 156 : 44), st)) {
        w.__kp = createAvatarPlayer(w, {
          doc: document, src: function (s) { return '/kapu/' + s + '.webm'; }, poster: '/kapu/poster.png', plush: PLUSH,
          onFail: function () { avVideoOff = true; PLAYERS.delete(w); if (avIO) avIO.unobserve(w); },
          onDestroy: function () { PLAYERS.delete(w); LIVE.delete(w); if (avIO) avIO.unobserve(w); },
        });
        PLAYERS.add(w);
        if (document.hidden) w.__kp.hold('doc', true);
        if (avOverlayOn() && !avOwn(el)) w.__kp.hold('overlay', true);
        if (avIO) avIO.observe(w);
      } else {
        var img = document.createElement('img');
        img.src = PLUSH; img.alt = ''; img.draggable = false;
        w.appendChild(img);
      }
      if (live) LIVE.add(w);
      avApply(w, st);
      el.appendChild(w);
      return w;
    },
    set: function (s) {
      if (STATES.indexOf(s) < 0) return;
      avState = s;
      LIVE.forEach(function (w) { if (!w.isConnected) { LIVE.delete(w); if (w.__kp) { PLAYERS.delete(w); w.__kp.destroy(); } } else avApply(w, s); });
    },
    level: function (v) {
      var n = Math.max(0, Math.min(1, Number(v) || 0));
      LIVE.forEach(function (w) { if (w.isConnected) w.style.setProperty('--lv', n.toFixed(3)); });
    },
  };
  window.KapuAvatar = KapuAvatar;

  /* --- állapot ------------------------------------------------------------------------------------ */
  var K = {
    entered: false, root: null, listEl: null,
    cfg: null, cfgErr: '', tokenErr: '',
    engines: null, enginesAt: 0, enginesP: null,
    items: [], listErr: '', prev: {}, q: '',
    convId: null, conv: null,
    running: new Map(), // convId ('' = most induló új beszélgetés) -> {activity}
    errs: {}, // convId -> {code, engine} az utolsó élő hibához
    cards: {}, // confirmId -> kártyaadat
    menu: null, dd: false, mdd: false, models: null, modelsAt: 0, loading: null, cfgAt: 0, cfgBusy: false, typing: null, stick: true, sending: false, savedPh: '',
    gate: createGate(), stopNew: false,
  };
  var DECL_KEY = 'kapu:declined';
  function declined() { try { return JSON.parse(localStorage.getItem(DECL_KEY) || '[]'); } catch (e) { return []; } }
  function decline(id) { try { var a = declined().filter(function (x) { return x !== id; }); a.push(id); localStorage.setItem(DECL_KEY, JSON.stringify(a.slice(-200))); } catch (e) { /* csak ebben a munkamenetben */ } }

  var fold = function (s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); };
  var plain = function (md) {
    var d = document.createElement('div');
    d.innerHTML = window.KapuMd ? KapuMd.render(String(md || '')).replace(/<\/(p|li)>/g, '$&\n') : esc(md);
    return d.textContent.replace(/[ \t]+/g, ' ').trim();
  };
  var firstLine = function (md) { return plain(md).split('\n').map(function (l) { return l.trim(); }).filter(Boolean)[0] || ''; };
  var engOf = function () { return (K.conv && K.conv.engine) || (K.cfg && K.cfg.engine) || null; };
  var engInfo = function (e) { return (K.engines || []).filter(function (x) { return x.engine === e; })[0] || null; };
  var curKey = function () { return K.convId || ''; };
  var isRunning = function () { return K.running.has(curKey()); };

  function when(ms) {
    var d = new Date(ms), now = new Date();
    var day = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((day(now) - day(d)) / 864e5);
    var hm = d.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' });
    if (diff === 0) return hm;
    if (diff === 1) return 'tegnap ' + hm;
    return d.toLocaleDateString('hu-HU', d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function dayLabel(ms) {
    var d = new Date(ms), now = new Date();
    var diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
    return diff === 0 ? 'Ma' : diff === 1 ? 'Tegnap' : diff < 7 ? 'Ezen a héten' : 'Korábban';
  }

  /* --- vázak -------------------------------------------------------------------------------------- */
  function ensureRoot() {
    if (K.root) return K.root;
    var r = document.createElement('div');
    r.className = 'kchat';
    r.innerHTML = '<div class="kv-bg"><i></i><i></i><i></i></div>' +
      '<div class="kv-top"><button type="button" data-klist>' + ic('k-list') + 'Beszélgetések</button></div>' +
      '<div class="kv-scroll"><div class="kv-msgs" role="log" aria-live="polite" aria-label="Beszélgetés Kapuval"></div></div>' +
      '<div class="kcomp"><form class="kcomp-in" autocomplete="off">' +
      '<label class="sr" for="kapuq">Üzenet Kapunak</label>' +
      '<textarea id="kapuq" rows="1" placeholder="Kérdezz bármit Kaputól…" maxlength="8000"></textarea>' +
      '<div class="kcomp-bar"></div></form></div>';
    K.root = r;
    var sc = $q('.kv-scroll', r);
    sc.addEventListener('scroll', function () { K.stick = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 90; });
    if (window.ResizeObserver) new ResizeObserver(function () { if (K.stick) sc.scrollTop = sc.scrollHeight; }).observe($q('.kv-msgs', r));
    var ta = $q('textarea', r);
    var grow = function () { ta.style.height = 'auto'; ta.style.height = Math.min(200, ta.scrollHeight) + 'px'; renderBar(); };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
    ta.addEventListener('focus', function () { if (!isRunning() && !K.speaking) KapuAvatar.set('listen'); });
    ta.addEventListener('blur', function () { if (avState === 'listen') KapuAvatar.set('idle'); });
    $q('form', r).addEventListener('submit', function (e) { e.preventDefault(); submit(); });
    r.addEventListener('click', onRootClick);
    return r;
  }

  function ensureList() {
    var host = document.querySelector('#app .list');
    if (!host) return null;
    if (!K.listEl) {
      var l = document.createElement('div');
      l.id = 'kapulist';
      l.innerHTML = '<button type="button" class="kl-new" data-knew>' + ic('k-plus') + 'Új beszélgetés</button>' +
        '<div class="kl-rows" role="list" aria-label="Beszélgetések Kapuval"></div>' +
        '<div class="kl-foot"></div>';
      l.addEventListener('click', onListClick);
      K.listEl = l;
    }
    if (K.listEl.parentNode !== host) host.appendChild(K.listEl);
    return K.listEl;
  }

  /* --- középső oszlop ----------------------------------------------------------------------------- */
  function renderList() {
    var l = ensureList();
    if (!l) return;
    var rows = $q('.kl-rows', l), foot = $q('.kl-foot', l);
    if (K.listErr) { rows.innerHTML = '<div class="kl-empty">' + esc(K.listErr) + '</div>'; foot.innerHTML = ''; return; }
    var q = fold(K.q).trim();
    var items = K.items.filter(function (it) { return !q || fold(it.title + ' ' + (K.prev[it.id] || '') + ' ' + ENG[it.engine]).indexOf(q) >= 0; });
    var h = '', last = '';
    items.forEach(function (it) {
      var lab = dayLabel(it.updatedAt);
      if (lab !== last) { h += '<div class="kl-day" role="presentation">' + lab + '</div>'; last = lab; }
      var run = K.running.has(it.id);
      h += '<div class="kl-row' + (it.id === K.convId ? ' on' : '') + '" role="listitem">' +
        '<button type="button" class="kl-open" data-kopen="' + esc(it.id) + '"' + (it.id === K.convId ? ' aria-current="true"' : '') + '>' +
        '<b>' + esc(it.title || 'Új beszélgetés') + '</b>' +
        '<span class="kl-meta">' + (run ? '<span class="kl-run" title="Kapu dolgozik"></span>' : '') + '<span class="kl-eng">' + esc(ENG[it.engine] || it.engine) + '</span>·<span>' + esc(when(it.updatedAt)) + '</span></span>' +
        (K.prev[it.id] ? '<span class="kl-prev">' + esc(K.prev[it.id]) + '</span>' : '') + '</button>' +
        '<button type="button" class="kl-more" data-kmore="' + esc(it.id) + '" aria-label="Továbbiak" aria-haspopup="menu" aria-expanded="' + (K.menu === it.id) + '">' + ic('k-dots') + '</button>' +
        (K.menu === it.id ? '<div class="kl-menu" role="menu"><button type="button" role="menuitem" data-kdel="' + esc(it.id) + '">' + ic('k-trash') + 'Beszélgetés törlése</button></div>' : '') +
        '</div>';
    });
    if (!items.length) h = '<div class="kl-empty">' + (K.items.length ? 'Nincs találat a beszélgetések között.' : 'Még nem beszélgettél Kapuval.<br>Kérdezz tőle valamit jobbra!') + '</div>';
    rows.innerHTML = h;
    foot.innerHTML = K.items.length ? '<button type="button" class="kl-clear" data-kclear>' + ic('k-trash') + 'Összes törlése</button>' : '';
  }

  async function refreshList() {
    var b = bridge();
    if (!b) return;
    var r = await b.list().catch(function (e) { return { ok: false, error: e && e.message }; });
    if (!r || !r.ok) { K.listErr = (r && r.error) || 'A beszélgetések most nem tölthetők be.'; renderList(); return; }
    K.listErr = '';
    K.items = r.items || [];
    renderList();
    // Az utolsó válasz első sora: beszélgetésenként egyszer (vagy ha frissült) olvassuk ki.
    var need = K.items.filter(function (it) { return K.prev['@' + it.id] !== it.updatedAt; }).slice(0, 60);
    if (!need.length) return;
    await Promise.all(need.map(function (it) {
      return b.get(it.id).then(function (g) {
        if (!g || !g.ok) return;
        var ms = g.conv.messages || [], k = null, u = null;
        for (var i = ms.length - 1; i >= 0; i--) { if (!k && ms[i].role === 'kapu') k = ms[i]; if (!u && ms[i].role === 'user') u = ms[i]; }
        K.prev[it.id] = k ? firstLine(k.text) : u ? 'Te: ' + firstLine(u.text) : '';
        K.prev['@' + it.id] = it.updatedAt;
      }).catch(function () {});
    }));
    renderList();
  }

  /* --- jobb oszlop: üzenetek ---------------------------------------------------------------------- */
  function metaHtml(engine, model) {
    var p = metaParts(K.models, engine, model);
    return '<div class="km-meta"><b>' + esc(p[0]) + '</b>' + p.slice(1).map(function (x) { return '·<span>' + esc(x) + '</span>'; }).join('') + '</div>';
  }
  var curModel = function () { return pickModel(K.models, engOf(), K.conv && K.conv.model); };

  function sysActs(code, engine) {
    if (code === 'signed_out' || code === 'missing')
      return '<div class="km-acts"><button type="button" class="kbtn pri" data-ksignin="' + esc(engine) + '">' + ic('k-login') + 'Belépés</button>' +
        '<button type="button" class="kbtn sec" data-stab="kapu">Kapu beállításai</button></div>';
    if (code === 'mcp_off')
      return '<div class="km-acts">' + (MEU.role === 'admin' ? '<button type="button" class="kbtn pri" data-stab="ai">AI-kapcsolat bekapcsolása</button>' : '') +
        '<button type="button" class="kbtn sec" data-krenew>Kapu-hozzáférés megújítása</button></div>';
    if (code === 'timeout' || code === 'failed') return '<div class="km-acts"><button type="button" class="kbtn sec" data-kretry>Újrapróbálom</button></div>';
    return '';
  }

  function sysText(m, code) {
    if (code === 'mcp_off') return '<b>Az AI-kapcsolat ki van kapcsolva az irodánál.</b><br>' + (MEU.role === 'admin' ? 'Kapcsold be a Beállítások → AI-kapcsolat lapon, vagy újítsd meg a Kapu-hozzáférést.' : 'Kérd meg az iroda adminját, hogy kapcsolja be. Ha be van kapcsolva, újítsd meg a Kapu-hozzáférést.');
    return esc(m.text);
  }

  function renderChat(opts) {
    opts = opts || {};
    var root = ensureRoot(), box = $q('.kv-msgs', root);
    if (K.typing) { try { K.typing.stop(); } catch (e) { /* már kész */ } K.typing = null; }
    var c = K.conv;
    if (!c || !c.messages || !c.messages.length) { renderEmpty(box); renderBar(); return; }
    var ms = c.messages, lastKapu = -1, lastUser = -1;
    ms.forEach(function (m, i) { if (m.role === 'kapu') lastKapu = i; if (m.role === 'user') lastUser = i; });
    var err = K.errs[c.id];
    var h = ms.map(function (m, i) {
      if (m.role === 'user') return '<div class="km me"><div class="km-card">' + esc(m.text) + '</div></div>';
      if (m.role === 'kapu')
        return '<div class="km kapu" data-i="' + i + '"><span class="kav-slot" data-av="' + (i === lastKapu ? 'live' : 'still') + '"></span><div class="km-col">' + metaHtml(c.engine, m.model) +
          '<div class="km-card"><div class="km-body">' + (window.KapuMd ? KapuMd.render(m.text) : esc(m.text)) + '</div>' +
          (m.confirmId ? '<div class="kc" data-kc="' + esc(m.confirmId) + '" data-act="' + (i > lastUser ? 1 : 0) + '"><span class="mut">Az átállítás betöltése…</span></div>' : '') +
          '</div></div></div>';
      var isLast = i === ms.length - 1, code = isLast && err ? err.code : null;
      return '<div class="km sys"><span class="kav-slot" data-av="still"></span><div class="km-col"><div class="km-card err">' + sysText(m, code) + (code ? sysActs(code, err.engine || c.engine) : '') + '</div></div></div>';
    }).join('');
    if (isRunning()) h += thinkHtml();
    box.innerHTML = h;
    box.querySelectorAll('.kav-slot').forEach(function (s) {
      var live = s.dataset.av === 'live' || s.dataset.av === 'think';
      KapuAvatar.mount(s, { live: live, state: live ? undefined : 'still' });
    });
    if (isRunning()) KapuAvatar.set('think'); else if (!K.speaking && avState !== 'listen') KapuAvatar.set('idle');
    fixChips(box);
    box.querySelectorAll('[data-kc]').forEach(fillCard);
    if (opts.typeLast && lastKapu === ms.length - 1) {
      var body = box.querySelector('.km.kapu[data-i="' + lastKapu + '"] .km-body');
      if (body && window.KapuTyping) {
        K.typing = new KapuTyping.Reveal(body, { onDone: function () { K.typing = null; } });
        K.typing.start();
      }
    }
    K.stick = true;
    var sc = $q('.kv-scroll', root);
    requestAnimationFrame(function () { sc.scrollTop = sc.scrollHeight; });
    renderBar();
  }

  /* Az MCP nyers azonosítókat ad (irat: 12, ügyfél: 3, adónaptár-tétel: o7); a felület m12 / c3 alakot használ. */
  function fixChips(el) {
    el.querySelectorAll('.kchip[data-goto],.kchip[data-cl]').forEach(function (c) {
      var g = c.dataset.goto, cl = c.dataset.cl;
      if (cl && /^\d+$/.test(cl)) c.dataset.cl = 'c' + cl;
      if (!g) return;
      if (/^o\d+$/.test(g)) {
        var ob = (typeof OBLIGATIONS !== 'undefined' ? OBLIGATIONS : []).filter(function (o) { return 'o' + o.id === g; })[0];
        if (ob && ob.receiptMid) c.dataset.goto = ob.receiptMid;
        else if (ob) { delete c.dataset.goto; c.dataset.area = 'upo'; }
      } else if (/^\d+$/.test(g)) c.dataset.goto = 'm' + g;
    });
  }

  function thinkHtml() {
    var r = K.running.get(curKey()) || {};
    return '<div class="km kapu think"><span class="kav-slot" data-av="think"></span><div class="km-col">' + metaHtml(engOf(), curModel()) +
      '<div class="km-think"><span class="kdots" aria-hidden="true"><i></i><i></i><i></i></span><span class="kact">' + esc(r.activity || 'Kapu gondolkodik…') + '</span></div></div></div>';
  }

  var lsPrompts = function () {
    try { var v = localStorage.getItem('kapu.prompts'); return v ? JSON.parse(v) : null; } catch (_) { return null; }
  };
  function curPrompts() {
    if (K.cfg && Array.isArray(K.cfg.prompts)) return resolvePrompts(K.cfg.prompts);
    var ls = lsPrompts();
    return resolvePrompts(Array.isArray(ls) ? ls : null);
  }
  function sugHtml() {
    return '<div class="ke-sug">' + curPrompts().map(function (p) {
      var tip = p.prompt !== p.title ? ' title="' + esc(p.prompt) + '"' : '';
      return '<div class="ke-p">' +
        '<button type="button" class="ke-pb" data-ksug="' + esc(p.id) + '"' + tip + '>' + esc(p.title) + '</button>' +
        '<span class="ke-pa">' +
          '<button type="button" class="ke-pi" data-ksedit="' + esc(p.id) + '" aria-label="Szerkesztés: ' + esc(p.title) + '" title="Szerkesztés">' + ic('k-edit') + '</button>' +
          '<button type="button" class="ke-pi del" data-ksdel="' + esc(p.id) + '" aria-label="Törlés: ' + esc(p.title) + '" title="Törlés">' + ic('k-trash') + '</button>' +
        '</span></div>';
    }).join('') +
      '<button type="button" class="ke-add" data-ksadd aria-label="Saját gyors prompt hozzáadása" title="Saját gyors prompt hozzáadása">' + ic('k-plus') + '</button>' +
    '</div>';
  }
  function syncSug() {
    var s = K.root && $q('.ke-sug', K.root);
    if (s) s.outerHTML = sugHtml();
  }

  function renderEmpty(box) {
    var b = bridge(), c = K.cfg, card = '';
    if (!b) card = '<div class="ke-card">Kapu csak a KapuMail asztali alkalmazásában érhető el.</div>';
    else if (K.cfgErr) card = '<div class="ke-card">' + esc(K.cfgErr) + '</div>';
    else if (c && !c.on) card = '<div class="ke-card">Kapu még nincs bekapcsolva ezen a gépen. A saját Claude-, ChatGPT- vagy Antigravity-előfizetéseddel válaszol.<div class="km-acts"><button type="button" class="kbtn pri" data-kon>Bekapcsolom</button><button type="button" class="kbtn sec" data-stab="kapu">Kapu beállításai</button></div></div>';
    else if (K.tokenErr) card = '<div class="ke-card">' + esc(K.tokenErr) + '<div class="km-acts"><button type="button" class="kbtn sec" data-krenew>Újrapróbálom</button></div></div>';
    else if (c && !c.engine) card = '<div class="ke-card">Válaszd ki, melyik AI-val beszéljen Kapu: lépj be a Kapu beállításainál, vagy válassz lent a motor-gombbal.<div class="km-acts"><button type="button" class="kbtn pri" data-stab="kapu">Kapu beállításai</button></div></div>';
    box.innerHTML = '<div class="ke"><span class="kav-slot"></span><h2>Szia, Kapu vagyok. Miben segítsek?</h2>' +
      '<p>Kérdezz az irodád irataitól a határidőkön át az ügyfelekig. A beállításokat is átállítom, ha jóváhagyod.</p>' +
      (card || callHtml() + sugHtml()) + '</div>';
    KapuAvatar.mount($q('.kav-slot', box), { hero: true, live: true, state: 'hello' });
    avState = 'idle';
  }

  var VOICE_UNAVAIL = 'Hangon ChatGPT-vel vagy Antigravityvel beszélhetsz.';
  var voiceReady = function () { return !!(window.KapuVoice && typeof KapuVoice.start === 'function'); };
  var curOs = function () { return (document.documentElement && document.documentElement.getAttribute('data-os')) || ''; };

  /* Az üres nézet hívásgombja: ha van összekötött élő hangos motor, aktív (és rákattintva átvált rá); különben letiltva a magyarázattal. */
  function callHtml() {
    var v = voiceTarget(engOf(), K.engines, curOs()), ok = !!v && voiceReady();
    var tip = !voiceReady() ? 'Élő beszélgetés – hamarosan' : !v ? VOICE_UNAVAIL : '';
    return '<div class="kcall-w"><button type="button" class="kcall" data-kcall aria-disabled="' + !ok + '"' + (tip ? ' aria-describedby="kcall-tip"' : '') + '>' +
      '<span class="kcall-i">' + ic('k-phone') + '</span>Beszéljünk élőszóban</button>' +
      (tip ? '<small id="kcall-tip">' + esc(tip) + '</small>' : '') + '</div>';
  }
  function syncCall() {
    var w = K.root && $q('.kcall-w', K.root);
    if (w) w.outerHTML = callHtml();
  }

  /* jóváhagyó kártya: a szervertől kérdezzük (lejárt, jóváhagyott?), a felhasználó munkamenetével */
  var show = function (v) {
    if (v === null || v === undefined || v === '') return '–';
    if (v === true) return 'be'; if (v === false) return 'ki';
    if (Array.isArray(v)) return v.length ? v.map(show).join(', ') : '–';
    if (typeof v === 'object') return Object.keys(v).map(function (k) { return k + ': ' + show(v[k]); }).join(', ');
    return String(v);
  };
  async function fillCard(el) {
    var id = el.dataset.kc, d = K.cards[id];
    if (!d) {
      try {
        var r = await fetch('/api/kapu/confirm/' + encodeURIComponent(id), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        d = r.ok ? await r.json() : { missing: true };
      } catch (e) { d = { missing: true, offline: true }; }
      if (!d.offline) K.cards[id] = d;
    }
    if (!el.isConnected) return;
    if (d.missing) { el.className = 'kc exp'; el.innerHTML = '<span class="mut">Ez az átállítási kérés már nem érhető el.</span>'; return; }
    var expired = !d.approved && new Date(d.expires_at).getTime() <= Date.now();
    d = Object.assign({}, d, { declined: !d.approved && declined().indexOf(id) >= 0 });
    var act = el.dataset.act === '1' && !expired && !d.approved && !d.declined && !isRunning();
    el.className = 'kc' + (expired ? ' exp' : '');
    el.innerHTML = '<h5>' + ic('k-spark') + 'Ezt állítanám át:</h5><ul>' + (d.summary || []).map(function (s) {
      return '<li><span class="l">' + esc(s.label) + ':</span><s>' + esc(show(s.from)) + '</s><span class="ar">→</span><span class="to">' + esc(show(s.to)) + '</span></li>';
    }).join('') + '</ul>' +
      (d.approved ? '<span class="kc-st ok">' + ic('check') + 'Jóváhagytad</span>'
        : d.declined ? '<span class="kc-st no">Elvetetted</span>'
        : expired ? '<span class="kc-st no">Lejárt – kérd újra Kaputól.</span>'
          : act ? '<div class="km-acts"><button type="button" class="kbtn pri" data-kgo="' + esc(id) + '">' + ic('check') + 'Mehet</button><button type="button" class="kbtn sec" data-kno="' + esc(id) + '">Mégse</button></div>'
            : '<span class="kc-st no">Nem hagytad jóvá</span>');
  }

  /* --- beviteli doboz ----------------------------------------------------------------------------- */
  function renderBar() {
    var root = K.root;
    if (!root) return;
    var bar = $q('.kcomp-bar', root), ta = $q('textarea', root);
    var e = engOf(), info = e ? engInfo(e) : null, cfg = K.cfg || {};
    var running = isRunning(), has = ta.value.trim().length > 0;
    var voice = voiceReady(), vEng = voiceTarget(e, K.engines, curOs());
    var micOff = !(cfg && cfg.on) || !vEng || !voice;
    var micTip = !voice ? 'Élő beszélgetés – hamarosan' : !vEng ? VOICE_UNAVAIL : vEng !== e ? 'Élő beszélgetés (' + ENG[vEng] + ')' : 'Élő beszélgetés Kapuval';
    var engLabel = e ? ENG[e] : 'Motor választása';
    var dd = '';
    if (K.dd) {
      dd = '<div class="kdd" role="menu">' + ORDER.map(function (x) {
        var s = engInfo(x), ok = s && s.signedIn;
        var sub = !K.engines ? 'Ellenőrzés…' : !s || !s.installed ? 'Nincs telepítve' : !s.signedIn ? 'Nincs bejelentkezve – belépés a beállításoknál' : 'Bejelentkezve' + (s.account ? ': ' + s.account.charAt(0).toUpperCase() + s.account.slice(1) : '');
        return '<button type="button" role="menuitemradio" aria-checked="' + (x === e) + '" data-keng="' + x + '"' + (ok || (s && s.installed) ? '' : ' disabled') + '>' +
          engMark(x) + '<span>' + ENG[x] + '<small>' + esc(sub) + '</small></span>' + (x === e ? '<span class="ck">' + ic('check') + '</span>' : '') + '</button>';
      }).join('') + '<div class="kdd-f"><button type="button" data-stab="kapu">' + ic('gear') + 'Kapu beállításai</button></div></div>';
    }
    bar.innerHTML =
      '<button type="button" class="kchp eng" data-kdd aria-haspopup="menu" aria-expanded="' + K.dd + '" title="' + (info && !info.signedIn ? 'Ez a motor nincs bejelentkezve' : 'Motor választása') + '">' +
      (e ? engMark(e) : ic('k-spark')) + '<span class="lbl">' + esc(engLabel) + '</span>' + ic('chev', 'cv') + '</button>' + dd +
      modelChip(e) +
      '<span class="sp"></span>' +
      '<button type="button" class="kib" data-kread aria-pressed="' + (cfg.readAloud === true) + '" title="' + (cfg.readAloud ? 'Felolvasás bekapcsolva – kattints a kikapcsoláshoz' : 'Válaszok felolvasása') + '" aria-label="Válaszok felolvasása">' + ic(cfg.readAloud ? 'k-vol' : 'k-voloff') + '</button>' +
      '<button type="button" class="kib" data-kmic aria-disabled="' + micOff + '" title="' + esc(micTip) + '" aria-label="Élő beszélgetés">' + ic('k-mic') + '</button>' +
      '<button type="button" class="kib" data-stab="kapu" title="Kapu beállításai" aria-label="Kapu beállításai">' + ic('gear') + '</button>' +
      (running
        ? '<button type="button" class="ksend stop" data-kstop title="Leállítás" aria-label="Válasz leállítása">' + ic('k-stop') + '</button>'
        : '<button type="submit" class="ksend" title="Küldés (Enter)" aria-label="Küldés"' + (has && !K.sending ? '' : ' disabled') + '>' + ic('k-up') + '</button>');
    syncCall();
  }

  /* A motor melletti modellválasztó: kisebbtől/gyorsabbtól a nagyobbig/okosabbig, rövid jelzéssel. */
  function modelChip(e) {
    var c = e && K.models && K.models[e];
    if (!c || !(c.options || []).length) return '';
    var cur = curModel(), name = modelName(K.models, e, cur);
    var h = '<span class="kmw"><button type="button" class="kchp mdl" data-kmdd aria-haspopup="menu" aria-expanded="' + K.mdd + '" title="Modell választása" aria-label="Modell: ' + esc(name) + '">' +
      '<span class="lbl">' + esc(name) + '</span>' + ic('chev', 'cv') + '</button>';
    if (K.mdd) {
      h += '<div class="kdd kdd-m" role="menu" aria-label="' + esc(ENG[e]) + ' modelljei"><div class="kdd-h">' + esc(ENG[e]) + ' · modell</div>' + c.options.map(function (o) {
        return '<button type="button" role="menuitemradio" aria-checked="' + (o.id === cur) + '" data-kmodel="' + esc(o.id) + '">' +
          '<span>' + esc(o.label) + (o.hint ? '<small>' + esc(o.hint) + (o.id === c.default ? ' · alap' : '') + '</small>' : '') + '</span>' +
          (o.id === cur ? '<span class="ck">' + ic('check') + '</span>' : '') + '</button>';
      }).join('') + '</div>';
    }
    return h + '</span>';
  }

  async function chooseModel(id) {
    var b = bridge(), e = engOf();
    K.mdd = false;
    if (!b || !e) { renderBar(); return; }
    if (K.convId && K.conv && K.conv.id === K.convId) {
      var r = await b.setModel(K.convId, id).catch(function (x) { return { ok: false, error: x && x.message }; });
      if (!r || !r.ok) { toast(esc((r && r.error) || 'A modell nem állítható át.'), true); renderBar(); return; }
      K.conv.model = id;
    } else if (K.conv) K.conv.model = id;
    // a motor alapja is ez lesz (új beszélgetés ezzel indul)
    if (await setCfg({ model: { engine: e, id: id } })) { if (K.models && K.models[e]) K.models[e].selected = id; }
    renderBar();
  }

  async function loadModels(force) {
    var b = bridge();
    if (!b || typeof b.models !== 'function') return;
    if (!force && K.models && Date.now() - K.modelsAt < 120000) return;
    var r = await b.models().catch(function () { return null; });
    if (r && r.ok && r.engines) { K.models = r.engines; K.modelsAt = Date.now(); }
  }

  /* Élő beszélgetés indítása (mikrofon, hívásgomb, logó): ha más motoron állunk, átvált az elérhető élő hangos motorra. */
  function startVoice(engine) {
    if (!voiceReady()) return;
    stopSpeech();
    var from = K.convId;
    KapuVoice.start({
      engine: engine || engOf(), convId: from,
      // Az élő beszélgetés köreit a chat is mutassa: a (közben esetleg létrejött) beszélgetés újratöltve.
      onClose: function (cid) {
        if (cid && S.area === 'kapu' && (K.convId === cid || (!from && !K.convId))) openConv(cid);
        refreshList();
      },
    });
  }

  async function activateVoice() {
    if (!voiceReady()) { toast('Az élő beszélgetés most nem érhető el.'); return; }
    if (!K.cfg || !K.cfg.on) { toast('Előbb kapcsold be a Kaput.', true); return; }
    if (!K.engines) await loadEngines();
    var cur = engOf(), target = voiceTarget(cur, K.engines, curOs());
    if (!target) {
      renderBar();
      toast(VOICE_UNAVAIL);
      return;
    }
    if (K.cfg.engine !== target && !(await setCfg({ engine: target }))) return;
    if (cur !== target) {
      await loadModels();
      if (K.conv && K.conv.engine !== target && (K.convId || (K.conv.messages && K.conv.messages.length))) newConv();
      else {
        if (K.conv) { K.conv.engine = target; K.conv.model = curModel(); }
        if (K.root && !$q('.kcall-w', K.root) && (!K.conv || !K.conv.messages || !K.conv.messages.length)) renderChat();
        else renderBar();
      }
      toast('Átváltva ' + ENG[target] + '-motorra az élő beszélgetéshez.');
    }
    if (!KapuVoice.active()) startVoice(target);
  }

  /* --- küldés és események ------------------------------------------------------------------------ */
  async function submit(text) {
    var ta = $q('textarea', ensureRoot());
    var q = (text == null ? ta.value : text).trim();
    var b = bridge();
    if (!q || !b || isRunning() || K.sending) return;
    stopSpeech();
    var cfg = K.cfg || {};
    if (!cfg.on) { toast('Előbb kapcsold be a Kaput.', true); return; }
    if (!K.convId && !cfg.engine) { toast('Válaszd ki, melyik AI-val beszéljen Kapu.', true); K.dd = true; renderBar(); return; }
    var convId = K.convId;
    if (!K.conv) K.conv = { id: null, title: q.slice(0, 60), engine: cfg.engine, model: curModel(), messages: [] };
    var conv = K.conv;
    conv.messages.push({ role: 'user', text: q, at: Date.now() });
    delete K.errs[convId || ''];
    if (text == null) { ta.value = ''; ta.style.height = 'auto'; }
    K.sending = true;
    K.stopNew = false;
    if (!convId) K.gate.begin();
    K.running.set(convId || '', { activity: '' });
    renderChat();
    var r = await b.send({ convId: convId, text: q, model: curModel() }).catch(function (e) { return { ok: false, error: e && e.message }; });
    K.sending = false;
    var held = !convId ? K.gate.end(r && r.ok ? r.convId : null) : { mine: [], other: [] };
    held.other.forEach(onEvent);
    if (!r || !r.ok) {
      K.running.delete(convId || '');
      conv.messages.pop();
      if (K.conv === conv && !conv.messages.length && !convId) K.conv = null;
      if (text == null && !ta.value) ta.value = q;
      renderChat();
      toast(esc((r && r.error) || 'Kapu most nem érhető el.'), true);
      return;
    }
    if (!convId) {
      var st = K.running.get('');
      K.running.delete('');
      conv.id = r.convId;
      if (K.conv === conv) K.convId = r.convId; // közben nem váltott másik beszélgetésre
      if (K.stopNew) {
        // A leállítás a send válasza előtt jött: most, hogy ismert az azonosító, megszakítjuk.
        K.stopNew = false;
        b.cancel(r.convId).catch(function () {});
      } else {
        K.running.set(r.convId, st || { activity: '' });
        held.mine.forEach(onEvent);
      }
    }
    renderBar();
    refreshList();
  }

  async function onEvent(ev) {
    if (!ev || !ev.convId) return;
    var id = ev.convId;
    if (!K.gate.offer(ev, function (x) { return x === K.convId || K.running.has(x) || K.items.some(function (it) { return it.id === x; }); })) return;
    if (ev.type === 'activity') {
      var r = K.running.get(id);
      if (r) { r.activity = String(ev.text || ''); var a = K.root && K.root.querySelector('.km.think .kact'); if (a && id === K.convId) a.textContent = r.activity || 'Kapu gondolkodik…'; }
      return;
    }
    if (ev.type !== 'final' && ev.type !== 'error') return;
    K.running.delete(id);
    if (ev.type === 'error') K.errs[id] = { code: ev.code, engine: (K.conv && K.conv.id === id && K.conv.engine) || null };
    if (id === K.convId && S.area === 'kapu') {
      await openConv(id, { typeLast: ev.type === 'final', keep: true });
      if (ev.type === 'final' && K.cfg && K.cfg.readAloud) speak(ev.text);
    } else if (id === K.convId) {
      await openConv(id, { keep: true, quiet: true });
    }
    renderList();
    refreshList();
  }

  async function openConv(id, opts) {
    opts = opts || {};
    var b = bridge();
    if (!b) return;
    if (!opts.keep) { stopSpeech(); K.convId = id; }
    var r = await b.get(id).catch(function () { return null; });
    if (K.convId !== id) return;
    if (!r || !r.ok) { toast(esc((r && r.error) || 'A beszélgetés nem tölthető be.'), true); K.convId = null; K.conv = null; }
    else K.conv = r.conv;
    if (!opts.quiet) renderChat({ typeLast: opts.typeLast });
    renderList();
  }

  function newConv() {
    stopSpeech();
    K.convId = null; K.conv = null; K.menu = null;
    renderChat();
    renderList();
    var ta = K.root && $q('textarea', K.root);
    if (ta) ta.focus();
  }

  /* --- felolvasás --------------------------------------------------------------------------------- */
  var pulse = 0;
  function speak(md) {
    if (!('speechSynthesis' in window)) return;
    if (window.KapuVoice && KapuVoice.active()) return; // élő beszélgetésben Kapu a saját hangján válaszol
    var text = plain(md).replace(/\n+/g, '. ');
    if (!text) return;
    try { speechSynthesis.cancel(); } catch (e) { /* nincs mit leállítani */ }
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'hu-HU';
    var v = (speechSynthesis.getVoices() || []).filter(function (x) { return /^hu/i.test(x.lang); })[0];
    if (v) u.voice = v;
    u.onstart = function () { K.speaking = true; KapuAvatar.set('talk'); };
    u.onboundary = function () { KapuAvatar.level(0.9); clearTimeout(pulse); pulse = setTimeout(function () { KapuAvatar.level(0.15); }, 170); };
    u.onend = u.onerror = function () { K.speaking = false; KapuAvatar.level(0); if (avState === 'talk') KapuAvatar.set(isRunning() ? 'think' : 'idle'); };
    speechSynthesis.speak(u);
  }
  function stopSpeech() {
    if (K.speaking || ('speechSynthesis' in window && speechSynthesis.speaking)) { try { speechSynthesis.cancel(); } catch (e) { /* már leállt */ } }
    K.speaking = false;
    KapuAvatar.level(0);
    if (avState === 'talk') KapuAvatar.set('idle');
  }

  /* --- kattintások -------------------------------------------------------------------------------- */
  async function setCfg(patch) {
    var r = await bridge().setConfig(patch).catch(function (e) { return { ok: false, error: e && e.message }; });
    if (!r || !r.ok) { toast(esc((r && r.error) || 'A beállítás nem menthető.'), true); return false; }
    K.cfg = Object.assign({}, K.cfg, r);
    if (patch && patch.prompts === null && !('prompts' in r)) delete K.cfg.prompts;
    if (window.KapuSettings) KapuSettings.sync(K.cfg);
    syncRail();
    return true;
  }

  async function savePrompts(next) {
    if (bridge()) {
      if (!(await setCfg({ prompts: next }))) return false;
    }
    try { localStorage.setItem('kapu.prompts', JSON.stringify(next)); } catch (_) {}
    syncSug();
    return true;
  }

  function openPromptModal(id) {
    var item = id ? curPrompts().filter(function (p) { return p.id === id; })[0] : null;
    if (id && !item) return;
    simpleDlg('<h3>' + (item ? 'Gyors prompt szerkesztése' : 'Saját gyors prompt hozzáadása') + '</h3>' +
      '<p>A cím jelenik meg gombként a nyitóképernyőn, rákattintva pedig a megadott promptot küldi el Kapunak.</p>' +
      '<form class="form kp-form" data-kpform data-kpid="' + esc(item ? item.id : '') + '">' +
        '<label><span>Cím</span><input name="title" required maxlength="120" value="' + esc(item ? item.title : '') + '" placeholder="pl. Heti ÁFA-ellenőrzés"></label>' +
        '<label><span>Prompt</span><textarea name="prompt" required maxlength="2000" rows="4" placeholder="Írd le, mit kérdezzen vagy tegyen Kapu…">' + esc(item ? item.prompt : '') + '</textarea></label>' +
        '<div class="acts" style="justify-content:flex-end"><button type="button" class="btn ghost" data-dlgx>Mégse</button><button type="submit" class="btn">Mentés</button></div>' +
      '</form>');
    var inp = document.querySelector('#dlg [data-kpform] input[name="title"]');
    if (inp) { inp.focus(); if (item) inp.select(); }
  }

  function openDeletePromptModal(id) {
    var item = curPrompts().filter(function (p) { return p.id === id; })[0];
    if (!item) return;
    simpleDlg('<h3>Gyors prompt törlése?</h3>' +
      '<p>Biztosan törlöd a(z) „<b>' + esc(item.title) + '</b>” gyors promptot?</p>' +
      '<div class="acts" style="justify-content:flex-end"><button type="button" class="btn ghost" data-dlgx>Mégse</button><button type="button" class="btn" data-ksdelok="' + esc(item.id) + '" style="background:var(--red)">Törlés</button></div>');
  }

  async function turnOn() {
    if (!(await setCfg({ on: true }))) return;
    var t = await bridge().ensureToken().catch(function (e) { return { ok: false, error: e && e.message }; });
    K.tokenErr = t && t.ok ? '' : (t && t.error) || 'A Kapu-hozzáférés most nem kérhető.';
    if (!K.tokenErr) K.cfg.hasToken = true;
    if (!K.cfg.engine) {
      await loadEngines();
      var first = (K.engines || []).filter(function (x) { return x.signedIn; })[0];
      if (first) await setCfg({ engine: first.engine });
    }
    await loadModels(true);
    renderChat();
  }

  async function onRootClick(e) {
    var t = e.target.closest('button');
    if (!t) {
      if ((K.dd || K.mdd) && !e.target.closest('.kdd')) { K.dd = false; K.mdd = false; renderBar(); }
      if (e.target.closest('.kv-msgs')) { stopSpeech(); if (K.typing) K.typing.stop(); }
      return;
    }
    var d = t.dataset;
    if (!('kdd' in d) && !('keng' in d) && K.dd && !t.closest('.kdd')) { K.dd = false; renderBar(); }
    if (!('kmdd' in d) && !d.kmodel && K.mdd) { K.mdd = false; renderBar(); }
    if ('kmdd' in d) { K.mdd = !K.mdd; K.dd = false; renderBar(); if (K.mdd) loadModels().then(function () { if (K.mdd) renderBar(); }); return; }
    if (d.kmodel) { chooseModel(d.kmodel); return; }
    if ('kcall' in d || 'kmic' in d) {
      await activateVoice();
      return;
    }
    if ('kdd' in d) { K.dd = !K.dd; K.mdd = false; renderBar(); if (K.dd && Date.now() - K.enginesAt > 30000) loadEngines().then(renderBar); return; }
    if (d.keng) {
      K.dd = false;
      var s = engInfo(d.keng);
      if (s && !s.signedIn) { renderBar(); goSettings(d.keng); return; }
      if (await setCfg({ engine: d.keng })) {
        await loadModels();
        if (K.conv && K.conv.engine !== d.keng && (K.convId || (K.conv.messages && K.conv.messages.length))) { newConv(); toast('Új beszélgetés ' + ENG[d.keng] + '-motorral.'); }
        else { if (K.conv) { K.conv.engine = d.keng; K.conv.model = curModel(); } renderBar(); }
      }
      return;
    }
    if ('kread' in d) { if (await setCfg({ readAloud: !(K.cfg && K.cfg.readAloud) })) { if (!K.cfg.readAloud) stopSpeech(); renderBar(); } return; }
    if ('kstop' in d) {
      var key = curKey();
      if (K.convId) await bridge().cancel(K.convId).catch(function () {});
      else if (K.sending) K.stopNew = true;
      K.running.delete(key);
      if (K.conv) K.conv.messages.push({ role: 'system', text: 'Leállítottad a választ.', at: Date.now(), local: true });
      KapuAvatar.set('idle');
      renderChat(); renderList();
      return;
    }
    if ('ksadd' in d) { openPromptModal(null); return; }
    if (d.ksedit) { openPromptModal(d.ksedit); return; }
    if (d.ksdel) { openDeletePromptModal(d.ksdel); return; }
    if ('ksug' in d) {
      var sp = d.ksug && curPrompts().filter(function (p) { return p.id === d.ksug; })[0];
      submit(sp ? sp.prompt : t.textContent);
      return;
    }
    if ('kon' in d) { t.disabled = true; await turnOn(); return; }
    if ('krenew' in d) {
      t.disabled = true;
      var r = await bridge().ensureToken({ renew: true }).catch(function (x) { return { ok: false, error: x && x.message }; });
      K.tokenErr = r && r.ok ? '' : (r && r.error) || 'A Kapu-hozzáférés most nem kérhető.';
      if (!K.tokenErr) { toast('Kapu-hozzáférés megújítva.'); if (K.conv) delete K.errs[K.conv.id]; }
      else toast(esc(K.tokenErr), true);
      renderChat();
      return;
    }
    if ('kretry' in d) {
      var ms = (K.conv && K.conv.messages) || [], last = null;
      for (var i = ms.length - 1; i >= 0; i--) if (ms[i].role === 'user') { last = ms[i].text; break; }
      if (last) submit(last);
      return;
    }
    if (d.ksignin) { goSettings(d.ksignin); return; }
    if (d.kgo) {
      t.disabled = true;
      var id = d.kgo;
      try { var card = await api('POST', 'kapu/confirm/' + encodeURIComponent(id)); K.cards[id] = card; }
      catch (x) { delete K.cards[id]; K.root.querySelectorAll('[data-kc="' + CSS.escape(id) + '"]').forEach(fillCard); return; }
      K.root.querySelectorAll('[data-kc="' + CSS.escape(id) + '"]').forEach(fillCard);
      submit('Jóváhagytam.');
      return;
    }
    if (d.kno) {
      // Nem kérdezünk vissza a modelltől: a kártya elvetettnek látszik (ezen a gépen megjegyezve), a kérés 10 perc múlva lejár.
      decline(d.kno);
      K.root.querySelectorAll('[data-kc="' + CSS.escape(d.kno) + '"]').forEach(fillCard);
      return;
    }
    if ('klist' in d) { document.getElementById('app').classList.toggle('klist'); return; }
  }

  function goSettings(engine) {
    S.area = 'settings'; S.stab = 'kapu';
    render();
    if (engine && window.KapuSettings) KapuSettings.signIn(engine);
  }

  async function onListClick(e) {
    var t = e.target.closest('button');
    var d = t ? t.dataset : {};
    if (K.menu && !d.kmore && !d.kdel) { K.menu = null; renderList(); if (!t) return; }
    if (!t) return;
    if ('knew' in d) { document.getElementById('app').classList.remove('klist'); newConv(); return; }
    if (d.kopen) { document.getElementById('app').classList.remove('klist'); if (d.kopen !== K.convId) openConv(d.kopen); return; }
    if (d.kmore) { K.menu = K.menu === d.kmore ? null : d.kmore; renderList(); var m = K.listEl.querySelector('.kl-menu button'); if (m) m.focus(); return; }
    if (d.kdel) {
      var id = d.kdel;
      K.menu = null;
      var r = await bridge().remove(id).catch(function (x) { return { ok: false, error: x && x.message }; });
      if (!r || r.ok === false) { toast(esc((r && r.error) || 'A törlés nem sikerült.'), true); return; }
      K.running.delete(id); delete K.errs[id]; delete K.prev[id];
      if (id === K.convId) newConv();
      toast('Beszélgetés törölve.');
      refreshList();
      return;
    }
    if ('kclear' in d) {
      simpleDlg('<h3>Összes beszélgetés törlése?</h3><p>Minden Kapuval folytatott beszélgetésed törlődik erről a gépről. Ez nem vonható vissza.</p>' +
        '<div class="acts"><button class="btn ghost" data-dlgx>Mégse</button><button class="btn" data-kclearok style="background:var(--red)">Összes törlése</button></div>');
    }
  }

  document.addEventListener('submit', async function (e) {
    var f = e.target;
    if (!f || !f.dataset || !('kpform' in f.dataset)) return;
    e.preventDefault();
    var title = ((f.elements.title && f.elements.title.value) || '').trim();
    var prompt = ((f.elements.prompt && f.elements.prompt.value) || '').trim();
    if (!title || !prompt) { toast('Add meg a címet és a promptot is.', true); return; }
    var editId = f.dataset.kpid || '';
    var cur = curPrompts();
    if (!editId && cur.length >= 50) { toast('Legfeljebb 50 gyors prompt menthető.', true); return; }
    var next = upsertPrompt(cur, { id: editId, title: title, prompt: prompt });
    if (!next) { toast('Add meg a címet és a promptot is.', true); return; }
    var btn = f.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    var saved = await savePrompts(next);
    if (btn) btn.disabled = false;
    if (!saved) return;
    var dl = document.getElementById('dlg');
    if (dl && dl.open) dl.close();
    toast(editId ? 'Gyors prompt frissítve.' : 'Saját gyors prompt mentve.');
  });

  document.addEventListener('click', async function (e) {
    var delP = e.target.closest('[data-ksdelok]');
    if (delP) {
      delP.disabled = true;
      var next = removePrompt(curPrompts(), delP.dataset.ksdelok);
      var saved = await savePrompts(next);
      delP.disabled = false;
      if (!saved) return;
      var dlg = document.getElementById('dlg');
      if (dlg && dlg.open) dlg.close();
      toast('Gyors prompt törölve.');
      return;
    }
    var ok = e.target.closest('[data-kclearok]');
    if (!ok) return;
    var dl = document.getElementById('dlg');
    if (dl && dl.open) dl.close();
    var r = await bridge().clear().catch(function (x) { return { ok: false, error: x && x.message }; });
    if (!r || r.ok === false) { toast(esc((r && r.error) || 'A törlés nem sikerült.'), true); return; }
    K.running.clear(); K.errs = {}; K.prev = {};
    newConv();
    toast('Minden beszélgetés törölve.');
    refreshList();
  });

  // Hivatkozás-chip: ha a cél nincs a betöltött adatok közt, ne vigyen sehová, hanem szóljon.
  document.addEventListener('click', function (e) {
    var c = e.target.closest('.kchat .kchip');
    if (!c) return;
    var d = c.dataset, msg = '';
    if (d.goto && !M.some(function (m) { return String(m.id) === d.goto; })) msg = 'Ez az irat nem található, vagy nincs hozzá jogod.';
    else if (d.cl && !C(d.cl)) msg = 'Ez az ügyfél nem található, vagy nincs hozzá jogod.';
    else if (d.stab === 'ai' && MEU.role !== 'admin') msg = 'Az AI-kapcsolat lapot csak az iroda adminja látja.';
    if (msg) { e.preventDefault(); e.stopPropagation(); toast(msg, true); return; }
    stopSpeech();
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || S.area !== 'kapu') return;
    if (K.dd || K.mdd) { K.dd = false; K.mdd = false; renderBar(); }
    if (K.menu) { K.menu = null; renderList(); }
    stopSpeech();
  });

  /* --- betöltés ----------------------------------------------------------------------------------- */
  function loadEngines() {
    var b = bridge();
    if (!b) return Promise.resolve();
    if (K.enginesP) return K.enginesP;
    K.enginesP = b.status().catch(function () { return null; }).then(function (r) {
      K.enginesP = null;
      if (r && r.ok) { K.engines = r.engines || []; K.enginesAt = Date.now(); syncRail(); }
    });
    return K.enginesP;
  }

  async function load() {
    var b = bridge();
    if (!b) { renderChat(); return; }
    var needEng = !K.engines || Date.now() - K.enginesAt > 60000;
    var res = await Promise.all([
      b.config().catch(function (e) { return { ok: false, error: e && e.message }; }),
      loadModels(),
      needEng ? loadEngines() : Promise.resolve(),
    ]);
    var c = res[0];
    if (!c || !c.ok) { K.cfgErr = (c && c.error) || 'A Kapu beállításai nem olvashatók.'; K.cfg = null; }
    else {
      K.cfgErr = ''; K.cfg = c;
      if (c.on && !c.hasToken) {
        var t = await b.ensureToken().catch(function (x) { return { ok: false, error: x && x.message }; });
        K.tokenErr = t && t.ok ? '' : (t && t.error) || 'A Kapu-hozzáférés most nem kérhető.';
      } else K.tokenErr = '';
    }
    syncRail();
    if (K.convId) await openConv(K.convId, { keep: true }); else renderChat();
    refreshList();
  }

  function enter() {
    K.entered = true;
    var q = document.getElementById('q');
    if (q) { K.savedPh = q.placeholder; q.placeholder = 'Keresés a beszélgetésekben…'; q.value = K.q; }
    var b = bridge();
    if (b && !K.hooked) { K.hooked = true; b.onEvent(onEvent); }
    renderList();
    K.loading = load();
  }
  function leave() {
    K.entered = false;
    var q = document.getElementById('q');
    if (q) { q.placeholder = K.savedPh || q.placeholder; q.value = S.q || ''; }
    K.dd = false; K.mdd = false; K.menu = null;
    document.getElementById('app').classList.remove('klist');
    stopSpeech();
    if (K.typing) K.typing.stop();
  }

  var curLogoMode = function () { return logoMode(K.cfg, K.engines, curOs(), voiceReady()); };

  window.KapuView = {
    /* A jobb oszlopba teszi a (megmaradó) chatet; az app.html minden rendereléskor hívhatja. */
    render: function (el) {
      if (!bridge()) { el.innerHTML = '<div class="page"><div class="card empty"><b>Kapu csak az asztali alkalmazásban érhető el</b>Nyisd meg a KapuMailt a gépeden telepített alkalmazással.</div></div>'; return; }
      var r = ensureRoot();
      if (r.parentNode !== el) { el.replaceChildren(r); if (K.conv && K.conv.messages && K.conv.messages.length) { var sc = $q('.kv-scroll', r); sc.scrollTop = sc.scrollHeight; } }
      ensureList();
    },
    /* A render() végén: belépés / kilépés a Kapu nézetbe. */
    onArea: function () {
      var on = S.area === 'kapu';
      if (on && !K.entered) enter();
      else if (!on && K.entered) leave();
    },
    onSearch: function (v) { K.q = String(v || ''); renderList(); },
    /* Jóváhagyó kártya máshová (az élő beszélgetés rétegének aljára): ugyanaz a kártya, saját gombkezeléssel. */
    confirmCard: function (host, id, o) {
      o = o || {};
      var c = document.createElement('div');
      c.className = 'kc';
      c.dataset.kc = id; c.dataset.act = '1';
      c.innerHTML = '<span class="mut">Az átállítás betöltése…</span>';
      host.appendChild(c);
      var again = function () { if (K.root) K.root.querySelectorAll('[data-kc="' + CSS.escape(id) + '"]').forEach(fillCard); };
      c.addEventListener('click', async function (e) {
        var t = e.target.closest('button');
        if (!t) return;
        if (t.dataset.kgo) {
          t.disabled = true;
          try { K.cards[id] = await api('POST', 'kapu/confirm/' + encodeURIComponent(id)); }
          catch (x) { delete K.cards[id]; fillCard(c); return; }
          fillCard(c); again();
          if (o.onApproved) o.onApproved();
          if (o.onDone) o.onDone();
        } else if (t.dataset.kno) {
          decline(id); fillCard(c); again();
          if (o.onDeclined) o.onDeclined();
          if (o.onDone) o.onDone();
        }
      });
      fillCard(c);
      return c;
    },
    sync: function (cfg, engines) {
      if (cfg) K.cfg = Object.assign({}, K.cfg, cfg);
      if (Array.isArray(engines)) {
        K.engines = engines; K.enginesAt = Date.now(); K.modelsAt = 0;
        if (K.entered) loadModels(true).then(function () { if (K.entered) renderBar(); });
      }
      syncRail();
      if (K.entered) { renderChat(); }
    },
    /* A sín felső logójának állapota: asztali appban 'voice' vagy 'chat', böngészőben ''. */
    logoMode: function () {
      if (!bridge()) return '';
      if ((!K.cfg || !K.engines) && !K.cfgBusy && Date.now() - K.cfgAt > 5000) peekCfg();
      return curLogoMode();
    },
    logoOn: function () { return !!this.logoMode(); },
    /* Logókattintás: megnyitja a Kapu-chatet; ha van összekapcsolt ChatGPT/Antigravity élő hang, átvált rá és elindítja a voicemodot. */
    openLive: async function () {
      if (!bridge()) return;
      var appEl = document.getElementById('app');
      appEl.classList.remove('klist', 'open');
      if (window.innerWidth < 760) appEl.classList.remove('nofold');
      if (S.area !== 'kapu') {
        S.area = 'kapu'; S.cv = null;
        render();
        var det = document.getElementById('detail');
        if (det) det.scrollTop = 0;
      }
      if (K.loading) await K.loading.catch(function () {});
      if (!K.engines) await loadEngines();
      syncRail();
      if (curLogoMode() !== 'voice') {
        var ta = K.root && $q('textarea', K.root);
        if (ta) ta.focus();
        return;
      }
      if (!KapuVoice.active()) await activateVoice();
    },
  };
  function rerail() { try { if (typeof renderRail === 'function' && TODAY) renderRail(); } catch (e) { /* még nincs sín vagy adat */ } }
  function syncRail() {
    var btn = document.querySelector('#rail [data-klogo]');
    var m = bridge() ? curLogoMode() : '';
    if ((btn ? btn.dataset.klogo : '') !== m) rerail();
  }
  function peekCfg() {
    var b = bridge();
    if (!b) return;
    K.cfgBusy = true;
    Promise.all([
      K.cfg ? Promise.resolve(null) : b.config().catch(function () { return null; }),
      K.engines ? Promise.resolve() : loadEngines(),
    ]).then(function (res) {
      K.cfgBusy = false; K.cfgAt = Date.now();
      if (res[0] && res[0].ok && !K.cfg) K.cfg = res[0];
      syncRail();
      if (K.entered) renderBar();
    }, function () { K.cfgBusy = false; K.cfgAt = Date.now(); });
  }
  document.addEventListener('click', function (e) {
    var l = e.target.closest && e.target.closest('[data-klogo]');
    if (!l) return;
    e.preventDefault();
    window.KapuView.openLive();
  });
  // Ha a hívást megelőzően (a hídon keresztül) jön esemény, akkor is kezeljük.
  if (bridge()) { K.hooked = true; bridge().onEvent(onEvent); }
})();
