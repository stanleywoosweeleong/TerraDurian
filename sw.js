/* TerraDurian service worker — makes the app installable, offline-capable and
   self-updating. There is NO version number to bump on a deploy.

   How updates reach people:
   - The app opens instantly from the saved copy (cache-first). On a weak rural signal a
     network-first launch means staring at a blank screen until a timeout.
   - Every time the page loads, and whenever the app comes back to the foreground, the page
     sends this worker a "check" message. The worker re-fetches every app file past the
     HTTP cache, compares it byte-for-byte with the saved copy, and stores the new one.
   - If the app's own code changed (the page, i18n.js or a language file), every open window
     is told "updated" and shows a "new version is ready" bar with a Refresh button.
     Dismissing it is fine — the new copy is already saved and appears on the next launch.

   The rest:
   - CDN LIBRARIES (Leaflet, Chart.js): stale-while-revalidate. They are pinned by version
     and integrity hash, so they effectively never change.
   - DATA APIs (NASA POWER, Open-Meteo, ORNL, your SMAP worker): network-first with a cache
     fallback, so you always get fresh data when online but still see the last good pull
     when you are out in the field with no signal — or when a data host is itself down
     (HTTP 5xx) or rate-limiting (429). Responses are stored under a key with the dates
     made relative (see dataKey), so yesterday's pull answers today's request offline, and
     each day's pull replaces the previous one instead of piling up.
*/
const CACHE_PREFIX = 'terradurian-';     // unique to THIS app — see activate
const SHELL = 'terradurian-shell';       // fixed names: they never change between deploys
const DATA = 'terradurian-data';
const INDEX = './index.html';

// The app's own code. A byte change in any of these is "a new version".
const CODE = [INDEX, './i18n.js', './zh.json', './ms.json'];
// Every same-origin file the app needs offline.
const OWN = CODE.concat([
  './TerraDurian.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './barlow-semi-condensed-600.woff2'
]);
const CDN = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
];

// hosts whose responses are data, not shell — always try the network first
const DATA_HOSTS = [
  'power.larc.nasa.gov',
  'modis.ornl.gov',
  'api.open-meteo.com',
  'archive-api.open-meteo.com',
  'api.opentopodata.org',
  'rest.isric.org',
  'api.openepi.io',
  'gibs.earthdata.nasa.gov',
  'services.arcgisonline.com'
];

function sameBytes(a, b){
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/* Fetch one file past the HTTP cache and store it. Resolves true only when a copy was
   already saved and the new one differs. Errors and non-200 responses leave the cache
   alone, so a temporary 404/503 from the host can never replace the app with an error page.
   {cache:'no-cache'} matters: GitHub Pages sends max-age=600, so a plain fetch can hand
   back the stale copy for ten minutes after a deploy. */
function refresh(url){
  return fetch(url, {cache: 'no-cache'}).then(res => {
    if (!res || !res.ok) return false;
    return caches.open(SHELL).then(c => c.match(url).then(old =>
      Promise.all([old ? old.arrayBuffer() : null, res.clone().arrayBuffer()]).then(b => {
        const changed = !!b[0] && !sameBytes(b[0], b[1]);
        return c.put(url, res).then(() => changed);
      })));
  }).catch(() => false);
}
// Refresh every own file; true if any of the CODE files changed.
function refreshShell(){
  return Promise.all(OWN.map(refresh)).then(changed => CODE.some(f => changed[OWN.indexOf(f)]));
}

// install: save the app, then take over at once. Safe because the cache names are stable —
// a new worker never strands an open page on a deleted cache.
self.addEventListener('install', event => {
  event.waitUntil(
    refreshShell()
      .then(() => caches.open(SHELL))
      .then(c => Promise.allSettled(CDN.map(u => c.match(u).then(hit => hit || c.add(u)))))   // a CDN hiccup must not block install
      .then(() => self.skipWaiting())
  );
});

// activate: delete only THIS app's other caches (the old versioned ones). Cache Storage is
// shared by the whole origin — on <user>.github.io that is every project page — so caches
// without our prefix belong to other apps and are left alone.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.indexOf(CACHE_PREFIX) === 0 && k !== SHELL && k !== DATA).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

/* Data URLs carry absolute dates (start=20251122, end_date=2026-11-22, …) that move forward
   every day. Stored verbatim, tomorrow's request would never match today's response and the
   cache would grow by one full pull per day. So each date value is rewritten as "days before
   today": the same request made tomorrow maps to the same key. */
function dataKey(url){
  const u = new URL(url.href);
  const today = Math.floor(Date.now() / 864e5);
  Array.from(u.searchParams.keys()).forEach(k => {
    const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(u.searchParams.get(k));
    if (m) u.searchParams.set(k, 'd-' + (today - Math.floor(Date.UTC(+m[1], m[2] - 1, +m[3]) / 864e5)));
  });
  return u.href;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  const isData = DATA_HOSTS.some(h => url.hostname.endsWith(h))
    || url.pathname.endsWith('smap.json')
    || url.hostname.endsWith('workers.dev');   // your Cloudflare SMAP worker

  if (isData) {
    // network-first, fall back to the last good copy
    const key = dataKey(url);
    event.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) {
          // Stored with the time it was saved. When this copy is later served in place of a
          // live answer, the page reads X-TD-Saved and badges the panels built from it.
          const copy = res.clone();
          const headers = new Headers(copy.headers);
          headers.set('X-TD-Saved', new Date().toISOString());
          const stamped = new Response(copy.body, {status: copy.status, statusText: copy.statusText, headers});
          caches.open(DATA).then(c => c.put(key, stamped));
          return res;
        }
        // The host answered, but with "I am down" (5xx) or "slow down" (429). That is as
        // useless to the grower as no signal, so the last good copy stands in here too.
        // Not for the SMAP worker: its 502 carries the reason (an expired token) and must
        // reach the app rather than be papered over with old readings.
        if (res && (res.status >= 500 || res.status === 429) && !url.hostname.endsWith('workers.dev'))
          return caches.match(key).then(hit => hit || res);
        return res;
      }).catch(() => caches.match(key).then(hit => hit || Response.error()))
    );
    return;
  }

  // PAGE LOADS: the saved app, instantly; the network only if nothing is saved yet.
  // Freshness is handled by the "check" message below, not here — if the worker
  // revalidated during the navigation it could finish before the new page is listening,
  // and the "updated" notice would be lost.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match(INDEX).then(hit => hit || fetch(req).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(INDEX, copy)); }
        return res;
      }))
    );
    return;
  }

  // THE APP'S OTHER FILES (scripts, language files, icons): saved copy first.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  // CDN LIBRARIES: stale-while-revalidate. Anything else cross-origin (map tiles) is
  // passed through untouched.
  if (!(url.hostname.endsWith('unpkg.com') || url.hostname.endsWith('cloudflare.com'))) return;
  event.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

// "check" from a page: refresh the app's files and, if its code changed, tell every open
// window so each can offer a reload.
self.addEventListener('message', event => {
  if (event.data !== 'check') return;
  event.waitUntil(
    refreshShell().then(changed => {
      if (!changed) return;
      return self.clients.matchAll({type: 'window'}).then(list => list.forEach(c => c.postMessage('updated')));
    })
  );
});
