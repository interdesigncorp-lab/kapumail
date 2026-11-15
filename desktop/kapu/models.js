'use strict';
// Kapu-chat: a motorok választható modelljei. Mindhárom motornál tudunk élő listából dolgozni (induláskor és
// összekötéskor frissítve): Claude a helyi/aláírt modellkatalógusból, Codex a `codex debug models` kimenetéből,
// Antigravity az `agy models` soraiból; ha az élő lista nem érhető el, az ismert tartaléklista (KNOWN) marad.
// A lista kisebbtől/gyorsabbtól a nagyobbig/okosabbig halad, magyar rövid jelzéssel.
// Biztonság: a CLI-nek csak olyan modell-azonosító megy, ami az engedélyezett listán van (resolve), és az is
// csak szigorú alakkal (MODEL_RE): tetszőleges szöveg nem kerülhet a parancssorba.

const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,79}$/;
const AGY_EFFORT = 'medium'; // ha a változatnak van ilyen foka; különben a legalacsonyabb

// Tartaléklista, ha a motor élő katalógusa még nem olvasható:
// Claude: a fő (main) modellek (2026-11: Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.2).
// Codex: `codex debug models` ChatGPT-fiókkal elérhető GPT-6 sor.
// Antigravity: tartalék Gemini-változatok.
const KNOWN = {
  claude: [
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: 'gyors' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'kiegyensúlyozott', balanced: true },
    { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'okosabb, lassabb' },
    { id: 'claude-fable-5-2', label: 'Fable 5.2', hint: 'legokosabb, leglassabb' },
  ],
  codex: [
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', hint: 'gyors' },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', hint: 'kiegyensúlyozott', balanced: true },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', hint: 'legokosabb' },
  ],
  agy: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high', 'gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high'],
};

const CLAUDE_FAMILY = {
  haiku: [0, 'gyors', 'Haiku'],
  sonnet: [1, 'kiegyensúlyozott', 'Sonnet'],
  opus: [2, 'okosabb, lassabb', 'Opus'],
  fable: [3, 'legokosabb, leglassabb', 'Fable'],
};
const CLAUDE_BALANCED = 'sonnet';
const CLAUDE_NAME = /^claude-(haiku|sonnet|opus|fable)-(\d+(?:-\d+)*?)(?:-20\d{6})?$/;

const CODEX_FAMILY = {
  luna: [0, 'gyors'],
  sol: [1, 'kiegyensúlyozott'],
  terra: [2, 'okosabb'],
  astra: [3, 'legokosabb'],
};
const CODEX_BALANCED = 'sol';
const CODEX_NAME = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/;

// Az Antigravity Gemini-családjai gyorstól okosig; ismeretlen család a végére, jelzés nélkül.
const AGY_FAMILY = { flash: [0, 'gyors'], argon: [1, 'kiegyensúlyozott'], carbon: [2, 'okosabb'], hydrogen: [3, 'legokosabb'] };
const AGY_BALANCED = 'argon';
const AGY_NAME = /^gemini-(\d+(?:\.\d+)*)-([a-z]+)$/;

