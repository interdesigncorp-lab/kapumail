'use strict';
// Kliensoldali PII-szűrő és jogi absztraháló modul (ADR / R3):
// Garantálja, hogy adószám, adóazonosító jel, TAJ, cégjegyzékszám, bankszámlaszám,
// e-mail vagy ügyfélnév soha ne kerülhessen ki a webes keresőbe.
// Az érzékeny adatokat a keresés előtt általános jogi fogalmakká alakítja át
// ("adózó", "gazdasági társaság", "bankszámla", "magánszemély") a keresés blokkolása nélkül.

// Magyar adószám: 8 számjegy - áfakód (1 jegy) - megyekód (2 jegy), kötőjellel, per-jellel, ponttal, szóközzel vagy egyben
const RE_TAX_NUMBER = /\b\d{8}[- /. ]?\d[- /. ]?\d{2}\b/g;

// Magyar adóazonosító jel: 10 számjegy, 8-assal kezdődik
const RE_TAX_ID = /\b8\d{9}\b/g;

// TAJ szám: 9 számjegy, általában 3-3-3 bontásban vagy egyben
const RE_TAJ = /\b\d{3}[- ]?\d{3}[- ]?\d{3}\b/g;

// Magyar bankszámlaszám (GIRO): 2x8 vagy 3x8 számjegy, kötőjellel, szóközzel vagy egyben
const RE_BANK_ACCOUNT = /\b\d{8}[- ]?\d{8}(?:[- ]?\d{8})?\b/g;

// IBAN számlaszám: HU + 26 számjegy, vagy általános nemzetközi IBAN
const RE_IBAN = /\b[A-Z]{2}\d{2}[- ]?(?:[A-Z0-9]{4}[- ]?){3,7}[A-Z0-9]{1,4}\b/gi;

// Cégjegyzékszám: 01-09-123456, 01 09 123456, Cg. 01-09-123456
const RE_COMPANY_REG = /(?:\bCg\.?\s*)?\b\d{2}[- ]\d{2}[- ]\d{6}\b/gi;

// E-mail cím
const RE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Magyar cégnév mintázat: név + társasági forma (Kft., Bt., Zrt., Nyrt., Kkt., stb.) kis- és nagybetűs formákban is
const RE_COMPANY_NAME = /\b[A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüűA-ZÁÉÍÓÖŐÚÜŰ0-9\.\- ]{1,35}\s+(?:Nonprofit\s+Kft|Kft|Bt|Zrt|Nyrt|Kkt)\b\.?/gi;

const PATTERNS = {
  taxNumber: RE_TAX_NUMBER,
  taxId: RE_TAX_ID,
  taj: RE_TAJ,
  bankAccount: RE_BANK_ACCOUNT,
  iban: RE_IBAN,
  companyReg: RE_COMPANY_REG,
  email: RE_EMAIL,
  companyName: RE_COMPANY_NAME,
};

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveEntityConcept(name) {
  if (typeof name !== 'string') return 'adózó';
  const lower = name.toLowerCase();
  // Előbb az alapítvány / egyesület és egyéni vállalkozó, utána a társasági formák
  if (/(?:^|[^a-záéíóöőúüű0-9])(?:alapítvány|egyesület)(?=$|[^a-záéíóöőúüű0-9])/i.test(lower)) return 'civil szervezet';
  if (/(?:^|[^a-záéíóöőúüű0-9])(?:e\.?v\.?|egyéni vállalkozó)(?=$|[^a-záéíóöőúüű0-9])/i.test(lower)) return 'egyéni vállalkozó';
  if (/(?:^|[^a-záéíóöőúüű0-9])(?:kft|bt|zrt|nyrt|kkt|kht|rt)(?=$|[^a-záéíóöőúüű0-9])/i.test(lower)) return 'gazdasági társaság';
  return 'adózó';
}

