'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A Jóváhagyott Fehérlistás Domainek (Group A, B, C) a Szakmai Protokoll és persona.md szerint:
const WHITELIST = {
  GROUP_A: [
    'nav.gov.hu',
    'njt.hu',
    'magyarkozlony.hu',
    'mnb.hu',
    'birosag.hu',
    'kuria-birosag.hu',
    'allamkincstar.gov.hu',
    'neak.gov.hu',
    'ksh.hu',
    'kormany.hu',
    'magyarorszag.hu',
    'eur-lex.europa.eu',
  ],
  GROUP_B: [
    'e-beszamolo.im.gov.hu',
    'e-cegjegyzek.hu',
    'kormanyhivatalok.hu',
    'naih.hu',
    'ec.europa.eu',
  ],
  GROUP_C: [
    'adozona.hu',
    'onadozo.hu',
    'rsm.hu',
    'kpmg.com',
    'pwc.com',
    'ey.com',
    'deloitte.com',
    'mkvk.hu',
  ],
};

const ALL_ALLOWED_DOMAINS = new Set([
  ...WHITELIST.GROUP_A,
  ...WHITELIST.GROUP_B,
  ...WHITELIST.GROUP_C,
]);

/**
 * Ellenőrzi, hogy egy adott domain megegyezik-e a fehérlistás domainnel,
 * vagy annak szigorúan közvetlen aldomainje-e (megakadályozva a domain-spoofing támadásokat).
 */
