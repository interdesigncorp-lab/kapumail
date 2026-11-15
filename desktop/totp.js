// TOTP (RFC 6238, HMAC-SHA1, 30 mp, 6 jegy) – az Ügyfélkapu+ hitelesítő kódjának
// előállítása és ellenőrzése, valamint otpauth:// URI / QR-kép feldolgozása.
// Külső npm-függőség nélkül, kizárólag a Node beépített `crypto` moduljára épül.
// Referencia: godavid/tarhely-cli (MIT, f9fbddd) src/kau/totp.ts.

const { createHmac } = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function normalizeSeed(input) {
  return String(input || '')
    .trim()
    .toUpperCase()
    .replace(/=+$/, '')
    .replace(/[\s-]+/g, '');
}

function base32Decode(input) {
  const clean = normalizeSeed(input);
  if (!clean) throw new Error('Üres hitelesítő kulcs.');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(`Érvénytelen Base32 karakter a hitelesítő kulcsban: „${ch}” (csak A–Z és 2–7 engedélyezett).`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function totpCode(seed, atSeconds = Date.now() / 1000, stepSeconds = 30) {
  const key = base32Decode(seed);
  const counter = Math.floor(atSeconds / stepSeconds);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', key).update(buf).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function secondsLeftInWindow(atSeconds = Date.now() / 1000, stepSeconds = 30) {
  return stepSeconds - (Math.floor(atSeconds) % stepSeconds);
}

function isValidTotpSeed(seed) {
  try {
    return base32Decode(seed).length >= 10 && /^\d{6}$/.test(totpCode(seed, 0));
  } catch {
    return false;
  }
}

function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out += BASE32_ALPHABET[(value >>> bits) & 31]; }
    value &= (1 << bits) - 1;
  }
  return bits > 0 ? out + BASE32_ALPHABET[(value << (5 - bits)) & 31] : out;
}

/** Protobuf-üzenet mezői: [{ field, wire, value }] – `value` szám (varint) vagy Buffer (hosszal jelölt). Hibás adatra dob. */
function protoFields(buf) {
  const out = []; let i = 0;
  const varint = () => { let n = 0, shift = 0; for (;;) { if (i >= buf.length || shift > 35) throw new Error('csonka'); const b = buf[i++]; n += (b & 0x7f) * 2 ** shift; if (!(b & 0x80)) return n; shift += 7; } };
  while (i < buf.length) {
    const tag = varint(); const wire = tag & 7; const field = Math.floor(tag / 8);
    if (wire === 0) out.push({ field, wire, value: varint() });
    else if (wire === 2) { const len = varint(); if (i + len > buf.length) throw new Error('csonka'); out.push({ field, wire, value: buf.subarray(i, i + len) }); i += len; }
    else throw new Error('ismeretlen mezőtípus');
  }
  return out;
}

/**
 * A Google Authenticator „Fiókok átvitele” QR-kódjának feldolgozása. A telefon csak így adja ki a kulcsot.
 * Csak akkor fogadjuk el, ha PONTOSAN EGY fiók van benne (ne kerüljön hozzánk más szolgáltatás kulcsa), és az
 * időalapú, SHA-1-es, hatjegyű – az Ügyfélkapu+ ilyet használ. A feldolgozás helyben történik, az adat sehová nem megy.
 */
