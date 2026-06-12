/* global L */
// Cheap Gas — frontend: detect/search a place, fetch /api/stations,
// rank by price for the chosen fuel, draw the list + price-pill map.

const FUEL_LABELS = { regular: 'Regular', midgrade: 'Midgrade', premium: 'Premium', diesel: 'Diesel' };
const MONO_COLORS = ['#0ea5e9', '#8b5cf6', '#ef4444', '#f59e0b', '#10b981', '#ec4899', '#f97316', '#14b8a6', '#6366f1', '#84cc16'];
const KM_TO_MI = 0.621371;
const RADIUS_LABELS = {
  km: { 5: '5 km', 10: '10 km', 25: '25 km', 50: '50 km' },
  mi: { 5: '3 mi', 10: '6 mi', 25: '16 mi', 50: '31 mi' },
};
const DEFAULT_SETTINGS = {
  theme: 'auto',          // auto | light | dark
  priceUnit: 'cents',     // cents (¢/L) | dollars ($/L)
  distUnit: 'km',         // km | mi
  sort: 'price',          // price | distance
  refreshMins: 10,        // 0 = off
  showUnpricedDefault: false,
  hideClosed: false,
  econ: 9.0,   // vehicle L/100km
  fillL: 50,   // typical fill, litres
};

const els = {
  input: document.getElementById('city-input'),
  results: document.getElementById('search-results'),
  locate: document.getElementById('locate-btn'),
  fuel: document.getElementById('fuel-select'),
  radius: document.getElementById('radius-select'),
  refresh: document.getElementById('refresh-btn'),
  mockBanner: document.getElementById('mock-banner'),
  infoBanner: document.getElementById('info-banner'),
  errBanner: document.getElementById('error-banner'),
  meta: document.getElementById('meta-line'),
  liveDot: document.getElementById('live-dot'),
  list: document.getElementById('station-list'),
  showUnpriced: document.getElementById('show-unpriced'),
  searchArea: document.getElementById('search-area-btn'),
  compare: document.getElementById('compare-card'),
  brandBar: document.getElementById('brand-bar'),
  toggleClosed: document.getElementById('toggle-closed'),
  statsStrip: document.getElementById('stats-strip'),
  statCheap: document.getElementById('stat-cheap'),
  statAvg: document.getElementById('stat-avg'),
  statHigh: document.getElementById('stat-high'),
  skeletons: document.getElementById('skeletons'),
  econInput: document.getElementById('econ-input'),
  fillInput: document.getElementById('fill-input'),
  logbookBtn: document.getElementById('logbook-btn'),
  logbookOverlay: document.getElementById('logbook-overlay'),
  logbookClose: document.getElementById('logbook-close'),
  logStats: document.getElementById('log-stats'),
  logForm: document.getElementById('log-form'),
  logStation: document.getElementById('log-station'),
  logLitres: document.getElementById('log-litres'),
  logCents: document.getElementById('log-cents'),
  logOdo: document.getElementById('log-odo'),
  logDate: document.getElementById('log-date'),
  logList: document.getElementById('log-list'),
  logTotal: document.getElementById('log-total'),
  logExport: document.getElementById('log-export'),
  routeBtn: document.getElementById('route-btn'),
  routeBar: document.getElementById('route-bar'),
  routeFromLabel: document.getElementById('route-from-label'),
  routeInput: document.getElementById('route-input'),
  routeResults: document.getElementById('route-results'),
  routeGo: document.getElementById('route-go'),
  routeExit: document.getElementById('route-exit'),
  settingsBtn: document.getElementById('settings-btn'),
  settingsOverlay: document.getElementById('settings-overlay'),
  settingsClose: document.getElementById('settings-close'),
  settingsAbout: document.getElementById('settings-about'),
  toggleUnpriced: document.getElementById('toggle-unpriced'),
};

function loadState() {
  try { return JSON.parse(localStorage.getItem('cheapgas-state')); } catch { return null; }
}
function saveState() { localStorage.setItem('cheapgas-state', JSON.stringify(state)); }

let state = loadState() || {};
state = {
  center: state.center || null,
  fuel: state.fuel || 'regular',
  radiusKm: state.radiusKm || 10,
  // follow = keep re-detecting where you are; off when a city was searched manually
  follow: state.follow ?? (state.center ? state.center.label === 'my location' : true),
  settings: { ...DEFAULT_SETTINGS, ...(state.settings || {}) },
  favorites: state.favorites || [], // [{ id, name }]
  brands: state.brands || [],       // selected brand labels; empty = all
};

let stations = [];
let lastResponse = null;
let lastLoadedAt = 0;
let showUnpriced = state.settings.showUnpricedDefault;
let selectedId = null;
const refs = new Map(); // station id -> { marker, li, latlng, baseZ }

// ------------------------------------------------------------------ map
const map = L.map('map', { zoomControl: false }).setView([56.3, -96], 4); // Canada overview until a place is picked
L.control.zoom({ position: 'bottomright' }).addTo(map);
const markerLayer = L.layerGroup().addTo(map);

// Basemaps: CARTO Positron by day; Esri World Dark Gray Canvas by night
// (charcoal land with clearly lighter roads — CARTO's dark tiles are too
// black to read in rural areas). Esri's dark canvas stops at zoom 16, so
// deeper zooms upscale those tiles.
const CARTO_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
const ESRI_ATTR = 'Tiles &copy; Esri &copy; OpenStreetMap contributors';
let baseLayers = [];
function applyBasemap(dark) {
  baseLayers.forEach((l) => map.removeLayer(l));
  baseLayers = [];
  if (dark) {
    const opts = { maxNativeZoom: 16, maxZoom: 19 };
    baseLayers.push(L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { ...opts, attribution: ESRI_ATTR }).addTo(map));
    baseLayers.push(L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', opts).addTo(map));
  } else {
    baseLayers.push(L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19, subdomains: 'abcd', attribution: CARTO_ATTR,
    }).addTo(map));
  }
}