/** „gemini-3.8-flash” → „Gemini 3.8 Flash”, „gpt-oss-120b” → „GPT OSS 120B”. */
function modelLabel(id) {
  const words = String(id).replace(/(\d+)-(\d+)(?=$|-)/g, '$1.$2').split('-').filter(Boolean);
  return words.map((w) => (/^(gpt|oss)$/i.test(w) || /^\d+b$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

function orderEfforts(levels) {
  const rank = (l) => { const i = EFFORT_ORDER.indexOf(l); return i < 0 ? EFFORT_ORDER.length : i; };
  return [...new Set(levels)].sort((a, b) => rank(a) - rank(b));
}

/** Az erőfokonkénti azonosítók („…-low”, „…-high”) változatonként egy elemmé. */
function foldEffortVariants(ids, preferred = AGY_EFFORT) {
  const suffix = new RegExp(`^(.+)-(${EFFORT_ORDER.join('|')})$`);
  const groups = new Map();
  for (const id of ids) {
    const m = suffix.exec(id);
    const base = m ? m[1] : id;
    const levels = groups.get(base) || [];
    if (m) levels.push(m[2]);
    groups.set(base, levels);
  }
  return [...groups].map(([id, levels]) => {
    const efforts = orderEfforts(levels);
    return { id, efforts, effort: efforts.length ? (efforts.includes(preferred) ? preferred : efforts[0]) : null };
  });
}

/** `agy models`: soronként `<id>\t<név>` (a „Fetching…” a hibakimenetre megy). */
function parseAgyModels(stdout) {
  return String(stdout || '').split('\n').flatMap((line) => {
    const [id, name] = line.split('\t');
    const t = id && id.trim();
    return name !== undefined && name.trim() && t && MODEL_RE.test(t) ? [t] : [];
  });
}

/** Claude modellkatalógus (helyi `~/.claude/cache/model-catalog/*.json` vagy `downloads.claude.ai/.../catalog.json`): a `main` modellek azonosítói. */
function parseClaudeCatalog(input) {
  let doc = input;
  if (typeof input === 'string') {
    try { doc = JSON.parse(input); } catch { return []; }
  }
  if (!doc || typeof doc !== 'object') return [];
  const localModels = doc.catalog && doc.catalog.config && Array.isArray(doc.catalog.config.models) ? doc.catalog.config.models : null;
  const pubCfg = doc.surfaces && doc.surfaces.cc && Array.isArray(doc.surfaces.cc.model_selector_config) ? doc.surfaces.cc.model_selector_config[0] : null;
  const pubModels = pubCfg && Array.isArray(pubCfg.models) ? pubCfg.models : null;
  const rows = localModels || pubModels;
  if (!rows) return [];
  const hasMain = rows.some((m) => m && m.section === 'main');
  return rows.flatMap((m) => {
    if (!m || typeof m.id !== 'string') return [];
    if (hasMain && m.section !== 'main') return [];
    const id = m.id.trim();
    return MODEL_RE.test(id) && CLAUDE_NAME.test(id) ? [id] : [];
  });
}

/** `codex debug models`: `{ models: [{ slug, visibility, supported_in_api }] }` → látható GPT-modellek. */
function parseCodexModels(input) {
  let doc = input;
  if (typeof input === 'string') {
    try { doc = JSON.parse(input); } catch { return []; }
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.models)) return [];
  return doc.models.flatMap((m) => {
    if (!m || m.visibility !== 'list' || m.supported_in_api === false || typeof m.slug !== 'string') return [];
    const slug = m.slug.trim();
    return MODEL_RE.test(slug) && CODEX_NAME.test(slug) ? [slug] : [];
  });
}

const cmpVersion = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
};

/** Claude választható modelljei: családonként (Haiku → Sonnet → Opus → Fable) a legújabb változat. */
function claudeOptions(live) {
  if (Array.isArray(live) && live.length) {
    const best = new Map();
    for (const raw of live) {
      const id = typeof raw === 'string' ? raw.trim() : '';
      const m = MODEL_RE.test(id) ? CLAUDE_NAME.exec(id) : null;
      if (!m) continue;
      const fam = m[1], ver = m[2].replace(/-/g, '.');
      const prev = best.get(fam);
      if (!prev || cmpVersion(ver, prev.ver) > 0) best.set(fam, { id, fam, ver });
    }
    if (best.size) {
      return [...best.values()]
        .map(({ id, fam, ver }) => {
          const meta = CLAUDE_FAMILY[fam];
          return { id, label: `${meta[2]} ${ver}`, hint: meta[1], argv: id, rank: meta[0], balanced: fam === CLAUDE_BALANCED };
        })
        .sort((a, b) => a.rank - b.rank)
        .map(({ rank, ...rest }) => rest);
    }
  }
  return KNOWN.claude.map((o) => ({ ...o, argv: o.id }));
}

/** Codex (ChatGPT) választható modelljei: a legfrissebb főverzió szintjei gyorstól okosig. */
function codexOptions(live) {
  if (Array.isArray(live) && live.length) {
    const parsed = [];
    let maxMajor = -1;
    for (const raw of live) {
      const id = typeof raw === 'string' ? raw.trim() : '';
      const m = MODEL_RE.test(id) ? CODEX_NAME.exec(id) : null;
      if (!m) continue;
      const ver = m[1], tier = m[2], major = Number(ver.split('.')[0]) || 0;
      if (major > maxMajor) maxMajor = major;
      parsed.push({ id, ver, tier, major });
    }
    const best = new Map();
    for (const item of parsed) {
      if (item.major !== maxMajor) continue;
      const prev = best.get(item.tier);
      if (!prev || cmpVersion(item.ver, prev.ver) > 0) best.set(item.tier, item);
    }
    if (best.size) {
      return [...best.values()]
        .map(({ id, ver, tier }) => {
          const fam = CODEX_FAMILY[tier];
          const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
          return {
            id, label: `GPT-${ver} ${tierLabel}`, hint: fam ? fam[1] : '', argv: id,
            rank: fam ? fam[0] : 9, ver, balanced: tier === CODEX_BALANCED,
          };
        })
        .sort((a, b) => a.rank - b.rank || cmpVersion(b.ver, a.ver))
        .map(({ rank, ver, ...rest }) => rest);
    }
  }
  return KNOWN.codex.map((o) => ({ ...o, argv: o.id }));
}

/** Az Antigravity választható modelljei: csak a Gemini-változatok, gyorstól okosig, azon belül az újabb elöl. */
function agyOptions(live) {
  const ids = Array.isArray(live) && live.length ? live : KNOWN.agy;
  return foldEffortVariants(ids)
    .map((o) => ({ o, m: AGY_NAME.exec(o.id) }))
    .filter(({ m }) => m)
    .map(({ o, m }) => {
      const fam = AGY_FAMILY[m[2]];
      return {
        id: o.id, label: modelLabel(o.id), hint: fam ? fam[1] : '', argv: o.effort ? `${o.id}-${o.effort}` : o.id,
        rank: fam ? fam[0] : 9, version: m[1], balanced: m[2] === AGY_BALANCED,
      };
    })
    .sort((a, b) => a.rank - b.rank || cmpVersion(b.version, a.version))
    .map(({ rank, version, ...rest }) => rest);
}

/**
 * options(engine, live?) → [{id, label, hint, argv, balanced?}] – a menü elemei sorrendben. `argv`: ami a CLI-nek
 * megy (az Antigravitynél az erőfok a név része). `live`: a motorhoz beolvasott élő modell-azonosítók.
 */
function options(engine, live) {
  if (engine === 'agy') return agyOptions(live);
  if (engine === 'claude') return claudeOptions(live);
  if (engine === 'codex') return codexOptions(live);
  return [];
}

/** A motor alapmodellje: a kiegyensúlyozott, ha van; különben az első. */
function defaultModel(engine, live) {
  const opts = options(engine, live);
  const b = opts.find((o) => o.balanced) || opts[0];
  return b ? b.id : null;
}

/** Az engedélyezett listán lévő modell (vagy null): így nem kerülhet ismeretlen azonosító a parancssorba. */
function resolve(engine, id, live) {
  if (typeof id !== 'string' || !MODEL_RE.test(id)) return null;
  const o = options(engine, live).find((x) => x.id === id);
  return o && MODEL_RE.test(o.argv) ? o : null;
}

/** A felületnek: {id, label, hint} elemek és az alapmodell, motoronként. `live`: motoronkénti térkép (vagy régi alakban az agy tömbje). */
function catalog(engines, live) {
  const byEngine = Array.isArray(live) ? { agy: live } : (live && typeof live === 'object' ? live : {});
  const out = {};
  for (const e of engines) {
    out[e] = {
      options: options(e, byEngine[e]).map(({ id, label, hint }) => ({ id, label, hint })),
      default: defaultModel(e, byEngine[e]),
    };
  }
  return out;
}

module.exports = {
  KNOWN, MODEL_RE, EFFORT_ORDER, modelLabel, orderEfforts, foldEffortVariants,
  parseAgyModels, parseClaudeCatalog, parseCodexModels,
  options, defaultModel, resolve, catalog,
};
