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
  statsStrip: document.getElementById('stats-strip'),
  statCheap: document.getElementById('stat-cheap'),
  statAvg: document.getElementById('stat-avg'),
  statHigh: document.getElementById('stat-high'),
  skeletons: document.getElementById('skeletons'),
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
  [/petro[\s-]?(canada|pass)/i, 'petro-canada.ca'],
  [/esso/i, 'esso.ca'],
  [/shell/i, 'shell.ca'],
  [/mobil/i, 'mobil.com'],
  [/7[\s-]?eleven/i, '7-eleven.ca'],
  [/canadian\s?tire|gas\+/i, 'canadiantire.ca'],
  [/costco/i, 'costco.ca'],
  [/circle\s?k/i, 'circlek.com'],
  [/ultramar/i, 'ultramar.ca'],
  [/chevron/i, 'chevron.com'],
  [/husky/i, 'myhusky.ca'],
  [/pioneer/i, 'pioneer.ca'],
  [/fas\s?gas/i, 'fasgas.ca'],
  [/irving/i, 'irvingoil.com'],
  [/macewen/i, 'macewen.ca'],
];

function brandDomain(name) {
  const hit = BRAND_DOMAINS.find(([re]) => re.test(name));
  return hit ? hit[1] : null;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  if (!e.target.closest('.search-wrap')) els.results.hidden = true;
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
  load();
});

els.locate.addEventListener('click', () => locateAndSearch({ silent: false }));

els.showUnpriced.addEventListener('click', () => { showUnpriced = !showUnpriced; render(); });

// “Search this area” appears when the map is panned away from the searched spot
map.on('moveend', () => {
  if (!state.center) return;
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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !els.settingsOverlay.hidden) closeSettings(); });

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

function syncSettingsUI() {
  document.querySelectorAll('.seg[data-setting]').forEach((seg) => {
    const current = String(state.settings[seg.dataset.setting]);
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === current));
  });
  els.toggleUnpriced.setAttribute('aria-checked', String(showUnpriced));
  [...els.radius.options].forEach((o) => { o.textContent = RADIUS_LABELS[state.settings.distUnit][o.value]; });

  let about = 'CheapGas · prices via Google Places · map © OpenStreetMap · CARTO · Esri';
  if (lastResponse?.mock) about += ' · running on sample data';
  else if (lastResponse) about += ` · API calls today ${lastResponse.budget.used}/${lastResponse.budget.limit}`;
  els.settingsAbout.textContent = about;
}

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

// ------------------------------------------------------------------ data
async function load() {
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
    if (state.follow) locateAndSearch({ silent: true });
    else if (state.center) load();
  }, mins * 60e3);
}

document.addEventListener('visibilitychange', () => {
  const mins = Number(state.settings.refreshMins);
  if (!mins || document.hidden || Date.now() - lastLoadedAt < mins * 60e3) return;
  if (state.follow) locateAndSearch({ silent: true });
  else if (state.center) load();
});

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
  return `<div class="gas-popup"><div class="pp-name">${esc(s.name)}</div>` +
    `<div class="pp-addr">${esc(s.address)} · ${fmtDist(s.distanceKm)}</div>${rows}` +
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

function makeCard(s, { tier, best, priced }) {
  const li = document.createElement('li');
  li.className = 'station-card' + (best ? ' cheapest' : '') + (priced ? '' : ' unpriced');
  li.setAttribute('role', 'button');
  li.tabIndex = 0;
  const price = priced
    ? `${best ? '<span class="best-chip">Best price</span>' : ''}<div class="price-big t-${tier}">${fmtPrice(s.prices[state.fuel])}</div><div class="price-age">${ago(s.prices[state.fuel].updated)}</div>`
    : `<div class="price-big">${fmtPrice(null)}</div><div class="price-age">no ${FUEL_LABELS[state.fuel].toLowerCase()} price</div>`;
  const domain = brandDomain(s.name);
  const badge = domain
    ? `<div class="monogram has-logo"><img loading="lazy" alt="" src="https://www.google.com/s2/favicons?domain=${domain}&sz=64"></div>`
    : `<div class="monogram" style="background:${monoColor(s.name)}">${esc(s.name.charAt(0))}</div>`;
  li.innerHTML =
    badge +
    `<div class="station-info"><div class="station-name">${esc(s.name)}</div>` +
    `<div class="station-sub">${fmtDist(s.distanceKm)} · ${esc(s.address)}</div></div>` +
    `<div class="station-price">${price}</div>`;
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
  const cls = priced ? `price-pill t-${tier}${best ? ' best' : ''}` : 'price-pill dot';
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

function render(recenter = false) {
  const fuel = state.fuel;
  const priced = stations.filter((s) => s.prices[fuel]);
  const byPrice = [...priced].sort((a, b) => a.prices[fuel].cents - b.prices[fuel].cents);
  const priceRank = new Map(byPrice.map((s, i) => [s.id, i]));
  const ordered = state.settings.sort === 'distance'
    ? [...priced].sort((a, b) => a.distanceKm - b.distanceKm)
    : byPrice;
  const unpriced = stations.filter((s) => !s.prices[fuel]);

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

  ordered.forEach((s) => wire(s, {
    tier: tierOf(priceRank.get(s.id), priced.length),
    best: priceRank.get(s.id) === 0,
    priced: true,
  }));
  if (showUnpriced) unpriced.forEach((s) => wire(s, { priced: false }));

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
    const src = lastResponse.mock ? 'sample data' : lastResponse.source === 'google' ? 'live' : 'cached';
    const stale = lastResponse.stale ? ' · ⚠ stale data (budget/API issue)' : '';
    const budget = lastResponse.mock ? '' : ` · API ${lastResponse.budget.used}/${lastResponse.budget.limit}`;
    els.meta.textContent =
      `${byPrice.length} station${byPrice.length === 1 ? '' : 's'} · ${FUEL_LABELS[fuel]} · ${radiusLabel()} around ${state.center.label} · ${hh} (${src})${budget}${stale}`;
    els.liveDot.classList.toggle('off', Boolean(lastResponse.mock || lastResponse.stale));
  }

  // ---- viewport
  if (recenter) {
    const pts = (byPrice.length ? byPrice : stations).map((s) => [s.lat, s.lng]);
    if (state.center) pts.push([state.center.lat, state.center.lng]);
    const pad = desktop
      ? { paddingTopLeft: [436, 36], paddingBottomRight: [36, 36] } // clear the floating panel
      : { padding: [24, 24] };
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { maxZoom: 14, ...pad });
    else if (state.center) map.setView([state.center.lat, state.center.lng], 12);
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
