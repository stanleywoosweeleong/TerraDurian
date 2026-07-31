/* i18n.js — bilingual layer for TerraDurian (English <-> Simplified Chinese).
 *
 * Works at the TEXT-NODE level: it walks every text node and, if that node's trimmed text
 * exactly matches a key in zh.json, swaps it — leaving sibling numbers and structure intact.
 * That reaches labels sitting next to live data (a factor name beside its score, a table
 * row label beside its value) which a whole-element approach cannot.
 *
 * - Injects an EN / 中文 toggle in the header; the choice persists in localStorage.
 * - A MutationObserver re-runs after the app re-renders, so fresh content translates too.
 * - Only EXACT trimmed matches are swapped, so numbers and one-off phrases stay English.
 * - Each translated node's English is remembered, so switching back restores it exactly.
 */
(function () {
  'use strict';
  var LS = 'td_lang';
  var lang = localStorage.getItem(LS) || 'en';
  var dict = {};
  var observer = null, timer = null;
  var orig = new WeakMap();

  var SKIP = { SCRIPT:1, STYLE:1, TEXTAREA:1, CANVAS:1, CODE:1 };

  function collect() {
    var tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentNode;
        if (!p || SKIP[p.tagName]) return NodeFilter.FILTER_REJECT;
        if (p.id === 'langToggle') return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('#log, #map, code')) return NodeFilter.FILTER_REJECT;
        return (n.nodeValue && n.nodeValue.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var out = [], n;
    while ((n = tw.nextNode())) out.push(n);
    return out;
  }

  function translateAll() {
    if (observer) observer.disconnect();
    collect().forEach(function (n) {
      if (lang === 'en') {
        if (orig.has(n) && n.nodeValue !== orig.get(n)) n.nodeValue = orig.get(n);
        return;
      }
      var raw = n.nodeValue;
      var t = dict[raw.trim().replace(/\s+/g, ' ')];   // whitespace-tolerant match
      if (t == null) return;
      if (!orig.has(n)) orig.set(n, raw);
      var lead = (raw.match(/^\s*/) || [''])[0];
      var trail = (raw.match(/\s*$/) || [''])[0];
      var want = lead + t + trail;
      if (n.nodeValue !== want) n.nodeValue = want;
    });
    if (observer) observer.observe(document.body, { childList: true, subtree: true });
  }

  function setLang(l) {
    lang = l;
    try { localStorage.setItem(LS, l); } catch (e) {}
    document.documentElement.lang = (l === 'zh') ? 'zh-CN' : 'en';
    var b = document.getElementById('langToggle');
    if (b) b.textContent = (l === 'en') ? '中文' : 'EN';
    translateAll();
    // repaint number-bearing dynamic panels (drainage verdict, SMAP caveat, …)
    // in the new language; the MutationObserver then re-translates their static labels.
    if (window.__tdRerender) { try { window.__tdRerender(); } catch (e) {} }
  }

  function injectToggle() {
    var hdr = document.querySelector('header');
    if (!hdr || document.getElementById('langToggle')) return;
    var b = document.createElement('button');
    b.id = 'langToggle';
    b.type = 'button';
    b.textContent = (lang === 'en') ? '中文' : 'EN';
    b.title = 'Switch language / 切换语言';
    b.style.cssText = 'margin-left:10px;font-weight:600';
    b.onclick = function () { setLang(lang === 'en' ? 'zh' : 'en'); };
    var status = document.getElementById('status');
    if (status && status.parentNode === hdr) hdr.insertBefore(b, status);
    else hdr.appendChild(b);
  }

  function start() {
    injectToggle();
    observer = new MutationObserver(function () {
      clearTimeout(timer);
      timer = setTimeout(translateAll, 80);
    });
    if (lang === 'zh') translateAll();
    else observer.observe(document.body, { childList: true, subtree: true });
  }

  fetch('./zh.json')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      dict = d;
      if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start);
      else start();
    })
    .catch(function () {
      if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', injectToggle);
      else injectToggle();
    });
})();
