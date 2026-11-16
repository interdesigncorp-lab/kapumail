'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeSearchQuery, resolveEntityConcept } = require('../kapu/pii-filter');

test('pii-filter: adószámok maszkolása általános fogalomra (adózó)', () => {
  const q1 = 'Minta Kft. adóbevallás késedelem 12345678-2-42 bírság';
  const r1 = sanitizeSearchQuery(q1);
  assert.ok(!r1.sanitizedQuery.includes('12345678-2-42'));
  assert.ok(r1.sanitizedQuery.includes('adózó'));
  assert.ok(r1.maskedTypes.includes('taxNumber'));
  assert.ok(r1.maskedItemsCount >= 1);

  const q2 = 'Áfa ellenőrzés 87654321244 határidő';
  const r2 = sanitizeSearchQuery(q2);
  assert.ok(!r2.sanitizedQuery.includes('87654321244'));
  assert.ok(r2.sanitizedQuery.includes('adózó'));

  const q3 = 'Adószám: 12345678/2/41 bírság';
  const r3 = sanitizeSearchQuery(q3);
  assert.ok(!r3.sanitizedQuery.includes('12345678/2/41'));
  assert.ok(!r3.sanitizedQuery.includes('12345678'));
  assert.ok(r3.sanitizedQuery.includes('adózó'));
  assert.ok(r3.maskedTypes.includes('taxNumber'));

  const q4 = 'Adószám pontozva: 12345678.2.41 határozat';
  const r4 = sanitizeSearchQuery(q4);
  assert.ok(!r4.sanitizedQuery.includes('12345678.2.41'));
  assert.ok(!r4.sanitizedQuery.includes('12345678'));
  assert.ok(r4.sanitizedQuery.includes('adózó'));
  assert.ok(r4.maskedTypes.includes('taxNumber'));
});

test('pii-filter: adóazonosító jel maszkolása (magánszemély)', () => {
  const q = 'szja bevallás 8324567890 önellenőrzés pótlék';
  const r = sanitizeSearchQuery(q);
  assert.ok(!r.sanitizedQuery.includes('8324567890'));
  assert.ok(r.sanitizedQuery.includes('magánszemély'));
  assert.ok(r.maskedTypes.includes('taxId'));
});

test('pii-filter: TAJ szám maszkolása (biztosított)', () => {
  const q = 'egészségügyi szolgáltatási járulék 123-456-789 mentesség';
  const r = sanitizeSearchQuery(q);
  assert.ok(!r.sanitizedQuery.includes('123-456-789'));
  assert.ok(r.sanitizedQuery.includes('biztosított'));
  assert.ok(r.maskedTypes.includes('taj'));
});

test('pii-filter: bankszámlaszám és IBAN maszkolása (bankszámla)', () => {
  const q1 = 'NAV költségvetési számla utalás 10032000-01076301-00000000';
  const r1 = sanitizeSearchQuery(q1);
  assert.ok(!r1.sanitizedQuery.includes('10032000-01076301-00000000'));
  assert.ok(r1.sanitizedQuery.includes('bankszámla'));

  const q2 = 'Téves átutalás HU42 1177 3016 1234 5678 0000 0000 visszahívás';
  const r2 = sanitizeSearchQuery(q2);
  assert.ok(!r2.sanitizedQuery.includes('HU42'));
  assert.ok(r2.sanitizedQuery.includes('bankszámla'));
});

test('pii-filter: cégjegyzékszám maszkolása (gazdasági társaság)', () => {
  const q = 'kényszertörlés eljárás 01-09-987654 fellebbezés';
  const r = sanitizeSearchQuery(q);
  assert.ok(!r.sanitizedQuery.includes('01-09-987654'));
  assert.ok(r.sanitizedQuery.includes('gazdasági társaság'));
  assert.ok(r.maskedTypes.includes('companyReg'));
});

test('pii-filter: e-mail cím maszkolása', () => {
  const q = 'NAV megkeresés válasz ugyintezo.janos@ugyfelceg.hu határidő';
  const r = sanitizeSearchQuery(q);
  assert.ok(!r.sanitizedQuery.includes('ugyintezo.janos@ugyfelceg.hu'));
  assert.ok(r.sanitizedQuery.includes('e-mail cím'));
});

