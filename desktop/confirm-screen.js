// A megerősítő réteg viselkedése. Minden adat szövegként kerül ki; az alapértelmezett és az Esc is a „Mégse”.
(async () => {
  const K = window.kapuConfirm, $ = id => document.getElementById(id);
  // Híd nélkül (ha a fájlt böngészőben nyitják meg a megjelenés ellenőrzésére) mintaadat látszik, és a gombok nem csinálnak semmit.
  const sample = { state: 'unread', title: 'Átveszed ezt az iratot?', lead: 'Még olvasatlan a tárhelyen. A letöltéstől megnyitottá válik, és ettől elindulhatnak a határidők. Nem vonható vissza.', stateLabel: 'Olvasatlan a tárhelyen',
    subject: 'Végzés hiánypótlásra (minta küldemény)', mailbox: 'Példa Kereskedelmi Kft', mailboxKey: '12345676', mailboxMark: 'PK', sender: 'Országos Bírósági Hivatal', senderMark: 'OBH',
    received: '2026. 06. 25. 10:12', folder: 'Beérkezett', type: 'OBH_UKE_KIADMANY', size: '87 KB' };
  const info = (K ? await K.info().catch(() => null) : sample) || null;
  if (!info) { if (K) K.answer(false); return; }
  document.body.dataset.state = info.state;
  for (const id of ['title', 'lead', 'subject', 'sender', 'mailbox', 'mailboxKey', 'received', 'type', 'size', 'folder', 'stateLabel', 'senderMark', 'mailboxMark']) {
    const el = $(id); if (!el) continue;
    el.textContent = info[id] || '';
    const row = $(id + '-row'); if (row) row.hidden = !info[id];
  }
  $('sender-row').hidden = !info.sender;
  // A logó csak a főfolyamat által megnevezett helyi fájl lehet; ha nem tölt be, marad a monogram.
  if (typeof info.senderLogo === 'string' && /^assets\/senders\/[a-z0-9]+\.(svg|png)$/.test(info.senderLogo)) {
    const img = new Image(); img.alt = '';
    img.onload = () => { $('senderMark').replaceChildren(img); $('senderMark').classList.add('logo'); };
    img.src = info.senderLogo;
  }
  let sent = false;
  const answer = yes => { if (sent) return; sent = true; $('yes').disabled = $('no').disabled = true; if (yes) $('yes').classList.add('busy'); if (K) K.answer(yes); };
  $('no').addEventListener('click', () => answer(false));
  $('yes').addEventListener('click', () => answer(true));
  $('scrim').addEventListener('mousedown', e => { if (e.target === $('scrim')) answer(false); });
  addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); answer(false); } });
  document.body.classList.add('ready');
  $('no').focus();
})();
