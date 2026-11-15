'use strict';
// Kapu-chat: modellválasztó (kapu/models.js), a modell a parancssorban (buildArgs), az ellenőrzés és a tárolás.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../kapu/models');
const R = require('../kapu/run');
const { createStore } = require('../kapu/store');
const { createKapu } = require('../kapu');

const dirs = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kapu-models-')); dirs.push(d); return d; }
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const encrypt = (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a));
const decrypt = (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8');

// `agy models` 2026-11-13 (részlet, keverten)
const AGY = ['gemini-4-carbon-medium', 'gemini-4-carbon-high', 'gemini-4-carbon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low',
  'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-low', 'gemini-pro-orchestrator', 'gemini-pro-orchestrator-argon',
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'claude-opus-5-5-low', 'claude-opus-5-5-high', 'gpt-oss-120b-medium'];

test('models: Claude és ChatGPT ismert tartaléklistája gyorstól okosig, magyar jelzéssel; az alap a kiegyensúlyozott', () => {
  assert.deepStrictEqual(M.options('codex').map((o) => [o.id, o.label, o.hint]), [
    ['gpt-6-luna', 'GPT-6 Luna', 'gyors'], ['gpt-6-sol', 'GPT-6 Sol', 'kiegyensúlyozott'], ['gpt-6-astra', 'GPT-6 Astra', 'legokosabb']]);
  assert.deepStrictEqual(M.options('claude').map((o) => [o.id, o.label, o.hint]), [
    ['claude-haiku-5-5', 'Haiku 5.5', 'gyors'],
    ['claude-sonnet-5-5', 'Sonnet 5.5', 'kiegyensúlyozott'],
    ['claude-opus-5-5', 'Opus 5.5', 'okosabb, lassabb'],
    ['claude-fable-5-2', 'Fable 5.2', 'legokosabb, leglassabb'],
  ]);
  assert.strictEqual(M.defaultModel('codex'), 'gpt-6-sol');
  assert.strictEqual(M.defaultModel('claude'), 'claude-sonnet-5-5');
  assert.strictEqual(M.options('claude')[0].hint, 'gyors');
  assert.ok(!M.options('codex').some((o) => o.id === 'gpt-6.1-sol')); // ChatGPT-fiókkal nem fut az alaplistában
});

test('models: Claude és Codex élő katalógus feldolgozása (helyi/nyilvános JSON, debug models, főverzió-szűrés)', () => {
  const localClaude = {
    version: 2,
    catalog: {
      config: {
        models: [
          { id: 'claude-opus-5-5', section: 'main' },
          { id: 'claude-fable-5-2', section: 'main' },
          { id: 'claude-sonnet-5-5', section: 'main' },
          { id: 'claude-haiku-5-5', section: 'main' },
          { id: 'claude-fable-5-1', section: 'overflow' },
          { id: 'claude-haiku-4-5-20251001', section: 'overflow' },
          { id: '--bad-flag', section: 'main' },
        ],
      },
    },
  };
  const claudeIds = M.parseClaudeCatalog(localClaude);
  assert.deepStrictEqual(claudeIds, ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.deepStrictEqual(M.options('claude', ['claude-fable-5-3', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5']).map((o) => [o.id, o.label]), [
    ['claude-haiku-5-5', 'Haiku 5.5'],
    ['claude-sonnet-5-5', 'Sonnet 5.5'],
    ['claude-fable-5-3', 'Fable 5.3'],
  ]);
  const pubClaude = { surfaces: { cc: { model_selector_config: [{ id: 'cc', models: [{ id: 'claude-fable-6', section: 'main' }, { id: 'claude-sonnet-6', section: 'main' }] }] } } };
  assert.deepStrictEqual(M.parseClaudeCatalog(pubClaude), ['claude-fable-6', 'claude-sonnet-6']);

  const codexRaw = JSON.stringify({
    models: [
      { slug: 'gpt-6-astra', visibility: 'list', supported_in_api: true },
      { slug: 'gpt-6-chat-thinking', visibility: 'hide', supported_in_api: true },
      { slug: 'gpt-6.2-sol', visibility: 'list', supported_in_api: true },
      { slug: 'gpt-6-sol', visibility: 'list', supported_in_api: true },
      { slug: 'gpt-6-luna', visibility: 'list', supported_in_api: true },
      { slug: 'gpt-5.6-terra', visibility: 'list', supported_in_api: true },
    ],
  });
  const codexIds = M.parseCodexModels(codexRaw);
  assert.deepStrictEqual(codexIds, ['gpt-6-astra', 'gpt-6.2-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-terra']);
  assert.deepStrictEqual(M.options('codex', codexIds).map((o) => [o.id, o.label, o.hint]), [
    ['gpt-6-luna', 'GPT-6 Luna', 'gyors'],
    ['gpt-6.2-sol', 'GPT-6.2 Sol', 'kiegyensúlyozott'],
    ['gpt-6-astra', 'GPT-6 Astra', 'legokosabb'],
  ]);
  assert.strictEqual(M.defaultModel('codex', codexIds), 'gpt-6.2-sol');
});

test('models: agy – erőfokonkénti sorok változatonként egy elemmé, csak Gemini, gyorstól okosig; argv az erőfokkal', () => {
  assert.deepStrictEqual(M.foldEffortVariants(['a-low', 'a-high', 'a-medium', 'b']), [
    { id: 'a', efforts: ['low', 'medium', 'high'], effort: 'medium' }, { id: 'b', efforts: [], effort: null }]);
  assert.deepStrictEqual(M.foldEffortVariants(['x-high', 'x-xhigh'])[0].effort, 'high');
  const o = M.options('agy', AGY);
  assert.deepStrictEqual(o.map((x) => x.id), ['gemini-3.8-flash', 'gemini-4-argon', 'gemini-4-carbon', 'gemini-4-hydrogen']);
  assert.deepStrictEqual(o.map((x) => x.hint), ['gyors', 'kiegyensúlyozott', 'okosabb', 'legokosabb']);
  assert.strictEqual(o[0].label, 'Gemini 3.8 Flash');
  assert.strictEqual(o[1].argv, 'gemini-4-argon-medium');
  assert.strictEqual(M.defaultModel('agy', AGY), 'gemini-4-argon');
  // élő lista nélkül az ismert tartalék
  assert.deepStrictEqual(M.options('agy').map((x) => x.id), ['gemini-3.8-flash', 'gemini-4-argon']);
  assert.deepStrictEqual(M.parseAgyModels('gemini-4-argon-low\tGemini 4 Argon (Low)\nFetching…\nrossz id;rm\tX\n'), ['gemini-4-argon-low']);
});

test('models: resolve – ismeretlen vagy furcsa azonosító elutasítva', () => {
  assert.strictEqual(M.resolve('codex', 'gpt-6-sol').argv, 'gpt-6-sol');
  for (const bad of ['gpt-9', '--dangerously-skip-permissions', 'gpt-6-sol --x', '', null, 'GPT-6-SOL', 'claude-sonnet-5-5']) assert.strictEqual(M.resolve('codex', bad), null, String(bad));
  assert.strictEqual(M.resolve('agy', 'gemini-4-carbon'), null); // csak élő listával
  assert.strictEqual(M.resolve('agy', 'gemini-4-carbon', AGY).argv, 'gemini-4-carbon-medium');
  assert.strictEqual(M.resolve('agy', 'gemini-4-argon-medium', AGY), null); // a változat azonosítója a választható
  assert.strictEqual(M.resolve('nincs', 'gpt-6-sol'), null);
});

test('buildArgs: a modell motoronként a CLI saját kapcsolójával; hibás alak elutasítva', () => {
  const at = (a, flag) => a[a.indexOf(flag) + 1];
  const c = R.buildArgs('claude', { mcpFile: '/x/m.json', personaFile: '/x/p.md', model: 'claude-opus-5-5' });
  assert.strictEqual(at(c, '--model'), 'claude-opus-5-5');
  const x = R.buildArgs('codex', { cwd: '/x', model: 'gpt-6-luna' });
  assert.strictEqual(at(x, '-m'), 'gpt-6-luna');
  assert.strictEqual(x[x.length - 1], '-');
  const xr = R.buildArgs('codex', { sessionId: 's1', model: 'gpt-6-luna' });
  assert.strictEqual(at(xr, '-m'), 'gpt-6-luna');
  assert.deepStrictEqual(xr.slice(-2), ['s1', '-']);
  const g = R.buildArgs('agy', { model: 'gemini-4-argon-medium' });
  assert.strictEqual(at(g, '--model'), 'gemini-4-argon-medium');
  // modell nélkül nincs kapcsoló (a CLI alapja)
  assert.ok(!R.buildArgs('agy', {}).includes('--model'));
  assert.ok(!R.buildArgs('codex', { cwd: '/x' }).includes('-m'));
  for (const bad of ['--x', 'a b', 'A', 'x;y', 5]) assert.throws(() => R.buildArgs('codex', { cwd: '/x', model: bad }), /modell/);
});

test('store: a beszélgetés modellje és a válasz modellje megmarad', () => {
  const dir = path.join(tmp(), 'kapu', '3-9');
  const s = createStore({ dir, encrypt, decrypt });
  const id = s.create('codex', 'gpt-6-sol');
  assert.strictEqual(s.get(id).model, 'gpt-6-sol');
  s.setModel(id, 'gpt-6-astra');
  s.append(id, { role: 'kapu', text: 'Szia', model: 'gpt-6-astra' });
  s.append(id, { role: 'kapu', text: 'x', model: '--rossz' });
  const again = createStore({ dir, encrypt, decrypt }).get(id);
  assert.strictEqual(again.model, 'gpt-6-astra');
  assert.deepStrictEqual(again.messages.map((m) => m.model), ['gpt-6-astra', undefined]);
  assert.strictEqual(s.list()[0].model, 'gpt-6-astra');
  assert.throws(() => s.setModel(id, 'a b'), /modell/);
  assert.strictEqual(s.get(s.create('claude')).model, null);
});

function makeKapu({ agy = AGY } = {}) {
  const cfg = {};
  const vault = {};
  const runs = [];
  const statusCalls = [];
  const k = createKapu({
    userData: tmp(), encrypt, decrypt,
    readCfg: () => cfg, saveCfg: (p) => Object.assign(cfg, p),
    readSecret: (ref) => vault[ref] || null, writeSecret: (ref, v) => { vault[ref] = v; },
    mcpBase: () => ({ mode: 'stdio', php: 'php', artisan: '/app/artisan' }),
    resolveScope: async () => ({ officeId: 3, userId: 9 }),
    startRun: (opts) => { const r = { opts, cancelled: false }; runs.push(r); return { cancel() { r.cancelled = true; } }; },
    isolation: { sweep: () => {}, forgetSession: () => {} },
    providers: {
      ENGINES: ['claude', 'codex', 'agy'],
      status: async (e) => { statusCalls.push(e); return { engine: e, installed: true, signedIn: true, ...(e === 'agy' && agy ? { models: agy } : {}) }; },
      openSignIn: async () => ({}), signInCommand: () => 'x',
    },
  });
  return { k, cfg, runs, statusCalls };
}
const on = async (x, engine) => { x.k.setConfig({ on: true, engine }); await x.k.storeToken('kapu-token-0123456789', { officeId: 3, userId: 9 }); };

test('index: alapmodell, választott modell a beszélgetéssel, ismeretlen modell elutasítva', async () => {
  const x = makeKapu();
  await on(x, 'codex');
  const a = await x.k.send({ text: 'Szia' });
  assert.strictEqual(x.runs[0].opts.model, 'gpt-6-sol'); // a kiegyensúlyozott
  assert.strictEqual((await x.k.get(a.convId)).model, 'gpt-6-sol');
  x.runs[0].opts.onEvent({ type: 'final', text: 'Helló.' });
  assert.strictEqual((await x.k.get(a.convId)).messages[1].model, 'gpt-6-sol');
  // a beszélgetés modellje átállítható, a következő kör azzal megy
  await x.k.send({ convId: a.convId, text: 'És most?', model: 'gpt-6-astra' });
  assert.strictEqual(x.runs[1].opts.model, 'gpt-6-astra');
  assert.strictEqual((await x.k.get(a.convId)).model, 'gpt-6-astra');
  await x.k.setModel(a.convId, 'gpt-6-luna');
  await x.k.send({ convId: a.convId, text: 'Harmadik' });
  assert.strictEqual(x.runs[2].opts.model, 'gpt-6-luna');
  // ismeretlen: a kör el sem indul, a tárolt modell nem változik
  await assert.rejects(x.k.send({ convId: a.convId, text: 'x', model: 'gpt-9-ultra' }), /Ismeretlen modell/);
  await assert.rejects(x.k.send({ convId: a.convId, text: 'x', model: '--dangerously-skip-permissions' }), /Ismeretlen modell/);
  await assert.rejects(x.k.setModel(a.convId, 'claude-opus-5-5'), /Ismeretlen modell/);
  assert.strictEqual(x.runs.length, 3);
  assert.strictEqual((await x.k.get(a.convId)).model, 'gpt-6-luna');
});

test('index: a motor alapmodellje a beállításban; az agy élő listából ellenőriz és erőfokkal indít', async () => {
  const x = makeKapu();
  await on(x, 'agy');
  assert.throws(() => x.k.setConfig({ model: { engine: 'codex', id: 'gpt-9' } }), /Ismeretlen modell/);
  assert.throws(() => x.k.setConfig({ model: { engine: 'nincs', id: 'gpt-6-sol' } }), /Ismeretlen motor/);
  x.k.setConfig({ model: { engine: 'codex', id: 'gpt-6-astra' } });
  assert.deepStrictEqual(x.cfg.kapu.model, { codex: 'gpt-6-astra' });
  assert.deepStrictEqual(x.k.config().model, { codex: 'gpt-6-astra' });
  const cat = await x.k.modelCatalog();
  assert.deepStrictEqual(x.statusCalls, ['agy']); // az `agy models` egyszer
  assert.strictEqual(cat.codex.selected, 'gpt-6-astra');
  assert.strictEqual(cat.agy.selected, 'gemini-4-argon');
  assert.deepStrictEqual(cat.agy.options.map((o) => o.id), ['gemini-3.8-flash', 'gemini-4-argon', 'gemini-4-carbon', 'gemini-4-hydrogen']);
  assert.deepStrictEqual(Object.keys(cat.claude.options[0]).sort(), ['hint', 'id', 'label']);
  x.k.setConfig({ model: { engine: 'agy', id: 'gemini-4-hydrogen' } });
  const r = await x.k.send({ text: 'Szia' });
  assert.strictEqual(x.runs[0].opts.model, 'gemini-4-hydrogen-medium');
  assert.strictEqual((await x.k.get(r.convId)).model, 'gemini-4-hydrogen');
  x.k.setConfig({ model: { engine: 'agy', id: null } });
  assert.deepStrictEqual(x.cfg.kapu.model, { codex: 'gpt-6-astra' });
});

test('index: az élő lista nélkül az agy az ismert tartalékot használja', async () => {
  const x = makeKapu({ agy: null });
  await on(x, 'agy');
  const cat = await x.k.modelCatalog();
  assert.deepStrictEqual(cat.agy.options.map((o) => o.id), ['gemini-3.8-flash', 'gemini-4-argon']);
  await assert.rejects(x.k.send({ text: 'x', model: 'gemini-4-carbon' }), /Ismeretlen modell/);
  await x.k.send({ text: 'x', model: 'gemini-3.8-flash' });
  assert.strictEqual(x.runs[0].opts.model, 'gemini-3.8-flash-medium');
});

test('index: induláskor (warmup) és összekötéskor (signedIn false→true) élőben frissíti a Claude és Codex modelleket', async () => {
  const cfg = {};
  const vault = {};
  const signed = { claude: true, codex: false, agy: false };
  const fetchCalls = [];
  let claudeLive = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'];
  let codexLive = ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'];
  const k = createKapu({
    userData: tmp(), encrypt, decrypt,
    readCfg: () => cfg, saveCfg: (p) => Object.assign(cfg, p),
    readSecret: (ref) => vault[ref] || null, writeSecret: (ref, v) => { vault[ref] = v; },
    mcpBase: () => ({ mode: 'stdio', php: 'php', artisan: '/app/artisan' }),
    resolveScope: async () => ({ officeId: 3, userId: 9 }),
    isolation: { sweep: () => {}, forgetSession: () => {} },
    providers: {
      ENGINES: ['claude', 'codex', 'agy'],
      status: async (e) => ({ engine: e, installed: true, signedIn: signed[e] }),
      fetchModels: async (e, opts) => {
        fetchCalls.push([e, !!opts.force]);
        return e === 'claude' ? claudeLive : e === 'codex' ? codexLive : null;
      },
      openSignIn: async () => ({}), signInCommand: () => 'x',
    },
  });

  // 1) Induláskor (warmup): a bejelentkezett claude élő listáját betölti, a még ki nem jelentkezett codexet nem indítja feleslegesen
  await k.warmup();
  assert.deepStrictEqual(fetchCalls, [['claude', false]]);
  let cat = await k.modelCatalog();
  assert.deepStrictEqual(cat.claude.options.map((o) => o.label), ['Haiku 5.5', 'Sonnet 5.5', 'Opus 5.5', 'Fable 5.2']);

  // 2) Összekötéskor (codex belépés: signedIn false → true): kényszerített (force: true) élő lekérdezés fut
  codexLive = ['gpt-6-luna', 'gpt-6.3-sol', 'gpt-6-astra'];
  signed.codex = true;
  await k.status();
  assert.ok(fetchCalls.some(([e, force]) => e === 'codex' && force === true));
  cat = await k.modelCatalog();
  assert.deepStrictEqual(cat.codex.options.map((o) => o.label), ['GPT-6 Luna', 'GPT-6.3 Sol', 'GPT-6 Astra']);
  assert.strictEqual(cat.codex.default, 'gpt-6.3-sol');

  // 3) Claude újra-összekötéskor az új modell (pl. Fable 5.3) is azonnal megjelenik
  signed.claude = false;
  await k.status();
  claudeLive = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-3'];
  signed.claude = true;
  await k.status();
  cat = await k.modelCatalog();
  assert.strictEqual(cat.claude.options[3].label, 'Fable 5.3');
});

test('index: gyors promptok mentése, szerkesztése, törlése (üres listáig) és ellenőrzése a beállításban', () => {
  const x = makeKapu();
  assert.strictEqual('prompts' in x.k.config(), false, 'testreszabás előtt nincs prompts mező');
  const saved = x.k.setConfig({
    prompts: [
      { id: 'p-week', title: '  Heti határidők  ', prompt: '  Mi jár le a héten?  ' },
      { id: 'u-sajat-1', title: 'ÁFA-ellenőrzés', prompt: 'Nézd meg az esedékes ÁFA-bevallásokat.' },
    ],
  });
  assert.deepStrictEqual(saved.prompts, [
    { id: 'p-week', title: 'Heti határidők', prompt: 'Mi jár le a héten?' },
    { id: 'u-sajat-1', title: 'ÁFA-ellenőrzés', prompt: 'Nézd meg az esedékes ÁFA-bevallásokat.' },
  ]);
  assert.deepStrictEqual(x.k.config().prompts, saved.prompts);

  // Összes gyors prompt törlésekor az üres tömb is megmarad (nem töltődnek vissza kéretlenül az alapok)
  assert.deepStrictEqual(x.k.setConfig({ prompts: [] }).prompts, []);
  assert.deepStrictEqual(x.k.config().prompts, []);

  // null visszaállítja az alapállapotot
  const reset = x.k.setConfig({ prompts: null });
  assert.strictEqual('prompts' in reset, false);
  assert.strictEqual('prompts' in x.k.config(), false);

  // Érvénytelen bemenetek elutasítva
  assert.throws(() => x.k.setConfig({ prompts: 'rossz' }), /Hibás gyors prompt/);
  assert.throws(() => x.k.setConfig({ prompts: [{ id: 'p-1', title: '   ', prompt: 'x' }] }), /érvényes címet és promptot/);
  assert.throws(() => x.k.setConfig({ prompts: [{ id: 'rossz id!', title: 'Cím', prompt: 'Prompt' }] }), /érvényes címet és promptot/);
  assert.throws(() => x.k.setConfig({ prompts: [{ id: 'dup', title: 'A', prompt: 'B' }, { id: 'dup', title: 'C', prompt: 'D' }] }), /érvényes címet és promptot/);
});