test('pii-filter: ügyfélnevek helyettesítése a megadott listából (clientNames)', () => {
  const options = {
    clientNames: [
      'Acme Consulting Kft.',
      'Kovács és Társa Bt.',
      'Szabó Péter E.V.',
      'Nagy Béla',
    ],
  };

  const q1 = 'Acme Consulting Kft. adóhatósági ellenőrzés jegyzőkönyv határidő';
  const r1 = sanitizeSearchQuery(q1, options);
  assert.ok(!r1.sanitizedQuery.includes('Acme Consulting Kft.'));
  assert.ok(r1.sanitizedQuery.includes('gazdasági társaság'));

  const q2 = 'Szabó Péter E.V. tételes költségelszámolás gépjármű';
  const r2 = sanitizeSearchQuery(q2, options);
  assert.ok(!r2.sanitizedQuery.includes('Szabó Péter'));
  assert.ok(r2.sanitizedQuery.includes('egyéni vállalkozó'));

  const q3 = 'Nagy Béla ingatlan értékesítés szja mentesség';
  const r3 = sanitizeSearchQuery(q3, options);
  assert.ok(!r3.sanitizedQuery.includes('Nagy Béla'));
  assert.ok(r3.sanitizedQuery.includes('adózó'));
});

test('pii-filter: hibatűrés (fail-safe) üres és érvénytelen bemenetekre', () => {
  assert.strictEqual(sanitizeSearchQuery(null).sanitizedQuery, '');
  assert.strictEqual(sanitizeSearchQuery(undefined).sanitizedQuery, '');
  assert.strictEqual(sanitizeSearchQuery('').sanitizedQuery, '');
  assert.strictEqual(sanitizeSearchQuery(12345).sanitizedQuery, '12345');
  assert.strictEqual(String(sanitizeSearchQuery('tiszta jogi keresés Art. 220. §')), 'tiszta jogi keresés Art. 220. §');
  // null vagy érvénytelen options paraméter soha nem dob TypeError-t
  assert.strictEqual(sanitizeSearchQuery('NAV ellenőrzés', null).sanitizedQuery, 'NAV ellenőrzés');
  assert.strictEqual(sanitizeSearchQuery('NAV ellenőrzés', undefined).sanitizedQuery, 'NAV ellenőrzés');
  assert.strictEqual(sanitizeSearchQuery('NAV ellenőrzés', 'nem objektum').sanitizedQuery, 'NAV ellenőrzés');
  assert.strictEqual(sanitizeSearchQuery('NAV ellenőrzés 12345678-2-42', null).sanitizedQuery, 'NAV ellenőrzés adózó');
});

test('pii-filter: cégnevek szűrése kis-, nagy- és vegyesbetűs formákban (KFT, kft, BT, ZRT)', () => {
  const q1 = 'Adóellenőrzés: Minta KFT 2024';
  const r1 = sanitizeSearchQuery(q1);
  assert.ok(!r1.sanitizedQuery.includes('Minta KFT'));
  assert.ok(r1.sanitizedQuery.includes('gazdasági társaság'));
  assert.ok(r1.maskedTypes.includes('companyName'));

  const q2 = 'Adóellenőrzés: Minta kft 2024';
  const r2 = sanitizeSearchQuery(q2);
  assert.ok(!r2.sanitizedQuery.includes('Minta kft'));
  assert.ok(r2.sanitizedQuery.includes('gazdasági társaság'));

  const q3 = 'Felszólítás: Minta BT 2024 és Teszt ZRT';
  const r3 = sanitizeSearchQuery(q3);
  assert.ok(!r3.sanitizedQuery.includes('Minta BT'));
  assert.ok(!r3.sanitizedQuery.includes('Teszt ZRT'));
  assert.ok(r3.sanitizedQuery.includes('gazdasági társaság'));

  const q4 = 'Minta Nonprofit Kft. eljárás';
  const r4 = sanitizeSearchQuery(q4);
  assert.ok(!r4.sanitizedQuery.includes('Minta Nonprofit Kft'));
  assert.ok(r4.sanitizedQuery.includes('gazdasági társaság'));
});

