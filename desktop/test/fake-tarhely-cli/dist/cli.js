// Ál tarhely-cli: a valódi `--json` kimenet alakját utánozza, hálózat és belépés nélkül.
const [cmd, ...rest] = process.argv.slice(2);
const out = o => { process.stdout.write(JSON.stringify({ steps: [], ...o }) + '\n'); process.exit(o.code); };
if (process.env.FAKE_FAIL === 'login') out({ ok: false, code: 3, error: 'A belépés sikertelen.', hint: 'init újra' });
if (cmd === 'doctor') out({ ok: true, code: 0, checks: [{ name: 'node', ok: true, detail: process.version }, { name: 'credentials', ok: true, detail: 'kulcstartó' }] });
if (cmd === 'mailboxes') out({ ok: true, code: 0, mailboxes: [{ index: 1, name: 'Értesítési tárhely', slug: 'ertesitesi-tarhely' }, { index: 2, name: '12345678 Példa Kft.', slug: '12345678-pelda-kft' }] });
if (cmd === 'list') out({ ok: true, code: 0, letters: [
  { eid: '000000012026110800000001', mailbox: '12345678 Példa Kft.', sender: 'NAV', senderFull: 'Nemzeti Adó- és Vámhivatal', recipient: 'x', type: 'NAV - Átvezetés végzés', desc: '', receivedAt: '2026-11-08 09:12', receivedOn: '2026-11-08', size: 1234, isNew: true },
  { eid: '000000012026110900000002', mailbox: 'Értesítési tárhely', sender: 'KH', senderFull: 'Kormányhivatal', recipient: 'x', type: 'Kormányhivatal - Nyugta', desc: 'Nyugta', receivedAt: '2026-11-09 10:00', receivedOn: '2026-11-09', size: 500, isNew: true },
  { eid: null, mailbox: 'Értesítési tárhely', sender: 'X', senderFull: 'X', type: 'azonosító nélkül', desc: '', receivedAt: '2026-11-09 10:00' },
].filter(l => !rest.includes('--since') || !l.receivedAt || l.receivedAt.slice(0, 10) >= rest[rest.indexOf('--since') + 1]) });
process.stderr.write('Hiba: ismeretlen parancs\n'); process.exit(1);
