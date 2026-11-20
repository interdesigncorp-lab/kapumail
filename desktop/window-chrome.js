'use strict';
// A főablak címsor-beállításai platformonként.
// macOS-en a rejtett címsor mellett a közlekedési lámpák megmaradnak. Windowson és Linuxon viszont a
// titleBarStyle: 'hidden' a bezárás / kis méret / teljes méret gombokat is eltünteti, ezért ott a
// titleBarOverlay kapcsolja vissza a rendszer saját ablakgombjait a jobb felső sarokba
// (a 28 px magas, húzható .winbar sáv magasságában, átlátszó háttérrel).
const WINBAR_HEIGHT = 28;

function windowChrome(platform = process.platform) {
  if (platform === 'darwin') return { titleBarStyle: 'hidden', trafficLightPosition: { x: 13, y: 7 } };
  return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#30225c', height: WINBAR_HEIGHT } };
}

module.exports = { windowChrome, WINBAR_HEIGHT };
