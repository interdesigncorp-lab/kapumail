'use strict';
// Közös hamis AI-CLI: a viselkedést a FAKE_AI_STATE környezeti változó JSON-ja adja:
// {loggedIn, missing, hang, plan, lines[]}. A `claude`, `codex`, `agy` szkriptek ezt hívják a nevükkel.
// Egy kör (Kapu-chat, run.js): {fixture: <jsonl útvonal>, stderr?, exitCode?, hangAfter?, argsFile?} –
// kiírja a fixture sorait, és ha argsFile adott, oda menti a kapott argumentumokat, a bemenetet, a HOME-ot.
const fs = require('node:fs');
function turn(name, args, s) {
  const finish = (stdin) => {
    if (s.argsFile) fs.writeFileSync(s.argsFile, JSON.stringify({ name, args, stdin, cwd: process.cwd(), home: process.env.HOME, env: Object.keys(process.env) }));
    if (s.stderr) process.stderr.write(s.stderr + '\n');
    if (s.fixture) process.stdout.write(fs.readFileSync(s.fixture, 'utf8'));
    if (s.hangAfter || s.hang) { setInterval(() => {}, 1000); return; }
    process.exitCode = s.exitCode || 0;
  };
  // A kérdés mindhárom motornál a bemeneten jön (run.js stdinFor).
  {
    let stdin = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { stdin += d; });
    process.stdin.on('end', () => finish(stdin));
  }
}
function run(name, args) {
  const s = JSON.parse(process.env.FAKE_AI_STATE || '{}');
  const out = (t) => process.stdout.write(t + '\n');
  if (s.missing) { process.stderr.write(`${name}: command not found\n`); process.exit(127); }
  if (args.includes('--output-format') || args[0] === 'exec') return turn(name, args, s);
  if (s.hang) { setInterval(() => {}, 1000); return; }
  if (name === 'claude' && args.join(' ') === 'auth status --json') {
    out(JSON.stringify(s.loggedIn ? { loggedIn: true, authMethod: 'claude.ai', subscriptionType: s.plan || 'max' } : { loggedIn: false }));
    process.exit(s.loggedIn ? 0 : 1);
  }
  if (name === 'codex' && args.join(' ') === 'login status') {
    // A valódi codex az állapotot a stderr-re írja.
    const err = (t) => process.stderr.write(t + '\n');
    if (s.loggedIn) { err(s.lines ? s.lines.join('\n') : 'Logged in using ChatGPT'); process.exit(0); }
    err('Not logged in'); process.exit(1);
  }
  if (name === 'agy' && args.join(' ') === 'models') {
    out('Fetching available models...');
    for (const l of (s.loggedIn ? s.lines || [] : [])) out(l);
    // A valódi agy kilépve a figyelmeztetést a stderr-re írja.
    if (!s.loggedIn && s.realSignedOut) process.stderr.write('Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n');
    process.exit(s.loggedIn ? 0 : 1);
  }
  process.stderr.write('ismeretlen hívás: ' + args.join(' ') + '\n'); process.exit(2);
}
module.exports = { run };
