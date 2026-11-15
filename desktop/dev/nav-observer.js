// Portálmegfigyelő (7. fázis: NAV; 10. fázis: ASP). Fejlesztői eszköz: nincs a telepítőcsomagban.
//
// Megnyit egy látható ablakot a hivatalos oldalra. TE lépsz be és TE kattintasz; a program csak figyeli, mit forgalmaz a
// hivatalos felület, és annak a SZERKEZETÉT jegyzi fel (dev/nav-shape.js). Saját kérést nem küld, mezőt nem tölt ki,
// semmire nem kattint. A jegyzőkönyv az ablak bezárásakor íródik ki a gitből kizárt research/kiserletek/kimenet/ mappába.
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { makeRecorder, allowedHost, allowedHostAsp } = require('./nav-shape');

const PROFILES = {
  nav: { nev: 'NAV', allowed: allowedHost, start: [
    ['NAV ügyfélportál (ugyfelportal.nav.gov.hu)', 'https://ugyfelportal.nav.gov.hu/'],
    ['NAV ügyfélportál – régi cím (upo.nav.gov.hu)', 'https://upo.nav.gov.hu/'],
    ['eBEV portál (ebev.nav.gov.hu)', 'https://ebev.nav.gov.hu/'],
    ['NAV főoldal (nav.gov.hu)', 'https://nav.gov.hu/'],
  ], teendo: 'Lépj be a NAV-portálra, és kattintsd végig, amit látni szeretnénk: képviselt adózók, adónaptár, bevallások, adószámla, törzsadatok.' },
  // Az ASP ügyféloldala. A címek a nyilvános belépőoldalak; hogy melyik él és mit forgalmaz, azt éppen a megfigyelés mutatja meg.
  asp: { nev: 'ASP', allowed: allowedHostAsp, start: [
    ['E-Önkormányzat Portál (ohp-20.asp.lgov.hu)', 'https://ohp-20.asp.lgov.hu/nyitolap'],
    ['E-Önkormányzat Portál – rövid cím (e-onkormanyzat.gov.hu)', 'https://e-onkormanyzat.gov.hu/'],
  ], teendo: 'Lépj be az E-Önkormányzat Portálra, és kattintsd végig, amit látni szeretnénk: önkormányzat kiválasztása, adóegyenleg-lekérdezés, ügykövetés, a szerepkör (saját név / cég képviselete) váltása.' },
};
const MAX_BODY = 2 * 1024 * 1024;