test('pii-filter: egybefüggő 16 és 24 jegyű bankszámlaszámok maszkolása', () => {
  const q1 = 'NAV utalás a 100320000107630100000000 számlára';
  const r1 = sanitizeSearchQuery(q1);
  assert.ok(!r1.sanitizedQuery.includes('100320000107630100000000'));
  assert.ok(r1.sanitizedQuery.includes('bankszámla'));
  assert.ok(r1.maskedTypes.includes('bankAccount'));

  const q2 = 'NAV utalás a 1177301612345678 számlára';
  const r2 = sanitizeSearchQuery(q2);
  assert.ok(!r2.sanitizedQuery.includes('1177301612345678'));
  assert.ok(r2.sanitizedQuery.includes('bankszámla'));
  assert.ok(r2.maskedTypes.includes('bankAccount'));
});

test('pii-filter: entitás fogalom feloldó segédfüggvény', () => {
  assert.strictEqual(resolveEntityConcept('Teszt Kft.'), 'gazdasági társaság');
  assert.strictEqual(resolveEntityConcept('Minta Zrt.'), 'gazdasági társaság');
  assert.strictEqual(resolveEntityConcept('Kis Bt.'), 'gazdasági társaság');
  assert.strictEqual(resolveEntityConcept('Kovács E.V.'), 'egyéni vállalkozó');
  assert.strictEqual(resolveEntityConcept('Magyar Adózásért Alapítvány'), 'civil szervezet');
  assert.strictEqual(resolveEntityConcept('Varga Katalin'), 'adózó');
});

// =========================================================================================================
// Forgatókönyv 7 (Scenario 7): Adószám és ügyfélnév kiszűrése/maszkolása keresés előtt hiba nélkül
// =========================================================================================================

test('Scenario 7: Valós komplex könyvelői kérdés PII-szűrése (adószám, adóazonosító, TAJ, bankszámla, cégnév, ügyfélnév)', () => {
  const rawPrompt =
    'Nagy és Fia Fuvarozó Kft. adószám: 12345678-2-41, ügyvezető: Nagy Béla (adóazonosító: 8345678901, TAJ: 123-456-789). ' +
    'Mennyi a cégautóadó a 140 kW-os Euro 6-os teherautójukra a 11773344-01234567 bankszámláról utalva?';

  const options = {
    clientNames: ['Nagy és Fia Fuvarozó Kft.', 'Nagy Béla'],
  };

  // 1. A PII-tisztító lefutása NEM dob hibát és nem szakítja meg a folyamatot
  let result;
  assert.doesNotThrow(() => {
    result = sanitizeSearchQuery(rawPrompt, options);
  });

  const sanitized = result.sanitizedQuery;

  // 2. Egyetlen konkrét PII vagy cégadat sem marad a kimenő keresési szövegben
  assert.doesNotMatch(sanitized, /12345678/, 'Adószám törzsszám nem maradhat');
  assert.doesNotMatch(sanitized, /12345678-2-41/, 'Teljes adószám nem maradhat');
  assert.doesNotMatch(sanitized, /8345678901/, 'Adóazonosító jel nem maradhat');
  assert.doesNotMatch(sanitized, /123-456-789/, 'TAJ szám nem maradhat');
  assert.doesNotMatch(sanitized, /11773344/, 'Bankszámlaszám nem maradhat');
  assert.doesNotMatch(sanitized, /11773344-01234567/, 'Teljes bankszámlaszám nem maradhat');
  assert.doesNotMatch(sanitized, /Nagy és Fia/, 'Cégnév nem maradhat');
  assert.doesNotMatch(sanitized, /Nagy Béla/, 'Ügyvezető neve nem maradhat');

  // 3. Általános jogi fogalmak helyettesítik a PII-t
  assert.ok(sanitized.includes('gazdasági társaság'), 'gazdasági társaság fogalom jelen kell legyen');
  assert.ok(sanitized.includes('adózó'), 'adózó fogalom jelen kell legyen');
  assert.ok(sanitized.includes('magánszemély'), 'magánszemély fogalom jelen kell legyen');
  assert.ok(sanitized.includes('biztosított'), 'biztosított fogalom jelen kell legyen');
  assert.ok(sanitized.includes('bankszámla'), 'bankszámla fogalom jelen kell legyen');

  // 4. A szakmai adójogi paraméterek megmaradnak a kereséshez
  assert.ok(sanitized.includes('cégautóadó'), 'cégautóadó megmarad');
  assert.ok(sanitized.includes('140 kW'), 'teljesítmény megmarad');
  assert.ok(sanitized.includes('Euro 6'), 'környezetvédelmi osztály megmarad');

  // 5. Maszkolt elemek száma és típusai ellenőrzése
  assert.ok(result.maskedItemsCount >= 5, `Legalább 5 maszkolt elem kell (volt: ${result.maskedItemsCount})`);
  assert.ok(result.maskedTypes.includes('clientName'));
  assert.ok(result.maskedTypes.includes('taxNumber'));
  assert.ok(result.maskedTypes.includes('taxId'));
  assert.ok(result.maskedTypes.includes('taj'));
  assert.ok(result.maskedTypes.includes('bankAccount'));
});