const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
function effectiveDark() {
  const t = state.settings.theme;
  return t === 'dark' || (t === 'auto' && darkMq.matches);
}
function applyTheme() {
  const t = state.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  applyBasemap(effectiveDark());
}
darkMq.addEventListener?.('change', () => { if (state.settings.theme === 'auto') applyTheme(); });

// ------------------------------------------------------------------ helpers
function distKm(lat1, lng1, lat2, lng2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// price formatting honours the ¢/L vs $/L setting
function priceText(cents, { short = false } = {}) {
  if (state.settings.priceUnit === 'dollars') return '$' + (cents / 100).toFixed(short ? 2 : 3);
  return cents.toFixed(1);
}
function priceUnitLabel() { return state.settings.priceUnit === 'dollars' ? '/L' : '¢/L'; }

function fmtPrice(p) {
  if (!p) return '<span class="unit">—</span>';
  if (p.currency !== 'CAD') return `${(p.cents / 100).toFixed(3)}<span class="unit">${p.currency}/L</span>`;
  return `${priceText(p.cents)}<span class="unit">${priceUnitLabel()}</span>`;
}

function fmtDist(km) {
  if (state.settings.distUnit === 'mi') return (km * KM_TO_MI).toFixed(2) + ' mi';
  return km + ' km';
}
function radiusLabel() {
  if (state.settings.distUnit === 'mi') return Math.round(state.radiusKm * KM_TO_MI) + ' mi';
  return state.radiusKm + ' km';
}

function ago(iso) {
  if (!iso) return '';
  const mins = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function shortName(n) { return n.split(',').slice(0, 2).join(','); }

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}
function monoColor(name) { return MONO_COLORS[hashStr(name) % MONO_COLORS.length]; }

// Brand → website domain; the card shows the site's favicon as the logo.
// Unmatched brands (and any favicon that fails to load) fall back to the
// coloured-letter tile.
const BRAND_DOMAINS = [
  [/petro[\s-]?(canada|pass)/i, 'petro-canada.ca', 'Petro-Canada'],
  [/esso/i, 'esso.ca', 'Esso'],
  [/shell/i, 'shell.ca', 'Shell'],
  [/mobil/i, 'mobil.com', 'Mobil'],
  [/7[\s-]?eleven/i, '7-eleven.ca', '7-Eleven'],
  [/canadian\s?tire|gas\+/i, 'canadiantire.ca', 'Canadian Tire'],
  [/costco/i, 'costco.ca', 'Costco'],
  [/circle\s?k/i, 'circlek.com', 'Circle K'],
  [/ultramar/i, 'ultramar.ca', 'Ultramar'],
  [/chevron/i, 'chevron.com', 'Chevron'],
  [/husky/i, 'myhusky.ca', 'Husky'],
  [/pioneer/i, 'pioneer.ca', 'Pioneer'],
  [/fas\s?gas/i, 'fasgas.ca', 'Fas Gas'],
  [/irving/i, 'irvingoil.com', 'Irving'],
  [/macewen/i, 'macewen.ca', 'MacEwen'],
];

function brandDomain(name) {
  const hit = BRAND_DOMAINS.find(([re]) => re.test(name));
  return hit ? hit[1] : null;
}

function brandLabel(name) {
  const hit = BRAND_DOMAINS.find(([re]) => re.test(name));
  return hit ? hit[2] : name;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- favorites + price history (all stored on this device)
function isFav(id) { return state.favorites.some((f) => f.id === id); }

function toggleFav(s) {
  if (isFav(s.id)) state.favorites = state.favorites.filter((f) => f.id !== s.id);
  else state.favorites.push({ id: s.id, name: s.name });
  saveState();
  render();
}

function localDate() { return new Date().toLocaleDateString('en-CA'); } // YYYY-MM-DD

function loadHistory() {
  try { return JSON.parse(localStorage.getItem('cheapgas-history')) || {}; } catch { return {}; }
}

function recordHistory(fuel, byPrice) {
  if (!byPrice.length || !lastResponse || lastResponse.mock) return;
  const h = loadHistory();
  const arr = (h[fuel] = h[fuel] || []);
  const cents = byPrice.map((s) => s.prices[fuel].cents);
  const entry = {
    d: localDate(),
    cheap: cents[0],
    avg: +(cents.reduce((a, b) => a + b, 0) / cents.length).toFixed(1),
    favs: {},
  };
  for (const f of state.favorites) {
    const s = byPrice.find((x) => x.id === f.id);
    if (s) entry.favs[f.id] = s.prices[fuel].cents;
  }
  const i = arr.findIndex((x) => x.d === entry.d);
  if (i >= 0) arr[i] = entry; else arr.push(entry);
  if (arr.length > 60) arr.splice(0, arr.length - 60);
  localStorage.setItem('cheapgas-history', JSON.stringify(h));
}

function spark(hist) {
  const pts = hist.slice(-7).map((h) => h.cheap);
  if (pts.length < 2) return '';
  const min = Math.min(...pts), max = Math.max(...pts), span = (max - min) || 1;
  const xy = pts.map((v, i) =>
    `${(i * (60 / (pts.length - 1))).toFixed(1)},${(16 - ((v - min) / span) * 13).toFixed(1)}`).join(' ');
  return `<svg class="cmp-spark" viewBox="0 0 60 18" aria-hidden="true"><polyline points="${xy}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

function showError(msg) { els.errBanner.textContent = msg; els.errBanner.hidden = false; }
function hideError() { els.errBanner.hidden = true; }
function showInfo(msg) { els.infoBanner.textContent = msg; els.infoBanner.hidden = false; }

function setLoading(on) {
  els.skeletons.hidden = !on || stations.length > 0; // only skeleton an empty list
}

// ------------------------------------------------------------------ search
let searchTimer = null;

els.input.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = els.input.value.trim();
  if (q.length < 3) { els.results.hidden = true; return; }
  searchTimer = setTimeout(() => geocode(q), 450);
});

els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); geocode(els.input.value.trim()); }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap')) {
    els.results.hidden = true;
    els.routeResults.hidden = true;
  }
});

async function geocode(q) {
  if (!q) return;
  try {
    const r = await fetch('/api/geocode?q=' + encodeURIComponent(q));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'geocoding error');
    renderSearchResults(data.results);
  } catch (e) {
    showError('Search failed: ' + e.message);
  }
}

function renderSearchResults(rows) {
  els.results.innerHTML = '';
  if (!rows.length) {
    const li = document.createElement('li');
    li.textContent = 'No matches found';
    els.results.appendChild(li);
  }
  for (const row of rows) {
    const li = document.createElement('li');
    li.textContent = row.name;
    li.addEventListener('click', () => {
      els.results.hidden = true;
      els.input.value = shortName(row.name);
      setCenter(row.lat, row.lng, shortName(row.name));
    });
    els.results.appendChild(li);
  }
  els.results.hidden = false;
}

// ------------------------------------------------------------------ controls
els.fuel.value = state.fuel;
els.radius.value = String(state.radiusKm);

els.fuel.addEventListener('change', () => {
  state.fuel = els.fuel.value; saveState(); render(true);
});
els.radius.addEventListener('change', () => {
  state.radiusKm = Number(els.radius.value); saveState(); load();
});
els.refresh.addEventListener('click', () => {
  els.refresh.classList.remove('spin');
  void els.refresh.offsetWidth; // restart the animation
  els.refresh.classList.add('spin');
  if (routeMode) goRoute(); else load();
});

els.locate.addEventListener('click', () => locateAndSearch({ silent: false }));

els.showUnpriced.addEventListener('click', () => { showUnpriced = !showUnpriced; render(); });

// “Search this area” appears when the map is panned away from the searched spot
map.on('moveend', () => {
  if (!state.center || routeMode) return;
  const c = map.getCenter();
  const moved = distKm(c.lat, c.lng, state.center.lat, state.center.lng);
  els.searchArea.hidden = moved < Math.max(2, state.radiusKm * 0.4);
});

els.searchArea.addEventListener('click', () => {
  const c = map.getCenter();
  els.searchArea.hidden = true;
  setCenter(c.lat, c.lng, 'map area');
});

function setCenter(lat, lng, label, follow = false) {
  state.center = { lat, lng, label };
  state.follow = follow;
  saveState();
  load();
}

// ------------------------------------------------------------------ settings
function openSettings() { syncSettingsUI(); els.settingsOverlay.hidden = false; }
function closeSettings() { els.settingsOverlay.hidden = true; }

els.settingsBtn.addEventListener('click', openSettings);
els.settingsClose.addEventListener('click', closeSettings);
els.settingsOverlay.addEventListener('click', (e) => { if (e.target === els.settingsOverlay) closeSettings(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!els.settingsOverlay.hidden) closeSettings();
  if (!els.logbookOverlay.hidden) els.logbookOverlay.hidden = true;
});

document.querySelectorAll('.seg[data-setting]').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const key = seg.dataset.setting;
    state.settings[key] = key === 'refreshMins' ? Number(btn.dataset.value) : btn.dataset.value;
    saveState();
    if (key === 'theme') applyTheme();
    if (key === 'refreshMins') restartAutoRefresh();
    syncSettingsUI();
    render(); // re-format prices/distances/sort in place
  });
});

els.toggleUnpriced.addEventListener('click', () => {
  showUnpriced = !showUnpriced;
  state.settings.showUnpricedDefault = showUnpriced;
  saveState();
  syncSettingsUI();
  render();
});

els.toggleClosed.addEventListener('click', () => {
  state.settings.hideClosed = !state.settings.hideClosed;
  saveState();
  syncSettingsUI();
  render();
});

function syncSettingsUI() {
  document.querySelectorAll('.seg[data-setting]').forEach((seg) => {
    const current = String(state.settings[seg.dataset.setting]);
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === current));
  });
  els.toggleUnpriced.setAttribute('aria-checked', String(showUnpriced));
  els.toggleClosed.setAttribute('aria-checked', String(state.settings.hideClosed));
  [...els.radius.options].forEach((o) => { o.textContent = RADIUS_LABELS[state.settings.distUnit][o.value]; });

  els.econInput.value = state.settings.econ;
  els.fillInput.value = state.settings.fillL;

  let about = 'CheapGas · prices via Google Places · map © OpenStreetMap · CARTO · Esri';
  if (lastResponse?.mock) about += ' · running on sample data';
  else if (lastResponse) about += ` · API calls today ${lastResponse.budget.used}/${lastResponse.budget.limit}`;
  els.settingsAbout.textContent = about;
}

els.econInput.addEventListener('change', () => {
  state.settings.econ = Math.min(30, Math.max(3, Number(els.econInput.value) || 9));
  saveState(); syncSettingsUI(); render();
});
els.fillInput.addEventListener('change', () => {
  state.settings.fillL = Math.min(200, Math.max(10, Number(els.fillInput.value) || 50));
  saveState(); syncSettingsUI(); render();
});

// ------------------------------------------------------------------ logbook
function loadLog() {
  try { return JSON.parse(localStorage.getItem('cheapgas-logbook')) || []; } catch { return []; }
}
function saveLog(arr) { localStorage.setItem('cheapgas-logbook', JSON.stringify(arr)); }

function openLogbook() {
  const sel = refs.get(selectedId);
  const selStation = sel ? stations.find((s) => s.id === selectedId) : null;
  const src = selStation || stations.find((s) => s.prices[state.fuel]);
  if (src && !els.logStation.value) els.logStation.value = src.name;
  if (src?.prices[state.fuel] && !els.logCents.value) els.logCents.value = src.prices[state.fuel].cents;
  if (!els.logLitres.value) els.logLitres.value = state.settings.fillL;
  els.logDate.value = localDate();
  renderLogbook();
  closeSettings();
  els.logbookOverlay.hidden = false;
}

function renderLogbook() {
  const log = loadLog().sort((a, b) => (a.d < b.d ? 1 : -1));
  // stats
  if (log.length) {
    const spent = log.reduce((a, f) => a + (f.litres * f.cents) / 100, 0);
    const ym = localDate().slice(0, 7);
    const monthSpent = log.filter((f) => f.d.startsWith(ym)).reduce((a, f) => a + (f.litres * f.cents) / 100, 0);
    const odoFills = log.filter((f) => f.odo).sort((a, b) => a.odo - b.odo);
    let econTxt = 'add odometer';
    if (odoFills.length >= 2) {
      const span = odoFills[odoFills.length - 1].odo - odoFills[0].odo;
      const litres = odoFills.slice(1).reduce((a, f) => a + f.litres, 0);
      if (span > 0) econTxt = `${((litres / span) * 100).toFixed(1)} L/100km`;
    }
    els.logStats.innerHTML =
      `<div class="stat"><span class="stat-label">Fills</span><span class="stat-value">${log.length}</span></div>` +
      `<div class="stat"><span class="stat-label">This month</span><span class="stat-value">$${monthSpent.toFixed(0)}</span></div>` +
      `<div class="stat"><span class="stat-label">All time</span><span class="stat-value">$${spent.toFixed(0)}</span></div>` +
      `<div class="stat"><span class="stat-label">Real economy</span><span class="stat-value">${econTxt}</span></div>`;
    els.logStats.hidden = false;
  } else {
    els.logStats.hidden = true;
  }
  // list
  els.logList.innerHTML = '';
  log.forEach((f) => {
    const li = document.createElement('li');
    li.className = 'log-row';
    li.innerHTML =
      `<div class="log-row-main"><strong>${esc(f.station)}</strong>` +
      `<span>${f.d} · ${f.litres} L @ ${f.cents}¢ = $${((f.litres * f.cents) / 100).toFixed(2)}${f.odo ? ` · ${f.odo.toLocaleString()} km` : ''}</span></div>` +
      `<button class="log-del" aria-label="Delete fill">✕</button>`;
    li.querySelector('.log-del').addEventListener('click', () => {
      saveLog(loadLog().filter((x) => x.ts !== f.ts));
      renderLogbook();
    });
    els.logList.appendChild(li);
  });
  els.logExport.hidden = log.length === 0;
}

els.logbookBtn.addEventListener('click', openLogbook);
els.logbookClose.addEventListener('click', () => { els.logbookOverlay.hidden = true; });
els.logbookOverlay.addEventListener('click', (e) => { if (e.target === els.logbookOverlay) els.logbookOverlay.hidden = true; });

function updateLogTotal() {
  const l = Number(els.logLitres.value), c = Number(els.logCents.value);
  els.logTotal.textContent = l > 0 && c > 0 ? `= $${((l * c) / 100).toFixed(2)}` : '';
}
els.logLitres.addEventListener('input', updateLogTotal);
els.logCents.addEventListener('input', updateLogTotal);

els.logForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const fill = {
    ts: Date.now(),
    d: els.logDate.value || localDate(),
    station: els.logStation.value.trim() || 'Station',
    litres: Number(els.logLitres.value),
    cents: Number(els.logCents.value),
    odo: Number(els.logOdo.value) || null,
  };
  if (!(fill.litres > 0) || !(fill.cents > 0)) return;
  saveLog([...loadLog(), fill]);
  els.logLitres.value = '';
  els.logOdo.value = '';
  updateLogTotal();
  renderLogbook();
});

els.logExport.addEventListener('click', () => {
  const log = loadLog().sort((a, b) => (a.d < b.d ? -1 : 1));
  const rows = [['date', 'station', 'litres', 'cents_per_L', 'total_dollars', 'odometer_km'],
    ...log.map((f) => [f.d, `"${f.station.replace(/"/g, '""')}"`, f.litres, f.cents, ((f.litres * f.cents) / 100).toFixed(2), f.odo ?? ''])];
  const csv = rows.map((r) => r.join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'cheapgas-logbook.csv';
  a.click();
});