function parseMigration(uri) {
  const bad = { ok: false, error: 'A Google Authenticator exportja nem olvasható. Olvasd be újra a QR-kódot, vagy add meg a 16 karakteres kulcsot.' };
  let accounts;
  try {
    const data = new URL(uri).searchParams.get('data');
    if (!data || !/^[A-Za-z0-9+/_=-]+$/.test(data)) return bad;
    accounts = protoFields(Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64')).filter(f => f.field === 1 && f.wire === 2).map(f => protoFields(f.value));
  } catch { return bad; }
  if (accounts.length === 0) return bad;
  if (accounts.length > 1) return { ok: false, error: `Ebben az exportban ${accounts.length} fiók van. A Google Authenticatorban az átvitelnél csak az Ügyfélkapu+ fiókot jelöld ki, és azt a QR-kódot add meg.` };
  const get = n => { const f = accounts[0].find(x => x.field === n); return f ? f.value : null; };
  const text = n => { const v = get(n); return Buffer.isBuffer(v) && v.length ? v.toString('utf8').slice(0, 120) : null; };
  const secret = get(1);
  if (!Buffer.isBuffer(secret)) return bad;
  if ((get(6) ?? 2) !== 2) return { ok: false, error: 'Csak időalapú (TOTP) hitelesítő fiók támogatott; ez számláló alapú.' };
  if (![0, 1].includes(get(4) ?? 0) || ![0, 1].includes(get(5) ?? 0)) return { ok: false, error: 'Ez a fiók nem támogatott beállítású (nem SHA-1-es vagy nem hatjegyű kódot ad).' };
  if (secret.length < 10) return { ok: false, error: 'A hitelesítő kulcs túl rövid az exportban.' };
  return { ok: true, seed: base32Encode(secret), account: text(2), issuer: text(3) };
}

/**
 * Feldolgoz egy 16/32 karakteres Base32 kulcsot VAGY egy QR-kódból kiolvasott `otpauth://` URI-t.
 * A Google Authenticator exportját (`otpauth-migration://`, „Fiókok átvitele”) is elfogadja, ha pontosan egy fiókot tartalmaz.
 */
function parseTotpInput(raw, atSeconds = Date.now() / 1000) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, error: 'Add meg a 16 karakteres hitelesítő kulcsot, vagy olvass be egy QR-kódot.' };
  let candidate = s;
  let account = null;
  let issuer = null;
  if (/^otpauth-migration:\/\//i.test(s)) {
    const m = parseMigration(s);
    if (!m.ok) return m;
    candidate = m.seed; account = m.account; issuer = m.issuer;
  }
  if (/^otpauth:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { return { ok: false, error: 'Érvénytelen otpauth:// QR-kód formátum.' }; }
    const kind = (u.hostname || u.pathname.replace(/^\/+/, '').split('/')[0] || '').toLowerCase();
    if (kind && kind !== 'totp') {
      return { ok: false, error: `Csak időalapú (TOTP) hitelesítő kód támogatott (kapott típus: ${kind}).` };
    }
    candidate = u.searchParams.get('secret') || '';
    issuer = u.searchParams.get('issuer') || null;
    const rawLabel = decodeURIComponent((u.hostname ? u.pathname : u.pathname.replace(/^\/+[^/]+/, '')).replace(/^\/+/, ''));
    if (rawLabel) account = rawLabel;
  }
  let bytes;
  try {
    bytes = base32Decode(candidate);
  } catch (e) {
    return { ok: false, error: e.message || 'Érvénytelen Base32 hitelesítő kulcs.' };
  }
  if (bytes.length < 10) {
    return { ok: false, error: 'A hitelesítő kulcs túl rövid: legalább 16 Base32 karakter (A–Z, 2–7) szükséges.' };
  }
  const seed = normalizeSeed(candidate);
  return {
    ok: true,
    seed,
    account,
    issuer,
    code: totpCode(seed, atSeconds),
    secondsLeft: secondsLeftInWindow(atSeconds),
    period: 30,
  };
}

/** Lapon belül futtatható QR-olvasó szkript (Chromium BarcodeDetector API). */
function qrDetectScript(dataUrl) {
  return `(async () => {
    if (typeof BarcodeDetector === 'undefined') {
      return { ok: false, error: 'Ezen a rendszeren a beépített QR-olvasó nem érhető el – másold be a 16 karakteres kulcsot szövegesen.' };
    }
    const sup = await BarcodeDetector.getSupportedFormats().catch(() => []);
    if (!sup.includes('qr_code')) {
      return { ok: false, error: 'A rendszer QR-felismerője nem támogatja a qr_code formátumot – add meg a 16 karakteres kulcsot.' };
    }
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('bad-img')); img.src = ${JSON.stringify(String(dataUrl || ''))}; });
    const det = new BarcodeDetector({ formats: ['qr_code'] });
    const hits = await det.detect(img);
    if (!hits || !hits.length || !hits[0].rawValue) {
      return { ok: false, error: 'Nem található olvasható QR-kód a képen. Próbálj élesebb kivágást, vagy add meg a 16 karakteres kulcsot.' };
    }
    return { ok: true, raw: String(hits[0].rawValue) };
  })()`;
}

/** Elszigetelt, rejtett Chromium-ablakban olvassa ki a QR-kódot egy kép data-URL-jéből. */
async function decodeQrDataUrl(BrowserWindow, dataUrl) {
  const s = String(dataUrl || '');
  if (!/^data:image\/(png|jpeg|jpg|webp|gif|bmp);base64,[a-z0-9+/=]+$/i.test(s) || s.length > 8 * 1024 * 1024) {
    return { ok: false, error: 'Csak PNG, JPEG vagy WebP kép tölthető be (legfeljebb 6 MB).' };
  }
  const win = new BrowserWindow({
    width: 320, height: 320, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  try {
    await win.loadURL('about:blank');
    const r = await win.webContents.executeJavaScript(qrDetectScript(s), true);
    if (!r || !r.ok) return r || { ok: false, error: 'A QR-kód nem olvasható.' };
    return parseTotpInput(r.raw);
  } catch {
    return { ok: false, error: 'A képfájl nem olvasható QR-kódként. Add meg a 16 karakteres kulcsot.' };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = {
  normalizeSeed,
  base32Decode,
  totpCode,
  secondsLeftInWindow,
  isValidTotpSeed,
  parseTotpInput,
  qrDetectScript,
  decodeQrDataUrl,
};
