'use strict';
// A macOS .dmg ablak hátterének kirajzolása (640×400 és 1280×800 @2x Retina).
// Az ikonok helye: KapuMail.app (x=170, y=180), Applications (x=470, y=180).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const outDir = process.argv.find((a) => a.startsWith('--out='))?.slice(6)
  || path.join(__dirname, '..', '.cache', 'dmg');
const plushB64 = fs.readFileSync(path.join(__dirname, '..', 'assets', 'plush.png')).toString('base64');
const plushUrl = `data:image/png;base64,${plushB64}`;

const html = `<!doctype html><html lang="hu"><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:640px;height:400px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}
body{
  background:
    radial-gradient(320px 240px at 110px 80px, rgba(246,166,204,.40), transparent 72%),
    radial-gradient(340px 250px at 530px 320px, rgba(167,139,250,.34), transparent 72%),
    linear-gradient(145deg, #fbf7fe 0%, #f3ecfb 48%, #fdf2f7 100%);
  position:relative;
}
.head{
  position:absolute;top:24px;left:0;right:0;
  display:flex;align-items:center;justify-content:center;gap:9px;
}
.head img{width:26px;height:26px;object-fit:contain;filter:drop-shadow(0 3px 6px rgba(91,58,158,.22))}
.head span{font-size:14px;font-weight:700;letter-spacing:-.01em;color:#2b1f47}
.head em{font-style:normal;font-weight:500;color:#6e5d92;font-size:12.5px}
.slot{
  position:absolute;top:98px;width:156px;height:164px;border-radius:26px;
  background:rgba(255,255,255,.56);
  border:1px solid rgba(139,106,208,.18);
  box-shadow:0 12px 28px -14px rgba(58,34,110,.16), inset 0 1px 0 rgba(255,255,255,.85);
}
.slot.left{left:92px}
.slot.right{left:392px}
.arrow{
  position:absolute;left:268px;top:156px;width:104px;height:48px;
  display:flex;align-items:center;justify-content:center;
}
.hint{
  position:absolute;bottom:26px;left:0;right:0;text-align:center;
  font-size:12.5px;font-weight:500;color:#5a4a7c;letter-spacing:.005em;
}
.hint b{color:#322254;font-weight:600}
</style>
<body>
  <div class="head">
    <img src="${plushUrl}" alt="">
    <span>KapuMail</span>
    <em>· Telepítés macOS-re</em>
  </div>
  <div class="slot left"></div>
  <div class="arrow">
    <svg width="96" height="36" viewBox="0 0 96 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="8" y1="18" x2="88" y2="18" gradientUnits="userSpaceOnUse">
          <stop stop-color="#7c5ce6"/>
          <stop offset="1" stop-color="#db4f9a"/>
        </linearGradient>
      </defs>
      <path d="M12 18H80" stroke="url(#g)" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M68 7L82 18L68 29" stroke="url(#g)" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>
  <div class="slot right"></div>
  <div class="hint">Húzd a <b>KapuMail</b> ikont az <b>Applications</b> (Alkalmazások) mappába</div>
</body></html>`;

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);

  for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
    const win = new BrowserWindow({
      width: 640,
      height: 400,
      show: false,
      frame: false,
      enableLargerThanScreen: true,
      webPreferences: { offscreen: true, deviceScaleFactor: scale, sandbox: false },
    });
    await win.loadURL(dataUrl);
    await new Promise((r) => setTimeout(r, 400));
    const img = await win.webContents.capturePage();
    const targetSize = { width: 640 * scale, height: 400 * scale };
    const finalImg = (img.getSize().width === targetSize.width && img.getSize().height === targetSize.height)
      ? img
      : img.resize({ ...targetSize, quality: 'best' });
    fs.writeFileSync(path.join(outDir, `background${suffix}.png`), finalImg.toPNG());
    win.destroy();
  }

  app.quit();
});
