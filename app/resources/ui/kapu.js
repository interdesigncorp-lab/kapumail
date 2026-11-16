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

  /* --- táblázat-export (Excel TSV / magyar CSV) és oszloprendezés segédek ------------------------- */
  function tableToTsv(rows) {
    return (rows || []).map(function (r) {
      return (r || []).map(function (c) { return String(c == null ? '' : c).replace(/[\r\n\t]+/g, ' ').trim(); }).join('\t');
    }).join('\n');
  }
  function csvCell(v) {
    var s = String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();
    // Excel képlet-injekció elleni védelem (=, @, illetve nem számmal folytatódó +/-)
    if (/^[=@]|^[+-](?!\d)/.test(s) && s !== '-' && s !== '+') s = "'" + s;
    if (/[;"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function tableToCsv(rows) {
    return '\uFEFF' + (rows || []).map(function (r) {
      return (r || []).map(csvCell).join(';');
    }).join('\r\n');
  }
  function parseSortDate(s) {
    var m = /^(\d{4})[-./]\s*(\d{1,2})[-./]\s*(\d{1,2})\.?$/.exec(s);
    if (!m) return null;
    return (+m[1]) * 10000 + (+m[2]) * 100 + (+m[3]);
  }
  function parseSortNum(s) {
    if (!s || /\d\s*[-–]\s*\d/.test(s)) return null;
    var m = /^([+-]?\d[\d\s\u00a0\u202f]*(?:[.,]\d+)?)(?:\s*(?:%|Ft|HUF|EUR|USD|GBP|CHF|eFt|MFt|db|fő|nap|óra))?$/i.exec(s);
    if (!m) return null;
    var n = Number(m[1].replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  function compareTableCells(a, b, dir) {
    var sa = String(a == null ? '' : a).trim(), sb = String(b == null ? '' : b).trim();
    var ea = !sa || /^[-–—]$/.test(sa), eb = !sb || /^[-–—]$/.test(sb);
    if (ea && eb) return 0;
    if (ea) return 1;
    if (eb) return -1;
    var sgn = dir === 'desc' ? -1 : 1;
    var da = parseSortDate(sa), db = parseSortDate(sb);
    if (da !== null && db !== null) return (da - db) * sgn;
    var na = parseSortNum(sa), nb = parseSortNum(sb);
    if (na !== null && nb !== null) return (na - nb) * sgn;
    return sa.localeCompare(sb, 'hu', { numeric: true, sensitivity: 'base' }) * sgn;
  }

  /* --- beszélgetéslista nézetei: alapértelmezetten kompakt (1 sor, rámutatásra nyílik), kétsoros és részletes --- */
  var LIST_VIEWS = [
    { id: 'compact', icon: 'k-v1', label: 'Kompakt', hint: 'Egy soros cím, rámutatásra nyílik' },
    { id: 'two', icon: 'k-v2', label: 'Kétsoros', hint: 'Cím, időpont és előnézet' },
    { id: 'full', icon: 'k-v3', label: 'Részletes', hint: 'Cím, motor és előnézet (3 sor)' },
  ];
  function resolveListView(v) {
    return v === 'compact' || v === 'two' || v === 'full' ? v : 'compact';
  }

  /* --- Kapu kabala hover & kattintás easter egg: hullámzó szívecskék/emojik + 120 cégvezetői idézet --- */
  var EASTER_COLORS = ['#f08bb9', '#a77dff', '#ff9ebb', '#b996ff', '#f598c4'];
  var EASTER_CUTE = ['🥰', '😊', '☺️', '🤗', '✨', '🌸', '🩷', '💜'];
  var EASTER_OFFICE = ['💌', '🧮', '🧾', '📬', '📊', '🗂️', '📎', '☕', '✅', '🤓', '📈'];
  var EASTER_MAX = 12;
  var EASTER_QUOTE_GROUPS = [
    { a: 'Warren Buffett · Berkshire Hathaway', qs: [
      'Egy nagyszerű vállalat tartós versenyelőnnyel védi a nyereségét.',
      'A vállalkozás valódi értékét nem pusztán a könyv szerinti értéke mutatja.',
      'A részvény megvásárlásával egy vállalkozás tulajdonosává válsz.',
      'A hosszú távú üzleti teljesítmény fontosabb a rövid távú árfolyammozgásoknál.',
      'A jó befektetési döntésekhez érteni kell a vállalkozás működését.',
      'A számviteli adatok segítik az üzleti gondolkodást, de nem helyettesítik azt.',
      'Az erős vállalatnak olyan előnye van, amelyet a versenytársak nehezen tudnak lemásolni.',
      'A vezetőnek a tulajdonosok hosszú távú érdekeit kell képviselnie.',
      'A hibák beismerése a felelős vállalatvezetés része.',
      'A vállalkozás értékteremtése fontosabb annál, hogy a piac ma mennyire lelkesedik érte.',
    ] },
    { a: 'Peter Drucker · Drucker Institute', qs: [
      'Az idő a vezető legszűkösebb erőforrása.',
      'Az eredmények a lehetőségek kihasználásából születnek.',
      'A hatékony innováció egyszerű és jól körülhatárolt.',
      'A marketing és az innováció teremti meg az üzleti eredményeket.',
      'A munkához felelősség, határidő és visszajelzés is tartozik.',
      'A vezetés célja, hogy magasabbra emelje az emberek jövőképét.',
      'A jó stratégia önmagában kevés, a megvalósítás minősége döntő.',
      'Az erőforrásokat a legnagyobb lehetőségekre kell összpontosítani.',
      'A hosszú távú tervezés a mai döntések jövőbeli következményeiről szól.',
      'A valódi eredményesség azzal kezdődik, hogy a megfelelő feladatot választjuk.',
    ] },
    { a: 'Jeff Bezos · Amazon', qs: [
      'Az ügyfelek igényeire figyelő vállalat sosem fogy ki a fejlődési lehetőségekből.',
      'A gyors döntéshozatal a versenyképesség része.',
      'Nem minden döntés igényel teljes bizonyosságot.',
      'Az ügyfél elégedettsége fontosabb a vállalati folyamatok kényelménél.',
      'A jó vezető felismeri, amikor a folyamat fontosabbá vált a célnál.',
      'A magas minőségi elvárás tanulható és fejleszthető.',
      'Az ügyfélközpontúság hosszú távú gondolkodást követel.',
      'A kiváló munkához sokszor több idő kell, mint elsőre gondolnánk.',
      'A vállalat mérete nem indokolja a vállalkozói gondolkodás elvesztését.',
      'A hosszú távú értékteremtésért néha rövid távú áldozatot kell vállalni.',
    ] },
    { a: 'Steve Jobs · Apple', qs: [
      'A múlt eseményeinek értelmét gyakran csak később ismerjük fel.',
      'A megérzésnek és a kíváncsiságnak is helye van a döntéseinkben.',
      'A kudarc néha megszabadít a korábbi sikerek terhétől.',
      'A szeretett munka megtalálásához keresni és kísérletezni kell.',
      'Ne elégedj meg olyan munkával, amelyben nem hiszel.',
      'Az időnk véges, ezért nem érdemes mások életét élnünk.',
      'A veszteség új kezdet lehet.',
      'A bizonytalanság ellenére is bíznunk kell abban, hogy a döntéseink egyszer értelmet nyernek.',
      'A kíváncsiság olyan tudáshoz vezethet, amelynek később vesszük hasznát.',
      'Maradj éhes a tudásra, és merj kezdőként gondolkodni.',
    ] },
    { a: 'Paul Graham · Y Combinator', qs: [
      'Az induláskor olyan munkát is vállalj, amelyet később nem lehet automatizálni.',
      'Az első ügyfeleket gyakran személyesen kell megszerezni.',
      'A sikeres startup egy valós emberi problémából indul ki.',
      'Jobb néhány lelkes felhasználó, mint sok közömbös.',
      'Az első ügyfelek visszajelzéseiből érted meg igazán a termékedet.',
      'Egy szűk piac is lehet egy nagy vállalkozás kezdete.',
      'A jó üzleti ötleteket gyakran a megoldatlan hétköznapi problémák rejtik.',
      'A kezdeti lassú, kézi munka később versenyelőnnyé válhat.',
      'A termék fejlesztése és az ügyfelek megismerése egymást erősítő feladat.',
      'Az igazán jó startupötletek sokszor kezdetben jelentéktelennek tűnnek.',
    ] },
    { a: 'Charlie Munger · Berkshire Hathaway', qs: [
      'Az ösztönzők akkor is befolyásolják az embereket, amikor ezt maguk sem veszik észre.',
      'A rosszul kialakított jutalmazás rossz döntésekhez vezethet.',
      'Az intelligencia nem véd meg automatikusan a gondolkodási hibáktól.',
      'Más tudományterületek ismerete javítja a döntéseink minőségét.',
      'A saját érdekeink torzíthatják azt, amit igaznak szeretnénk látni.',
      'A korábbi döntésünkhöz való ragaszkodás megakadályozhatja a józan mérlegelést.',
      'A tömeg véleménye önmagában nem bizonyítja, hogy valami igaz.',
      'A túlzott magabiztosság veszélyes döntési hiba.',
      'Az emberi viselkedést több pszichológiai hatás együttesen alakíthatja.',
      'A bölcs döntéshez fel kell ismernünk saját gondolkodásunk korlátait.',
    ] },
    { a: 'Bojár Gábor · Graphisoft', qs: [
      'A vállalkozói gondolkodás egyik alapja a kockázat vállalása.',
      'A jó vállalkozó mások képességeit is sikerre tudja vinni.',
      'Az ügyfél sikere a vállalkozó számára is öröm.',
      'A kitartás azt jelenti, hogy a sokadik kudarc után is újrakezdünk.',
      'A sikerhez néha hinnünk kell abban is, ami elsőre lehetetlennek tűnik.',
      'A jó vállalkozás nem csak pénzügyi mutatókkal mérhető.',
      'A kiszámítható szabályok segítik a vállalkozások hosszú távú fejlődését.',
      'A valódi piaci verseny ösztönzi az innovációt.',
      'A megfelelő üzlettárs kiválasztásánál a gondolkodásmód is döntő.',
      'A vállalkozóvá válásban a személyiség mellett a tanulásnak is szerepe van.',
    ] },
    { a: 'Rubik Ernő · Rubik-kocka', qs: [
      'A kíváncsiságot nem elfojtani, hanem megőrizni kell.',
      'Egy probléma megértése és megoldása két különböző feladat.',
      'A kreativitáshoz a kérdezés szabadságára is szükség van.',
      'Egy új megoldás keresése közben néha le kell bontanunk valamit.',
      'A megoldásra fordított időnél fontosabb lehet maga a felismerés.',
      'A készen kapott tudás nem helyettesíti a saját felfedezést.',
      'A játék és a tanulás szorosan összetartozhat.',
      'Az alkotás során a részek és az egész kapcsolatát is meg kell értenünk.',
      'A sikeres találmány működése még az alkotóját is továbbgondolkodásra késztetheti.',
      'A gyermekkori kíváncsiság megőrzése a későbbi kreativitás alapja lehet.',
    ] },
    { a: 'Sam Walton · Walmart', qs: [
      'A vállalkozás sikere a munkatársak elkötelezettségén is múlik.',
      'A nyereséget meg kell osztani azokkal, akik hozzájárulnak a megteremtéséhez.',
      'A munkatársak motiválásához az elismerés ugyanolyan fontos lehet, mint a pénz.',
      'A kommunikáció hiánya gyengíti a szervezetet.',
      'A jó vezető figyel a munkatársak véleményére.',
      'A sikereket közösen kell megünnepelni.',
      'Adj többet az ügyfélnek, mint amennyit vár.',
      'A költségek fegyelmezett kezelése versenyelőnyt jelent.',
      'Ne félj szembemenni a megszokott üzleti gyakorlattal.',
      'A sikeres vállalkozás folyamatosan tanul a saját hibáiból.',
    ] },
    { a: 'Satya Nadella · Microsoft', qs: [
      'A kíváncsiság fontosabb lehet annál, mint hogy mindig nálunk legyen a válasz.',
      'A folyamatos tanulás a vállalati kultúra alapvető része.',
      'A fejlődéshez néha a régi beidegződéseinket is el kell engednünk.',
      'A vezetőnek magán is alkalmaznia kell azt a szemléletet, amit a csapatától elvár.',
      'Az empátia segít felismerni az ügyfelek ki nem mondott igényeit.',
      'A valódi innovációhoz nyitottnak kell lennünk az új nézőpontokra.',
      'A vállalat kultúráját tudatosan alakítani kell.',
      'A változáshoz alkalmazkodó szervezetnek újra és újra tanulnia kell.',
      'A technológia értékét az adja, hogy mire teszi képessé az embereket.',
      'A sikeres átalakulás a gondolkodásmód megváltoztatásával kezdődik.',
    ] },
    { a: 'Balogh Petya · STRT', qs: [
      'Ötlettel tele a padlás.',
      'A legjobb ötlet is értéktelen, ha nem tudod megvalósítani.',
      'A sikeres vállalkozót nem a kudarc hiánya, hanem a tanulási képessége különbözteti meg.',
      'A vállalkozói úton minden hibában meg kell keresned a saját felelősségedet.',
      'Ne növekedj addig, amíg nem bizonyítottad, hogy valódi értéket teremtesz.',
      'A befektetés nem mindig segítség; a túl korai növekedés akár tönkre is tehet egy céget.',
      'A jó alapító nem ragaszkodik egy rossz ötlethez, hanem képes változtatni.',
      'A siker nem jelenti azt, hogy mindent jól csináltál.',
      'A vállalkozó legfontosabb képességei közé tartozik az alkalmazkodás és az önreflexió.',
      'A jó vállalkozásnak nemcsak bevételt kell termelnie, hanem nyereséget is meg kell őriznie.',
    ] },
    { a: 'Laczkovszki Gábor · WiredSign', qs: [
      'Nem az határozza meg, hányszor buktam el, hanem hogy hányszor döntöttem úgy: folytatom.',
      'Nem irányíthatom, mit gondolnak rólam mások. Azt viszont igen, hogy holnap milyen emberként ébredek.',
      'A vállalkozás nem a bizonytalanság megszüntetéséről szól, hanem arról, hogy megtanulunk benne cselekedni.',
      'Nem az számít, mennyi mindent építettem, hanem hogy amit létrehoztam, könnyebbé tette-e valaki más életét.',
      'A körülményekre mindig találhatok kifogást. A döntéseimért azonban nekem kell felelősséget vállalnom.',
      'Aki ma ugyanúgy gondolkodik, mint tegnap, az lehet, hogy hű önmagához, de nem biztos, hogy fejlődik.',
      'A bátorság nem a félelem hiánya, hanem az a pillanat, amikor a cél fontosabbá válik nála.',
      'Nem azért alkotok, mert biztos vagyok a sikerben. Hanem mert nem szeretném úgy leélni az életem, hogy meg sem próbáltam.',
      'A siker megmutatja, mire vagyok képes. A nehézségek megmutatják, ki vagyok valójában.',
      'Nem az a dolgom, hogy bebizonyítsam, mások tévedtek. Az a dolgom, hogy megvalósítsam, amiben hiszek.',
      'Az ember akkor válik igazán szabaddá, amikor már nem mások elismerésétől teszi függővé a saját értékét.',
      'Nem minden akadály azért kerül elém, hogy megállítson. Van, amelyik azért, hogy megtanuljam, mire vagyok képes.',
      'Az igazság nem attól válik igazzá, hogy hányan hisznek benne. És nem attól lesz hamis, hogy egyedül maradok vele.',
      'A pénzt, amit elveszítek, újra megkereshetem. Az időt, amit értelmetlen dolgokra fordítok, soha nem kapom vissza.',
      'A jellememet nem az mutatja meg, hogyan viselkedem, amikor minden jól alakul, hanem az, hogyan döntök, amikor minden ellenem szól.',
      'A világ tele van emberekkel, akik elmagyarázzák, miért nem lehet valamit megcsinálni. Én inkább megpróbálom megépíteni.',
      'Nem az az erős ember, aki minden vitát megnyer, hanem aki képes uralkodni magán akkor is, amikor minden oka meglenne elveszíteni a türelmét.',
      'A legnagyobb gazdagság nem az, ha mindent megengedhetek magamnak, hanem ha nem kell feladnom az elveimet azért, hogy megéljek.',
      'Nem bánom, ha tévedtem. Csak azt bánnám, ha a büszkeségem miatt képtelen lennék felismerni és kijavítani.',
      'Nem választhatom meg mindig, mit hoz elém az élet. De azt igen, hogy az, ami történik velem, megtör vagy bölcsebbé tesz.',
    ] },
  ];
  var EASTER_QUOTES = [];
  EASTER_QUOTE_GROUPS.forEach(function (g) {
    g.qs.forEach(function (q) { EASTER_QUOTES.push({ q: q, a: g.a }); });
  });

  function createQuotePicker(list, rng) {
    rng = rng || Math.random;
    var bag = [], lastAuthor = '', lastQuote = '';
    function refill() {
      bag = list.map(function (_, i) { return i; });
      for (var i = bag.length - 1; i > 0; i--) {
        var j = Math.floor(rng() * (i + 1)) % (i + 1);
        var tmp = bag[i]; bag[i] = bag[j]; bag[j] = tmp;
      }
    }
    return function next() {
      if (!list.length) return null;
      if (!bag.length) refill();
      var k = bag.length - 1;
      if (bag.length > 1) {
        for (var s = k; s >= 0; s--) {
          var cand = list[bag[s]];
          if (cand.a !== lastAuthor && cand.q !== lastQuote) {
            var swap = bag[k]; bag[k] = bag[s]; bag[s] = swap;
            break;
          }
        }
      }
      var picked = list[bag.pop()];
      lastAuthor = picked.a;
      lastQuote = picked.q;
      return picked;
    };
  }
  var defaultQuotePicker = createQuotePicker(EASTER_QUOTES);

  function easterHeartSvg(color, size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="' + color + '" aria-hidden="true">' +
      '<path d="M12 21.15c-.42 0-.83-.14-1.17-.42C6.14 16.86 2.5 13.43 2.5 8.95 2.5 5.68 5.02 3.2 8.15 3.2c1.74 0 3.04.82 3.85 1.88.81-1.06 2.11-1.88 3.85-1.88 3.13 0 5.65 2.48 5.65 5.75 0 4.48-3.64 7.91-8.33 11.78-.34.28-.75.42-1.17.42z"/></svg>';
  }
  function easterSparkleSvg(color, size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="' + color + '" aria-hidden="true">' +
      '<path d="M12 2.5c.35 0 .66.24.75.58l1.42 5.33a3.5 3.5 0 0 0 2.47 2.47l5.33 1.42a.77.77 0 0 1 0 1.5l-5.33 1.42a3.5 3.5 0 0 0-2.47 2.47l-1.42 5.33a.77.77 0 0 1-1.5 0l-1.42-5.33a3.5 3.5 0 0 0-2.47-2.47L2.53 13.8a.77.77 0 0 1 0-1.5l5.33-1.42a3.5 3.5 0 0 0 2.47-2.47l1.42-5.33c.09-.34.4-.58.75-.58z"/></svg>';
  }
  function stepEasterParticle(p, t) {
    var easeRise = 1 - Math.pow(1 - t, 1.35);
    var wave = Math.sin(t * Math.PI * p.freq + p.phase) * p.amp * (0.4 + 0.6 * t);
    var x = p.x0 + p.drift * t + wave;
    var y = p.y0 - p.rise * easeRise;
    var rot = Math.cos(t * Math.PI * p.freq + p.phase) * 13;
    var scale = t < 0.16 ? (0.35 + (t / 0.16) * 0.65) : (1 - (t - 0.16) * 0.14);
    var alpha = t < 0.16 ? (t / 0.16) * p.maxAlpha : t > 0.62 ? ((1 - t) / 0.38) * p.maxAlpha : p.maxAlpha;
    return { x: x, y: y, rot: rot, scale: scale, alpha: Math.max(0, alpha) };
  }
  function createHeroEasterEgg(slot, hero, env) {
    env = env || {};
    var doc = env.doc;
    var now = env.now || function () { return Date.now(); };
    var later = env.setTimeout || setTimeout, cancel = env.clearTimeout || clearTimeout;
    var raf = env.raf || function (f) { return later(function () { f(now()); }, 16); };
    var caf = env.caf || cancel;
    var rng = env.rand || Math.random;
    var disabled = env.disabled || function () { return false; };
    var hidden = env.hidden || function () { return false; };
    var pickQuote = env.rand ? createQuotePicker(EASTER_QUOTES, rng) : defaultQuotePicker;
    var size = env.size || 156;
    var rnd = function (a, b) { return a + rng() * (b - a); };

    slot.classList.add('kav-hero-slot');
    var layer = doc.createElement('span');
    layer.className = 'kav-fx';
    layer.setAttribute('aria-hidden', 'true');
    slot.appendChild(layer);

    var particles = [], burstTs = [], hovering = false, spawnT = 0, secondT = 0, bounceT = 0, rafId = 0, lastEmoji = '';
    var qEl = null, qHideT = 0, qRemT = 0;

    function pickEmoji(list) {
      var idx = Math.floor(rng() * list.length) % list.length;
      var ch = list[idx];
      if (list.length > 1 && ch === lastEmoji) ch = list[(idx + 1) % list.length];
      lastEmoji = ch;
      return ch;
    }
    function clearQuote() {
      cancel(qHideT); cancel(qRemT); qHideT = 0; qRemT = 0;
      if (qEl && qEl.parentNode) qEl.parentNode.removeChild(qEl);
      qEl = null;
    }
    function showQuote() {
      if (!hero.isConnected || hidden()) { clearQuote(); return null; }
      clearQuote();
      var item = pickQuote();
      if (!item) return null;
      var box = doc.createElement('div');
      box.className = 'kav-q';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      var qt = doc.createElement('span');
      qt.className = 'kav-qt';
      qt.textContent = '„' + item.q + '”';
      var qa = doc.createElement('span');
      qa.className = 'kav-qa';
      qa.textContent = item.a;
      box.appendChild(qt);
      box.appendChild(qa);
      slot.appendChild(box);
      qEl = box;
      qHideT = later(function () {
        if (qEl === box) box.classList.add('out');
        qRemT = later(function () {
          if (box.parentNode) box.parentNode.removeChild(box);
          if (qEl === box) qEl = null;
        }, 360);
      }, 6800);
      return item;
    }
    function clearTimers() {
      cancel(spawnT); cancel(secondT); spawnT = 0; secondT = 0;
      while (burstTs.length) cancel(burstTs.pop());
    }
    function cleanupAll() {
      hovering = false;
      hero.classList.remove('k-hover', 'k-happy');
      clearTimers(); clearQuote(); cancel(bounceT); bounceT = 0;
      if (rafId) { caf(rafId); rafId = 0; }
      while (particles.length) {
        var p = particles.pop();
        if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
      }
    }
    function bounce() {
      hero.classList.remove('k-happy');
      if (hero.offsetWidth !== undefined) void hero.offsetWidth;
      hero.classList.add('k-happy');
      cancel(bounceT);
      bounceT = later(function () { hero.classList.remove('k-happy'); bounceT = 0; }, 680);
    }
    function spawnOne() {
      if (!hero.isConnected) { cleanupAll(); return null; }
      if (disabled() || particles.length >= EASTER_MAX) return null;
      var el = doc.createElement('span');
      el.className = 'kav-p';
      var r = rng(), kind = 'heart';
      if (r < 0.52) {
        var col = EASTER_COLORS[Math.floor(rng() * EASTER_COLORS.length) % EASTER_COLORS.length];
        var sz = Math.round(rnd(12, 17));
        if (rng() < 0.22) { kind = 'sparkle'; el.innerHTML = easterSparkleSvg(col, sz - 1); }
        else el.innerHTML = easterHeartSvg(col, sz);
      } else {
        kind = r < 0.77 ? 'cute' : 'office';
        el.style.fontSize = Math.round(rnd(14.5, 18.5)) + 'px';
        el.textContent = pickEmoji(kind === 'cute' ? EASTER_CUTE : EASTER_OFFICE);
      }
      var p = {
        el: el, kind: kind,
        x0: size * 0.5 + rnd(-size * 0.27, size * 0.27),
        y0: size * 0.28 + rnd(-10, 20),
        rise: rnd(72, 106),
        drift: rnd(-20, 20),
        amp: rnd(9, 16),
        freq: rnd(1.5, 2.4),
        phase: rnd(0, Math.PI * 2),
        maxAlpha: kind === 'heart' || kind === 'sparkle' ? rnd(0.8, 0.92) : rnd(0.86, 0.95),
        born: now(),
        life: rnd(1800, 2400),
      };
      var s0 = stepEasterParticle(p, 0);
      el.style.opacity = s0.alpha.toFixed(3);
      el.style.transform = 'translate3d(' + s0.x.toFixed(1) + 'px,' + s0.y.toFixed(1) + 'px,0) translate(-50%,-50%) scale(' + s0.scale.toFixed(3) + ') rotate(' + s0.rot.toFixed(1) + 'deg)';
      layer.appendChild(el);
      particles.push(p);
      if (!rafId) rafId = raf(tick);
      return p;
    }
    function tick() {
      rafId = 0;
      if (!hero.isConnected || disabled()) { cleanupAll(); return; }
      var cur = now();
      for (var i = particles.length - 1; i >= 0; i--) {
        var p = particles[i];
        var t = (cur - p.born) / p.life;
        if (t >= 1) {
          if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
          particles.splice(i, 1);
          continue;
        }
        var s = stepEasterParticle(p, Math.max(0, t));
        p.el.style.opacity = s.alpha.toFixed(3);
        p.el.style.transform = 'translate3d(' + s.x.toFixed(1) + 'px,' + s.y.toFixed(1) + 'px,0) translate(-50%,-50%) scale(' + s.scale.toFixed(3) + ') rotate(' + s.rot.toFixed(1) + 'deg)';
      }
      if (particles.length) rafId = raf(tick);
    }
    function scheduleNext() {
      if (!hovering) return;
      spawnT = later(function () {
        if (!hovering || !hero.isConnected || disabled()) return;
        spawnOne();
        scheduleNext();
      }, rnd(350, 530));
    }
    function burst(n) {
      if (disabled() || !hero.isConnected) return;
      bounce();
      while (burstTs.length) cancel(burstTs.pop());
      for (var i = 0; i < n; i++) {
        (function (delay) {
          if (delay === 0) spawnOne();
          else burstTs.push(later(function () { spawnOne(); }, delay));
        })(i * 110);
      }
    }
    hero.addEventListener('mouseenter', function () {
      if (disabled() || !hero.isConnected) return;
      hovering = true;
      hero.classList.add('k-hover');
      clearTimers();
      bounce();
      spawnOne();
      secondT = later(function () { if (hovering) spawnOne(); }, 155);
      scheduleNext();
    });
    hero.addEventListener('mouseleave', function () {
      hovering = false;
      hero.classList.remove('k-hover');
      cancel(spawnT); cancel(secondT); spawnT = 0; secondT = 0;
    });
    hero.addEventListener('click', function () {
      burst(4);
      showQuote();
    });

    return { layer: layer, count: function () { return particles.length; }, quoteEl: function () { return qEl; }, showQuote: showQuote, spawnOne: spawnOne, destroy: cleanupAll };
  }

  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) module.exports = { createGate: createGate, createAvatarPlayer: createAvatarPlayer, overlayHold: overlayHold, pickModel: pickModel, modelName: modelName, metaParts: metaParts, canVoice: canVoice, voiceTarget: voiceTarget, logoMode: logoMode, DEFAULT_PROMPTS: DEFAULT_PROMPTS, resolvePrompts: resolvePrompts, upsertPrompt: upsertPrompt, removePrompt: removePrompt, tableToTsv: tableToTsv, tableToCsv: tableToCsv, compareTableCells: compareTableCells, LIST_VIEWS: LIST_VIEWS, resolveListView: resolveListView, EASTER_COLORS: EASTER_COLORS, EASTER_CUTE: EASTER_CUTE, EASTER_OFFICE: EASTER_OFFICE, EASTER_QUOTE_GROUPS: EASTER_QUOTE_GROUPS, EASTER_QUOTES: EASTER_QUOTES, createQuotePicker: createQuotePicker, stepEasterParticle: stepEasterParticle, createHeroEasterEgg: createHeroEasterEgg };
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
      'k-v3': '<rect x="3.5" y="4.5" width="17" height="15" rx="3.5"/><path d="M7.5 8.8h9M7.5 12h5.5M7.5 15.2h7.5"/>',
      'k-v2': '<rect x="3.5" y="5.8" width="17" height="12.4" rx="3.5"/><path d="M7.5 10.2h9M7.5 13.8h6"/>',
      'k-v1': '<rect x="3.5" y="7.5" width="17" height="9" rx="3.5"/><path d="M7.5 12h7.5"/>',
      'k-copy': '<rect x="9" y="9" width="10.5" height="10.5" rx="2.2"/><path d="M15 9V6.2A2.2 2.2 0 0012.8 4H6.2A2.2 2.2 0 004 6.2v6.6A2.2 2.2 0 006.2 15H9"/>',
      'k-dl': '<path d="M12 4.5v10.5M8 11.5l4 4 4-4M5 19.5h14"/>',
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
      if (opts.hero) {
        w.__ke = createHeroEasterEgg(el, w, {
          doc: document,
          size: opts.size || 156,
          now: function () { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); },
          raf: typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null,
          caf: typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null,
          disabled: function () {
            try { if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return true; } catch (_) {}
            return !!document.hidden || avOverlayOn();
          },
          hidden: function () { return !!document.hidden || avOverlayOn(); },
        });
      }
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
    menu: null, view: 'compact', vdd: false, dd: false, mdd: false, models: null, modelsAt: 0, loading: null, cfgAt: 0, cfgBusy: false, typing: null, stick: true, sending: false, savedPh: '',
    gate: createGate(), stopNew: false,
  };
  var DECL_KEY = 'kapu:declined';
  var VIEW_KEY = 'kapu.listView';
  function savedListView() { try { return resolveListView(localStorage.getItem(VIEW_KEY)); } catch (e) { return 'compact'; } }
  function saveListView(v) { var next = resolveListView(v); K.view = next; try { localStorage.setItem(VIEW_KEY, next); } catch (e) { /* csak ebben a munkamenetben */ } return next; }
  K.view = savedListView();
  function declined() { try { return JSON.parse(localStorage.getItem(DECL_KEY) || '[]'); } catch (e) { return []; } }
  function decline(id) { try { var a = declined().filter(function (x) { return x !== id; }); a.push(id); localStorage.setItem(DECL_KEY, JSON.stringify(a.slice(-200))); } catch (e) { /* csak ebben a munkamenetben */ } }

  var fold = function (s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); };
  var plain = function (md) {
    var d = document.createElement('div');
    d.innerHTML = window.KapuMd ? KapuMd.render(String(md || ''))
      .replace(/<\/t[hd]>/gi, '$& ')
      .replace(/<\/(p|li|tr|h[1-6]|pre|blockquote)>/gi, '$&\n') : esc(md);
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
  function whenShort(ms) {
    var d = new Date(ms), now = new Date();
    var day = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((day(now) - day(d)) / 864e5);
    if (diff <= 1) return d.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' });
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
    r.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.matches && e.target.matches('th[data-ktsort]')) {
        e.preventDefault();
        sortChatTable(e.target);
      }
    });
    return r;
  }

  function ensureList() {
    var host = document.querySelector('#app .list');
    if (!host) return null;
    if (!K.listEl) {
      var l = document.createElement('div');
      l.id = 'kapulist';
      l.dataset.kview = resolveListView(K.view);
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
  function viewPickerHtml(view) {
    var cur = LIST_VIEWS.filter(function (x) { return x.id === view; })[0] || LIST_VIEWS[0];
    return '<div class="kl-vw">' +
      '<button type="button" class="kl-vbtn" data-kvbtn aria-label="Lista nézete: ' + esc(cur.label) + '" aria-haspopup="menu" aria-expanded="' + (K.vdd ? 'true' : 'false') + '" title="Nézet: ' + esc(cur.label) + '">' +
        ic(cur.icon) + ic('chev', 'cv') +
      '</button>' +
      (K.vdd ? '<div class="kl-vmenu" role="menu" aria-label="Beszélgetéslista nézete">' +
        LIST_VIEWS.map(function (o) {
          var on = o.id === view;
          return '<button type="button" role="menuitemradio" aria-checked="' + (on ? 'true' : 'false') + '" data-kview="' + o.id + '">' +
            ic(o.icon, 'vi') +
            '<span><b>' + esc(o.label) + '</b><small>' + esc(o.hint) + '</small></span>' +
            (on ? ic('check', 'ck') : '') +
          '</button>';
        }).join('') +
      '</div>' : '') +
    '</div>';
  }

  function renderList() {
    var l = ensureList();
    if (!l) return;
    var view = resolveListView(K.view);
    l.dataset.kview = view;
    var rows = $q('.kl-rows', l), foot = $q('.kl-foot', l);
    if (K.listErr) { rows.innerHTML = '<div class="kl-empty">' + esc(K.listErr) + '</div>'; foot.innerHTML = ''; return; }
    var q = fold(K.q).trim();
    var items = K.items.filter(function (it) { return !q || fold(it.title + ' ' + (K.prev[it.id] || '') + ' ' + ENG[it.engine]).indexOf(q) >= 0; });
    var h = '', last = '', firstDay = true;
    items.forEach(function (it) {
      var lab = dayLabel(it.updatedAt);
      if (lab !== last) {
        if (firstDay) {
          firstDay = false;
          h += '<div class="kl-day-bar"><div class="kl-day" role="presentation">' + lab + '</div>' + viewPickerHtml(view) + '</div>';
        } else h += '<div class="kl-day" role="presentation">' + lab + '</div>';
        last = lab;
      }
      var run = K.running.has(it.id), mopen = K.menu === it.id;
      h += '<div class="kl-row' + (it.id === K.convId ? ' on' : '') + (mopen ? ' mopen' : '') + '" role="listitem">' +
        '<button type="button" class="kl-open" data-kopen="' + esc(it.id) + '"' + (it.id === K.convId ? ' aria-current="true"' : '') + '>' +
        '<span class="kl-head">' +
          (run ? '<span class="kl-run kl-hrun" title="Kapu dolgozik"></span>' : '') +
          '<b>' + esc(it.title || 'Új beszélgetés') + '</b>' +
          '<span class="kl-when">' + esc(whenShort(it.updatedAt)) + '</span>' +
        '</span>' +
        '<span class="kl-extra"><span class="kl-extra-in">' +
          '<span class="kl-meta">' + (run ? '<span class="kl-run" title="Kapu dolgozik"></span>' : '') + '<span class="kl-eng">' + esc(ENG[it.engine] || it.engine) + '</span>·<span>' + esc(when(it.updatedAt)) + '</span></span>' +
          (K.prev[it.id] ? '<span class="kl-prev">' + esc(K.prev[it.id]) + '</span>' : '') +
        '</span></span></button>' +
        '<button type="button" class="kl-more" data-kmore="' + esc(it.id) + '" aria-label="Továbbiak" aria-haspopup="menu" aria-expanded="' + mopen + '">' + ic('k-dots') + '</button>' +
        (mopen ? '<div class="kl-menu" role="menu"><button type="button" role="menuitem" data-kdel="' + esc(it.id) + '">' + ic('k-trash') + 'Beszélgetés törlése</button></div>' : '') +
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
  function metaHtml(engine, model, copyIdx) {
    var p = metaParts(K.models, engine, model);
    var cp = copyIdx != null ? '<button type="button" class="km-copy" data-kcopy="' + copyIdx + '" title="Válasz másolása" aria-label="Válasz másolása">' + ic('k-copy') + '</button>' : '';
    return '<div class="km-meta"><b>' + esc(p[0]) + '</b>' + p.slice(1).map(function (x) { return '·<span>' + esc(x) + '</span>'; }).join('') + cp + '</div>';
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
        return '<div class="km kapu" data-i="' + i + '"><span class="kav-slot" data-av="' + (i === lastKapu ? 'live' : 'still') + '"></span><div class="km-col">' + metaHtml(c.engine, m.model, i) +
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
    enhanceTables(box);
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

  /* Táblázatok interaktív fejléce (sorok száma, Excel/TSV másolás, CSV letöltés, kattintható oszloprendezés). */
  function enhanceTables(el) {
    el.querySelectorAll('.ktbl-w').forEach(function (w) {
      if ($q('.ktbl-bar', w)) return;
      var tbl = $q('table.ktbl', w);
      if (!tbl) return;
      var bodyRows = tbl.querySelectorAll('tbody tr');
      var n = bodyRows.length;
      bodyRows.forEach(function (tr, idx) { tr.dataset.orig = String(idx); });
      if (n >= 2) {
        tbl.querySelectorAll('thead th').forEach(function (th, c) {
          th.dataset.ktsort = String(c);
          th.setAttribute('tabindex', '0');
          th.setAttribute('aria-sort', 'none');
          th.setAttribute('title', 'Rendezés ezen az oszlopon');
        });
      }
      var bar = document.createElement('div');
      bar.className = 'ktbl-bar';
      bar.setAttribute('data-notype', '1');
      bar.innerHTML = '<span class="ktbl-cnt">' + (n ? n + ' sor' : 'Táblázat') + '</span>' +
        '<button type="button" class="ktbl-btn" data-ktcopy title="Táblázat másolása vágólapra (Excelbe illeszthető)">' + ic('k-copy') + '<span>Másolás</span></button>' +
        '<button type="button" class="ktbl-btn" data-ktcsv title="Táblázat letöltése CSV-fájlként (Excel)">' + ic('k-dl') + '<span>CSV</span></button>';
      w.insertBefore(bar, w.firstChild);
    });
  }

  function extractTableRows(tbl) {
    var out = [];
    tbl.querySelectorAll('thead tr, tbody tr').forEach(function (tr) {
      var r = [];
      tr.querySelectorAll('th, td').forEach(function (cell) { r.push((cell.textContent || '').replace(/\s+/g, ' ').trim()); });
      if (r.length) out.push(r);
    });
    return out;
  }

  function sortChatTable(th) {
    if (K.typing) K.typing.stop();
    var tbl = th.closest('table.ktbl');
    var tbody = tbl && $q('tbody', tbl);
    if (!tbody) return;
    var col = +th.dataset.ktsort || 0;
    var cur = th.getAttribute('aria-sort') || 'none';
    var next = cur === 'ascending' ? 'descending' : cur === 'descending' ? 'none' : 'ascending';
    tbl.querySelectorAll('thead th[data-ktsort]').forEach(function (h) { h.setAttribute('aria-sort', h === th ? next : 'none'); });
    var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
    rows.sort(function (ra, rb) {
      if (next === 'none') return (+ra.dataset.orig || 0) - (+rb.dataset.orig || 0);
      var ca = ra.children[col], cb = rb.children[col];
      var cmp = compareTableCells(ca ? ca.textContent : '', cb ? cb.textContent : '', next === 'descending' ? 'desc' : 'asc');
      return cmp !== 0 ? cmp : (+ra.dataset.orig || 0) - (+rb.dataset.orig || 0);
    });
    rows.forEach(function (tr) { tbody.appendChild(tr); });
  }

  async function copyText(str) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(str); return true; } catch (_) { /* tartalék lent */ }
    }
    try {
      var ta = document.createElement('textarea');
      ta.value = str;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (_) { return false; }
  }

  function flashBtn(btn) {
    if (!btn) return;
    btn.classList.add('copied');
    var use = btn.querySelector('svg use');
    var orig = use && use.getAttribute('href');
    if (use && orig) use.setAttribute('href', '#check');
    clearTimeout(btn.__cpT);
    btn.__cpT = setTimeout(function () {
      btn.classList.remove('copied');
      if (use && orig) use.setAttribute('href', orig);
    }, 1500);
  }

  function copyableBodyText(bodyEl, fallbackMd) {
    if (!bodyEl) return plain(fallbackMd);
    var parts = [];
    Array.prototype.slice.call(bodyEl.children).forEach(function (ch) {
      if (ch.classList && ch.classList.contains('ktbl-w')) {
        var tbl = $q('table.ktbl', ch);
        if (tbl) parts.push(tableToTsv(extractTableRows(tbl)));
      } else if (ch.tagName === 'UL' || ch.tagName === 'OL') {
        var ordered = ch.tagName === 'OL';
        var lines = Array.prototype.slice.call(ch.querySelectorAll('li')).map(function (li, idx) {
          return (ordered ? (idx + 1) + '. ' : '• ') + (li.textContent || '').replace(/\s+/g, ' ').trim();
        });
        if (lines.length) parts.push(lines.join('\n'));
      } else if (ch.tagName === 'PRE') {
        parts.push((ch.textContent || '').replace(/\n+$/, ''));
      } else if (ch.tagName !== 'HR') {
        var t = (ch.textContent || '').replace(/[ \t]+/g, ' ').trim();
        if (t) parts.push(t);
      }
    });
    return parts.join('\n\n').trim() || plain(fallbackMd);
  }

  function downloadCsv(rows) {
    var csv = tableToCsv(rows);
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var d = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = 'kapu-tablazat-' + d + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
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
    var th = e.target.closest('th[data-ktsort]');
    if (th) {
      sortChatTable(th);
      return;
    }
    var t = e.target.closest('button');
    if (!t) {
      if ((K.dd || K.mdd) && !e.target.closest('.kdd')) { K.dd = false; K.mdd = false; renderBar(); }
      if (e.target.closest('.kv-msgs')) { stopSpeech(); if (K.typing) K.typing.stop(); }
      return;
    }
    var d = t.dataset;
    if ('ktcopy' in d) {
      if (K.typing) K.typing.stop();
      var wCopy = t.closest('.ktbl-w'), tblCopy = wCopy && $q('table.ktbl', wCopy);
      if (tblCopy && (await copyText(tableToTsv(extractTableRows(tblCopy))))) {
        flashBtn(t);
        toast('Táblázat vágólapra másolva (Excelbe illeszthető).');
      }
      return;
    }
    if ('ktcsv' in d) {
      if (K.typing) K.typing.stop();
      var wCsv = t.closest('.ktbl-w'), tblCsv = wCsv && $q('table.ktbl', wCsv);
      if (tblCsv) {
        downloadCsv(extractTableRows(tblCsv));
        flashBtn(t);
        toast('Táblázat letöltve CSV-fájlként.');
      }
      return;
    }
    if ('kcopy' in d) {
      if (K.typing) K.typing.stop();
      var idx = +d.kcopy;
      var msg = K.conv && K.conv.messages && K.conv.messages[idx];
      var rowEl = t.closest('.km.kapu');
      var bodyEl = rowEl && $q('.km-body', rowEl);
      var txt = copyableBodyText(bodyEl, msg ? msg.text : '');
      if (txt && (await copyText(txt))) {
        flashBtn(t);
        toast('Válasz a vágólapra másolva.');
      }
      return;
    }
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
    e.__inKapuList = true;
    var t = e.target.closest('button');
    var d = t ? t.dataset : {};
    var needRender = false;
    if (K.vdd && !('kvbtn' in d) && !d.kview) { K.vdd = false; needRender = true; }
    if (K.menu && !d.kmore && !d.kdel) { K.menu = null; needRender = true; }
    if (!t) { if (needRender) renderList(); return; }
    if ('kvbtn' in d) { K.vdd = !K.vdd; K.menu = null; renderList(); return; }
    if (d.kview) { saveListView(d.kview); K.vdd = false; renderList(); return; }
    if ('knew' in d) { document.getElementById('app').classList.remove('klist'); newConv(); return; }
    if (d.kopen) { document.getElementById('app').classList.remove('klist'); if (d.kopen !== K.convId) openConv(d.kopen); else if (needRender) renderList(); return; }
    if (d.kmore) { K.vdd = false; K.menu = K.menu === d.kmore ? null : d.kmore; renderList(); var m = K.listEl.querySelector('.kl-menu button'); if (m) m.focus(); return; }
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

  // Külső kattintás zárja a lista menüit; capture fázisban fut, mielőtt a renderList() lecserélné az innerHTML-t (különben a levált e.target.closest('#kapulist') null lenne).
  document.addEventListener('click', function (e) {
    if (e.__inKapuList || S.area !== 'kapu' || (!K.vdd && !K.menu)) return;
    if (K.listEl && e.composedPath && e.composedPath().indexOf(K.listEl) >= 0) return;
    if (e.target && e.target.closest && e.target.closest('#kapulist')) return;
    K.vdd = false; K.menu = null; renderList();
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || S.area !== 'kapu') return;
    if (K.dd || K.mdd) { K.dd = false; K.mdd = false; renderBar(); }
    if (K.menu || K.vdd) { K.menu = null; K.vdd = false; renderList(); }
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
    K.dd = false; K.mdd = false; K.menu = null; K.vdd = false;
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
