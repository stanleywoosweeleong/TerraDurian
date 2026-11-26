/**
 * smap-worker.js — Cloudflare Worker: real NASA SMAP soil moisture as CORS JSON.
 *
 * Deploy: put your Earthdata BEARER TOKEN in a secret named EARTHDATA_TOKEN
 *   (dashboard: Settings -> Variables and Secrets -> Add -> Encrypt).
 *   Token from https://urs.earthdata.nasa.gov -> Generate Token.
 *   Your account must have accepted the NSIDC DAAC EULA.
 *
 *   EARTHDATA TOKENS EXPIRE (about every 60 days). When that happens every call answers
 *   502 with an "Earthdata rejected the token" error and the app falls back to its model
 *   proxy. The fix is always the same: generate a new token and replace the secret.
 *
 * AUTOMATIC RENEWAL (optional, recommended): add two more secrets,
 *     EARTHDATA_USERNAME   and   EARTHDATA_PASSWORD
 *   and the Worker asks Earthdata Login for a token by itself
 *   (POST /api/users/find_or_create_token — it hands back the account's current token, or
 *   makes a new one once the old one has expired). Nothing then needs replacing by hand.
 *   With both set, EARTHDATA_TOKEN is ignored and can be deleted.
 *   Use a separate Earthdata account made just for this Worker if you can: the password
 *   is stored encrypted, but anyone who can edit this Worker could read it out.
 *
 * Call:  /?lat=3.2477&lon=102.4192&days=365&max=18
 *   ?end=YYYY-MM-DD -> window ENDS on this date instead of today. This is how the app
 *                      paginates: several calls with different ?end each get their own
 *                      50-subrequest budget, so 4 calls × 90 days × 25 granules ≈ 100
 *                      observations instead of 18. Responses carry a `window` field so
 *                      the app can tell this worker version supports it.
 *   ?debug=1   -> dump the first granule's links so the OPeNDAP path can be verified
 *   ?loose=0   -> drop canopy-flagged retrievals (default keeps them)
 *
 * Free-plan safe: fetches at most `max` granules (default 18), IN PARALLEL, each with
 * an 8 s timeout — so it stays under the 50-subrequest cap and never hits the gateway
 * timeout. It samples evenly across the requested period rather than clustering.
 *
 * Caching: responses are stored in the Cloudflare edge cache — historical windows
 * (ending >2 days ago) for 30 days (the archive is immutable), current windows for
 * 6 hours. Repeat fetches cost NASA nothing and return instantly.
 * EXCEPT: if more than 20% of the granule fetches timed out, the (partial) result is
 * cached for only 1 hour — so a refetch on a better day fills in the missing points
 * instead of locking a bad NASA moment in for a month. A couple of timeouts out of 25
 * is normal NASA weather and still caches long.
 * A rejected token is never cached at all: once the secret is replaced, the very next
 * call works. A window in which NASA's data host answered with errors is treated like
 * timeouts (short cache), and an entirely empty answer is never kept longer than 6 hours.
 *
 * OPTIONAL HARDENING (both are plain variables, not secrets):
 *   ALLOWED_ORIGINS  comma-separated list, e.g. "https://you.github.io". When set, requests
 *                    from web pages on any other site are refused. Requests with no Origin
 *                    (typing the address into a browser, curl) are still allowed, so this
 *                    stops other sites using your worker, not a determined individual.
 *   DEBUG            set to "1" to enable ?debug=1 and ?probe=1. They bypass the cache and
 *                    spend NASA requests, so they are off unless you turn them on.
 */

const CMR = 'https://cmr.earthdata.nasa.gov/search/granules.json';
const SHORT_NAME = 'SPL3SMP_E';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });
const TOKEN_MSG = 'Earthdata rejected the token — it has expired (they last about 60 days) or the account '
  + 'has not accepted the NSIDC DAAC EULA. Generate a new token at urs.earthdata.nasa.gov and replace '
  + 'the EARTHDATA_TOKEN secret on this Worker.';
const isAuthFail = status => status === 401 || status === 403;

