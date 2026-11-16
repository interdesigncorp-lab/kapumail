// Szűk, típusos híd. A felület nem kap Node-hozzáférést, és nyers titkot (jelszót, TOTP-seedet)
// elmentés után SOHA nem tud visszaolvasni a titoktárból.
const { contextBridge, ipcRenderer } = require('electron');
// Az operációs rendszer jelzése a felületnek (CSS: html[data-os="darwin"] – liquid glass csak macOS-en).
try { document.documentElement.setAttribute('data-os', (typeof process !== 'undefined' && process.platform) || ''); } catch {}
contextBridge.exposeInMainWorld('iratkapuDesktop', {
  info: () => ipcRenderer.invoke('desktop:info'),
  setup: {
    get: () => ipcRenderer.invoke('setup:get'),
    set: url => ipcRenderer.invoke('setup:set', String(url)),
    mode: (mode, terms) => ipcRenderer.invoke('setup:mode', String(mode), terms === true),
    legal: doc => ipcRenderer.invoke('setup:legal', String(doc)),
  },
  connector: {
    status: () => ipcRenderer.invoke('connector:status'),
    choose: () => ipcRenderer.invoke('connector:choose'),
    doctor: () => ipcRenderer.invoke('connector:doctor'),
    mailboxes: () => ipcRenderer.invoke('connector:mailboxes'),
    list: since => ipcRenderer.invoke('connector:list', since || null),
  },
  portal: {
    credInfo: key => ipcRenderer.invoke('portal:credInfo', String(key)),
    saveCreds: (key, data) => ipcRenderer.invoke('portal:saveCreds', String(key), {
      mode: String((data && data.mode) || 'totp'),
      username: data && typeof data.username === 'string' ? data.username : '',
      password: data && typeof data.password === 'string' ? data.password : '',
      totpSeed: data && typeof data.totpSeed === 'string' ? data.totpSeed : '',
    }),
    copyCreds: (fromKey, toKey) => ipcRenderer.invoke('portal:copyCreds', String(fromKey), String(toKey)),
    deleteCreds: key => ipcRenderer.invoke('portal:deleteCreds', String(key)),
    totpPreview: raw => ipcRenderer.invoke('portal:totpPreview', String(raw || '')),
    decodeQr: dataUrl => ipcRenderer.invoke('portal:decodeQr', String(dataUrl || '')),
    totpCode: key => ipcRenderer.invoke('portal:totpCode', String(key)),
  },
  live: {
    status: () => ipcRenderer.invoke('live:status'),
    // A második paraméter a kapcsolat kulcsa: a munkamenet ehhez a kapcsolathoz tartozik (status().portalId).
    start: (mode, portalKey) => ipcRenderer.invoke('live:start', String(mode), portalKey == null ? null : String(portalKey)),
    connectAuto: key => ipcRenderer.invoke('live:connectAuto', String(key)),
    windowVisible: vis => ipcRenderer.invoke('live:windowVisible', Boolean(vis)),
    close: () => ipcRenderer.invoke('live:close'),
    mailboxes: () => ipcRenderer.invoke('live:mailboxes'),
    list: (since, filter, opts) => ipcRenderer.invoke('live:list', since || null, filter || null, opts && opts.sent === true ? { sent: true } : null),
    listHttp: opts => ipcRenderer.invoke('live:listHttp', opts && opts.sent === true ? { sent: true } : null),
    // Csak az irat azonosítója megy át: hogy mit szabad letölteni, azt a főfolyamat a szervertől kérdezi meg.
    downloadOne: req => ipcRenderer.invoke('live:downloadOne', {
      messageId: String((req && req.messageId) || ''),
      auto: !!(req && req.auto),
      viaRuleId: Number.isInteger(req && req.viaRuleId) ? req.viaRuleId : null,
    }),
    onProgress: cb => { ipcRenderer.removeAllListeners('live:progress'); if (typeof cb === 'function') ipcRenderer.on('live:progress', (_e, p) => cb(p)); },
  },
  // ADR-008 C: felügyelet nélküli, többügyfeles listázás (böngészőablak nélkül)
  // NAV ügyfélportál: a belépő saját nevében olvasható adatok (csak GET). Képviseletet csak akkor vált, ha célokat kap.
  // `clientIds` (nem kötelező): azoknak az ügyfeleknek az azonosítói, akikre a szerver szerint képviseletet lehet váltani (B kör)
  // `queries` (nem kötelező): a beadott bevallások lekérdezése is fusson (C kör; a NAV oldalán lekérdezést hoz létre)
  nav: { readOwn: (key, clientIds, queries) => ipcRenderer.invoke('nav:readOwn', String(key), Array.isArray(clientIds) ? clientIds.map(String) : null, queries === true),
    // letölthető kimutatások egy adózóra (target: adószám-törzs / adóazonosító jel, vagy null a belépő saját maga)
    exports: (key, target, kinds) => ipcRenderer.invoke('nav:exports', String(key), target == null ? null : String(target), Array.isArray(kinds) ? kinds.map(String) : null),
    onProgress: cb => { ipcRenderer.removeAllListeners('nav:progress'); if (typeof cb === 'function') ipcRenderer.on('nav:progress', (_e, p) => cb(p)); } },
  // Önkormányzati portál (ASP): osztott képernyős szinkronablak ügyféllistával és pipákkal + saját neves háttér-olvasás (csak GET)
  asp: {
    readWindow: opts => ipcRenderer.invoke('asp:readWindow', opts && typeof opts === 'object' ? {
      portalKey: opts.portalKey == null ? null : String(opts.portalKey),
      items: Array.isArray(opts.items) ? opts.items.slice(0, 500).map(x => ({
        own: !!(x && x.own),
        name: String((x && x.name) || '').slice(0, 140),
        tax: String((x && x.tax) || '').slice(0, 40),
        doneToday: !!(x && x.doneToday),
        summary: String((x && x.summary) || '').slice(0, 120),
      })) : [],
    } : null),
    readOwnAuto: key => ipcRenderer.invoke('asp:readOwnAuto', String(key || '')),
    onUpdated: cb => { ipcRenderer.removeAllListeners('asp:updated'); ipcRenderer.on('asp:updated', () => cb()); },
  },
  auto: {
    clients: () => ipcRenderer.invoke('auto:clients'),
    run: (keys, filters, forceFull, opts) => ipcRenderer.invoke('auto:run', Array.isArray(keys) ? keys.map(String) : null, filters || null, forceFull || null, opts && opts.sent === true ? { sent: true } : null),
    ack: (key, full) => ipcRenderer.invoke('auto:ack', String(key), full === true),
    // Kézi letöltés böngészőablak nélkül: a főfolyamat kér engedélyt a szervertől, és nem automatikus típusnál maga kérdez rá.
    downloadManual: (key, req) => ipcRenderer.invoke('auto:downloadManual', String(key), { messageId: String((req && req.messageId) || ''), sent: !!(req && req.sent) }),
    // Csak az irat azonosítója megy át; hogy letölthető-e, azt a főfolyamat a szervertől kérdezi meg, és csak automatikus típust enged.
    downloadOne: (key, req) => ipcRenderer.invoke('auto:downloadOne', String(key), { messageId: String((req && req.messageId) || ''), viaRuleId: Number.isInteger(req && req.viaRuleId) ? req.viaRuleId : null }),
    onProgress: cb => { ipcRenderer.removeAllListeners('auto:progress'); if (typeof cb === 'function') ipcRenderer.on('auto:progress', (_e, p) => cb(p)); },
  },
  lock: {
    get: () => ipcRenderer.invoke('lock:get'),
    enable: pin => ipcRenderer.invoke('lock:enable', String(pin)),
    disable: pin => ipcRenderer.invoke('lock:disable', pin ? String(pin) : null),
    set: patch => ipcRenderer.invoke('lock:set', { touchId: patch.touchId, idleMin: patch.idleMin }),
    now: () => ipcRenderer.invoke('lock:now'),
  },
  notify: {
    show: n => ipcRenderer.invoke('notify:show', { id: Number(n && n.id) || 0, title: String((n && n.title) || '').slice(0, 120), body: String((n && n.body) || '').slice(0, 400) }),
    onClick: cb => { ipcRenderer.removeAllListeners('notify:click'); ipcRenderer.on('notify:click', (_e, id) => cb(Number(id))); },
  },
  schedule: {
    get: () => ipcRenderer.invoke('schedule:get'),
    set: on => ipcRenderer.invoke('schedule:set', on === true),
    save: cfg => ipcRenderer.invoke('schedule:save', cfg),
    due: () => ipcRenderer.invoke('schedule:due'),
    setCalendar: (work, rest) => ipcRenderer.invoke('schedule:setCalendar', String(work || ''), String(rest || '')),
    ran: () => ipcRenderer.invoke('schedule:ran'),
  },
  background: {
    get: () => ipcRenderer.invoke('background:get'),
    set: on => ipcRenderer.invoke('background:set', on === true),
  },
  // MCP-közvetítő (ADR-013): be/ki, állapot és a ChatGPT-be beírandó cím. A titkot a felület nem kapja meg.
  relay: {
    get: () => ipcRenderer.invoke('relay:get'),
    set: on => ipcRenderer.invoke('relay:set', on === true),
  },
  // Kapu-chat (ADR-014). Kinek az előzményei: a főfolyamat a szervertől kérdezi (GET /api/kapu/me), a felület nem adja meg.
  // Minden hívás {ok:true, ...} vagy {ok:false, error}: status → {engines:[…]}, config → {on, engine, readAloud, mode, hasToken},
  // list → {items:[{id,title,engine,updatedAt}]}, get → {conv:{id,title,engine,sessionId,messages}}, send → {convId}.
  // Az események (session / activity / confirm / final / error) convId-vel érkeznek. Egy beszélgetésben egy kör fut:
  // az új send a futót megszakítja és lecseréli, ezért a felület futás közben tiltsa a Küldést.
  kapu: {
    status: () => ipcRenderer.invoke('kapu:status'),
    signIn: engine => ipcRenderer.invoke('kapu:signIn', String(engine)),
    cancelSignIn: () => ipcRenderer.invoke('kapu:cancelSignIn'),
    signInState: () => ipcRenderer.invoke('kapu:signInState'),
    signInCode: code => ipcRenderer.invoke('kapu:signInCode', String(code || '').slice(0, 600)),
    signInOpen: url => ipcRenderer.invoke('kapu:signInOpen', String(url || '').slice(0, 4000)),
    config: () => ipcRenderer.invoke('kapu:config'),
    // Kikapcsoláskor a főfolyamat törli a gépen tárolt Kapu-tokent, itt pedig a felület munkamenetével a szerveren
    // is visszavonjuk (DELETE /api/kapu/token); újra bekapcsoláskor az ensureToken friss tokent kér.
    setConfig: async c => {
      const r = await ipcRenderer.invoke('kapu:setConfig', {
        ...(c && 'on' in c ? { on: c.on === true } : {}),
        ...(c && 'engine' in c ? { engine: c.engine == null ? null : String(c.engine) } : {}),
        ...(c && 'readAloud' in c ? { readAloud: c.readAloud === true } : {}),
        ...(c && c.model && typeof c.model === 'object' ? { model: { engine: String(c.model.engine || ''), id: c.model.id == null ? null : String(c.model.id).slice(0, 80) } } : {}),
        ...(c && 'prompts' in c ? { prompts: c.prompts === null ? null : Array.isArray(c.prompts) ? c.prompts.slice(0, 50).map(p => ({ id: String((p && p.id) || '').slice(0, 48), title: String((p && p.title) || '').slice(0, 120), prompt: String((p && p.prompt) || '').slice(0, 2000) })) : 'invalid' } : {}),
      });
      if (r && r.ok && c && 'on' in c && c.on !== true) {
        try {
          const xsrf = decodeURIComponent((document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || '');
          await fetch('/api/kapu/token', { method: 'DELETE', credentials: 'same-origin', headers: { Accept: 'application/json', 'X-XSRF-TOKEN': xsrf } });
        } catch { /* nincs kapcsolat: a gépen már nincs token, a szerveren az admin vonhatja vissza */ }
      }
      return r;
    },
    // Ha még nincs token, a felület munkamenetével kér egyet (POST /api/kapu/token), és a főfolyamat a titoktárba teszi –
    // csak ha a szerver ugyanannak a felhasználónak adta ki. A token a felülethez nem jut el. renew: true → akkor is újat kér.
    ensureToken: async opts => {
      const st = await ipcRenderer.invoke('kapu:tokenState');
      if (!st || !st.ok) return st;
      if (st.has && !(opts && opts.renew === true)) return { ok: true };
      let r, j;
      try {
        const xsrf = decodeURIComponent((document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || '');
        r = await fetch('/api/kapu/token', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf }, body: JSON.stringify({ device: st.device }) });
        j = await r.json().catch(() => ({}));
      } catch { return { ok: false, error: 'A Kapu-token most nem kérhető: nincs kapcsolat a szerverrel.' }; }
      if (!r.ok || !j || typeof j.token !== 'string') return { ok: false, error: (j && typeof j.message === 'string' && j.message) || 'A Kapu-token most nem kérhető.' };
      return ipcRenderer.invoke('kapu:storeToken', { token: j.token, officeId: j.officeId, userId: j.userId });
    },
    list: () => ipcRenderer.invoke('kapu:list'),
    get: id => ipcRenderer.invoke('kapu:get', String(id)),
    remove: id => ipcRenderer.invoke('kapu:remove', String(id)),
    clear: () => ipcRenderer.invoke('kapu:clear'),
    send: req => ipcRenderer.invoke('kapu:send', { convId: req && req.convId != null ? String(req.convId) : null, text: String((req && req.text) || ''), model: req && req.model ? String(req.model).slice(0, 80) : null }),
    // Modellválasztó: motoronként {options:[{id,label,hint}], default, selected}; a beszélgetés modellje (a főfolyamat ellenőrzi).
    models: () => ipcRenderer.invoke('kapu:models'),
    setModel: (convId, model) => ipcRenderer.invoke('kapu:setModel', { convId: String(convId), model: String(model || '').slice(0, 80) }),
    cancel: convId => ipcRenderer.invoke('kapu:cancel', String(convId)),
    onEvent: cb => { ipcRenderer.removeAllListeners('kapu:event'); ipcRenderer.on('kapu:event', (_e, ev) => cb(ev)); },
    // Élő hang. prepare: macOS mikrofonengedély. ChatGPT (WebRTC): start a felület SDP-ajánlatára {ok, sdpAnswer, convId}.
    // Antigravity (PCM): start(engine 'agy') → {ok, convId, mode:'pcm'}; sendAudio: 16 kHz mono s16le base64 ~60 ms-onként
    // (válasz nélkül); Kapu hangja `audio` {pcm: 24 kHz mono s16le base64} eseményként, `clear`-re a lejátszás leáll.
    // További események: state (closed/error) · transcript {role,text} · speaking {role} · think {on} · conv {convId} · confirm {id, convId} · dropped {text}.
    voice: {
      prepare: () => ipcRenderer.invoke('kapu:micAccess'),
      start: (engine, sdpOffer, convId) => ipcRenderer.invoke('kapu:voiceStart', { engine: String(engine || ''), sdp: String(sdpOffer || ''), convId: convId == null ? null : String(convId) }),
      stop: () => ipcRenderer.invoke('kapu:voiceStop'),
      text: t => ipcRenderer.invoke('kapu:voiceText', String(t || '')),
      declined: () => ipcRenderer.invoke('kapu:voiceDeclined'),
      sendAudio: b64 => { if (typeof b64 === 'string' && b64 && b64.length <= 200000) ipcRenderer.send('kapu:voiceAudio', b64); },
      onEvent: cb => { ipcRenderer.removeAllListeners('kapu:voice'); ipcRenderer.on('kapu:voice', (_e, ev) => cb(ev)); },
    },
  },
  // Alkalmazás-frissítő: nyilvános latest.json ellenőrzés, SHA-256 + kódaláírás ellenőrzés, előrehaladás és újraindítás.
  updater: {
    get: () => ipcRenderer.invoke('updater:get'),
    check: () => ipcRenderer.invoke('updater:check'),
    install: () => ipcRenderer.invoke('updater:install'),
    restart: () => ipcRenderer.invoke('updater:restart'),
    onState: cb => { ipcRenderer.removeAllListeners('updater:state'); ipcRenderer.on('updater:state', (_e, st) => cb(st)); },
    onProgress: cb => { ipcRenderer.removeAllListeners('updater:progress'); ipcRenderer.on('updater:progress', (_e, p) => cb(p)); },
  },
  vault: {
    has: ref => ipcRenderer.invoke('vault:has', String(ref)),
    set: (ref, secret) => ipcRenderer.invoke('vault:set', String(ref), String(secret)),
    delete: ref => ipcRenderer.invoke('vault:delete', String(ref)),
  },
});
