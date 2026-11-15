// Üzemmód: "local" = helyi asztali alkalmazás (a szerverrész ezen a gépen fut, egy felhasználóval),
// "server" = közös (felhő alapú) szerverhez kapcsolódik. Tiszta logika, Electron nélkül tesztelhető.
const MODES = ['local', 'server'];

// A mentett beállításból és a környezetből eldönti a módot; null = még nem választott (első indítás).
// Aki korábban szervercímet adott meg (vagy fejlesztőként környezeti változóval indít), annak nem kell újra választania.
function resolveMode(cfg, env = {}) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  if (MODES.includes(c.mode)) return c.mode;
  if (env.IRATKAPU_URL || (typeof c.url === 'string' && c.url)) return 'server';
  return null;
}

// A felület kéréseinek jelölése: a szerver ebből tudja, hogy asztali alkalmazásból nézik, és melyik módban.
function userAgent(base, version, mode) {
  const clean = String(base || '').replace(/\s*KapuMail-Desktop\/\S+ \((?:local|server)\)/g, '');
  return `${clean} KapuMail-Desktop/${String(version || '0').replace(/[^\d.]/g, '') || '0'} (${MODES.includes(mode) ? mode : 'server'})`.trim();
}

module.exports = { MODES, resolveMode, userAgent };
