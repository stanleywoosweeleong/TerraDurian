/* TerraDurian service worker — makes the app installable and offline-capable.

   Strategy:
   - APP SHELL (the HTML, icons, the two CDN libraries): cache-first, so the app opens
     instantly and works with no connection.
   - DATA APIs (NASA POWER, Open-Meteo, ORNL, GIBS tiles, your SMAP worker): network-first
     with a cache fallback, so you always get fresh data when online but still see the last
     good pull when you are out in the field with no signal.
*/
const VERSION = 'terradurian-v8';
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
  'basemaps.cartocdn.com'
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
  } else {
    // shell: cache-first
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res && res.ok && (url.origin === self.location.origin
              || url.hostname.endsWith('unpkg.com') || url.hostname.endsWith('cloudflare.com'))) {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(req, copy));
        }
        return res;
      }))
    );
  }
});
