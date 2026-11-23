// ==UserScript==
// @name         GeoFS NPC Traffic
// @namespace    geofs-npc-traffic
// @version      0.6.5
// @description  No UI. Fly near an airport and planes are already there: parked at gates, taxiing, and on final approach. Arrivals land, taxi to a gate and park; parked planes push back, taxi out and take off. Layout is scanned from OpenStreetMap.
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      overpass-api.de
// @connect      overpass.kumi.systems
// @connect      lz4.overpass-api.de
// @connect      overpass.private.coffee
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // With @grant the script runs in a sandbox, so the page's own objects are reached through unsafeWindow.
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const geofs = new Proxy({}, {
    get: (_, k) => { const g = W.geofs; if (!g) return undefined; const v = g[k]; return typeof v === 'function' ? v.bind(g) : v; }
  });

  // ---------------------------------------------------------------- config
  const CFG = {
    // Where models.json and the .glb files live (your repo, raw GitHub links). Must end with a slash.
    repoBase: 'https://raw.githubusercontent.com/747400forlife/geofs-npc-traffic/main/',

    // Add more airports later. elev = field elevation in metres (fallback only).
    airports: [
      { icao: 'RKSI', name: 'Incheon', lat: 37.4602, lon: 126.4407, elev: 7, radiusM: 9000,
        // Cargo area, used only if OpenStreetMap has no apron/building named cargo. Centre is the cargo terminal
        // (the airport's published "Cargo Apron 1/2" are next to it). Move it if the MD-11 parks in the wrong place.
        cargoHint: { lat: 37.4582, lon: 126.4764, radiusM: 1800 } }
    ],

    activeRadiusKm: 30,    // traffic exists only while you are this close (like Global Traffic)
    scanEveryS: 3,         // how often the proximity check runs

    parked: 20,            // planes sitting at gates the moment you arrive
    minStandSpacingM: 60,  // keeps parked planes from overlapping
    cargoNearM: 500,       // a stand this close to something named cargo/freight in OpenStreetMap counts as a cargo stand
    arrivals: 2,           // planes already on approach the moment you arrive
    taxiing: 2,            // planes already taxiing in from the runway the moment you arrive
    queued: 2,             // planes already waiting at the runway to take off the moment you arrive
    taxiingOut: 2,         // planes already taxiing out to the runway the moment you arrive
    maxMoving: 4,          // arriving planes (approach/taxi) alive at once; new ones appear as old ones park
    departEveryS: 30,      // a parked plane pushes back, taxis out and takes off this often (lower = more takeoffs)
    maxDepartures: 6,      // departing planes at once (they queue at the runway)

    approachKts: 140,
    taxiKts: 25,
    glideDeg: 3,
    accel: 2.5,            // m/s^2
    holdShortM: 80,        // planes stop this far before a runway when it is in use (takeoff roll or landing)
    takeoffAccel: 3.2,     // m/s^2 during the takeoff roll and climb
    decel: 4,              // m/s^2
    hideBeyondKm: 20       // models are hidden when farther than this from the camera
  };

  const R = 6378137, rad = Math.PI / 180, deg = 180 / Math.PI, kts = 0.514444;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const wrap180 = a => ((a + 540) % 360) - 180;
  const norm360 = a => ((a % 360) + 360) % 360;
  const rand = (a, b) => a + Math.random() * (b - a);
  const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  const log = (...a) => console.log('[NPC Traffic]', ...a);
  const errAt = {};
  function reportError(where, e) {
    const now = performance.now();
    if (errAt[where] && now - errAt[where] < 5000) return;
    errAt[where] = now;
    console.error('[NPC Traffic] error in ' + where + ': ' + (e && e.message ? e.message : e) + '\n' + (e && e.stack ? e.stack : ''));
  }
  const safe = (where, fn) => { try { return fn(); } catch (e) { reportError(where, e); } };

  const toXY = (o, lat, lon) => [(lon - o.lon) * rad * R * Math.cos(o.lat * rad), (lat - o.lat) * rad * R];
  const toLL = (o, x, y) => [o.lat + (y / R) * deg, o.lon + (x / (R * Math.cos(o.lat * rad))) * deg];

  function playerLLA() {
    const i = geofs.aircraft && geofs.aircraft.instance;
    return i && i.llaLocation ? i.llaLocation : null;
  }
  function groundAlt(lat, lon) {
    try {
      const g = geofs.getGroundAltitude(lat, lon);
      if (g && g.location) return g.location[2];
      if (typeof g === 'number') return g;
    } catch (e) {}
    return null;
  }

  // ---------------------------------------------------------------- heap + dijkstra
  class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(d, v) {
      const a = this.a; a.push([d, v]); let i = a.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
    }
    pop() {
      const a = this.a, top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last; let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]]; i = m;
        }
      }
      return top;
    }
  }
  function dijkstra(src) {
    const dist = { [src.k]: 0 }, prev = {}, h = new Heap();
    h.push(0, src);
    while (h.size) {
      const [d, n] = h.pop();
      if (d > dist[n.k]) continue;
      for (const e of n.adj) {
        const nd = d + e.w;
        if (dist[e.to.k] === undefined || nd < dist[e.to.k]) { dist[e.to.k] = nd; prev[e.to.k] = n.k; h.push(nd, e.to); }
      }
    }
    return { dist, prev };
  }

  // ---------------------------------------------------------------- airport scan (OpenStreetMap)
  const airports = CFG.airports.map(c => ({
    cfg: c, o: { lat: c.lat, lon: c.lon }, state: 'idle', populated: false, lastDep: 0,
    runways: [], parks: [], graph: new Map(), rwyNode: new Map(), flow: 0, flowSince: 0
  }));

  const OVERPASS_HOSTS = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];

  // The essential data: runways, taxiways, stands. Also what you can open by hand in a browser tab (see the warning in scanAirport).
  function overpassQuery(c) {
    const ar = '(around:' + c.radiusM + ',' + c.lat + ',' + c.lon + ')';
    return '[out:json][timeout:60];(' +
      'way["aeroway"="runway"]' + ar + ';' +
      'way["aeroway"~"^(taxiway|taxilane)$"]' + ar + ';' +
      'node["aeroway"~"^(parking_position|gate)$"]' + ar + ';' +
      'way["aeroway"="parking_position"]' + ar + ';' +
      ');out geom;';
  }
  // Optional extra, asked for separately so that a slow answer can never spoil the essential data
  function cargoQuery(c) {
    const ar = '(around:' + c.radiusM + ',' + c.lat + ',' + c.lon + ')';
    return '[out:json][timeout:25];(' +
      'way["aeroway"="apron"]["name"~"cargo|freight",i]' + ar + ';' +
      ');out geom;' +
      '(nwr["name"~"cargo|freight",i]' + ar + ';);out center;';
  }

  // An answer only counts if it really contains an airport: a runway, a taxiway and a stand.
  // (Overpass answers "HTTP 200, no elements" when it is overloaded or the query times out.)
  function validOsm(j) {
    if (!j || !Array.isArray(j.elements)) throw new Error('answer had no data' + (j && j.remark ? ' (' + j.remark + ')' : ''));
    const has = f => j.elements.some(e => e.tags && f(e.tags.aeroway));
    if (!has(a => a === 'runway') || !has(a => a === 'taxiway' || a === 'taxilane') || !has(a => a === 'parking_position' || a === 'gate'))
      throw new Error('answer was empty or incomplete' + (j.remark ? ' (' + j.remark + ')' : ''));
    return j;
  }
  const anyElements = j => { if (!j || !Array.isArray(j.elements)) throw new Error('answer had no data'); return j; };

  // Tampermonkey's own request: no CORS rules, so this is the one most likely to work
  function gmRequest(url, method, body, timeout) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('GM_xmlhttpRequest not available'));
      GM_xmlhttpRequest({
        method, url, data: body, timeout: timeout || 90000,
        onload: r => {
          if (r.status < 200 || r.status >= 300) return reject(new Error('HTTP ' + r.status));
          try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error('answer was not JSON')); }
        },
        onerror: () => reject(new Error('request blocked or failed (allow the domain if Tampermonkey asked)')),
        ontimeout: () => reject(new Error('timed out'))
      });
    });
  }

  // tries every server and method until one gives an answer that passes `check`
  async function overpass(q, check, quick) {
    const errs = [], hosts = quick ? OVERPASS_HOSTS.slice(0, 2) : OVERPASS_HOSTS, name = h => h.replace('https://', '').split('/')[0];
    const modes = quick ? ['GET'] : ['GET', 'POST'];
    if (typeof GM_xmlhttpRequest === 'function') {
      for (const h of hosts) for (const mode of modes) {
        try { return check(await (mode === 'GET' ? gmRequest(h + '?data=' + encodeURIComponent(q), 'GET', undefined, quick ? 25000 : 90000) : gmRequest(h, 'POST', q))); }
        catch (e) { errs.push('GM ' + name(h) + ' ' + mode + ' ' + e.message); }
      }
    }
    for (const h of hosts) for (const mode of modes) {
      try {
        // plain GET, or a POST with a text body: neither triggers a CORS preflight
        const r = mode === 'GET' ? await fetch(h + '?data=' + encodeURIComponent(q)) : await fetch(h, { method: 'POST', body: q });
        if (!r.ok) { errs.push(name(h) + ' ' + mode + ' HTTP ' + r.status); continue; }
        return check(await r.json());
      } catch (e) { errs.push(name(h) + ' ' + mode + ' ' + e.message); }
    }
    throw new Error(errs.join(' | '));
  }

  const CARGO_RE = /cargo|freight|화물/i;

  function compactify(o, data) {
    const rw = {}, taxi = [], parks = [], cargoPoly = [], cargoPts = [];
    const r1 = v => Math.round(v * 10) / 10;
    const cen = pts => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    for (const el of data.elements || []) {
      const tags = el.tags || {}, aw = tags.aeroway;
      const named = CARGO_RE.test((tags.name || '') + ' ' + (tags.ref || '') + ' ' + (tags['name:en'] || ''));
      if (el.type === 'way' && el.geometry) {
        const pts = el.geometry.map(g => toXY(o, g.lat, g.lon)).map(p => [r1(p[0]), r1(p[1])]);
        if (aw === 'runway') { const ref = tags.ref || ('id' + el.id); (rw[ref] = rw[ref] || []).push(...pts); }
        else if (aw === 'taxiway' || aw === 'taxilane') taxi.push(pts);
        else if (aw === 'parking_position' || aw === 'gate') { const c = cen(pts); parks.push([c[0], c[1], named ? 1 : 0]); }
        else if (aw === 'apron' && named && pts.length > 2) cargoPoly.push(pts);
        if (named && aw !== 'runway' && aw !== 'taxiway' && aw !== 'taxilane' && aw !== 'apron') cargoPts.push(cen(pts).map(r1));
      } else if (el.type === 'node' && el.lat != null && (aw === 'parking_position' || aw === 'gate')) {
        const c = toXY(o, el.lat, el.lon); parks.push([c[0], c[1], named ? 1 : 0]);
        if (named) cargoPts.push(c.map(r1));
      } else if (named && (el.center || el.lat != null)) {                  // anything else named cargo (buildings, terminals)
        const c = toXY(o, el.center ? el.center.lat : el.lat, el.center ? el.center.lon : el.lon); cargoPts.push(c.map(r1));
      }
    }
    return { rw, taxi, parks, cargoPoly, cargoPts };
  }

  const snapKey = (x, y) => Math.round(x / 3) + ',' + Math.round(y / 3);

  function buildAirport(ap, c) {
    ap.graph = new Map(); ap.runways = []; ap.parks = [];
    const getNode = (x, y) => {
      const k = snapKey(x, y); let n = ap.graph.get(k);
      if (!n) { n = { k, x, y, adj: [] }; ap.graph.set(k, n); }
      return n;
    };
    for (const pts of c.taxi) {
      let prev = null;
      for (const p of pts) {
        const n = getNode(p[0], p[1]);
        if (prev && prev !== n) {
          const w = Math.hypot(n.x - prev.x, n.y - prev.y);
          prev.adj.push({ to: n, w }); n.adj.push({ to: prev, w });
        }
        prev = n;
      }
    }
    const far = (p, pts) => pts.reduce((b, q) => (Math.hypot(q[0] - p[0], q[1] - p[1]) > Math.hypot(b[0] - p[0], b[1] - p[1]) ? q : b), pts[0]);
    for (const ref of Object.keys(c.rw)) {
      const pts = c.rw[ref];
      const b = far(pts[0], pts), a = far(b, pts);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 600) continue;
      ap.runways.push({ ref, A: { x: a[0], y: a[1] }, B: { x: b[0], y: b[1] }, len, junctions: [], arr: new Set(), dep: null, waiting: new Set(), crossing: new Set(), role: 'both' });
    }
    // taxiway nodes sitting on a runway centreline are the exits/crossings
    for (const r of ap.runways) {
      const ux = (r.B.x - r.A.x) / r.len, uy = (r.B.y - r.A.y) / r.len;
      for (const n of ap.graph.values()) {
        const dx = n.x - r.A.x, dy = n.y - r.A.y;
        const s = dx * ux + dy * uy, l = dx * uy - dy * ux;
        if (s > 50 && s < r.len - 50 && Math.abs(l) < 40 && n.adj.length) r.junctions.push({ n, s });
      }
    }
    ap.rwyNode = new Map();                                // taxi node key -> the runway it sits on
    ap.runways.forEach(r => r.junctions.forEach(j => ap.rwyNode.set(j.n.k, r)));
    // attach every stand to the closest taxi node
    const nodes = Array.from(ap.graph.values());
    for (const p of c.parks) {
      let best = null, bd = 150;
      for (const n of nodes) { const d = Math.hypot(n.x - p[0], n.y - p[1]); if (d < bd) { bd = d; best = n; } }
      if (best) ap.parks.push({ x: p[0], y: p[1], att: best, taken: false, cargo: false });
    }
    // cargo stands: named cargo themselves, inside a cargo-named apron, or next to something named cargo
    const inPoly = (x, y, poly) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const flagged = new Set(c.parks.filter(q => q[2]).map(q => q[0] + ',' + q[1]));
    ap.parks.forEach(p => {
      p.cargo = flagged.has(p.x + ',' + p.y) || (c.cargoPoly || []).some(poly => inPoly(p.x, p.y, poly));
    });
    if (!ap.parks.some(p => p.cargo)) {                                         // nothing exact: stands next to something named cargo
      ap.parks.forEach(p => { p.cargo = (c.cargoPts || []).some(q => Math.hypot(q[0] - p.x, q[1] - p.y) < CFG.cargoNearM); });
    }
    ap.cargoSource = ap.parks.some(p => p.cargo) ? 'OpenStreetMap' : null;
    if (!ap.cargoSource && ap.cfg.cargoHint) {                                  // nothing named cargo mapped: use the configured area
      const h = ap.cfg.cargoHint, hc = toXY(ap.o, h.lat, h.lon);
      ap.parks.forEach(p => { p.cargo = Math.hypot(p.x - hc[0], p.y - hc[1]) < h.radiusM; });
      if (ap.parks.some(p => p.cargo)) ap.cargoSource = 'cargoHint';
    }
    ap.hasCargo = ap.parks.some(p => p.cargo);
    if (ap.runways.length) {
      const r0 = ap.runways[0];
      const h = norm360(Math.atan2(r0.B.x - r0.A.x, r0.B.y - r0.A.y) * deg);
      ap.flow = Math.random() < 0.5 ? h : norm360(h + 180);
      ap.flowSince = performance.now();
      assignRoles(ap);
    }
  }

  // runways pointing along the active flow; with two or more, alternate them between arrivals and departures
  function assignRoles(ap) {
    const m = ap.runways.filter(r => [r.A, r.B].some((e, i) => {
      const o = i === 0 ? r.B : r.A, hdg = norm360(Math.atan2(o.x - e.x, o.y - e.y) * deg);
      return Math.abs(wrap180(hdg - ap.flow)) <= 35;
    }));
    ap.runways.forEach(r => { r.role = 'both'; });
    if (m.length >= 2) m.forEach((r, i) => { r.role = i % 2 ? 'dep' : 'arr'; });
  }

  // airport_RKSI.json from the repo if there is one, otherwise OpenStreetMap
  async function fetchAirportData(ap) {
    let data = null;
    try {
      const r = await fetch(CFG.repoBase + 'airport_' + ap.cfg.icao + '.json?t=' + Date.now());
      if (r.ok) { data = validOsm(await r.json()); log('Using airport_' + ap.cfg.icao + '.json from the repo'); }
    } catch (e) { data = null; /* not there, or not usable: fine */ }
    if (!data) {
      data = await overpass(overpassQuery(ap.cfg), validOsm);
      try {                                                    // cargo info is a bonus, never worth failing for
        const extra = await overpass(cargoQuery(ap.cfg), anyElements, true);
        data = { elements: data.elements.concat(extra.elements) };
      } catch (e) { log('Cargo lookup skipped (' + e.message.slice(0, 80) + '); the cargoHint area is used instead'); }
    }
    return data;
  }

  function loadFailedHelp(ap, e) {
    const q = overpassQuery(ap.cfg);
    console.warn('[NPC Traffic] Could not load ' + ap.cfg.icao + ' from OpenStreetMap: ' + e.message + '\n' +
      'Fix: open this link in a new browser tab, save the page as airport_' + ap.cfg.icao + '.json, and upload it to your repo next to models.json:\n' +
      OVERPASS_HOSTS[0] + '?data=' + encodeURIComponent(q) + '\n(or, same thing: ' + OVERPASS_HOSTS[1] + '?data=' + encodeURIComponent(q) + ')');
  }

  // saved/loaded data is only used if it holds a runway, a taxiway and a stand
  const validCompact = c => !!(c && c.rw && Object.keys(c.rw).length && c.taxi && c.taxi.length && c.parks && c.parks.length);

  async function scanAirport(ap) {
    ap.state = 'scanning';
    const ck = 'geofsNpcScan_' + ap.cfg.icao + '_v2', oldKey = 'geofsNpcScan_' + ap.cfg.icao + '_v1';
    const readCache = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
    const dropCache = k => { try { localStorage.removeItem(k); } catch (e) {} };
    let compact = readCache(ck), fromOld = false;
    if (compact && !validCompact(compact)) { log('Saved ' + ap.cfg.icao + ' data was empty or incomplete, throwing it away'); dropCache(ck); compact = null; }
    if (!compact) {                                            // data saved by an earlier version of this script still works
      const old = readCache(oldKey);
      if (validCompact(old)) { compact = old; fromOld = true; log('Using the airport data your browser saved earlier (no cargo info); refreshing it in the background'); }
    }
    if (!compact) {
      log('Loading ' + ap.cfg.icao + ' (first run only, then cached)...');
      try {
        compact = compactify(ap.o, await fetchAirportData(ap));
        if (!validCompact(compact)) throw new Error('the data held no runway, taxiway or stand');
        try { localStorage.setItem(ck, JSON.stringify(compact)); } catch (e) { /* too big, skip cache */ }
      } catch (e) {
        ap.state = 'failed'; ap.tries = (ap.tries || 0) + 1;
        loadFailedHelp(ap, e);
        if (ap.tries < 3) setTimeout(() => { if (ap.state === 'failed' && !ap.parks.length) ap.state = 'idle'; }, 120000);   // try again in 2 minutes
        return;
      }
    }
    buildAirport(ap, compact);
    ap.state = ap.runways.length && ap.parks.length ? 'ready' : 'failed';
    log(ap.cfg.icao + ': ' + ap.runways.length + ' runways, ' + ap.graph.size + ' taxi nodes, ' + ap.parks.length + ' stands (' + ap.parks.filter(p => p.cargo).length + ' cargo' + (ap.cargoSource ? ', from ' + ap.cargoSource : ', none found') + ')' +
      (ap.state === 'failed' ? ' (not enough data to run traffic)' : ''));
    if (ap.state === 'failed') {                               // never keep data that does not work
      dropCache(ck); ap.tries = (ap.tries || 0) + 1;
      if (ap.tries < 3) setTimeout(() => { if (ap.state === 'failed') ap.state = 'idle'; }, 5000);
      return;
    }
    if (fromOld) {                                             // fetch the new data (with cargo info) for next time, planes keep running meanwhile
      fetchAirportData(ap)
        .then(d => { const c2 = compactify(ap.o, d); if (!validCompact(c2)) throw new Error('refresh gave no usable data'); localStorage.setItem(ck, JSON.stringify(c2)); log('Fresh ' + ap.cfg.icao + ' data saved; it is used from the next reload'); })
        .catch(e => loadFailedHelp(ap, e));
    }
  }

  // ---------------------------------------------------------------- models
  let models = [];
  async function loadModels() {
    try {
      const r = await fetch(CFG.repoBase + 'models.json?t=' + Date.now());
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      models = (j.models || []).map(m => ({
        name: m.name, url: new URL(m.url, CFG.repoBase).href, scale: m.scale || 1,
        hOff: m.headingOffset || 0, pOff: m.pitchOffset || 0, rOff: m.rollOffset || 0, off: m.altOffset || 0,
        max: m.maxCount || 0,                                  // 0 = no limit on how many of this plane at once
        min: m.minCount || 0,                                  // keep at least this many of this plane around
        cargo: !!m.cargo,                                      // true = parks and taxis in the cargo area only
        weight: m.weight != null ? m.weight : 1                // relative chance of being picked (default 1)
      }));
      log(models.length + ' model(s): ' + models.map(m => m.name).join(', '));
      for (const m of models) {
        fetch(m.url, { method: 'HEAD' })
          .then(r => { if (!r.ok) console.warn('[NPC Traffic] Model file not found (HTTP ' + r.status + '): ' + m.url); })
          .catch(e => console.warn('[NPC Traffic] Model file blocked/unreachable: ' + m.url + ' (' + e.message + ')'));
      }
    } catch (e) { console.warn('[NPC Traffic] Could not load models.json from ' + CFG.repoBase + ' (' + e.message + ')'); }
  }
  // cargo planes use cargo stands and everyone else stays out of them (only when the airport has a cargo area)
  const standOk = (ap, p, m) => !ap.hasCargo || !m || !!m.cargo === !!p.cargo;

  // weighted random pick that respects each model's maxCount (e.g. only one MD-11 at a time)
  function pickModel() {
    const live = {};
    npcs.forEach(n => { live[n.m.name] = (live[n.m.name] || 0) + 1; });
    let pool = models.filter(m => !m.max || (live[m.name] || 0) < m.max);
    if (!pool.length) pool = models.filter(m => !m.max);
    if (!pool.length) pool = models;
    let r = Math.random() * pool.reduce((t, m) => t + m.weight, 0);
    for (const m of pool) { r -= m.weight; if (r <= 0) return m; }
    return pool[pool.length - 1];
  }

  // ---------------------------------------------------------------- npc rendering (Cesium entities)
  const npcs = [];

  function viewer() { return geofs.api && geofs.api.viewer; }

  function render(n) {
    const C = W.Cesium, v = viewer();
    if (!C || !v) return;
    const ll = toLL(n.ap.o, n.x, n.y);
    const alt = n.gElev + n.m.off + n.agl;
    const pos = C.Cartesian3.fromDegrees(ll[1], ll[0], alt);
    // Cesium heading 0 points east, so compass heading h becomes h - 90
    const hpr = new C.HeadingPitchRoll(((n.hdg + n.m.hOff) - 90) * rad, (n.pitch + n.m.pOff) * rad, (n.roll + n.m.rOff) * rad);
    const q = C.Transforms.headingPitchRollQuaternion(pos, hpr);
    if (!n.ent) {
      try {
      n.ent = v.entities.add({
        position: pos, orientation: q,
        model: {
          uri: n.m.url, scale: n.m.scale, runAnimations: false,
          shadows: C.ShadowMode.ENABLED,
          distanceDisplayCondition: new C.DistanceDisplayCondition(0, CFG.hideBeyondKm * 1000)
        }
      });
      } catch (e) { if (!render.warned) { render.warned = true; console.warn('[NPC Traffic] Could not create a model entity:', e); } }
    } else {
      n.ent.position = pos; n.ent.orientation = q;
    }
  }

  function destroy(n) {
    if (n.rwy) n.rwy.arr.delete(n);
    n.rwy = null;
    if (n.crossRwy) { n.crossRwy.crossing.delete(n); n.crossRwy = null; }
    if (n.depRwy) { n.depRwy.waiting.delete(n); if (n.depRwy.dep === n) n.depRwy.dep = null; n.depRwy = null; }
    if (n.gate) n.gate.taken = false;
    try { viewer().entities.remove(n.ent); } catch (e) {}
    const k = npcs.indexOf(n); if (k >= 0) npcs.splice(k, 1);
  }

  // ---------------------------------------------------------------- planning an arrival
  const alongRunway = n => (n.x - n.thr.x) * n.dir.x + (n.y - n.thr.y) * n.dir.y;

  // a plane may enter the runway to depart only if nothing is on it or within 4 km of landing
  function depClear(r) {
    if (r.dep || r.crossing.size) return false;
    for (const a of r.arr) if (alongRunway(a) > -4000) return false;
    return true;
  }

  function runwayFreeAt(r, s0) {
    // a departure is holding short: keep arrivals off (on a shared runway, still let one in every ~3 minutes)
    if (r.waiting.size && !(r.role === 'both' && performance.now() - (r.lastArr || 0) > 200000)) return false;
    if (r.dep && s0 > -6000) return false;
    for (const a of r.arr) {
      const sa = alongRunway(a);
      if (Math.abs(sa - s0) < 4500) return false;
      if (sa >= 0 && s0 > -3500) return false;
    }
    return true;
  }

  // Taxi routes that run over a runway get a hold-short point `holdShortM` before it. The plane waits there
  // until the runway is clear (no takeoff roll, nobody crossing, no landing within 4 km).
  function addCrossingHolds(ap, route, from, to, ownRwy) {
    let inside = null;
    for (let i = from; i < to; i++) {
      const rr = route[i].k !== undefined ? ap.rwyNode.get(route[i].k) : null;
      if (!rr) { inside = null; continue; }
      if (inside === rr) continue;
      inside = rr;
      if (i === from && rr === ownRwy) continue;                 // the exit we just took
      let h = i, back = 0;
      while (h > from && back < CFG.holdShortM) {
        back += Math.hypot(route[h].x - route[h - 1].x, route[h].y - route[h - 1].y); h--;
      }
      if (route[h].ph !== 'taxi') continue;
      let e = i; while (e + 1 < to && ap.rwyNode.get(route[e + 1].k) === rr) e++;
      Object.assign(route[h], { ph: 'xhold', xr: rr, xEnd: e, spd: 5 });
    }
  }

  function planArrival(ap, startS, model) {
    const gs = Math.tan(CFG.glideDeg * rad), td = 300, ak = CFG.approachKts, tk = CFG.taxiKts;

    // keep the active direction for a while, flip it now and then when nobody is landing
    if (performance.now() - ap.flowSince > 20 * 60 * 1000 && !npcs.some(n => n.rwy || n.depRwy)) {
      ap.flow = norm360(ap.flow + 180); ap.flowSince = performance.now(); assignRoles(ap);
    }

    const cands = [];
    for (const r of ap.runways) {
      if (r.role === 'dep' || !runwayFreeAt(r, startS)) continue;
      for (const onA of [true, false]) {
        const thr = onA ? r.A : r.B, farEnd = onA ? r.B : r.A;
        const hdg = norm360(Math.atan2(farEnd.x - thr.x, farEnd.y - thr.y) * deg);
        if (Math.abs(wrap180(hdg - ap.flow)) <= 35) cands.push({ r, onA, thr, farEnd, hdg });
      }
    }
    shuffle(cands);

    for (const c of cands) {
      const { r, onA, thr, farEnd, hdg } = c;
      const dir = { x: (farEnd.x - thr.x) / r.len, y: (farEnd.y - thr.y) / r.len };
      const exits = shuffle(r.junctions.map(j => ({ j, s: onA ? j.s : r.len - j.s }))
        .filter(e => e.s >= 900 && e.s <= r.len - 300));
      exits.sort((p, q) => (p.s >= 1500 ? 0 : 1) - (q.s >= 1500 ? 0 : 1));

      for (const e of exits.slice(0, 5)) {
        const { dist, prev } = dijkstra(e.j.n);
        const opts = ap.parks.filter(p => !p.taken && dist[p.att.k] !== undefined && standOk(ap, p, model));
        if (!opts.length) continue;
        const gate = opts[Math.floor(Math.random() * opts.length)];

        const path = []; let k = gate.att.k;
        while (k !== undefined) { path.push(ap.graph.get(k)); k = prev[k]; }
        path.reverse();

        const N = (s, agl, spd, ph) => ({ x: thr.x + dir.x * s, y: thr.y + dir.y * s, s, agl, spd, ph });
        const route = [
          N(-9000, gs * (9000 + td), ak, 'approach'),
          N(-4000, gs * (4000 + td), ak, 'approach'),
          N(-1000, gs * (1000 + td), ak - 5, 'approach'),
          N(0, gs * td, ak - 8, 'approach'),
          N(td, 0, ak - 10, 'flare'),
          N(Math.max(td + 300, e.s - 100), 0, 28, 'rollout')
        ];
        const relIdx = route.length;                     // first taxi node (the exit)
        path.forEach((n, idx) => {
          let spd = tk;
          if (idx > 0 && idx < path.length - 1) {
            const a = Math.atan2(n.x - path[idx - 1].x, n.y - path[idx - 1].y) * deg;
            const b = Math.atan2(path[idx + 1].x - n.x, path[idx + 1].y - n.y) * deg;
            if (Math.abs(wrap180(b - a)) > 35) spd = 8;
          }
          route.push({ x: n.x, y: n.y, k: n.k, agl: 0, spd: idx === 0 ? 14 : spd, ph: 'taxi' });
        });
        route.push({ x: gate.x, y: gate.y, agl: 0, spd: 3, ph: 'park' });
        addCrossingHolds(ap, route, relIdx, route.length - 1, r);
        return { route, r, gate, relIdx, hdg, thr, dir };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- spawning
  let npcSeq = 0;
  function newNpc(ap, extra) {
    return Object.assign({
      id: ++npcSeq, ap, m: pickModel(), pitch: 0, roll: 0, prevAgl: 0, wait: 0, seg: null,
      gElev: ap.cfg.elev, gT: 0, gOK: false, rwy: null, gate: null
    }, extra);
  }

  function startSeg(n) {
    const w = n.route[n.i];
    n.seg = { agl0: n.agl, d0: Math.max(1, Math.hypot(w.x - n.x, w.y - n.y)), x0: n.x, y0: n.y };
    n.spin = 0; n.wpT = 0; n.wpBest = n.seg.d0;
  }

  // opts.startS: metres before the threshold to appear on final (default 9 km out)
  // opts.midTaxi: appear already taxiing somewhere along the taxi route
  function spawnArrival(ap, opts) {
    opts = opts || {};
    if (!models.length) return false;
    const startS = opts.startS != null ? opts.startS : -9000;
    const model = opts.model || pickModel();
    const plan = planArrival(ap, startS, model);
    if (!plan) return false;
    const route = plan.route, gs = Math.tan(CFG.glideDeg * rad);
    const extra = { kind: 'arr', route, relIdx: plan.relIdx, gate: plan.gate, thr: plan.thr, dir: plan.dir };
    extra.m = model;
    const n = newNpc(ap, extra);

    if (opts.midTaxi) {
      const lo = plan.relIdx + 1, hi = route.length - 2;
      if (hi < lo) return false;
      const idx = lo + Math.floor(Math.random() * (hi - lo + 1)), w = route[idx], nx = route[idx + 1];
      Object.assign(n, { x: w.x, y: w.y, agl: 0, i: idx + 1, phase: 'taxi', v: CFG.taxiKts * kts,
        hdg: norm360(Math.atan2(nx.x - w.x, nx.y - w.y) * deg) });
    } else {
      const i0 = route.findIndex(w => w.s !== undefined && w.s > startS);
      Object.assign(n, {
        x: plan.thr.x + plan.dir.x * startS, y: plan.thr.y + plan.dir.y * startS,
        agl: gs * (-startS + 300), i: i0, phase: 'approach', v: CFG.approachKts * kts, hdg: plan.hdg
      });
      n.rwy = plan.r; plan.r.arr.add(n); plan.r.lastArr = performance.now();
    }
    n.prevAgl = n.agl;
    plan.gate.taken = true;
    startSeg(n); render(n); npcs.push(n);
    return true;
  }

  // adds up to `count` parked planes at free stands; stands closer than minDist to the player are skipped
  function addParked(ap, count, minDist, px, py, model) {
    const taken = npcs.filter(n => n.ap === ap && n.phase === 'park');
    for (let k = 0; k < count; k++) {
      const m = model || pickModel();
      const p = shuffle(ap.parks.filter(q => !q.taken && standOk(ap, q, m))).find(q =>
        (!minDist || Math.hypot(q.x - px, q.y - py) >= minDist) &&
        !taken.some(t => Math.hypot(t.x - q.x, t.y - q.y) < CFG.minStandSpacingM));
      if (!p) continue;
      const dx = p.x - p.att.x, dy = p.y - p.att.y;
      let hdg;
      if (Math.hypot(dx, dy) > 6) hdg = Math.atan2(dx, dy) * deg;                  // nose toward the stand
      else if (p.att.adj.length) { const e = p.att.adj[0].to; hdg = Math.atan2(e.x - p.att.x, e.y - p.att.y) * deg; }
      else hdg = rand(0, 360);
      const n = newNpc(ap, { m, x: p.x, y: p.y, agl: 0, hdg: norm360(hdg), phase: 'park', isStatic: true, gate: p });
      p.taken = true;
      render(n); npcs.push(n); taken.push(n);
    }
  }
  const spawnParked = ap => addParked(ap, CFG.parked, 0);

  const arrivalCount = () => npcs.filter(n => n.kind === 'arr' && n.phase !== 'park').length;
  const departureCount = () => npcs.filter(n => n.kind === 'dep').length;

  // models with minCount (e.g. four Jeju Air 737s): top up to that number. At arrival all at once, later one per check.
  function fillMinimums(ap, instant, px, py) {
    for (const m of models) {
      const live = npcs.filter(n => n.m === m).length;
      if (!m.min || live >= m.min) continue;
      if (instant) addParked(ap, m.min - live, 0, 0, 0, m);
      else {
        if (!spawnArrival(ap, { model: m })) addParked(ap, 1, 2000, px, py, m);   // arrivals first, else out of sight
        break;                                                                     // one per check keeps arrivals spaced out
      }
    }
  }

  // everything appears at once, no waiting
  function populate(ap) {
    safe('populate: parked planes', () => spawnParked(ap));
    safe('populate: minimum counts', () => fillMinimums(ap, true));
    for (let k = 0; k < CFG.arrivals; k++) safe('populate: arrivals', () => spawnArrival(ap, { startS: -rand(4500, 9000) }));
    for (let k = 0; k < CFG.taxiing; k++) safe('populate: taxiing in', () => spawnArrival(ap, { midTaxi: true }));
    for (let k = 0; k < CFG.queued; k++) safe('populate: queued departures', () => startDeparture(ap, 'hold'));
    for (let k = 0; k < CFG.taxiingOut; k++) safe('populate: taxiing out', () => startDeparture(ap, 'taxi'));
    ap.lastDep = performance.now() - (CFG.departEveryS - 6) * 1000;   // first takeoff within seconds
    log(ap.cfg.icao + ' populated: ' + npcs.filter(n => n.ap === ap).length + ' planes');
  }

  function clearAirport(ap) {
    npcs.filter(n => n.ap === ap).forEach(destroy);
    ap.runways.forEach(r => { r.arr.clear(); r.waiting.clear(); r.crossing.clear(); r.dep = null; });
    ap.parks.forEach(p => { p.taken = false; });
  }


  // ---------------------------------------------------------------- departures
  function planDeparture(ap, gate, usedHolds) {
    const tk = CFG.taxiKts, cands = [];
    for (const r of ap.runways) {
      if (r.role === 'arr') continue;
      for (const onA of [true, false]) {
        const thr = onA ? r.A : r.B, farEnd = onA ? r.B : r.A;
        const hdg = norm360(Math.atan2(farEnd.x - thr.x, farEnd.y - thr.y) * deg);
        if (Math.abs(wrap180(hdg - ap.flow)) <= 35) cands.push({ r, onA, thr, farEnd });
      }
    }
    shuffle(cands);
    const { dist, prev } = dijkstra(gate.att);
    for (const c of cands) {
      const { r, onA, thr, farEnd } = c;
      const queued = k => usedHolds.get(k) || 0;
      const js = r.junctions.map(j => ({ j, s: onA ? j.s : r.len - j.s }))
        .filter(e => e.s >= 50 && e.s <= 1200 && dist[e.j.n.k] !== undefined && queued(e.j.n.k) < 4);
      if (!js.length) continue;
      js.sort((p, q) => (dist[p.j.n.k] + queued(p.j.n.k) * 400) - (dist[q.j.n.k] + queued(q.j.n.k) * 400));   // prefer a free entry
      const e = js[0];
      const dir = { x: (farEnd.x - thr.x) / r.len, y: (farEnd.y - thr.y) / r.len };
      const P = (s, agl, spd, ph) => ({ x: thr.x + dir.x * s, y: thr.y + dir.y * s, s, agl, spd, ph });

      const path = []; let k = e.j.n.k;
      while (k !== undefined) { path.push(ap.graph.get(k)); k = prev[k]; }
      path.reverse();                                    // stand's taxi node ... runway entry

      // the first plane holds 80 m short of the runway, the next ones 90 m, 180 m... further back along the taxiway
      let holdIdx = path.length - 1, back = 0;
      const need = CFG.holdShortM + queued(e.j.n.k) * 90;
      while (holdIdx > 0 && back < need) {
        back += Math.hypot(path[holdIdx].x - path[holdIdx - 1].x, path[holdIdx].y - path[holdIdx - 1].y); holdIdx--;
      }
      const route = [];
      path.forEach((n, idx) => {
        const last = idx === path.length - 1;
        let spd = tk;
        if (idx > 0 && !last) {
          const a = Math.atan2(n.x - path[idx - 1].x, n.y - path[idx - 1].y) * deg;
          const b = Math.atan2(path[idx + 1].x - n.x, path[idx + 1].y - n.y) * deg;
          if (Math.abs(wrap180(b - a)) > 35) spd = 8;
        }
        if (last) spd = 8;
        if (idx === 0) spd = 14;
        if (idx === holdIdx) spd = 5;
        route.push({ x: n.x, y: n.y, k: n.k, agl: 0, spd, ph: idx === holdIdx ? 'hold' : 'taxi' });
      });
      addCrossingHolds(ap, route, 0, holdIdx, r);
      const sL = e.s + 80, sT = sL + 0.6 * (r.len - sL);
      route.push(P(sL, 0, 8, 'lineup'), P(sT, 0, 150, 'takeoff'),
        P(r.len + 300, 20, 160, 'climb'), P(r.len + 3500, 350, 185, 'climb'), P(r.len + 9000, 900, 210, 'climb'));
      return { route, r, holdKey: e.j.n.k, holdIdx };
    }
    return null;
  }

  // sends one parked plane (from the initial fill or an earlier arrival) out to the runway
  // mode: undefined = leave the stand now, 'hold' = appear already waiting at the runway, 'taxi' = appear mid-taxi
  function startDeparture(ap, mode) {
    const parked = shuffle(npcs.filter(n => n.ap === ap && n.phase === 'park' && n.gate));
    parked.sort((a, b) => (b.m.max ? 1 : 0) - (a.m.max ? 1 : 0));            // limited models (one at a time) go first
    const used = new Map();                                                    // how many planes already wait at each runway entry
    npcs.forEach(n => { if (n.holdKey) used.set(n.holdKey, (used.get(n.holdKey) || 0) + 1); });
    for (const n of parked.slice(0, 6)) {
      const plan = planDeparture(ap, n.gate, used);
      if (!plan) continue;
      n.gate.taken = false; n.gate = null;
      Object.assign(n, { route: plan.route, i: 0, phase: 'taxi', isStatic: false, kind: 'dep', depRwy: plan.r, holdKey: plan.holdKey,
        holdDone: false, holdWait: false, v: 0, gT: 0 });
      const first = n.route[0], nx = n.route[1] || first;
      if (mode === 'hold' || mode === 'taxi') {
        const hi = plan.holdIdx;
        const idx = mode === 'hold' ? hi : Math.max(0, Math.floor(Math.random() * Math.max(1, hi)));
        const w = n.route[idx], nw = n.route[Math.min(idx + 1, n.route.length - 1)];
        Object.assign(n, { x: w.x, y: w.y, hdg: norm360(Math.atan2(nw.x - w.x, nw.y - w.y) * deg), agl: 0, prevAgl: 0 });
        if (mode === 'hold') {
          n.i = idx; n.holdDone = true; n.holdWait = true; n.v = 0; n.depRwy.waiting.add(n);
        } else { n.i = Math.min(idx + 1, n.route.length - 1); n.v = CFG.taxiKts * kts; }
        n.phase = n.route[n.i].ph;
      } else {
        n.push = {
          left: Math.min(Math.hypot(first.x - n.x, first.y - n.y), 45),          // short pushback
          hdg: norm360(Math.atan2(nx.x - first.x, nx.y - first.y) * deg)
        };
      }
      startSeg(n);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- movement
  function step(n, dt) {
    if (!isFinite(n.x + n.y + n.hdg + n.v)) { destroy(n); return; }            // never keep a plane with broken numbers
    if (n.phase === 'park') { n.v = Math.max(0, n.v - CFG.decel * dt); return; }   // stays until sent out to depart

    if (n.push) {                                           // pushback: reverse while turning toward the taxiway
      const sp = 2;
      n.x -= Math.sin(n.hdg * rad) * sp * dt; n.y -= Math.cos(n.hdg * rad) * sp * dt;
      n.push.left -= sp * dt;
      n.hdg = norm360(n.hdg + clamp(wrap180(n.push.hdg - n.hdg), -6 * dt, 6 * dt));
      n.v = 0;
      if (n.push.left <= 0) n.push = null;
      return;
    }
    if (n.holdWait) {                                       // holding short until the runway is clear
      if (!depClear(n.depRwy)) { n.v = 0; return; }
      n.holdWait = false; n.holdKey = null; n.depRwy.waiting.delete(n); n.depRwy.dep = n;
      n.i++; n.phase = n.route[n.i].ph; startSeg(n);
    }
    if (n.xWait) {                                          // holding short of a runway it has to cross
      const w0 = n.route[n.i];
      if (!depClear(w0.xr)) { n.v = 0; return; }
      n.xWait = false; startCrossing(n, w0);
      n.i++; n.phase = n.route[n.i].ph; startSeg(n);
    }
    const w = n.route[n.i];
    const dx = w.x - n.x, dy = w.y - n.y;
    const air = n.agl > 2;

    const want = Math.atan2(dx, dy) * deg;
    const herr = Math.abs(wrap180(want - n.hdg));
    let target = w.spd * kts;
    if (!air && herr > 25 && w.ph !== 'takeoff') target = Math.min(target, 3.5);     // slow down for sharp turns so the turn circle stays small
    const a = target > n.v ? ((w.ph === 'takeoff' || w.ph === 'climb') ? CFG.takeoffAccel : CFG.accel) : CFG.decel;
    n.v += clamp(target - n.v, -a * dt, a * dt);

    const maxTurn = (air ? 4 : 30 * Math.min(1, n.v / 3)) * dt;
    const turn = clamp(wrap180(want - n.hdg), -maxTurn, maxTurn);
    n.spin += Math.abs(turn);
    n.hdg = norm360(n.hdg + turn);
    n.roll += ((air ? clamp((turn / dt) * 5, -25, 25) : 0) - n.roll) * Math.min(1, dt * 2);

    n.x += Math.sin(n.hdg * rad) * n.v * dt;
    n.y += Math.cos(n.hdg * rad) * n.v * dt;

    const dist = Math.hypot(w.x - n.x, w.y - n.y);
    const f = clamp(dist / n.seg.d0, 0, 1);
    n.agl = w.agl + (n.seg.agl0 - w.agl) * f;

    const vs = (n.agl - n.prevAgl) / Math.max(dt, 0.001);
    n.prevAgl = n.agl;
    let pt = 0;
    if (w.ph === 'flare') pt = 5;
    else if (w.ph === 'takeoff') pt = n.v > 70 ? 8 : 0;
    else if (n.agl > 2) pt = clamp(Math.atan2(vs, Math.max(n.v, 1)) * deg + 3, -1, 14);
    n.pitch += (pt - n.pitch) * Math.min(1, dt * 1.5);

    n.gT -= dt;
    if (n.gT <= 0) { n.gT = 0.5; sampleGround(n); }

    if (dist < n.wpBest - 5) { n.wpBest = dist; n.wpT = 0; } else n.wpT += dt;
    const stalled = !air && n.wpT > 20 && n.v > 0.5;                                  // moving, but not getting any closer
    if (stalled && !step.warned) { step.warned = true; console.warn('[NPC Traffic] a ' + n.m.name + ' stopped making progress on its route, skipping ahead'); }
    const reach = air ? 70 : Math.max(14, n.v * 1.2);
    const ux = w.x - n.seg.x0, uy = w.y - n.seg.y0;
    const passed = !air && dist < 60 && ((n.x - w.x) * ux + (n.y - w.y) * uy) > 0;     // already beside/past it
    if (dist < reach || passed || stalled || (!air && n.spin > 900)) {                            // 900 deg of turning without arriving = going in circles
      if (w.ph === 'xhold') {
        if (!depClear(w.xr)) { n.xWait = true; n.v = 0; return; }
        startCrossing(n, w);
      }
      if (w.ph === 'hold' && !n.holdDone) { n.holdDone = true; n.holdWait = true; n.v = 0; n.depRwy.waiting.add(n); return; }
      if (n.i >= n.route.length - 1) {
        if (w.ph !== 'park') { destroy(n); return; }       // departure left the area
        n.phase = 'park';
        if (n.rwy) { n.rwy.arr.delete(n); n.rwy = null; }
        return;
      }
      n.i++; n.phase = n.route[n.i].ph;
      if (n.rwy && n.i === n.relIdx + 1) { n.rwy.arr.delete(n); n.rwy = null; }   // cleared the runway
      if (n.phase === 'climb' && n.depRwy && n.depRwy.dep === n) n.depRwy.dep = null;   // airborne
      if (n.crossRwy && n.i > n.xEnd) { n.crossRwy.crossing.delete(n); n.crossRwy = null; }   // across
      startSeg(n);
    }
  }

  function startCrossing(n, w) { w.xr.crossing.add(n); n.crossRwy = w.xr; n.xEnd = w.xEnd; }

  function sampleGround(n) {
    const ll = toLL(n.ap.o, n.x, n.y), g = groundAlt(ll[0], ll[1]);
    if (g != null && Math.abs(g - n.ap.cfg.elev) < 30) { n.gElev = g; n.gOK = true; }
  }

  // ---------------------------------------------------------------- loop
  let last = performance.now(), scanAcc = 0;

  let statusAt = 0;
  function scan() {
    const p = playerLLA();
    if (!models.length) { if (performance.now() - statusAt > 15000) { statusAt = performance.now(); log('no models loaded yet (check models.json / repoBase)'); } return; }
    if (!p) return;
    if (performance.now() - statusAt > 15000) {
      statusAt = performance.now();
      airports.forEach(a => log(a.cfg.icao + ': ' + a.state + ', ' + (Math.hypot(...toXY(a.o, p[0], p[1])) / 1000).toFixed(1) + ' km away (needs < ' + CFG.activeRadiusKm + '), ' + npcs.filter(n => n.ap === a).length + ' planes'));
    }
    const lim = CFG.activeRadiusKm * 1000;
    for (const ap of airports) {
      if (ap.state === 'idle') scanAirport(ap);
      if (ap.state !== 'ready') continue;
      const d = Math.hypot(...toXY(ap.o, p[0], p[1]));
      if (!ap.populated && d < lim) { ap.populated = true; populate(ap); }
      else if (ap.populated && d > lim * 1.3) { clearAirport(ap); ap.populated = false; }
      else if (ap.populated) {
        const pp = toXY(ap.o, p[0], p[1]);
        if (arrivalCount() < CFG.maxMoving) safe('new arrival', () => spawnArrival(ap));
        safe('minimum counts', () => fillMinimums(ap, false, pp[0], pp[1]));
        const parkedNow = npcs.filter(n => n.ap === ap && n.phase === 'park').length;
        if (parkedNow < CFG.parked * 0.6) safe('parked top-up', () => addParked(ap, 1, 2000, pp[0], pp[1]));   // appears out of sight
        const t = performance.now();
        if (t - ap.lastDep > CFG.departEveryS * 1000 && departureCount() < CFG.maxDepartures) {
          ap.lastDep = safe('departure', () => startDeparture(ap)) ? t : t - CFG.departEveryS * 1000 + 4000;   // none ready: retry in 4 s
        }
      }
    }
    // parked planes: pick up the real terrain height once it has loaded around them
    for (const n of npcs) {
      if (n.isStatic && !n.gOK) { sampleGround(n); if (n.gOK) render(n); }
    }
  }

  function tick() {
    const now = performance.now(), dt = clamp((now - last) / 1000, 0, 0.1);
    last = now;
    for (const n of npcs.slice()) {
      if (n.isStatic) continue;
      try { step(n, dt); if (npcs.includes(n)) render(n); }
      catch (e) { reportError('moving a ' + (n.m && n.m.name) + ' (' + n.phase + ')', e); destroy(n); }
    }
    scanAcc += dt;
    if (scanAcc >= CFG.scanEveryS) { scanAcc = 0; safe('scan', scan); }
  }

  // ---------------------------------------------------------------- boot (no UI)
  let bootTries = 0;
  function boot() {
    const missing = [];
    if (!W.geofs) missing.push('geofs');
    else {
      if (!geofs.api || !geofs.api.viewer) missing.push('geofs.api.viewer');
      if (!geofs.aircraft || !geofs.aircraft.instance) missing.push('geofs.aircraft.instance');
    }
    if (!W.Cesium) missing.push('W.Cesium');
    if (missing.length) {
      if (bootTries++ % 10 === 0) log('waiting for: ' + missing.join(', '));
      return setTimeout(boot, 1000);
    }
    log('v0.6.5 started');
    loadModels();
    airports.forEach(scanAirport);                         // scan now, so the data is ready before you get near
    try { geofs.api.viewer.scene.preRender.addEventListener(tick); } catch (e) { setInterval(tick, 33); }

    // console helpers only, nothing on screen
    W.npcTraffic = {
      debug() { return npcs.map(n => ({ wi: n.i, id: n.id, hdg: n.hdg, x: Math.round(n.x), y: Math.round(n.y), model: n.m.name, kind: n.kind || 'parked', phase: n.phase, agl: Math.round(n.agl), kts: Math.round(n.v / kts) })); },
      status() { return airports.map(a => ({ icao: a.cfg.icao, state: a.state, runways: a.runways.length, stands: a.parks.length, populated: a.populated, planes: npcs.filter(n => n.ap === a).length, models: models.length })); },
      clear() { npcs.slice().forEach(destroy); airports.forEach(a => { a.populated = false; }); },
      repopulate() { airports.forEach(a => { if (a.state === 'ready') { clearAirport(a); a.populated = true; populate(a); } }); },
      rescan() {
        airports.forEach(a => { try { localStorage.removeItem('geofsNpcScan_' + a.cfg.icao + '_v2'); } catch (e) {} clearAirport(a); a.populated = false; a.state = 'idle'; });
      }
    };
  }
  boot();
})();
