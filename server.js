// Cheap Gas Near Me — zero-dependency Node server.
// Serves the web app from /public and a small JSON API:
//   GET /api/stations?lat=..&lng=..&radiusKm=..   stations + fuel prices (cached)
//   GET /api/geocode?q=city name                  city search via OSM Nominatim
//   GET /api/health
//
// With no Google API key configured it runs in MOCK mode (realistic fake data)
// so the app is usable immediately. Add a key (config.json or the
// GOOGLE_MAPS_API_KEY env var) to get real prices from Places API (New).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');

// ---------------------------------------------------------------- config
function loadConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch { /* no config.json — fine */ }
  return {
    apiKey: process.env.GOOGLE_MAPS_API_KEY || fileCfg.googleMapsApiKey || '',
    port: Number(process.env.PORT || fileCfg.port || 3000),
    maxGoogleCallsPerDay: Number(fileCfg.maxGoogleCallsPerDay ?? 30),
    cacheMinutes: Number(fileCfg.cacheMinutes ?? 30),
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || fileCfg.vapidPublicKey || '',
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || fileCfg.vapidPrivateKey || '',
  };
}
const cfg = loadConfig();
if (cfg.apiKey === 'PASTE_YOUR_KEY_HERE') cfg.apiKey = '';
const MOCK = !cfg.apiKey;

// ---------------------------------------------------------------- usage budget
// Hard daily cap on Google calls so the app can never run past the free tier.
function todayStr() { return new Date().toISOString().slice(0, 10); }

function loadUsage() {
  try {
    const u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (u.date === todayStr()) return u;
  } catch { /* first run or corrupt — start fresh */ }
  return { date: todayStr(), calls: 0 };
}
let usage = loadUsage();

function recordCalls(n) {
  if (usage.date !== todayStr()) usage = { date: todayStr(), calls: 0 };
  usage.calls += n;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch (e) {
    console.warn('could not persist usage counter:', e.message);
  }
}

function budgetRemaining() {
  if (usage.date !== todayStr()) usage = { date: todayStr(), calls: 0 };
  return cfg.maxGoogleCallsPerDay - usage.calls;
}

// ---------------------------------------------------------------- cache
const cache = new Map(); // tileKey -> { at: epoch ms, stations: [...] }

function tileKey(lat, lng, radiusKm) {
  return `${lat.toFixed(2)},${lng.toFixed(2)},${radiusKm}`;
}

