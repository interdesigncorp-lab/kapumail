// Ütemezett szinkron időpontjai és beállítása. Tiszta függvények: se óra, se állapot – a hívó adja az időt és az utolsó futást.
'use strict';

/** Két ütemezett futás között legalább ennyi percnek kell eltelnie – semmilyen beállítás nem viheti ez alá. */
const MIN_GAP_MIN = 180;
/** Ennyi késést enged a távolságszabály: a pontosan induló, de egy-két percet késő futás után a 3 órával későbbi időpont ne essen ki. */
const GRACE_MIN = 15;
/** Az alapértelmezés: munkanapokon 8, 12 és 16 órakor, minden belépőre. `weekdays`: Date.getDay() szerint (0 = vasárnap). */
const DEFAULTS = Object.freeze({ mode: 'fixed', times: Object.freeze(['08:00', '12:00', '16:00']), everyHours: 3, from: '07:00', to: '19:00', days: 'workdays', weekdays: Object.freeze([1, 2, 3, 4, 5]), excluded: Object.freeze([]) });

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Húsvétvasárnap (Gergely-naptár, névtelen algoritmus). */
function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

/** A magyar munkaszüneti napok egy évben: a rögzített napok, nagypéntek, húsvéthétfő és pünkösdhétfő. */
function holidaysOf(year) {
  const e = easter(year); const plus = n => ymd(new Date(year, e.getMonth(), e.getDate() + n));
  const fixed = ['01-01', '03-15', '05-01', '08-20', '10-23', '11-01', '12-25', '12-26'].map(x => `${year}-${x}`);
  return [...fixed, plus(-2), plus(1), plus(50)].sort();
}

const dateList = a => (Array.isArray(a) ? a.filter(x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) : []);

/**
 * Munkanap-e. Hétvége és munkaszüneti nap nem az. Az áthelyezett munkanapokat (jellemzően szombat) és a hozzájuk
 * tartozó pihenőnapokat évente rendelet írja elő, ezért azok a beállításból jönnek: `cal.extraWorkdays`, `cal.extraRestdays`.
 */
