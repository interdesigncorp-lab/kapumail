// Postafiók-szűrő (rendszerválasztó): a belépőn kikapcsolt rendszer postafiókjának leveleit az asztali app
// le sem kéri. A végső döntés a szerveré – ez csak arra való, hogy a tiltott postafiókhoz ne is nyúljunk.
'use strict';

/** Pontosan egy 8 jegyű adószám-törzs áll-e a névben (a 10 jegyű adóazonosító jel nem az). */
function taxNamed(name) {
  const stems = new Set();
  const rest = String(name).replace(/(?<!\d)(\d{8})-?\d-?\d{2}(?!\d)/g, (_, s) => { stems.add(s); return ' '; });
  rest.replace(/(?<!\d)(\d{8})(?!\d)/g, (_, s) => { stems.add(s); return ' '; });
  return stems.size === 1;
}

/**
 * @param {string} name az élő postafiók neve
 * @param {{ known: string[], deny: string[], unknown: 'all'|'taxNamed'|'none' } | null} filter
 *   known: a szerver által már ismert postafióknevek; deny: közülük a kikapcsolt rendszerűek;
 *   unknown: mi legyen a még nem ismert nevűekkel. `null` szűrő mindent enged.
 */
function mailboxAllowed(name, filter) {
  if (!filter) return true;
  const n = String(name);
  if ((filter.known || []).includes(n)) return !(filter.deny || []).includes(n);
  if (filter.unknown === 'all') return true;
  if (filter.unknown === 'taxNamed') return taxNamed(n);
  return false; // 'none' vagy ismeretlen szabály: szigorúan
}

/** A felülettől kapott szűrő megtisztítása: csak a várt alak megy tovább a tárhely-modulokhoz. */
function cleanFilter(f) {
  if (!f || typeof f !== 'object') return null;
  const list = a => (Array.isArray(a) ? a.slice(0, 1000).map(x => String(x).slice(0, 200)) : []);
  return { known: list(f.known), deny: list(f.deny), unknown: ['all', 'taxNamed', 'none'].includes(f.unknown) ? f.unknown : 'none' };
}

module.exports = { mailboxAllowed, taxNamed, cleanFilter };
