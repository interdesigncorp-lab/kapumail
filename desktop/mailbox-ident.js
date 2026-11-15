// Az élő postafiók azonosítása a tárhely postafiók-listájának egy eleméből.
// Élő próbával igazolt mezők (2026-11-12): `azonosito` (64 karakteres, belépések között állandó), `mailboxName` / `megnevezes`
// (céges postafióknál a nyolcjegyű adószám-törzs; a saját tárhelynél egy MINDEN belépőnél azonos általános szöveg),
// `name` (a megjelenített név: a cég neve), `type` (AP = a belépő saját értesítési tárhelye, CKP = Cégkapu), `defaultMailbox`.
'use strict';

/**
 * A szervernek küldött postafiók-kulcs. A céges postafióknál maga az adószám-törzs (irodán belül egyedi).
 * Minden másnál a név nem egyedi – két belépő saját tárhelye ugyanúgy hívódik –, ezért az állandó azonosító
 * elejével egészítjük ki, különben két ember levelei egy postafiókba kerülhetnének.
 */
function mailboxKey(rawName, addressId) {
  const raw = String(rawName);
  if (/^\d{8}$/.test(raw) || !addressId) return raw;
  return `${raw} · ${String(addressId).slice(0, 8)}`;
}

/** @returns {{ index: number, addressId: string, name: string, rawName: string, displayName: string, type: string|null, isDefault: boolean } | null} */
function describeMailbox(item, index) {
  if (!item || typeof item.azonosito !== 'string' || item.azonosito === '') return null;
  const rawName = String(item.mailboxName ?? item.megnevezes ?? item.name ?? `postafiók ${index + 1}`);
  return {
    index, addressId: item.azonosito, name: mailboxKey(rawName, item.azonosito), rawName,
    displayName: String(item.name ?? rawName).slice(0, 200),
    type: typeof item.type === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(item.type) ? item.type : null,
    isDefault: item.defaultMailbox === true,
  };
}

module.exports = { mailboxKey, describeMailbox };
