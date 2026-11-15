'use strict';
// Az alkalmazás-frissítő (desktop/updater.js) és a felső frissítési csík (app.html) tesztjei.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  compareVersions,
  isAllowedUrl,
  parseLatestRelease,
  pickArtifact,
  appBundle,
  signingTeam,
  stageMacUpdate,
  downloadAndVerify,
  createUpdater,
} = require('../updater');

const sha256Hex = buf => crypto.createHash('sha256').update(buf).digest('hex');

const VALID_SHA = 'a'.repeat(64);
const SAMPLE_MANIFEST = {
  version: '0.2.0',
  date: '2026-11-20',
  notes: 'https://kapumail.hu/#letoltes',
  described: true,
  download: 'https://kapumail.hu/#letoltes',
  mac: {
    arm64: { url: 'https://kapumail.hu/letoltes/KapuMail-0.2.0-arm64.dmg', sha256: VALID_SHA, bytes: 1024 },
    x64: { url: 'https://kapumail.hu/letoltes/KapuMail-0.2.0-x64.dmg', sha256: VALID_SHA, bytes: 2048 },
  },
  windows: {
    x64: { url: 'https://kapumail.hu/letoltes/KapuMail-Setup-0.2.0.exe', sha256: VALID_SHA, bytes: 4096 },
  },
};