// ---------------------------------------------------------------- auto-location
function getGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('not supported'));
    const giveUp = setTimeout(() => reject(new Error('GPS timed out')), 9000);
    navigator.geolocation.getCurrentPosition(
      (pos) => { clearTimeout(giveUp); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
      (err) => { clearTimeout(giveUp); reject(new Error(err.message || 'permission denied')); },
      { timeout: 8000, maximumAge: 60000 }
    );
  });
}

async function ipLocate() {
  const r = await fetch('/api/iplocate');
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'network location failed');
  return data; // { lat, lng, label }
}

let warnedInsecure = false;

// Detect where the user is (GPS if possible, network IP otherwise) and search
// there. silent=true is the background flavour: no spinners, no error noise.
async function locateAndSearch({ silent }) {
  if (!silent) { hideError(); els.meta.textContent = 'Detecting your location…'; setLoading(true); }
  let loc = null;
  let label = 'my location';
  if (window.isSecureContext && navigator.geolocation) {
    try { loc = await getGPS(); } catch { /* fall through to IP lookup */ }
  } else if (!warnedInsecure && !silent) {
    warnedInsecure = true;
    showInfo('Precise GPS needs an https:// address — using your network’s approximate (city-level) location instead.');
  }
  if (!loc) {
    try {
      const ip = await ipLocate();
      loc = ip;
      label = `${ip.label} (approx.)`;
    } catch (e) {
      if (!silent) {
        setLoading(false);
        showError(`Could not detect your location (${e.message}) — search your city instead.`);
        els.meta.textContent = 'Pick a city or tap “Near me” to start.';
      }
      return;
    }
  }
  const prev = state.center;
  const moved = prev ? distKm(loc.lat, loc.lng, prev.lat, prev.lng) : Infinity;
  if (moved > Math.max(1.5, state.radiusKm * 0.25)) {
    els.input.value = '';
    setCenter(loc.lat, loc.lng, label, true);
  } else {
    state.follow = true;
    saveState();
    if (!silent) load(); // barely moved, but an explicit tap deserves fresh data
  }
}

