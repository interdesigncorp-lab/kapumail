// Az önkormányzati portál osztott ablakának bal oldali vezérlősávja.
// Kizárólag textContent és createElement építi a felületet (nincs nyers HTML-beillesztés).
'use strict';

(() => {
  const P = window.aspPanel;
  const $ = id => document.getElementById(id);
  let state = null;
  let query = '';

  function checkSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '3');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
    svg.appendChild(path);
    return svg;
  }

  function makeBtn(label, cls, onClick, disabled = false) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.disabled = !!disabled;
    b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
    return b;
  }

  function render() {
    if (!state) return;
    const items = Array.isArray(state.items) ? state.items : [];
    const doneCount = items.filter(x => x.state === 'done').length;
    const total = items.length;
    const pill = $('progPill');
    pill.textContent = `${doneCount} / ${total} ✓`;
    pill.classList.toggle('all-done', total > 0 && doneCount === total);
    $('progBar').style.width = total > 0 ? `${Math.round((doneCount / total) * 100)}%` : '0%';

    const dot = $('sDot');
    const title = $('sTitle');
    const sub = $('sSub');
    const acts = $('sActs');
    acts.replaceChildren();

    if (state.phase === 'login') {
      dot.className = state.autoLogin ? 'dot spin' : 'dot';
      title.textContent = state.autoLogin ? 'Automatikus Ügyfélkapu+ belépés…' : 'Lépj be a jobb oldalon';
      sub.textContent = state.loginNote || (state.autoLogin
        ? 'Felhasználónév, jelszó és 6 jegyű kód kitöltése a KAÜ-oldalon.'
        : 'Ügyfélkapu+ vagy DÁP azonosítással. Belépés után a lista élővé válik.');
      if (state.autoLogin) {
        acts.appendChild(makeBtn('Kézi / DÁP belépés', 'btn', () => P.manualLogin()));
      }
    } else {
      const reading = state.phase === 'reading';
      dot.className = reading ? 'dot spin' : 'dot live';
      const ar = state.activeRole;
      if (reading) {
        title.textContent = 'Önkormányzatok beolvasása…';
        sub.textContent = ar ? `${ar.clientName || ar.label}${ar.id && !ar.own ? ` (${ar.id})` : ''} · kérlek, várj néhány másodpercet` : 'Kivonatok, bevallások és ügyek lekérdezése…';
      } else if (ar) {
        title.textContent = ar.own ? 'Aktív: Saját néven (magánszemély)' : `Aktív: ${ar.clientName || ar.label}`;
        sub.textContent = ar.own
          ? 'A saját adószámla-kivonat magánadat, csak te látod.'
          : `${ar.label}${ar.id ? ` · adószám: ${ar.id}` : ''}`;
      } else {
        title.textContent = 'Belépve a portálra';
        sub.textContent = 'Válassz ügyfelet a lenti listából, vagy válts szerepkört jobbra.';
      }
      acts.appendChild(makeBtn('Szerepkörváltás →', 'btn pri', () => P.openSwitch(), reading));
      acts.appendChild(makeBtn('Aktuális szerepkör olvasása', 'btn', () => P.readNow(), reading));
    }

    const warn = $('warnBox');
    if (state.warning) {
      warn.hidden = false;
      warn.textContent = state.warning;
    } else {
      warn.hidden = true;
      warn.textContent = '';
    }

    const search = $('search');
    search.hidden = items.length < 4;

    const q = query.trim().toLowerCase();
    const qDigits = q.replace(/\D+/g, '');
    const filtered = !q ? items : items.filter(it =>
      String(it.name || '').toLowerCase().includes(q) ||
      String(it.tax || '').toLowerCase().includes(q) ||
      (qDigits && String(it.tax11 || it.stem || '').includes(qDigits))
    );

    const list = $('list');
    list.replaceChildren();
    if (!filtered.length) {
      const emp = document.createElement('div');
      emp.className = 'empty';
      emp.textContent = 'Nincs a keresésnek megfelelő ügyfél.';
      list.appendChild(emp);
      return;
    }

    for (const it of filtered) {
      const row = document.createElement('div');
      row.setAttribute('role', 'listitem');
      row.className = 'item'
        + (it.state === 'done' ? ' done' + (it.fresh ? '' : ' earlier') : '')
        + (it.state === 'reading' ? ' reading' : '')
        + (it.state === 'error' ? ' error' : '')
        + (state.selectedKey === it.key ? ' sel' : '');

      const chk = document.createElement('div');
      chk.className = 'chk';
      if (it.state === 'done') chk.appendChild(checkSvg());
      else if (it.state === 'error') chk.textContent = '!';
      row.appendChild(chk);

      const body = document.createElement('div');
      body.className = 'ibody';

      const nameRow = document.createElement('div');
      nameRow.className = 'iname';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = it.name;
      nameRow.appendChild(nm);
      if (it.own) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'Saját';
        nameRow.appendChild(tag);
      }
      body.appendChild(nameRow);

      if (!it.own && (it.tax || it.stem)) {
        const meta = document.createElement('div');
        meta.className = 'imeta';
        const primary = it.tax11 || it.stem || it.tax;
        const pLabel = it.tax || primary;
        const mainCopy = document.createElement('button');
        mainCopy.type = 'button';
        const isMainCopied = state.copiedKey === it.key && state.copiedWhat === 'main';
        mainCopy.className = 'copy-pill' + (isMainCopied ? ' copied' : '');
        mainCopy.textContent = isMainCopied ? `✓ Másolva: ${primary}` : `📋 ${pLabel}`;
        mainCopy.title = 'Kattints az adószám vágólapra másolásához és a szerepkörváltás megnyitásához';
        mainCopy.addEventListener('click', e => {
          e.stopPropagation();
          P.select(it.key, primary, 'main');
        });
        meta.appendChild(mainCopy);

        if (it.tax11 && it.stem && it.tax11 !== it.stem) {
          const stemCopy = document.createElement('button');
          stemCopy.type = 'button';
          const isStemCopied = state.copiedKey === it.key && state.copiedWhat === 'stem';
          stemCopy.className = 'copy-pill' + (isStemCopied ? ' copied' : '');
          stemCopy.textContent = isStemCopied ? `✓ ${it.stem}` : `8 jegy: ${it.stem}`;
          stemCopy.title = 'Csak a 8 jegyű törzsszám másolása';
          stemCopy.addEventListener('click', e => {
            e.stopPropagation();
            P.select(it.key, it.stem, 'stem');
          });
          meta.appendChild(stemCopy);
        }
        body.appendChild(meta);
      }

      const note = document.createElement('div');
      note.className = 'inote';
      if (it.state === 'reading') {
        note.textContent = 'Önkormányzatok lekérdezése folyamatban…';
      } else if (it.state === 'done') {
        note.textContent = `✓ ${it.summary || (it.fresh ? 'Leszinkronizálva' : 'Ma már lekérdezve')}`;
      } else if (it.state === 'error') {
        note.textContent = it.error || 'A beolvasás nem sikerült.';
      } else if (state.selectedKey === it.key && !it.own) {
        note.textContent = 'Adószám a vágólapon (⌘V / Ctrl+V) – válts szerepkört jobbra!';
      } else if (it.own) {
        note.textContent = 'Saját magánszemélyes helyi adószámla és bevallások';
      } else {
        note.textContent = 'Kattints a másoláshoz és a szerepkörváltáshoz';
      }
      body.appendChild(note);

      row.appendChild(body);
      row.addEventListener('click', () => {
        const primary = it.own ? '' : (it.tax11 || it.stem || it.tax || '');
        P.select(it.key, primary, 'main');
      });
      list.appendChild(row);
    }
  }

  $('search').addEventListener('input', e => { query = e.target.value || ''; render(); });
  $('closeBtn').addEventListener('click', () => P.close());
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && document.activeElement !== $('search')) P.close(); });

  P.onState(next => { state = next; render(); });
  P.state().then(s => { if (s) { state = s; render(); } });
})();
