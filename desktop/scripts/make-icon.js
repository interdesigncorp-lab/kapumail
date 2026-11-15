// Az alkalmazásikon előállítása a plüssfigurából: npm run icon  ->  assets/icon.png (1024×1024).
// Az electron-builder ebből készíti a macOS .icns és a Windows .ico fájlt.
// Opcionális: electron scripts/make-icon.js --shot=fajl.png  -> az indítóképernyő képe ellenőrzéshez.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const plush = pathToFileURL(path.join(__dirname, '..', 'assets', 'plush.png')).href;
// Apple ikonrács: 1024-es vásznon 824-es lekerekített négyzet, körülötte hely az árnyéknak.
const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:1024px;height:1024px;background:transparent;overflow:hidden}
.t{position:absolute;left:100px;top:100px;width:824px;height:824px;border-radius:186px;overflow:hidden;
  background:radial-gradient(120% 90% at 50% 8%,#fff 0%,rgba(255,255,255,0) 55%),linear-gradient(145deg,#f9dcea 0%,#e7dbf8 38%,#d6d0fb 68%,#f6dfe0 100%);
  box-shadow:0 22px 44px -10px rgba(50,30,110,.38),0 4px 10px rgba(50,30,110,.16),inset 0 0 0 2px rgba(255,255,255,.55),inset 0 -28px 60px -20px rgba(110,80,200,.28)}
.g{position:absolute;left:50%;top:79%;width:520px;height:64px;margin-left:-260px;border-radius:50%;background:rgba(60,35,120,.26);filter:blur(26px)}
img{position:absolute;left:50%;top:50.5%;width:640px;transform:translate(-50%,-50%);filter:drop-shadow(0 26px 30px rgba(70,40,130,.26))}
</style><div class="t"><div class="g"></div><img src="${plush}"></div>`;

app.whenReady().then(async () => {
  const shot = (process.argv.find(a => a.startsWith('--shot=')) || '').split('=')[1];
  const size = shot ? { width: 900, height: 620 } : { width: 1024, height: 1024 };
  const win = new BrowserWindow({ ...size, show: false, frame: false, transparent: !shot, webPreferences: { offscreen: true } });
  if (shot) await win.loadFile(path.join(__dirname, '..', 'splash.html'));
  else { // fájlból töltjük be, mert data: oldalról a helyi kép nem érhető el
    const tmp = path.join(app.getPath('temp'), 'kapumail-icon.html');
    fs.writeFileSync(tmp, html); await win.loadFile(tmp); fs.unlinkSync(tmp);
  }
  await new Promise(r => setTimeout(r, shot ? 2300 : 600));
  let img = await win.webContents.capturePage();
  if (!shot) img = img.resize({ width: 1024, height: 1024, quality: 'best' });
  const out = shot || path.join(__dirname, '..', 'assets', 'icon.png');
  fs.writeFileSync(out, img.toPNG());
  console.log(out, img.getSize());
  app.quit();
});