// ------------------------------------------------------------------ route mode
let routeMode = false;
let route = null; // { label, distanceKm, durationMin, coords }
let routeDest = null;
const routeLayer = L.layerGroup().addTo(map);

els.routeBtn.addEventListener('click', () => {
  els.routeBar.hidden = !els.routeBar.hidden;
  if (!els.routeBar.hidden) {
    els.routeFromLabel.textContent = state.center ? state.center.label : 'your location';
    els.routeInput.focus();
  }
});

let routeSearchTimer = null;
els.routeInput.addEventListener('input', () => {
  clearTimeout(routeSearchTimer);
  routeDest = null;
  const q = els.routeInput.value.trim();
  if (q.length < 3) { els.routeResults.hidden = true; return; }
  routeSearchTimer = setTimeout(() => routeGeocode(q), 450);
});
els.routeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); els.routeGo.click(); }
});

async function routeGeocode(q, autopick = false) {
  try {
    const r = await fetch('/api/geocode?q=' + encodeURIComponent(q));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'geocoding error');
    if (autopick && data.results.length) {
      pickDest(data.results[0]);
      return;
    }
    els.routeResults.innerHTML = '';
    for (const row of data.results) {
      const li = document.createElement('li');
      li.textContent = row.name;
      li.addEventListener('click', () => pickDest(row));
      els.routeResults.appendChild(li);
    }
    els.routeResults.hidden = data.results.length === 0;
  } catch (e) {
    showError('Destination search failed: ' + e.message);
  }
}

