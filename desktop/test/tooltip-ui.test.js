// A [data-tip] súgóbuborék (#tip felső rétegű popover) pozicionálásának és életciklusának tesztje
// közvetlenül az app.html `placeTipRect` + `showTip` forrásából.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'resources', 'ui', 'app.html'), 'utf8');
const start = html.indexOf('let tipEl=null;');
const end = html.indexOf("document.addEventListener('pointerover'");
assert.ok(start > 0 && end > start, 'placeTipRect és showTip megtalálható az app.html-ben');
const snippet = html.slice(start, end);

function makeTipHarness({ vw = 1280, vh = 800, tipW = 142, tipH = 26 } = {}) {
  let popOpen = false;
  const tip = {
    hidden: true,
    textContent: '',
    style: { left: '', top: '' },
    get offsetWidth() { return tipW; },
    get offsetHeight() { return tipH; },
    matches: sel => sel === ':popover-open' && popOpen,
    showPopover() { popOpen = true; },
    hidePopover() { popOpen = false; },
  };
  const $ = sel => (sel === '#tip' ? tip : null);
  const api = new Function('$', 'innerWidth', 'innerHeight', `${snippet}\nreturn { placeTipRect, showTip, getTipEl: () => tipEl };`)(
    $, vw, vh
  );
  return { tip, isPopoverOpen: () => popOpen, ...api };
}

test('az app.html #tip popover elemet használ a levágódó ::after álelem helyett', () => {
  assert.match(html, /<div id="tip" popover="manual" role="tooltip" hidden><\/div>/);
  assert.match(html, /#tip\{[^}]*position:fixed[^}]*pointer-events:none/);
  assert.match(html, /#tip\[hidden\]\{display:none\}/);
  assert.equal(html.includes('[data-tip]:hover::after'), false);
});

test('a lista jobb szélén lévő ÜK jelvény buboréka nem vágódik le a .rows határán, hanem a felső rétegben nyílik meg', () => {
  const h = makeTipHarness({ vw: 1280, vh: 800, tipW: 142, tipH: 26 });
  const boxEl = {
    isConnected: true,
    getAttribute: k => (k === 'data-tip' ? 'Tárhely: Ügyfélkapu' : null),
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ left: 378, right: 404, top: 310, bottom: 328 }),
    classList: { contains: () => false },
  };
  h.showTip(boxEl);
  assert.equal(h.tip.hidden, false);
  assert.equal(h.isPopoverOpen(), true);
  assert.equal(h.tip.textContent, 'Tárhely: Ügyfélkapu');
  // A 404px-es listaoszlop szélén túl is szabadon megjelenik (378 + 142 = 520 < 1280 - 8).
  assert.equal(h.tip.style.left, '378px');
  assert.equal(h.tip.style.top, '334px');

  // Elhagyáskor vagy leválasztott elemnél eltűnik és kilép a popover rétegből.
  h.showTip(null);
  assert.equal(h.tip.hidden, true);
  assert.equal(h.isPopoverOpen(), false);
  assert.equal(h.getTipEl(), null);
});

test('ablakszéleknél (jobb, bal, alsó) a buborék a látható területen belül marad', () => {
  const { placeTipRect } = makeTipHarness();
  // Keskeny ablak jobb széle: visszahúzza 8px-re a jobb széltől.
  assert.deepEqual(
    placeTipRect({ left: 380, right: 406, top: 200, bottom: 218 }, 142, 26, 460, 800, false),
    { x: 310, y: 224 }
  );
  // Jobbra igazított (.tipr) elem a bal szél közelében: nem lóg ki balra sem.
  assert.deepEqual(
    placeTipRect({ left: 70, right: 92, top: 100, bottom: 122 }, 240, 26, 1280, 800, true),
    { x: 8, y: 128 }
  );
  // Alsó sor: ha alul nem fér ki, az elem fölé fordul.
  assert.deepEqual(
    placeTipRect({ left: 200, right: 230, top: 770, bottom: 788 }, 142, 26, 1280, 800, false),
    { x: 200, y: 738 }
  );
});