function isWorkday(date, cal = {}) {
  const key = ymd(date);
  if (dateList(cal.extraWorkdays).includes(key)) return true;
  if (dateList(cal.extraRestdays).includes(key)) return false;
  const day = date.getDay();
  return day !== 0 && day !== 6 && !holidaysOf(date.getFullYear()).includes(key);
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = t => { const m = TIME_RE.exec(typeof t === 'string' ? t : ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const toTime = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const uniq = a => [...new Set(a)];
const fresh = () => ({ ...DEFAULTS, times: [...DEFAULTS.times], weekdays: [...DEFAULTS.weekdays], excluded: [] });

/**
 * Szigorú ellenőrzés mentéshez. A hibaüzenet a felhasználónak szól.
 * @returns {{ ok: true, cfg: object } | { ok: false, error: string }}
 */
function validate(input) {
  const bad = error => ({ ok: false, error });
  if (!input || typeof input !== 'object') return bad('Hiányzó beállítás.');
  const mode = input.mode === 'interval' ? 'interval' : input.mode === 'fixed' ? 'fixed' : null;
  if (!mode) return bad('Válaszd ki, hogy fix időpontokban vagy rendszeresen fusson.');
  if (!Array.isArray(input.times) || !input.times.length) return bad('Legalább egy időpontot adj meg.');
  if (input.times.some(t => toMin(t) == null)) return bad('Az időpont alakja óra:perc, például 08:30.');
  const mins = uniq(input.times.map(toMin)).sort((x, y) => x - y);
  // Két szomszédos időpont távolsága, az utolsó és a másnapi első között is.
  const tooClose = list => {
    for (let i = 0; i < list.length && list.length > 1; i++) {
      const wrap = i + 1 === list.length, a = list[i], b = list[wrap ? 0 : i + 1], gap = wrap ? b + 1440 - a : b - a;
      if (gap < MIN_GAP_MIN) return `Két időpont között legalább 3 óra kell (${toTime(a)} és ${wrap ? 'másnap ' : ''}${toTime(b)} között csak ${String(Math.round(gap / 6) / 10).replace('.', ',')} óra van).`;
    }
    return null;
  };
  const closeFixed = tooClose(mins);
  if (closeFixed) return bad(closeFixed);
  if (!Number.isInteger(input.everyHours) || input.everyHours < MIN_GAP_MIN / 60 || input.everyHours > 24) return bad('A gyakoriság 3 és 24 óra közötti egész szám lehet.');
  const from = toMin(input.from), to = toMin(input.to);
  if (from == null || to == null) return bad('Az időpont alakja óra:perc, például 08:30.');
  if (from >= to) return bad('Az időablak kezdete legyen korábban, mint a vége.');
  const every = []; for (let m = from; m <= to; m += input.everyHours * 60) every.push(m);
  const closeEvery = tooClose(every); // az ablak utolsó időpontja és a másnapi első között is kell a 3 óra
  if (closeEvery) return bad(closeEvery + ' Szűkítsd az időablakot, vagy válassz más gyakoriságot.');
  const days = ['workdays', 'all', 'custom'].includes(input.days) ? input.days : null;
  if (!days) return bad('Válaszd ki, mely napokon fusson.');
  const weekdays = uniq((Array.isArray(input.weekdays) ? input.weekdays : []).filter(d => Number.isInteger(d) && d >= 0 && d <= 6)).sort();
  if (!weekdays.length) return bad('Válassz legalább egy napot.');
  const excluded = uniq((Array.isArray(input.excluded) ? input.excluded : []).filter(k => typeof k === 'string' && k && k.length <= 200)).slice(0, 200);
  return { ok: true, cfg: { mode, times: mins.map(toTime), everyHours: input.everyHours, from: toTime(from), to: toTime(to), days, weekdays, excluded } };
}

/**
 * Elnéző olvasás a beállítófájlból: ami hiányzik vagy hibás, annak a helyén az alapérték áll. Így a régi vagy sérült
 * beállítás nem állítja le az ütemezést, és nem viheti a 3 órás határ alá sem.
 */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}, d = fresh();
  const pick = patch => { const v = validate({ ...d, ...patch }); return v.ok ? v.cfg : null; };
  const out = fresh();
  for (const keys of [['mode'], ['times'], ['everyHours'], ['from', 'to'], ['days'], ['weekdays'], ['excluded']]) {
    if (keys.some(k => r[k] === undefined)) continue;
    const got = pick(Object.fromEntries(keys.map(k => [k, r[k]])));
    if (got) for (const k of keys) out[k] = got[k];
  }
  return validate(out).ok ? out : fresh(); // külön-külön jó, de együtt érvénytelen mezők (például gyakoriság és időablak): alapérték
}

/** A nap időpontjai percben, növekvő sorrendben. „X óránként” módban: az ablak kezdete, majd X óránként, amíg belefér. */
function slotsOf(cfg) {
  const c = normalize(cfg);
  if (c.mode !== 'interval') return c.times.map(toMin);
  const out = [];
  for (let m = toMin(c.from); m <= toMin(c.to); m += c.everyHours * 60) out.push(m);
  return out;
}

/** Fut-e ezen a napon: munkanapokon (a naptár szerint), minden nap, vagy pontosan a kiválasztott hétköznapokon (ünnepnapon is). */
function runsOn(date, cfg = {}) {
  const c = normalize(cfg);
  if (c.days === 'all') return true;
  if (c.days === 'custom') return c.weekdays.includes(date.getDay());
  return isWorkday(date, cfg);
}

const atMin = (day, min) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(min / 60), min % 60, 0, 0);
/** Az időpont elég messze van-e az utolsó ütemezett futástól (3 óra, a türelmi idővel). */
const farEnough = (slot, lastRunMs) => lastRunMs == null || slot.getTime() >= lastRunMs + (MIN_GAP_MIN - GRACE_MIN) * 60000;
/** Az utolsó futás ideje számként; hiányzó vagy sérült érték (nem szám) úgy számít, mintha még nem lett volna futás. */
const lastOf = v => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * A legutóbbi, már elmúlt mai időpont, ha azóta még nem volt futás; különben null.
 * Kimaradt futásból így csak a legutóbbi pótlódik; nem futó napon semmi nem fut. Az utolsó futáshoz 3 óránál közelebbi
 * időpont kimarad (nem halasztódik), a beállítás mentése (`cfg.changedAt`) előtti időpont pedig nem számít.
 * @param {Date} now
 * @param {number|null} lastRunMs az utolsó ütemezett futás ideje (epoch ms) vagy null
 * @param {object} cfg a teljes ütemezés-beállítás (mód, időpontok, napok, changedAt, áthelyezett munkanapok és pihenőnapok)
 * @returns {Date|null}
 */
function dueSlot(now, lastRunMs, cfg = {}) {
  if (!(now instanceof Date) || isNaN(now)) return null;
  cfg = cfg && typeof cfg === 'object' ? cfg : {};
  lastRunMs = lastOf(lastRunMs);
  if (!runsOn(now, cfg)) return null;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const passed = slotsOf(cfg).filter(m => nowMin >= m);
  if (!passed.length) return null;
  const slot = atMin(now, passed[passed.length - 1]);
  if (Number(cfg.changedAt) >= slot.getTime()) return null;
  if (lastRunMs != null && lastRunMs >= slot.getTime()) return null;
  return farEnough(slot, lastRunMs) ? slot : null;
}

/** A következő (jövőbeli) ütemezett időpont, legfeljebb két hétre előre; ha nincs ilyen, null. */
function nextSlot(now, lastRunMs, cfg = {}) {
  if (!(now instanceof Date) || isNaN(now)) return null;
  cfg = cfg && typeof cfg === 'object' ? cfg : {};
  lastRunMs = lastOf(lastRunMs);
  const slots = slotsOf(cfg);
  for (let i = 0; i <= 14; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    if (!runsOn(day, cfg)) continue;
    for (const m of slots) { const s = atMin(day, m); if (s > now && farEnough(s, lastRunMs)) return s; }
  }
  return null;
}

module.exports = { dueSlot, nextSlot, slotsOf, runsOn, normalize, validate, isWorkday, holidaysOf, DEFAULTS, MIN_GAP_MIN, GRACE_MIN };
