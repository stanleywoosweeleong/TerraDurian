# TerraDurian — NASA Earth Science Farm Intelligence

An installable web app (PWA) that reads a durian farm from orbit: soil moisture,
flowering induction, irrigation, terrain, soil, and a 16-day forecast — built on open
NASA data (POWER, MODIS, GIBS), ERA5-Land, and live SMAP via a Cloudflare Worker.
Bilingual English / 简体中文.

## Deploy on GitHub Pages
1. Put every file in THIS folder (except the `tools/` folder) into your repo root.
   Required for the website:
     index.html   manifest.webmanifest   sw.js   i18n.js   zh.json
     icon-192.png   icon-512.png
     icon-192-maskable.png   icon-512-maskable.png   apple-touch-icon.png
2. Repo → Settings → Pages → Source: "Deploy from a branch" → main → / (root).
3. Open the published https:// URL. On a phone: browser menu → "Add to Home Screen".

GitHub Pages already serves over HTTPS, which the PWA (install + offline) needs.

## Updating later
When you change any file, bump the version string in `sw.js`
(e.g. `terradurian-v2` → `-v3`). That tells the service worker to drop the old
cache and serve the new files. Skip this and returning visitors may see a stale copy.

## Live SMAP
Real SMAP soil moisture comes through a Cloudflare Worker; the app has the endpoint
built in (Farm setup → SMAP endpoint). To run your own, deploy `tools/smap-worker.js`
(deploy notes are in the file header) and paste its URL into that field.

## tools/  (optional — NOT part of the website, do not upload to Pages)
- smap-worker.js   Cloudflare Worker that serves live SMAP as CORS JSON
- fetch_smap.py    desktop script: pull SMAP to a local smap.json (needs Earthdata login)
- diagnose_smap.py one-granule SMAP diagnostic
- Get SMAP data.bat  double-click wrapper for fetch_smap.py (Windows)

## Notes
- Soil (ISRIC SoilGrids) and the forecast (Open-Meteo) are non-NASA sources, badged
  as such in the app.
- SMAP over a closed durian canopy is quality-flagged: read it as a trend, not an
  exact value. See the Sources tab.
