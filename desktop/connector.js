// Élő tárhely-csatlakozó: a godavid/tarhely-cli (MIT) parancssori eszközét hívja helyben.
//
// Amit tud:   környezet-ellenőrzés (doctor), postafiókok (mailboxes), levéllista (list).
// Amit NEM:   letöltés, tartós tár, küldés, törlés – ezekhez itt szándékosan nincs kód.
//
// A belépési adatot ez a modul nem látja és nem kezeli: a tarhely-cli a rendszer kulcstartójából
// olvassa, ahová a felhasználó a saját termináljában, a `tarhely-cli init` paranccsal tette.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ALLOWED = { doctor: [], mailboxes: [], list: ['--since'] };

/** A kiválasztott fájl valóban a tarhely-cli belépési pontja-e. */
function validateCli(cliPath) {
  try {
    if (path.basename(cliPath) !== 'cli.js' || !fs.statSync(cliPath).isFile()) return { ok: false, error: 'A tarhely-cli dist/cli.js fájlját válaszd ki.' };
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(cliPath), '..', 'package.json'), 'utf8'));
    if (pkg.name !== 'tarhely-cli') return { ok: false, error: 'Ez nem a tarhely-cli csomag.' };
    return { ok: true, version: String(pkg.version || '?') };
  } catch { return { ok: false, error: 'A fájl nem olvasható, vagy nem a tarhely-cli része.' }; }
}

function nodeBinary() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8' });
  const found = r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
  return found ? { bin: found, env: {} } : { bin: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** Egy engedélyezett parancs futtatása. Shell nincs; az argumentumok rögzítettek és ellenőrzöttek. */
function run(cliPath, command, opts = {}) {
  return new Promise(resolve => {
    if (!(command in ALLOWED)) return resolve({ ok: false, code: 1, error: `Nem engedélyezett parancs: ${command}` });
    const v = validateCli(cliPath);
    if (!v.ok) return resolve({ ok: false, code: 1, error: v.error });
    const args = [cliPath, command, '--json'];
    if (opts.since) {
      if (!ALLOWED[command].includes('--since') || !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) return resolve({ ok: false, code: 1, error: 'Érvénytelen dátum.' });
      args.push('--since', opts.since);
    }
    const node = nodeBinary();
    const child = spawn(node.bin, args, { env: { ...process.env, ...node.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = r => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { child.kill(); finish({ ok: false, code: 1, error: 'Időtúllépés: a tárhely nem válaszolt időben.' }); }, opts.timeoutMs || 180000);
    child.stdout.on('data', d => { out += d; if (out.length > 20e6) child.kill(); });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => finish({ ok: false, code: 1, error: 'A tarhely-cli nem indítható: ' + e.message }));
    child.on('close', code => {
      const line = out.trim().split(/\r?\n/).filter(l => l.startsWith('{')).pop();
      try { finish({ ...JSON.parse(line), exit: code }); }
      catch { finish({ ok: false, code: code ?? 1, error: (err.trim().split(/\r?\n/).pop() || 'A tarhely-cli nem adott értelmezhető választ.').slice(0, 300) }); }
    });
  });
}

/** Csak azt adjuk tovább a felületnek és a szervernek, amire a listához szükség van. */
function slimLetters(result) {
  const cap = (s, n) => String(s ?? '').slice(0, n);
  return (Array.isArray(result.letters) ? result.letters : []).filter(l => l && l.eid).slice(0, 2000).map(l => ({
    eid: cap(l.eid, 80), mailbox: cap(l.mailbox, 200), sender: cap(l.sender, 120), senderFull: cap(l.senderFull, 200),
    type: cap(l.type, 200), desc: cap(l.desc, 300), receivedAt: cap(l.receivedAt, 16),
  }));
}

module.exports = { validateCli, run, slimLetters, ALLOWED };
