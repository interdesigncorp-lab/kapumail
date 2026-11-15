'use strict';
// Kapu-chat: a beszélgetések helyi tárolója. Minden beszélgetés egy titkosított fájl (`<id>.bin`) a
// felhasználó és az iroda saját mappájában (`userData/kapu/<officeId>-<userId>/`). A titkosítást a hívó
// adja (az asztali appban a safeStorage, azaz Keychain / DPAPI), így a modul Electron nélkül tesztelhető.
// Tárolt: cím (az első kérdés első 60 karaktere), motor, modell (a választóból; null: a motor alapmodellje),
// a CLI munkamenet-azonosítója, üzenetek (a Kapu-válasznál az is, melyik modell adta).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ENGINES } = require('./providers');
const { MODEL_RE } = require('./models');
const cleanModel = (m) => (typeof m === 'string' && MODEL_RE.test(m) ? m : null);
const ROLES = ['user', 'kapu', 'system'];
const ID = /^[a-f0-9]{32}$/;
const TITLE_LEN = 60;
const MAX_TEXT = 100000;
const MAX_MESSAGES = 1000;

const cleanTitle = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, TITLE_LEN);

function createStore({ dir, encrypt, decrypt }) {
  if (!dir || typeof encrypt !== 'function' || typeof decrypt !== 'function') throw new Error('A tárolóhoz mappa és titkosítás kell.');
  const file = (id) => path.join(dir, `${id}.bin`);
  const ensureDir = () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  function read(id) {
    if (typeof id !== 'string' || !ID.test(id)) return null;
    let raw;
    try { raw = fs.readFileSync(file(id)); } catch { return null; }
    try {
      const c = JSON.parse(decrypt(raw));
      return c && c.id === id && Array.isArray(c.messages) ? c : null;
    } catch { return null; } // sérült vagy más kulccsal titkosított fájl
  }

  // Atomi írás: ideiglenes fájlba, majd átnevezés, hogy egy megszakadt írás ne rontsa el a beszélgetést.
  function write(c) {
    ensureDir();
    const tmp = `${file(c.id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, encrypt(JSON.stringify(c)), { mode: 0o600 });
    fs.renameSync(tmp, file(c.id));
  }

  function must(id) {
    const c = read(id);
    if (!c) throw new Error('Nincs ilyen beszélgetés.');
    return c;
  }

  return {
    dir,
    create(engine, model = null) {
      if (!ENGINES.includes(engine)) throw new Error('Ismeretlen motor.');
      const now = Date.now();
      const c = { id: crypto.randomBytes(16).toString('hex'), title: '', engine, model: cleanModel(model), sessionId: null, createdAt: now, updatedAt: now, messages: [] };
      write(c);
      return c.id;
    },
    list() {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return []; }
      return names
        .filter((n) => n.endsWith('.bin'))
        .map((n) => read(n.slice(0, -4)))
        .filter(Boolean)
        .map((c) => ({ id: c.id, title: c.title, engine: c.engine, model: cleanModel(c.model), updatedAt: c.updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    get(id) {
      const c = read(id);
      return c ? { id: c.id, title: c.title, engine: c.engine, model: cleanModel(c.model), sessionId: c.sessionId || null, messages: c.messages } : null;
    },
    append(id, msg) {
      const c = must(id);
      if (!msg || !ROLES.includes(msg.role)) throw new Error('Ismeretlen üzenetszerep.');
      if (typeof msg.text !== 'string' || !msg.text.trim()) throw new Error('Üres üzenet.');
      const m = { role: msg.role, text: msg.text.slice(0, MAX_TEXT), at: Date.now() };
      if (typeof msg.confirmId === 'string' && msg.confirmId) m.confirmId = msg.confirmId.slice(0, 100);
      if (msg.voice === true) m.voice = true; // élő beszélgetésben hangzott el
      if (cleanModel(msg.model)) m.model = msg.model; // a válasz modellje (a fejlécben látszik)
      c.messages.push(m);
      if (c.messages.length > MAX_MESSAGES) c.messages.splice(0, c.messages.length - MAX_MESSAGES);
      if (!c.title && m.role === 'user') c.title = cleanTitle(m.text);
      c.updatedAt = m.at;
      write(c);
      return m;
    },
    /** A beszélgetés modellje (a választóból); null: a motor alapmodellje. Nem módosítja az updatedAt-et. */
    setModel(id, model) {
      const c = must(id);
      if (model !== null && !cleanModel(model)) throw new Error('Érvénytelen modell.');
      c.model = model;
      write(c);
      return true;
    },
    setSession(id, sessionId) {
      const c = read(id);
      if (!c) return false;
      c.sessionId = typeof sessionId === 'string' && sessionId ? sessionId.slice(0, 200) : null;
      write(c);
      return true;
    },
    /** Törli a beszélgetést; visszaadja a motorját és munkamenetét, hogy a CLI-oldali fájlok is törölhetők legyenek. */
    remove(id) {
      const c = read(id);
      if (typeof id !== 'string' || !ID.test(id)) return null;
      fs.rmSync(file(id), { force: true });
      return c ? { id, engine: c.engine, sessionId: c.sessionId || null } : null;
    },
    clear() {
      const gone = [];
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return gone; }
      for (const n of names) {
        if (n.endsWith('.bin') && ID.test(n.slice(0, -4))) {
          const c = read(n.slice(0, -4));
          if (c) gone.push({ id: c.id, engine: c.engine, sessionId: c.sessionId || null });
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
      return gone;
    },
  };
}

module.exports = { createStore, ENGINES, ROLES, TITLE_LEN };