// ---------------------------------------------------------------- geometry
function haversineKm(lat1, lng1, lat2, lng2) {
  const r = (d) => (d * Math.PI) / 180;
  const a =
    Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function offsetPoint(lat, lng, distKm, bearingDeg) {
  const b = (bearingDeg * Math.PI) / 180;
  return {
    lat: lat + (distKm / 111.32) * Math.cos(b),
    lng: lng + (distKm / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(b),
  };
}

// Nearby Search returns at most 20 places per call, nearest-first, so a wide
// radius needs several sample circles to also cover the surrounding cities.
function samplePoints(lat, lng, radiusKm) {
  if (radiusKm <= 13) return [{ lat, lng, rKm: radiusKm }];
  const pts = [{ lat, lng, rKm: radiusKm * 0.5 }];
  const ring = radiusKm <= 30 ? [45, 135, 225, 315] : [0, 60, 120, 180, 240, 300];
  for (const bearing of ring) {
    const p = offsetPoint(lat, lng, radiusKm * 0.6, bearing);
    pts.push({ ...p, rKm: radiusKm * 0.55 });
  }
  return pts;
}

// ---------------------------------------------------------------- Google Places
const FUEL_MAP = {
  REGULAR_UNLEADED: 'regular',
  MIDGRADE: 'midgrade',
  PREMIUM: 'premium',
  DIESEL: 'diesel',
  TRUCK_DIESEL: 'diesel',
};

async function googleNearby(pt) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': cfg.apiKey,
      'X-Goog-FieldMask':
        'places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus,places.fuelOptions,places.rating,places.userRatingCount,places.currentOpeningHours.openNow',
    },
    body: JSON.stringify({
      includedTypes: ['gas_station'],
      maxResultCount: 20,
      rankPreference: 'DISTANCE',
      locationRestriction: {
        circle: {
          center: { latitude: pt.lat, longitude: pt.lng },
          radius: Math.min(pt.rKm, 50) * 1000,
        },
      },
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    throw new Error(`Places API ${res.status}: ${body}`);
  }
  return (await res.json()).places || [];
}

function normalizePlace(p) {
  const prices = {};
  for (const fp of p.fuelOptions?.fuelPrices || []) {
    const key = FUEL_MAP[fp.type];
    if (!key || !fp.price) continue;
    const cents = (Number(fp.price.units || 0) + Number(fp.price.nanos || 0) / 1e9) * 100;
    if (!(cents > 0)) continue;
    const updated = fp.updateTime || null;
    if (!prices[key] || (updated || '') > (prices[key].updated || '')) {
      prices[key] = {
        cents: +cents.toFixed(1),
        currency: fp.price.currencyCode || 'CAD',
        updated,
      };
    }
  }
  return {
    id: p.id,
    name: p.displayName?.text || 'Gas station',
    address: p.formattedAddress || '',
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    rating: p.rating ?? null,
    ratingCount: p.userRatingCount ?? null,
    openNow: p.currentOpeningHours?.openNow ?? null, // null = hours unknown
    prices,
  };
}

async function fetchGoogleStations(lat, lng, radiusKm) {
  const pts = samplePoints(lat, lng, radiusKm);
  if (budgetRemaining() < pts.length) return null; // caller falls back to stale cache
  const results = await Promise.allSettled(pts.map(googleNearby));
  recordCalls(pts.length);
  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length === results.length) throw failures[0].reason;
  const byId = new Map();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const place of r.value) {
      if (place.businessStatus && place.businessStatus !== 'OPERATIONAL') continue;
      const s = normalizePlace(place);
      if (s.lat == null || s.lng == null) continue;
      if (!byId.has(s.id)) byId.set(s.id, s);
    }
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------- mock data
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MOCK_BRANDS = [
  'Petro-Canada', 'Shell', 'Esso', 'Husky', 'Canadian Tire Gas+', 'Costco Gas',
  'Ultramar', 'Co-op', 'Chevron', 'Mobil', '7-Eleven Fuel', 'Pioneer', 'Fas Gas Plus',
];
const MOCK_STREETS = [
  'Main St', 'King St', 'Dundas St', 'Portage Ave', 'Macleod Trail',
  'Hastings St', 'Tecumseh Rd', 'Bank St', 'Quinpool Rd', 'Broadway Ave',
];

function mockStations(lat, lng, radiusKm, key) {
  const rand = mulberry32(hashStr(key));
  const n = 18 + Math.floor(rand() * 8);
  const base = 142 + rand() * 22; // regular, ¢/L
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = radiusKm * Math.sqrt(rand());
    const p = offsetPoint(lat, lng, d, rand() * 360);
    const brand = MOCK_BRANDS[Math.floor(rand() * MOCK_BRANDS.length)];
    let off = (rand() - 0.5) * 10;
    if (/Costco|Canadian Tire/.test(brand)) off -= 5; // discounters run cheaper
    const reg = +(base + off).toFixed(1);
    const updated = new Date(Date.now() - rand() * 6 * 3600e3).toISOString();
    const prices = { regular: { cents: reg, currency: 'CAD', updated } };
    if (rand() < 0.85) prices.midgrade = { cents: +(reg + 12 + rand() * 4).toFixed(1), currency: 'CAD', updated };
    if (rand() < 0.8) prices.premium = { cents: +(reg + 22 + rand() * 6).toFixed(1), currency: 'CAD', updated };
    if (rand() < 0.6) prices.diesel = { cents: +(reg + 8 + rand() * 15).toFixed(1), currency: 'CAD', updated };
    out.push({
      id: `mock-${key}-${i}`,
      name: brand,
      address: `${100 + Math.floor(rand() * 9900)} ${MOCK_STREETS[Math.floor(rand() * MOCK_STREETS.length)]}`,
      lat: p.lat,
      lng: p.lng,
      rating: +(3.3 + rand() * 1.6).toFixed(1),
      ratingCount: 5 + Math.floor(rand() * 400),
      openNow: rand() < 0.92,
      prices,
    });
  }
  return out;
}