/**
 * sanitizeSearchQuery(query, options)
 *
 * Átalakítja a keresési lekérdezést: a konkrét azonosítókat általános jogi fogalmakká
 * cseréli ("adózó", "gazdasági társaság", "bankszámla"), a keresés meghiúsítása nélkül.
 *
 * @param {string} query A keresési kifejezés
 * @param {object} [options]
 * @param {string[]} [options.clientNames] Ügyfélnevek listája (pl. "Minta Kft.", "Kovács János")
 * @returns {{ sanitizedQuery: string, maskedItemsCount: number, maskedTypes: string[], toString: () => string }}
 */
function sanitizeSearchQuery(query, options = {}) {
  const result = {
    sanitizedQuery: '',
    maskedItemsCount: 0,
    maskedTypes: [],
    toString() { return this.sanitizedQuery; },
  };

  if (query === null || query === undefined) {
    return result;
  }

  try {
    const opts = options && typeof options === 'object' ? options : {};
    const clientNames = Array.isArray(opts.clientNames) ? opts.clientNames : [];
    let text = String(query);
    let count = 0;
    const types = new Set();

    // 1. Ügyfélnevek helyettesítése a megadott listából (hosszabb nevek előre)
    if (clientNames.length > 0) {
      const sorted = [...clientNames]
        .filter((n) => typeof n === 'string' && n.trim().length > 1)
        .sort((a, b) => b.length - a.length);

      for (const name of sorted) {
        const trimmed = name.trim();
        const escaped = escapeRegex(trimmed);
        const re = new RegExp(`(^|[^a-záéíóöőúüűA-ZÁÉÍÓÖŐÚÜŰ0-9])${escaped}([^a-záéíóöőúüűA-ZÁÉÍÓÖŐÚÜŰ0-9]|$)`, 'gi');
        if (re.test(text)) {
          const concept = resolveEntityConcept(trimmed);
          text = text.replace(re, (match, prefix, suffix) => {
            count++;
            types.add('clientName');
            return `${prefix}${concept}${suffix}`;
          });
        }
      }
    }

    // 2. Szabványos azonosítók szűrése és helyettesítése általános jogi fogalmakkal
    // Sorrend: IBAN és bankszámla előtt e-mail és adószám, hogy ne ütközzenek rész-minták

    // E-mail
    text = text.replace(RE_EMAIL, () => {
      count++;
      types.add('email');
      return 'e-mail cím';
    });

    // IBAN
    text = text.replace(RE_IBAN, () => {
      count++;
      types.add('iban');
      return 'bankszámla';
    });

    // Belföldi bankszámlaszám (GIRO)
    text = text.replace(RE_BANK_ACCOUNT, () => {
      count++;
      types.add('bankAccount');
      return 'bankszámla';
    });

    // Cégjegyzékszám
    text = text.replace(RE_COMPANY_REG, () => {
      count++;
      types.add('companyReg');
      return 'gazdasági társaság';
    });

    // Adószám (8 jegyű vagy 8-1-2 jegyű)
    text = text.replace(RE_TAX_NUMBER, () => {
      count++;
      types.add('taxNumber');
      return 'adózó';
    });

    // Adóazonosító jel (10 jegyű, 8-assal kezdődő)
    text = text.replace(RE_TAX_ID, () => {
      count++;
      types.add('taxId');
      return 'magánszemély';
    });

    // TAJ szám
    text = text.replace(RE_TAJ, () => {
      count++;
      types.add('taj');
      return 'biztosított';
    });

    // Általános cégnév mintázat szövegben (ha nem szerepelt az explicit clientNames-ben)
    text = text.replace(RE_COMPANY_NAME, () => {
      count++;
      types.add('companyName');
      return 'gazdasági társaság';
    });

    // Felesleges szóközök normalizálása
    result.sanitizedQuery = text.replace(/[ \t]+/g, ' ').trim();
    result.maskedItemsCount = count;
    result.maskedTypes = Array.from(types);

    return result;
  } catch (_err) {
    result.sanitizedQuery = String(query).replace(/[ \t]+/g, ' ').trim();
    return result;
  }
}

module.exports = {
  sanitizeSearchQuery,
  PATTERNS,
  resolveEntityConcept,
};
