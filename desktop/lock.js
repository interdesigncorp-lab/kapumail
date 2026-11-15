// Alkalmazászár: PIN-kezelés és próbálkozás-korlátozás. Tiszta logika, Electron nélkül tesztelhető.
// A zár a felületet védi (nyitva hagyott gép ellen); a titoktár kulcsát nem köti a PIN-hez vagy az ujjlenyomathoz.
const crypto = require('crypto');

const IDLE_CHOICES = [0, 1, 5, 15, 60]; // perc; 0 = tétlenség miatt nem zár
const okPin = pin => typeof pin === 'string' && pin.length >= 4 && pin.length <= 64;

function hashPin(pin, salt = crypto.randomBytes(16)) {
  if (!okPin(pin)) throw new Error('A PIN 4–64 karakter legyen.');
  return { salt: salt.toString('base64'), hash: crypto.scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64') };
}

function verifyPin(pin, rec) {
  if (!okPin(pin) || !rec || !rec.salt || !rec.hash) return false;
  const want = Buffer.from(rec.hash, 'base64');
  const got = crypto.scryptSync(pin, Buffer.from(rec.salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// Helyreállító kód: a PIN beállításakor egyszer jelenik meg; elfelejtett PIN esetén ezzel állítható be új.
// 20 karakter a félreolvasható jelek (0, O, 1, I, L) nélkül: kb. 99 bit. Csak a lenyomata tárolódik, mint a PIN-nek.
const RC_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRecoveryCode(bytes = crypto.randomBytes(40)) {
  let out = '';
  for (const b of bytes) { if (b < 248 && out.length < 20) out += RC_ABC[b % 31]; } // 248 = 8 × 31: torzítás nélkül
  if (out.length < 20) return newRecoveryCode();
  return out.match(/.{5}/g).join('-');
}
// Beíráskor a kis- és nagybetű, a szóköz és a kötőjel nem számít.
const cleanRecovery = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashRecovery = (code, salt) => hashPin(cleanRecovery(code), salt);
const verifyRecovery = (code, rec) => cleanRecovery(code).length === 20 && verifyPin(cleanRecovery(code), rec);

// 5 hibás PIN után várakozás: 30 mp, majd duplázódik, legfeljebb 15 perc.
class Throttle {
  constructor(now = () => Date.now()) { this.now = now; this.fails = 0; this.until = 0; }
  waitMs() { return Math.max(0, this.until - this.now()); }
  fail() { this.fails++; if (this.fails >= 5) this.until = this.now() + Math.min(15 * 60000, 30000 * 2 ** (this.fails - 5)); return this.waitMs(); }
  reset() { this.fails = 0; this.until = 0; }
}

// A config.json "lock" kulcsának megtisztított alakja; hibás vagy hiányos adat = kikapcsolt zár.
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const pin = r.pin && typeof r.pin.salt === 'string' && typeof r.pin.hash === 'string' ? { salt: r.pin.salt, hash: r.pin.hash } : null;
  const recovery = r.recovery && typeof r.recovery.salt === 'string' && typeof r.recovery.hash === 'string' ? { salt: r.recovery.salt, hash: r.recovery.hash } : null;
  return { enabled: !!r.enabled && !!pin, touchId: !!r.touchId, idleMin: IDLE_CHOICES.includes(r.idleMin) ? r.idleMin : 5, pin, recovery };
}

module.exports = { IDLE_CHOICES, okPin, hashPin, verifyPin, newRecoveryCode, hashRecovery, verifyRecovery, Throttle, normalize };
