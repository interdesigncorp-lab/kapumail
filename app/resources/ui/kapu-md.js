/* KapuMd: a Kapu-chat biztonságos Markdown-megjelenítője. Nyers HTML és kép soha nem kerül ki;
   a kapu: linkek az app saját kattintáskezelőinek megfelelő gombok (data-goto / data-cl / data-stab). */
(function (root) {
  'use strict';

  var ID = /^[A-Za-z0-9_-]{1,64}$/;
  var TAB = /^[a-z]{1,32}$/;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* A link célja alapján: gomb (kapu:), külső hivatkozás (https:, mailto:) vagy null (sima szöveg). */
  function linkHtml(label, href) {
    var text = formatPlain(label);
    var m = /^kapu:([a-z]+)\/(.*)$/i.exec(href);
    if (/^kapu:/i.test(href)) {
      var kind = m ? m[1].toLowerCase() : '', id = m ? m[2] : '';
      if ((kind === 'irat' || kind === 'hatarido') && ID.test(id)) return '<button class="kchip" data-goto="' + esc(id) + '">' + text + '</button>';
      if (kind === 'ugyfel' && ID.test(id)) return '<button class="kchip" data-cl="' + esc(id) + '">' + text + '</button>';
      if (kind === 'beallitas' && TAB.test(id)) return '<button class="kchip" data-stab="' + esc(id) + '">' + text + '</button>';
      return '<span class="kchip off">' + text + '</span>';
    }
    if (/^(https:\/\/|mailto:)/i.test(href)) return '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + text + '</a>';
    return text;
  }

  /* Félkövér, dőlt és áthúzás az (még nem escape-elt) szövegen; az eredmény biztonságos HTML. */
  function formatPlain(s) {
    var h = esc(s);
    h = h.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
    h = h.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
    return h;
  }

  function inline(src) {
    var parts = [];
    var hold = function (html) { parts.push(html); return '\u0000' + (parts.length - 1) + '\u0000'; };
    var s = String(src).replace(/\u0000/g, '');
    s = s.replace(/`([^`\n]+)`/g, function (_, c) { return hold('<code>' + esc(c) + '</code>'); });
    // Kép: csak a szöveg marad (a kép soha nem jelenik meg).
    s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]*)\)/g, function (_, alt) { return hold(esc(alt)); });
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (_, label, href) { return hold(linkHtml(label, href)); });
    var out = formatPlain(s);
    // Egy hivatkozás szövege is tartalmazhat helyőrzőt (kód a linkben): addig cserélünk, amíg marad.
    var guard = 0;
    while (/\u0000\d+\u0000/.test(out) && guard++ < 5) out = out.replace(/\u0000(\d+)\u0000/g, function (_, i) { return parts[+i]; });
    return out;
  }

  /* GFM-táblázat sorának felbontása: figyelembe veszi a `kód` szakaszokat és a \| escape-elést. */
  function splitTableRow(line) {
    var s = String(line || '').trim();
    if (!s || s.indexOf('|') < 0) return null;
    var outer = s.charAt(0) === '|';
    if (outer) s = s.slice(1);
    if (s.length && s.charAt(s.length - 1) === '|') {
      var bs = 0;
      for (var k = s.length - 2; k >= 0 && s.charAt(k) === '\\'; k--) bs++;
      if (bs % 2 === 0) s = s.slice(0, -1);
    }
    var cells = [], cur = '', inCode = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '\\' && i + 1 < s.length && s.charAt(i + 1) === '|' && !inCode) {
        cur += '|';
        i++;
      } else if (ch === '`') {
        inCode = !inCode;
        cur += ch;
      } else if (ch === '|' && !inCode) {
        cells.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    if (!outer && cells.length < 2) return null;
    return cells;
  }

  function parseTableSep(line, expectedCols) {
    var cells = splitTableRow(line);
    if (!cells || cells.length !== expectedCols || !expectedCols) return null;
    var aligns = [];
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (!/^:?-{2,}:?$/.test(c)) return null;
      var l = c.charAt(0) === ':', r = c.charAt(c.length - 1) === ':';
      aligns.push(l && r ? 'center' : r ? 'right' : l ? 'left' : null);
    }
    return aligns;
  }

  var NUM_PLACEHOLDER = /^(?:[-–—]|n\/a)$/i;
  var DATE_LIKE = /^\d{4}[-./]\s*\d{1,2}(?:[-./]\s*\d{1,2}\.?)?$/;
  var NUM_VAL = /^[+-]?\d[\d\s\u00a0\u202f]*(?:[.,]\d+)?(?:\s*(?:%|Ft|HUF|EUR|USD|GBP|CHF|eFt|MFt|db|fő|nap|óra))?$/i;
  function isNumericRaw(raw) {
    var s = String(raw || '').replace(/^\*\*|\*\*$|^`|`$|^\*|\*$/g, '').trim();
    if (!s || DATE_LIKE.test(s) || /\d\s*[-–]\s*\d/.test(s)) return false;
    return NUM_VAL.test(s);
  }

  function renderTable(head, aligns, rows) {
    var cols = head.length;
    var cls = aligns.map(function (al, c) {
      if (al === 'right') return 'al-r';
      if (al === 'center') return 'al-c';
      if (al === 'left') return 'al-l';
      var seen = 0;
      for (var r = 0; r < rows.length; r++) {
        var v = String(rows[r][c] || '').trim();
        if (!v || NUM_PLACEHOLDER.test(v)) continue;
        if (!isNumericRaw(v)) return '';
        seen++;
      }
      return seen > 0 ? 'num' : '';
    });
    var attr = function (c) { return cls[c] ? ' class="' + cls[c] + '"' : ''; };
    var thead = '<thead><tr>' + head.map(function (h, c) { return '<th' + attr(c) + '>' + inline(h) + '</th>'; }).join('') + '</tr></thead>';
    var tbody = rows.length ? '<tbody>' + rows.map(function (row) {
      var cells = [];
      for (var c = 0; c < cols; c++) cells.push('<td' + attr(c) + '>' + inline(row[c] || '') + '</td>');
      return '<tr>' + cells.join('') + '</tr>';
    }).join('') + '</tbody>' : '<tbody></tbody>';
    return '<div class="ktbl-w"><div class="ktbl-sc"><table class="ktbl">' + thead + tbody + '</table></div></div>';
  }

  function render(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var html = '', para = [], list = null, quote = [];
    var flushPara = function () {
      if (para.length) html += '<p>' + para.map(inline).join('<br>') + '</p>';
      para = [];
    };
    var flushList = function () {
      if (list) html += '<' + list.tag + '>' + list.items.map(function (it) { return '<li>' + inline(it) + '</li>'; }).join('') + '</' + list.tag + '>';
      list = null;
    };
    var flushQuote = function () {
      if (!quote.length) return;
      var qParas = [], cur = [];
      quote.forEach(function (ql) {
        if (!ql.trim()) { if (cur.length) { qParas.push(cur); cur = []; } }
        else cur.push(ql.trim());
      });
      if (cur.length) qParas.push(cur);
      html += '<blockquote class="kquote">' + (qParas.length ? qParas.map(function (p) { return '<p>' + p.map(inline).join('<br>') + '</p>'; }).join('') : '') + '</blockquote>';
      quote = [];
    };
    var flushAll = function () { flushPara(); flushList(); flushQuote(); };

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // Kódblokk: ``` ... ```
      if (/^\s*```/.test(line)) {
        flushAll();
        var code = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          code.push(lines[i]);
          i++;
        }
        html += '<pre class="kpre"><code>' + esc(code.join('\n')) + '</code></pre>';
        continue;
      }

      // GFM-táblázat: fejléc + elválasztó sor (| --- | ---: |)
      if (i + 1 < lines.length) {
        var head = splitTableRow(line);
        var aligns = head ? parseTableSep(lines[i + 1], head.length) : null;
        if (head && aligns) {
          flushAll();
          var trows = [];
          i += 2;
          while (i < lines.length) {
            var rl = lines[i];
            if (!rl.trim() || /^\s*```/.test(rl) || /^\s*#{1,4}\s+/.test(rl) || /^\s*>/.test(rl)) break;
            var cells = splitTableRow(rl);
            if (!cells) break;
            trows.push(cells.slice(0, head.length));
            i++;
          }
          i--;
          html += renderTable(head, aligns, trows);
          continue;
        }
      }

      // Címsor (# .. ####)
      var hd = /^\s*(#{1,4})\s+(.+?)\s*#*$/.exec(line);
      if (hd) {
        flushAll();
        var htag = hd[1].length >= 4 ? 'h4' : 'h3';
        html += '<' + htag + ' class="k' + htag + '">' + inline(hd[2]) + '</' + htag + '>';
        continue;
      }

      // Vízszintes elválasztó (---, ***, ___)
      if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) {
        flushAll();
        html += '<hr class="khr">';
        continue;
      }

      // Idézet (> ...)
      var bq = /^\s*>\s?(.*)$/.exec(line);
      if (bq) {
        flushPara(); flushList();
        quote.push(bq[1]);
        continue;
      }

      // Felsorolás (- / * / 1.)
      var ul = /^\s*[-*]\s+(.*)$/.exec(line), ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara(); flushQuote();
        var tag = ul ? 'ul' : 'ol';
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag: tag, items: [] };
        list.items.push((ul || ol)[1]);
      } else if (!line.trim()) {
        flushAll();
      } else {
        flushList(); flushQuote();
        para.push(line.trim());
      }
    }
    flushAll();
    return html;
  }

  var api = { render: render, escape: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapuMd = api;
})(typeof window !== 'undefined' ? window : globalThis);
