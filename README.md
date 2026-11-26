# TerraDurian — NASA Earth Science Farm Intelligence

An installable web app (PWA) that reads a durian farm from orbit: soil moisture,
flowering induction, irrigation, terrain, soil, and a 16-day forecast — built on open
NASA data (POWER, MODIS, GIBS), ERA5-Land, and live SMAP via a Cloudflare Worker.
Three languages: English / 简体中文 / Bahasa Melayu.

## Deploy on GitHub Pages
1. Put every file in this repository into your repo root.
   Required for the website:
     index.html   manifest.webmanifest   sw.js   i18n.js   zh.json   ms.json
     barlow-semi-condensed-600.woff2   (the typeface for figures; SIL Open Font License,
                                        see barlow-semi-condensed-LICENSE.txt)
     icon-192.png   icon-512.png
     icon-192-maskable.png   icon-512-maskable.png   apple-touch-icon.png
   `TerraDurian.html` is only a redirect to `index.html`, kept so old links still work.
2. Repo → Settings → Pages → Source: "Deploy from a branch" → main → / (root).
3. Open the published https:// URL. On a phone: browser menu → "Add to Home Screen".

GitHub Pages already serves over HTTPS, which the PWA (install + offline) needs.

## Updating later
Just push your changes. There is no version number to bump anywhere.
GitHub Pages takes a minute or two to publish.

How the update reaches people:
- The app always opens instantly from the copy saved on the device.
- Each time it is opened, and each time it comes back to the foreground, it quietly
  checks for a newer copy and saves it.
- If the app's code changed (`index.html`, `i18n.js`, `zh.json` or `ms.json`), a
  "A new version is ready — Refresh" bar appears. Refresh applies it at once; if the
  bar is dismissed, the new copy simply appears on the next launch.
- Refreshing keeps the pin, the Farm setup and the saved plots for that browser tab.

## First launch
The first time the app is opened on a device it asks for a language (English / 中文 /
Bahasa Melayu) and remembers the answer. The picker in the header changes it later.

## Live SMAP
Real SMAP soil moisture comes through a Cloudflare Worker; the app has the endpoint
built in (Farm setup → SMAP endpoint). To run your own, deploy `tools/smap-worker.js`
(deploy notes are in the file header) and paste its URL into that field. If the Worker
cannot be reached, the app tries a local `smap.json`, then ORNL DAAC, then falls back
to the MERRA-2 proxy.

## tools/  (optional — NOT part of the website)
- smap-worker.js   Cloudflare Worker that serves live SMAP as CORS JSON. To update the
                   live worker, paste this file into the Worker's editor in Cloudflare
                   and deploy — nothing in this repo deploys it for you.

The NASA Earthdata token the Worker uses **expires about every 60 days**. When it does,
the app's SMAP panel shows "Earthdata rejected the token" and falls back to the model
proxy. Generate a new token at urs.earthdata.nasa.gov and replace the Worker's
`EARTHDATA_TOKEN` secret (Cloudflare → the Worker → Settings → Variables and Secrets).

To stop doing that by hand, add two more secrets to the Worker — `EARTHDATA_USERNAME`
and `EARTHDATA_PASSWORD` — and deploy the current `tools/smap-worker.js`. The Worker then
asks Earthdata Login for a valid token itself and renews it when it expires. Prefer a
separate Earthdata account made only for this Worker (it must accept the NSIDC DAAC EULA).

Two optional plain variables harden the Worker (see its header for details):
`ALLOWED_ORIGINS` (e.g. `https://stanleywoosweeleong.github.io`) refuses requests from
other websites, and `DEBUG=1` turns on the `?debug=1` / `?probe=1` diagnostics, which are
off by default.

The desktop helpers (`fetch_smap.py`, `diagnose_smap.py`, `Get SMAP data.bat`) are not
included in this repository.

## Languages
English is the source text. `zh.json` and `ms.json` map each fixed English string to its
translation; sentences that carry live numbers are per-language templates in `index.html`
(`TPL`, with Malay in `TPL_MS`). To correct a translation, edit the matching entry there.
The Fetch log is always in English — it is a diagnostic record.

## Notes
- Soil (ISRIC SoilGrids) and the forecast (Open-Meteo) are non-NASA sources, badged
  as such in the app.
- SMAP over a closed durian canopy is quality-flagged: read it as a trend, not an
  exact value. See the Sources tab.
