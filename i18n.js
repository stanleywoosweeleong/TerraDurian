/* i18n.js — language layer for TerraDurian: English, Simplified Chinese, Bahasa Melayu.
 *
 * Works at the TEXT-NODE level: it walks every text node and, if that node's trimmed text
 * exactly matches a key in the language file, swaps it — leaving sibling numbers and
 * structure intact. That reaches labels sitting next to live data (a factor name beside
 * its score, a table row label beside its value) which a whole-element approach cannot.
 *
 * - English is the source: the keys of zh.json / ms.json are the English strings.
 * - Injects a language picker in the header; the choice persists in localStorage.
 * - On the very first launch (no valid saved language) a full-screen picker asks once.
 *   "First launch" means nothing valid is saved — not a separate flag — so a damaged
 *   stored value also leads back to the picker instead of a broken interface.
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
    // `label` is what the header picker shows: short codes, so it stays small on a phone.
    ms: { label: 'BM',   html: 'ms',    file: './ms.json' },
    en: { label: 'EN',   html: 'en' },
    zh: { label: '中文', html: 'zh-CN', file: './zh.json' }
  };
  var lang = null;
  try { lang = localStorage.getItem(LS); } catch (e) {}           // storage can be blocked
  var firstLaunch = !LANGS[lang];  // nothing valid saved → the picker asks
  if (firstLaunch) lang = 'en';    // what shows behind the picker
  window.__tdLang = lang;          // the app's templates read this (kept in memory if storage is blocked)
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
        if (p.closest && p.closest('#langToggle, #langpick, #log, #map, code')) return NodeFilter.FILTER_REJECT;
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
      if (el.closest && el.closest('#map, #langpick')) continue;   // Leaflet's own controls; the picker is multilingual by design
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
    if (!LANGS[l]) return Promise.resolve(false);
    // Always save — even when the choice equals what is already showing. Skipping the save
    // for "no change" would mean picking the default language is never remembered, and the
    // first-launch picker would come back on every launch.
    try { localStorage.setItem(LS, l); } catch (e) {}
    lang = l; window.__tdLang = l;  // templates read the choice at once
    return load(l).then(function (d) {
      if (lang === l) apply(l, d);  // ignore a slow file that lost a race with a newer choice
      return true;
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

  // First-launch picker. The page shows it (synchronously, before first paint) when no valid
  // language is saved; here we give its buttons their job. It saves through setLang — the
  // same path as the header picker — so the latest choice always wins.
  function closePicker() {
    var lp = document.getElementById('langpick');
    if (!lp) return;
    lp.hidden = true;
    document.body.classList.remove('picking');
    var kids = document.body.children;
    for (var i = 0; i < kids.length; i++) kids[i].inert = false;
    window.scrollTo(0, 0);
  }
  function wirePicker() {
    var lp = document.getElementById('langpick');
    if (!lp) return;
    lp.onclick = function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-lang]') : null;
      if (!b || !LANGS[b.getAttribute('data-lang')]) return;
      firstLaunch = false;
      setLang(b.getAttribute('data-lang'));
      closePicker();
    };
    if (!firstLaunch && !lp.hidden) closePicker();   // page and layer disagree → trust the saved choice
  }

  function start() {
    injectToggle();
    wirePicker();
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
