/* TerraDurian service worker — makes the app installable and offline-capable.

   Strategy:
   - THE APP'S OWN CODE (the HTML page, i18n.js, zh.json, the manifest): network-first with
     a 3 s timeout, then cache. These files must stay in step with each other — a new page
     paired with an old translation file shows untranslated text — and a stale cached page
     used to pin the app to an old build after a deploy.
   - OTHER SHELL ASSETS (icons, the two CDN libraries): stale-while-revalidate — instant
     from cache, refreshed in the background.
   - DATA APIs (NASA POWER, Open-Meteo, ORNL, your SMAP worker): network-first with a cache
     fallback, so you always get fresh data when online but still see the last good pull
     when you are out in the field with no signal — or when a data host is itself down
     (HTTP 5xx) or rate-limiting (429). Responses are stored under a key with
     the dates made relative (see dataKey), so yesterday's pull answers today's request
     offline, and each day's pull replaces the previous one instead of piling up.
*/
const VERSION = 'terradurian-v26';
const SHELL = VERSION + '-shell';
const DATA = VERSION + '-data';

const SHELL_ASSETS = [
  './',
  './index.html',
  './TerraDurian.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './i18n.js',
  './zh.json',
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

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL).then(c => c.addAll(SHELL_ASSETS).catch(() => {
      // if a CDN asset fails at install time, cache what we can and carry on
      return Promise.allSettled(SHELL_ASSETS.map(a => c.add(a)));
    })).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL && k !== DATA).map(k => caches.delete(k))
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
          const copy = res.clone();
          caches.open(DATA).then(c => c.put(key, copy));
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

  const cacheable = res => res && res.ok && (url.origin === self.location.origin
    || url.hostname.endsWith('unpkg.com') || url.hostname.endsWith('cloudflare.com'));

  // THE APP'S OWN CODE: network-first. The HTML must never be stale — a cached page can pin
  // the app to an old build (old basemap, old text) long after a deploy — and i18n.js /
  // zh.json must match the page they were deployed with. 3 s is plenty on a field
  // connection; if the network is slower or absent we fall back to the cache, so offline
  // still works.
  const ownCode = url.origin === self.location.origin && /\.(html|js|json|webmanifest)$/.test(url.pathname);
  if (req.mode === 'navigate' || ownCode) {
    event.respondWith(
      Promise.race([
        fetch(req),
        new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3000))
      ]).then(res => {
        if (cacheable(res)) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req).then(hit =>
        hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
    );
    return;
  }

  // OTHER SHELL ASSETS (icons, CDN libs): stale-while-revalidate —
  // serve the cached copy instantly, then quietly refresh it for next time. Fast start,
  // but a deploy is picked up on the following load instead of never.
  event.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (cacheable(res)) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