function isDomainWhitelisted(domain) {
  if (typeof domain !== 'string') return false;
  let clean = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  // Only strip valid numeric port numbers consisting exclusively of digits
  clean = clean.replace(/:\d+$/, '');
  if (!clean || clean.includes(':') || clean.includes('@')) return false;

  for (const allowed of ALL_ALLOWED_DOMAINS) {
    if (clean === allowed || clean.endsWith(`.${allowed}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Keresőkifejezés validálása és domain kinyerése:
 * Megköveteli a kötelező `site:<domain>` operátort a jóváhagyott fehérlistáról.
 */
function validateSearchQuery(query) {
  if (typeof query !== 'string' || !query.trim()) {
    return { valid: false, error: 'Üres keresőkifejezés.', domains: [] };
  }

  const siteMatches = Array.from(query.matchAll(/\bsite:([^\s]+)/gi));
  if (siteMatches.length === 0) {
    return {
      valid: false,
      error: 'Általános, nem fehérlistás keresés nem engedélyezett (hiányzik a kötelező site: operátor).',
      domains: [],
    };
  }

  const domains = [];
  for (const match of siteMatches) {
    const rawDomain = match[1];
    // Leválasztjuk az esetleges zárójeleket vagy írásjeleket
    const cleanDomain = rawDomain.replace(/[(),;]+$/, '');
    domains.push(cleanDomain);

    if (!isDomainWhitelisted(cleanDomain)) {
      return {
        valid: false,
        error: `Tiltott vagy nem engedélyezett keresési domain: ${cleanDomain}`,
        domains,
        rejectedDomain: cleanDomain,
      };
    }
  }

  return { valid: true, domains };
}

/**
 * Szakmai keresési lekérdezés-generáló szűrő:
 * Adott felhasználói kérdésből (amely nem hivatalos fórumokat is tartalmazhat)
 * kinyeri a szakmai kulcsszavakat és kötelezően fehérlistás domainhez köti a lekérdezést.
 */
function buildWhitelistedSearchQuery(userQuestion, targetDomain = 'nav.gov.hu') {
  if (!isDomainWhitelisted(targetDomain)) {
    throw new Error(`A megadott cél-domain (${targetDomain}) nem szerepel a fehérlistán.`);
  }

  let clean = String(userQuestion || '');
  // Kiszűrjük a tiltott fórumokra és közösségi oldalakra való hivatkozást
  const FORUM_PATTERNS = [
    /\b(?:https?:\/\/)?(?:www\.)?reddit(?:\.com)?\b/gi,
    /\b(?:https?:\/\/)?(?:www\.)?gyakorikerdesek(?:\.hu)?\b/gi,
    /\b(?:https?:\/\/)?(?:www\.)?facebook(?:\.com)?\b/gi,
    /\bfórum(?:ok|on)?\b/gi,
    /\balapján\b/gi,
  ];

  for (const p of FORUM_PATTERNS) {
    clean = clean.replace(p, ' ');
  }

  clean = clean.replace(/[ \t]+/g, ' ').trim();
  return `site:${targetDomain} ${clean}`.trim();
}

// --- Tesztek -------------------------------------------------------------------------------------

test('Scenario 6: Fehérlistás keresési domainek ellenőrzése (Group A, B, C)', () => {
  // Group A domainek elfogadása
  assert.ok(isDomainWhitelisted('nav.gov.hu'));
  assert.ok(isDomainWhitelisted('njt.hu'));
  assert.ok(isDomainWhitelisted('magyarkozlony.hu'));
  assert.ok(isDomainWhitelisted('mnb.hu'));
  assert.ok(isDomainWhitelisted('eur-lex.europa.eu'));
  assert.ok(isDomainWhitelisted('birosag.hu'));

  // Group B domainek elfogadása
  assert.ok(isDomainWhitelisted('e-cegjegyzek.hu'));
  assert.ok(isDomainWhitelisted('e-beszamolo.im.gov.hu'));
  assert.ok(isDomainWhitelisted('naih.hu'));

  // Group C domainek elfogadása
  assert.ok(isDomainWhitelisted('adozona.hu'));
  assert.ok(isDomainWhitelisted('onadozo.hu'));
  assert.ok(isDomainWhitelisted('rsm.hu'));
});

test('Scenario 6: Nem fehérlistás domainek (reddit, gyakorikerdesek, fórumok, blogok) elutasítása', () => {
  const forbiddenDomains = [
    'reddit.com',
    'gyakorikerdesek.hu',
    'facebook.com',
    'blog.hu',
    'hvg.hu',
    'index.hu',
    'telex.hu',
    'origo.hu',
    'randomforum.net',
    'quora.com',
  ];

  for (const domain of forbiddenDomains) {
    assert.strictEqual(
      isDomainWhitelisted(domain),
      false,
      `A nem hivatalos ${domain} nem szerepelhet a fehérlistán.`
    );

    const q = `site:${domain} szocho kedvezmény szabályok`;
    const check = validateSearchQuery(q);
    assert.strictEqual(check.valid, false);
    assert.strictEqual(check.rejectedDomain, domain);
  }
});

test('Scenario 6: Általános un-scoped (site: nélküli) keresőkifejezések elutasítása', () => {
  const unscopedQueries = [
    'kriptovaluta szocho szabályok 2026',
    'hogyan kell adózni bitcoin után',
    'cégautóadó fizetési határidő',
  ];

  for (const q of unscopedQueries) {
    const check = validateSearchQuery(q);
    assert.strictEqual(check.valid, false);
    assert.ok(check.error.includes('hiányzik a kötelező site: operátor'));
  }
});

test('Scenario 6 (Adversarial): Domain-spoofing és átverési kísérletek szigorú meghiúsítása', () => {
  const spoofingAttempts = [
    'nav.gov.hu.attacker.com',
    'njt.hu.fake-site.org',
    'fake-nav.gov.hu',
    'nav.gov.hu@evil.com',
    'malicious.com/site:nav.gov.hu',
    'subdomain.nav.gov.hu.hacker.io',
    'nav.gov.hu:evil.com',
    'nav.gov.hu:8080.evil.com',
    'nav.gov.hu:password@evil.com',
  ];

  for (const attempt of spoofingAttempts) {
    assert.strictEqual(
      isDomainWhitelisted(attempt),
      false,
      `A hamisított ${attempt} domainnek szigorúan el kell buknia.`
    );
  }
});

test('Scenario 6: Valós tényállás - fórumok említésének kiszűrése és fehérlistás keresés kényszerítése', () => {
  const userQuestion = 'Kriptovaluta utáni szocho gyakorikerdesek és reddit fórumok alapján';

  // Generált keresőkifejezés kötelezően fehérlistás domainre
  const generatedQuery = buildWhitelistedSearchQuery(userQuestion, 'nav.gov.hu');

  // 1. A kifejezés a hivatalos nav.gov.hu-ra irányul
  assert.ok(generatedQuery.startsWith('site:nav.gov.hu'));

  // 2. Egyetlen nem fehérlistás domain vagy fórum sem szerepel benne
  assert.strictEqual(generatedQuery.includes('reddit.com'), false);
  assert.strictEqual(generatedQuery.includes('reddit'), false);
  assert.strictEqual(generatedQuery.includes('gyakorikerdesek.hu'), false);
  assert.strictEqual(generatedQuery.includes('gyakorikerdesek'), false);
  assert.strictEqual(generatedQuery.includes('fórum'), false);

  // 3. A szakmai lényeg (kriptovaluta, szocho) megmarad
  assert.ok(generatedQuery.includes('Kriptovaluta'));
  assert.ok(generatedQuery.includes('szocho'));

  // 4. A lekérdezés érvényes a fehérlista ellenőrző szerint
  const validation = validateSearchQuery(generatedQuery);
  assert.strictEqual(validation.valid, true);
  assert.deepStrictEqual(validation.domains, ['nav.gov.hu']);
});

test('Scenario 6: persona.md integritásának ellenőrzése a fehérlistás szabályzatra', () => {
  const personaPath = path.join(__dirname, '..', 'kapu', 'persona.md');
  const personaText = fs.readFileSync(personaPath, 'utf8');

  // A persona szövegének kötelezően tartalmaznia kell a fehérlistás protokoll elemeit
  assert.ok(personaText.includes('site:nav.gov.hu'));
  assert.ok(personaText.includes('site:njt.hu'));
  assert.ok(personaText.includes('site:magyarkozlony.hu'));
  assert.ok(personaText.includes('Group A'));
  assert.ok(personaText.includes('Group B'));
  assert.ok(personaText.includes('Group C'));

  // Kifejezett tiltások a fórumokra és nem engedélyezett forrásokra
  assert.ok(personaText.includes('reddit'));
  assert.ok(personaText.includes('gyakorikerdesek'));
  assert.ok(personaText.includes('fórumok'));
  assert.ok(personaText.includes('szigorúan tilos'));
});
