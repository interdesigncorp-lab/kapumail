// A felügyelet nélküli futás állapotának kezelése a főfolyamatban: a beállításfájlból olvas és oda ment.
// Külön modul, hogy az Electron nélkül is tesztelhető legyen. Titkot nem tárol: hibaszámláló, tiltás oka, utolsó siker.
'use strict';

const A = require('./tarhely-auto');

/** @param {{ readCfg: () => object, saveCfg: (patch: object) => void }} io */
function makeAutoControl({ readCfg, saveCfg }) {
  const state = () => { const s = readCfg().auto; return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; };
  return {
    state,
    /** A futó `onProgress` visszahívása: belépőnként azonnal ment, hogy egy megszakadt futás után is megmaradjon a tiltás. */
    saver: snapshot => result => saveCfg({ auto: A.mergeResult(state(), snapshot, result) }),
    /** A belépési adatok újramentése feloldja a tiltást. */
    unblockOnSave: key => { const st = state(); if (!st[key]) return; A.unblock(st, key); saveCfg({ auto: st }); },
    /** Az ablakos automata belépés előtt: a tiltás oka, vagy null. */
    gate: key => A.blockedReason(state(), key),
    /** Az ablakos automata belépés eredménye: csak a jelszóhibát rögzítjük (az azonnal tilt). */
    recordWindowResult: (key, res) => {
      if (!res || res.ok !== false || A.classifyError(res.error) !== 'password') return;
      const st = state(); A.recordFailure(st, key, res.error); saveCfg({ auto: st });
    },
  };
}

module.exports = { makeAutoControl };
