'use strict';
// Szakmai MCP (jogi és könyvelői eszközök): az 1 órás hozzáférési token a KapuMail-apptól
// (GET /api/kapu/premium?device=<uuid>, ami a billingtől kéri: automatikus 14 napos próba vagy előfizetés).
// A token a kör MCP-konfigjába kerül második szerverként; ha nincs, a kör nélküle fut.
// Elektron nélküli modul: a lekérés, az óra és az időkorlát tesztből állítható.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EARLY_SEC = 300; // ennyivel a lejárat előtt már újat kér
const TIMEOUT_MS = 6000;
// Sikertelen lekérés után ennyi ideig nem kérdez újra: a billing kiesése így nem lassít minden kört.
const RETRY_UNAVAILABLE_MS = 90_000;
const RETRY_REFUSED_MS = 60_000; // 204 (nincs próba/előfizetés stb.): hamar kiderül, ha közben előfizetett
const SUBSCRIBE = 'A jogi és könyvelői eszközökhöz előfizetés kell.';
// Amit a felhasználónak egyszer jelezni kell; a többi ok (pl. a billing nem érhető el) csendes.
const NOTICES = {
  no_entitlement: SUBSCRIBE,
  revoked: SUBSCRIBE,
  trial_limit: `Erről a hálózatról már több próbaidő is indult. ${SUBSCRIBE}`,
  device_limit: 'Az előfizetésed már 3 eszközön használja a szakmai eszközöket.',
};

/** Az eszköz állandó azonosítója: `<userData>/kapu/device-id` (egyszer generált UUID, 0600). */
function deviceIdFor(userData) {
  const dir = path.join(userData, 'kapu');
  const file = path.join(dir, 'device-id');
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (UUID4.test(v)) return v;
  } catch { /* még nincs */ }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = crypto.randomUUID();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, id, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return id;
}

function valid(j) {
  if (!j || typeof j !== 'object') return null;
  if (typeof j.token !== 'string' || !j.token || typeof j.url !== 'string' || !Number.isInteger(j.exp)) return null;
  try { if (new URL(j.url).protocol !== 'https:') return null; } catch { return null; }
  return {
    value: { url: j.url, token: j.token, ent: Array.isArray(j.ent) ? j.ent.filter((e) => typeof e === 'string') : [], plan: typeof j.plan === 'string' ? j.plan : '' },
    exp: j.exp,
  };
}

/**
 * create({fetchPremium(deviceId) → Promise<{status, json?, reason?}>, deviceId, now?, timeoutMs?})
 *   → { get() → Promise<{url, token, ent, plan}|null>, reason() → string|null, notice() → string|null, reset() }
 * A get() soha nem dob. A notice() egy okot csak egyszer ad vissza (reset() után újra).
 */
function create({ fetchPremium, deviceId, now = Date.now, timeoutMs = TIMEOUT_MS }) {
  let cached = null;
  let lastReason = null;
  let retryAt = 0;
  const noticed = new Set();
  const refused = (reason) => {
    lastReason = reason;
    retryAt = now() + (reason === 'unavailable' ? RETRY_UNAVAILABLE_MS : RETRY_REFUSED_MS);
    return null;
  };

  async function get() {
    if (cached && cached.exp - EARLY_SEC > Math.floor(now() / 1000)) return cached.value;
    cached = null;
    if (now() < retryAt) return null;
    let r;
    try {
      let timer;
      const limit = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
      r = await Promise.race([Promise.resolve().then(() => fetchPremium(deviceId)), limit]);
      clearTimeout(timer);
    } catch {
      r = null;
    }
    if (!r) return refused('unavailable');
    if (r.status === 204) return refused(typeof r.reason === 'string' && r.reason ? r.reason : 'unavailable');
    const v = r.status === 200 ? valid(r.json) : null;
    if (!v) return refused('unavailable');
    lastReason = null;
    retryAt = 0;
    cached = v;
    return v.value;
  }

  function notice() {
    const text = lastReason ? NOTICES[lastReason] : undefined;
    if (!text || noticed.has(lastReason)) return null;
    noticed.add(lastReason);
    return text;
  }

  return {
    get,
    reason: () => lastReason,
    notice,
    reset() { cached = null; lastReason = null; retryAt = 0; noticed.clear(); },
  };
}

module.exports = { create, deviceIdFor, NOTICES };