// ── automatic token renewal ────────────────────────────────────────────────────────────
// The token is kept in memory for the life of this Worker instance and re-read from
// Earthdata Login at most every 6 hours, or at once when NASA rejects it.
const URS_TOKEN = 'https://urs.earthdata.nasa.gov/api/users/find_or_create_token';
const TOKEN_TTL = 6 * 3600 * 1000;
let memo = { token: null, at: 0 };
const canRenew = env => !!(env.EARTHDATA_USERNAME && env.EARTHDATA_PASSWORD);
const b64 = str => btoa(String.fromCharCode(...new TextEncoder().encode(str)));   // safe for non-ASCII passwords
async function getToken(env, force) {
  if (!canRenew(env)) return env.EARTHDATA_TOKEN || null;          // manual mode: the stored secret
  if (!force && memo.token && Date.now() - memo.at < TOKEN_TTL) return memo.token;
  const r = await timedFetch(URS_TOKEN, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + b64(env.EARTHDATA_USERNAME + ':' + env.EARTHDATA_PASSWORD) },
  }, 10000);
  if (!r.ok) {
    memo = { token: null, at: 0 };
    throw new Error(r.status === 401
      ? 'Earthdata Login refused EARTHDATA_USERNAME / EARTHDATA_PASSWORD — check both secrets on this Worker.'
      : 'Earthdata Login answered HTTP ' + r.status + ' when asked for a token.');
  }
  const j = await r.json();
  if (!j || !j.access_token) throw new Error('Earthdata Login returned no token.');
  memo = { token: j.access_token, at: Date.now() };
  return memo.token;
}
// integer query parameter with a default and hard bounds; junk input gets the default
const intParam = (v, dflt, lo, hi) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// EASE-Grid 2.0 global 9 km — identical maths to fetch_smap.py
const E = { rows: 1624, cols: 3856, cell: 9008.055210146, a: 6378137.0, e: 0.081819190842621, ts: 30.0 };
function easeRowCol(lat, lon) {
  const phi = lat * Math.PI / 180, lam = lon * Math.PI / 180, pts = E.ts * Math.PI / 180, e = E.e;
  const k0 = Math.cos(pts) / Math.sqrt(1 - e * e * Math.sin(pts) ** 2), s = Math.sin(phi);
  const q = (1 - e * e) * (s / (1 - e * e * s * s) - (1 / (2 * e)) * Math.log((1 - e * s) / (1 + e * s)));
  const x = E.a * k0 * lam, y = E.a * q / (2 * k0);
  const col = Math.floor((x + (E.cols / 2) * E.cell) / E.cell);
  const row = Math.floor(((E.rows / 2) * E.cell - y) / E.cell);
  return (row < 0 || row >= E.rows || col < 0 || col >= E.cols) ? null : { row, col };
}

async function timedFetch(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms || 8000);
  try { return await fetch(url, { ...opts, signal: c.signal }); }
  finally { clearTimeout(t); }
}
// Like timedFetch, but the clock also covers reading the body — a response whose headers
// arrive promptly and whose data then stalls would otherwise hang the whole invocation.
async function timedBytes(url, opts, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms || 8000);
  try {
    const r = await fetch(url, { ...opts, signal: c.signal });
    return { status: r.status, ok: r.ok, bytes: r.ok ? new Uint8Array(await r.arrayBuffer()) : null };
  } finally { clearTimeout(t); }
}

