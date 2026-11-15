// A zárképernyő viselkedése. Titkot nem tárol; a PIN-t egyszer küldi a főfolyamatnak, és azonnal törli a mezőből.
(async () => {
  const L = window.kapuLock, $ = id => document.getElementById(id);
  const card = $('card'), form = $('f'), pin = $('pin'), go = $('go'), touch = $('touch'), touchActs = $('touchacts'), msg = $('msg'), lead = $('lead');
  let timer = null, busy = false, hasTouch = false;
  // Két nézet: Touch ID (ujjlenyomat-ikon, két gomb) és PIN (lakat-ikon, beviteli mező).
  const view = v => {
    const t = v === 'touch'; touchActs.hidden = !t; form.hidden = t; $('rf').hidden = true; $('forgot').hidden = false; $('ic-touch').toggleAttribute('hidden', !t); $('ic-pin').toggleAttribute('hidden', t);
    $('back').hidden = !hasTouch; msg.textContent = '';
    lead.textContent = t ? 'Nyomj Entert vagy szóközt a Touch ID-hoz, vagy használd a PIN-kódodat.' : 'A folytatáshoz add meg a PIN-kódodat.';
    if (!t) pin.focus(); else touch.focus();
  };
  const shake = () => { card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); };
  const wait = ms => {
    clearInterval(timer); const end = Date.now() + ms;
    const tick = () => { const left = Math.ceil((end - Date.now()) / 1000); const on = left > 0;
      pin.disabled = go.disabled = on; if (on) msg.textContent = `Túl sok hibás próbálkozás. Újra próbálhatod ${left} mp múlva.`; else { clearInterval(timer); msg.textContent = ''; if (!form.hidden) pin.focus(); } };
    tick(); if (ms > 0) timer = setInterval(tick, 500);
  };
  const tryTouch = async () => {
    if (busy) return; busy = true; touch.disabled = true;
    await L.touch().catch(() => ({ ok: false }));
    busy = false; touch.disabled = false;
  };
  form.addEventListener('submit', async e => {
    e.preventDefault(); const v = pin.value; pin.value = ''; if (!v) return;
    const r = await L.pin(v).catch(() => ({ ok: false })); if (r.ok) return;
    shake(); if (r.waitMs) wait(r.waitMs); else { msg.textContent = 'Hibás PIN-kód.'; pin.focus(); }
  });
  touch.addEventListener('click', tryTouch);
  $('usepin').addEventListener('click', () => view('pin'));
  // Elfelejtett PIN: a beállításkor kapott helyreállító kóddal új PIN adható meg.
  let hasRecovery = false;
  $('forgot').addEventListener('click', () => {
    if (!hasRecovery) { msg.textContent = hasTouch ? 'Ehhez a zárhoz nincs helyreállító kód. Oldd fel Touch ID-val, és a Beállításokban adj meg új PIN-t.' : 'Ehhez a zárhoz nincs helyreállító kód.'; return; }
    touchActs.hidden = form.hidden = true; $('rf').hidden = false; $('forgot').hidden = true; msg.textContent = '';
    lead.textContent = 'Írd be a helyreállító kódot, amelyet a zár bekapcsolásakor kaptál, és adj meg új PIN-kódot.'; $('rc').focus();
  });
  $('rback').addEventListener('click', () => view(hasTouch ? 'touch' : 'pin'));
  $('rf').addEventListener('submit', async e => {
    e.preventDefault(); const a = $('np').value, b = $('np2').value;
    if (a.length < 4) { msg.textContent = 'Az új PIN legalább 4 karakter legyen.'; return; }
    if (a !== b) { msg.textContent = 'A két PIN-kód nem egyezik.'; return; }
    const r = await L.recover($('rc').value, a).catch(() => ({ ok: false })); $('np').value = $('np2').value = '';
    if (r.ok) return;
    shake(); msg.textContent = r.waitMs ? `Túl sok hibás próbálkozás. Várj ${Math.ceil(r.waitMs / 1000)} mp-et.` : (r.error || 'Nem sikerült.');
  });
  $('back').addEventListener('click', () => view('touch'));
  const s = await L.state(); hasTouch = !!s.touch; hasRecovery = !!s.recovery;
  view(hasTouch ? 'touch' : 'pin');
  if (s.waitMs) wait(s.waitMs);
  // A rendszer Touch ID-ablaka nem ugrik fel magától: csak a gombra, illetve Enterre vagy szóközre jön elő (tulajdonosi kérés).
  // A gomb fókuszban van, így a két billentyű magától is megnyomja; az alábbi figyelő arra az esetre kell, ha a fókusz máshol áll.
  document.addEventListener('keydown', e => {
    if (touchActs.hidden || (e.key !== 'Enter' && e.key !== ' ') || e.target.closest('button, input')) return;
    e.preventDefault(); tryTouch();
  });
  window.addEventListener('focus', () => { if (!touchActs.hidden) touch.focus(); });
})();