function run({ app, BrowserWindow, session, Menu, dialog, outDir, profile = 'nav' }) {
  const P = PROFILES[profile]; if (!P) { app.quit(); return; }
  const START = P.start, allowedHost = P.allowed, slug = profile;
  const rec = makeRecorder(allowedHost);
  const ses = session.fromPartition(`megfigyelo-${slug}`, { cache: false }); // memóriában él: bezáráskor a belépés is megszűnik
  const win = new BrowserWindow({ width: 1280, height: 900, title: `KapuMail – ${P.nev}-megfigyelő (csak figyel)`,
    webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
  const wc = win.webContents, dbg = wc.debugger;
  // Engedett gépnévre a sima http-s cím is átmehet: a munkamenet alább https-re emeli, mielőtt a kérés elindulna
  // (az ASP-portál a belépés után http-s címre irányít vissza). Titkosítatlan kérés így nem megy ki.
  const ok = url => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) && allowedHost(u.hostname); } catch { return false; } };
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (d, cb) => {
    try { const u = new URL(d.url); if (allowedHost(u.hostname)) { u.protocol = 'https:'; u.port = ''; return cb({ redirectURL: u.href }); } } catch { /* tiltjuk */ }
    cb({ cancel: true });
  });
  // A letiltott navigációnak a gépneve és a protokollja kiíródik (érték nélkül): ebből látszik, ha a portál az engedélylistán kívülre irányít.
  const blocked = new Set();
  const guard = (e, url) => { if (ok(url)) return; e.preventDefault(); let w = '(értelmezhetetlen cím)'; try { const u = new URL(url); w = `${u.protocol}//${u.hostname}`; } catch { /* marad */ } if (!blocked.has(w)) { blocked.add(w); console.log(`Letiltott navigáció: ${w}`); } };
  wc.on('did-fail-load', (_e, code, desc, url, main) => { if (main && code !== -3) { let w = ''; try { w = new URL(url).hostname; } catch { /* marad */ } console.log(`Betöltési hiba: ${code} ${desc} (${w})`); } });
  wc.on('will-navigate', guard); wc.on('will-redirect', guard);
  wc.setWindowOpenHandler(({ url }) => { if (ok(url)) wc.loadURL(url); return { action: 'deny' }; }); // az új lapra nyíló hivatkozás ugyanebben az ablakban nyílik
  wc.on('did-navigate', (_e, url) => rec.page(url)); wc.on('did-navigate-in-page', (_e, url) => rec.page(url));
  ses.on('will-download', e => e.preventDefault()); // megfigyelés közben semmit nem töltünk le

  const reqs = new Map();
  dbg.attach('1.3');
  dbg.on('message', (_e, method, p) => {
    try {
      if (method === 'Network.requestWillBeSent') reqs.set(p.requestId, { url: p.request.url, method: p.request.method, requestBody: p.request.postData || null, requestHeaders: p.request.headers || null });
      else if (method === 'Network.responseReceived') { const r = reqs.get(p.requestId); if (r) { r.status = p.response.status; r.contentType = p.response.headers['content-type'] || p.response.headers['Content-Type'] || ''; r.kind = p.type; } }
      else if (method === 'Network.loadingFinished') {
        const r = reqs.get(p.requestId); reqs.delete(p.requestId);
        if (!r || !r.status) return;
        // a JSON-válasznak és a HTML-oldalnak a szerkezete kell (űrlapmezők nevei, táblázatok mérete); más törzset nem olvasunk ki
        if (!/json|html/i.test(r.contentType) || p.encodedDataLength > MAX_BODY) { if (/^(XHR|Fetch|Document)$/.test(r.kind || '')) rec.add(r); return; }
        dbg.sendCommand('Network.getResponseBody', { requestId: p.requestId })
          .then(b => rec.add({ ...r, body: b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body }))
          .catch(() => rec.add(r));
      } else if (method === 'Network.loadingFailed') reqs.delete(p.requestId);
    } catch { /* a megfigyelés hibája nem zavarhatja az oldalt */ }
  });
  dbg.sendCommand('Network.enable').catch(() => {});

  let saved = false;
  const save = () => {
    if (saved) return null; saved = true;
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const file = path.join(outDir, `${slug}-megfigyeles-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify({ keszult: new Date().toISOString(), tiltottNavigaciok: [...blocked].sort(), ...rec.toJSON() }, null, 2));
    console.log(`${P.nev}-megfigyelés mentve (${rec.count()} kérés szerkezete, érték nélkül):\n  ${file}`);
    return file;
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []), { role: 'editMenu' },
    { label: 'Megfigyelő', submenu: [
      ...START.map(([label, url]) => ({ label: `Megnyitás: ${label}`, click: () => wc.loadURL(url).catch(() => {}) })),
      { type: 'separator' }, { label: 'Vissza', accelerator: 'CmdOrCtrl+[', click: () => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack() },
      { label: 'Újratöltés', accelerator: 'CmdOrCtrl+R', click: () => wc.reload() },
      { type: 'separator' }, { label: 'Mentés és kilépés', accelerator: 'CmdOrCtrl+S', click: () => win.close() },
    ] },
  ]));
  win.on('close', () => { save(); });
  win.on('closed', () => app.quit());
  dialog.showMessageBox(win, { type: 'info', buttons: ['Értem'], title: `${P.nev}-megfigyelő`,
    message: 'Ez az ablak csak figyel.',
    detail: P.teendo + '\n\nA program nem tölt ki mezőt, nem kattint, és saját kérést nem küld. Csak azt jegyzi fel, milyen címekről milyen SZERKEZETŰ válasz jött – nevek, adószámok, összegek nélkül.\n\nNe indíts beküldést vagy módosítást. Ha más címen van a portál, a „Megfigyelő” menüből válthatsz. A végén zárd be az ablakot: ekkor íródik ki a jegyzőkönyv.' })
    .then(() => wc.loadURL(START[0][1]).catch(() => {}));
}

module.exports = { run, PROFILES };
