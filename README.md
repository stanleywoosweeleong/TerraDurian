# TerraDurian — NASA Earth Science Farm Intelligence

An installable web app (PWA) that reads a durian farm from orbit: soil moisture,
flowering induction, irrigation, terrain, soil, and a 16-day forecast — built on open
NASA data (POWER, MODIS, GIBS), ERA5-Land, and live SMAP via a Cloudflare Worker.
Bilingual English / 简体中文.

## Deploy on GitHub Pages
1. Put every file in this repository into your repo root.
   Required for the website:
     index.html   manifest.webmanifest   sw.js   i18n.js   zh.json
     icon-192.png   icon-512.png
     icon-192-maskable.png   icon-512-maskable.png   apple-touch-icon.png
   `TerraDurian.html` is only a redirect to `index.html`, kept so old links still work.
2. Repo → Settings → Pages → Source: "Deploy from a branch" → main → / (root).
3. Open the published https:// URL. On a phone: browser menu → "Add to Home Screen".

GitHub Pages already serves over HTTPS, which the PWA (install + offline) needs.

## Updating later
The page, `i18n.js` and `zh.json` are fetched network-first, so returning visitors get
a new deploy on their next online load without any extra step. Icons and the two CDN
libraries are served from cache and refreshed in the background.

Bump the version string in `sw.js` (e.g. `terradurian-v24` → `-v25`) when you want to
throw away everything cached on visitors' devices — for example after changing how
data responses are cached.

## Live SMAP
Real SMAP soil moisture comes through a Cloudflare Worker; the app has the endpoint
built in (Farm setup → SMAP endpoint). To run your own, deploy `tools/smap-worker.js`
(deploy notes are in the file header) and paste its URL into that field. If the Worker
cannot be reached, the app tries a local `smap.json`, then ORNL DAAC, then falls back
to the MERRA-2 proxy.

## tools/  (optional — NOT part of the website, and not included in this repository)
- smap-worker.js   Cloudflare Worker that serves live SMAP as CORS JSON
- fetch_smap.py    desktop script: pull SMAP to a local smap.json (needs Earthdata login)
- diagnose_smap.py one-granule SMAP diagnostic
- Get SMAP data.bat  double-click wrapper for fetch_smap.py (Windows)

## Notes
- Soil (ISRIC SoilGrids) and the forecast (Open-Meteo) are non-NASA sources, badged
  as such in the app.
- SMAP over a closed durian canopy is quality-flagged: read it as a trend, not an
  exact value. See the Sources tab.
