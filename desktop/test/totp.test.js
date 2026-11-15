const test = require('node:test');
const assert = require('node:assert');
const T = require('../totp');

// RFC 6238 B. melléklet SHA-1 tesztvektor: ASCII "12345678901234567890" -> Base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
const RFC_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('RFC 6238 SHA-1 referencia tesztvektorok', () => {
  assert.equal(T.totpCode(RFC_SEED, 59), '287082');
  assert.equal(T.totpCode(RFC_SEED, 1111111109), '081804');
  assert.equal(T.totpCode(RFC_SEED, 1111111111), '050471');
  assert.equal(T.totpCode(RFC_SEED, 1234567890), '005924');
});

test('szóközök, kötőjelek, kisbetűk és padding normalizálása', () => {
  assert.equal(T.totpCode('gezd-gnbv gy3t qojq gezd gnbv gy3t qojq====', 59), '287082');
  assert.equal(T.secondsLeftInWindow(59, 30), 1);
  assert.equal(T.secondsLeftInWindow(60, 30), 30);
  assert.equal(T.isValidTotpSeed('JBSWY3DPEHPK3PXP'), true);
  assert.equal(T.isValidTotpSeed('ROVID'), false);
  assert.equal(T.isValidTotpSeed('1890INVALIDBASE32'), false);
});

test('parseTotpInput elfogad 16 karakteres ÜK+ kulcsot és otpauth:// URI-t, de kiszűri az exportot', () => {
  const direct = T.parseTotpInput('jbsw y3dp ehpk 3pxp', 100);
  assert.equal(direct.ok, true);
  assert.equal(direct.seed, 'JBSWY3DPEHPK3PXP');
  assert.match(direct.code, /^\d{6}$/);

  const uri = T.parseTotpInput('otpauth://totp/NISZ:teszt.elek?secret=JBSWY3DPEHPK3PXP&issuer=UgyfelkapuPlusz&period=30', 100);
  assert.equal(uri.ok, true);
  assert.equal(uri.seed, 'JBSWY3DPEHPK3PXP');
  assert.equal(uri.code, direct.code);
  assert.equal(uri.issuer, 'UgyfelkapuPlusz');
  assert.equal(uri.account, 'NISZ:teszt.elek');

  const hotp = T.parseTotpInput('otpauth://hotp/Teszt?secret=JBSWY3DPEHPK3PXP&counter=1');
  assert.equal(hotp.ok, false);
  assert.match(hotp.error, /TOTP/);

  const shortKey = T.parseTotpInput('JBSWY3DP');
  assert.equal(shortKey.ok, false);
});

// Google Authenticator export („Fiókok átvitele"): a kulcs benne van, a telefon csak így adja ki.
const pb = (field, bytes) => Buffer.concat([Buffer.from([(field << 3) | 2, bytes.length]), bytes]);
const vi = (field, n) => Buffer.from([field << 3, n]);
const account = ({ secret = Buffer.from('Hello!\xde\xad\xbe\xef', 'latin1'), name = 'teszt.elek', issuer = 'Ügyfélkapu+', type = 2, algo = 1, digits = 1 } = {}) =>
  pb(1, Buffer.concat([pb(1, secret), pb(2, Buffer.from(name)), pb(3, Buffer.from(issuer)), vi(4, algo), vi(5, digits), vi(6, type)]));
const migration = (...accounts) => 'otpauth-migration://offline?data=' + encodeURIComponent(Buffer.concat([...accounts, vi(2, 1), vi(3, 1), vi(4, 0)]).toString('base64'));

test('Google Authenticator export: egyetlen fiókból kiolvassa a kulcsot, és ugyanazt a kódot adja, mint a telefon', () => {
  const r = T.parseTotpInput(migration(account()), 100);
  assert.equal(r.ok, true);
  assert.equal(r.seed, 'JBSWY3DPEHPK3PXP'); // „Hello!\xde\xad\xbe\xef" Base32 alakja
  assert.deepEqual([r.account, r.issuer, r.code], ['teszt.elek', 'Ügyfélkapu+', T.totpCode('JBSWY3DPEHPK3PXP', 100)]);
  // a Google saját dokumentált mintája is átmegy
  assert.equal(T.parseTotpInput('otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YWxpY2VAZ29vZ2xlLmNvbRoHRXhhbXBsZTAC').seed, 'JBSWY3DPEHPK3PXP');
});

test('Google Authenticator export: több fiók, nem időalapú vagy nem szabványos fiók, sérült adat – érthető hibával elutasítva', () => {
  const err = s => { const r = T.parseTotpInput(s); assert.equal(r.ok, false); return r.error; };
  assert.match(err(migration(account(), account({ name: 'masik' }))), /csak az Ügyfélkapu\+ fiókot/i);
  assert.match(err(migration(account({ type: 1 }))), /időalapú/i);
  assert.match(err(migration(account({ algo: 2 }))), /nem támogatott/i);
  assert.match(err(migration(account({ digits: 2 }))), /nem támogatott/i);
  assert.match(err(migration(account({ secret: Buffer.from('abc') }))), /túl rövid/i);
  assert.match(err('otpauth-migration://offline?data=%%%'), /nem olvasható/i);
  assert.match(err('otpauth-migration://offline?data=' + Buffer.from([0x0a, 0x7f, 1, 2]).toString('base64')), /nem olvasható/i);
  assert.match(err('otpauth-migration://offline'), /nem olvasható/i);
});
