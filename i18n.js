/* i18n.js — language layer for TerraDurian: English, Simplified Chinese, Bahasa Melayu.
 *
 * Works at the TEXT-NODE level: it walks every text node and, if that node's trimmed text
 * exactly matches a key in the language file, swaps it — leaving sibling numbers and
 * structure intact. That reaches labels sitting next to live data (a factor name beside
 * its score, a table row label beside its value) which a whole-element approach cannot.
 *
 * - English is the source: the keys of zh.json / ms.json are the English strings.
 * - Injects a language picker in the header; the choice persists in localStorage.
 * - A MutationObserver re-runs after the app re-renders, so fresh content translates too.
 * - Only EXACT trimmed matches are swapped, so numbers and one-off phrases stay English.
 * - Each translated node's English is remembered, so switching language (to English or
 *   straight from one translation to another) always starts from the original.
 * - Input placeholders and aria-labels are translated too.
 * - Sentences that carry live numbers are NOT handled here: the app builds those from its
 *   own per-language templates (TPL in index.html) and repaints via window.__tdRerender.
 *
 * To add a language: add it to LANGS, ship <code>.json, and add the templates in index.html.
 */
(function () {
  'use strict';
  var LS = 'td_lang';
  var LANGS = {
    en: { label: 'English',       html: 'en' },
    zh: { label: '中文',           html: 'zh-CN', file: './zh.json' },
    ms: { label: 'Bahasa Melayu', html: 'ms',    file: './ms.json' }
  };
  var lang = 'en';
  try { lang = localStorage.getItem(LS) || 'en'; } catch (e) {}   // storage can be blocked
  if (!LANGS[lang]) lang = 'en';
  var dicts = { en: {} };          // language code -> {english: translation}
  var dict = {};                   // the active one
  var observer = null;
  var orig = new WeakMap();        // text node -> its English text
  var shown = new WeakMap();       // text node -> what we last wrote into it

  var SKIP = { SCRIPT:1, STYLE:1, TEXTAREA:1, CANVAS:1, CODE:1 };

  function collect() {
    var tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentNode;
        if (!p || SKIP[p.tagName]) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('#langToggle, #log, #map, code')) return NodeFilter.FILTER_REJECT;
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
      // If the app has rewritten this node since we last touched it, its current text is
      // fresh English and the remembered original no longer applies.
      if (orig.has(n) && shown.get(n) !== n.nodeValue) { orig.delete(n); shown.delete(n); }
      var raw = orig.has(n) ? orig.get(n) : n.nodeValue;          // always translate from English
      var t = (lang === 'en') ? null : dict[raw.trim().replace(/\s+/g, ' ')];   // whitespace-tolerant match
      var want = raw;
      if (t != null) {
        var lead = (raw.match(/^\s*/) || [''])[0];
        var trail = (raw.match(/\s*$/) || [''])[0];
        want = lead + t + trail;
      }
      if (want !== raw) { orig.set(n, raw); shown.set(n, want); }
      else if (orig.has(n)) { orig.delete(n); shown.delete(n); }
      if (n.nodeValue !== want) n.nodeValue = want;
    });
    translateAttrs();
    if (observer) observer.observe(document.body, { childList: true, subtree: true });
  }

  // Text that lives in attributes — input placeholders and the labels screen readers speak.
  // The English original is parked in data-en-<attr> so switching back restores it exactly.
  var ATTRS = ['placeholder', 'aria-label'];
  function translateAttrs() {
    var els = document.querySelectorAll('[placeholder],[aria-label]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest && el.closest('#map')) continue;          // Leaflet's own controls
      for (var j = 0; j < ATTRS.length; j++) {
        var a = ATTRS[j], cur = el.getAttribute(a);
        if (cur == null) continue;
        var en = el.getAttribute('data-en-' + a);
        var src = en != null ? en : cur;
        var t = (lang === 'en') ? null : dict[src];
        var want = t != null ? t : src;
        if (t != null && en == null) el.setAttribute('data-en-' + a, cur);
        if (cur !== want) el.setAttribute(a, want);
      }
    }
  }

  // Fetch a language file once; resolves to {} for English or if the file cannot be loaded
  // (the app then simply stays in English rather than breaking).
  function load(l) {
    if (dicts[l]) return Promise.resolve(dicts[l]);
    return fetch(LANGS[l].file)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { dicts[l] = d; return d; })
      .catch(function () { return {}; });
  }

  function apply(l, d) {
    lang = l; dict = d;
    window.__tdDict = d;            // the app looks up names held in data tables (e.g. map layers)
    document.documentElement.lang = LANGS[l].html;
    var sel = document.getElementById('langToggle');
    if (sel && sel.value !== l) sel.value = l;
    translateAll();
    // repaint number-bearing dynamic panels (drainage verdict, SMAP caveat, …)
    // in the new language; the MutationObserver then re-translates their static labels.
    if (window.__tdRerender) { try { window.__tdRerender(); } catch (e) {} }
  }

  function setLang(l) {
    if (!LANGS[l]) l = 'en';
    try { localStorage.setItem(LS, l); } catch (e) {}
    lang = l;                       // templates read the stored choice at once
    return load(l).then(function (d) {
      if (lang === l) apply(l, d);  // ignore a slow file that lost a race with a newer choice
    });
  }

  function injectToggle() {
    var hdr = document.querySelector('header');
    if (!hdr || document.getElementById('langToggle')) return;
    var sel = document.createElement('select');
    sel.id = 'langToggle';
    sel.setAttribute('aria-label', 'Language / 语言 / Bahasa');
    sel.title = 'Language / 语言 / Bahasa';
    sel.style.cssText = 'margin-left:10px;font-weight:600';
    Object.keys(LANGS).forEach(function (k) {
      var o = document.createElement('option');
      o.value = k; o.textContent = LANGS[k].label;
      sel.appendChild(o);
    });
    sel.value = lang;
    sel.onchange = function () { setLang(sel.value); };
    var status = document.getElementById('status');
    if (status && status.parentNode === hdr) hdr.insertBefore(sel, status);
    else hdr.appendChild(sel);
  }

  function start() {
    injectToggle();
    // Translate SYNCHRONOUSLY inside the observer callback: MutationObserver fires
    // before the browser paints, so freshly rendered English is swapped before it ever
    // becomes visible — no flicker. (A debounce timer here would let a frame of English
    // paint first.) translateAll() disconnects the observer while it edits, so it cannot
    // re-trigger itself.
    observer = new MutationObserver(function () {
      if (lang !== 'en') translateAll();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    if (lang !== 'en') load(lang).then(function (d) { apply(lang, d); });
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start);
  else start();
})();
