/* TerraDurian service worker — makes the app installable and offline-capable.

   Strategy:
   - PAGE LOADS (the HTML itself): network-first with a 3 s timeout, then cache. A stale
     cached page used to pin the app to an old build after a deploy; this prevents that
     while still opening offline.
   - OTHER SHELL ASSETS (icons, i18n.js, zh.json, the two CDN libraries):
     stale-while-revalidate — instant from cache, refreshed in the background.
   - DATA APIs (NASA POWER, Open-Meteo, ORNL, GIBS tiles, your SMAP worker): network-first
     with a cache fallback, so you always get fresh data when online but still see the last
     good pull when you are out in the field with no signal.
*/
const VERSION = 'terradurian-v20';
const SHELL = VERSION + '-shell';
const DATA = VERSION + '-data';

const SHELL_ASSETS = [
  './',
  './index.html',
  './TerraDurian.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
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
    event.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(DATA).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  const cacheable = res => res && res.ok && (url.origin === self.location.origin
    || url.hostname.endsWith('unpkg.com') || url.hostname.endsWith('cloudflare.com'));

  // PAGE LOADS: network-first. The HTML must never be stale — a cached page can pin the
  // app to an old build (old basemap, old text) long after a deploy. 3 s is plenty on a
  // field connection; if the network is slower or absent we fall back to the cache, so
  // offline still works.
  if (req.mode === 'navigate') {
    event.respondWith(
      Promise.race([
        fetch(req),
        new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3000))
      ]).then(res => {
        if (cacheable(res)) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // OTHER SHELL ASSETS (scripts, icons, zh.json, CDN libs): stale-while-revalidate —
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