// ---------------------------------------------------------------- routing
// Proxy to the public OSRM demo router (fair-use). Returns the driving route
// as [lat,lng] coords so the client can draw it and sample stations along it.
const routeCache = new Map(); // key -> { at, data }

async function handleRoute(res, params) {
  const fLat = Number(params.get('fromLat')), fLng = Number(params.get('fromLng'));
  const tLat = Number(params.get('toLat')), tLng = Number(params.get('toLng'));
  if (![fLat, fLng, tLat, tLng].every(Number.isFinite)) {
    return sendJson(res, 400, { error: 'fromLat, fromLng, toLat, toLng are required' });
  }
  const key = [fLat.toFixed(3), fLng.toFixed(3), tLat.toFixed(3), tLng.toFixed(3)].join(',');
  const hit = routeCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60e3) return sendJson(res, 200, hit.data);
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${fLng},${fLat};${tLng},${tLat}?overview=full&geometries=geojson&alternatives=false`;
    const r = await fetch(url, { headers: { 'User-Agent': 'cheap-gas-app/1.0 (personal use)' } });
    const j = await r.json();
    if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.message || j.code || 'no route found');
    const rt = j.routes[0];
    const data = {
      distanceKm: +(rt.distance / 1000).toFixed(1),
      durationMin: Math.round(rt.duration / 60),
      coords: rt.geometry.coordinates.map((c) => [c[1], c[0]]),
    };
    if (routeCache.size > 50) routeCache.clear();
    routeCache.set(key, { at: Date.now(), data });
    sendJson(res, 200, data);
  } catch (e) {
    sendJson(res, 502, { error: `Routing failed: ${e.message}` });
  }
}

// ---------------------------------------------------------------- IP geolocation
// Fallback for when browser GPS is unavailable (e.g. phones on plain http://).
// City-level accuracy. LAN/localhost clients resolve the server's own public
// IP — same network, same city.
const ipLocCache = new Map(); // ip ('' = server's own) -> { at, data }

function isPrivateIp(ip) {
  return !ip || ip === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fc|fd)/i.test(ip);
}

async function handleIpLocate(req, res) {
  let ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  ip = ip.replace(/^::ffff:/, '');
  if (isPrivateIp(ip)) ip = '';
  const hit = ipLocCache.get(ip);
  if (hit && Date.now() - hit.at < 12 * 3600e3) return sendJson(res, 200, hit.data);
  try {
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,city,regionName,lat,lon`);
    const j = await r.json();
    if (j.status !== 'success') throw new Error(j.message || 'lookup failed');
    const data = { lat: j.lat, lng: j.lon, label: [j.city, j.regionName].filter(Boolean).join(', ') || 'my area' };
    if (ipLocCache.size > 100) ipLocCache.clear();
    ipLocCache.set(ip, { at: Date.now(), data });
    sendJson(res, 200, data);
  } catch (e) {
    sendJson(res, 502, { error: `IP geolocation failed: ${e.message}` });
  }
}

// ---------------------------------------------------------------- API handlers
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// Core station lookup with cache, mock mode, and budget guard — shared by the
// HTTP handler and the alert checker. Throws errors carrying .status.
async function getStationsFor(lat, lng, radiusKm) {
  const key = tileKey(lat, lng, radiusKm);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < cfg.cacheMinutes * 60e3) {
    return { stations: cached.stations, source: 'cache', at: cached.at, stale: false };
  }
  if (MOCK) {
    const stations = mockStations(lat, lng, radiusKm, key);
    cache.set(key, { at: Date.now(), stations });
    return { stations, source: 'mock', at: Date.now(), stale: false };
  }
  try {
    const stations = await fetchGoogleStations(lat, lng, radiusKm);
    if (stations === null) {
      // Daily budget exhausted — serve whatever we have rather than overspend.
      if (cached) return { stations: cached.stations, source: 'cache', at: cached.at, stale: true };
      const err = new Error(`Daily Google call budget (${cfg.maxGoogleCallsPerDay}) used up. Try again tomorrow or raise maxGoogleCallsPerDay in config.json.`);
      err.status = 429;
      throw err;
    }
    cache.set(key, { at: Date.now(), stations });
    return { stations, source: 'google', at: Date.now(), stale: false };
  } catch (e) {
    if (e.status) throw e;
    console.error('Places fetch failed:', e.message);
    if (cached) return { stations: cached.stations, source: 'cache', at: cached.at, stale: true };
    const err = new Error(`Could not fetch prices: ${e.message}`);
    err.status = 502;
    throw err;
  }
}