// find the OPeNDAP base for a granule from its CMR links.
// NSIDC's Hyrax link is a "service#" rel whose href points at opendap.earthdata.nasa.gov/collections/
// and ends in a CMR-suffixed granule name (….h5_XXXX), NOT a clean ".h5" — so match on the host.
function opendapBase(entry) {
  for (const l of (entry.links || [])) {
    const h = l.href || '';
    // anchored: the bearer token is sent to this address, so it must BE NASA's host, not merely mention it
    if (/^https:\/\/opendap\.earthdata\.nasa\.gov\/collections\//i.test(h)) return h.replace(/\.html$/i, '');
  }
  return null;
}
function dateOf(e) { const t = e.time_start || e.updated || ''; return t ? t.slice(0, 10) : null; }

// .dap.csv is broken for this dataset and DAP2 is unrepresentable, so we read the DAP4
// BINARY (.dap) response. Its layout, verified byte-for-byte against a known granule:
//   ...DMR XML... </Dataset> \n\r\n  [4-byte chunk header]  N×([4-byte value][4-byte CRC])  [4-byte trailer]
// The data sits at the very END, so counting back from buf.length is immune to the DMR's
// varying length. We request 4 Float32 vars (sm + vegetation, AM & PM) → uniform 8-byte stride.
// We tell soil-moisture (0–1) from vegetation-water-content (>1) by value, not position.
// KNOWN LIMIT: over sparse vegetation VWC can itself be below 1 kg/m², and it would then be
// read as soil moisture. That cannot happen under a closed tree canopy (VWC is well above 5),
// which is what this worker is for — do not reuse it for bare or arid sites without fixing this.
function readDap(buf, nVars) {
  if (!buf || buf.length < 8 + 8 * nVars) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const base = buf.length - 4 - 8 * nVars;              // first value, counting from the end
  const v = i => dv.getFloat32(base + i * 8, true);
  const pick = (a, b) => {                              // one AM/PM pair -> {sm, vwc} or null
    let sm = null, vwc = null;
    for (const x of [v(a), v(b)]) {
      if (x >= 0.01 && x <= 1) sm = x;                 // below 0.01 is not a soil-moisture value (or is stray bytes)
      else if (x > 1 && x < 100) vwc = x;
    }
    return sm != null ? { sm, vwc } : null;
  };
  const r = pick(0, 1) || pick(2, 3);                  // AM pair preferred, else PM pair
  if (!r) return null;
  return { sm: r.sm, vwc: r.vwc, flag: r.vwc != null && r.vwc > 5 };  // SMAP trusts VWC < ~5 kg/m²
}

function pickEvenly(arr, k) {
  if (arr.length <= k) return arr;
  const out = [], step = arr.length / k;
  for (let i = 0; i < k; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    // optional: refuse other websites (see ALLOWED_ORIGINS in the header)
    const origin = request.headers.get('Origin');
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
    if (allowed.length && origin && allowed.indexOf(origin) < 0)
      return json({ error: 'This SMAP worker does not serve requests from ' + origin + '.' }, 403);
    if (!canRenew(env) && !env.EARTHDATA_TOKEN)
      return json({ error: 'Worker has no credentials: set EARTHDATA_USERNAME and EARTHDATA_PASSWORD (automatic renewal), or EARTHDATA_TOKEN.' }, 500);

    const u = new URL(request.url);
    const lat = parseFloat(u.searchParams.get('lat')), lon = parseFloat(u.searchParams.get('lon'));
    const days = intParam(u.searchParams.get('days'), 365, 1, 1460);
    const max = intParam(u.searchParams.get('max'), 18, 1, 30);
    const loose = u.searchParams.get('loose') !== '0';
    const diag = env.DEBUG === '1';                                   // diagnostics are opt-in
    const debug = diag && u.searchParams.get('debug') === '1';
    const probe = diag && u.searchParams.get('probe') === '1';
    if (!isFinite(lat) || !isFinite(lon)) return json({ error: 'need ?lat= and ?lon=' }, 400);
    const rc = easeRowCol(lat, lon);
    if (!rc) return json({ error: 'coordinates outside the EASE grid' }, 400);

    const endParam = u.searchParams.get('end');                       // pagination window end
    const end = endParam ? new Date(endParam + 'T23:59:59Z') : new Date();
    if (isNaN(end.getTime())) return json({ error: 'bad ?end= date, want YYYY-MM-DD' }, 400);
    const start = new Date(end.getTime() - days * 864e5);

    // edge cache: historical windows are immutable, current ones refresh every 6 h
    const historical = (Date.now() - end.getTime()) > 2 * 864e5;
    const cacheKey = new Request(u.origin + u.pathname
      + '?lat=' + lat.toFixed(4) + '&lon=' + lon.toFixed(4) + '&days=' + days
      + '&max=' + max + '&loose=' + (loose ? 1 : 0) + '&end=' + end.toISOString().slice(0, 10));
    if (!debug && !probe) {
      const hit = await caches.default.match(cacheKey);
      if (hit) {
        const h = new Response(hit.body, hit);
        h.headers.set('X-Smap-Cache', 'HIT');
        return h;
      }
    }
    const cachePut = async (resp, unhealthy, empty) => {
      const c = resp.clone();
      const cc = new Response(c.body, c);
      cc.headers.set('Cache-Control',
        unhealthy ? 'public, max-age=3600'                    // partial result — let a retry improve it soon
        : (historical && !empty) ? 'public, max-age=2592000'  // an empty answer is never locked in for a month
        : 'public, max-age=21600');
      await caches.default.put(cacheKey, cc);
      return resp;
    };
    // looked up only now, after the edge cache has had its chance — a cache hit costs no login
    let token;
    try { token = await getToken(env, false); }
    catch (e) { return json({ error: e.name === 'AbortError' ? 'Earthdata Login timed out.' : e.message }, 502); }
    const auth = { headers: { Authorization: 'Bearer ' + token } };
    const cmrUrl = CMR + '?short_name=' + SHORT_NAME
      + '&temporal=' + start.toISOString().slice(0, 10) + ',' + end.toISOString().slice(0, 10)
      + '&bounding_box=' + (lon - 0.1) + ',' + (lat - 0.1) + ',' + (lon + 0.1) + ',' + (lat + 0.1)
      + '&page_size=400&sort_key=-start_date';

    let entries;
    try {
      let r = await timedFetch(cmrUrl, auth, 10000);
      if (isAuthFail(r.status) && canRenew(env)) {       // token expired mid-life: fetch a new one, try once more
        auth.headers.Authorization = 'Bearer ' + await getToken(env, true);
        r = await timedFetch(cmrUrl, auth, 10000);
      }
      if (isAuthFail(r.status)) return json({ error: TOKEN_MSG }, 502);          // not cached
      if (!r.ok) return json({ error: 'CMR HTTP ' + r.status, detail: (await r.text()).slice(0, 300) }, 502);
      entries = ((await r.json()).feed || {}).entry || [];
    } catch (e) {
      if (/^Earthdata Login/.test(e.message || '')) return json({ error: e.message }, 502);   // renewal itself failed
      return json({ error: 'CMR failed: ' + (e.name === 'AbortError' ? 'timeout' : e.message) }, 502);
    }
    if (!entries.length) return json({ error: 'no granules for this point/period' }, 404);

    // DEBUG: show the real link structure so the OPeNDAP path can be nailed down
    if (debug) {
      return json({
        debug: true, granules_found: entries.length,
        ease_cell: rc,
        first_granule_title: entries[0].title,
        first_granule_time: entries[0].time_start,
        first_granule_links: (entries[0].links || []).map(l => ({ rel: l.rel, href: l.href })),
        derived_opendap_base: opendapBase(entries[0]),
      });
    }

    // PROBE: the ONLY working format is the DAP4 binary `.dap`. Fetch it as raw bytes and scan
    // for the soil-moisture float directly — this both extracts the value and reveals the layout.
    if (probe) {
      const base = opendapBase(entries[0]);
      if (!base) return json({ probe: true, error: 'no opendap base' });
      const R = rc.row, C = rc.col;
      // request soil_moisture for AM and PM at our cell
      const ceStr = '/Soil_Moisture_Retrieval_Data_AM/soil_moisture[' + R + '][' + C + '];'
                  + '/Soil_Moisture_Retrieval_Data_PM/soil_moisture_pm[' + R + '][' + C + ']';
      let buf;
      try {
        const r = await timedFetch(base + '.dap?dap4.ce=' + encodeURIComponent(ceStr), auth, 25000);
        buf = new Uint8Array(await r.arrayBuffer());
      } catch (e) { return json({ probe: true, error: 'dap fetch failed: ' + e.message }); }

      const dv = new DataView(buf.buffer);
      // locate end of the DMR (XML) so we know where the binary data starts
      const txt = new TextDecoder('latin1').decode(buf);
      const dmrEnd = txt.indexOf('</Dataset>');
      // scan the WHOLE buffer for float32 (both byte orders) that look like soil moisture or fill
      const hits = [];
      for (let o = 0; o + 4 <= buf.length; o++) {
        const le = dv.getFloat32(o, true), be = dv.getFloat32(o, false);
        if (le >= 0 && le <= 1 && Number.isFinite(le)) hits.push({ off: o, order: 'LE', val: +le.toFixed(4) });
        else if (be >= 0 && be <= 1 && Number.isFinite(be)) hits.push({ off: o, order: 'BE', val: +be.toFixed(4) });
        else if (Math.abs(le + 9999) < 1) hits.push({ off: o, order: 'LE', val: -9999 });
        else if (Math.abs(be + 9999) < 1) hits.push({ off: o, order: 'BE', val: -9999 });
      }
      // hex of the last 48 bytes (where the data + checksums sit)
      const tail = [];
      for (let o = Math.max(0, buf.length - 48); o < buf.length; o++) tail.push(buf[o].toString(16).padStart(2, '0'));
      return json({ probe: true, opendap_base: base, ease_cell: rc,
        total_bytes: buf.length, dmr_end_index: dmrEnd,
        bytes_after_dmr: dmrEnd >= 0 ? buf.length - (dmrEnd + 10) : null,
        float_candidates: hits.slice(0, 20),
        tail_hex: tail.join(' ') });
    }

    const chosen = pickEvenly(entries, max);
    const stats = { chosen: chosen.length, kept: 0, flagged: 0, nodata: 0, no_opendap: 0, errors: 0, http: 0, auth: 0 };
    const px = '[' + rc.row + '][' + rc.col + ']';
    // 4 Float32 variables (soil moisture + vegetation water content, AM & PM) via DAP4 BINARY.
    const AM = '/Soil_Moisture_Retrieval_Data_AM/';
    const PM = '/Soil_Moisture_Retrieval_Data_PM/';
    const ce = '.dap?dap4.ce=' + encodeURIComponent(
      AM + 'soil_moisture' + px + ';' + AM + 'vegetation_water_content' + px + ';'
      + PM + 'soil_moisture_pm' + px + ';' + PM + 'vegetation_water_content_pm' + px);

    // fetch every chosen granule IN PARALLEL, each with its own timeout
    const results = await Promise.all(chosen.map(async g => {
      const obase = opendapBase(g);
      if (!obase) { stats.no_opendap++; return null; }
      try {
        const r = await timedBytes(obase + ce, auth, 12000);
        if (isAuthFail(r.status)) { stats.auth++; return null; }
        // the host answered with an error: a failure of NASA's server, NOT "no data here"
        if (!r.ok) { stats.http++; return null; }
        const p = readDap(r.bytes, 4);
        if (!p) { stats.nodata++; return null; }
        if (p.flag) { stats.flagged++; if (!loose) return null; }
        stats.kept++;
        const d = dateOf(g);
        return d ? { date: d, sm_surface: +p.sm.toFixed(4), flagged: p.flag || undefined,
                     vwc: p.vwc != null ? +p.vwc.toFixed(2) : undefined } : null;
      } catch (e) { stats.errors++; return null; }
    }));

    const win = { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
    // The data host refused the token. Without this check the granules would just count as
    // "no data" and an empty answer would be cached for up to 30 days — long after the token
    // had been replaced. Say what is wrong instead, and cache nothing.
    if (stats.auth) {
      memo = { token: null, at: 0 };                  // with automatic renewal, the next call logs in afresh
      return json({ error: TOKEN_MSG, window: win, stats }, 502);
    }
    const obs = results.filter(Boolean).sort((a, b) => a.date < b.date ? -1 : 1);
    if (!obs.length) return cachePut(json({
      error: 'no usable retrievals', window: win, stats,
      hint: (stats.errors + stats.http) ? 'NASA\'s data host timed out or answered with errors — try again later.' : 'No valid pixels for this point/period.'
    }, 200), (stats.errors + stats.http) > 0, true);  // empty because of failures -> 1 h; empty otherwise -> 6 h at most

    const newest = new Date(obs[obs.length - 1].date);
    const unhealthy = (stats.errors + stats.http) * 5 > stats.chosen;   // >20% timeouts or server errors -> don't lock this in for a month
    return cachePut(json({
      product: SHORT_NAME, lat, lon, ease_row: rc.row, ease_col: rc.col,
      qa: loose ? 'loose (flagged kept)' : 'strict',
      window: win,                                        // presence of this field = pagination supported
      lag_days: Math.round((Date.now() - newest.getTime()) / 864e5), stats,
      note: 'SMAP L-band radiometer, 9 km, via OPeNDAP through a Cloudflare Worker.',
      obs,
    }), unhealthy);
  },
};