function pickDest(row) {
  routeDest = { lat: row.lat, lng: row.lng, label: shortName(row.name) };
  els.routeInput.value = shortName(row.name);
  els.routeResults.hidden = true;
  goRoute();
}

els.routeGo.addEventListener('click', () => {
  if (routeDest) goRoute();
  else if (els.routeInput.value.trim().length >= 3) routeGeocode(els.routeInput.value.trim(), true);
});

els.routeExit.addEventListener('click', exitRoute);

function exitRoute() {
  routeMode = false;
  route = null;
  routeDest = null;
  els.routeBar.hidden = true;
  els.routeInput.value = '';
  routeLayer.clearLayers();
  load();
}

// Evenly spaced sample points along the polyline — each costs one API call,
// so wide spacing + the server cache keep route searches inside the budget.
function samplesAlong(coords, totalKm) {
  const n = Math.min(6, Math.max(2, Math.round(totalKm / 40)));
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + distKm(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
  }
  const total = cum[cum.length - 1];
  const pts = [];
  for (let k = 1; k <= n; k++) {
    const target = (total * k) / (n + 1);
    let idx = cum.findIndex((c) => c >= target);
    if (idx < 0) idx = cum.length - 1;
    pts.push({ lat: coords[idx][0], lng: coords[idx][1], routeKm: Math.round(target) });
  }
  return pts;
}