async function handleStations(res, params) {
  const lat = Number(params.get('lat'));
  const lng = Number(params.get('lng'));
  let radiusKm = Number(params.get('radiusKm') || 10);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) {
    return sendJson(res, 400, { error: 'lat and lng query params are required' });
  }
  radiusKm = Math.min(Math.max(radiusKm, 2), 60);
  try {
    const r = await getStationsFor(lat, lng, radiusKm);
    const withDist = r.stations
      .map((s) => ({ ...s, distanceKm: +haversineKm(lat, lng, s.lat, s.lng).toFixed(2) }))
      .filter((s) => s.distanceKm <= radiusKm + 2)
      .sort((a, b) => a.distanceKm - b.distanceKm);
    sendJson(res, 200, {
      stations: withDist,
      source: r.source,
      mock: MOCK,
      stale: r.stale,
      fetchedAt: new Date(r.at).toISOString(),
      cacheMinutes: cfg.cacheMinutes,
      budget: { used: usage.calls, limit: cfg.maxGoogleCallsPerDay },
    });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message, budget: { used: usage.calls, limit: cfg.maxGoogleCallsPerDay } });
  }
}

async function handleGeocode(res, params) {
  const q = (params.get('q') || '').trim();
  if (!q) return sendJson(res, 400, { error: 'q query param is required' });
  const url =
    'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=ca&q=' +
    encodeURIComponent(q);
  try {
    let r = await fetch(url, { headers: { 'User-Agent': 'cheap-gas-near-me/1.0 (personal local app)' } });
    let rows = r.ok ? await r.json() : [];
    if (!rows.length) {
      // retry without the Canada filter so US border towns etc. still work
      r = await fetch(url.replace('&countrycodes=ca', ''), {
        headers: { 'User-Agent': 'cheap-gas-near-me/1.0 (personal local app)' },
      });
      rows = r.ok ? await r.json() : [];
    }
    sendJson(res, 200, {
      results: rows.map((row) => ({
        name: row.display_name,
        lat: Number(row.lat),
        lng: Number(row.lon),
      })),
    });
  } catch (e) {
    sendJson(res, 502, { error: `Geocoding failed: ${e.message}` });
  }
}

// ---------------------------------------------------------------- push alerts
// Requires the web-push package and VAPID keys (env vars or config.json).
// Without them the server runs fine and alert endpoints report "disabled".
let webpush = null;
try { webpush = (await import('web-push')).default; } catch { /* dependency not installed */ }

const ALERTS = Boolean(webpush && cfg.vapidPublicKey && cfg.vapidPrivateKey);
if (ALERTS) webpush.setVapidDetails('mailto:lesliepeters18@gmail.com', cfg.vapidPublicKey, cfg.vapidPrivateKey);

const SUBS_FILE = path.join(DATA_DIR, 'subs.json');
let subs = [];
try { subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch { /* none yet */ }

function saveSubs() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subs));
  } catch (e) {
    console.warn('could not persist subscriptions:', e.message);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 100e3) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const FUELS = ['regular', 'midgrade', 'premium', 'diesel'];

