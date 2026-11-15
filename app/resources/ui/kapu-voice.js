/* Kapu-chat (ADR-014): az élő beszélgetés teljes ablakos rétege,
   világosan: elmosott fehér üveg a KapuMail felett, középen a nagy Kapu). ChatGPT-nél a hang WebRTC-n
   megy: a mikrofon és a Kapu hangja a böngészőrész RTCPeerConnection-jén, a főfolyamat csak az SDP-t
   cseréli (iratkapuDesktop.kapu.voice). Antigravitynél PCM-út: a mikrofon 16 kHz mono s16le base64-ben
   60 ms-onként megy a főfolyamatnak (sendAudio), Kapu 24 kHz-es darabjai `audio` eseményként jönnek és
   AudioBufferSource-szal, egymás után ütemezve szólnak; `clear` (közbeszólás) minden lejátszást leállít.
   Az elhangzott kérdés a szöveges körön át fut (voice-bridge), a
   jóváhagyó kártya a réteg alján jelenik meg. Kifelé: window.KapuVoice {start({engine, convId, onClose}),
   open(engine), active()}. Az app.html segédeit használja (esc, toast). */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;

  var ENG_EYE = { codex: 'ChatGPT élő', agy: 'Antigravity élő' };
  var BARS = 256;
  var cur = null;
  var bridge = function () { var k = window.iratkapuDesktop && window.iratkapuDesktop.kapu; return k && k.voice ? k : null; };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  var SVG = {
    pulse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2.5-6 4 12 2.5-6H21"/></svg>',
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v2.5"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 10.5V6.5a3 3 0 00-5.6-1.5M9 9v2.5a3 3 0 004.6 2.5M5.5 11.5a6.5 6.5 0 0010.4 5.2M18.5 11.5a6.4 6.4 0 01-.6 2.7M12 18v2.5M4 4l16 16"/></svg>',
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 13.6c4.9-4.4 12.1-4.4 17 0l-1.9 2.6a1.2 1.2 0 01-1.5.4l-2.5-1.1a1.2 1.2 0 01-.7-1.1v-1.6a11 11 0 00-3.8 0v1.6c0 .5-.3.9-.7 1.1l-2.5 1.1a1.2 1.2 0 01-1.5-.4z"/></svg>',
  };

  function Session(opts) {
    this.opts = opts;
    this.engine = opts.engine;
    this.convId = opts.convId || null;
    this.ended = false;
    this.muted = false;
    this.thinking = false;
    this.lines = [];
    this.meters = {};
    this.frame = 0;
    this.focus = document.activeElement;
    this.build();
  }

  Session.prototype.build = function () {
    var self = this;
    var root = this.root = el('div', 'kvo');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'kvo-title');
    root.dataset.state = 'connecting';
    root.dataset.src = 'none';
    var amb = el('div', 'kvo-amb'); amb.setAttribute('aria-hidden', 'true'); amb.innerHTML = '<i></i><i></i><i></i>';
    var head = el('header', 'kvo-head');
    var mark = el('span', 'kvo-mark'); mark.innerHTML = SVG.pulse;
    var ht = el('div');
    ht.appendChild(el('p', 'kvo-eye', ENG_EYE[this.engine] || 'Élő'));
    var h2 = el('h2', null, 'Élő beszélgetés'); h2.id = 'kvo-title'; ht.appendChild(h2);
    head.appendChild(mark); head.appendChild(ht);

    var stage = el('main', 'kvo-stage');
    var id = el('div', 'kvo-id');
    var orb = el('div', 'kvo-orb'); orb.setAttribute('aria-hidden', 'true');
    orb.appendChild(el('span', 'kvo-glow'));
    orb.appendChild(el('span', 'kvo-ring r1'));
    orb.appendChild(el('span', 'kvo-ring r2'));
    var av = el('span', 'kvo-av'); orb.appendChild(av);
    id.appendChild(orb);
    id.appendChild(el('p', 'kvo-name', 'Kapu'));
    id.appendChild(el('p', 'kvo-role', 'Az iroda iratfelelőse'));
    this.status = el('p', 'kvo-status', 'Mikrofon megnyitása…'); this.status.setAttribute('role', 'status');
    this.error = el('p', 'kvo-err'); this.error.setAttribute('role', 'alert');
    this.play = el('button', 'kvo-play', 'Hang lejátszása'); this.play.type = 'button'; this.play.hidden = true;
    this.play.addEventListener('click', function () {
      if (self.pcm && self.ctx) { self.ctx.resume().then(function () { self.play.hidden = true; }).catch(function () {}); return; }
      self.audio.play().then(function () { self.play.hidden = true; }).catch(function () {});
    });
    this.tr = el('div', 'kvo-tr'); this.tr.setAttribute('aria-live', 'polite'); this.tr.setAttribute('aria-label', 'Az utolsó elhangzott mondatok');
    this.canvas = el('canvas', 'kvo-wave'); this.canvas.setAttribute('aria-hidden', 'true');
    stage.appendChild(id); stage.appendChild(this.status); stage.appendChild(this.error); stage.appendChild(this.play);
    stage.appendChild(this.tr); stage.appendChild(this.canvas);

    this.confirm = el('div', 'kvo-confirm');

    var ctl = el('footer', 'kvo-ctl');
    var acts = el('div', 'kvo-acts');
    var mute = this.mute = el('button', 'kvo-mute'); mute.type = 'button'; mute.disabled = true;
    mute.setAttribute('aria-pressed', 'false'); mute.setAttribute('aria-label', 'Mikrofon némítása'); mute.title = 'Mikrofon némítása';
    mute.innerHTML = SVG.mic;
    mute.addEventListener('click', function () { self.toggleMute(); });
    var end = el('button', 'kvo-end'); end.type = 'button';
    end.innerHTML = SVG.phone + '<span>Beszélgetés befejezése</span>';
    end.addEventListener('click', function () { self.close(); });
    acts.appendChild(mute); acts.appendChild(end);
    ctl.appendChild(acts);
    ctl.appendChild(el('p', 'kvo-hint', 'Beszélj természetesen. A válaszába is közbeszólhatsz.'));

    root.appendChild(amb); root.appendChild(head); root.appendChild(stage); root.appendChild(this.confirm); root.appendChild(ctl);
    this.avatar = window.KapuAvatar ? KapuAvatar.mount(av, { size: 260, live: true, state: 'hello' }) : null;
    this.audio = new Audio(); this.audio.autoplay = true;
    this.onKey = function (e) { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); self.close(); } };
    this.onHide = function () { self.close(); };
    this.endBtn = end;
  };

  Session.prototype.open = async function () {
    var self = this, b = bridge();
    document.body.appendChild(this.root);
    document.body.classList.add('kvo-on');
    document.addEventListener('keydown', this.onKey, true);
    window.addEventListener('pagehide', this.onHide);
    requestAnimationFrame(function () { self.root.classList.add('in'); self.endBtn.focus(); });
    b.voice.onEvent(function (ev) { self.onEvent(ev); });
    this.deadline = setTimeout(function () { self.fail(self.stream ? 'Az élő beszélgetés nem indult el időben. Próbáld újra.' : 'A mikrofon nem nyílt meg időben.'); }, 45000);
    try {
      var acc = await b.voice.prepare();
      if (this.ended) return;
      if (!acc || !acc.ok) { this.fail((acc && acc.error) || 'Nincs mikrofon-hozzáférés.'); return; }
      // A mikrofon csak a kifejezett indítás után nyílik meg, oldalbetöltéskor soha.
      var stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (this.ended) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      this.stream = stream;
      this.status.textContent = 'Kapcsolódás…';
      if (this.engine === 'agy') { await this.openPcm(b, stream); return; }
      var peer = this.peer = new RTCPeerConnection();
      stream.getAudioTracks().forEach(function (t) {
        t.enabled = false;
        t.onended = function () { if (!self.ended) self.fail('A mikrofon kapcsolata megszakadt.'); };
        peer.addTrack(t, stream);
      });
      this.meter(stream, 'input');
      this.channel = peer.createDataChannel('oai-events');
      peer.ontrack = function (ev) {
        if (self.ended) return;
        var remote = new MediaStream([ev.track]);
        self.audio.srcObject = remote;
        self.audio.play().catch(function () { if (!self.ended) self.play.hidden = false; });
        self.meter(remote, 'output');
        self.root.dataset.audio = 'on';
      };
      peer.onconnectionstatechange = function () {
        if (self.ended) return;
        var st = peer.connectionState;
        self.root.dataset.conn = st;
        if (st === 'connected') {
          clearTimeout(self.deadline);
          self.root.dataset.state = 'live';
          self.status.textContent = self.muted ? 'A mikrofon némítva.' : '';
          self.mute.disabled = false;
          stream.getAudioTracks().forEach(function (t) { t.enabled = !self.muted; });
          if (window.KapuAvatar) KapuAvatar.set('idle');
        } else if (st === 'failed' || st === 'disconnected' || st === 'closed') self.fail('Megszakadt a kapcsolat.');
      };
      var offer = await peer.createOffer();
      if (this.ended) return;
      await peer.setLocalDescription(offer);
      if (this.ended) return;
      this.requested = true;
      var r = await b.voice.start(this.engine, offer.sdp, this.convId);
      if (this.ended) { if (r && r.ok) b.voice.stop().catch(function () {}); return; }
      if (!r || !r.ok) { this.fail((r && r.error) || 'Az élő beszélgetés most nem indult el.'); return; }
      if (r.convId) this.convId = r.convId;
      await peer.setRemoteDescription({ type: 'answer', sdp: r.sdpAnswer });
    } catch (e) {
      if (this.ended) return;
      var n = e && e.name;
      this.fail(n === 'NotAllowedError' || n === 'SecurityError' ? 'A KapuMail nem kapott mikrofon-hozzáférést.' : n === 'NotFoundError' ? 'Nem található mikrofon.' : 'Az élő beszélgetés most nem indult el.');
    }
  };

  /* Antigravity: PCM-út a főfolyamaton át (voice-agy). A mikrofon csak a hívás felépülése után megy. */
  Session.prototype.openPcm = async function (b, stream) {
    var self = this;
    var ctx = this.ctx = new AudioContext();
    var src = ctx.createMediaStreamSource(stream);
    var out = this.outGain = ctx.createGain();
    out.connect(ctx.destination);
    this.pcm = { next: 0, sources: new Set(), mic: [], micLen: 0 };
    stream.getAudioTracks().forEach(function (t) {
      t.enabled = false;
      t.onended = function () { if (!self.ended) self.fail('A mikrofon kapcsolata megszakadt.'); };
    });
    this.meter(src, 'input');
    this.meter(out, 'output');
    this.requested = true;
    var r = await b.voice.start(this.engine, '', this.convId);
    if (this.ended) { if (r && r.ok) b.voice.stop().catch(function () {}); return; }
    if (!r || !r.ok) { this.fail((r && r.error) || 'Az élő beszélgetés most nem indult el.'); return; }
    if (r.convId) this.convId = r.convId;
    clearTimeout(this.deadline);
    this.root.dataset.state = 'live';
    this.root.dataset.conn = 'connected';
    this.root.dataset.audio = 'on';
    this.status.textContent = this.muted ? 'A mikrofon némítva.' : '';
    this.mute.disabled = false;
    stream.getAudioTracks().forEach(function (t) { t.enabled = !self.muted; });
    if (window.KapuAvatar) KapuAvatar.set('idle');
    if (ctx.state !== 'running') ctx.resume().catch(function () { if (!self.ended) self.play.hidden = false; });
    // Mikrofon → 16 kHz: a bemeneti mintákat ablakonként átlagoljuk (egyszerű aluláteresztés), 60 ms-onként küldjük.
    var proc = this.proc = ctx.createScriptProcessor(1024, 1, 1);
    var mute = this.procSink = ctx.createGain(); mute.gain.value = 0;
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    var ratio = (ctx.sampleRate || 48000) / 16000;
    proc.onaudioprocess = function (e) {
      if (self.ended || self.muted) return;
      var input = e.inputBuffer.getChannelData(0);
      var n = Math.floor(input.length / ratio); // a puffer végén maradó tört minta elmarad (≤0,15%)
      if (n <= 0) return;
      var pcm = new Int16Array(n);
      for (var i = 0; i < n; i++) {
        var a = i * ratio, from = Math.floor(a), to = Math.min(input.length, Math.floor(a + ratio)), sum = 0;
        for (var j = from; j < to; j++) sum += input[j];
        var v = to > from ? sum / (to - from) : 0;
        v = v < -1 ? -1 : v > 1 ? 1 : v;
        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      if (self.pcm.mic.length < 40) { self.pcm.mic.push(pcm); self.pcm.micLen += n; }
    };
    this.micTimer = setInterval(function () {
      var p = self.pcm;
      if (self.ended || !p || !p.micLen) return;
      var all = new Int16Array(p.micLen), off = 0;
      p.mic.forEach(function (c) { all.set(c, off); off += c.length; });
      p.mic = []; p.micLen = 0;
      var bytes = new Uint8Array(all.buffer), bin = '';
      for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      try { b.voice.sendAudio(btoa(bin)); } catch (e) { /* a következő darab megy */ }
    }, 60);
  };

  /* Kapu 24 kHz-es darabja: egymás után ütemezve; a mérő a kimeneti erősítőn át látja. */
  Session.prototype.playPcm = function (b64) {
    var p = this.pcm, ctx = this.ctx;
    if (!p || !ctx || this.ended) return;
    var bin;
    try { bin = atob(String(b64 || '')); } catch (e) { return; }
    var n = Math.floor(bin.length / 2);
    if (n <= 0) return;
    var bytes = new Uint8Array(n * 2);
    for (var i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
    var view = new DataView(bytes.buffer);
    var buf = ctx.createBuffer(1, n, 24000), ch = buf.getChannelData(0);
    for (var k = 0; k < n; k++) ch[k] = view.getInt16(k * 2, true) / 32768;
    var node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(this.outGain);
    p.sources.add(node);
    node.onended = function () { p.sources.delete(node); };
    var at = Math.max(ctx.currentTime + 0.02, p.next);
    node.start(at);
    p.next = at + buf.duration;
  };

  Session.prototype.clearPcm = function () {
    var p = this.pcm;
    if (!p) return;
    p.sources.forEach(function (n) { try { n.stop(); } catch (e) { /* már véget ért */ } });
    p.sources.clear();
    p.next = 0;
  };

  Session.prototype.onEvent = function (ev) {
    if (this.ended || !ev) return;
    if (ev.type === 'audio') { this.playPcm(ev.pcm); return; }
    if (ev.type === 'clear') { this.clearPcm(); return; }
    if (ev.type === 'state') {
      if (ev.state === 'error') this.fail(ev.text || 'Megszakadt az élő beszélgetés.');
      else if (ev.state === 'closed' && this.requested) { this.release(); this.status.textContent = 'A beszélgetés véget ért.'; this.root.dataset.state = 'ended'; }
      return;
    }
    if (ev.type === 'conv' && ev.convId) { this.convId = ev.convId; return; }
    if (ev.type === 'transcript') { this.addLine(ev.role, ev.text); return; }
    if (ev.type === 'think') {
      this.thinking = !!ev.on;
      this.root.classList.toggle('thinking', this.thinking);
      if (window.KapuAvatar) KapuAvatar.set(this.thinking ? 'think' : 'idle');
      return;
    }
    if (ev.type === 'confirm' && ev.id) { this.showConfirm(ev.id); return; }
    if (ev.type === 'dropped') {
      var t = String(ev.text || '');
      this.note('Túl sok kérdés várt egyszerre, ez kimaradt: „' + (t.length > 60 ? t.slice(0, 60) + '…' : t) + '” – kérdezd újra.');
    }
  };

  Session.prototype.addLine = function (role, text) {
    this.lines.push({ role: role, text: String(text || '') });
    this.lines = this.lines.slice(-2);
    var tr = this.tr;
    tr.replaceChildren.apply(tr, this.lines.map(function (l) {
      var p = el('p', l.role === 'user' ? 'me' : 'kapu');
      p.appendChild(el('strong', null, l.role === 'user' ? 'Te' : 'Kapu'));
      p.appendChild(document.createTextNode(' ' + l.text));
      return p;
    }));
  };

  Session.prototype.note = function (text) {
    var self = this;
    this.status.textContent = text;
    clearTimeout(this.noteT);
    this.noteT = setTimeout(function () { if (!self.ended && self.status.textContent === text) self.status.textContent = self.muted ? 'A mikrofon némítva.' : ''; }, 7000);
  };

  Session.prototype.showConfirm = function (id) {
    var self = this, b = bridge();
    if (!window.KapuView || typeof KapuView.confirmCard !== 'function') return;
    this.confirm.replaceChildren();
    this.root.classList.add('has-confirm');
    KapuView.confirmCard(this.confirm, id, {
      onApproved: function () { b.voice.text('Jóváhagytam.').catch(function () {}); },
      onDeclined: function () { b.voice.declined().catch(function () {}); },
      onDone: function () { setTimeout(function () { if (!self.ended) { self.root.classList.remove('has-confirm'); self.confirm.replaceChildren(); } }, 2400); },
    });
  };

  Session.prototype.toggleMute = function () {
    this.muted = !this.muted;
    var m = this.muted;
    (this.stream ? this.stream.getAudioTracks() : []).forEach(function (t) { t.enabled = !m; });
    this.mute.setAttribute('aria-pressed', String(m));
    this.mute.setAttribute('aria-label', m ? 'Mikrofon visszakapcsolása' : 'Mikrofon némítása');
    this.mute.title = this.mute.getAttribute('aria-label');
    this.mute.classList.toggle('is-muted', m);
    this.mute.innerHTML = m ? SVG.micOff : SVG.mic;
    this.status.textContent = m ? 'A mikrofon némítva.' : '';
  };

  /* Passzív mérés: a mikrofon soha nem megy a hangszóróra. A spektrum tükrözött, 256 sávos
     hulláma: a mély hangok középen, kifelé a magasak; beszélő felhasználó elsőbbséget kap. */
  Session.prototype.meter = function (stream, side) {
    var self = this;
    try {
      var ctx = this.ctx = this.ctx || new AudioContext();
      var old = this.meters[side];
      if (old) { old.an.disconnect(); if (old.own) old.node.disconnect(); }
      var an = ctx.createAnalyser(); an.fftSize = 256; an.smoothingTimeConstant = 0.65;
      // MediaStream (WebRTC, mikrofon) vagy kész hangcsomópont (PCM-út: a kimeneti erősítő, a mikrofonforrás).
      var own = typeof MediaStream !== 'undefined' && stream instanceof MediaStream;
      var node = own ? ctx.createMediaStreamSource(stream) : stream;
      node.connect(an);
      this.meters[side] = { an: an, node: node, own: own, data: new Uint8Array(an.fftSize), spec: new Uint8Array(an.frequencyBinCount) };
      if (this.frame) return;
      var prev = 0, lvl = 0, half = BARS / 2;
      var heights = new Float32Array(half).fill(2);
      var cv = this.canvas, g = cv.getContext('2d');
      var draw = function (time) {
        if (self.ended) return;
        var dt = Math.min(50, Math.max(0, time - prev)); prev = time;
        var smooth = function (c, t, a, r) { return c + (t - c) * (1 - Math.exp(-dt / (t > c ? a : r))); };
        var levels = { input: 0, output: 0 };
        ['input', 'output'].forEach(function (ch) {
          var m = self.meters[ch];
          var on = ch === 'input' ? !self.muted && self.stream && self.stream.getAudioTracks().some(function (t) { return t.enabled; }) : self.pcm ? self.pcm.sources.size > 0 : !self.audio.paused;
          if (!m || !on) return;
          m.an.getByteTimeDomainData(m.data);
          m.an.getByteFrequencyData(m.spec);
          var sum = 0;
          for (var i = 0; i < m.data.length; i++) { var v = (m.data[i] - 128) / 128; sum += v * v; }
          levels[ch] = Math.sqrt(sum / m.data.length);
        });
        var src = levels.input > 0.015 ? 'input' : levels.output > 0.008 ? 'output' : 'none';
        var spec = src === 'none' ? null : self.meters[src].spec;
        lvl = smooth(lvl, src === 'none' ? 0 : Math.min(1, levels[src] * 3), 240, 600);
        if (src !== 'none' || lvl < 0.005) {
          if (self.root.dataset.src !== src) {
            self.root.dataset.src = src;
            if (window.KapuAvatar && !self.thinking) KapuAvatar.set(src === 'output' ? 'talk' : src === 'input' ? 'listen' : 'idle');
          }
        }
        self.root.style.setProperty('--vl', lvl.toFixed(3));
        if (window.KapuAvatar) KapuAvatar.level(self.root.dataset.src === 'output' ? lvl : 0);
        // rajzolás
        var dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);
        var grad = g.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, '#f4a6c6'); grad.addColorStop(0.3, '#9b7bff'); grad.addColorStop(0.5, '#7c5cff'); grad.addColorStop(0.7, '#9b7bff'); grad.addColorStop(1, '#f4a6c6');
        g.fillStyle = grad;
        g.globalAlpha = src === 'none' && lvl < 0.01 ? 0.35 : 0.95;
        var step = w / BARS, bw = Math.max(1, Math.min(3, step - 1)), mid = h / 2;
        for (var i = 0; i < half; i++) {
          var target = 2 + ((spec ? spec[i] : 0) / 255) * (h - 2);
          var bh = heights[i] = smooth(heights[i], target, 45, 180);
          var xl = (half - 1 - i) * step + (step - bw) / 2, xr = (half + i) * step + (step - bw) / 2;
          g.fillRect(xl, mid - bh / 2, bw, bh);
          g.fillRect(xr, mid - bh / 2, bw, bh);
        }
        self.frame = requestAnimationFrame(draw);
      };
      ctx.resume().catch(function () {});
      this.frame = requestAnimationFrame(function (t) { prev = t; draw(t); });
    } catch (e) { /* a kapcsolat nem függ a megjelenítéstől */ }
  };

  Session.prototype.fail = function (msg) {
    if (this.ended) return;
    this.release();
    this.root.dataset.state = 'error';
    this.status.textContent = '';
    this.error.textContent = msg || 'Az élő beszélgetés megszakadt.';
  };

  Session.prototype.release = function () {
    if (this.ended) return;
    this.ended = true;
    if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); }); // a felvétel előbb áll le, mint bármi más
    try { if (this.channel) this.channel.close(); } catch (e) { /* már zárva */ }
    try { if (this.peer) this.peer.close(); } catch (e) { /* már zárva */ }
    this.audio.pause(); this.audio.srcObject = null;
    clearInterval(this.micTimer);
    if (this.proc) { this.proc.onaudioprocess = null; try { this.proc.disconnect(); } catch (e) { /* már leválasztva */ } }
    this.clearPcm();
    cancelAnimationFrame(this.frame);
    var ms = this.meters;
    Object.keys(ms).forEach(function (k) { try { ms[k].node.disconnect(); ms[k].an.disconnect(); } catch (e) { /* már leválasztva */ } });
    if (this.ctx) this.ctx.close().catch(function () {});
    clearTimeout(this.deadline);
    this.mute.disabled = true;
    this.play.hidden = true;
    this.root.dataset.src = 'none';
    this.root.style.setProperty('--vl', '0');
    if (window.KapuAvatar) { KapuAvatar.level(0); KapuAvatar.set('idle'); }
    var b = bridge();
    if (b && this.requested) b.voice.stop().catch(function () {});
  };

  Session.prototype.close = function () {
    if (this.closed) return;
    this.closed = true;
    this.release();
    document.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('pagehide', this.onHide);
    document.body.classList.remove('kvo-on');
    var root = this.root;
    root.classList.remove('in');
    setTimeout(function () { root.remove(); }, 220);
    if (cur === this) cur = null;
    try { if (this.focus && this.focus.focus) this.focus.focus(); } catch (e) { /* nincs fókusz */ }
    if (typeof this.opts.onClose === 'function') this.opts.onClose(this.convId);
  };

  window.KapuVoice = {
    /* start({engine, convId?, onClose(convId)}) – a beviteli doboz mikrofon gombja hívja. */
    start: function (opts) {
      opts = opts || {};
      if (!bridge()) { if (window.toast) toast('Az élő beszélgetés csak az asztali alkalmazásban érhető el.', true); return null; }
      if (cur) return cur;
      if (opts.engine !== 'codex' && opts.engine !== 'agy') { if (window.toast) toast('Hangon ChatGPT-vel vagy Antigravityvel beszélhetsz.', true); return null; }
      cur = new Session(opts);
      // Windowson nincs Unix pszeudoterminál: az Antigravity-hang ott még nem megy (a főfolyamat is ezt mondja).
      if (opts.engine === 'agy' && document.documentElement.getAttribute('data-os') === 'win32') {
        var s = cur;
        document.body.appendChild(s.root); document.body.classList.add('kvo-on');
        document.addEventListener('keydown', s.onKey, true);
        requestAnimationFrame(function () { s.root.classList.add('in'); s.endBtn.focus(); });
        s.fail('Antigravity-hang Windowson még nem elérhető.');
        return cur;
      }
      cur.open();
      return cur;
    },
    open: function (engine) { return this.start({ engine: engine }); },
    active: function () { return cur !== null; },
    stop: function () { if (cur) cur.close(); },
  };
})();
