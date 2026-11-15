// Fejlesztői módban az Electron alapértelmezetten 'Electron'-ként jelenne meg
// a macOS Dockban és a menüsorban. Ez a szkript beállítja a KapuMail nevet és ikont.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function patchMacDevApp() {
  if (process.platform !== 'darwin') return;

  // A Dock a csomag MAPPANEVÉT írja ki (Electron.app -> "Electron"), az Info.plist
  // átírása ehhez kevés. Ezért a csomagot átnevezzük KapuMail.app-ra, és a path.txt-ben
  // megmondjuk az electron parancsnak, hol találja. Friss telepítés után újra lefut.
  const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
  const stockApp = path.join(electronDir, 'dist', 'Electron.app');
  const electronApp = path.join(electronDir, 'dist', 'KapuMail.app');
  if (fs.existsSync(stockApp)) {
    try {
      fs.rmSync(electronApp, { recursive: true, force: true });
      fs.renameSync(stockApp, electronApp);
    } catch {}
  }
  if (fs.existsSync(electronApp) && !fs.existsSync(stockApp)) {
    try { fs.writeFileSync(path.join(electronDir, 'path.txt'), 'KapuMail.app/Contents/MacOS/Electron'); } catch {}
  }
  const plistPath = path.join(electronApp, 'Contents', 'Info.plist');
  if (!fs.existsSync(plistPath)) return;

  const setOrAddPlistKey = (key, val) => {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${val}`, plistPath], { stdio: 'ignore' });
    } catch {
      try {
        execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${val}`, plistPath], { stdio: 'ignore' });
      } catch {}
    }
  };

  setOrAddPlistKey('CFBundleDisplayName', 'KapuMail');
  setOrAddPlistKey('CFBundleName', 'KapuMail');

  const icnsSource = path.join(__dirname, '..', 'assets', 'icon.icns');
  const icnsTarget = path.join(electronApp, 'Contents', 'Resources', 'electron.icns');
  if (fs.existsSync(icnsSource) && fs.existsSync(path.dirname(icnsTarget))) {
    try {
      fs.copyFileSync(icnsSource, icnsTarget);
    } catch {}
  }
}

patchMacDevApp();