async function handleSubscribe(req, res) {
  if (!ALERTS) return sendJson(res, 503, { error: 'alerts are not configured on this server (VAPID keys missing)' });
  const b = await readBody(req);
  const sub = b.subscription;
  if (!sub?.endpoint || !sub?.keys) return sendJson(res, 400, { error: 'subscription required' });
  const lat = Number(b.lat), lng = Number(b.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return sendJson(res, 400, { error: 'lat/lng required' });
  const entry = {
    endpoint: sub.endpoint,
    keys: sub.keys,
    fuel: FUELS.includes(b.fuel) ? b.fuel : 'regular',
    thresholdCents: Math.min(400, Math.max(50, Number(b.thresholdCents) || 150)),
    lat,
    lng,
    radiusKm: Math.min(25, Math.max(2, Number(b.radiusKm) || 10)),
    lastNotified: subs.find((s) => s.endpoint === sub.endpoint)?.lastNotified || null,
  };
  subs = subs.filter((s) => s.endpoint !== entry.endpoint);
  subs.push(entry);
  saveSubs();
  sendJson(res, 200, { ok: true, count: subs.length });
}

async function handleUnsubscribe(req, res) {
  const b = await readBody(req);
  subs = subs.filter((s) => s.endpoint !== b.endpoint);
  saveSubs();
  sendJson(res, 200, { ok: true });
}

// Pinged by an external cron every 20-30 min (which also keeps the free
// instance awake). Internally throttled so extra pings cost nothing.
let lastAlertsRun = 0;
async function handleAlertsRun(res) {
  if (!ALERTS) return sendJson(res, 200, { ok: true, skipped: 'alerts not configured' });
  if (Date.now() - lastAlertsRun < 20 * 60e3) {
    return sendJson(res, 200, { ok: true, skipped: 'ran recently', subs: subs.length });
  }
  lastAlertsRun = Date.now();
  let sent = 0, dropped = 0, checked = 0;
  for (const sub of [...subs]) {
    try {
      const r = await getStationsFor(sub.lat, sub.lng, sub.radiusKm);
      checked++;
      const priced = r.stations
        .filter((s) => s.prices[sub.fuel])
        .sort((a, b) => a.prices[sub.fuel].cents - b.prices[sub.fuel].cents);
      if (!priced.length) continue;
      const best = priced[0];
      const cents = best.prices[sub.fuel].cents;
      const today = new Date().toISOString().slice(0, 10);
      if (cents <= sub.thresholdCents && sub.lastNotified !== today) {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify({
          title: `⛽ ${cents.toFixed(1)}¢/L near you`,
          body: `${best.name} has ${sub.fuel} at ${cents.toFixed(1)}¢/L — at or below your ${sub.thresholdCents}¢ alert.`,
          url: '/',
        }));
        sub.lastNotified = today;
        sent++;
      }
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        subs = subs.filter((s) => s.endpoint !== sub.endpoint);
        dropped++;
      } else {
        console.warn('alert check failed:', e.message);
      }
    }
  }
  saveSubs();
  sendJson(res, 200, { ok: true, subs: subs.length, checked, sent, dropped });
}

// ---------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/stations') return await handleStations(res, url.searchParams);
    if (url.pathname === '/api/geocode') return await handleGeocode(res, url.searchParams);
    if (url.pathname === '/api/iplocate') return await handleIpLocate(req, res);
    if (url.pathname === '/api/route') return await handleRoute(res, url.searchParams);
    if (url.pathname === '/api/push/pubkey') {
      return sendJson(res, 200, { enabled: ALERTS, key: cfg.vapidPublicKey || null });
    }
    if (url.pathname === '/api/push/subscribe' && req.method === 'POST') return await handleSubscribe(req, res);
    if (url.pathname === '/api/push/unsubscribe' && req.method === 'POST') return await handleUnsubscribe(req, res);
    if (url.pathname === '/api/alerts/run') return await handleAlertsRun(res);
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        mock: MOCK,
        alerts: ALERTS,
        subs: subs.length,
        budget: { used: usage.calls, limit: cfg.maxGoogleCallsPerDay },
      });
    }
    return serveStatic(res, url.pathname);
  } catch (e) {
    console.error('Unhandled error:', e);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

server.listen(cfg.port, () => {
  console.log(`⛽ Cheap Gas Near Me  →  http://localhost:${cfg.port}`);
  console.log(
    MOCK
      ? '   Running in MOCK mode (sample data). Add a Google API key for real prices — see README.md.'
      : `   Live mode. Google call budget today: ${usage.calls}/${cfg.maxGoogleCallsPerDay}, cache ${cfg.cacheMinutes} min.`
  );
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${cfg.port} is in use. Set "port" in config.json or $env:PORT and retry.`);
    process.exit(1);
  }
  throw e;
});
