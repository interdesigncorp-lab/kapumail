// Az asztali app életjele (ADR-016): a főfolyamat 30 mp-enként a PHP storage/app mappájába írja, hogy fut, és hogyan indítható.
// A helyi (stdio) MCP-folyamat ebből tudja, kell-e ablak nélkül elindítania az appot egy MI-ből kért szinkronhoz. Titkot nem tartalmaz.
'use strict';

const fs = require('fs');
const path = require('path');

/** A fájl helye: csomagolt appnál a felhasználói adatmappa, fejlesztői módban a repó app/storage mappája. */
function aliveFile(paths) {
  const storage = paths.isPackaged ? path.join(paths.stateDir, 'storage') : path.join(paths.appRoot, 'storage');
  return path.join(storage, 'app', 'desktop-alive.json');
}

/** Hogyan indítható újra az app: macOS-en a .app csomag, Windowson az exe. Fejlesztői módban (nem csomagolt) nincs. */
function launchInfo({ platform, execPath, isPackaged }) {
  if (!isPackaged || !execPath) return null;
  if (platform === 'darwin') {
    const i = execPath.indexOf('.app/');
    return i > 0 ? { platform, path: execPath.slice(0, i + 4) } : null;
  }
  if (platform === 'win32') return { platform, path: execPath };
  return null;
}

/** A fájl tartalma; leálláskor `at: 0`, hogy a PHP azonnal lássa, de az indítási adat megmaradjon. */
function payload({ now, pid, isPackaged, launch, stopped = false }) {
  return { at: stopped ? 0 : now, pid, packaged: isPackaged === true, launch: launch || null };
}

/** Atomi írás: ideiglenes fájl, majd átnevezés (a PHP sosem lát félig írt fájlt). */
function writeAlive(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

module.exports = { aliveFile, launchInfo, payload, writeAlive };
