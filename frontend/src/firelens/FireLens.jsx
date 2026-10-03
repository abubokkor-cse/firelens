// FireLens: harmonized MODIS × VIIRS burning-activity calendar — globe, calendar, anomalies and area reports.
import React from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './firelens.css';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000/api/v1';
// Pre-built reports on Cloudflare R2 / CDN (scripts/build_reports.py); empty = always ask the API.
const REPORTS_URL = (import.meta.env.VITE_REPORTS_URL || '').replace(/\/$/, '');
// ASCII report file name ('Curaçao' → 'curacao'); must match presets.slug() in the backend.
const slugOf = n => n.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
const COUNTRY_ALIAS = {};  // archive country names are Natural Earth ADMIN names, same as the globe's borders

const D = Math.PI / 180;
const hs = n => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const cd = (a, b, m) => { const d = Math.abs(a - b) % m; return Math.min(d, m - d); };
const REG = {
  Global: { lon: 20, lat: 12, sub: 'Whole planet', coord: '0.25° grid · 2000–present', span: 360, peak: 32, peak2: 2, p2w: .75, spread: 6, wk: 3200, seed: 1, cover: 'Mixed biomes' },
  Bangladesh: { country: 'Bangladesh', lon: 90.4, lat: 23.7, sub: 'South Asia', coord: '23.7°N, 90.4°E', span: 14, peak: 12, spread: 3, wk: 140, seed: 8, cover: 'Cropland / hill forest' },
  Amazon: { lon: -57.5, lat: -10, sub: 'Brazil · arc of deforestation', coord: '10.0°S, 57.5°W', span: 45, peak: 35, spread: 4, wk: 640, seed: 2, cover: 'Tropical forest edge' },
  California: { lon: -119.3, lat: 37.3, sub: 'Western United States', coord: '37.3°N, 119.3°W', span: 16, peak: 33, spread: 3, wk: 90, seed: 7, cover: 'Shrubland / conifer forest' },
  Argentina: { country: 'Argentina', lon: -63.6, lat: -34, sub: 'South America', coord: '34.0°S, 63.6°W', span: 40, peak: 36, spread: 5, wk: 500, seed: 9, cover: 'Grassland / delta wetland' },
  Australia: { country: 'Australia', lon: 134, lat: -22, sub: 'Oceania', coord: '22.0°S, 134.0°E', span: 50, peak: 40, spread: 5, wk: 420, seed: 6, cover: 'Tropical savanna' },
  India: { country: 'India', lon: 79, lat: 22, sub: 'South Asia', coord: '22.0°N, 79.0°E', span: 40, peak: 15, peak2: 44, p2w: .6, spread: 3.5, wk: 560, seed: 5, cover: 'Cropland / dry forest' },
  Thailand: { country: 'Thailand', lon: 101, lat: 15.5, sub: 'Southeast Asia', coord: '15.5°N, 101.0°E', span: 18, peak: 11, spread: 3.5, wk: 300, seed: 3, cover: 'Cropland / deciduous forest' },
  Canada: { country: 'Canada', lon: -100, lat: 56, sub: 'North America', coord: '56.0°N, 100.0°W', span: 60, peak: 30, spread: 4, wk: 400, seed: 11, cover: 'Boreal forest' },
  'SE Australia': { lon: 147, lat: -33, sub: 'Victoria · New South Wales', coord: '33.0°S, 147.0°E', span: 14, peak: 50, spread: 4, wk: 150, seed: 12, cover: 'Eucalypt forest' },
  Indonesia: { country: 'Indonesia', lon: 114, lat: -1.5, sub: 'Southeast Asia', coord: '1.5°S, 114.0°E', span: 48, peak: 36, spread: 4, wk: 400, seed: 10, cover: 'Peatland / plantation' },
};
const ORDER = Object.keys(REG);
ORDER.forEach(k => { REG[k].name = k; REG[k].scale = REG[k].scale || REG[k].wk / 3200; });
const QUICK = ['Bangladesh', 'Amazon', 'California'];
// Curated case studies
const CASES = [
  { region: 'Canada', year: 2023, page: 'calendar', title: 'Canada — the record 2023 wildfire season', note: 'Harmonized burning 5.4× the 2003–2025 mean — the highest of all 27 years' },
  { region: 'SE Australia', year: 2019, page: 'calendar', title: 'South-east Australia — Black Summer 2019–20', note: 'The biggest fire season on record there (5×); late December 2019 flagged EXTREME' },
  { region: 'California', year: 2020, page: 'calendar', title: 'California — the 2020 fire year', note: '3.7× the mean, highest in the record' },
  { region: 'Indonesia', year: 2015, page: 'calendar', title: 'Indonesia — the 2015 peatland fires', note: 'El Niño drought: 3.1× the mean, highest in the record' },
  { region: 'Bangladesh', year: 2022, page: 'harmonize', title: 'Bangladesh — a MODIS outage, caught', note: 'Aqua MODIS was offline 1–16 April 2022 at peak season; FireLens flags the year and follows VIIRS' },
  { region: 'Thailand', year: 2026, page: 'anomalies', title: 'Thailand 2026 — late start, then a surge', note: 'Quiet February–March, then April burning up to 4× normal; both sensors agree' },
];
const CHIP_IMG = { Bangladesh: 'https://flagcdn.com/w80/bd.png', Amazon: 'https://commons.wikimedia.org/wiki/Special:FilePath/Amazon_Manaus_forest.jpg?width=120', California: 'https://commons.wikimedia.org/wiki/Special:FilePath/Golden_Gate_Bridge_as_seen_from_Battery_East.jpg?width=120', Argentina: 'https://flagcdn.com/w80/ar.png', Australia: 'https://flagcdn.com/w80/au.png' };
const BBOX = { Canada: { west: -141, south: 41.7, east: -52.6, north: 83.1 }, 'SE Australia': { west: 140, south: -39, east: 154, north: -27 }, Amazon: { west: -65, south: -15, east: -50, north: -5 }, California: { west: -124.5, south: 32.5, east: -114, north: 42 }, Bangladesh: { west: 88, south: 20.6, east: 92.7, north: 26.6 }, Argentina: { west: -73.6, south: -55.1, east: -53.6, north: -21.8 }, Australia: { west: 112.9, south: -43.7, east: 153.7, north: -10.6 }, India: { west: 68.1, south: 6.7, east: 97.4, north: 35.5 }, Thailand: { west: 97.3, south: 5.6, east: 105.6, north: 20.5 }, Indonesia: { west: 95, south: -11, east: 141, north: 6 } };
const RAW = { Amazon: [72, 2051, 6127, 26268.2], California: [6, 131, 410, 1520], Bangladesh: [11, 236, 380, 1702], Global: [3120, 41880, 184000, 522000], Africa: [1310, 18200, 61000, 190000], 'Southeast Asia': [240, 5600, 11200, 48000], 'South Asia': [310, 6400, 9800, 41000], Australia: [150, 2900, 7600, 30100] };
const ALPHA = [['All', 'Ensemble', 4.2], ['Forest', 'Tropical / temperate forest', 4.2], ['Savanna', 'Savanna & grassland', 3.1], ['Cropland', 'Agricultural burning', 5.6], ['Shrubland', 'Shrub & chaparral', 3.6]];
const FIELDS = [['latitude, longitude', 'Both', 'Fire pixel centre, WGS84 decimal degrees'], ['brightness / bright_ti4', 'MODIS / VIIRS', 'Brightness temperature (K), 4 µm band'], ['bright_t31 / bright_ti5', 'MODIS / VIIRS', 'Background temperature (K), 11 µm band'], ['frp', 'Both', 'Fire radiative power (MW) — burning intensity'], ['confidence', 'Both', 'MODIS 0–100 %; VIIRS l / n / h'], ['acq_date, acq_time', 'Both', 'Overpass date and UTC time (HHMM)'], ['satellite', 'Both', 'Terra / Aqua (MODIS); N / N20 (VIIRS)'], ['scan, track', 'Both', 'Pixel footprint in km (≈1.3×1.1 vs 0.5×0.6)'], ['daynight', 'Both', 'D = day, N = night overpass'], ['version', 'Both', 'Collection, e.g. 6.1NRT / 2.0NRT']];
const ENDPOINTS = [['POST', '/calendar/report', 'Everything for one AOI: calendar, baseline, anomalies, outlook, calibration'], ['POST', '/calendar/generate', '52-week × 2000–present harmonized burning calendar'], ['POST', '/calendar/anomalies', 'Early/late onset, surge and suppression alerts'], ['POST', '/harmonize/calculate', 'Live MODIS + VIIRS window → harmonized count & FRP'], ['POST', '/fires/live', 'Raw NRT MODIS + VIIRS hotspots for a bbox'], ['GET', '/fires/global', 'Today\'s worldwide VIIRS detections on a grid'], ['GET', '/archive/grid', 'One archived year on a grid (harmonized / MODIS / VIIRS)'], ['GET', '/harmonize/model', 'Out-of-time validation of the harmonization model']];
const SEV = { CRITICAL: ['#ff4a3a', 'rgba(255,74,58,.14)'], WARNING: ['#ffa53a', 'rgba(255,165,58,.14)'], INFO: ['#5aa0ff', 'rgba(90,160,255,.14)'] };
const TYPE = { EARLY_ONSET: 'Early season onset', LATE_ONSET: 'Late season onset', EXTREME_FIRE_SURGE: 'Extreme fire surge', UNUSUAL_SUPPRESSION: 'Unusual suppression' };
const wkRange = (y, w) => { const f = d => new Date(Date.UTC(y, 0, 1 + d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); return f((w - 1) * 7) + '–' + f(w === 52 ? 364 : w * 7 - 1); };
const wkDate = (y, w) => new Date(Date.UTC(y, 0, 1 + (w - 1) * 7)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const ord = p => { p = Math.round(p); const s = (p % 10 === 1 && p !== 11) ? 'st' : (p % 10 === 2 && p !== 12) ? 'nd' : (p % 10 === 3 && p !== 13) ? 'rd' : 'th'; return p + s; };
const CLUSTERS = [[22,-8,11,6,700],[8,10,14,3,450],[-58,-9,9,5,380],[-48,-14,5,4,180],[101,17,6,4,340],[80,23,7,4,300],[90.4,23.8,1.3,1.2,90],[115,58,22,5,240],[131,-15,11,3,300],[-121,39,2.5,3.5,90],[-115,57,12,4,110],[112,-1,7,3,150],[-62,-29,6,6,120],[30,50,8,3,120],[-100,20,6,4,90],[28,-18,6,4,200]];
const STOPS = [[0,[18,26,61]],[.18,[31,43,107]],[.35,[90,42,122]],[.5,[176,40,63]],[.65,[229,64,42]],[.8,[255,122,26]],[1,[255,208,74]]];
const ramp = t => { t = Math.max(0, Math.min(1, t)); for (let i = 1; i < STOPS.length; i++) { if (t <= STOPS[i][0]) { const [a, ca] = STOPS[i-1], [b, cb] = STOPS[i]; const k = (t - a) / (b - a); return 'rgb(' + ca.map((v, j) => Math.round(v + (cb[j] - v) * k)).join(',') + ')'; } } return 'rgb(255,208,74)'; };
const fmt = n => Math.round(n).toLocaleString('en-US');
const fmtK = v => v >= 1000 ? (Math.round(v / 100) / 10) + 'K' : String(Math.round(v));
const niceStep = x => { const p = Math.pow(10, Math.floor(Math.log10(x))); const m = x / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; };
const LIVE_MAX_AGE = 30 * 60e3;  // a live report older than this is fetched again (the API refreshes areas every 30 min)
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// Quality flags
const QNOTE = { ADJUSTED: ' · scaled for missing satellite days', NOAA20: ' · S-NPP gap, filled with NOAA-20', MODIS: ' · VIIRS gap, filled with MODIS' };
const CUR_YEAR = new Date().getFullYear();
const MONTH_OF_WEEK = Array.from({ length: 52 }, (_, w) => new Date(Date.UTC(2001, 0, 1 + w * 7 + 3)).getUTCMonth());
const fmtMW = v => v == null ? '—' : v >= 1e6 ? (v / 1e6).toFixed(2) + ' TW' : v >= 1000 ? (v / 1000).toFixed(v >= 1e4 ? 1 : 2) + ' GW' : fmt(v) + ' MW';
const pctTxt = d => d == null ? '—' : (d >= 0 ? '↑ ' : '↓ ') + Math.abs(d).toFixed(0) + '%';
const upColor = d => d == null ? '#9fb0cc' : d >= 0 ? '#ff5a3a' : '#3ddc84';
// Divergent anomaly scale (blue = low, red = high)
const diverge = p => { const t = Math.max(-1, Math.min(1, (p - 50) / 45)), g = [44, 52, 72], to = t < 0 ? [59, 140, 255] : [255, 74, 42], k = Math.abs(t); return 'rgb(' + g.map((x, i) => Math.round(x + (to[i] - x) * k)).join(',') + ')'; };
const logT = (v, max) => Math.log1p(Math.max(0, v)) / Math.log1p(Math.max(1, max));
const path = (arr, X, Y) => { let out = '', pen = false; arr.forEach((v, i) => { if (v == null || Number.isNaN(v)) { pen = false; return; } out += (pen ? 'L' : 'M') + X(i) + ' ' + Y(v); pen = true; }); return out; };

const el2owner = map => map.getContainer().__owner;
export default class FireLens extends React.Component {
  static defaultProps = { useLiveApi: true, apiBase: API_BASE, autoRotate: true, showSatellites: true, showGlobeLabels: true, defaultRegion: 'Global' };
  state = { alert: { email: '', name: '', mode: 'region', radius: 25, lat: null, lon: null, strong: true, frp: 50, confirmed: false, unusual: false, delta: 50, freq: 'instant', consent: false },
    region: this.props.defaultRegion || 'Global', source: 'harmonized', year: CUR_YEAR, playing: false, tip: null, calMode: 'weekly', calMetric: 'count', mapZoom: 1, page: 'home', days: 1, landcover: 'All', sev: 'All', apiTick: 0 };
  store = {};
  yearGrid = {};  // archived year grids for the globe, keyed 'year|source'
  _yg = {};       // year grids being fetched
  fires = [];     // offline sample hotspots, filled in componentDidMount
  globeRef = React.createRef();
  satRef = React.createRef();
  heroInput = React.createRef();
  geoInput = React.createRef();   // hidden file input for GeoJSON areas
  headerSearch = React.createRef();
  drawCount = 0;
  mapRef = React.createRef();
  satT = 0;

  componentDidMount() {
    let s = 7; const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
    this.fires = [];
    CLUSTERS.forEach(([lo, la, sl, sa, n]) => { for (let i = 0; i < n; i++) { const lon = lo + gauss() * sl, lat = la + gauss() * sa; this.fires.push({ lon, lat, lr: lon * D, sl: Math.sin(lat * D), cl: Math.cos(lat * D), t: rnd(), small: rnd() < .45, inten: Math.pow(rnd(), 2.2) }); } });
    const sp = document.createElement('canvas'); sp.width = sp.height = 64; const sx = sp.getContext('2d');
    const g = sx.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,240,190,1)'); g.addColorStop(.15, 'rgba(255,170,60,.9)'); g.addColorStop(.4, 'rgba(255,80,20,.35)'); g.addColorStop(1, 'rgba(255,40,0,0)'); sx.fillStyle = g; sx.fillRect(0, 0, 64, 64); this.sprite = sp;
    this.ro = new ResizeObserver(() => this.resize()); if (this.globeRef.current) this.ro.observe(this.globeRef.current); if (this.mapRef.current) this.ro.observe(this.mapRef.current);
    this._ps = { ...this.state }; this._pp = { ...this.props };
    this.indexP = REPORTS_URL ? fetch(REPORTS_URL + '/index.json', { cache: 'no-cache' }).then(r => r.json()).then(d => ({ through: d.through, countries: d.countries, slugs: new Set(d.reports.map(x => x.slug)), countrySlugs: new Set(d.reports.filter(x => x.country).map(x => x.slug)) })).then(ix => { this.reportIndex = ix; return ix; }).catch(() => null) : null;
    this.resize(); this.loadLand(); this.fetchRegion(this.state.region); this.fetchGlobal();
    if (this.props.useLiveApi ?? true) this.api('/archive/regions', null, 'GET').then(d => { this.archive = d; this.setState(s => ({ apiTick: s.apiTick + 1 })); }, () => {});
    this._pf = setTimeout(() => ORDER.forEach(n => this.fetchReport(n)), 1200);
    this._onKey = e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.setState({ menuOpen: true }, () => this.headerSearch.current && this.headerSearch.current.focus());
      }
      if (e.key === 'Escape' && this.state.alertOpen) this.setState({ alertOpen: false });
    };
    window.addEventListener('keydown', this._onKey);
    // A page left open stays current: every 5 minutes the area on screen is refreshed if its data has aged.
    this._fresh = setInterval(() => { if (document.visibilityState === 'visible') this.fetchRegion(this.state.region); }, 5 * 60e3);
    this.initGlobe();
  }
  componentWillUnmount() { clearTimeout(this._gw); clearTimeout(this._pf); window.removeEventListener('keydown', this._onKey); clearInterval(this.playT); clearInterval(this._fresh); this.ro && this.ro.disconnect(); const gel = this.globeRef.current; if (!gel || !gel.isConnected) { if (this.map) this.map.remove(); if (gel) gel.__map = null; } }
  componentDidUpdate(ppIn) {
    const ps = this._ps || {}, pp = this._pp || ppIn || {}; this._ps = { ...this.state }; this._pp = { ...this.props };
    this.getMap();
    const s = this.state;
    if (s.region !== ps.region || s.source !== ps.source || s.year !== ps.year || s.mapZoom !== ps.mapZoom || s.apiTick !== ps.apiTick) this.drawMap();
    if (s.region !== ps.region || s.source !== ps.source || s.year !== ps.year || s.apiTick !== ps.apiTick || pp.showGlobeLabels !== this.props.showGlobeLabels) { try { this.updateGlobe(); } catch (err) { console.warn('updateGlobe: ' + (err && err.message)); } }
    if (s.year !== ps.year || s.source !== ps.source) this.fetchYearGrid();
    if (s.region !== ps.region || pp.autoRotate !== this.props.autoRotate) this.focusGlobe(1600);
    if (s.page !== ps.page && s.page === 'home') setTimeout(() => this.sizeGlobe(true), 30);
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.sizeGlobe();
    const m = this.mapRef.current; if (m && m.clientWidth) { this.ms = [m.clientWidth, m.clientHeight]; m.width = this.ms[0] * this.dpr; m.height = this.ms[1] * this.dpr; this.drawMap(); }
  }

  async loadLand() {
    try {
      const topo = await (await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json')).json();
      const { scale, translate } = topo.transform;
      const arcs = topo.arcs.map(a => { let x = 0, y = 0; return a.map(([dx, dy]) => { x += dx; y += dy; return [x * scale[0] + translate[0], y * scale[1] + translate[1]]; }); });
      const ap = i => i >= 0 ? arcs[i] : arcs[~i].slice().reverse();
      const ring = ids => { let p = []; ids.forEach((i, k) => { const a = ap(i); p = p.concat(k ? a.slice(1) : a); }); return p; };
      const polys = []; const o = topo.objects.land; const gs = o.type === 'GeometryCollection' ? o.geometries : [o];
      gs.forEach(g => { if (g.type === 'Polygon') polys.push(g.arcs.map(ring)); else if (g.type === 'MultiPolygon') g.arcs.forEach(p => polys.push(p.map(ring))); });
      const K = 4, lc = document.createElement('canvas'); lc.width = 360 * K; lc.height = 180 * K; const x = lc.getContext('2d');
      x.fillStyle = '#17243d'; x.strokeStyle = '#2c4268'; x.lineWidth = 1;
      const unwrap = r => { let prev = null, off = 0; return r.map(([lo, la]) => { if (prev != null) { const d = lo + off - prev; if (d > 180) off -= 360; else if (d < -180) off += 360; } prev = lo + off; return [prev, la]; }); };
      polys.forEach(p => {
        const rs = p.map(unwrap);
        if (rs[0].some(([, la]) => la < -85)) { x.beginPath(); rs[0].forEach(([lo, la], i) => { const px = (lo + 180) * K, py = (90 - la) * K; i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.lineTo(lc.width, lc.height); x.lineTo(0, lc.height); x.fill(); return; }
        [-360, 0, 360].forEach(o => { x.beginPath(); rs.forEach(r => r.forEach(([lo, la], i) => { const px = (lo + o + 180) * K, py = (90 - la) * K; i ? x.lineTo(px, py) : x.moveTo(px, py); })); x.fill('evenodd'); x.stroke(); });
      });
      this.landCanvas = lc;
      const data = x.getImageData(0, 0, lc.width, lc.height).data;
      this.landData = data; this.landW = lc.width; this._gk = null; this.updateGlobe();
      const lon = [], sl = [], cl = [];
      for (let la = -84; la <= 84; la += .9) { const step = .9 / Math.max(Math.cos(la * D), .2); for (let lo = -180; lo < 180; lo += step) { const px = Math.floor((lo + 180) * K), py = Math.floor((90 - la) * K); if (data[(py * lc.width + px) * 4 + 3] > 0) { lon.push(lo * D); sl.push(Math.sin(la * D)); cl.push(Math.cos(la * D)); } } }
      this.land = { lon: Float32Array.from(lon), sl: Float32Array.from(sl), cl: Float32Array.from(cl), n: lon.length };
      this.drawMap();
    } catch (e) { console.warn('land data unavailable', e); }
  }

  dens(y) { return .4 + .6 * (y - 2000) / 26 + (hs(y) - .5) * .08; }

  initGlobe() {
    const el = this.globeRef.current; if (!el) return;
    el.__owner = this;
    if (el.__map) { this.map = el.__map; this.mapReady = !!el.__ready; if (!el.__ready) return; this._gk = null; this.sizeGlobe(); this.updateGlobe(); this.focusGlobe(0); return; }
    try { this._initMap(el); } catch (err) { console.warn('map init failed: ' + (err && err.message)); }
  }
  _initMap(el) {
    const ml = maplibregl;
    const style = {
      version: 8,
      projection: { type: 'globe' },
      sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] },
      sources: {
        sat: { type: 'raster', tileSize: 256, maxzoom: 18, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] },
        ref: { type: 'raster', tileSize: 256, maxzoom: 13, tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'] },
        countries: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, generateId: true },
        fires: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        aoi: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': 'rgba(0,0,0,0)' } },  // transparent: the globe floats in the page's star field
        { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-saturation': -.15, 'raster-brightness-max': .85, 'raster-contrast': .1 } },
        { id: 'country-fill', type: 'fill', source: 'countries', paint: { 'fill-color': '#ffffff', 'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], .12, 0] } },
        { id: 'ref', type: 'raster', source: 'ref', paint: { 'raster-opacity': .85 } },
        { id: 'aoi-fill', type: 'fill', source: 'aoi', paint: { 'fill-color': '#ff6a1a', 'fill-opacity': .14 } },
        { id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': '#ffc04a', 'line-width': 2.2 } },
        { id: 'fire-heat', type: 'heatmap', source: 'fires', maxzoom: 7, paint: {
          'heatmap-weight': ['get', 'w'],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, .8, 6, 2.2],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 5, 3, 12, 6, 22],
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 4, .95, 7, 0],
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', .15, 'rgba(176,40,63,.55)', .35, 'rgba(229,64,42,.8)', .6, 'rgba(255,122,26,.92)', .85, 'rgba(255,208,74,.97)', 1, 'rgba(255,245,200,1)'] } },
        { id: 'fire-pts', type: 'circle', source: 'fires', minzoom: 3.5, paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3.5, ['+', 1.5, ['*', 2.5, ['get', 'w']]], 9, ['+', 4, ['*', 7, ['get', 'w']]]],
          'circle-color': ['interpolate', ['linear'], ['get', 'w'], 0, '#e5402a', .5, '#ff8a1f', 1, '#ffd04a'],
          'circle-blur': .35, 'circle-stroke-width': .6, 'circle-stroke-color': 'rgba(255,240,200,.7)',
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], 3.5, 0, 5, .95] } },
      ],
    };
    const map = new ml.Map({ container: el, style, center: [40, 15], zoom: 1.35, attributionControl: { compact: true }, canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true }, dragRotate: false, maxPitch: 0 });
    this.map = map; el.__map = map; const me = () => el.__owner || this;
    map.addControl(new ml.NavigationControl({ showCompass: false }), 'bottom-right');
    map.on('load', () => {
      el.querySelectorAll('.maplibregl-ctrl-attrib.maplibregl-compact-show').forEach(n => n.classList.remove('maplibregl-compact-show'));
      me().mapReady = true; el.__ready = true; me().sizeGlobe(); me().updateGlobe(); me().focusGlobe(0);
      fetch('https://cdn.jsdelivr.net/gh/vasturiano/react-globe.gl@master/example/datasets/ne_110m_admin_0_countries.geojson').then(r => r.json()).then(gj => {
        gj.features = gj.features.filter(f => f.properties.ISO_A2 !== 'AQ');
        me().countries = gj.features; map.getSource('countries').setData(gj);
      }).catch(() => {});
    });
    let hov = null;
    map.on('mousemove', 'country-fill', e => { const f = e.features[0]; if (!f) return; if (hov !== null && hov !== f.id) map.setFeatureState({ source: 'countries', id: hov }, { hover: false }); hov = f.id; map.setFeatureState({ source: 'countries', id: hov }, { hover: true }); map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'country-fill', () => { if (hov !== null) map.setFeatureState({ source: 'countries', id: hov }, { hover: false }); hov = null; map.getCanvas().style.cursor = ''; });
    map.on('click', e => {
      const fs = map.queryRenderedFeatures(e.point, { layers: ['country-fill'] });
      if (fs[0]) { const src = (me().countries || []).find(c => (c.properties.ADMIN || c.properties.NAME) === (fs[0].properties.ADMIN || fs[0].properties.NAME)); if (src) me().pickCountry({ name: src.properties.ADMIN || src.properties.NAME, geometry: src.geometry, lx: src.properties.LABEL_X, ly: src.properties.LABEL_Y }); }
      else me().dropAoi(e.lngLat.lat, e.lngLat.lng);
    });
    const stopSpin = () => { me().userBusy = true; clearTimeout(me()._ub); me()._ub = setTimeout(() => { me().userBusy = false; }, 2500); };
    map.on('dragstart', stopSpin); map.on('touchstart', stopSpin); map.on('wheel', stopSpin);
    let last = performance.now(), vel = 1;
    const SATS = [
      { name: 'MODIS · Terra', col: '255,176,32', inc: 64, node: -28, speed: .00016, ph: 0, rr: 1.3 },
      { name: 'MODIS · Aqua', col: '255,138,31', inc: 64, node: 152, speed: .00016, ph: 2.1, rr: 1.3 },
      { name: 'VIIRS · S-NPP', col: '120,200,255', inc: 72, node: 30, speed: .00021, ph: 1.0, rr: 1.46 },
      { name: 'VIIRS · NOAA-20', col: '160,220,255', inc: 72, node: 210, speed: .00021, ph: 4.2, rr: 1.46 },
    ];
    const drawSats = now => {
      const cv = o0().satRef.current; if (!cv) return;
      const W = cv.clientWidth, H = cv.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
      const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
      const z = map.getZoom(), fade = Math.max(0, Math.min(1, (2.6 - z) / .8)); if (fade <= 0 || !(o0().props.showSatellites ?? true)) return;
      const r = 512 * Math.pow(2, z) / (2 * Math.PI) * (W / map.getContainer().clientWidth), cx = W / 2, cy = H / 2;
      const P = (s, t) => { const i = s.inc * Math.PI / 180, n = s.node * Math.PI / 180, R0 = r * s.rr; let X = Math.cos(t) * R0, Y = Math.sin(t) * R0 * Math.sin(i), Zz = Math.sin(t) * R0 * Math.cos(i); const X2 = X * Math.cos(n) - Zz * Math.sin(n), Z2 = X * Math.sin(n) + Zz * Math.cos(n); return { x: cx + X2 * .95, y: cy - Y * .42 - X2 * .12, z: Z2 }; };
      const hidden = p => p.z < 0 && Math.hypot(p.x - cx, p.y - cy) < r;
      x.globalAlpha = fade;
      SATS.forEach(s => {
        x.lineWidth = 1;
        for (let k = 0; k < 120; k++) { const p1 = P(s, k / 120 * 6.283), p2 = P(s, (k + 1) / 120 * 6.283); if (hidden(p1)) continue; x.strokeStyle = 'rgba(' + s.col + ',' + (p1.z < 0 ? .12 : .32) + ')'; x.beginPath(); x.moveTo(p1.x, p1.y); x.lineTo(p2.x, p2.y); x.stroke(); }
        const t = s.ph + now * s.speed, p = P(s, t); if (hidden(p)) return;
        for (let k = 1; k < 14; k++) { const q = P(s, t - k * .025); if (hidden(q)) break; x.fillStyle = 'rgba(' + s.col + ',' + (.5 * (1 - k / 14)) + ')'; x.beginPath(); x.arc(q.x, q.y, 2.2 * (1 - k / 16), 0, 6.283); x.fill(); }
        const g = x.createRadialGradient(p.x, p.y, 0, p.x, p.y, 12); g.addColorStop(0, 'rgba(' + s.col + ',.9)'); g.addColorStop(1, 'rgba(' + s.col + ',0)'); x.fillStyle = g; x.beginPath(); x.arc(p.x, p.y, 12, 0, 6.283); x.fill();
        x.fillStyle = '#fff'; x.fillRect(p.x - 2.5, p.y - 1.5, 5, 3); x.fillStyle = 'rgba(' + s.col + ',1)'; x.fillRect(p.x - 8, p.y - 1, 4.5, 2); x.fillRect(p.x + 3.5, p.y - 1, 4.5, 2);
        x.font = '600 10.5px Manrope, sans-serif'; x.fillStyle = 'rgba(' + s.col + ',.95)'; x.fillText(s.name, p.x + 11, p.y - 7);
      });
      x.globalAlpha = 1;
    };
    const o0 = () => me();
    const spin = now => {
      if (!el.isConnected) return; const o = me(); o.map = map; now = now || performance.now();
      const dt = Math.min(64, now - last); last = now;
      const want = o.mapReady && o.state.region === 'Global' && (o.props.autoRotate ?? true) && !o.userBusy && !o.state.playing && map.getZoom() < 3.2 ? 1 : 0;
      vel += (want - vel) * Math.min(1, dt / 700);
      if (vel > .002 && !map.isMoving()) { const c = map.getCenter(); map.jumpTo({ center: [c.lng + vel * dt * .006, c.lat] }); }
      try { drawSats(now); } catch (e) {}
      el.__spin = requestAnimationFrame(spin);
    };
    el.__spin = requestAnimationFrame(spin);
  }
  getMap() { const el = this.globeRef && this.globeRef.current; if (el) el.__owner = this; const m = el && el.__map; if (m) { this.map = m; this.mapReady = !!el.__ready; } return m && el.__ready ? m : null; }
  sizeGlobe() { const m = this.getMap(); if (m) m.resize(); }
  focusGlobe(ms) {
    const map = this.getMap(); if (!map) return; const st = this.state, R = REG[st.region], bb = BBOX[st.region]; map.stop();
    if (st.region === 'Global') { map.flyTo({ center: [40, 15], zoom: 1.35, duration: ms || 0, essential: true }); return; }
    if (bb) map.fitBounds([[bb.west, bb.south], [bb.east, bb.north]], { padding: 50, duration: ms || 0, maxZoom: 9, essential: true });
    else map.flyTo({ center: [R.lon, R.lat], zoom: Math.max(2, Math.min(8, 7 - Math.log2(R.span / 4))), duration: ms || 0, essential: true });
  }
  updateGlobe() {
    const map = this.getMap(); if (!map || !this.fires || !map.getSource('fires')) return; const st = this.state, R = REG[st.region];
    const e = this.store[st.region], live = st.year === CUR_YEAR && e && e.fires && e.fires.length ? e.fires : null, bb = BBOX[st.region];
    const grid = this.globeCells(), sample = this.isSample();
    const key = [st.year, st.source, st.region, st.apiTick, !!this.landData, grid ? grid.cells.length : -1, sample].join('|');
    if (this._gk !== key) {
      this._gk = key; const feats = [];
      const inBB = (lon, lat) => bb && lon >= bb.west && lon <= bb.east && lat >= bb.south && lat <= bb.north;
      if (grid) {
        for (const [lat, lon, v] of grid.cells) { if (live && inBB(lon, lat)) continue; feats.push({ type: 'Feature', properties: { w: +(.12 + .88 * logT(v, grid.max)).toFixed(2) }, geometry: { type: 'Point', coordinates: [lon, lat] } }); }
      } else if (sample) {
        const dn = this.dens(st.year);
        for (const f of this.fires) {
          if (f.t > dn) continue; if (st.source === 'modis' && f.small) continue; if (st.source === 'viirs' && st.year < 2012) continue; if (live && inBB(f.lon, f.lat)) continue;
          if (this.landData) { const lw = this.landW, ix = Math.floor((f.lon + 180) * 4), iy = Math.floor((90 - f.lat) * 4); if (ix < 0 || iy < 0 || ix >= lw || this.landData[(iy * lw + ix) * 4 + 3] === 0) continue; }
          feats.push({ type: 'Feature', properties: { w: +(.15 + f.inten * .85).toFixed(2) }, geometry: { type: 'Point', coordinates: [f.lon, f.lat] } });
        }
      }
      if (live) live.forEach(f => { if (st.source === 'modis' && f.sensor !== 'MODIS') return; if (st.source === 'viirs' && f.sensor === 'MODIS') return; const k = Math.min(1, Math.log10(1 + f.frp) / 2.3); feats.push({ type: 'Feature', properties: { w: +(.25 + k * .75).toFixed(2), frp: f.frp, sensor: f.sensor }, geometry: { type: 'Point', coordinates: [f.lng, f.lat] } }); });
      map.getSource('fires').setData({ type: 'FeatureCollection', features: feats });
    }
    let aoi = { type: 'FeatureCollection', features: [] };
    if (st.region !== 'Global') {
      const geo = this.aoiGeo && this.aoiGeo[st.region], b = bb || { west: R.lon - R.span / 4, east: R.lon + R.span / 4, south: R.lat - R.span / 6, north: R.lat + R.span / 6 };
      aoi.features.push({ type: 'Feature', properties: {}, geometry: geo || { type: 'Polygon', coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]] } });
    }
    map.getSource('aoi').setData(aoi);
    (map.__markers || []).forEach(m => m.remove()); map.getContainer().querySelectorAll('.maplibregl-marker').forEach(n => n.remove()); map.__markers = this.markers = [];
    const labels = (this.props.showGlobeLabels ?? true) ? ORDER.filter(n => n !== 'Global' && n !== st.region).map(n => ({ name: n, lat: REG[n].lat, lng: REG[n].lon, txt: this.labelTxt(n), act: false, pick: () => this.setRegion(n) })) : [];
    if (st.region !== 'Global') labels.push({ name: st.region, lat: R.lat, lng: R.lon, txt: this.labelTxt(st.region, true), act: true, pick: () => this.go('harmonize') });
    const seen = new Set(); labels.filter(d => !seen.has(d.name) && seen.add(d.name)).forEach(d => { const m = new maplibregl.Marker({ element: this.labelEl(d), anchor: 'left', opacityWhenCovered: '0' }).setLngLat([d.lng, d.lat]).addTo(map); this.markers.push(m); });
    if (!map.__flip) { map.__flip = true; map.on('move', () => { const o = el2owner(map); o && o.flipLabels(); }); }
    this.flipLabels();
  }
  labelTxt(n, active) {
    const e = this.store[n], s = e && e.report && e.report.summary;
    if (active && e && e.liveTotals && this.state.year === CUR_YEAR) return (e.liveTotals.modis + e.liveTotals.viirs) ? fmt(e.liveTotals.modis + e.liveTotals.viirs) + ' live detections · ' + this.state.days + ' d' : 'No live fires · ' + this.state.days + ' d';
    if (s) return 'Wk ' + s.week + ': ' + fmt(s.harmonized_week) + ' fires · ' + s.season.toLowerCase();
    if (e && e.noArchive) return 'Live FIRMS only';
    return active ? 'Area of interest' : '26-year record';
  }
  globeCells() {
    const st = this.state;
    if (st.year === CUR_YEAR && st.source !== 'modis' && this.liveGlobal) return this.liveGlobal;
    return this.yearGrid[st.year + '|' + st.source] || null;
  }
  isSample() { if (!(this.props.useLiveApi ?? true)) return true; const e = this.store[this.state.region]; return !!(this.offline || (e && e.reportErr && !e.report)); }

  flipLabels() {
    const map = this.map; if (!map || !this.markers) return; const W = map.getContainer().clientWidth;
    this.markers.forEach(m => { const p = map.project(m.getLngLat()), inner = m.getElement().firstChild; if (!inner) return; const f = p.x > W * .58; if (inner.__f === f) return; inner.__f = f; inner.style.left = f ? 'auto' : '-7px'; inner.style.right = f ? '-7px' : 'auto'; inner.style.flexDirection = f ? 'row-reverse' : 'row'; });
  }
  labelEl(d) {
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const el = document.createElement('div'); el.style.cssText = 'width:0;height:0;pointer-events:auto;cursor:pointer';
    el.innerHTML = '<div style="position:absolute;left:-7px;top:0;transform:translateY(-50%);display:flex;align-items:center;gap:8px;font-family:Manrope,sans-serif;line-height:1.25"><span style="display:block;width:12px;height:12px;box-sizing:border-box;border-radius:50%;background:#ff3b2a;border:2px solid #fff;box-shadow:0 0 12px #ff3b2a;flex:none"></span><span style="padding:6px 10px;border-radius:8px;white-space:nowrap;background:' + (d.act ? 'rgba(40,18,10,.92)' : 'rgba(10,14,24,.85)') + ';border:1px solid ' + (d.act ? 'rgba(255,106,26,.85)' : 'rgba(255,255,255,.15)') + '"><b style="display:block;font:600 12px \'Space Grotesk\',sans-serif;color:#fff">' + esc(d.name) + '</b><span style="font-size:11px;font-weight:600;color:#ff7a4a">' + esc(d.txt) + '</span></span></div>';
    el.onclick = ev => { ev.stopPropagation(); d.pick(); };
    return el;
  }
  makeRegion(name, lat, lon, bb, sub) {
    const dx = Math.abs(bb.east - bb.west), dy = Math.abs(bb.north - bb.south), area = Math.max(1, dx * dy), sd = Math.floor(hs(lat * 13 + lon) * 1000);
    const wk = Math.round(Math.max(20, Math.min(3000, area * 5))), pct = Math.round(55 + hs(sd) * 42), dl = Math.round((hs(sd + 1) - .35) * 40);
    REG[name] = { name, lon, lat, sub, coord: Math.abs(lat).toFixed(1) + '°' + (lat >= 0 ? 'N' : 'S') + ', ' + Math.abs(lon).toFixed(1) + '°' + (lon >= 0 ? 'E' : 'W'), peak: lat > 20 ? 15 : lat >= 0 ? 11 : 36, spread: 3.5, fires: wk * 6, delta: dl, frp: fmt(wk * 1.8) + ' MW', frpD: dl + 4, pct: ord(pct), status: pct > 80 ? 'Active' : 'Normal', statusSub: pct > 80 ? 'Above-normal burning' : 'Within seasonal range', cover: 'Mixed', scale: Math.max(.01, Math.min(1, area / 1500)), span: Math.max(5, Math.min(120, Math.max(dx, dy) * 1.8)), wk, seed: sd };
    BBOX[name] = bb; RAW[name] = [Math.round(wk * .12), Math.round(wk * 2.6), wk * 5, wk * 19];
  }
  async searchPlace(q) {
    q = (q || '').trim(); if (!q) return;
    const hit = ORDER.find(n => n.toLowerCase() === q.toLowerCase()) || Object.keys(REG).find(n => n.toLowerCase() === q.toLowerCase());
    if (hit) { this.setRegion(hit); this.setState({ searchMsg: '' }); return; }
    this.setState({ searchMsg: 'Searching “' + q + '”…', searchErr: false });
    try {
      const r = await (await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&polygon_geojson=1&polygon_threshold=0.02&q=' + encodeURIComponent(q))).json();
      if (!r || !r[0]) throw new Error('none');
      const p = r[0], [s, n, w, e] = p.boundingbox.map(Number), name = p.name || p.display_name.split(',')[0];
      const bb = { west: Math.max(-180, w), south: Math.max(-90, s), east: Math.min(180, e), north: Math.min(90, n) };
      this.makeRegion(name, +p.lat, +p.lon, bb, p.display_name.split(',').slice(1, 3).join(',').trim() || p.type);
      this.aoiGeo = this.aoiGeo || {}; if (p.geojson && /Polygon/.test(p.geojson.type)) this.aoiGeo[name] = p.geojson;
      if (this.archive && this.archive.countries.some(x => x.country === name)) REG[name].country = name;
      this.setRegion(name); this.setState({ searchMsg: 'Showing ' + name + ' — fetching hotspots for this area', searchErr: false });
    } catch (err) { this.setState({ searchMsg: 'No match for “' + q + '”. Try a country, province or park name.', searchErr: true }); }
  }
  pickCountry(c) {
    let w = 180, e = -180, s = 90, n = -90;
    const walk = a => { if (typeof a[0] === 'number') { w = Math.min(w, a[0]); e = Math.max(e, a[0]); s = Math.min(s, a[1]); n = Math.max(n, a[1]); } else a.forEach(walk); };
    walk(c.geometry.coordinates);
    if (e - w > 180) { w = -180; e = 180; }
    const lon = c.lx != null ? c.lx : (w + e) / 2, lat = c.ly != null ? c.ly : (s + n) / 2;
    this.makeRegion(c.name, lat, lon, { west: w, south: s, east: e, north: n }, 'Country');
    if (this.archive && this.archive.countries.some(x => x.country === c.name)) REG[c.name].country = c.name;
    this.aoiGeo = this.aoiGeo || {}; this.aoiGeo[c.name] = c.geometry;
    this.setRegion(c.name); this.setState({ searchMsg: 'Showing ' + c.name + ' — fetching hotspots for this country', searchErr: false });
  }
  // ── fire alerts by email ─────────────────────────────────────────────────────
  alertArea() {
    const st = this.state, R = REG[st.region] || {}, a = st.alert;
    if (a.mode === 'location') return a.lat == null ? null : { name: 'your location', lat: a.lat, lon: a.lon, radius_km: a.radius };
    if (st.region === 'Global') return null;
    return R.country ? { name: st.region, country: R.country } : BBOX[st.region] ? { name: st.region, bbox: BBOX[st.region] } : null;
  }
  openAlerts() {
    const st = this.state, R = REG[st.region] || {};
    const regionOk = st.region !== 'Global' && !!(R.country || BBOX[st.region]);
    this.setState(s => ({ alertOpen: true, menuOpen: false, alertMsg: '', alertErr: false, alertDone: false, alert: { ...s.alert, mode: regionOk ? 'region' : 'location' } }));
  }
  setAlert(k, val) { this.setState(s => ({ alert: { ...s.alert, [k]: val }, alertMsg: '', alertErr: false })); }
  locateForAlerts() {
    if (!navigator.geolocation) { this.setState({ alertMsg: 'Your browser cannot share its location.', alertErr: true }); return; }
    this.setState({ alertMsg: 'Finding your location…', alertErr: false });
    navigator.geolocation.getCurrentPosition(
      p => this.setState(s => ({ alert: { ...s.alert, mode: 'location', lat: +p.coords.latitude.toFixed(4), lon: +p.coords.longitude.toFixed(4) }, alertMsg: '' })),
      () => this.setState({ alertMsg: 'Your location is not available — use the selected area instead.', alertErr: true }), { timeout: 10000 });
  }
  async submitAlerts(ev) {
    ev.preventDefault();
    const a = this.state.alert, area = this.alertArea(), fail = m => this.setState({ alertMsg: m, alertErr: true });
    if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(a.email.trim())) return fail('Please enter a valid email address.');
    if (!area) return fail(a.mode === 'location' ? 'Tap “Use my location” first.' : 'Pick a country or place first — alerts for the whole planet are not offered.');
    if (!(a.strong || a.confirmed || a.unusual)) return fail('Choose at least one kind of alert.');
    if (!a.consent) return fail('Please tick the box to agree to alert emails.');
    this.setState({ alertBusy: true, alertMsg: '', alertErr: false });
    try {
      const r = await this.api('/alerts/subscribe', { email: a.email.trim(), name: a.name.trim() || null, area, frequency: a.freq, consent: true,
        types: { strong_fire: a.strong, min_frp_mw: a.frp, confirmed_fire: a.confirmed, unusual: a.unusual, min_delta_pct: a.delta } });
      this.setState({ alertDone: true, alertMsg: r.message });
    } catch (err) { fail(err.message && !/^HTTP|abort/i.test(err.message) ? err.message : 'Could not reach FireLens — please try again.'); }
    this.setState({ alertBusy: false });
  }
  alertVals() {
    const st = this.state, a = st.alert, R = REG[st.region] || {};
    const regionOk = st.region !== 'Global' && !!(R.country || BBOX[st.region]);
    const opt = (on, dis) => ({ background: on ? 'rgba(255,106,26,.12)' : 'rgba(255,255,255,.03)', border: '1px solid ' + (on ? 'rgba(255,106,26,.7)' : 'rgba(130,160,210,.2)'), opacity: dis ? .5 : 1 });
    return {
      alertOpen: !!st.alertOpen, openAlerts: () => this.openAlerts(), closeAlerts: () => this.setState({ alertOpen: false }),
      submitAlerts: ev => this.submitAlerts(ev), alertBusy: !!st.alertBusy, alertDone: !!st.alertDone, alertMsg: st.alertMsg || '', alertMsgColor: st.alertErr ? '#ff8a6a' : '#9fb0cc',
      a, setA: k => ev => this.setAlert(k, ev.target.type === 'checkbox' ? ev.target.checked : ev.target.type === 'select-one' && k !== 'freq' ? +ev.target.value : ev.target.value),
      aRegionLabel: regionOk ? st.region : 'Choose a country or place first', aRegionOk: regionOk, aRegionStyle: opt(a.mode === 'region', !regionOk), aLocStyle: opt(a.mode === 'location'),
      pickRegion: () => regionOk && this.setAlert('mode', 'region'), pickLoc: () => { this.setAlert('mode', 'location'); if (a.lat == null) this.locateForAlerts(); },
      aLocLabel: a.lat == null ? 'Use my location' : a.lat.toFixed(2) + '°, ' + a.lon.toFixed(2) + '°',
      freqTabs: [['instant', 'Right away', 'checked every hour'], ['daily', 'Daily summary', 'at most one email a day']].map(([k, l, d]) => ({ key: k, label: l, desc: d, style: opt(a.freq === k), onClick: () => this.setAlert('freq', k) })),
    };
  }
  nearMe() {
    const fail = () => {
      this.setState({ menuOpen: false, searchMsg: 'Your location is not available — search a place instead.', searchErr: true });
      const el = document.getElementById('top'); if (el) window.scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(() => this.heroInput.current && this.heroInput.current.focus(), 400);
    };
    if (!navigator.geolocation) { fail(); return; }
    this.setState({ searchMsg: 'Finding your location…', searchErr: false });
    navigator.geolocation.getCurrentPosition(pos => {
      const lat = pos.coords.latitude, lon = pos.coords.longitude, dLon = 1 / Math.max(0.2, Math.cos(lat * Math.PI / 180));
      const name = 'Near me';
      this.makeRegion(name, lat, lon, { west: Math.max(-180, lon - dLon), south: Math.max(-89, lat - 1), east: Math.min(180, lon + dLon), north: Math.min(89, lat + 1) }, 'Around your location · ~220 km');
      if (this.store[name]) delete this.store[name];
      this.setRegion(name);
      this.setState({ page: 'home', menuOpen: false, searchMsg: 'Showing fires within ~110 km of you', searchErr: false });
      setTimeout(() => { const el = document.getElementById('explore'); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' }); }, 80);
    }, fail, { timeout: 10000, maximumAge: 600000 });
  }
  dropAoi(lat, lng) {
    const name = 'AOI ' + Math.abs(lat).toFixed(1) + '°' + (lat >= 0 ? 'N' : 'S') + ' ' + Math.abs(lng).toFixed(1) + '°' + (lng >= 0 ? 'E' : 'W');
    this.makeRegion(name, lat, lng, { west: lng - 2.5, south: lat - 2, east: lng + 2.5, north: lat + 2 }, 'Custom area of interest');
    this.setRegion(name);
  }

  drawMap() {
    const c = this.mapRef.current; if (!c || !this.ms) return;
    const [W, H] = this.ms, ctx = c.getContext('2d'); ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const st = this.state, R = REG[st.region];
    const span = Math.min(360, R.span / st.mapZoom), latSpan = span * H / W;
    const lonC = st.region === 'Global' ? 10 : R.lon, latC = st.region === 'Global' ? 12 : R.lat;
    const lonMin = lonC - span / 2, latMax = latC + latSpan / 2;
    const px = lo => (lo - lonMin) / span * W, py = la => (latMax - la) / latSpan * H;
    this.mapProj = { lonMin, latMax, span, latSpan, W, H };
    ctx.fillStyle = '#050a14'; ctx.fillRect(0, 0, W, H);
    if (this.landCanvas) ctx.drawImage(this.landCanvas, (lonMin + 180) * 4, (90 - latMax) * 4, span * 4, latSpan * 4, 0, 0, W, H);
    const gstep = span > 120 ? 30 : span > 30 ? 10 : 2; ctx.strokeStyle = 'rgba(130,160,210,.08)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let lo = Math.ceil(lonMin / gstep) * gstep; lo < lonMin + span; lo += gstep) { ctx.moveTo(px(lo), 0); ctx.lineTo(px(lo), H); }
    for (let la = Math.floor(latMax / gstep) * gstep; la > latMax - latSpan; la -= gstep) { ctx.moveTo(0, py(la)); ctx.lineTo(W, py(la)); } ctx.stroke();
    const noV = st.source === 'viirs' && st.year < 2012;
    const live = st.year === CUR_YEAR ? (this.store[st.region] || {}).fires : null, grid = this.globeCells();
    const off = (x, y) => x < -10 || x > W + 10 || y < -10 || y > H + 10;
    ctx.globalCompositeOperation = 'lighter';
    if (grid && !noV) {
      const base = Math.max(1.6, Math.min(16, W / span * grid.cell * .8));
      for (const [lat, lon, v] of grid.cells) { const x = px(lon), y = py(lat); if (off(x, y)) continue; const s = base * (.45 + 1.3 * logT(v, grid.max)); ctx.drawImage(this.sprite, x - s, y - s, s * 2, s * 2); }
    } else if (!noV && this.isSample()) {
      const dn = this.dens(st.year), base = Math.max(1.6, Math.min(9, W / span * .9));
      for (const f of this.fires) {
        if (f.t > dn) continue; if (st.source === 'modis' && f.small) continue;
        const x = px(f.lon), y = py(f.lat); if (off(x, y)) continue;
        const s = base * (st.source === 'modis' ? 1.5 : st.source === 'viirs' ? .8 : 1) * (1 + f.inten * 2.2);
        ctx.drawImage(this.sprite, x - s, y - s, s * 2, s * 2);
      }
    }
    if (live && live.length) {
      for (const f of live) { if (st.source === 'modis' && f.sensor !== 'MODIS') continue; if (st.source === 'viirs' && f.sensor === 'MODIS') continue; const x = px(f.lng), y = py(f.lat); if (off(x, y)) continue; const s = 3 + Math.min(10, Math.log10(1 + f.frp) * 4); ctx.globalAlpha = f.cor === 'POSSIBLE' ? .35 : f.cor === 'LIKELY' ? .7 : 1; ctx.drawImage(this.sprite, x - s, y - s, s * 2, s * 2); }
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'source-over';
    if (st.region !== 'Global') { ctx.setLineDash([5, 5]); ctx.strokeStyle = 'rgba(255,140,60,.8)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(px(R.lon), py(R.lat), Math.min(W, H) * .18, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
    if (noV) { ctx.fillStyle = 'rgba(5,10,20,.55)'; ctx.fillRect(0, 0, W, H); ctx.font = '600 15px "Space Grotesk"'; ctx.fillStyle = '#ffb27a'; ctx.textAlign = 'center'; ctx.fillText('VIIRS record begins 2012 — switch to Harmonized', W / 2, H / 2); ctx.textAlign = 'left'; }
  }

  setRegion(r) { if (!REG[r]) return; this.setState({ region: r, mapZoom: 1 }); this.fetchRegion(r); }

  async api(path, body, method = 'POST') {
    const base = this.props.apiBase ?? API_BASE;
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 30000);
    try {
      const init = method === 'GET' ? { signal: ac.signal } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? null), signal: ac.signal };
      const r = await fetch(base + path, init);
      if (!r.ok) { let d = ''; try { d = (await r.json()).detail; } catch (_) { /* no JSON body */ } const err = new Error(d || 'HTTP ' + r.status); err.status = r.status; throw err; }
      return await r.json();
    } finally { clearTimeout(t); }
  }
  async fetchGlobal() {
    if (!(this.props.useLiveApi ?? true)) { this.offline = true; return; }
    try { const d = await this.api('/fires/global?days=1', null, 'GET'); this.liveGlobal = { ...d, max: d.cells.reduce((m, c) => Math.max(m, c[2]), 1) }; }
    catch (err) { if (!err.status) this.offline = true; }
    this._gk = null; this.setState(s => ({ apiTick: s.apiTick + 1 }));
  }
  async fetchYearGrid() {
    const st = this.state; if (!(this.props.useLiveApi ?? true) || this.offline || (st.year === CUR_YEAR && st.source !== 'modis')) return;
    const k = st.year + '|' + st.source; if (this.yearGrid[k] || this._yg[k]) return; this._yg[k] = true;
    try { const d = await this.api('/archive/grid?year=' + st.year + '&source=' + st.source, null, 'GET'); this.yearGrid[k] = { ...d, max: d.cells.reduce((m, c) => Math.max(m, c[2]), 1) }; }
    catch (err) { if (!err.status) this.offline = true; }
    delete this._yg[k]; this._gk = null; this.setState(s => ({ apiTick: s.apiTick + 1 }));
  }
  fetchReport(region) {
    if (!(this.props.useLiveApi ?? true)) return Promise.resolve(null);
    const cur = this.store[region] || (this.store[region] = {});
    if (cur.report || cur.noArchive) return Promise.resolve(cur.report || null);
    if (cur.reportP) return cur.reportP;
    const R = REG[region], bbox = BBOX[region] || null;
    if (!R || (!bbox && region !== 'Global')) return Promise.resolve(null);
    const q = '/calendar/report?aoi_name=' + encodeURIComponent(region) + (R.country ? '&country=' + encodeURIComponent(R.country) : '');
    const geo = this.aoiGeo && this.aoiGeo[region];
    const fromApi = () => this.api(q, bbox ? { bbox, ...(geo && !R.country ? { geometry: geo } : {}) } : null);
    cur.reportP = (this.indexP || Promise.resolve(null)).then(idx => {
      const s = slugOf(COUNTRY_ALIAS[region] || region);
      if (!idx || !idx.slugs.has(s) || (geo && !idx.countrySlugs.has(s))) return fromApi();
      return fetch(REPORTS_URL + '/reports/' + s + '.json?v=' + idx.through).then(r => (r.ok ? r.json() : Promise.reject(new Error('CDN ' + r.status)))).catch(fromApi);
    })
      .then(r => { cur.report = r; cur.reportErr = null; cur.vm = null; cur.liveAt = r && r.live ? Date.now() : 0; return r; },
            err => { if (err.status === 404 || err.status === 503) cur.noArchive = err.message; else { cur.reportErr = err.message || 'offline'; if (!err.status) this.offline = true; } return null; })
      .finally(() => { cur.reportP = null; this._gk = null; this.setState(s => ({ apiTick: s.apiTick + 1 })); });
    return cur.reportP;
  }
  // Pre-built reports end where the stored archive ends; bring the shown area up to today from FIRMS
  // near-real-time data (the API fetches and caches the missing days per area for an hour).
  refreshLive(region) {
    const cur = this.store[region], r = cur && cur.report, R = REG[region], now = Date.now();
    if (!r || cur.liveP || !R || now - (cur.liveTried || 0) < 5 * 60e3) return;
    if (r.live ? now - (cur.liveAt || 0) < LIVE_MAX_AGE : !r.through) return;
    const bbox = BBOX[region] || null, geo = this.aoiGeo && this.aoiGeo[region];
    if (!bbox && !R.country && region !== 'Global') return;
    cur.liveTried = now;
    const q = '/calendar/report?aoi_name=' + encodeURIComponent(region) + (R.country ? '&country=' + encodeURIComponent(R.country) : '');
    cur.liveP = this.api(q, bbox ? { bbox, ...(geo && !R.country ? { geometry: geo } : {}) } : null)
      .then(x => { if (x && x.live && this.store[region] === cur) { cur.report = x; cur.vm = null; cur.liveAt = Date.now(); cur.liveTried = 0; } }, () => {})
      .finally(() => { cur.liveP = null; this._gk = null; this.setState(s => ({ apiTick: s.apiTick + 1 })); });
    this.setState(s => ({ apiTick: s.apiTick + 1 }));
  }
  async fetchWatch(region) {
    const cur = this.store[region] || (this.store[region] = {}), R = REG[region];
    if (!(this.props.useLiveApi ?? true) || !R || cur.watch || cur.watchP) return;
    const bbox = BBOX[region] || null, geo = this.aoiGeo && this.aoiGeo[region];
    if (!bbox && region !== 'Global') return;
    const q = '/calendar/watchlist?top=8' + (R.country ? '&country=' + encodeURIComponent(R.country) : '');
    const fromApi = () => this.api(q, bbox ? { bbox, ...(geo && !R.country ? { geometry: geo } : {}) } : null);
    // The whole planet's list is pre-built with the nightly reports (computing it scans every tile).
    const planet = region === 'Global' && REPORTS_URL && this.indexP
      ? this.indexP.then(idx => idx ? fetch(REPORTS_URL + '/reports/global-watch.json?v=' + idx.through).then(r => (r.ok ? r.json() : fromApi())) : fromApi()).catch(fromApi)
      : null;
    cur.watchP = (planet || fromApi())
      .then(w => { cur.watch = w; }, () => { cur.watch = null; })
      .finally(() => { cur.watchP = null; this.setState(s => ({ apiTick: s.apiTick + 1 })); });
  }
  lonLatAt(e) {
    const p = this.mapProj, r = e.currentTarget.getBoundingClientRect();
    if (!p) return null;
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    return { lon: p.lonMin + x * p.span, lat: p.latMax - y * p.latSpan, x: x * r.width, y: y * r.height };
  }
  parseGeo(obj) {
    const polys = [];
    const take = g => { if (!g) return; if (g.type === 'Polygon') polys.push(g.coordinates); else if (g.type === 'MultiPolygon') polys.push(...g.coordinates); else if (g.type === 'GeometryCollection') g.geometries.forEach(take); };
    if (obj.type === 'FeatureCollection') obj.features.forEach(f => take(f.geometry)); else if (obj.type === 'Feature') take(obj.geometry); else take(obj);
    if (!polys.length) return null;
    let w = 180, e = -180, so = 90, n = -90;
    polys.forEach(p => p.forEach(ring => ring.forEach(([x, y]) => { w = Math.min(w, x); e = Math.max(e, x); so = Math.min(so, y); n = Math.max(n, y); })));
    const props = (obj.type === 'FeatureCollection' ? (obj.features[0] || {}).properties : obj.properties) || {};
    return { geometry: polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys }, bbox: { west: w, south: so, east: e, north: n }, name: props.name || props.NAME || props.ADMIN || null };
  }
  interactVals() {
    const st = this.state, e = this.store[st.region] || {}, w = e.watch, p = this.mapProj;
    const cells = (w && w.cells) || [];
    const place = c => (c.country ? c.country + ' · ' : '') + Math.abs(c.lat).toFixed(2) + '°' + (c.lat >= 0 ? 'N' : 'S') + ' ' + Math.abs(c.lon).toFixed(2) + '°' + (c.lon >= 0 ? 'E' : 'W');
    const zoomTo = c => () => this.dropAoi(c.lat, c.lon);
    const d = st.drawRect;
    return {
      geoInput: this.geoInput,
      drawing: !!st.drawMode, drawCursor: st.drawMode ? 'crosshair' : 'default', drawTouch: st.drawMode ? 'none' : 'auto',
      drawBtnBg: st.drawMode ? 'rgba(255,138,31,.35)' : 'rgba(255,255,255,.05)',
      drawBox: d ? { left: Math.min(d.x0, d.x1) + 'px', top: Math.min(d.y0, d.y1) + 'px', width: Math.abs(d.x1 - d.x0) + 'px', height: Math.abs(d.y1 - d.y0) + 'px' } : null,
      toggleDraw: () => this.setState(s => ({ drawMode: !s.drawMode, drawRect: null })),
      mapDown: ev => { if (!this.state.drawMode) return; const q = this.lonLatAt(ev); if (!q) return; ev.currentTarget.setPointerCapture(ev.pointerId); this._d0 = q; this.setState({ drawRect: { x0: q.x, y0: q.y, x1: q.x, y1: q.y } }); },
      mapMove: ev => { if (!this._d0) return; const q = this.lonLatAt(ev); if (q) this.setState(s => ({ drawRect: { ...s.drawRect, x1: q.x, y1: q.y } })); },
      mapUp: ev => {
        const a = this._d0, b = this._d0 && this.lonLatAt(ev); this._d0 = null;
        this.setState({ drawRect: null, drawMode: false });
        if (!a || !b || Math.abs(a.lon - b.lon) < 0.3 || Math.abs(a.lat - b.lat) < 0.3) return;
        const bb = { west: Math.max(-180, Math.min(a.lon, b.lon)), east: Math.min(180, Math.max(a.lon, b.lon)), south: Math.max(-89, Math.min(a.lat, b.lat)), north: Math.min(89, Math.max(a.lat, b.lat)) };
        const name = 'Drawn area ' + (++this.drawCount);
        this.makeRegion(name, (bb.south + bb.north) / 2, (bb.west + bb.east) / 2, bb, 'Drawn area of interest');
        this.setRegion(name);
      },
      pickGeo: () => this.geoInput.current && this.geoInput.current.click(),
      onGeoFile: ev => {
        const f = ev.target.files && ev.target.files[0]; ev.target.value = '';
        if (!f) return;
        f.text().then(t => {
          const g = this.parseGeo(JSON.parse(t));
          if (!g) throw new Error('no polygon');
          const name = g.name || f.name.replace(/\.(geo)?json$/i, '');
          this.makeRegion(name, (g.bbox.south + g.bbox.north) / 2, (g.bbox.west + g.bbox.east) / 2, g.bbox, 'Uploaded area of interest');
          this.aoiGeo = this.aoiGeo || {}; this.aoiGeo[name] = g.geometry;
          this.setRegion(name); this.setState({ searchMsg: 'Showing uploaded area “' + name + '”', searchErr: false });
        }).catch(() => this.setState({ searchMsg: 'Could not read that file — upload a GeoJSON Polygon or MultiPolygon.', searchErr: true }));
      },
      hasWatch: cells.length > 0, noWatch: !!w && cells.length === 0,
      watchWhen: w ? 'weeks ' + w.weeks.join('–') + ', ' + w.year : '',
      watchRows: cells.map((c, i) => ({ n: i + 1, place: place(c), detail: fmt(c.current) + ' fires in 2 weeks · normally ' + (c.baseline_mean < 1 ? 'almost none' : fmt(c.baseline_mean)), cur: fmt(c.current), mean: fmt(c.baseline_mean), ratio: c.baseline_mean < 1 ? 'new' : c.ratio + '×', onClick: zoomTo(c) })),
      watchMarks: p && st.year === CUR_YEAR ? cells.map((c, i) => ({ c, i })).filter(({ c }) => c.lon >= p.lonMin && c.lon <= p.lonMin + p.span && c.lat <= p.latMax && c.lat >= p.latMax - p.latSpan)
        .map(({ c, i }) => ({ n: i + 1, left: ((c.lon - p.lonMin) / p.span * 100) + '%', top: ((p.latMax - c.lat) / p.latSpan * 100) + '%', title: place(c) + ' — ' + (c.baseline_mean < 1 ? 'new fire activity (normally none)' : c.ratio + '× normal'), onClick: zoomTo(c) })) : [],
      plainSummary: this.plainSummary(),
      cases: CASES.map(c => ({ ...c, onClick: () => { this.setRegion(c.region); this.setState({ year: c.year }); this.go(c.page); } })),
    };
  }
  plainSummary() {
    const vm = this.vm(this.state.region);
    if (!vm) return '';
    const r = vm.r, s = r.summary, b = r.baseline, o = r.outlook, cp = b.critical_period, name = this.state.region;
    const pct = d => Math.abs(Math.round(d)) + '% ' + (d >= 0 ? 'above' : 'below');
    const parts = this.state.region === 'Global' ? ['Worldwide, fires burn somewhere every week — this is the sum over every country.'] : [name + ' is ' + (s.season === 'Off-season' ? 'in its off-season' : s.season === 'Peak season' ? 'at the peak of its fire season' : s.season === 'Building' ? 'heading into its fire season' : 'past the peak of its fire season') + (cp ? ' — normally ' + cp.share + '% of the year’s burning falls between ' + cp.start_date + ' and ' + cp.end_date : '') + '.'];
    const tw = s.this_week;
    if (tw) parts.push('This week so far (since ' + new Date(tw.start + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) + (r.live ? ', live to ' + r.live.to.slice(11, 16) + ' UTC' : '') + '): ' + fmt(tw.harmonized) + ' harmonized detections' + (tw.delta_pct != null ? ', ' + pct(tw.delta_pct) + ' the normal for those days.' : '.'));
    if (s.delta_pct != null) parts.push('The last two weeks were ' + pct(s.delta_pct) + ' the 2003–2025 normal (' + ord(s.percentile) + ' percentile).');
    if (s.ytd_delta_pct != null) parts.push('So far this year burning is ' + pct(s.ytd_delta_pct) + ' normal.');
    if (o.available) parts.push('Outlook for the next ' + o.weeks.length + ' weeks: ' + o.risk_level.toLowerCase() + (o.risk_level !== 'NORMAL' ? ' — ' + o.prob_exceed_p90 + '% of similar past seasons had a week above the 90th percentile.' : '.'));
    const now = r.anomalies.filter(a => a.year === r.current_year).length;
    if (now) parts.push(now + ' alert' + (now > 1 ? 's' : '') + ' this year.');
    if (s.provisional) parts.push('Recent weeks use near-real-time data and are provisional.');
    return parts.join(' ');
  }
  vm(region) {
    const e = this.store[region]; if (!e || !e.report) return null;
    if (e.vm) return e.vm;
    const r = e.report, H = {}, M = {}, V = {}, F = {}, P = {}, Q = {}, PV = {};
    r.calendar.forEach(y => {
      H[y.year] = []; M[y.year] = []; V[y.year] = []; F[y.year] = []; P[y.year] = []; Q[y.year] = []; PV[y.year] = [];
      y.weeks.forEach(w => { const i = w.week - 1, nd = w.status === 'NO_DATA'; H[y.year][i] = w.harmonized_count; M[y.year][i] = nd ? null : w.modis_raw; V[y.year][i] = nd || y.year < 2012 ? null : w.viirs_raw; F[y.year][i] = w.total_frp; P[y.year][i] = w.percentile; Q[y.year][i] = w.quality; PV[y.year][i] = w.provisional; });
    });
    const maxOf = o => Object.values(o).reduce((m, a) => a.reduce((mm, x) => x != null && x > mm ? x : mm, m), 1);
    const hm = Math.max(maxOf(H), maxOf(M));
    e.vm = { r, H, M, V, F, P, Q, PV, max: { harmonized: hm, modis: hm, viirs: maxOf(V) } };
    return e.vm;
  }

  async fetchRegion(region, force) {
    if (!(this.props.useLiveApi ?? true)) return;
    const bbox = BBOX[region], cur = this.store[region] || (this.store[region] = {});
    const { days, landcover } = this.state, key = days + '|' + landcover;
    const rp = this.fetchReport(region);
    rp.then(() => this.refreshLive(region));
    this.fetchWatch(region);
    if (!bbox) { await rp; return; }
    if (!force && cur.key === key && cur.status && cur.status !== 'offline' && cur.status !== 'loading' && Date.now() - (cur.firesAt || 0) < 10 * 60e3) return;
    cur.key = key; cur.firesAt = Date.now(); cur.status = 'loading'; this.setState(s => ({ apiTick: s.apiTick + 1 }));
    const [h, f] = await Promise.allSettled([this.api('/harmonize/calculate', { bbox, days, landcover }), this.api('/fires/live?days=' + days, bbox)]);
    await rp;
    if (cur.key !== key) return;
    cur.harm = h.status === 'fulfilled' ? h.value : null;
    if (f.status === 'fulfilled' && f.value && Array.isArray(f.value.fires)) {
      cur.fires = f.value.fires.map(x => ({ lat: x.latitude, lng: x.longitude, frp: x.frp || 0, sensor: x.sensor, cor: x.corroboration }));
      cur.liveTotals = { modis: f.value.total_modis, viirs: f.value.total_viirs, ratio: f.value.disparity_ratio };
      cur.corrob = f.value.corroboration; cur.match = f.value.sensor_match;
    }
    cur.status = cur.harm || cur.fires || cur.report ? 'live' : 'offline';
    this._gk = null; this.setState(s => ({ apiTick: s.apiTick + 1 }));
  }
  getHarm() {
    const st = this.state, e = this.store[st.region];
    if (e && e.harm) { const h = e.harm; return { mc: h.raw_modis_count, vc: h.raw_viirs_count, hc: h.harmonized_count, mf: h.raw_modis_frp, vf: h.raw_viirs_frp, hf: h.harmonized_frp, alpha: h.scaling_factor_applied, method: h.calibration_method, window: 'Live NRT · ' + (st.days === 1 ? '24 h' : st.days + ' days'), raw: h }; }
    const vm = this.vm(st.region);
    if (vm) {
      const r = vm.r, y = r.current_year, w = r.current_week - 1, c = r.calibration;
      const mc = vm.M[y][w] || 0, vc = vm.V[y][w] || 0, hc = vm.H[y][w] || 0, hf = vm.F[y][w] || 0;
      const raw = { aoi: st.region, year: y, week: w + 1, raw_modis_count: mc, raw_viirs_count: vc, harmonized_count: hc, harmonized_frp: hf, scaling_factor_applied: c.alpha, local_factor_k: c.k, calibration_method: c.method };
      return { mc, vc, hc, mf: null, vf: null, hf, alpha: c.alpha, method: c.method, window: 'Archive · week ' + (w + 1) + ', ' + y, raw };
    }
    const [m0, v0, mf0, vf0] = RAW[st.region] || RAW.Amazon, k = st.days * (st.days > 1 ? .9 + .2 * hs(st.days + 3) : 1);
    const alpha = (ALPHA.find(a => a[0] === st.landcover) || ALPHA[0])[2];
    const mc = Math.round(m0 * k), vc = Math.round(v0 * k), mf = mf0 * k, vf = vf0 * k;
    const hc = .4 * mc + .6 * vc / alpha, hf = .4 * mf + .38 * vf * (4.2 / alpha);
    const method = 'Sample values (API offline)';
    return { mc, vc, hc, mf, vf, hf, alpha, method, window: 'Sample', raw: { sample: true, raw_modis_count: mc, raw_viirs_count: vc, harmonized_count: +hc.toFixed(1), scaling_factor_applied: alpha, calibration_method: method } };
  }

  detect(R) {
    const k = 'd|' + R.name + '|' + this.state.apiTick; if (this._dk === k) return this._det; const out = [];
    const vals = y => Array.from({ length: 52 }, (_, w) => this.cv(R, y, w) * R.wk);
    const base = []; for (let y = 2003; y <= 2025; y++) base.push(vals(y));
    const mean = [], sd = []; for (let w = 0; w < 52; w++) { const xs = base.map(b => b[w]); const m = xs.reduce((a, b) => a + b, 0) / xs.length; mean.push(m); sd.push(Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length) || 1); }
    const mx = Math.max(...mean), bOn = mean.findIndex(v => v > .5 * mx);
    const pctl = (w, v) => base.filter(b => b[w] < v).length / base.length * 100;
    for (let y = 2026; y >= 2014; y--) {
      const v = vals(y); const on = v.findIndex(x => x > .5 * mx);
      if (bOn - on >= 2) out.push({ week: on + 1, year: y, severity: 'WARNING', alert_type: 'EARLY_ONSET', description: 'Burning passed 50% of the baseline peak in week ' + (on + 1) + ', ' + (bOn - on) + ' weeks earlier than the 2003–2025 norm.', current_value: +v[on].toFixed(1), historical_mean: +mean[on].toFixed(1), percentile: +pctl(on, v[on]).toFixed(1) });
      for (let w = 0; w < 52; w++) {
        const z = (v[w] - mean[w]) / sd[w];
        if (z > 2.4) out.push({ week: w + 1, year: y, severity: z > 3.2 ? 'CRITICAL' : 'WARNING', alert_type: 'EXTREME_FIRE_SURGE', description: 'Harmonized detections ' + (v[w] / mean[w]).toFixed(1) + '× the weekly mean (z = ' + z.toFixed(1) + ').', current_value: +v[w].toFixed(1), historical_mean: +mean[w].toFixed(1), percentile: +pctl(w, v[w]).toFixed(1) });
        else if (z < -1.9 && mean[w] > .5 * mx) out.push({ week: w + 1, year: y, severity: 'INFO', alert_type: 'UNUSUAL_SUPPRESSION', description: 'In-season activity well below normal — rain, policy or reduced fuel load.', current_value: +v[w].toFixed(1), historical_mean: +mean[w].toFixed(1), percentile: +pctl(w, v[w]).toFixed(1) });
      }
    }
    out.sort((a, b) => b.year - a.year || b.week - a.week);
    this._dk = k; this._det = out.slice(0, 14); return this._det;
  }
  anomalies() { const e = this.store[this.state.region]; if (e && e.report) return e.report.anomalies; return this.isSample() ? this.detect(REG[this.state.region]) : []; }

  yearStats(R, y) {
    const vm = this.vm(R.name);
    if (!vm) return this.isSample() ? this.yearStatsSample(R, y) : { line: '', base: '', band: '', peak: '—', peakWhen: '', len: '—', onset: '—', total: '—', totalD: '', totalColor: '#9fb0cc' };
    const r = vm.r, b = r.baseline, v = vm.H[y] || [], n = y === r.current_year ? r.current_week : 52;
    const vals = Array.from({ length: 52 }, (_, w) => (w < n ? v[w] : null));
    const top = Math.max(1, ...vals.map(x => x || 0), ...b.p90) * 1.05;
    const X = w => (w / 51 * 520).toFixed(1), Y = x => (170 - x / top * 170).toFixed(1);
    const band = b.p90.map((m, w) => (w ? 'L' : 'M') + X(w) + ' ' + Y(m)).join('') + b.p10.map((_, w) => 'L' + X(51 - w) + ' ' + Y(b.p10[51 - w])).join('') + 'Z';
    const got = vals.filter(x => x != null);
    if (!got.length) return { line: '', base: path(b.mean, X, Y), band, peak: '—', peakWhen: 'no data', len: '—', onset: '—', total: '—', totalD: '', totalColor: '#9fb0cc' };
    const peakV = Math.max(...got), pk = vals.indexOf(peakV), len = got.filter(x => x >= .5 * peakV).length;
    let cum = 0, on = -1; for (let w = 0; w < n; w++) { cum += vals[w] || 0; if (cum >= .15 * b.annual_mean) { on = w + 1; break; } }
    const sh = b.onset_median_week && on > 0 ? b.onset_median_week - on : null;
    const tot = got.reduce((a, x) => a + x, 0), bt = b.mean.slice(0, n).reduce((a, x) => a + x, 0), d = bt ? (tot / bt - 1) * 100 : 0;
    return { line: path(vals, X, Y), base: path(b.mean, X, Y), band, peak: 'Week ' + (pk + 1), peakWhen: fmt(peakV) + ' fires · ' + wkDate(y, pk + 1),
      len: String(len), onset: sh == null ? '—' : sh === 0 ? 'On time' : Math.abs(sh) + ' wk ' + (sh > 0 ? 'early' : 'late'),
      total: fmt(tot), totalD: (d >= 0 ? '↑ ' : '↓ ') + Math.abs(d).toFixed(0) + '% vs baseline' + (n < 52 ? ' (to date)' : ''), totalColor: d >= 0 ? '#ff5a3a' : '#3ddc84' };
  }
  yearStatsSample(R, y) {
    const vals = yy => Array.from({ length: 52 }, (_, w) => this.cv(R, yy, w) * R.wk);
    const v = vals(y), base = []; for (let yy = 2003; yy <= 2025; yy++) base.push(vals(yy));
    const mean = [], sd = []; for (let w = 0; w < 52; w++) { const xs = base.map(b => b[w]); const m = xs.reduce((a, b) => a + b, 0) / xs.length; mean.push(m); sd.push(Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length)); }
    const top = Math.max(...v, ...mean.map((m, i) => m + sd[i])) * 1.05;
    const X = w => (w / 51 * 520).toFixed(1), Y = x => (170 - x / top * 170).toFixed(1);
    const line = a => a.map((x, w) => (w ? 'L' : 'M') + X(w) + ' ' + Y(x)).join('');
    const band = mean.map((m, w) => (w ? 'L' : 'M') + X(w) + ' ' + Y(m + sd[w])).join('') + mean.map((m, w) => 'L' + X(51 - w) + ' ' + Y(Math.max(0, mean[51 - w] - sd[51 - w]))).join('') + 'Z';
    const pk = v.indexOf(Math.max(...v)), len = v.filter(x => x >= .5 * v[pk]).length;
    const mx = Math.max(...mean), on = v.findIndex(x => x > .5 * mx), bOn = mean.findIndex(x => x > .5 * mx), sh = bOn - on;
    const tot = v.reduce((a, b) => a + b, 0), bt = mean.reduce((a, b) => a + b, 0), d = (tot / bt - 1) * 100;
    return { line: line(v), base: line(mean), band, peak: 'Week ' + (pk + 1), peakWhen: 'around ' + wkDate(y, pk + 1), len: String(len), onset: on < 0 ? '—' : sh === 0 ? 'On time' : Math.abs(sh) + ' wk ' + (sh > 0 ? 'early' : 'late'), total: fmt(tot), totalD: (d >= 0 ? '↑ ' : '↓ ') + Math.abs(d).toFixed(0) + '% vs baseline', totalColor: d >= 0 ? '#ff5a3a' : '#3ddc84' };
  }

  download(name, text, type) { const b = new Blob([text], { type }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000); }
  go(page) { this.setState({ page, tip: null }); window.scrollTo(0, 0); }

  cv(R, y, w) {
    const e = this.store[R.name], L = e && e.lookup; if (L && L[y] && L[y][w] != null) return L[y][w] / L.norm;
    const d = cd(w, R.peak - (y - 2000) * .07, 52); let s = Math.exp(-d * d / (2 * R.spread * R.spread));
    if (R.peak2 != null) { const d2 = cd(w, R.peak2, 52); s += (R.p2w || .6) * Math.exp(-d2 * d2 / (2 * R.spread * R.spread)); }
    const tr = 1 + (y - 2000) * .016 + (hs(y * 7 + R.seed) - .5) * .3;
    return (.06 + s) * tr * (.72 + .56 * hs(y * 131 + w * 17 + R.seed * 3));
  }
  cellVal(R, y, c, monthly) {
    if (!monthly) return this.cv(R, y, c);
    const a = Math.floor(c * 52 / 12), b = Math.floor((c + 1) * 52 / 12); let t = 0; for (let w = a; w < b; w++) t += this.cv(R, y, w); return t / (b - a);
  }

  buildCal() {
    const st = this.state, key = [st.region, st.source, st.calMode, st.calMetric, st.year, st.apiTick].join('|'); if (this._ck === key) return this._cal;
    const vm = this.vm(st.region);
    if (!vm && this.isSample()) { const rows = this.buildCalSample(); this._ck = key; this._cal = rows; return rows; }
    const R = REG[st.region], monthly = st.calMode === 'monthly', cols = monthly ? 12 : 52, rows = [];
    const src = vm ? (st.source === 'modis' ? vm.M : st.source === 'viirs' ? vm.V : vm.H) : null;
    const mx = vm ? vm.max[st.source] * (monthly ? 4.3 : 1) : 1;
    const label = st.source === 'harmonized' ? 'Harmonized fires (MODIS-eq.)' : st.source === 'modis' ? 'MODIS detections (raw)' : 'VIIRS S-NPP detections (raw)';
    const cell = (y, c) => {
      if (!src || !src[y]) return null;
      if (!monthly) return src[y][c];
      let t = 0, any = false; for (let w = 0; w < 52; w++) if (MONTH_OF_WEEK[w] === c && src[y][w] != null) { t += src[y][w]; any = true; }
      return any ? t : null;
    };
    const frpOf = (y, c) => { const f = vm.F[y]; if (!f) return null; if (!monthly) return f[c]; let t = 0; for (let w = 0; w < 52; w++) if (MONTH_OF_WEEK[w] === c && f[w] != null) t += f[w]; return t; };
    const pctOf = (y, c) => { const p = vm.P[y]; if (!p) return null; if (!monthly) return p[c]; let t = 0, k = 0; for (let w = 0; w < 52; w++) if (MONTH_OF_WEEK[w] === c && p[w] != null) { t += p[w]; k++; } return k ? t / k : null; };
    const frpMax = vm ? (monthly ? 4.3 : 1) * Object.values(vm.F).reduce((m, row) => row.reduce((mm, x) => (x != null && x > mm ? x : mm), m), 1) : 1;
    const colour = (y, c, v) => !vm ? null : st.calMetric === 'frp' ? (frpOf(y, c) == null ? null : ramp(logT(frpOf(y, c), frpMax)))
      : st.calMetric === 'anomaly' ? (pctOf(y, c) == null ? null : diverge(pctOf(y, c)))
      : (v == null ? null : ramp(logT(v, mx)));
    for (let y = CUR_YEAR; y >= 2000; y--) {
      const cells = [];
      for (let c = 0; c < cols; c++) {
        const v = cell(y, c);
        const onEnter = e => {
          if (v == null) { this.setState({ tip: null }); return; }
          const p = monthly ? null : vm.P[y] && vm.P[y][c];
          this.setState({ tip: { x: e.clientX, y: e.clientY, title: (monthly ? MON[c] : 'Week ' + (c + 1) + ' (' + wkDate(y, c + 1) + ')') + ' · ' + y, label, fires: fmt(v), frp: fmtMW(frpOf(y, c)), pct: p == null ? '—' : ord(p), cover: R.cover || 'Mixed', src: (st.source === 'harmonized' ? (y >= 2012 ? 'VIIRS S-NPP → MODIS-eq.' : 'MODIS Terra/Aqua') : st.source === 'modis' ? 'MODIS C6.1' : 'VIIRS S-NPP 375 m') + (monthly ? '' : QNOTE[vm.Q[y] && vm.Q[y][c]] || '') + (!monthly && vm.PV[y] && vm.PV[y][c] ? ' · provisional (NRT)' : '') } });
        };
        const bg = colour(y, c, v);
        cells.push({ bg: bg == null ? 'rgba(255,255,255,.03)' : bg, onEnter, onClick: () => this.setState({ year: y }) });
      }
      rows.push({ full: String(y), label: y % 2 === 0 ? String(y) : '', labelColor: y === st.year ? '#ffb27a' : '#7f8ea8', outline: y === st.year ? '1px solid rgba(255,178,122,.55)' : 'none', cells });
    }
    this._ck = key; this._cal = rows; return rows;
  }
  buildCalSample() {
    const st = this.state;
    const R = REG[st.region], monthly = st.calMode === 'monthly', cols = monthly ? 12 : 52, rows = [];
    for (let y = 2026; y >= 2000; y--) {
      const cells = [];
      for (let c = 0; c < cols; c++) {
        const h = this.cellVal(R, y, c, monthly);
        let v = h; if (st.source === 'modis') v = h * .4; if (st.source === 'viirs' && y < 2012) v = null;
        const onEnter = e => {
          if (v == null) { this.setState({ tip: null }); return; }
          let below = 0; for (let yy = 2000; yy <= 2026; yy++) if (this.cellVal(R, yy, c, monthly) < h) below++;
          const p = Math.round(below / 26 * 100), sfx = (p % 10 === 1 && p !== 11) ? 'st' : (p % 10 === 2 && p !== 12) ? 'nd' : (p % 10 === 3 && p !== 13) ? 'rd' : 'th';
          const fires = v * R.wk * (monthly ? 4.3 : 1);
          this.setState({ tip: { x: e.clientX, y: e.clientY, title: (monthly ? MON[c] : 'Week ' + (c + 1)) + ' · ' + y, label: st.source === 'harmonized' ? 'Harmonized fires' : st.source === 'modis' ? 'MODIS fires (raw)' : 'VIIRS fires (raw)', fires: fmt(fires), frp: fmt(fires * .15) + ' MW', pct: p + sfx, cover: R.cover, src: st.source === 'harmonized' ? (y >= 2012 ? 'MODIS + VIIRS' : 'MODIS (calibrated)') : st.source.toUpperCase() } });
        };
        cells.push({ bg: v == null ? 'rgba(255,255,255,.03)' : ramp(v / 1.5), onEnter, onClick: () => this.setState({ year: y }) });
      }
      rows.push({ full: String(y), label: y % 2 === 0 ? String(y) : '', labelColor: y === st.year ? '#ffb27a' : '#7f8ea8', outline: y === st.year ? '1px solid rgba(255,178,122,.55)' : 'none', cells });
    }
    return rows;
  }

  series(region) {
    const vm = this.vm(region);
    if (!vm) return this.isSample() ? this.seriesSample(region) : null;
    if (this._sk === vm) return this._ser;
    const out = Array.from({ length: 12 * (CUR_YEAR - 1999) }, () => ({ modis: null, viirs: null, harm: null }));
    vm.r.monthly.forEach(m => { const i = (m.year - 2000) * 12 + m.month - 1; if (out[i]) out[i] = { modis: m.modis, viirs: m.viirs, harm: m.harmonized }; });
    this._sk = vm; this._ser = out; return out;
  }
  seriesSample(region) {
    if (this._sk === region) return this._ser;
    const R = REG[region], pm = Math.round(R.peak / 52 * 12), out = [];
    for (let m = 0; m < 324; m++) {
      const y = 2000 + m / 12, mo = m % 12, d = cd(mo, pm, 12);
      const seas = .6 + .7 * Math.exp(-d * d / 3), n = .85 + .3 * hs(m + R.seed * 50);
      const modis = 9000 * (1 + (y - 2000) * .012) * seas * n * R.scale;
      const viirs = y >= 2012 ? modis * 2.6 * (1 + (y - 2012) * .035) * (.92 + .16 * hs(m * 3 + R.seed)) : null;
      out.push({ modis, viirs, harm: viirs ?? modis * 2.6 });
    }
    this._sk = region; this._ser = out; return out;
  }


  critVals() {
    const vm = this.state.region !== 'Global' && this.vm(this.state.region), b = vm && vm.r.baseline, cp = b && b.critical_period, core = b && b.core_period;
    if (!cp) return { hasCrit: false, critBand: [], critText: '', critShort: '' };
    const inWin = (w, p) => (p.start_week <= p.end_week ? w >= p.start_week && w <= p.end_week : w >= p.start_week || w <= p.end_week);
    return {
      hasCrit: true,
      critBand: Array.from({ length: 52 }, (_, i) => (inWin(i + 1, core) ? '#ff5a1a' : inWin(i + 1, cp) ? 'rgba(255,138,31,.45)' : 'rgba(255,255,255,.04)')),
      critText: 'Critical period: ' + cp.start_date + ' – ' + cp.end_date + ' holds ' + cp.share + '% of normal yearly burning (' + cp.weeks + ' weeks); core ' + core.start_date + ' – ' + core.end_date + ' (' + core.share + '%). Baseline 2003–2025.',
      critShort: cp.start_date + ' – ' + cp.end_date + ' · ' + cp.share + '% of burning',
    };
  }
  liveChecks() {
    const st = this.state, e = this.store[st.region] || {}, cor = e.corrob, m = e.match;
    const tot = cor ? cor.CONFIRMED + cor.LIKELY + cor.POSSIBLE : 0, win = st.days === 1 ? 'last 24 h' : 'last ' + st.days + ' days';
    const out = { hasCorrob: tot > 0, corrobRows: [], corrobWindow: 'Live FIRMS · ' + win, hasMatch: false, matchTiles: [], matchNote: '', matchText: '' };
    if (tot) out.corrobRows = [['CONFIRMED', 'Confirmed', '2+ satellites within 1.5 km & 12 h', '#ff5a3a'], ['LIKELY', 'Likely', 'one satellite: high confidence or revisit', '#ffa53a'], ['POSSIBLE', 'Possible', 'single nominal / low-confidence pixel', '#7f8ea8']]
      .map(([k, label, desc, color]) => ({ label, desc, color, n: fmt(cor[k]), pct: Math.round(cor[k] / tot * 100) + '%', w: (cor[k] / tot * 100) + '%' }));
    if (m && m.aqua_modis && m.snpp_viirs) {
      out.hasMatch = true;
      out.matchNote = 'Live FIRMS · ' + win + ' · ' + st.region;
      out.matchTiles = [
        { k: 'MODIS fires also seen by VIIRS', v: m.modis_matched_pct + '%', d: fmt(m.modis_matched) + ' of ' + fmt(m.aqua_modis) + ' Aqua detections', color: '#5aa0ff' },
        { k: 'VIIRS detections near a MODIS fire', v: m.viirs_matched_pct + '%', d: fmt(m.viirs_matched) + ' of ' + fmt(m.snpp_viirs) + ' S-NPP detections', color: '#ffb020' },
        { k: 'FRP on matched fires', v: m.frp_ratio_matched == null ? '—' : m.frp_ratio_matched + '×', d: 'VIIRS ÷ MODIS, same fires', color: '#ff8a4a' },
        { k: 'Overpass gap', v: m.median_gap_min == null ? '—' : m.median_gap_min + ' min', d: 'Aqua after S-NPP (orbital drift)', color: '#c8d3e8' },
      ];
      out.matchText = 'Detections are paired when Aqua MODIS and S-NPP VIIRS fire pixels fall within 1.5 km on the same afternoon pass. Most VIIRS detections have no MODIS counterpart: at 375 m VIIRS resolves small and cool fires below MODIS\'s 1 km detection limit — the reason raw counts jump in 2012 and why the record is harmonized.';
    }
    return out;
  }
  reportVals() {
    const st = this.state, vm = this.vm(st.region), e = this.store[st.region] || {};
    const out = { reportDate: new Date().toISOString().slice(0, 10), reportTiles: [], reportCal: [], reportPeak: '—', reportOutlook: 'No outlook available for this area.', reportCorrob: 'No live detections loaded for this area.' };
    if (e.corrob) {
      const c = e.corrob, t = c.CONFIRMED + c.LIKELY + c.POSSIBLE;
      out.reportCorrob = t ? fmt(t) + ' detections (' + (st.days === 1 ? 'last 24 h' : 'last ' + st.days + ' days') + '): ' + fmt(c.CONFIRMED) + ' confirmed by two or more satellites, ' + fmt(c.LIKELY) + ' likely, ' + fmt(c.POSSIBLE) + ' possible.' : 'No active fires detected in the live window.';
    }
    if (!vm) return out;
    const r = vm.r, s = r.summary, o = r.outlook, b = r.baseline;
    out.reportTiles = [
      { k: 'THIS WEEK (' + s.week + ')', v: fmt(s.harmonized_week), d: 'harmonized detections' },
      { k: 'LAST 2 WEEKS VS 2003–2025', v: s.delta_pct == null ? s.season : pctTxt(s.delta_pct), d: 'percentile ' + ord(s.percentile), color: upColor(s.delta_pct) },
      { k: 'YEAR TO DATE', v: s.ytd_delta_pct == null ? '—' : pctTxt(s.ytd_delta_pct), d: fmt(s.ytd_harmonized) + ' vs ' + fmt(s.ytd_baseline) + ' usual', color: upColor(s.ytd_delta_pct) },
      { k: 'SEASON', v: s.season, d: 'peak usually ' + s.peak_month + ' (wk ' + s.peak_week + ')' },
      ...(b.critical_period ? [{ k: 'CRITICAL PERIOD', v: b.critical_period.start_date + ' – ' + b.critical_period.end_date, d: b.critical_period.share + '% of yearly burning in ' + b.critical_period.weeks + ' weeks', color: '#d9822b' }] : []),
      { k: 'OUTLOOK', v: o.available ? o.risk_level : '—', d: o.available ? 'next ' + o.weeks.length + ' weeks' : '', color: o.available ? { HIGH: '#d9342b', ELEVATED: '#d9822b', NORMAL: '#1f9d55' }[o.risk_level] : undefined },
      { k: 'ALERTS ' + r.current_year, v: String(r.anomalies.filter(a => a.year === r.current_year).length), d: 'onset, surge, suppression' },
    ];
    const mx = vm.max.harmonized;
    for (let y = r.current_year; y >= 2000; y--) out.reportCal.push({ label: y % 2 === 0 ? String(y) : '', cells: Array.from({ length: 52 }, (_, w) => { const v = vm.H[y] && vm.H[y][w]; return { bg: v == null ? '#e9edf3' : ramp(logT(v, mx)) }; }) });
    out.reportPeak = 'week ' + b.peak_week + ' (' + s.peak_month + '), season onset median week ' + (b.onset_median_week || '—');
    out.reportOutlook = o.available
      ? 'Expected ' + fmt(o.expected.reduce((a, x) => a + x, 0)) + ' detections over weeks ' + o.weeks[0] + '–' + o.weeks[o.weeks.length - 1] + ' (usual ' + fmt(o.baseline_mean.reduce((a, x) => a + x, 0)) + '). ' + o.prob_exceed_p90 + '% of analog seasons had a week above the 90th percentile. Season so far ' + o.ytd_vs_baseline.toFixed(2) + '× baseline; ' + o.remaining_season_pct + '% of usual burning still ahead.'
      : o.reason || out.reportOutlook;
    return out;
  }
  heroVals() {
    const st = this.state, R = REG[st.region], vm = this.vm(st.region), e = this.store[st.region] || {};
    const blank = { heroCount: '—', heroDelta: '', deltaColor: '#9fb0cc', heroWhen: e.reportP || e.status === 'loading' ? 'Loading…' : 'No data', heroBasis: '', regionFrp: '—', regionFrpD: '', frpColor: '#9fb0cc', regionPct: '—', pctNote: '', regionStatus: '—', regionStatusSub: '', anomCount: '0' };
    if (vm) {
      const r = vm.r, s = r.summary, b = r.baseline;
      const anomCount = String(r.anomalies.filter(a => a.year === r.current_year).length);
      const cp = st.region === 'Global' ? null : b.critical_period;
      const season = st.region === 'Global' ? { regionStatus: 'Year-round', regionStatusSub: 'Some region is always burning' }
        : { regionStatus: s.season, regionStatusSub: cp ? 'Critical ' + cp.start_date + ' – ' + cp.end_date : 'Peak usually ' + s.peak_month + (b.onset_median_week ? ' · onset wk ' + b.onset_median_week : '') };
      const tw = s.this_week, dshort = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      if (st.year === r.current_year && tw) {
        const off = tw.delta_pct == null;
        return { heroCount: fmt(tw.harmonized), heroDelta: off ? (s.season === 'Off-season' ? 'Off-season' : '—') : pctTxt(tw.delta_pct), deltaColor: upColor(tw.delta_pct),
          heroWhen: 'This week so far · ' + (r.live ? 'Live' : e.liveP ? 'updating to live…' : 'since ' + dshort(tw.start)),
          heroBasis: (off ? 'normal for these days ' + fmt(tw.expected) : 'vs. 2003–2025, same ' + tw.days + ' day' + (tw.days > 1 ? 's' : '')) + (r.live ? ' · updated ' + r.live.to.slice(11, 16) + ' UTC' : ' · data to ' + dshort(r.through)),
          regionFrp: fmtMW(tw.frp_mw), regionFrpD: 'so far this week', frpColor: '#9fb0cc', regionPct: ord(s.percentile),
          pctNote: 'last 2 full weeks', anomCount, ...season };
      }
      if (st.year === r.current_year) {
        const off = s.delta_pct == null;
        return { heroCount: fmt(s.harmonized_week), heroDelta: off ? (s.season === 'Off-season' ? 'Off-season' : '—') : pctTxt(s.delta_pct), deltaColor: upColor(s.delta_pct),
          heroWhen: 'Last full week · ' + wkRange(s.year, s.week), heroBasis: off ? 'same-week mean ' + fmt(s.baseline_week_mean) : 'last 2 weeks vs. 2003–2025' + (s.provisional ? ' · provisional' : ''),
          regionFrp: fmtMW(s.frp_week_mw), regionFrpD: pctTxt(s.frp_delta_pct), frpColor: upColor(s.frp_delta_pct), regionPct: ord(s.percentile),
          pctNote: s.percentile >= 90 ? 'Well above normal' : s.percentile >= 70 ? 'Above normal' : s.percentile <= 20 ? 'Below normal' : 'Near normal', anomCount, ...season };
      }
      const tot = y => (vm.H[y] || []).reduce((a, v) => a + (v || 0), 0), frpTot = y => (vm.F[y] || []).reduce((a, v) => a + (v || 0), 0);
      const base = []; for (let y = 2003; y <= 2025; y++) if (vm.H[y] && vm.H[y].some(x => x != null)) base.push(y);
      if (!vm.H[st.year] || vm.H[st.year].every(x => x == null)) return { ...blank, heroWhen: st.year + ' · no sensor data', anomCount, ...season };
      const v = tot(st.year), mean = base.reduce((a, y) => a + tot(y), 0) / Math.max(1, base.length), fmean = base.reduce((a, y) => a + frpTot(y), 0) / Math.max(1, base.length);
      const d = mean ? (v / mean - 1) * 100 : null, fd = fmean ? (frpTot(st.year) / fmean - 1) * 100 : null;
      return { heroCount: fmt(v), heroDelta: pctTxt(d), deltaColor: upColor(d), heroWhen: st.year + ' · full year', heroBasis: 'vs. 2003–2025 annual mean',
        regionFrp: fmtMW(frpTot(st.year)), regionFrpD: pctTxt(fd), frpColor: upColor(fd), regionPct: ord(base.filter(y => tot(y) < v).length / Math.max(1, base.length) * 100), pctNote: 'rank among 2003–2025', anomCount, ...season };
    }
    if (e.noArchive && e.harm) { const h = e.harm; return { ...blank, heroCount: fmt(h.harmonized_count), heroWhen: 'Live · ' + (st.days === 1 ? '24 h' : st.days + ' d'), heroBasis: 'outside archive — no baseline', regionFrp: fmtMW(h.harmonized_frp), regionStatus: 'Live only', regionStatusSub: 'Not in the 26-year archive' }; }
    if (this.isSample()) return { ...blank, heroCount: fmt((R.wk || 100) * 6 * (.55 + .45 * (st.year - 2000) / 26)), heroWhen: 'Sample data', heroBasis: 'API offline' };
    return blank;
  }
  pageVals() {
    const st = this.state, R = REG[st.region], pg = st.page, vm = this.vm(st.region);
    const NAV = [['home', 'Home'], ['harmonize', 'Harmonize'], ['calendar', 'Fire Calendar'], ['anomalies', 'Anomalies'], ['data', 'Data'], ['cases', 'Case Studies']];
    const goExplore = id => { this.setState({ page: 'home', tip: null }); setTimeout(() => { const el = document.getElementById(id); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' }); }, 60); };
    const e = this.store[st.region] || {};
    const status = !(this.props.useLiveApi ?? true) ? 'off' : e.report ? 'live' : e.noArchive ? 'noarchive' : e.reportErr || this.offline ? 'offline' : 'loading';
    const H = this.getHarm(), mxc = Math.max(H.mc, H.vc, H.hc) || 1;
    const anoms = this.anomalies(), top = Math.max(1, ...anoms.map(a => Math.max(a.current_value, a.historical_mean)));
    const fa = a => { const [color, tint] = SEV[a.severity] || SEV.INFO; const r = a.historical_mean ? a.current_value / a.historical_mean : 0; return { sev: a.severity, color, tint, title: TYPE[a.alert_type] || a.alert_type, desc: a.description, when: 'Week ' + a.week + ' · ' + a.year, date: 'around ' + wkDate(a.year, a.week), cur: fmt(a.current_value), mean: fmt(a.historical_mean), curW: (a.current_value / top * 100) + '%', meanW: (a.historical_mean / top * 100) + '%', pctl: ord(a.percentile), vs: r ? (r >= 1 ? '+' : '') + Math.round((r - 1) * 100) + '% vs mean' : '' }; };
    const list = anoms.filter(a => st.sev === 'All' || a.severity === st.sev).map(fa);
    const cnt = s => anoms.filter(a => s === 'All' || a.severity === s).length;
    const titles = { harmonize: ['Harmonize', 'MODIS (1 km) and VIIRS (375 m) on one scale — calibrated on the years both sensors flew, so 2000–2026 compare directly.'], calendar: ['Burning activity calendar', 'Week-by-week harmonized hotspots for every year. Find the critical periods and how the season is shifting.'], anomalies: ['Anomalies & early warning', 'Weeks where burning departs from the 2003–2025 baseline, and an analog-year outlook for the weeks ahead.'], data: ['Data & export', 'Download what you see and check the source fields behind it.'], report: ['Area report', 'One page for responders and land managers — print it or save it as PDF.'], cases: ['Case studies', 'Known fire events that stand out in the harmonized 26-year record — found in the data, not told to it. Open one to see it on the calendar.'] };
    const cal = vm && vm.r.calibration, mt = cal && cal.model && cal.model.test;
    const maxRatio = cal ? Math.max(1, ...cal.yearly.map(y => y.ratio || 0)) : 1, maxA = cal ? Math.max(1, ...cal.alpha_by_month.map(a => a || 0)) : 1;
    const o = vm && vm.r.outlook, oOK = !!(o && o.available);
    const RISK = { HIGH: ['#ff4a3a', 'rgba(255,74,58,.14)'], ELEVATED: ['#ffa53a', 'rgba(255,165,58,.14)'], NORMAL: ['#3ddc84', 'rgba(61,220,132,.12)'] };
    let oChart = { exp: '', band: '', base: '', p90: '' };
    if (oOK) {
      const n = o.weeks.length, oTop = Math.max(1, ...o.high, ...o.baseline_p90, ...o.expected) * 1.1;
      const X = i => (n > 1 ? i / (n - 1) * 520 : 260).toFixed(1), Y = v => (150 - v / oTop * 150).toFixed(1);
      oChart = { exp: path(o.expected, X, Y), base: path(o.baseline_mean, X, Y), p90: path(o.baseline_p90, X, Y), band: o.high.map((v, i) => (i ? 'L' : 'M') + X(i) + ' ' + Y(v)).join('') + o.low.map((_, i) => 'L' + X(n - 1 - i) + ' ' + Y(o.low[n - 1 - i])).join('') + 'Z' };
    }
    const tag = st.region.replace(/\s/g, '_');
    const through = vm ? vm.r.through : null, liveTo = vm && vm.r.live ? vm.r.live.to : null;
    const liveTxt = liveTo ? +liveTo.slice(8, 10) + ' ' + MON[+liveTo.slice(5, 7) - 1] + ' ' + liveTo.slice(11, 16) + ' UTC' : '';
    const updating = !!(e && e.liveP);
    return {
      navItems: NAV.map(([k, l]) => ({ label: l, color: pg === k ? '#fff' : '#c8d3e8', bd: pg === k ? '#ff6a1a' : 'transparent', onClick: () => { this.setState({ menuOpen: false }); k === 'about' ? goExplore('about') : this.go(k); } })),
      menuOpen: st.menuOpen ? '1' : '0', menuGlyph: st.menuOpen ? '✕' : '☰', toggleMenu: () => this.setState(s => ({ menuOpen: !s.menuOpen })),
      goHome: () => this.go('home'), goHarm: () => this.go('harmonize'), goCalendar: () => this.go('calendar'), goAnom: () => this.go('anomalies'), goExplore: () => { this.setState({ menuOpen: false }); goExplore('explore'); }, nearMe: () => this.nearMe(),
      headerSearch: this.headerSearch, kbdHint: typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') ? '⌘K' : 'Ctrl K',
      homeDisplay: pg === 'home' ? 'block' : 'none', isDetail: pg !== 'home', isHarm: pg === 'harmonize', isCal: pg === 'calendar', isAnom: pg === 'anomalies', isData: pg === 'data', isReport: pg === 'report', isCases: pg === 'cases',
      goReport: () => this.go('report'), goCases: () => this.go('cases'), printNow: () => window.print(),
      ...this.liveChecks(), ...this.reportVals(), ...this.interactVals(),
      pageTitle: (titles[pg] || ['', ''])[0], pageSub: (titles[pg] || ['', ''])[1],
      notGlobal: st.region !== 'Global', resetGlobal: () => this.setRegion('Global'),
      pageChips: ['Global', ...QUICK].map(n => ({ name: n, bg: n === st.region ? 'rgba(255,106,26,.14)' : 'rgba(255,255,255,.03)', bd: n === st.region ? '#ff6a1a' : 'rgba(130,160,210,.18)', onClick: () => this.setRegion(n) })),
      apiLabel: { live: liveTo ? 'NASA FIRMS · live to ' + liveTxt : 'NASA FIRMS archive' + (through ? ' · to ' + through : '') + (updating ? ' · updating to today…' : ''), noarchive: 'Live FIRMS · outside archive', offline: 'API offline · sample data', loading: 'Loading NASA FIRMS…', off: 'Sample data' }[status],
      apiColor: { live: '#3ddc84', noarchive: '#ffa53a', offline: '#ffa53a', loading: '#9fb0cc', off: '#9fb0cc' }[status],
      apiBase: this.props.apiBase ?? API_BASE,
      dataNote: liveTo ? 'Data: NASA FIRMS — MODIS C6.1 (1 km) & VIIRS S-NPP (375 m) archive through ' + vm.r.live.archive_through + ', then FIRMS near-real-time (MODIS, S-NPP, NOAA-20) to ' + liveTxt + '.' : through ? 'Data: NASA FIRMS — MODIS C6.1 (1 km) & VIIRS S-NPP (375 m) archive through ' + through + '.' : 'Data: NASA FIRMS — MODIS C6.1 (1 km) & VIIRS S-NPP (375 m).',
      noArchiveMsg: e.noArchive || '', hasNoArchive: !!e.noArchive,
      dayTabs: [1, 3, 7, 10].map(d => ({ label: d === 1 ? '24 h' : d + ' days', bg: st.days === d ? 'rgba(255,106,26,.2)' : 'transparent', bd: st.days === d ? 'rgba(255,106,26,.7)' : 'rgba(130,160,210,.18)', onClick: () => this.setState({ days: d }, () => this.fetchRegion(st.region)) })),
      landcover: st.landcover, onLandcover: ev => this.setState({ landcover: ev.target.value }, () => this.fetchRegion(st.region)),
      runHarm: () => this.fetchRegion(st.region, true),
      hModis: fmt(H.mc), hViirs: fmt(H.vc), hHarm: H.hc.toLocaleString('en-US', { maximumFractionDigits: 1 }), hModisFrp: fmtMW(H.mf), hViirsFrp: fmtMW(H.vf), hHarmFrp: fmtMW(H.hf), hAlpha: (+H.alpha).toFixed(2), hMethod: H.method, hWindow: H.window, hRatio: H.mc ? (H.vc / H.mc).toFixed(1) + '×' : '—',
      modisW: (H.mc / mxc * 100) + '%', viirsW: (H.vc / mxc * 100) + '%', harmW: (H.hc / mxc * 100) + '%',
      alphaRows: ALPHA.map(([n, d, a]) => ({ name: n === 'All' ? 'Local (learned)' : n, alpha: a.toFixed(1), eq: fmt(H.vc / a) + ' MODIS-eq.', bg: st.landcover === n ? 'rgba(255,106,26,.12)' : 'transparent', bd: st.landcover === n ? 'rgba(255,106,26,.6)' : 'transparent', onClick: () => this.setState({ landcover: n }, () => this.fetchRegion(st.region)) })),
      hasCal: !!cal, noCal: !cal,
      calInfo: cal ? 'α = ' + cal.alpha + ' VIIRS per MODIS detection · k = ' + cal.k + ' · FRP β = ' + cal.beta_frp + ' · calibrated on ' + (cal.calibration_years.length ? cal.calibration_years[0] + '–' + cal.calibration_years[cal.calibration_years.length - 1] : '—') : '',
      calMethod: cal ? cal.method : '',
      ...this.critVals(),
      calQa: cal ? 'Official FIRMS gaps handled — missing days: Terra ' + (cal.official_missing_days || {}).terra + ', Aqua ' + (cal.official_missing_days || {}).aqua + ', S-NPP ' + (cal.official_missing_days || {}).snpp + ', NOAA-20 ' + (cal.official_missing_days || {}).noaa20 + ' · ' + (cal.viirs_gap_weeks || []).length + ' gap weeks filled here' + (cal.noaa20 && cal.noaa20.overlap_weeks ? ' · S-NPP ÷ NOAA-20 = ' + cal.noaa20.snpp_per_noaa20 + ' (' + cal.noaa20.overlap_weeks + ' weeks) — NOAA-20 carries the record after S-NPP retires' : '') + (cal.standard_through ? ' · provisional after ' + cal.standard_through : '') : '',
      calYears: cal ? cal.yearly.map(y => ({ year: String(y.year), modis: fmt(y.modis), viirs: fmt(y.viirs), ratio: y.ratio == null ? '—' : y.ratio.toFixed(2) + '×', w: ((y.ratio || 0) / maxRatio * 100) + '%', qa: y.qa === 'OK' ? 'OK' : 'MODIS under-detection', qaColor: y.qa === 'OK' ? '#3ddc84' : '#ffa53a', barColor: y.qa === 'OK' ? '#ffb020' : '#ff4a3a' })) : [],
      alphaMonth: cal ? cal.alpha_by_month.map((a, i) => ({ m: MON[i], a: a == null ? '—' : a.toFixed(1), h: a ? (a / maxA * 100) + '%' : '0%' })) : [],
      hasModel: !!mt,
      modelRows: mt ? [['Gradient boosting (FireLens)', mt.gradient_boosting, '#ff8a4a'], ['Flat ratio, learned α', mt.flat_ratio_learned, '#c8d3e8'], ['Flat ratio, α = 4.2', mt.flat_ratio_4_2, '#c8d3e8']].map(([name, m, color]) => ({ name, color, r2: m.r2.toFixed(3), mae: m.mae.toFixed(1), bias: (m.bias_pct >= 0 ? '+' : '') + m.bias_pct + '%' })) : [],
      modelNote: mt ? 'Out-of-time test — trained ' + cal.model.train_years + ', tested ' + cal.model.test_years + (cal.model.countries ? ' across ' + cal.model.countries + ' countries' : '') + ', on country-week totals (MODIS detections).' : '',
      modelHere: (() => { const pc = cal && cal.model && cal.model.per_country_test, c = pc && (pc[R.country] || pc[st.region]); return c ? 'In ' + (R.country || st.region) + ': FireLens R² ' + c.model.r2.toFixed(3) + ' (bias ' + (c.model.bias_pct >= 0 ? '+' : '') + c.model.bias_pct + '%) vs single ratio R² ' + c.flat.r2.toFixed(3) + ' (bias ' + (c.flat.bias_pct >= 0 ? '+' : '') + c.flat.bias_pct + '%).' : ''; })(),
      modelFeatures: cal && cal.model && cal.model.feature_importance ? Object.keys(cal.model.feature_importance).slice(0, 4).map(f => ({ v_n: 'VIIRS count', v_frp: 'VIIRS FRP', cell_ratio: 'Cell VIIRS/MODIS ratio', v_mean_frp: 'FRP per detection', v_night_frac: 'Night share', lat: 'Latitude', wk_sin: 'Season', wk_cos: 'Season' }[f] || f)).filter((f, i, a) => a.indexOf(f) === i).join(' · ') : '',
      calRowsBig: this.buildCal(), ys: this.yearStats(R, st.year),
      prevYear: () => this.setState(s => ({ year: Math.max(2000, s.year - 1) })), nextYear: () => this.setState(s => ({ year: Math.min(CUR_YEAR, s.year + 1) })),
      anomTop: anoms.slice(0, 5).map(fa), anomList: list, anomEmpty: list.length === 0,
      sevCards: [['All', 'ALL ALERTS', '#e8eefb'], ['CRITICAL', 'CRITICAL', SEV.CRITICAL[0]], ['WARNING', 'WARNING', SEV.WARNING[0]], ['INFO', 'INFO', SEV.INFO[0]]].map(([k, l, c]) => ({ label: l, n: String(cnt(k)), color: c, bg: st.sev === k ? 'rgba(255,255,255,.07)' : 'rgba(255,255,255,.02)', bd: st.sev === k ? c : 'rgba(130,160,210,.16)', onClick: () => this.setState({ sev: k }) })),
      hasOutlook: oOK, noOutlook: !oOK, outlookReason: o && !o.available ? o.reason : vm ? '' : 'Outlook needs the archive for this area.',
      outlookRisk: oOK ? o.risk_level : '—', riskColor: oOK ? RISK[o.risk_level][0] : '#9fb0cc', riskTint: oOK ? RISK[o.risk_level][1] : 'rgba(255,255,255,.03)',
      outlookRange: oOK ? 'Weeks ' + o.weeks[0] + '–' + o.weeks[o.weeks.length - 1] + ' · from ' + wkDate(vm.r.current_year, o.weeks[0]) : '',
      outlookProb: oOK ? o.prob_exceed_p90 + '%' : '—', outlookYtd: oOK ? o.ytd_vs_baseline.toFixed(2) + '×' : '—', outlookRemain: oOK ? o.remaining_season_pct + '%' : '—',
      outlookAnalogs: oOK ? o.analog_years.join(', ') : '', outlookMini: oOK ? 'Outlook, next ' + o.weeks.length + ' weeks: ' + o.risk_level.toLowerCase() : '',
      oExp: oChart.exp, oBand: oChart.band, oBase: oChart.base, oP90: oChart.p90,
      fieldRows: FIELDS.map(([k, s, d]) => ({ k, s, d })), endpoints: ENDPOINTS.map(([m, p, d]) => ({ m, p, d })),
      dlCal: () => {
        if (vm) {
          let t = 'year,week,week_start,modis_raw,viirs_snpp_raw,harmonized_modis_eq,harmonized_frp_mw,percentile,status\n';
          vm.r.calendar.forEach(y => y.weeks.forEach(w => { if (w.status === 'NO_DATA') return; t += [y.year, w.week, new Date(Date.UTC(y.year, 0, 1 + (w.week - 1) * 7)).toISOString().slice(0, 10), w.modis_raw, y.year >= 2012 ? w.viirs_raw : '', w.harmonized_count, w.total_frp, w.percentile, w.status].join(',') + '\n'; }));
          this.download('firelens-calendar-' + tag + '.csv', t, 'text/csv'); return;
        }
        let t = 'year,week,sample_fires\n'; for (let y = 2000; y <= 2026; y++) for (let w = 0; w < 52; w++) t += y + ',' + (w + 1) + ',' + (this.cv(R, y, w) * R.wk).toFixed(1) + '\n'; this.download('firelens-calendar-SAMPLE-' + tag + '.csv', t, 'text/csv');
      },
      dlAnom: () => this.download('firelens-anomalies-' + tag + '.json', JSON.stringify(anoms, null, 2), 'application/json'),
      dlHarm: () => this.download('firelens-harmonize-' + tag + '.json', JSON.stringify(H.raw, null, 2), 'application/json'),
      dlReport: () => vm && this.download('firelens-report-' + tag + '.json', JSON.stringify(vm.r, null, 1), 'application/json'),
    };
  }

  setYearFromEvent(e) { const r = e.currentTarget.getBoundingClientRect(); const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); const y = Math.round(2000 + t * (CUR_YEAR - 2000)); if (y !== this.state.year) this.setState({ year: y }); }

  renderVals() {
    const st = this.state, R = REG[st.region], e = this.store[st.region] || {};
    const pts = this.series(st.region) || [], N = Math.max(1, 12 * (CUR_YEAR - 1999) - 1);
    let max = 1; pts.forEach(p => { max = Math.max(max, p.harm || 0, p.viirs || 0, p.modis || 0); });
    const step = niceStep(max / 4), top = Math.ceil(max / step) * step;
    const X = i => (i / N * 1000).toFixed(1), Y = v => (300 - v / top * 300).toFixed(1);
    const harm = pts.map(p => p.harm), idx = harm.map((v, i) => (v != null ? i : -1)).filter(i => i >= 0);
    const harmLine = path(harm, X, Y), modisLine = path(pts.map(p => p.modis), X, Y), viirsLine = path(pts.map(p => p.viirs), X, Y);
    const trendArea = idx.length ? path(harm.map((v, i) => (i >= idx[0] && i <= idx[idx.length - 1] ? v || 0 : null)), X, Y) + 'L' + X(idx[idx.length - 1]) + ' 300L' + X(idx[0]) + ' 300Z' : '';
    const yi = (st.year - 2000) * 12; let yt = 0; for (let i = yi; i < yi + 12; i++) yt += (pts[i] && pts[i].harm) || 0;
    const tip = st.tip, g = this.globeCells(), liveNow = st.year === CUR_YEAR && st.source !== 'modis' && this.liveGlobal;
    const liveN = e.liveTotals ? e.liveTotals.modis + e.liveTotals.viirs : null;
    return {
      globeRef: this.globeRef, satRef: this.satRef, mapRef: this.mapRef,
      region: st.region, regionName: st.region, regionSub: R.sub, regionCoord: R.coord,
      ...this.heroVals(),
      ...this.pageVals(),
      ...this.alertVals(),
      chips: QUICK.map(n => ({ name: n, flagBg: 'url(' + CHIP_IMG[n] + ')', bg: n === st.region ? 'rgba(255,106,26,.14)' : 'rgba(255,255,255,.03)', bd: n === st.region ? '#ff6a1a' : 'rgba(130,160,210,.18)', onClick: () => this.setRegion(n) })),
      srcTabs: [['harmonized', 'Harmonized'], ['modis', 'MODIS'], ['viirs', 'VIIRS']].map(([k, l]) => ({ label: l, bg: st.source === k ? 'rgba(255,106,26,.2)' : 'transparent', bd: st.source === k ? 'rgba(255,106,26,.7)' : 'transparent', color: st.source === k ? '#ffe2cf' : '#9fb0cc', onClick: () => this.setState({ source: k }) })),
      sourceLabel: st.source === 'harmonized' ? 'harmonized to MODIS-equivalent' : st.source === 'modis' ? 'MODIS raw (not comparable)' : 'VIIRS S-NPP raw, 2012 onward',
      mapNote: (liveNow ? 'Live today · VIIRS' : (st.source === 'harmonized' ? 'Harmonized' : st.source.toUpperCase()) + ' · ' + st.year) + (g && !liveNow ? ' · archive' : ''),
      year: st.year, yearPct: ((st.year - 2000) / (CUR_YEAR - 2000) * 100) + '%', playGlyph: st.playing ? '❚❚' : '▶',
      togglePlay: () => { if (st.playing) { clearInterval(this.playT); this.setState({ playing: false }); } else { this.playT = setInterval(() => this.setState(s => ({ year: s.year >= CUR_YEAR ? 2000 : s.year + 1 })), 700); this.setState({ playing: true }); } },
      trackDown: ev => { this.trackDrag = true; ev.currentTarget.setPointerCapture(ev.pointerId); this.setYearFromEvent(ev); },
      trackMove: ev => { if (this.trackDrag) this.setYearFromEvent(ev); },
      trackUp: () => { this.trackDrag = false; },
      harmLine, modisLine, viirsLine, trendArea,
      yTicks: [0, 1, 2, 3, 4].map(k => ({ label: fmtK(top * k / 4), top: (100 - k * 25) + '%' })),
      xTicks: [2000, 2005, 2010, 2015, 2020, 2025].map(y => ({ label: String(y), left: ((y - 2000) * 12 / N * 100) + '%' })),
      markerPct: (((st.year - 2000) * 12 + 6) / N * 100) + '%', markerLabel: pts.length ? st.year + ' · ' + fmt(yt) + ' fires' : '',
      calRows: this.buildCal(), calCols: st.calMode === 'monthly' ? 12 : 52, calUnit: st.calMode === 'monthly' ? 'month' : 'week', calMode: st.calMode,
      onModeSelect: ev => this.setState({ calMode: ev.target.value }),
      calMetric: st.calMetric, onMetricSelect: ev => this.setState({ calMetric: ev.target.value }),
      calLegend: st.calMetric === 'anomaly' ? 'linear-gradient(90deg,#3b8cff,#2c3448,#ff4a2a)' : 'linear-gradient(90deg,#121a3d,#1f2b6b,#5a2a7a,#b0283f,#e5402a,#ff7a1a,#ffd04a)',
      calLo: st.calMetric === 'anomaly' ? 'Quieter than normal' : 'Low', calHi: st.calMetric === 'anomaly' ? 'More fire than normal' : 'High',
      calMetricNote: { count: 'Harmonized fire detections per ' + (st.calMode === 'monthly' ? 'month' : 'week') + ' (log colour scale)', frp: 'Fire radiative power — how much energy the fires release (harmonized, log scale)', anomaly: 'How unusual each ' + (st.calMode === 'monthly' ? 'month' : 'week') + ' was: percentile of the 2-week value vs the same weeks of 2003–2025' }[st.calMetric],
      clearTip: () => this.setState({ tip: null }),
      tipShow: !!tip, tip: tip || {}, tipLeft: tip ? (tip.x > window.innerWidth - 250 ? tip.x - 236 : tip.x + 16) + 'px' : '0px', tipTop: tip ? (tip.y > window.innerHeight - 190 ? tip.y - 180 : tip.y + 16) + 'px' : '0px',
      zoomIn: () => this.setState(s => ({ mapZoom: Math.min(8, s.mapZoom * 1.5) })), zoomOut: () => this.setState(s => ({ mapZoom: Math.max(1, s.mapZoom / 1.5) })),
      heroInput: this.heroInput, heroSearch: () => this.searchPlace(this.heroInput.current && this.heroInput.current.value),
      hasSearchMsg: !!st.searchMsg, searchMsg: st.searchMsg || '', searchMsgColor: st.searchErr ? '#ffa53a' : '#9fb0cc',
      globeHint: st.region === 'Global'
        ? (liveNow ? 'Live today · ' + fmt(this.liveGlobal.detections) + ' VIIRS detections worldwide · click a country' : g ? st.year + ' · archived ' + (st.source === 'harmonized' ? 'harmonized' : st.source.toUpperCase()) + ' fires · monitored countries' : this.isSample() ? 'Sample hotspots · API offline' : 'Loading NASA FIRMS…')
        : (liveN != null && st.year === CUR_YEAR ? (liveN ? fmt(liveN) + ' live FIRMS detections in ' + st.region + ' · ' + (st.days === 1 ? '24 h' : st.days + ' d') : 'No live FIRMS fires in ' + st.region + ' · ' + (st.days === 1 ? '24 h' : st.days + ' d')) : st.region + ' · ' + st.year),
      onSearchKey: ev => { if (ev.key !== 'Enter') return; this.searchPlace(ev.target.value); },
      archiveCount: this.archive ? String(this.archive.countries.length) : this.reportIndex ? String(this.reportIndex.countries.length) : '—',
    };
  }

  render() {
    const v = this.renderVals();
    return (
      <div className="firelens">
        <svg aria-hidden="true" style={{ position: "absolute", width: 0, height: 0 }}>
          <defs>
            <filter id="fullLiquidFilter">
              <feTurbulence type="fractalNoise" baseFrequency="0.008" numOctaves="1" result="turbulence" />
              <feDisplacementMap in="SourceGraphic" in2="turbulence" scale="12" xChannelSelector="R" yChannelSelector="G" />
            </filter>
          </defs>
        </svg>
      <header data-noprint style={{ position: "sticky", top: "0", zIndex: "30", backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)", background: "rgba(4,6,12,.72)", borderBottom: "1px solid rgba(130,160,210,.1)" }}>
        <div data-m="pad hdr" data-open={v.menuOpen} style={{ maxWidth: "1480px", margin: "0 auto", padding: "14px 28px", display: "flex", alignItems: "center", gap: "32px", flexWrap: "wrap" }}>
          <a href="#top" style={{ display: "flex", alignItems: "center", gap: "12px", color: "#fff" }}>
            <div className="fl-flame" aria-hidden="true">
              <span className="fl-glow"></span>
              <span className="fl-tongue fl-red"></span>
              <span className="fl-tongue fl-orange"></span>
              <span className="fl-tongue fl-yellow"></span>
              <span className="fl-core"></span>
              <span className="fl-spark fl-s1"></span><span className="fl-spark fl-s2"></span><span className="fl-spark fl-s3"></span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", lineHeight: "1.05" }}>
              <span style={{ fontFamily: "'Space Grotesk'", fontWeight: "700", fontSize: "24px", letterSpacing: "-.02em" }}>FireLens</span>
              <span data-m="tag" style={{ fontSize: "12px", color: "#9fb0cc" }}>MODIS × VIIRS Fire Intelligence</span>
            </div>
          </a>
          <button data-m="burger" onClick={v.toggleMenu} aria-label="Menu" aria-expanded={v.menuOpen === "1"} style={{ display: "none", width: "42px", height: "40px", borderRadius: "10px", border: "1px solid rgba(130,160,210,.25)", background: "rgba(255,255,255,.04)", color: "#fff", fontSize: "20px", cursor: "pointer", alignItems: "center", justifyContent: "center" }}>{v.menuGlyph}</button>
          <nav data-m="nav" style={{ display: "flex", gap: "26px", flexWrap: "wrap", fontSize: "14px", fontWeight: "600" }}>
            {v.navItems.map((n, i0) => <React.Fragment key={i0}>
              <button onClick={n.onClick} style={{ background: "none", border: "0", borderBottom: `2px solid ${n.bd}`, padding: "0 0 6px", color: n.color, font: "600 14px Manrope", cursor: "pointer" }}>{n.label}</button>
            </React.Fragment>)}
          </nav>
          <div data-m="hsearch" style={{ flex: "1 1 220px", display: "flex", justifyContent: "flex-end", gap: "12px", alignItems: "center" }}>
            <div style={{ flex: "1 1 200px", maxWidth: "320px", display: "flex", alignItems: "center", gap: "10px", height: "40px", padding: "0 12px", borderRadius: "12px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(130,160,210,.18)" }}>
              <div style={{ width: "12px", height: "12px", border: "2px solid #9fb0cc", borderRadius: "50%", flex: "none" }}></div>
              <input ref={v.headerSearch} placeholder="Search country or region…" onKeyDown={v.onSearchKey} style={{ flex: "1", minWidth: "0", background: "none", border: "0", outline: "none", color: "#e8eefb", font: "500 13px Manrope" }} />
              <span data-m="tag" style={{ fontSize: "11px", color: "#7f8ea8", border: "1px solid rgba(130,160,210,.25)", borderRadius: "6px", padding: "2px 6px" }}>{v.kbdHint}</span>
            </div>
            <button data-m="bell" onClick={v.openAlerts} title="Fire alerts by email" aria-label="Fire alerts by email" style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "center", width: "40px", height: "40px", borderRadius: "12px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(130,160,210,.22)", color: "#ffd2b8", cursor: "pointer" }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg></button>
            <button data-m="cta" onClick={v.nearMe} title="Open the area around your location" style={{ flex: "none", display: "flex", alignItems: "center", gap: "8px", height: "40px", padding: "0 18px", border: "0", borderRadius: "12px", background: "linear-gradient(90deg,#ff4d1a,#ff8a1f)", color: "#fff", font: "700 14px Manrope", boxShadow: "0 6px 24px rgba(255,90,26,.35)", whiteSpace: "nowrap", cursor: "pointer" }}><span aria-hidden="true" style={{ width: "10px", height: "10px", borderRadius: "50%", border: "2px solid #fff", boxShadow: "0 0 0 3px rgba(255,255,255,.25)", flex: "none" }}></span>Fires near me</button>
          </div>
        </div>
      </header>

      <div style={{ display: v.homeDisplay }}>
      <main id="top" data-m="pad" style={{ maxWidth: "1480px", margin: "0 auto", padding: "28px 28px 0" }}>
        <section style={{ display: "flex", flexWrap: "wrap", gap: "28px", alignItems: "flex-start" }}>
          <div data-m="col" style={{ flex: "1 1 320px", maxWidth: "460px", display: "flex", flexDirection: "column", gap: "22px", paddingTop: "12px" }}>
            <div style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: "8px", padding: "7px 14px", borderRadius: "999px", background: "rgba(255,59,59,.1)", border: "1px solid rgba(255,90,60,.35)", fontSize: "12px", fontWeight: "700", letterSpacing: ".06em", color: "#ff7a5a" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#ff3b3b", boxShadow: "0 0 10px #ff3b3b" }}></span>NASA EARTH OBSERVATIONS
            </div>
            <h1 style={{ margin: "0", fontFamily: "'Space Grotesk'", fontWeight: "700", fontSize: "clamp(32px,4.4vw,66px)", lineHeight: "1.02", letterSpacing: "-.03em", color: "#fff" }}>25 Years of Earth’s <span style={{ background: "linear-gradient(90deg,#ff5a1a,#ffb020)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>Fire Activity</span></h1>
            <p style={{ margin: "0", fontSize: "17px", lineHeight: "1.55", color: "#c8d3e8", textWrap: "pretty" }}>One consistent burning-activity record from MODIS and VIIRS active fire hotspots — to examine historical patterns, unusual conditions and critical periods for any area of interest.</p>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", height: "54px", padding: "0 6px 0 16px", borderRadius: "14px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(130,160,210,.28)" }}>
              <div style={{ width: "14px", height: "14px", border: "2px solid #c8d3e8", borderRadius: "50%", flex: "none" }}></div>
              <input ref={v.heroInput} placeholder="Search any place — e.g. Chiang Mai, Rondônia, Sundarbans" onKeyDown={v.onSearchKey} style={{ flex: "1", minWidth: "0", background: "none", border: "0", outline: "none", color: "#fff", font: "500 15px Manrope" }} />
              <button onClick={v.heroSearch} style={{ width: "42px", height: "42px", border: "0", borderRadius: "10px", background: "linear-gradient(135deg,#ff5a1a,#ff8a1f)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: "20px", fontWeight: "700", cursor: "pointer" }}>→</button>
            </div>
            {v.hasSearchMsg && <><div style={{ marginTop: "-12px", fontSize: "13px", color: v.searchMsgColor }}>{v.searchMsg}</div></>}
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: "14px", fontWeight: "600", color: "#c8d3e8" }}>Quick regions</span>{v.notGlobal && <><button onClick={v.resetGlobal} style={{ background: "none", border: "0", padding: "0", color: "#ff9a5a", font: "600 12px Manrope", cursor: "pointer" }}>← Back to global</button></>}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "10px" }}>
                {v.chips.map((c, i0) => <React.Fragment key={i0}>
                  <button onClick={c.onClick} style={{ display: "flex", alignItems: "center", gap: "8px", height: "40px", padding: "0 14px 0 6px", borderRadius: "999px", background: c.bg, border: `1px solid ${c.bd}`, color: "#e8eefb", font: "600 13px Manrope", cursor: "pointer" }}>
                    <span style={{ width: "28px", height: "28px", borderRadius: "50%", display: "block", flex: "none", background: `#1a2438 ${c.flagBg} center / cover no-repeat`, boxShadow: "0 0 0 1px rgba(255,255,255,.25)" }}></span>
                    {c.name}
                  </button>
                </React.Fragment>)}
              </div>
            </div>
          </div>

          <div style={{ flex: "1.5 1 min(440px,100%)", minWidth: "0", display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ width: "100%", maxWidth: "640px", position: "relative" }}>
              <div ref={v.globeRef} style={{ width: "100%", aspectRatio: "1", display: "block", cursor: "grab" }}></div>
              <canvas ref={v.satRef} style={{ position: "absolute", left: "0", top: "0", width: "100%", aspectRatio: "1", pointerEvents: "none" }}></canvas>
              <div style={{ position: "absolute", left: "0", right: "0", bottom: "12%", display: "flex", justifyContent: "center", pointerEvents: "none" }}><span style={{ padding: "6px 12px", borderRadius: "999px", background: "rgba(4,6,12,.7)", border: "1px solid rgba(130,160,210,.2)", fontSize: "12px", color: "#c8d3e8" }}>{v.globeHint}</span></div>
            </div>
            <div style={{ width: "100%", maxWidth: "560px", display: "flex", alignItems: "center", gap: "18px", marginTop: "-18px", position: "relative" }}>
              <button onClick={v.togglePlay} style={{ flex: "none", width: "48px", height: "48px", borderRadius: "50%", border: "1.5px solid rgba(255,255,255,.7)", background: "rgba(4,6,12,.6)", color: "#fff", fontSize: "16px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>{v.playGlyph}</button>
              <span style={{ fontFamily: "'Space Grotesk'", fontWeight: "600", fontSize: "14px" }}>2000</span>
              <div style={{ flex: "1", display: "flex", flexDirection: "column", gap: "8px" }}>
                <div onPointerDown={v.trackDown} onPointerMove={v.trackMove} onPointerUp={v.trackUp} style={{ position: "relative", height: "22px", cursor: "pointer", touchAction: "none" }}>
                  <div style={{ position: "absolute", left: "0", right: "0", top: "9px", height: "4px", borderRadius: "4px", background: "linear-gradient(90deg,#2a6dff,#3b8cff 40%,#ff9a1f 60%,#ff3b2a)" }}></div>
                  <div style={{ position: "absolute", left: "44.4%", top: "3px", width: "1px", height: "16px", background: "rgba(255,255,255,.5)" }}></div>
                  <div style={{ position: "absolute", top: "1px", left: v.yearPct, width: "20px", height: "20px", marginLeft: "-10px", borderRadius: "50%", background: "radial-gradient(circle,#ffd04a,#ff8a1f)", boxShadow: "0 0 0 4px rgba(255,138,31,.25),0 0 16px #ff8a1f" }}></div>
                </div>
                <div style={{ position: "relative", height: "30px", fontSize: "12px" }}>
                  <span style={{ position: "absolute", left: "4%", color: "#5aa0ff", fontWeight: "700" }}>MODIS</span>
                  <span style={{ position: "absolute", left: "44.4%", transform: "translateX(-50%)", textAlign: "center", color: "#c8d3e8", lineHeight: "1.25" }}><b style={{ color: "#fff" }}>2012</b><br />overlap</span>
                  <span style={{ position: "absolute", right: "6%", color: "#ff9a3a", fontWeight: "700" }}>VIIRS</span>
                </div>
              </div>
              <span style={{ fontFamily: "'Space Grotesk'", fontWeight: "600", fontSize: "14px" }}>2026</span>
              <span style={{ position: "absolute", right: "0", top: "-34px", fontFamily: "'Space Grotesk'", fontSize: "13px", color: "#ffb27a", fontWeight: "600" }}>Showing {v.year}</span>
            </div>
          </div>

          <div data-m="col" style={{ flex: "1 1 320px", maxWidth: "420px", display: "flex", flexDirection: "column", gap: "16px", paddingTop: "12px" }}>
            <div className="glass" style={{ padding: "20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
                <div style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>{v.regionName} <span style={{ color: "#9fb0cc", fontWeight: "400", fontSize: "14px" }}>· harmonized</span></div>
                <span style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#3ddc84", fontWeight: "700" }}><span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#3ddc84", boxShadow: "0 0 8px #3ddc84" }}></span>{v.heroWhen}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "18px", margin: "16px 0 18px", flexWrap: "wrap" }}>
                <span style={{ fontFamily: "'Space Grotesk'", fontSize: "52px", fontWeight: "700", letterSpacing: "-.03em", lineHeight: "1" }}>{v.heroCount}</span>
                <div style={{ lineHeight: "1.3" }}>
                  <div style={{ fontFamily: "'Space Grotesk'", fontSize: "20px", fontWeight: "700", color: v.deltaColor }}>{v.heroDelta}</div>
                  <div style={{ fontSize: "13px", color: "#c8d3e8" }}>{v.heroBasis}</div>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "10px" }}>
                <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.12)" }}>
                  <div style={{ fontSize: "12px", color: "#9fb0cc" }}>FRP</div>
                  <div style={{ fontFamily: "'Space Grotesk'", fontSize: "18px", fontWeight: "700" }}>{v.regionFrp}</div>
                  <div style={{ fontSize: "12px", color: v.frpColor }}>{v.regionFrpD}</div>
                </div>
                <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.12)" }}>
                  <div style={{ fontSize: "12px", color: "#9fb0cc" }}>Percentile</div>
                  <div style={{ fontFamily: "'Space Grotesk'", fontSize: "18px", fontWeight: "700" }}>{v.regionPct}</div>
                  <div style={{ fontSize: "12px", color: "#9fb0cc" }}>of weeks</div>
                </div>
                <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.12)" }}>
                  <div style={{ fontSize: "12px", color: "#9fb0cc" }}>Anomalies</div>
                  <div style={{ fontFamily: "'Space Grotesk'", fontSize: "18px", fontWeight: "700" }}>{v.anomCount}</div>
                  <div style={{ fontSize: "12px", color: "#ff6a4a" }}>flagged this year</div>
                </div>
              </div>
            </div>

            <div className="glass" style={{ padding: "20px" }}>
              <div style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>Fire activity trend <span style={{ color: "#9fb0cc", fontWeight: "400", fontSize: "14px" }}>· monthly</span></div>
              <div style={{ position: "relative", height: "190px", margin: "16px 0 26px 36px" }}>
                {v.yTicks.map((t, i0) => <React.Fragment key={i0}>
                  <div style={{ position: "absolute", left: "0", right: "0", top: t.top, borderTop: "1px solid rgba(130,160,210,.1)" }}><span style={{ position: "absolute", left: "-36px", top: "-8px", fontSize: "11px", color: "#7f8ea8" }}>{t.label}</span></div>
                </React.Fragment>)}
                <svg viewBox="0 0 1000 300" preserveAspectRatio="none" style={{ position: "absolute", inset: "0", width: "100%", height: "100%", overflow: "visible" }}>
                  <defs><linearGradient id="fl-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ff7a1a" stopOpacity=".45"></stop><stop offset="1" stopColor="#ff7a1a" stopOpacity="0"></stop></linearGradient></defs>
                  <path d={v.trendArea} fill="url(#fl-area)"></path>
                  <path d={v.modisLine} fill="none" stroke="#3b8cff" strokeWidth="1.4" vectorEffect="non-scaling-stroke"></path>
                  <path d={v.viirsLine} fill="none" stroke="#ffd04a" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" opacity=".8"></path>
                  <path d={v.harmLine} fill="none" stroke="#ff7a1a" strokeWidth="1.8" vectorEffect="non-scaling-stroke"></path>
                </svg>
                <div style={{ position: "absolute", top: "-6px", bottom: "0", left: "44.4%", borderLeft: "1px dashed rgba(255,255,255,.35)" }}></div>
                <div style={{ position: "absolute", top: "0", bottom: "0", left: v.markerPct, width: "2px", marginLeft: "-1px", background: "#ffb27a", boxShadow: "0 0 8px #ff8a1f" }}></div>
                {v.xTicks.map((x, i0) => <React.Fragment key={i0}>
                  <span style={{ position: "absolute", bottom: "-22px", left: x.left, transform: "translateX(-50%)", fontSize: "11px", color: "#7f8ea8" }}>{x.label}</span>
                </React.Fragment>)}
              </div>
              <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", fontSize: "12px", color: "#c8d3e8" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "6px" }}><span style={{ width: "14px", height: "3px", borderRadius: "2px", background: "#ff7a1a" }}></span>Harmonized</span>
                <span style={{ display: "flex", alignItems: "center", gap: "6px" }}><span style={{ width: "14px", height: "3px", borderRadius: "2px", background: "#3b8cff" }}></span>MODIS raw</span>
                <span style={{ display: "flex", alignItems: "center", gap: "6px" }}><span style={{ width: "14px", height: "0", borderTop: "2px dashed #ffd04a" }}></span>VIIRS raw</span>
                <span style={{ marginLeft: "auto", color: "#ffb27a", fontWeight: "600" }}>{v.markerLabel}</span>
              </div>
            </div>
          </div>
        </section>

        <section id="explore" style={{ marginTop: "8px", scrollMarginTop: "90px", display: "flex", flexDirection: "column", gap: "18px" }}>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: "12px", fontWeight: "700", letterSpacing: ".1em", color: "#ff8a4a" }}>AREA OF INTEREST</div>
              <h2 style={{ margin: "6px 0 0", fontFamily: "'Space Grotesk'", fontSize: "32px", fontWeight: "700", letterSpacing: "-.02em" }}>Explore {v.regionName}</h2>
              {v.plainSummary && <p style={{ margin: "8px 0 0", maxWidth: "760px", fontSize: "15px", lineHeight: "1.55", color: "#c8d3e8", textWrap: "pretty" }}>{v.plainSummary}</p>}
            </div>
            <div style={{ display: "flex", gap: "4px", padding: "4px", borderRadius: "12px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(130,160,210,.16)" }}>
              {v.srcTabs.map((s, i0) => <React.Fragment key={i0}>
                <button onClick={s.onClick} style={{ height: "34px", padding: "0 18px", borderRadius: "9px", border: `1px solid ${s.bd}`, background: s.bg, color: s.color, font: "700 13px Manrope", cursor: "pointer" }}>{s.label}</button>
              </React.Fragment>)}
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "18px", alignItems: "flex-start" }}>
            <div data-m="lgroup" style={{ flex: "2.5 1 min(900px,100%)", minWidth: "0", display: "flex", flexWrap: "wrap", gap: "18px", alignItems: "stretch" }}>
            <div className="glass" style={{ flex: "1 1 min(380px,100%)", minWidth: "0", overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 18px" }}>
                <span style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>Hotspot map</span>
                <span style={{ fontSize: "12px", color: "#9fb0cc" }}>{v.mapNote}</span>
              </div>
              <div style={{ position: "relative", flex: "1", minHeight: "380px" }}>
                <canvas ref={v.mapRef} onPointerDown={v.mapDown} onPointerMove={v.mapMove} onPointerUp={v.mapUp} style={{ position: "absolute", inset: "0", width: "100%", height: "100%", display: "block", cursor: v.drawCursor, touchAction: v.drawTouch }}></canvas>
                {v.drawBox && <div style={{ position: "absolute", left: v.drawBox.left, top: v.drawBox.top, width: v.drawBox.width, height: v.drawBox.height, border: "2px dashed #ffb27a", background: "rgba(255,138,31,.12)", pointerEvents: "none" }}></div>}
                {v.watchMarks.map((m, i2) => <button key={i2} onClick={m.onClick} title={m.title} style={{ position: "absolute", left: m.left, top: m.top, transform: "translate(-50%,-50%)", width: "22px", height: "22px", borderRadius: "50%", border: "2px solid #fff", background: "#ff3b2a", color: "#fff", font: "800 11px Manrope", cursor: "pointer", boxShadow: "0 0 10px rgba(255,59,42,.8)", padding: 0 }}>{m.n}</button>)}
                {v.drawing && <div style={{ position: "absolute", left: "56px", top: "12px", padding: "8px 12px", borderRadius: "10px", background: "rgba(8,12,22,.9)", border: "1px solid #ffb27a", color: "#ffd2b5", font: "600 12px Manrope", pointerEvents: "none" }}>Drag on the map to draw your area of interest</div>}
                <input ref={v.geoInput} type="file" accept=".json,.geojson,application/geo+json,application/json" onChange={v.onGeoFile} style={{ display: "none" }} />
                <div style={{ position: "absolute", left: "12px", top: "12px", display: "flex", flexDirection: "column", gap: "4px", padding: "5px", borderRadius: "12px", background: "rgba(8,12,22,.85)", border: "1px solid rgba(130,160,210,.18)" }}>
                  <button onClick={v.zoomIn} style={{ width: "32px", height: "32px", borderRadius: "8px", border: "0", background: "rgba(255,255,255,.05)", color: "#fff", fontSize: "18px", cursor: "pointer" }}>+</button>
                  <button onClick={v.zoomOut} style={{ width: "32px", height: "32px", borderRadius: "8px", border: "0", background: "rgba(255,255,255,.05)", color: "#fff", fontSize: "18px", cursor: "pointer" }}>−</button>
                  <button onClick={v.toggleDraw} title="Draw an area of interest" style={{ width: "32px", height: "32px", borderRadius: "8px", border: "0", background: v.drawBtnBg, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><span style={{ width: "12px", height: "12px", border: "1.5px dashed #c8d3e8", borderRadius: "2px" }}></span></button>
                  <button onClick={v.pickGeo} title="Upload a GeoJSON area (Polygon / MultiPolygon)" style={{ width: "32px", height: "32px", borderRadius: "8px", border: "0", background: "rgba(255,255,255,.05)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><span style={{ width: "12px", height: "12px", border: "1.5px solid #c8d3e8", borderRadius: "50%" }}></span></button>
                </div>
                <div style={{ position: "absolute", left: "12px", bottom: "12px", padding: "10px 12px", borderRadius: "10px", background: "rgba(8,12,22,.85)", border: "1px solid rgba(130,160,210,.18)", fontSize: "11px", color: "#c8d3e8", minWidth: "170px" }}>
                  <div style={{ fontWeight: "700", marginBottom: "6px" }}>FRP (MW)</div>
                  <div style={{ height: "6px", borderRadius: "3px", background: "linear-gradient(90deg,#b0283f,#e5402a,#ff7a1a,#ffd04a)" }}></div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: "4px", color: "#9fb0cc" }}><span>0</span><span>10</span><span>50</span><span>200+</span></div>
                </div>
              </div>
            </div>

            <div className="glass" id="calendar" style={{ flex: "1.5 1 520px", minWidth: "0", scrollMarginTop: "90px", padding: "18px", display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>Burning activity calendar</div>
                  <div style={{ fontSize: "12px", color: "#9fb0cc", marginTop: "2px" }}>Hotspots per {v.calUnit}, {v.sourceLabel}</div>
                  {v.hasCrit && <div style={{ fontSize: "12px", color: "#ffb27a", marginTop: "4px" }}>Critical period {v.critShort}</div>}
                  {v.hasNoArchive && <div style={{ fontSize: "12px", color: "#ffa53a", marginTop: "4px", maxWidth: "460px" }}>{v.noArchiveMsg}</div>}
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button onClick={v.goCalendar} style={{ height: "34px", padding: "0 12px", borderRadius: "9px", background: "rgba(255,106,26,.12)", border: "1px solid rgba(255,106,26,.45)", color: "#ffd2b5", font: "700 13px Manrope", cursor: "pointer", whiteSpace: "nowrap" }}>Full calendar →</button>
                  <select value={v.calMode} onChange={v.onModeSelect} style={{ height: "34px", padding: "0 10px", borderRadius: "9px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(130,160,210,.2)", color: "#e8eefb", font: "600 13px Manrope" }}>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "40px repeat(12,minmax(0,1fr))", fontSize: "11px", color: "#9fb0cc" }}>
              <div title={v.critText} style={{ display: v.hasCrit ? "flex" : "none", alignItems: "center", marginBottom: "3px" }}><span style={{ width: "40px", flex: "none", fontSize: "9px", color: "#ffb27a", fontWeight: "700" }}>CRIT.</span><div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(52,minmax(0,1fr))", gap: "2px" }}>{v.critBand.map((c, i9) => <span key={i9} style={{ height: "5px", borderRadius: "1px", background: c }}></span>)}</div></div>
                <span></span><span>Jan</span><span>Feb</span><span>Mar</span><span>Apr</span><span>May</span><span>Jun</span><span>Jul</span><span>Aug</span><span>Sep</span><span>Oct</span><span>Nov</span><span>Dec</span>
              </div>
              <div onMouseLeave={v.clearTip} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                {v.calRows.map((r, i0) => <React.Fragment key={i0}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0", outline: r.outline, outlineOffset: "1px", borderRadius: "2px" }}>
                    <span style={{ width: "40px", flex: "none", fontSize: "10px", color: r.labelColor, fontFamily: "'Space Grotesk'" }}>{r.label}</span>
                    <div style={{ flex: "1", display: "grid", gridTemplateColumns: `repeat(${v.calCols},minmax(0,1fr))`, gap: "2px" }}>
                      {r.cells.map((c, i1) => <React.Fragment key={i1}>
                        <div onMouseEnter={c.onEnter} onClick={c.onClick} style={{ cursor: "pointer", height: "10px", borderRadius: "1.5px", background: c.bg }}></div>
                      </React.Fragment>)}
                    </div>
                  </div>
                </React.Fragment>)}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "12px", color: "#9fb0cc", marginTop: "4px", flexWrap: "wrap" }}>
                <span>Low</span>
                <div style={{ flex: "1", minWidth: "120px", maxWidth: "320px", height: "6px", borderRadius: "3px", background: "linear-gradient(90deg,#121a3d,#1f2b6b,#5a2a7a,#b0283f,#e5402a,#ff7a1a,#ffd04a)" }}></div>
                <span>High</span>
                <span style={{ marginLeft: "auto" }}>Log colour scale · empty = no sensor data · hover for gap-filled / provisional weeks</span>
              </div>
            </div>

              <div className="glass" data-m="casecard" style={{ flex: "1.6 1 min(460px,100%)", minWidth: "0", padding: "18px", display: "flex", flexDirection: "column", gap: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                  <div><div style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>Case studies</div><div style={{ fontSize: "12px", color: "#9fb0cc", marginTop: "2px" }}>Known fire events the harmonized record picks out — open one to see it</div></div>
                  <button onClick={v.goCases} style={{ height: "30px", padding: "0 10px", borderRadius: "8px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(130,160,210,.22)", color: "#e8eefb", font: "600 12px Manrope", cursor: "pointer", whiteSpace: "nowrap" }}>All cases →</button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(230px,100%),1fr))", gap: "10px" }}>
                  {v.cases.map((c, i2) => <button key={i2} onClick={c.onClick} style={{ display: "flex", flexDirection: "column", gap: "4px", textAlign: "left", padding: "12px 14px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.14)", color: "#e8eefb", cursor: "pointer", font: "600 13px Manrope" }}>
                    <span style={{ display: "flex", gap: "8px", alignItems: "baseline" }}><span style={{ color: "#ffb27a", fontFamily: "'Space Grotesk'", fontWeight: "700" }}>{c.year}</span><span>{c.title}</span></span>
                    <span style={{ fontWeight: "500", fontSize: "12px", color: "#9fb0cc", lineHeight: "1.4" }}>{c.note}</span>
                  </button>)}
                </div>
              </div>
              <div className="glass" id="anomalies" data-m="anomcard" style={{ flex: "1 1 min(340px,100%)", minWidth: "0", scrollMarginTop: "90px", padding: "18px", display: "flex", flexDirection: "column", gap: "4px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}><div style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>Recent anomalies</div><button onClick={v.goAnom} style={{ height: "30px", padding: "0 10px", borderRadius: "8px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(130,160,210,.22)", color: "#e8eefb", font: "600 12px Manrope", cursor: "pointer" }}>View all →</button></div>
                {v.hasOutlook && <button onClick={v.goAnom} style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", padding: "8px 10px", borderRadius: "10px", background: v.riskTint, border: `1px solid ${v.riskColor}`, color: "#e8eefb", font: "600 12px Manrope", cursor: "pointer", textAlign: "left" }}><span style={{ width: "8px", height: "8px", borderRadius: "50%", background: v.riskColor, flex: "none" }}></span>{v.outlookMini}</button>}
                {v.anomTop.map((a, i0) => <React.Fragment key={i0}>
                  <div style={{ display: "flex", gap: "12px", alignItems: "center", padding: "10px 0", borderTop: "1px solid rgba(130,160,210,.1)" }}>
                    <div style={{ width: "36px", height: "36px", flex: "none", borderRadius: "10px", background: a.tint, border: `1px solid ${a.color}`, display: "flex", alignItems: "center", justifyContent: "center" }}><span style={{ width: "10px", height: "10px", background: a.color, transform: "rotate(45deg)" }}></span></div>
                    <div style={{ flex: "1", minWidth: "0" }}><div style={{ fontSize: "13px", fontWeight: "700" }}>{a.title}</div><div style={{ fontSize: "12px", color: "#9fb0cc" }}>{a.when}</div></div>
                    <div style={{ textAlign: "right", fontSize: "12px" }}><div style={{ color: a.color, fontWeight: "700" }}>{a.pctl}</div><div style={{ color: "#9fb0cc" }}>{a.vs}</div></div>
                  </div>
                </React.Fragment>)}
              </div>
            </div>
            <div data-m="rcol" style={{ flex: "1 1 min(300px,100%)", minWidth: "0", display: "flex", flexDirection: "column", gap: "18px" }}>
              <div className="glass" style={{ padding: "18px", display: "flex", flexDirection: "column", gap: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}><div style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>Current area analysis</div><button onClick={v.goHarm} style={{ height: "30px", padding: "0 10px", borderRadius: "8px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(130,160,210,.22)", color: "#e8eefb", font: "600 12px Manrope", cursor: "pointer", whiteSpace: "nowrap" }}>Harmonize details →</button></div>
                <div>
                  <div style={{ fontFamily: "'Space Grotesk'", fontSize: "20px", fontWeight: "700" }}>{v.regionName}</div>
                  <div style={{ fontSize: "12px", color: "#9fb0cc" }}>{v.regionSub} · {v.regionCoord}</div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "10px" }}>
                  <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.12)" }}>
                    <div style={{ fontSize: "12px", color: "#9fb0cc" }}>Harmonized fires</div>
                    <div style={{ fontFamily: "'Space Grotesk'", fontSize: "20px", fontWeight: "700" }}>{v.heroCount}</div>
                    <div style={{ fontSize: "12px", color: v.deltaColor }}>{v.heroDelta}</div>
                  </div>
                  <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.12)" }}>
                    <div style={{ fontSize: "12px", color: "#9fb0cc" }}>FRP</div>
                    <div style={{ fontFamily: "'Space Grotesk'", fontSize: "20px", fontWeight: "700" }}>{v.regionFrp}</div>
                    <div style={{ fontSize: "12px", color: v.frpColor }}>{v.regionFrpD}</div>
                  </div>
                  <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.12)" }}>
                    <div style={{ fontSize: "12px", color: "#9fb0cc" }}>Historical percentile</div>
                    <div style={{ fontFamily: "'Space Grotesk'", fontSize: "20px", fontWeight: "700" }}>{v.regionPct}</div>
                    <div style={{ fontSize: "12px", color: "#ff8a4a" }}>{v.pctNote}</div>
                  </div>
                  <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.12)" }}>
                    <div style={{ fontSize: "12px", color: "#9fb0cc" }}>Season status</div>
                    <div style={{ fontFamily: "'Space Grotesk'", fontSize: "20px", fontWeight: "700" }}>{v.regionStatus}</div>
                    <div style={{ fontSize: "12px", color: "#3ddc84" }}>{v.regionStatusSub}</div>
                  </div>
                </div>
              </div>

              {v.hasCorrob && <div className="glass" style={{ padding: "18px", display: "flex", flexDirection: "column", gap: "10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}><div style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>Is it a real fire?</div><span style={{ fontSize: "12px", color: "#9fb0cc" }}>{v.corrobWindow}</span></div>
                <div style={{ display: "flex", height: "10px", borderRadius: "5px", overflow: "hidden", background: "rgba(255,255,255,.05)" }}>{v.corrobRows.map((r, i2) => <span key={i2} style={{ width: r.w, background: r.color }}></span>)}</div>
                {v.corrobRows.map((r, i2) => <div key={i2} style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "13px" }}><span style={{ width: "10px", height: "10px", borderRadius: "50%", background: r.color, flex: "none" }}></span><span style={{ fontWeight: "700", minWidth: "76px" }}>{r.label}</span><span style={{ flex: 1, minWidth: 0, fontSize: "12px", color: "#9fb0cc" }}>{r.desc}</span><span style={{ fontFamily: "'Space Grotesk'", fontWeight: "700" }}>{r.n}</span><span style={{ width: "38px", textAlign: "right", fontSize: "12px", color: "#9fb0cc" }}>{r.pct}</span></div>)}
              </div>}