test('compareVersions és parseLatestRelease: szigorú séma- és origó-ellenőrzés', () => {
  assert.equal(compareVersions('0.2.0', '0.1.0'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.9', '0.2.0'), -1);

  assert.equal(isAllowedUrl('https://kapumail.hu/letoltes/latest.json'), true);
  assert.equal(isAllowedUrl('https://evil.example.com/latest.json'), false);
  assert.equal(isAllowedUrl('http://kapumail.hu/letoltes/latest.json'), false);
  assert.equal(isAllowedUrl('http://127.0.0.1:9123/latest.json', false), false);
  assert.equal(isAllowedUrl('http://127.0.0.1:9123/latest.json', true), true);

  const parsed = parseLatestRelease(SAMPLE_MANIFEST);
  assert.ok(parsed);
  assert.equal(parsed.version, '0.2.0');
  assert.equal(pickArtifact(parsed, { platform: 'darwin', arch: 'arm64' }).url, 'https://kapumail.hu/letoltes/KapuMail-0.2.0-arm64.dmg');
  assert.equal(pickArtifact(parsed, { platform: 'win32', arch: 'x64' }).url, 'https://kapumail.hu/letoltes/KapuMail-Setup-0.2.0.exe');

  // Idegen domainről érkező telepítő URL elutasítva
  const bad = structuredClone(SAMPLE_MANIFEST);
  bad.mac.arm64.url = 'https://attacker.invalid/KapuMail-0.2.0-arm64.dmg';
  bad.mac.x64 = null;
  bad.windows.x64 = null;
  assert.equal(parseLatestRelease(bad), null);
});

test('appBundle és signingTeam: macOS csomagútvonal és TeamIdentifier kinyerése', async () => {
  assert.equal(appBundle('/Applications/KapuMail.app/Contents/MacOS/KapuMail'), '/Applications/KapuMail.app');
  assert.equal(appBundle('/usr/local/bin/electron'), null);

  const team = await signingTeam('/Applications/KapuMail.app', async () => ({
    stdout: '',
    stderr: 'Authority=Developer ID Application: Test\nTeamIdentifier=AB12CD34EF\n',
  }));
  assert.equal(team, 'AB12CD34EF');
});

test('downloadAndVerify: ellenőrzi a SHA-256 lenyomatot és hibás hash esetén törli a részfájlt', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'km-upd-dl-'));
  try {
    const payload = Buffer.from('kapumail-test-binary-payload');
    const goodSha = sha256Hex(payload);
    const progress = [];
    const fetchStub = async () => ({
      ok: true,
      status: 200,
      url: 'https://kapumail.hu/letoltes/KapuMail-0.2.0-arm64.dmg',
      headers: { get: k => (k === 'content-length' ? String(payload.length) : null) },
      async arrayBuffer() { return payload; },
    });

    const dest = path.join(tmp, 'KapuMail-0.2.0-arm64.dmg');
    await downloadAndVerify('https://kapumail.hu/letoltes/KapuMail-0.2.0-arm64.dmg', goodSha, dest, {
      fetchImpl: fetchStub,
      onProgress: (r, t) => progress.push([r, t]),
    });
    assert.equal(fs.existsSync(dest), true);
    assert.equal(progress.length, 1);

    const badDest = path.join(tmp, 'bad.dmg');
    await assert.rejects(
      () => downloadAndVerify('https://kapumail.hu/letoltes/KapuMail-0.2.0-arm64.dmg', '0'.repeat(64), badDest, { fetchImpl: fetchStub }),
      /ellenőrzőösszege nem egyezik/,
    );
    assert.equal(fs.existsSync(badDest), false);
    assert.deepEqual(fs.readdirSync(tmp).filter(f => f.includes('.part')), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createUpdater: aláírt macOS csomag letöltése, előkészítése és kilépéskori atomi cseréje', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'km-upd-mac-'));
  try {
    const payload = Buffer.from('signed-dmg-bytes');
    const sha = sha256Hex(payload);
    const manifest = structuredClone(SAMPLE_MANIFEST);
    manifest.mac.arm64.sha256 = sha;
    manifest.mac.arm64.bytes = payload.length;

    const phases = [];
    const notices = [];
    let swaps = [];
    let quitCalled = 0;

    const stagedFakePath = path.join(tmp, '.KapuMail-0.2.0.app');
    const upd = createUpdater({
      currentVersion: '0.1.0',
      isPackaged: true,
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tmp,
      tempDir: tmp,
      downloadsDir: tmp,
      replaceablePromise: Promise.resolve({ bundle: path.join(tmp, 'KapuMail.app'), team: 'AB12CD34EF' }),
      fetchImpl: async url => {
        if (url.endsWith('latest.json')) {
          return { ok: true, status: 200, text: async () => JSON.stringify(manifest) };
        }
        return {
          ok: true,
          status: 200,
          url,
          headers: { get: () => String(payload.length) },
          async arrayBuffer() { return payload; },
        };
      },
      stageFn: async ({ version }) => {
        assert.equal(version, '0.2.0');
        fs.mkdirSync(stagedFakePath, { recursive: true });
        return stagedFakePath;
      },
      swapFn: opts => { swaps.push(opts); },
      quitApp: () => { quitCalled++; },
      onProgress: p => phases.push(p.phase),
      onNotifyAvailable: rel => notices.push(rel.version),
    });

    const st = await upd.check();
    assert.equal(st.available, true);
    assert.equal(st.canInstall, true);
    assert.equal(st.latest.version, '0.2.0');
    assert.deepEqual(notices, ['0.2.0']);

    // Másodszor ugyanarra a verzióra nem küld új rendszerértesítést
    await upd.check();
    assert.deepEqual(notices, ['0.2.0']);

    const res = await upd.install();
    assert.equal(res.ok, true);
    assert.equal(res.mode, 'replace');
    assert.deepEqual(phases, ['downloading', 'downloading', 'verifying', 'ready']);

    await upd.restartToUpdate();
    assert.equal(quitCalled, 1);
    assert.equal(upd.applyStagedOnQuit(), true);
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0].relaunch, true);
    assert.equal(swaps[0].stagedPath, stagedFakePath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('app.html: a frissítési csík a felső .tophead sávban jelenik meg, kezeli a szundit, a licencet és az állapotokat', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'resources', 'ui', 'app.html'), 'utf8');

  // 1) A #updbanner közvetlenül a .tophead sávban, a #winbar mellett van, az #app előtt
  assert.match(html, /<header class="tophead" id="tophead"><div class="winbar" id="winbar"><\/div><div class="upd-banner" id="updbanner"[^>]*hidden><\/div><\/header>/);
  assert.match(html, /\.app\{position:fixed;top:calc\(30px \+ var\(--upd-h,0px\)\)/);

  // 2) Kivágjuk az updRender és updateCardHtml logikát és lefuttatjuk izolált környezetben
  const start = html.indexOf('const UPD_SNOOZE_KEY=');
  const end = html.indexOf('(function updInit()');
  assert.ok(start > 0 && end > start, 'Az updRender blokk megtalálható az app.html-ben');
  const snippet = html.slice(start, end);

  const store = new Map();
  const banner = { hidden: true, innerHTML: '', dataset: {}, offsetHeight: 42 };
  const rootProps = {};
  const documentStub = {
    documentElement: { style: { setProperty: (k, v) => { rootProps[k] = v; } } },
    getElementById: id => (id === 'updbanner' ? banner : null),
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = n => `<svg data-ic="${n}"></svg>`;
  let OFFICE = { license: { officialBuild: true, state: 'active', canSync: true } };

  const api = new Function(
    'window', 'document', 'localStorage', 'ResizeObserver', 'getComputedStyle', 'esc', 'ic', 'navigator', 'getOffice',
    `
    let OFFICE = getOffice();
    ${snippet}
    return {
      UPD,
      setOffice: o => { OFFICE = o; },
      updRender,
      updSnooze,
      updateCardHtml,
    };
    `,
  )(
    { iratkapuDesktop: { updater: {} } },
    documentStub,
    { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    undefined,
    () => ({ marginTop: '1px', marginBottom: '7px' }),
    esc,
    ic,
    { userAgent: 'KapuMail-Desktop/0.1.0' },
    () => OFFICE,
  );

  // Ajánlat állapot (aláírt Mac: Frissítés gomb + Újdonságok + Később)
  api.UPD.state = {
    current: '0.1.0',
    enabled: true,
    canInstall: true,
    checkedAt: new Date().toISOString(),
    failed: false,
    available: true,
    latest: { version: '0.2.0', date: '2026-11-20', notes: 'https://kapumail.hu/#letoltes', described: true, download: 'https://kapumail.hu/#letoltes' },
  };
  api.updRender();
  assert.equal(banner.hidden, false);
  assert.equal(rootProps['--upd-h'], '50px');
  assert.match(banner.innerHTML, /Elérhető a KapuMail 0\.2\.0\./);
  assert.match(banner.innerHTML, />Újdonságok<\/a>/);
  assert.match(banner.innerHTML, /data-updgo>Frissítés<\/button>/);
  assert.match(banner.innerHTML, /data-updlater="0\.2\.0">Később<\/button>/);

  // Később (24 órás elnémítás erre a verzióra) → eltűnik, de 0.2.1-nél azonnal megjelenik
  api.updSnooze('0.2.0');
  api.updRender();
  assert.equal(banner.hidden, true);
  assert.equal(rootProps['--upd-h'], '0px');

  api.UPD.state.latest.version = '0.2.1';
  api.updRender();
  assert.equal(banner.hidden, false);
  assert.match(banner.innerHTML, /Elérhető a KapuMail 0\.2\.1\./);

  // Lejárt próbaidőszak / előfizetés esetén: Előfizetés aktiválása gomb jelenik meg
  api.setOffice({ license: { officialBuild: true, state: 'expired', canSync: false } });
  api.updRender();
  assert.match(banner.innerHTML, /a frissítéshez aktív előfizetés szükséges/);
  assert.match(banner.innerHTML, /data-trialmodal>Előfizetés aktiválása<\/button>/);

  // Letöltés közbeni állapot (64%) + Újraindításra kész állapot
  api.setOffice({ license: { officialBuild: true, state: 'active', canSync: true } });
  api.UPD.progress = { phase: 'downloading', version: '0.2.1', percent: 64 };
  api.updRender();
  assert.equal(banner.dataset.phase, 'downloading');
  assert.match(banner.innerHTML, /A KapuMail 0\.2\.1 letöltése…/);
  assert.match(banner.innerHTML, /64%/);
  assert.match(banner.innerHTML, /--upd-pct:64%/);

  api.UPD.progress = { phase: 'ready', version: '0.2.1', mode: 'replace' };
  api.updRender();
  assert.equal(banner.dataset.phase, 'ready');
  assert.match(banner.innerHTML, /Kész a KapuMail 0\.2\.1\./);
  assert.match(banner.innerHTML, /Kilépéskor települ, vagy most rögtön egy újraindítással\./);
  assert.match(banner.innerHTML, /data-updrestart>Újraindítás most<\/button>/);

  // Beállítások → Ezen a gépen kártya
  const card = api.updateCardHtml();
  assert.match(card, /id="updcard"/);
  assert.match(card, /Ez a KapuMail <b>0\.1\.0<\/b>\./);
  assert.match(card, /Frissítések keresése/);
});