async function goRoute() {
  if (!state.center) { showError('Set a starting point first (search or “Near me”).'); return; }
  if (!routeDest) return;
  hideError();
  els.meta.textContent = `Routing to ${routeDest.label}…`;
  setLoading(true);
  try {
    const { lat, lng } = state.center;
    const r = await fetch(`/api/route?fromLat=${lat}&fromLng=${lng}&toLat=${routeDest.lat}&toLng=${routeDest.lng}`);
    const rt = await r.json();
    if (!r.ok) throw new Error(rt.error || `HTTP ${r.status}`);

    els.meta.textContent = `Checking prices along ${rt.distanceKm} km of road…`;
    const pts = samplesAlong(rt.coords, rt.distanceKm);
    const results = await Promise.all(pts.map((p) =>
      fetch(`/api/stations?lat=${p.lat}&lng=${p.lng}&radiusKm=4`)
        .then((x) => x.json().then((j) => ({ ok: x.ok, j, p })))
        .catch(() => null)
    ));

    const byId = new Map();
    let lastBudget = null, anyMock = false;
    for (const res of results) {
      if (!res?.ok) continue;
      lastBudget = res.j.budget;
      anyMock = anyMock || res.j.mock;
      for (const s of res.j.stations) {
        if (!byId.has(s.id)) byId.set(s.id, { ...s, routeKm: res.p.routeKm });
      }
    }
    if (!byId.size) throw new Error('no stations found along this route');

    route = { label: routeDest.label, distanceKm: rt.distanceKm, durationMin: rt.durationMin, coords: rt.coords };
    routeMode = true;
    stations = [...byId.values()];
    lastResponse = {
      fetchedAt: new Date().toISOString(),
      source: 'route',
      mock: anyMock,
      stale: false,
      budget: lastBudget || { used: 0, limit: 0 },
    };
    lastLoadedAt = Date.now();
    els.mockBanner.hidden = !anyMock;

    routeLayer.clearLayers();
    L.polyline(rt.coords, { color: '#0d9488', weight: 5, opacity: 0.75 }).addTo(routeLayer);
    L.marker([routeDest.lat, routeDest.lng], {
      icon: L.divIcon({ className: 'pp-wrap', html: '<div class="center-dot" style="background:#dc2626"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      interactive: false,
    }).addTo(routeLayer);

    render(true);
  } catch (e) {
    showError('Route search failed: ' + e.message);
    els.meta.textContent = 'Route search failed.';
  } finally {
    setLoading(false);
  }
}

// ------------------------------------------------------------------ data
async function load() {
  if (routeMode) return; // route results stay until you exit route mode
  if (!state.center) return;
  els.meta.textContent = 'Loading prices…';
  hideError();
  setLoading(true);
  try {
    const { lat, lng } = state.center;
    const r = await fetch(`/api/stations?lat=${lat}&lng=${lng}&radiusKm=${state.radiusKm}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    stations = data.stations;
    lastResponse = data;
    lastLoadedAt = Date.now();
    els.mockBanner.hidden = !data.mock;
    render(true);
  } catch (e) {
    showError('Could not load prices: ' + e.message);
    els.meta.textContent = 'Could not load prices.';
    els.liveDot.classList.add('off');
  } finally {
    setLoading(false);
  }
}

let refreshTimer = null;
function restartAutoRefresh() {
  clearInterval(refreshTimer);
  const mins = Number(state.settings.refreshMins);
  if (!mins) return;
  refreshTimer = setInterval(() => {
    if (routeMode) return;
    if (state.follow) locateAndSearch({ silent: true });
    else if (state.center) load();
  }, mins * 60e3);
}

document.addEventListener('visibilitychange', () => {
  const mins = Number(state.settings.refreshMins);
  if (routeMode || !mins || document.hidden || Date.now() - lastLoadedAt < mins * 60e3) return;
  if (state.follow) locateAndSearch({ silent: true });
  else if (state.center) load();
});

// ------------------------------------------------------------------ compare card
function renderCompare(byPrice, fuel) {
  const el = els.compare;
  if (!state.favorites.length || !byPrice.length) { el.hidden = true; return; }

  const inArea = byPrice.filter((s) => isFav(s.id));
  if (!inArea.length) {
    el.innerHTML = `<div class="cmp-title">⭐ ${esc(state.favorites[0].name)}</div>` +
      `<div class="cmp-sub">no ${FUEL_LABELS[fuel]} price in this search — star a station here to compare</div>`;
    el.hidden = false;
    return;
  }

  const mine = inArea[0];           // your best-priced starred station
  const best = byPrice[0];          // cheapest overall
  const myC = mine.prices[fuel].cents;
  const bestC = best.prices[fuel].cents;
  const diff = +(myC - bestC).toFixed(1);

  let line;
  if (mine.id === best.id || diff <= 0) {
    line = `<span class="cmp-good">cheapest around right now 🎉</span>`;
  } else {
    const { fillL, econ } = state.settings;
    const save = (diff / 100) * fillL;
    const driveCost = 2 * best.distanceKm * (econ / 100) * (bestC / 100); // round trip
    const net = save - driveCost;
    const verdict = net > 0.05
      ? `≈ <span class="cmp-good">$${net.toFixed(2)} net</span> after the drive — worth it`
      : `but the ${fmtDist(best.distanceKm)} round trip burns ~$${driveCost.toFixed(2)} — <span class="cmp-bad">not worth it</span>`;
    line = `<span class="cmp-bad">+${diff}¢</span> vs ${esc(best.name)} (${priceText(bestC)}${priceUnitLabel()}) — ` +
      `saves $${save.toFixed(2)} on ${fillL} L, ${verdict}`;
  }

  const hist = loadHistory()[fuel] || [];
  const prev = [...hist].reverse().find((h) => h.d !== localDate());
  let trend = '';
  if (prev) {
    const dd = +(bestC - prev.cheap).toFixed(1);
    trend = dd === 0
      ? 'cheapest price unchanged vs yesterday'
      : dd < 0
        ? `cheapest is <span class="cmp-good">↓ ${Math.abs(dd)}¢</span> vs yesterday`
        : `cheapest is <span class="cmp-bad">↑ ${dd}¢</span> vs yesterday`;
  }

  el.innerHTML =
    `<div class="cmp-title">⭐ ${esc(mine.name)} · ${priceText(myC)}${priceUnitLabel()}</div>` +
    `<div class="cmp-sub">${line}</div>` +
    (trend ? `<div class="cmp-row"><span class="cmp-sub">${trend}</span>${spark(hist)}</div>` : '');
  el.hidden = false;
}

// ------------------------------------------------------------------ render
function tierOf(rank, total) {
  if (total <= 1) return 'good';
  const t = rank / (total - 1);
  if (t < 0.34) return 'good';
  if (t < 0.67) return 'mid';
  return 'high';
}

function popupHtml(s) {
  const rows = Object.keys(FUEL_LABELS)
    .filter((f) => s.prices[f])
    .map((f) => `<div class="pp-row"><span>${FUEL_LABELS[f]}</span><span><strong>${fmtPrice(s.prices[f])}</strong> <span class="when">${ago(s.prices[f].updated)}</span></span></div>`)
    .join('') || '<div class="pp-row">No price data reported</div>';
  const dir = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`;
  const meta = [
    s.rating ? `★ ${s.rating}` : '',
    s.openNow === false ? '<span style="color:#ef4444;font-weight:700">Closed</span>' : '',
    fmtDist(s.distanceKm),
  ].filter(Boolean).join(' · ');
  return `<div class="gas-popup"><div class="pp-name">${esc(s.name)}</div>` +
    `<div class="pp-addr">${esc(s.address)} · ${meta}</div>${rows}` +
    `<a class="pp-dir" href="${dir}" target="_blank" rel="noopener">Directions ↗</a></div>`;
}

function select(id, opts = {}) {
  const prev = refs.get(selectedId);
  if (prev) {
    prev.li.classList.remove('selected');
    prev.marker.getElement()?.querySelector('.price-pill')?.classList.remove('selected');
    prev.marker.setZIndexOffset(prev.baseZ);
  }
  selectedId = id;
  const r = refs.get(id);
  if (!r) return;
  r.li.classList.add('selected');
  r.marker.getElement()?.querySelector('.price-pill')?.classList.add('selected');
  r.marker.setZIndexOffset(3000);
  if (opts.scroll) r.li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (opts.fly) {
    // Centre the station in the VISIBLE map area (right of the floating panel),
    // and open the popup once the flight lands so the two animations don't fight.
    const z = Math.max(map.getZoom(), 14);
    const desktop = window.matchMedia('(min-width: 761px)').matches;
    const pt = map.project(r.latlng, z);
    const target = map.unproject(desktop ? pt.subtract(L.point(210, 0)) : pt, z);
    const open = () => { if (selectedId === id) r.marker.openPopup(); };
    map.once('moveend', open);
    clearTimeout(select._fallback);
    select._fallback = setTimeout(open, 900);
    map.flyTo(target, z, { duration: 0.6 });
  }
}

let favBaseCents = null; // cents at your best-priced ⭐ station, for per-card deltas

function makeCard(s, { tier, best, priced }) {
  const li = document.createElement('li');
  li.className = 'station-card' + (best ? ' cheapest' : '') + (priced ? '' : ' unpriced');
  li.setAttribute('role', 'button');
  li.tabIndex = 0;
  let delta = '';
  if (priced && favBaseCents != null && !isFav(s.id)) {
    const d = +(s.prices[state.fuel].cents - favBaseCents).toFixed(1);
    if (d !== 0) delta = `<div class="fav-delta">${d > 0 ? '+' : '−'}${Math.abs(d)}¢ vs ⭐</div>`;
  }
  const price = priced
    ? `${best ? '<span class="best-chip">Best price</span>' : ''}<div class="price-big t-${tier}">${fmtPrice(s.prices[state.fuel])}</div><div class="price-age">${ago(s.prices[state.fuel].updated)}</div>${delta}`
    : `<div class="price-big">${fmtPrice(null)}</div><div class="price-age">no ${FUEL_LABELS[state.fuel].toLowerCase()} price</div>`;
  const domain = brandDomain(s.name);
  const badge = domain
    ? `<div class="monogram has-logo"><img loading="lazy" alt="" src="https://www.google.com/s2/favicons?domain=${domain}&sz=64"></div>`
    : `<div class="monogram" style="background:${monoColor(s.name)}">${esc(s.name.charAt(0))}</div>`;
  const fav = isFav(s.id);
  const closed = s.openNow === false ? '<span class="closed-chip">Closed</span>' : '';
  if (s.openNow === false) li.classList.add('closed');
  const stars = s.rating ? `★ ${s.rating}${s.ratingCount ? ` (${s.ratingCount})` : ''} · ` : '';
  const where = s.routeKm != null
    ? `km ${s.routeKm} of drive · ${fmtDist(s.distanceKm)} off route`
    : fmtDist(s.distanceKm);
  li.innerHTML =
    badge +
    `<div class="station-info"><div class="station-name">${esc(s.name)}${closed}</div>` +
    `<div class="station-sub">${stars}${where} · ${esc(s.address)}</div></div>` +
    `<div class="station-price">${price}</div>` +
    `<button class="star-btn${fav ? ' active' : ''}" title="${fav ? 'Remove from' : 'Add to'} favourites" aria-label="${fav ? 'Remove from' : 'Add to'} favourites">${fav ? '★' : '☆'}</button>`;
  li.querySelector('.star-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFav(s);
  });
  const img = li.querySelector('.monogram img');
  if (img) {
    img.addEventListener('error', () => {
      const m = img.parentElement;
      m.classList.remove('has-logo');
      m.style.background = monoColor(s.name);
      m.textContent = s.name.charAt(0);
    });
  }
  return li;
}

function makeMarker(s, { tier, best, priced }) {
  const cls = (priced ? `price-pill t-${tier}${best ? ' best' : ''}` : 'price-pill dot') + (isFav(s.id) ? ' fav' : '');
  const inner = priced ? priceText(s.prices[state.fuel].cents, { short: true }) : '';
  const icon = L.divIcon({
    className: 'pp-wrap',
    html: `<div class="${cls}" title="${esc(s.name)}">${inner}</div>`,
    iconSize: priced ? [58, 26] : [14, 14],
    iconAnchor: priced ? [29, 13] : [7, 7],
  });
  const baseZ = best ? 1500 : priced ? 500 : 0;
  return L.marker([s.lat, s.lng], { icon, riseOnHover: true, zIndexOffset: baseZ });
}

function renderBrandBar() {
  const counts = new Map();
  for (const s of stations) {
    const label = brandLabel(s.name);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const labels = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l).slice(0, 10);
  els.brandBar.hidden = labels.length < 2;
  els.brandBar.innerHTML = '';
  const mkChip = (label, active, onClick) => {
    const b = document.createElement('button');
    b.className = 'chip' + (active ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    els.brandBar.appendChild(b);
  };
  mkChip('All', state.brands.length === 0, () => { state.brands = []; saveState(); render(); });
  for (const label of labels) {
    mkChip(label, state.brands.includes(label), () => {
      state.brands = state.brands.includes(label)
        ? state.brands.filter((x) => x !== label)
        : [...state.brands, label];
      saveState();
      render();
    });
  }
}

function render(recenter = false) {
  const fuel = state.fuel;
  renderBrandBar();
  let pool = stations;
  if (state.brands.length) pool = pool.filter((s) => state.brands.includes(brandLabel(s.name)));
  if (state.settings.hideClosed) pool = pool.filter((s) => s.openNow !== false);
  const priced = pool.filter((s) => s.prices[fuel]);
  const byPrice = [...priced].sort((a, b) => a.prices[fuel].cents - b.prices[fuel].cents);
  const priceRank = new Map(byPrice.map((s, i) => [s.id, i]));
  const ordered = state.settings.sort === 'distance'
    ? [...priced].sort((a, b) => (routeMode ? a.routeKm - b.routeKm : a.distanceKm - b.distanceKm))
    : byPrice;
  const unpriced = pool.filter((s) => !s.prices[fuel]);

  els.list.innerHTML = '';
  refs.clear();
  selectedId = null;
  markerLayer.clearLayers();

  const desktop = window.matchMedia('(min-width: 761px)').matches;
  const popupOpts = {
    offset: [0, -8],
    autoPanPaddingTopLeft: desktop ? L.point(440, 18) : L.point(18, 18),
    autoPanPaddingBottomRight: L.point(18, 18),
  };
  const wire = (s, opt) => {
    const li = makeCard(s, opt);
    const marker = makeMarker(s, opt).bindPopup(popupHtml(s), popupOpts).addTo(markerLayer);
    marker.on('click', () => select(s.id, { scroll: true }));
    const activate = () => select(s.id, { fly: true });
    li.addEventListener('click', activate);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
    els.list.appendChild(li);
    refs.set(s.id, { marker, li, latlng: [s.lat, s.lng], baseZ: opt.best ? 1500 : opt.priced ? 500 : 0 });
  };

  const favsIn = ordered.filter((s) => isFav(s.id));
  favBaseCents = favsIn.length
    ? Math.min(...favsIn.map((s) => s.prices[fuel].cents))
    : null;

  const divider = (label) => {
    const li = document.createElement('li');
    li.className = 'list-divider';
    li.textContent = label;
    els.list.appendChild(li);
  };

  const opts = (s) => ({
    tier: tierOf(priceRank.get(s.id), priced.length),
    best: priceRank.get(s.id) === 0,
    priced: true,
  });
  if (favsIn.length) {
    divider('⭐ Your stations');
    favsIn.forEach((s) => wire(s, opts(s)));
    divider('All nearby');
  }
  ordered.filter((s) => !isFav(s.id)).forEach((s) => wire(s, opts(s)));
  if (showUnpriced) unpriced.forEach((s) => wire(s, { priced: false }));

  if (!routeMode) {
    recordHistory(fuel, byPrice);
    renderCompare(byPrice, fuel);
  } else {
    els.compare.hidden = true;
  }

  els.showUnpriced.hidden = unpriced.length === 0;
  els.showUnpriced.textContent = `${showUnpriced ? 'Hide' : 'Show'} ${unpriced.length} station${unpriced.length === 1 ? '' : 's'} without a ${FUEL_LABELS[fuel].toLowerCase()} price`;

  // ---- stats strip
  els.statsStrip.hidden = byPrice.length === 0;
  if (byPrice.length) {
    const cents = byPrice.map((s) => s.prices[fuel].cents);
    const avg = cents.reduce((a, b) => a + b, 0) / cents.length;
    const u = `<span class="u">${priceUnitLabel()}</span>`;
    els.statCheap.innerHTML = priceText(cents[0]) + u;
    els.statAvg.innerHTML = priceText(avg) + u;
    els.statHigh.innerHTML = priceText(cents[cents.length - 1]) + u;
    const tag = state.settings.priceUnit === 'cents' ? '¢' : '';
    document.title = `${priceText(cents[0])}${tag} ${FUEL_LABELS[fuel]} near ${state.center.label} — Cheap Gas`;
  } else {
    document.title = 'Cheap Gas — lowest gas prices near you';
  }

  // ---- searched-location dot
  if (state.center) {
    L.marker([state.center.lat, state.center.lng], {
      icon: L.divIcon({ className: 'pp-wrap', html: '<div class="center-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      interactive: false,
      zIndexOffset: 200,
    }).addTo(markerLayer);
  }

  // ---- status line
  if (lastResponse) {
    const t = new Date(lastResponse.fetchedAt);
    const hh = `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`;
    const src = lastResponse.mock ? 'sample data' : lastResponse.source === 'google' ? 'live' : lastResponse.source === 'route' ? 'live' : 'cached';
    const stale = lastResponse.stale ? ' · ⚠ stale data (budget/API issue)' : '';
    const budget = lastResponse.mock ? '' : ` · API ${lastResponse.budget.used}/${lastResponse.budget.limit}`;
    if (routeMode && route) {
      const hrs = Math.floor(route.durationMin / 60);
      const mins = route.durationMin % 60;
      els.meta.textContent =
        `${byPrice.length} station${byPrice.length === 1 ? '' : 's'} along your ${route.distanceKm} km drive to ${route.label}` +
        ` (${hrs ? `${hrs} h ` : ''}${mins} min) · ${FUEL_LABELS[fuel]}${budget}${stale}`;
    } else {
      els.meta.textContent =
        `${byPrice.length} station${byPrice.length === 1 ? '' : 's'} · ${FUEL_LABELS[fuel]} · ${radiusLabel()} around ${state.center.label} · ${hh} (${src})${budget}${stale}`;
    }
    els.liveDot.classList.toggle('off', Boolean(lastResponse.mock || lastResponse.stale));
  }

  // ---- viewport
  if (recenter) {
    const pad = desktop
      ? { paddingTopLeft: [436, 36], paddingBottomRight: [36, 36] } // clear the floating panel
      : { padding: [24, 24] };
    if (routeMode && route) {
      map.fitBounds(L.latLngBounds(route.coords), pad);
    } else {
      const pts = (byPrice.length ? byPrice : stations).map((s) => [s.lat, s.lng]);
      if (state.center) pts.push([state.center.lat, state.center.lng]);
      if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { maxZoom: 14, ...pad });
      else if (state.center) map.setView([state.center.lat, state.center.lng], 12);
    }
    els.searchArea.hidden = true;
  }
}

// ------------------------------------------------------------------ boot
applyTheme();
restartAutoRefresh();
syncSettingsUI();

if (state.center) {
  els.input.value = state.follow ? '' : state.center.label;
  load(); // instant render of the last spot…
  if (state.follow) locateAndSearch({ silent: true }); // …then snap to wherever you are now
} else {
  locateAndSearch({ silent: false }); // first run: auto-detect
}