{v.hasWatch && <div className="glass" style={{ padding: "18px", display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}><div style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>Where to look now</div><span style={{ fontSize: "12px", color: "#9fb0cc" }}>{v.watchWhen}</span></div>
                <div style={{ fontSize: "12px", color: "#9fb0cc" }}>0.25° cells burning furthest above their own 2003–2025 normal · click to zoom in</div>
                {v.watchRows.map((w, i2) => <button key={i2} onClick={w.onClick} style={{ display: "grid", gridTemplateColumns: "22px minmax(0,1fr) auto", gap: "10px", alignItems: "center", textAlign: "left", padding: "7px 0", border: "0", borderTop: "1px solid rgba(130,160,210,.1)", background: "none", color: "#e8eefb", cursor: "pointer", font: "600 13px Manrope" }}><span style={{ width: "22px", height: "22px", borderRadius: "50%", background: "#ff3b2a", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", fontWeight: "800" }}>{w.n}</span><span style={{ minWidth: 0 }}>{w.place}<span style={{ display: "block", fontSize: "12px", color: "#9fb0cc", fontWeight: "500" }}>{w.detail}</span></span><span style={{ fontFamily: "'Space Grotesk'", fontWeight: "700", color: "#ff7a4a" }}>{w.ratio}</span></button>)}
              </div>}
              {v.noWatch && <div style={{ padding: "14px 18px", borderRadius: "14px", background: "rgba(61,220,132,.06)", border: "1px solid rgba(61,220,132,.3)", fontSize: "13px", color: "#bff5d6" }}>Where to look now: no cell in this area is burning well above its own normal over the last two weeks.</div>}

            </div>
          </div>
        </section>


      </main>

      <section id="about" style={{ position: "relative", overflow: "hidden", marginTop: "40px", paddingTop: "120px" }}>
        <div data-m="earth" style={{ position: "absolute", left: "-20%", width: "140%", top: "40px", bottom: "0", borderRadius: "50% 50% 0 0 / 180px 180px 0 0", overflow: "hidden", background: "url('/earth-night.jpg') center 22% / cover no-repeat", boxShadow: "0 -18px 60px rgba(90,140,255,.18)" }}>
          <div style={{ position: "absolute", inset: "0", background: "linear-gradient(180deg,rgba(4,6,12,0) 0%,rgba(4,6,12,.3) 30%,rgba(4,6,12,.62) 70%,rgba(4,6,12,.78) 100%)" }}></div>
        </div>
        <div data-m="pad" style={{ position: "relative", maxWidth: "1480px", margin: "0 auto", padding: "0 28px 28px" }}>
          <div className="glass" data-m="stats" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(150px,100%),1fr))", gap: "0", padding: "6px 8px" }}>
            <div data-m="stat" style={{ padding: "18px 20px", borderRight: "1px solid rgba(130,160,210,.12)" }}><div style={{ fontFamily: "'Space Grotesk'", fontSize: "22px", fontWeight: "700" }}>25+</div><div style={{ fontSize: "13px", color: "#9fb0cc" }}>Years of data (2000–2026)</div></div>
            <div data-m="stat" style={{ padding: "18px 20px", borderRight: "1px solid rgba(130,160,210,.12)" }}><div style={{ fontFamily: "'Space Grotesk'", fontSize: "22px", fontWeight: "700" }}>2</div><div style={{ fontSize: "13px", color: "#9fb0cc" }}>Sensors: MODIS + VIIRS</div></div>
            <div data-m="stat" style={{ padding: "18px 20px", borderRight: "1px solid rgba(130,160,210,.12)" }}><div style={{ fontFamily: "'Space Grotesk'", fontSize: "22px", fontWeight: "700" }}>{v.archiveCount}</div><div style={{ fontSize: "13px", color: "#9fb0cc" }}>Countries · 26-year archive, live worldwide</div></div>
            <div data-m="stat" style={{ padding: "18px 20px", borderRight: "1px solid rgba(130,160,210,.12)" }}><div style={{ fontFamily: "'Space Grotesk'", fontSize: "22px", fontWeight: "700" }}>Open data</div><div style={{ fontSize: "13px", color: "#9fb0cc" }}>NASA FIRMS archive</div></div>
            <div data-m="stat" style={{ padding: "18px 20px" }}><div style={{ fontFamily: "'Space Grotesk'", fontSize: "22px", fontWeight: "700" }}>8-week outlook</div><div style={{ fontSize: "13px", color: "#9fb0cc" }}>Early warning for responders &amp; land managers</div></div>
          </div>
          <div style={{ marginTop: "28px", paddingTop: "18px", borderTop: "1px solid rgba(255,255,255,.08)", display: "flex", justifyContent: "space-between", gap: "16px", flexWrap: "wrap", fontSize: "12px", color: "#9fb0cc" }}>
            <span>Built for the 2026 NASA Space Apps Challenge · Harmonization of MODIS and VIIRS Hot Spots</span>
            <span>{v.dataNote}</span>
          </div>
        </div>
      </section>

      </div>
      {v.isDetail && <>
      <main data-m="pad" style={{ maxWidth: "1480px", margin: "0 auto", padding: "28px 28px 60px", display: "flex", flexDirection: "column", gap: "20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "16px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <button onClick={v.goHome} style={{ alignSelf: "flex-start", background: "none", border: "0", padding: "0", color: "#9fb0cc", font: "600 13px Manrope", cursor: "pointer" }}>← Home</button>
            <h1 data-m="h1" style={{ margin: "0", fontFamily: "'Space Grotesk'", fontSize: "40px", fontWeight: "700", letterSpacing: "-.02em", color: "#fff" }}>{v.pageTitle} {!v.isCases && <span style={{ color: "#ff8a4a" }}>· {v.regionName}</span>}</h1>
            <p style={{ margin: "0", color: "#c8d3e8", fontSize: "15px", maxWidth: "680px", textWrap: "pretty" }}>{v.pageSub}</p>
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ display: "flex", alignItems: "center", gap: "6px", height: "34px", padding: "0 12px", borderRadius: "999px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.18)", fontSize: "12px", fontWeight: "700", color: v.apiColor }}><span style={{ width: "7px", height: "7px", borderRadius: "50%", background: v.apiColor }}></span>{v.apiLabel}</span>
            <button data-noprint onClick={v.goReport} style={{ height: "34px", padding: "0 14px", borderRadius: "999px", background: "rgba(61,220,132,.08)", border: "1px solid rgba(61,220,132,.45)", color: "#bff5d6", font: "700 13px Manrope", cursor: "pointer" }}>Area report ⎙</button>
            <button data-noprint onClick={v.openAlerts} style={{ height: "34px", padding: "0 14px", borderRadius: "999px", background: "rgba(255,106,26,.08)", border: "1px solid rgba(255,106,26,.5)", color: "#ffd2b8", font: "700 13px Manrope", cursor: "pointer" }}>Email alerts 🔔</button>
            {v.pageChips.map((c, i1) => <React.Fragment key={i1}>
              <button onClick={c.onClick} style={{ height: "34px", padding: "0 14px", borderRadius: "999px", background: c.bg, border: `1px solid ${c.bd}`, color: "#e8eefb", font: "600 13px Manrope", cursor: "pointer" }}>{c.name}</button>
            </React.Fragment>)}
          </div>
        </div>

        {v.isHarm && <>
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center", padding: "12px", borderRadius: "14px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.14)" }}>
              <span style={{ fontSize: "12px", color: "#9fb0cc", fontWeight: "700" }}>WINDOW</span>
              <div style={{ display: "flex", gap: "4px" }}>
                {v.dayTabs.map((d, i2) => <React.Fragment key={i2}><button onClick={d.onClick} style={{ height: "32px", padding: "0 12px", borderRadius: "8px", border: `1px solid ${d.bd}`, background: d.bg, color: "#e8eefb", font: "700 12px Manrope", cursor: "pointer" }}>{d.label}</button></React.Fragment>)}
              </div>
              <span style={{ fontSize: "12px", color: "#9fb0cc", fontWeight: "700", marginLeft: "8px" }}>LAND COVER</span>
              <select value={v.landcover} onChange={v.onLandcover} style={{ height: "32px", padding: "0 10px", borderRadius: "8px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(130,160,210,.2)", color: "#e8eefb", font: "600 13px Manrope" }}>
                <option value="All">Local (learned)</option><option value="Forest">Forest</option><option value="Savanna">Savanna</option><option value="Cropland">Cropland</option><option value="Shrubland">Shrubland</option>
              </select>
              <button onClick={v.runHarm} style={{ marginLeft: "auto", height: "36px", padding: "0 18px", border: "0", borderRadius: "10px", background: "linear-gradient(90deg,#ff4d1a,#ff8a1f)", color: "#fff", font: "700 13px Manrope", cursor: "pointer" }}>Run harmonization</button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(260px,100%),1fr))", gap: "16px" }}>
              <div className="glass" style={{ padding: "20px", background: "linear-gradient(180deg,rgba(59,140,255,.10),rgba(255,255,255,.02))", border: "1px solid rgba(59,140,255,.35)" }}>
                <div style={{ fontSize: "12px", fontWeight: "700", letterSpacing: ".06em", color: "#5aa0ff" }}>MODIS · RAW</div>
                <div style={{ fontFamily: "'Space Grotesk'", fontSize: "44px", fontWeight: "700", marginTop: "8px" }}>{v.hModis}</div>
                <div style={{ fontSize: "13px", color: "#c8d3e8" }}>hotspots · {v.hModisFrp} FRP</div>
                <div style={{ fontSize: "12px", color: "#9fb0cc", marginTop: "12px" }}>Terra / Aqua · 1 km pixels · 2000–present</div>
              </div>
              <div className="glass" style={{ padding: "20px", background: "linear-gradient(180deg,rgba(255,176,32,.10),rgba(255,255,255,.02))", border: "1px solid rgba(255,176,32,.35)" }}>
                <div style={{ fontSize: "12px", fontWeight: "700", letterSpacing: ".06em", color: "#ffb020" }}>VIIRS · RAW</div>
                <div style={{ fontFamily: "'Space Grotesk'", fontSize: "44px", fontWeight: "700", marginTop: "8px" }}>{v.hViirs}</div>
                <div style={{ fontSize: "13px", color: "#c8d3e8" }}>hotspots · {v.hViirsFrp} FRP</div>
                <div style={{ fontSize: "12px", color: "#9fb0cc", marginTop: "12px" }}>S-NPP + NOAA-20 · 375 m pixels · 2012–present</div>
              </div>
              <div className="glass" style={{ padding: "20px", background: "linear-gradient(180deg,rgba(255,106,26,.14),rgba(255,255,255,.02))", border: "1px solid rgba(255,106,26,.55)", boxShadow: "0 0 40px rgba(255,90,26,.12)" }}>
                <div style={{ fontSize: "12px", fontWeight: "700", letterSpacing: ".06em", color: "#ff8a4a" }}>HARMONIZED</div>
                <div style={{ fontFamily: "'Space Grotesk'", fontSize: "44px", fontWeight: "700", marginTop: "8px" }}>{v.hHarm}</div>
                <div style={{ fontSize: "13px", color: "#c8d3e8" }}>MODIS-equivalent · {v.hHarmFrp} FRP</div>
                <div style={{ fontSize: "12px", color: "#9fb0cc", marginTop: "12px" }}>α = {v.hAlpha} · {v.hMethod}</div>
              </div>
            </div>

            <div className="glass" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}><span style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>Sensor disparity</span><span style={{ fontSize: "13px", color: "#c8d3e8" }}>VIIRS sees <b style={{ color: "#ffb020" }}>{v.hRatio}</b> more hotspots than MODIS in the same area and window <span style={{ color: "#9fb0cc" }}>({v.hWindow})</span></span></div>
              <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 80px", gap: "10px 14px", alignItems: "center", fontSize: "13px" }}>
                <span style={{ color: "#5aa0ff", fontWeight: "700" }}>MODIS</span><div style={{ height: "14px", borderRadius: "4px", background: "rgba(255,255,255,.04)" }}><div style={{ height: "100%", width: v.modisW, minWidth: "3px", borderRadius: "4px", background: "#3b8cff" }}></div></div><span style={{ textAlign: "right" }}>{v.hModis}</span>
                <span style={{ color: "#ffb020", fontWeight: "700" }}>VIIRS</span><div style={{ height: "14px", borderRadius: "4px", background: "rgba(255,255,255,.04)" }}><div style={{ height: "100%", width: v.viirsW, borderRadius: "4px", background: "#ffb020" }}></div></div><span style={{ textAlign: "right" }}>{v.hViirs}</span>
                <span style={{ color: "#ff8a4a", fontWeight: "700" }}>Harmonized</span><div style={{ height: "14px", borderRadius: "4px", background: "rgba(255,255,255,.04)" }}><div style={{ height: "100%", width: v.harmW, borderRadius: "4px", background: "linear-gradient(90deg,#ff4d1a,#ff8a1f)" }}></div></div><span style={{ textAlign: "right" }}>{v.hHarm}</span>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(340px,100%),1fr))", gap: "16px" }}>
              <div className="glass" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "14px" }}>
                <span style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>Method</span>
                <div style={{ display: "flex", gap: "12px" }}><span style={{ width: "26px", height: "26px", flex: "none", borderRadius: "50%", background: "rgba(255,106,26,.15)", color: "#ff8a4a", font: "700 12px 'Space Grotesk'", display: "flex", alignItems: "center", justifyContent: "center" }}>1</span><div style={{ fontSize: "13px", color: "#c8d3e8", lineHeight: "1.5" }}><b style={{ color: "#fff" }}>Overlap calibration.</b> MODIS (Terra + Aqua) and VIIRS S-NPP detections on the same 0.25° cells and weeks, 2012–present. Static industrial sources and low-confidence pixels removed.</div></div>
                <div style={{ display: "flex", gap: "12px" }}><span style={{ width: "26px", height: "26px", flex: "none", borderRadius: "50%", background: "rgba(255,106,26,.15)", color: "#ff8a4a", font: "700 12px 'Space Grotesk'", display: "flex", alignItems: "center", justifyContent: "center" }}>2</span><div style={{ fontSize: "13px", color: "#c8d3e8", lineHeight: "1.5" }}><b style={{ color: "#fff" }}>VIIRS → MODIS model.</b> A gradient-boosted Poisson model predicts MODIS detections from VIIRS count, FRP, FRP per detection, latitude and season — validated on years it never saw.</div></div>
                <div style={{ display: "flex", gap: "12px" }}><span style={{ width: "26px", height: "26px", flex: "none", borderRadius: "50%", background: "rgba(255,106,26,.15)", color: "#ff8a4a", font: "700 12px 'Space Grotesk'", display: "flex", alignItems: "center", justifyContent: "center" }}>3</span><div style={{ fontSize: "13px", color: "#c8d3e8", lineHeight: "1.5" }}><b style={{ color: "#fff" }}>Local anchoring & QA.</b> A factor k aligns each area with its own MODIS record (2012–2019). Years where MODIS under-detects (e.g. outages) are flagged and excluded.</div></div>
                <div style={{ display: "flex", gap: "12px" }}><span style={{ width: "26px", height: "26px", flex: "none", borderRadius: "50%", background: "rgba(255,106,26,.15)", color: "#ff8a4a", font: "700 12px 'Space Grotesk'", display: "flex", alignItems: "center", justifyContent: "center" }}>4</span><div style={{ fontSize: "13px", color: "#c8d3e8", lineHeight: "1.5" }}><b style={{ color: "#fff" }}>One record.</b> 2000–2011 is MODIS; from 2012 the record follows VIIRS in MODIS-equivalent units — so it continues when Terra and Aqua retire.</div></div>
              </div>
              {v.hasCal && <div className="glass" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}><span style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>Calibration learned for {v.regionName}</span><span style={{ fontSize: "12px", color: "#9fb0cc" }}>{v.calMethod}</span></div>
                <div style={{ fontSize: "12px", color: "#c8d3e8" }}>{v.calInfo}</div>
                <div style={{ fontSize: "12px", color: "#9fb0cc" }}>{v.calQa}</div>
                <div style={{ display: "grid", gridTemplateColumns: "52px 1fr 1fr 64px minmax(0,1.2fr)", gap: "0 10px", fontSize: "12px", color: "#9fb0cc", padding: "6px 0", borderBottom: "1px solid rgba(130,160,210,.12)" }}><span>Year</span><span>MODIS</span><span>VIIRS</span><span>V ÷ M</span><span>Quality</span></div>
                <div style={{ display: "flex", flexDirection: "column", gap: "2px", maxHeight: "300px", overflowY: "auto" }}>
                  {v.calYears.map((r, i2) => <div key={i2} style={{ display: "grid", gridTemplateColumns: "52px 1fr 1fr 64px minmax(0,1.2fr)", gap: "0 10px", alignItems: "center", padding: "5px 0", fontSize: "12px", borderBottom: "1px solid rgba(130,160,210,.06)" }}>
                    <span style={{ fontFamily: "'Space Grotesk'", color: "#fff" }}>{r.year}</span><span style={{ color: "#8fbfff" }}>{r.modis}</span><span style={{ color: "#ffd27a" }}>{r.viirs}</span>
                    <span style={{ position: "relative" }}><span style={{ position: "absolute", left: 0, top: "50%", height: "4px", marginTop: "-2px", width: r.w, background: r.barColor, opacity: ".35", borderRadius: "2px" }}></span><span style={{ position: "relative", fontWeight: "700" }}>{r.ratio}</span></span>
                    <span style={{ color: r.qaColor, fontWeight: "600" }}>{r.qa}</span>
                  </div>)}
                </div>
                <div style={{ fontSize: "12px", color: "#9fb0cc", marginTop: "4px" }}>α by month (VIIRS per MODIS detection)</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(12,minmax(0,1fr))", gap: "4px", alignItems: "end", height: "70px" }}>
                  {v.alphaMonth.map((m, i2) => <div key={i2} title={m.m + ': ' + m.a} style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", height: "100%", gap: "2px" }}><span style={{ fontSize: "10px", color: "#c8d3e8" }}>{m.a}</span><span style={{ width: "100%", height: m.h, minHeight: "2px", borderRadius: "3px 3px 0 0", background: "linear-gradient(180deg,#ffb020,#ff6a1a)" }}></span><span style={{ fontSize: "10px", color: "#7f8ea8" }}>{m.m[0]}</span></div>)}
                </div>
              </div>}
              {v.noCal && <div className="glass" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "10px" }}>
                <span style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>Literature ratio by land cover</span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 70px 1fr", gap: "0", fontSize: "12px", color: "#9fb0cc", padding: "6px 0", borderBottom: "1px solid rgba(130,160,210,.12)" }}><span>Land cover</span><span>α</span><span>VIIRS ÷ α</span></div>
                {v.alphaRows.map((r, i2) => <React.Fragment key={i2}>
                  <button onClick={r.onClick} style={{ display: "grid", gridTemplateColumns: "1fr 70px 1fr", alignItems: "center", textAlign: "left", padding: "10px 8px", borderRadius: "8px", border: `1px solid ${r.bd}`, background: r.bg, color: "#e8eefb", font: "600 13px Manrope", cursor: "pointer" }}><span>{r.name}</span><span style={{ fontFamily: "'Space Grotesk'" }}>{r.alpha}</span><span style={{ color: "#c8d3e8" }}>{r.eq}</span></button>
                </React.Fragment>)}
              </div>}
            </div>

            {v.hasMatch && <div className="glass" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}><span style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>Same fire, two sensors</span><span style={{ fontSize: "12px", color: "#9fb0cc" }}>{v.matchNote}</span></div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(170px,100%),1fr))", gap: "10px" }}>
                {v.matchTiles.map((t, i2) => <div key={i2} style={{ padding: "12px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.12)" }}><div style={{ fontSize: "12px", color: "#9fb0cc" }}>{t.k}</div><div style={{ fontFamily: "'Space Grotesk'", fontSize: "22px", fontWeight: "700", color: t.color }}>{t.v}</div><div style={{ fontSize: "12px", color: "#9fb0cc" }}>{t.d}</div></div>)}
              </div>
              <div style={{ fontSize: "12px", color: "#c8d3e8", lineHeight: "1.5" }}>{v.matchText}</div>
            </div>}

            {v.hasModel && <div className="glass" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}><span style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>Does it work? Model validation</span><span style={{ fontSize: "12px", color: "#9fb0cc" }}>{v.modelNote}</span></div>
              <div data-m="widewrap"><div data-m="wide" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.6fr) repeat(3,minmax(0,1fr))", gap: "10px", fontSize: "12px", color: "#9fb0cc", padding: "6px 0", borderBottom: "1px solid rgba(130,160,210,.12)" }}><span>Method</span><span>R²</span><span>MAE (detections / week)</span><span>Bias</span></div>
              {v.modelRows.map((r, i2) => <div data-m="wide" key={i2} style={{ display: "grid", gridTemplateColumns: "minmax(0,1.6fr) repeat(3,minmax(0,1fr))", gap: "10px", padding: "9px 0", fontSize: "13px", borderBottom: "1px solid rgba(130,160,210,.06)" }}><span style={{ color: r.color, fontWeight: "700" }}>{r.name}</span><span style={{ fontFamily: "'Space Grotesk'" }}>{r.r2}</span><span style={{ fontFamily: "'Space Grotesk'" }}>{r.mae}</span><span style={{ fontFamily: "'Space Grotesk'" }}>{r.bias}</span></div>)}</div>
              {v.modelHere && <div style={{ fontSize: "13px", color: "#ffd2b5" }}>{v.modelHere}</div>}
              <div style={{ fontSize: "12px", color: "#9fb0cc" }}>Most informative inputs: {v.modelFeatures}</div>
            </div>}

            <div className="glass" style={{ padding: "20px" }}>
              <div style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>Harmonized record 2000–2026 <span style={{ color: "#9fb0cc", fontWeight: "400", fontSize: "14px" }}>· monthly, {v.regionName}</span></div>
              <div style={{ position: "relative", height: "260px", margin: "18px 0 28px 40px" }}>
                <div style={{ position: "absolute", top: "0", bottom: "0", left: "44.4%", right: "0", background: "rgba(255,176,32,.04)", borderLeft: "1px dashed rgba(255,255,255,.35)" }}><span style={{ position: "absolute", top: "4px", left: "8px", fontSize: "11px", color: "#ffb27a" }}>MODIS + VIIRS overlap</span></div>
                {v.yTicks.map((t, i2) => <React.Fragment key={i2}>
                  <div style={{ position: "absolute", left: "0", right: "0", top: t.top, borderTop: "1px solid rgba(130,160,210,.1)" }}><span style={{ position: "absolute", left: "-40px", top: "-8px", fontSize: "11px", color: "#7f8ea8" }}>{t.label}</span></div>
                </React.Fragment>)}
                <svg viewBox="0 0 1000 300" preserveAspectRatio="none" style={{ position: "absolute", inset: "0", width: "100%", height: "100%", overflow: "visible" }}>
                  <defs><linearGradient id="fl-area2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ff7a1a" stopOpacity=".4"></stop><stop offset="1" stopColor="#ff7a1a" stopOpacity="0"></stop></linearGradient></defs>
                  <path d={v.trendArea} fill="url(#fl-area2)"></path>
                  <path d={v.modisLine} fill="none" stroke="#3b8cff" strokeWidth="1.4" vectorEffect="non-scaling-stroke"></path>
                  <path d={v.viirsLine} fill="none" stroke="#ffd04a" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke"></path>
                  <path d={v.harmLine} fill="none" stroke="#ff7a1a" strokeWidth="2" vectorEffect="non-scaling-stroke"></path>
                </svg>
                {v.xTicks.map((x, i2) => <React.Fragment key={i2}><span style={{ position: "absolute", bottom: "-22px", left: x.left, transform: "translateX(-50%)", fontSize: "11px", color: "#7f8ea8" }}>{x.label}</span></React.Fragment>)}
              </div>
              <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", fontSize: "12px", color: "#c8d3e8" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "6px" }}><span style={{ width: "14px", height: "3px", background: "#ff7a1a" }}></span>Harmonized</span>
                <span style={{ display: "flex", alignItems: "center", gap: "6px" }}><span style={{ width: "14px", height: "3px", background: "#3b8cff" }}></span>MODIS raw</span>
                <span style={{ display: "flex", alignItems: "center", gap: "6px" }}><span style={{ width: "14px", borderTop: "2px dashed #ffd04a" }}></span>VIIRS raw</span>
              </div>
            </div>
          </div>
        </>}

        {v.isCal && <>
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center", padding: "12px", borderRadius: "14px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.14)" }}>
              <span style={{ fontSize: "12px", color: "#9fb0cc", fontWeight: "700" }}>SOURCE</span>
              <div style={{ display: "flex", gap: "4px" }}>{v.srcTabs.map((s, i2) => <React.Fragment key={i2}><button onClick={s.onClick} style={{ height: "32px", padding: "0 14px", borderRadius: "8px", border: `1px solid ${s.bd}`, background: s.bg, color: s.color, font: "700 12px Manrope", cursor: "pointer" }}>{s.label}</button></React.Fragment>)}</div>
              <span style={{ fontSize: "12px", color: "#9fb0cc", fontWeight: "700", marginLeft: "8px" }}>MEASURE</span>
              <select value={v.calMetric} onChange={v.onMetricSelect} style={{ height: "32px", padding: "0 10px", borderRadius: "8px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(130,160,210,.2)", color: "#e8eefb", font: "600 13px Manrope" }}><option value="count">Fire count</option><option value="frp">Fire intensity (FRP)</option><option value="anomaly">Anomaly vs 2003–2025</option></select>
              <span style={{ fontSize: "12px", color: "#9fb0cc", fontWeight: "700", marginLeft: "8px" }}>RESOLUTION</span>
              <select value={v.calMode} onChange={v.onModeSelect} style={{ height: "32px", padding: "0 10px", borderRadius: "8px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(130,160,210,.2)", color: "#e8eefb", font: "600 13px Manrope" }}><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>
              <span style={{ marginLeft: "auto", fontSize: "12px", color: "#9fb0cc" }}>Weekly is the finest reliable step — shorter bins are biased by satellite orbits (MODIS user guide)</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "flex-start" }}>
              <div className="glass" onMouseLeave={v.clearTip} style={{ flex: "2 1 600px", minWidth: "0", padding: "20px", display: "flex", flexDirection: "column", gap: "3px" }}>
                <div style={{ display: "grid", gridTemplateColumns: "44px repeat(12,minmax(0,1fr))", fontSize: "11px", color: "#9fb0cc", marginBottom: "6px" }}><span></span><span>Jan</span><span>Feb</span><span>Mar</span><span>Apr</span><span>May</span><span>Jun</span><span>Jul</span><span>Aug</span><span>Sep</span><span>Oct</span><span>Nov</span><span>Dec</span></div>
                <div title={v.critText} style={{ display: v.hasCrit ? "flex" : "none", alignItems: "center", marginBottom: "3px" }}><span style={{ width: "44px", flex: "none", fontSize: "9px", color: "#ffb27a", fontWeight: "700" }}>CRIT.</span><div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(52,minmax(0,1fr))", gap: "2px" }}>{v.critBand.map((c, i9) => <span key={i9} style={{ height: "5px", borderRadius: "1px", background: c }}></span>)}</div></div>
                {v.calRowsBig.map((r, i2) => <React.Fragment key={i2}>
                  <div style={{ display: "flex", alignItems: "center", outline: r.outline, outlineOffset: "1px", borderRadius: "2px" }}>
                    <span style={{ width: "44px", flex: "none", fontSize: "11px", color: r.labelColor, fontFamily: "'Space Grotesk'" }}>{r.full}</span>
                    <div style={{ flex: "1", display: "grid", gridTemplateColumns: `repeat(${v.calCols},minmax(0,1fr))`, gap: "2px" }}>
                      {r.cells.map((c, i3) => <React.Fragment key={i3}><div onMouseEnter={c.onEnter} onClick={c.onClick} style={{ cursor: "pointer", height: "15px", borderRadius: "2px", background: c.bg }}></div></React.Fragment>)}
                    </div>
                  </div>
                </React.Fragment>)}
                <div style={{ display: "flex", alignItems: "center", gap: "12px", fontSize: "12px", color: "#9fb0cc", marginTop: "12px", flexWrap: "wrap" }}><span>{v.calLo}</span><div style={{ flex: "1", minWidth: "120px", maxWidth: "320px", height: "6px", borderRadius: "3px", background: v.calLegend }}></div><span>{v.calHi}</span><span style={{ marginLeft: "auto" }}>{v.calMetricNote}</span></div>
              </div>
              <div style={{ flex: "1 1 min(320px,100%)", minWidth: "0", display: "flex", flexDirection: "column", gap: "16px" }}>
                <div className="glass" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>{v.year} season</span><div style={{ display: "flex", gap: "4px" }}><button onClick={v.prevYear} style={{ width: "30px", height: "30px", borderRadius: "8px", border: "1px solid rgba(130,160,210,.22)", background: "rgba(255,255,255,.04)", color: "#fff", cursor: "pointer" }}>‹</button><button onClick={v.nextYear} style={{ width: "30px", height: "30px", borderRadius: "8px", border: "1px solid rgba(130,160,210,.22)", background: "rgba(255,255,255,.04)", color: "#fff", cursor: "pointer" }}>›</button></div></div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "10px" }}>
                    <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.12)" }}><div style={{ fontSize: "12px", color: "#9fb0cc" }}>Peak week</div><div style={{ fontFamily: "'Space Grotesk'", fontSize: "20px", fontWeight: "700" }}>{v.ys.peak}</div><div style={{ fontSize: "12px", color: "#9fb0cc" }}>{v.ys.peakWhen}</div></div>
                    <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.12)" }}><div style={{ fontSize: "12px", color: "#9fb0cc" }}>Season length</div><div style={{ fontFamily: "'Space Grotesk'", fontSize: "20px", fontWeight: "700" }}>{v.ys.len}</div><div style={{ fontSize: "12px", color: "#9fb0cc" }}>weeks ≥ 50% of peak</div></div>
                    <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.12)" }}><div style={{ fontSize: "12px", color: "#9fb0cc" }}>Onset vs. baseline</div><div style={{ fontFamily: "'Space Grotesk'", fontSize: "20px", fontWeight: "700" }}>{v.ys.onset}</div><div style={{ fontSize: "12px", color: "#9fb0cc" }}>vs. 2003–2025 median</div></div>
                    <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.12)" }}><div style={{ fontSize: "12px", color: "#9fb0cc" }}>Annual total</div><div style={{ fontFamily: "'Space Grotesk'", fontSize: "20px", fontWeight: "700" }}>{v.ys.total}</div><div style={{ fontSize: "12px", color: v.ys.totalColor }}>{v.ys.totalD}</div></div>
                  </div>
                </div>
                <div className="glass" data-m="widewrap" style={{ padding: "20px" }}>
                  <div style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600" }}>Weekly profile vs. baseline</div>
                  <svg viewBox="0 0 520 170" preserveAspectRatio="none" style={{ width: "100%", height: "170px", marginTop: "12px", overflow: "visible" }}>
                    <path d={v.ys.band} fill="rgba(159,176,204,.12)"></path>
                    <path d={v.ys.base} fill="none" stroke="#9fb0cc" strokeWidth="1.4" strokeDasharray="4 3" vectorEffect="non-scaling-stroke"></path>
                    <path d={v.ys.line} fill="none" stroke="#ff7a1a" strokeWidth="2.2" vectorEffect="non-scaling-stroke"></path>
                  </svg>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "#7f8ea8", marginTop: "4px" }}><span>Jan</span><span>Apr</span><span>Jul</span><span>Oct</span><span>Dec</span></div>
                  <div style={{ display: "flex", gap: "14px", fontSize: "12px", color: "#c8d3e8", marginTop: "10px", flexWrap: "wrap" }}><span style={{ display: "flex", alignItems: "center", gap: "6px" }}><span style={{ width: "14px", height: "3px", background: "#ff7a1a" }}></span>{v.year}</span><span style={{ display: "flex", alignItems: "center", gap: "6px" }}><span style={{ width: "14px", borderTop: "2px dashed #9fb0cc" }}></span>Baseline mean</span><span style={{ display: "flex", alignItems: "center", gap: "6px" }}><span style={{ width: "14px", height: "8px", background: "rgba(159,176,204,.25)" }}></span>p10–p90, 2003–2025</span></div>
                </div>
              </div>
            </div>
          </div>
        </>}

        {v.isAnom && <>
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div className="glass" style={{ padding: "20px", border: `1px solid ${v.riskColor}`, display: "flex", flexWrap: "wrap", gap: "20px" }}>
              <div style={{ flex: "1 1 260px", minWidth: 0, display: "flex", flexDirection: "column", gap: "10px" }}>
                <div style={{ fontSize: "12px", fontWeight: "700", letterSpacing: ".08em", color: "#ff8a4a" }}>EARLY-WARNING OUTLOOK</div>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}><span style={{ padding: "6px 14px", borderRadius: "999px", background: v.riskTint, border: `1px solid ${v.riskColor}`, color: v.riskColor, font: "800 14px 'Space Grotesk'", letterSpacing: ".04em" }}>{v.outlookRisk}</span><span style={{ fontSize: "13px", color: "#c8d3e8" }}>{v.outlookRange}</span></div>
                {v.noOutlook && <div style={{ fontSize: "13px", color: "#9fb0cc" }}>{v.outlookReason}</div>}
                {v.hasOutlook && <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "10px" }}>
                  <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.12)" }}><div style={{ fontSize: "12px", color: "#9fb0cc" }}>Chance of a week above p90</div><div style={{ fontFamily: "'Space Grotesk'", fontSize: "20px", fontWeight: "700" }}>{v.outlookProb}</div></div>
                  <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.12)" }}><div style={{ fontSize: "12px", color: "#9fb0cc" }}>Season so far</div><div style={{ fontFamily: "'Space Grotesk'", fontSize: "20px", fontWeight: "700" }}>{v.outlookYtd}</div><div style={{ fontSize: "11px", color: "#9fb0cc" }}>of baseline to date</div></div>
                  <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.12)" }}><div style={{ fontSize: "12px", color: "#9fb0cc" }}>Usual burning still ahead</div><div style={{ fontFamily: "'Space Grotesk'", fontSize: "20px", fontWeight: "700" }}>{v.outlookRemain}</div></div>
                </div>}
                {v.hasOutlook && <div style={{ fontSize: "12px", color: "#9fb0cc", lineHeight: "1.5" }}>Analog years — past seasons whose last 12 weeks looked most like this one: <b style={{ color: "#fff" }}>{v.outlookAnalogs}</b>. Their continuation, scaled to this year's level, gives the expected range.</div>}
              </div>
              {v.hasOutlook && <div style={{ flex: "1.4 1 320px", minWidth: 0 }}>
                <svg viewBox="0 0 520 150" preserveAspectRatio="none" style={{ width: "100%", height: "150px", overflow: "visible" }}>
                  <path d={v.oBand} fill="rgba(255,122,26,.16)"></path>
                  <path d={v.oP90} fill="none" stroke="#ff4a3a" strokeWidth="1.2" strokeDasharray="2 3" vectorEffect="non-scaling-stroke"></path>
                  <path d={v.oBase} fill="none" stroke="#9fb0cc" strokeWidth="1.4" strokeDasharray="4 3" vectorEffect="non-scaling-stroke"></path>
                  <path d={v.oExp} fill="none" stroke="#ff7a1a" strokeWidth="2.2" vectorEffect="non-scaling-stroke"></path>
                </svg>
                <div style={{ display: "flex", gap: "14px", fontSize: "12px", color: "#c8d3e8", marginTop: "8px", flexWrap: "wrap" }}><span style={{ display: "flex", alignItems: "center", gap: "6px" }}><span style={{ width: "14px", height: "3px", background: "#ff7a1a" }}></span>Expected</span><span style={{ display: "flex", alignItems: "center", gap: "6px" }}><span style={{ width: "14px", height: "8px", background: "rgba(255,122,26,.3)" }}></span>Analog range</span><span style={{ display: "flex", alignItems: "center", gap: "6px" }}><span style={{ width: "14px", borderTop: "2px dashed #9fb0cc" }}></span>Baseline mean</span><span style={{ display: "flex", alignItems: "center", gap: "6px" }}><span style={{ width: "14px", borderTop: "2px dotted #ff4a3a" }}></span>90th percentile</span></div>
              </div>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(180px,100%),1fr))", gap: "14px" }}>
              {v.sevCards.map((s, i2) => <React.Fragment key={i2}>
                <button onClick={s.onClick} style={{ textAlign: "left", padding: "18px", borderRadius: "16px", background: s.bg, border: `1px solid ${s.bd}`, color: "#e8eefb", cursor: "pointer", fontFamily: "Manrope" }}>
                  <div style={{ fontSize: "12px", fontWeight: "700", letterSpacing: ".06em", color: s.color }}>{s.label}</div>
                  <div style={{ fontFamily: "'Space Grotesk'", fontSize: "36px", fontWeight: "700", marginTop: "4px" }}>{s.n}</div>
                </button>
              </React.Fragment>)}
            </div>
            <div className="glass" data-m="widewrap" style={{ padding: "8px 20px" }}>
              <div data-m="wide" style={{ display: "grid", gridTemplateColumns: "110px 150px minmax(0,1fr) 200px 80px", gap: "16px", padding: "12px 0", fontSize: "12px", color: "#9fb0cc", borderBottom: "1px solid rgba(130,160,210,.12)" }}><span>Severity</span><span>When</span><span>Alert</span><span>Current vs. mean</span><span style={{ textAlign: "right" }}>Pctl.</span></div>
              {v.anomList.map((a, i2) => <React.Fragment key={i2}>
                <div data-m="wide" style={{ display: "grid", gridTemplateColumns: "110px 150px minmax(0,1fr) 200px 80px", gap: "16px", alignItems: "center", padding: "14px 0", borderBottom: "1px solid rgba(130,160,210,.08)", fontSize: "13px" }}>
                  <span style={{ justifySelf: "start", padding: "4px 10px", borderRadius: "999px", background: a.tint, border: `1px solid ${a.color}`, color: a.color, fontSize: "11px", fontWeight: "800", letterSpacing: ".04em" }}>{a.sev}</span>
                  <div><div style={{ fontWeight: "700" }}>{a.when}</div><div style={{ fontSize: "12px", color: "#9fb0cc" }}>{a.date}</div></div>
                  <div style={{ minWidth: "0" }}><div style={{ fontWeight: "700" }}>{a.title}</div><div style={{ fontSize: "12px", color: "#c8d3e8", lineHeight: "1.45", textWrap: "pretty" }}>{a.desc}</div></div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                    <div style={{ height: "8px", borderRadius: "4px", background: "rgba(255,255,255,.05)" }}><div style={{ height: "100%", width: a.curW, borderRadius: "4px", background: a.color }}></div></div>
                    <div style={{ height: "8px", borderRadius: "4px", background: "rgba(255,255,255,.05)" }}><div style={{ height: "100%", width: a.meanW, borderRadius: "4px", background: "#5d6b86" }}></div></div>
                    <div style={{ fontSize: "11px", color: "#9fb0cc" }}>{a.cur} vs {a.mean}</div>
                  </div>
                  <span style={{ textAlign: "right", fontFamily: "'Space Grotesk'", fontWeight: "700", color: a.color }}>{a.pctl}</span>
                </div>
              </React.Fragment>)}
              {v.anomEmpty && <><div style={{ padding: "30px 0", textAlign: "center", color: "#9fb0cc", fontSize: "14px" }}>No alerts match this filter.</div></>}
            </div>
          </div>
        </>}

        {v.isData && <>
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(240px,100%),1fr))", gap: "14px" }}>
              <button onClick={v.dlCal} style={{ textAlign: "left", padding: "18px", borderRadius: "16px", background: "rgba(61,220,132,.06)", border: "1px solid rgba(61,220,132,.35)", color: "#e8eefb", cursor: "pointer", fontFamily: "Manrope" }}><div style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "700" }}>Burning calendar · CSV</div><div style={{ fontSize: "12px", color: "#9fb0cc", marginTop: "4px" }}>year, week, harmonized fires — {v.regionName}</div></button>
              <button onClick={v.dlAnom} style={{ textAlign: "left", padding: "18px", borderRadius: "16px", background: "rgba(61,220,132,.06)", border: "1px solid rgba(61,220,132,.35)", color: "#e8eefb", cursor: "pointer", fontFamily: "Manrope" }}><div style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "700" }}>Anomaly alerts · JSON</div><div style={{ fontSize: "12px", color: "#9fb0cc", marginTop: "4px" }}>Same schema as /calendar/anomalies</div></button>
              <button onClick={v.dlHarm} style={{ textAlign: "left", padding: "18px", borderRadius: "16px", background: "rgba(61,220,132,.06)", border: "1px solid rgba(61,220,132,.35)", color: "#e8eefb", cursor: "pointer", fontFamily: "Manrope" }}><div style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "700" }}>Harmonization result · JSON</div><div style={{ fontSize: "12px", color: "#9fb0cc", marginTop: "4px" }}>Same schema as /harmonize/calculate</div></button>
              <button onClick={v.dlReport} style={{ textAlign: "left", padding: "18px", borderRadius: "16px", background: "rgba(61,220,132,.06)", border: "1px solid rgba(61,220,132,.35)", color: "#e8eefb", cursor: "pointer", fontFamily: "Manrope" }}><div style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "700" }}>Full AOI report · JSON</div><div style={{ fontSize: "12px", color: "#9fb0cc", marginTop: "4px" }}>Calendar, baseline, anomalies, outlook, calibration</div></button>
            </div>
            <div className="glass" data-m="widewrap" style={{ padding: "20px" }}>
              <div style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600", marginBottom: "10px" }}>NASA FIRMS fields</div>
              <div data-m="wide" style={{ display: "grid", gridTemplateColumns: "200px 140px minmax(0,1fr)", gap: "12px", padding: "10px 0", fontSize: "12px", color: "#9fb0cc", borderBottom: "1px solid rgba(130,160,210,.12)" }}><span>Field</span><span>Sensor</span><span>Meaning</span></div>
              {v.fieldRows.map((f, i2) => <React.Fragment key={i2}>
                <div data-m="wide" style={{ display: "grid", gridTemplateColumns: "200px 140px minmax(0,1fr)", gap: "12px", padding: "10px 0", fontSize: "13px", borderBottom: "1px solid rgba(130,160,210,.08)" }}><span style={{ fontFamily: "ui-monospace,Menlo,monospace", color: "#ffd2b5" }}>{f.k}</span><span style={{ color: "#c8d3e8" }}>{f.s}</span><span style={{ color: "#c8d3e8" }}>{f.d}</span></div>
              </React.Fragment>)}
            </div>
            <div className="glass" style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ fontFamily: "'Space Grotesk'", fontSize: "17px", fontWeight: "600", marginBottom: "6px" }}>Backend endpoints</div>
              {v.endpoints.map((e, i2) => <React.Fragment key={i2}>
                <div style={{ display: "flex", gap: "12px", alignItems: "baseline", flexWrap: "wrap", fontSize: "13px" }}><span style={{ padding: "2px 8px", borderRadius: "6px", background: "rgba(59,140,255,.15)", color: "#8fbfff", font: "700 11px ui-monospace,Menlo,monospace" }}>{e.m}</span><span style={{ fontFamily: "ui-monospace,Menlo,monospace", color: "#fff" }}>{e.p}</span><span style={{ color: "#9fb0cc" }}>{e.d}</span></div>
              </React.Fragment>)}
              <div style={{ fontSize: "12px", color: "#7f8ea8", marginTop: "8px" }}>Base URL: {v.apiBase}</div>
            </div>
          </div>
        </>}
        {v.isCases && <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(300px,100%),1fr))", gap: "14px" }}>
            {v.cases.map((c, i2) => <button className="glass" key={i2} onClick={c.onClick} style={{ display: "flex", flexDirection: "column", gap: "6px", textAlign: "left", padding: "18px", color: "#e8eefb", cursor: "pointer", font: "600 14px Manrope" }}>
              <span style={{ color: "#ffb27a", fontFamily: "'Space Grotesk'", fontSize: "22px", fontWeight: "700" }}>{c.year}</span>
              <span style={{ fontFamily: "'Space Grotesk'", fontSize: "17px" }}>{c.title}</span>
              <span style={{ fontWeight: "500", fontSize: "13px", color: "#9fb0cc", lineHeight: "1.45" }}>{c.note}</span>
              <span style={{ marginTop: "auto", fontSize: "13px", color: "#ff9a5a" }}>Open →</span>
            </button>)}
          </div>
        </>}
        {v.isReport && <>
          <div data-report style={{ background: "#fff", color: "#141a26", borderRadius: "14px", padding: "28px", display: "flex", flexDirection: "column", gap: "18px", fontFamily: "Manrope" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", flexWrap: "wrap", borderBottom: "2px solid #ff6a1a", paddingBottom: "12px" }}>
              <div><div style={{ font: "700 24px 'Space Grotesk'" }}>FireLens area report · {v.regionName}</div><div style={{ fontSize: "12px", color: "#5b6477" }}>{v.regionSub} · {v.regionCoord} · generated {v.reportDate}</div></div>
              <div style={{ textAlign: "right", fontSize: "12px", color: "#5b6477" }}>{v.dataNote}<br />Harmonized to MODIS-equivalent detections</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: "10px" }}>
              {v.reportTiles.map((t, i2) => <div key={i2} style={{ border: "1px solid #e1e6ee", borderRadius: "10px", padding: "10px 12px" }}><div style={{ fontSize: "11px", color: "#5b6477", fontWeight: "700" }}>{t.k}</div><div style={{ font: "700 20px 'Space Grotesk'", color: t.color || "#141a26" }}>{t.v}</div><div style={{ fontSize: "11px", color: "#5b6477" }}>{t.d}</div></div>)}
            </div>
            <div>
              <div style={{ font: "700 15px 'Space Grotesk'", marginBottom: "6px" }}>Burning activity calendar, 2000–present (harmonized, weekly)</div>
              <div style={{ display: "grid", gridTemplateColumns: "40px repeat(12,minmax(0,1fr))", fontSize: "10px", color: "#5b6477" }}><span></span>{["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].map(m => <span key={m}>{m}</span>)}</div>
              {v.reportCal.map((r, i2) => <div key={i2} style={{ display: "flex", alignItems: "center" }}><span style={{ width: "40px", flex: "none", fontSize: "9px", color: "#5b6477" }}>{r.label}</span><div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(52,minmax(0,1fr))", gap: "1px" }}>{r.cells.map((c, i3) => <span key={i3} style={{ height: "7px", background: c.bg, WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}></span>)}</div></div>)}
              <div style={{ fontSize: "11px", color: "#5b6477", marginTop: "4px" }}>Low → high (log scale). Grey = no sensor data. Baseline peak: {v.reportPeak}.</div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: "18px" }}>
              <div>
                <div style={{ font: "700 15px 'Space Grotesk'", marginBottom: "6px" }}>Early-warning outlook</div>
                <div style={{ fontSize: "12px", lineHeight: "1.6" }}><b style={{ color: v.riskColor }}>{v.outlookRisk}</b> · {v.outlookRange}<br />{v.reportOutlook}</div>
              </div>
              <div>
                <div style={{ font: "700 15px 'Space Grotesk'", marginBottom: "6px" }}>Live detections — real-fire check</div>
                <div style={{ fontSize: "12px", lineHeight: "1.6" }}>{v.reportCorrob}</div>
              </div>
            </div>
            <div>
              <div style={{ font: "700 15px 'Space Grotesk'", marginBottom: "6px" }}>Alerts this year and last</div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr><th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #cfd6e3", fontSize: "11px", color: "#5b6477", fontWeight: "700" }}>Severity</th><th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #cfd6e3", fontSize: "11px", color: "#5b6477", fontWeight: "700" }}>When</th><th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #cfd6e3", fontSize: "11px", color: "#5b6477", fontWeight: "700" }}>Alert</th><th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #cfd6e3", fontSize: "11px", color: "#5b6477", fontWeight: "700" }}>Detections vs mean</th><th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #cfd6e3", fontSize: "11px", color: "#5b6477", fontWeight: "700" }}>Pctl.</th></tr></thead>
                <tbody>{v.anomList.slice(0, 12).map((a, i2) => <tr key={i2}><td style={{ padding: "6px 8px", borderBottom: "1px solid #e6eaf1", fontSize: "12px", verticalAlign: "top" }}><b style={{ color: a.color }}>{a.sev}</b></td><td style={{ padding: "6px 8px", borderBottom: "1px solid #e6eaf1", fontSize: "12px", verticalAlign: "top" }}>{a.when}<br /><span style={{ color: "#5b6477" }}>{a.date}</span></td><td style={{ padding: "6px 8px", borderBottom: "1px solid #e6eaf1", fontSize: "12px", verticalAlign: "top" }}><b>{a.title}</b><br />{a.desc}</td><td style={{ padding: "6px 8px", borderBottom: "1px solid #e6eaf1", fontSize: "12px", verticalAlign: "top" }}>{a.cur} vs {a.mean}</td><td style={{ padding: "6px 8px", borderBottom: "1px solid #e6eaf1", fontSize: "12px", verticalAlign: "top" }}>{a.pctl}</td></tr>)}</tbody></table>
              {v.anomEmpty && <div style={{ fontSize: "12px", color: "#5b6477", padding: "8px 0" }}>No alerts — activity within the historical range.</div>}
            </div>
            <div>
              <div style={{ font: "700 15px 'Space Grotesk'", marginBottom: "6px" }}>Where to look now <span style={{ fontWeight: "500", fontSize: "12px", color: "#5b6477" }}>· {v.watchWhen}</span></div>
              {v.hasWatch ? <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr><th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #cfd6e3", fontSize: "11px", color: "#5b6477", fontWeight: "700" }}>#</th><th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #cfd6e3", fontSize: "11px", color: "#5b6477", fontWeight: "700" }}>Location</th><th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #cfd6e3", fontSize: "11px", color: "#5b6477", fontWeight: "700" }}>Last 2 weeks</th><th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #cfd6e3", fontSize: "11px", color: "#5b6477", fontWeight: "700" }}>Normal</th><th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #cfd6e3", fontSize: "11px", color: "#5b6477", fontWeight: "700" }}>× normal</th></tr></thead>
                <tbody>{v.watchRows.map((w, i2) => <tr key={i2}><td style={{ padding: "6px 8px", borderBottom: "1px solid #e6eaf1", fontSize: "12px", verticalAlign: "top" }}>{w.n}</td><td style={{ padding: "6px 8px", borderBottom: "1px solid #e6eaf1", fontSize: "12px", verticalAlign: "top" }}>{w.place}</td><td style={{ padding: "6px 8px", borderBottom: "1px solid #e6eaf1", fontSize: "12px", verticalAlign: "top" }}>{w.cur}</td><td style={{ padding: "6px 8px", borderBottom: "1px solid #e6eaf1", fontSize: "12px", verticalAlign: "top" }}>{w.mean}</td><td style={{ padding: "6px 8px", borderBottom: "1px solid #e6eaf1", fontSize: "12px", verticalAlign: "top" }}><b>{w.ratio}</b></td></tr>)}</tbody></table>
                : <div style={{ fontSize: "12px", color: "#5b6477" }}>No cell is burning well above its own normal.</div>}
            </div>
            <div style={{ fontSize: "11px", color: "#5b6477", lineHeight: "1.6", borderTop: "1px solid #e1e6ee", paddingTop: "10px" }}>
              <b>Method.</b> NASA FIRMS MODIS C6.1 (Terra/Aqua, 1 km) and VIIRS S-NPP (375 m) detections, vegetation fires only (type 0), nominal+ confidence, aggregated to 0.25° × week. 2000–2011 MODIS; from 2012 VIIRS converted to MODIS-equivalent detections by a model calibrated on the overlap ({v.calInfo}). Baseline 2003–2025, same week ±1. Outlook: analog seasons ({v.outlookAnalogs}). Real-fire check: CONFIRMED = two satellites within 1.5 km and 12 h.
            </div>
            <div data-noprint style={{ display: "flex", gap: "10px" }}><button onClick={v.printNow} style={{ height: "40px", padding: "0 18px", border: "0", borderRadius: "10px", background: "linear-gradient(90deg,#ff4d1a,#ff8a1f)", color: "#fff", font: "700 14px Manrope", cursor: "pointer" }}>Print / save as PDF</button></div>
          </div>
        </>}
      </main>
      </>}
      {v.tipShow && <>
        <div style={{ position: "fixed", zIndex: "50", left: v.tipLeft, top: v.tipTop, width: "220px", padding: "12px 14px", borderRadius: "12px", background: "rgba(8,12,22,.95)", border: "1px solid rgba(130,160,210,.3)", boxShadow: "0 12px 40px rgba(0,0,0,.5)", fontSize: "12px", lineHeight: "1.7", pointerEvents: "none", color: "#c8d3e8" }}>
          <div style={{ fontFamily: "'Space Grotesk'", fontWeight: "700", fontSize: "14px", color: "#fff" }}>{v.tip.title}</div>
          <div>{v.tip.label}: <b style={{ color: "#fff" }}>{v.tip.fires}</b></div>
          <div>FRP: <b style={{ color: "#fff" }}>{v.tip.frp}</b></div>
          <div>Percentile: <b style={{ color: "#ff8a4a" }}>{v.tip.pct}</b></div>
          <div>Land cover: {v.tip.cover}</div>
          <div>Sources: {v.tip.src}</div>
        </div>
      </>}
      {v.alertOpen && <div role="dialog" aria-modal="true" aria-label="Fire alerts by email" onClick={v.closeAlerts} style={{ position: "fixed", inset: "0", zIndex: "80", background: "rgba(2,4,10,.66)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px", overflowY: "auto" }}>
        <form className="glass" noValidate onClick={ev => ev.stopPropagation()} onSubmit={v.submitAlerts} style={{ width: "100%", maxWidth: "540px", padding: "26px", display: "flex", flexDirection: "column", gap: "16px", background: "rgba(10,14,26,.86)", color: "#e8eefb" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
            <div><div style={{ font: "700 22px 'Space Grotesk'" }}>Fire alerts by email</div>
              <div style={{ fontSize: "13px", color: "#9fb0cc", lineHeight: "1.55", marginTop: "4px" }}>We check NASA FIRMS (MODIS + VIIRS) every hour and email you when a fire you care about is detected.</div></div>
            <button type="button" onClick={v.closeAlerts} aria-label="Close" style={{ flex: "none", width: "34px", height: "34px", borderRadius: "10px", background: "rgba(255,255,255,.05)", border: "1px solid rgba(130,160,210,.22)", color: "#c8d3e8", cursor: "pointer", fontSize: "14px" }}>✕</button>
          </div>
          {v.alertDone ? <div style={{ display: "flex", flexDirection: "column", gap: "14px", padding: "8px 0" }}>
            <div style={{ font: "700 18px 'Space Grotesk'", color: "#3ddc84" }}>Almost done — check your inbox</div>
            <div style={{ fontSize: "14px", color: "#c8d3e8", lineHeight: "1.6" }}>{v.alertMsg} Alerts start only after you confirm, and every email has an unsubscribe link.</div>
            <button type="button" onClick={v.closeAlerts} style={{ alignSelf: "flex-start", height: "40px", padding: "0 18px", border: "0", borderRadius: "10px", background: "linear-gradient(90deg,#ff4d1a,#ff8a1f)", color: "#fff", font: "700 14px Manrope", cursor: "pointer" }}>Done</button>
          </div> : <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: "10px" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}><span style={{ fontSize: "11px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: "#7f8ea8" }}>Email</span><input type="email" autoComplete="email" required value={v.a.email} onChange={v.setA('email')} placeholder="you@example.com" style={{ height: "42px", padding: "0 12px", borderRadius: "10px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(130,160,210,.22)", color: "#e8eefb", font: "500 14px Manrope", outline: "none", width: "100%", boxSizing: "border-box" }} /></label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}><span style={{ fontSize: "11px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: "#7f8ea8" }}>Name <span style={{ textTransform: "none", letterSpacing: "0", fontWeight: "500" }}>(optional)</span></span><input autoComplete="name" value={v.a.name} onChange={v.setA('name')} maxLength={60} style={{ height: "42px", padding: "0 12px", borderRadius: "10px", background: "rgba(255,255,255,.04)", border: "1px solid rgba(130,160,210,.22)", color: "#e8eefb", font: "500 14px Manrope", outline: "none", width: "100%", boxSizing: "border-box" }} /></label>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <span style={{ fontSize: "11px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: "#7f8ea8" }}>Area</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: "10px" }}>
              <button type="button" onClick={v.pickRegion} disabled={!v.aRegionOk} style={{ ...v.aRegionStyle, textAlign: "left", padding: "12px 14px", borderRadius: "12px", color: "#e8eefb", cursor: v.aRegionOk ? "pointer" : "not-allowed" }}><div style={{ fontWeight: "700", fontSize: "14px" }}>Selected area</div><div style={{ fontSize: "12px", color: "#9fb0cc", marginTop: "2px" }}>{v.aRegionLabel}</div></button>
              <div onClick={v.pickLoc} style={{ ...v.aLocStyle, padding: "12px 14px", borderRadius: "12px", cursor: "pointer" }}><div style={{ fontWeight: "700", fontSize: "14px" }}>Around my location</div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "6px", flexWrap: "wrap" }}><button type="button" onClick={ev => { ev.stopPropagation(); v.pickLoc(); }} style={{ height: "28px", padding: "0 10px", borderRadius: "8px", background: "rgba(255,255,255,.05)", border: "1px solid rgba(130,160,210,.25)", color: "#c8d3e8", font: "600 12px Manrope", cursor: "pointer" }}>{v.aLocLabel}</button>
                  <select value={v.a.radius} onClick={ev => ev.stopPropagation()} onChange={v.setA('radius')} aria-label="Radius" style={{ height: "32px", padding: "0 8px", borderRadius: "8px", background: "#0c1222", border: "1px solid rgba(130,160,210,.25)", color: "#ffd2b8", font: "700 13px Manrope" }}>{[10, 25, 50, 100].map(r => <option key={r} value={r}>{r} km</option>)}</select></div></div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <span style={{ fontSize: "11px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: "#7f8ea8" }}>Email me about</span>
            <label style={{ display: "flex", gap: "12px", alignItems: "flex-start", padding: "12px 14px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.18)", cursor: "pointer" }}><input type="checkbox" checked={v.a.strong} onChange={v.setA('strong')} style={{ marginTop: "3px", accentColor: "#ff6a1a" }} /><div style={{ flex: "1" }}><div style={{ fontWeight: "700", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>Strong fire — one fire above <select value={v.a.frp} onChange={v.setA('frp')} aria-label="Fire strength" style={{ height: "32px", padding: "0 8px", borderRadius: "8px", background: "#0c1222", border: "1px solid rgba(130,160,210,.25)", color: "#ffd2b8", font: "700 13px Manrope" }}><option value={20}>20 MW · sizeable</option><option value={50}>50 MW · strong</option><option value={100}>100 MW · very strong</option><option value={500}>500 MW · extreme</option></select></div><div style={{ fontSize: "12px", color: "#9fb0cc", marginTop: "3px" }}>Fire radiative power: the heat a fire gives off. Above 100 MW is a large, intense fire.</div></div></label>
            <label style={{ display: "flex", gap: "12px", alignItems: "flex-start", padding: "12px 14px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.18)", cursor: "pointer" }}><input type="checkbox" checked={v.a.confirmed} onChange={v.setA('confirmed')} style={{ marginTop: "3px", accentColor: "#ff6a1a" }} /><div><div style={{ fontWeight: "700", fontSize: "14px" }}>Confirmed fire — any size</div><div style={{ fontSize: "12px", color: "#9fb0cc", marginTop: "3px" }}>Seen by two different satellites within 1.5 km and 12 h. Best for a small radius around a home, farm or forest.</div></div></label>
            <label style={{ display: "flex", gap: "12px", alignItems: "flex-start", padding: "12px 14px", borderRadius: "12px", background: "rgba(255,255,255,.03)", border: "1px solid rgba(130,160,210,.18)", cursor: "pointer" }}><input type="checkbox" checked={v.a.unusual} onChange={v.setA('unusual')} style={{ marginTop: "3px", accentColor: "#ff6a1a" }} /><div style={{ flex: "1" }}><div style={{ fontWeight: "700", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>Unusual week — burning <select value={v.a.delta} onChange={v.setA('delta')} aria-label="How unusual" style={{ height: "32px", padding: "0 8px", borderRadius: "8px", background: "#0c1222", border: "1px solid rgba(130,160,210,.25)", color: "#ffd2b8", font: "700 13px Manrope" }}><option value={50}>+50%</option><option value={100}>+100%</option><option value={200}>+200%</option></select> above normal</div><div style={{ fontSize: "12px", color: "#9fb0cc", marginTop: "3px" }}>The area’s harmonized fire count this week against its 2003–2025 normal for the same days.</div></div></label>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <span style={{ fontSize: "11px", fontWeight: "700", letterSpacing: ".08em", textTransform: "uppercase", color: "#7f8ea8" }}>How often</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>{v.freqTabs.map(f => <button type="button" key={f.key} onClick={f.onClick} style={{ ...f.style, textAlign: "left", padding: "10px 14px", borderRadius: "12px", color: "#e8eefb", cursor: "pointer" }}><div style={{ fontWeight: "700", fontSize: "14px" }}>{f.label}</div><div style={{ fontSize: "12px", color: "#9fb0cc" }}>{f.desc}</div></button>)}</div>
          </div>
          <label style={{ display: "flex", gap: "10px", alignItems: "flex-start", fontSize: "13px", color: "#c8d3e8", lineHeight: "1.5", cursor: "pointer" }}><input type="checkbox" checked={v.a.consent} onChange={v.setA('consent')} style={{ marginTop: "3px", accentColor: "#ff6a1a" }} />I agree to receive FireLens alert emails. My email is used only for these alerts; I can unsubscribe any time.</label>
          {v.alertMsg && <div role="status" style={{ fontSize: "13px", color: v.alertMsgColor }}>{v.alertMsg}</div>}
          <button type="submit" disabled={v.alertBusy} style={{ height: "46px", border: "0", borderRadius: "12px", background: "linear-gradient(90deg,#ff4d1a,#ff8a1f)", color: "#fff", font: "700 15px Manrope", cursor: v.alertBusy ? "wait" : "pointer", opacity: v.alertBusy ? .7 : 1, boxShadow: "0 6px 24px rgba(255,90,26,.3)" }}>{v.alertBusy ? 'Sending…' : 'Send confirmation email'}</button>
          <div style={{ fontSize: "11px", color: "#5b6477", lineHeight: "1.5" }}>Satellite detections are not an official warning: they can miss fires under cloud and include hot industrial sites. In an emergency, follow your local authorities.</div>
          </>}
        </form>
      </div>}
      </div>
    );
  }
}
