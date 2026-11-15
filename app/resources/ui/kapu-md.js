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

  /* Félkövér és dőlt az (még nem escape-elt) szövegen; az eredmény biztonságos HTML. */
  function formatPlain(s) {
    var h = esc(s);
    h = h.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
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

  function render(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var html = '', para = [], list = null; // list: {tag, items}
    var flushPara = function () {
      if (para.length) html += '<p>' + para.map(inline).join('<br>') + '</p>';
      para = [];
    };
    var flushList = function () {
      if (list) html += '<' + list.tag + '>' + list.items.map(function (i) { return '<li>' + inline(i) + '</li>'; }).join('') + '</' + list.tag + '>';
      list = null;
    };
    lines.forEach(function (line) {
      var ul = /^\s*[-*]\s+(.*)$/.exec(line), ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        var tag = ul ? 'ul' : 'ol';
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag: tag, items: [] };
        list.items.push((ul || ol)[1]);
      } else if (!line.trim()) {
        flushPara(); flushList();
      } else {
        flushList();
        para.push(line.trim());
      }
    });
    flushPara(); flushList();
    return html;
  }

  var api = { render: render, escape: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KapuMd = api;
})(typeof window !== 'undefined' ? window : globalThis);