test('Scenario 7: Automatikus cégnév-felismerés explicit clientNames lista nélkül is', () => {
  const raw = 'Kovács és Társa Szállítmányozó Bt. 87654321-2-41 iparűzési adó devizás számla utalás HU42 1177 3016 1234 5678 0000 0000';
  const r = sanitizeSearchQuery(raw);

  assert.doesNotMatch(r.sanitizedQuery, /87654321/);
  assert.doesNotMatch(r.sanitizedQuery, /HU42/);
  assert.doesNotMatch(r.sanitizedQuery, /Kovács és Társa/);
  assert.ok(r.sanitizedQuery.includes('gazdasági társaság'));
  assert.ok(r.sanitizedQuery.includes('adózó'));
  assert.ok(r.sanitizedQuery.includes('bankszámla'));
  assert.ok(r.sanitizedQuery.includes('iparűzési adó'));
});

test('Scenario 7 (Adversarial): Extrém összetett PII-halmaz és speciális karakterek kezelése', () => {
  const complexInput =
    'Ügyfél: Dr. Tóth-Kovács Árpád EV (adóazonosító: 8499112233, TAJ: 456 789 012, adószám: 99887766-1-41), ' +
    'cég: Alfa-Beta-Gamma 2000 Zrt. (Cg. 01-10-123456, adószám: 11223344-2-41), ' +
    'kapcsolattartó e-mail: ugyved@toth-law.firm.hu, ' +
    'GIRO számlaszám: 10400123-01234567-00000000, IBAN: HU98 1040 0123 0123 4567 0000 0000. ' +
    'Kérdés: KIVA alanyiság választása és kapcsolt vállalkozási kötelezettségek.';

  const options = {
    clientNames: ['Dr. Tóth-Kovács Árpád EV', 'Alfa-Beta-Gamma 2000 Zrt.'],
  };

  let r;
  assert.doesNotThrow(() => {
    r = sanitizeSearchQuery(complexInput, options);
  });

  const clean = r.sanitizedQuery;
  assert.doesNotMatch(clean, /8499112233/);
  assert.doesNotMatch(clean, /456 789 012/);
  assert.doesNotMatch(clean, /99887766/);
  assert.doesNotMatch(clean, /01-10-123456/);
  assert.doesNotMatch(clean, /11223344/);
  assert.doesNotMatch(clean, /ugyved@toth-law\.firm\.hu/);
  assert.doesNotMatch(clean, /10400123/);
  assert.doesNotMatch(clean, /HU98/);
  assert.doesNotMatch(clean, /Tóth-Kovács/);
  assert.doesNotMatch(clean, /Alfa-Beta-Gamma/);

  assert.ok(clean.includes('KIVA alanyiság'));
  assert.ok(clean.includes('kapcsolt vállalkozási kötelezettségek'));
  assert.ok(r.maskedItemsCount >= 8);
});

