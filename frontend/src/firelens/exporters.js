// Downloadable figures and bundles: self-contained SVG charts (also rasterised to PNG), CSV text and a small ZIP
// writer. Figures are drawn from the data, not screenshotted, so they are sharp, titled and carry their source line.

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FONT = 'font-family="Helvetica, Arial, sans-serif"';
const BG = '#0b1020', INK = '#e8eefb', MUTED = '#9fb0cc', GRID = '#24304a';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const kfmt = v => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(v >= 1e4 ? 0 : 1) + 'K' : String(Math.round(v)));
const nice = x => { const p = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1e-9)))), m = x / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; };
// Axis top and tick step: about four ticks, ending just above the data.
const axis = max => { const step = nice(Math.max(max, 1) / 4); return { step, top: Math.ceil(Math.max(max, 1) * 1.04 / step) * step }; };
const grid = (top, step, L, R, w, Y) => { let b = ''; for (let v = 0; v <= top + 1e-9; v += step) b += `<line x1="${L}" x2="${w - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${GRID}"/><text x="${L - 8}" y="${Y(v) + 4}" font-size="11" fill="${MUTED}" text-anchor="end">${kfmt(v)}</text>`; return b; };

function frame(w, h, title, subtitle, source, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${FONT}>`
    + `<rect width="${w}" height="${h}" fill="${BG}"/>`
    + `<text x="28" y="38" font-size="20" font-weight="700" fill="${INK}">${esc(title)}</text>`
    + `<text x="28" y="60" font-size="13" fill="${MUTED}">${esc(subtitle)}</text>`
    + body
    + `<text x="28" y="${h - 16}" font-size="11" fill="${MUTED}">${esc(source)}</text>`
    + `<text x="${w - 28}" y="38" font-size="12" fill="${MUTED}" text-anchor="end">FireLens · firelens.tech</text></svg>`;
}

function legendBar(x, y, w, stops, lo, hi, ticks) {
  const id = 'g' + Math.random().toString(36).slice(2, 8);
  let s = `<defs><linearGradient id="${id}">${stops.map(([p, c]) => `<stop offset="${p}" stop-color="rgb(${c.join(',')})"/>`).join('')}</linearGradient></defs>`;
  s += `<rect x="${x}" y="${y}" width="${w}" height="10" rx="3" fill="url(#${id})"/>`;
  if (ticks && ticks.length) ticks.forEach((t, i) => { s += `<text x="${x + i / (ticks.length - 1) * w}" y="${y + 26}" font-size="11" fill="${MUTED}" text-anchor="middle">${esc(t)}</text>`; });
  s += `<text x="${x - 8}" y="${y + 9}" font-size="11" fill="${MUTED}" text-anchor="end">${esc(lo)}</text><text x="${x + w + 8}" y="${y + 9}" font-size="11" fill="${MUTED}">${esc(hi)}</text>`;
  return s;
}

// Calendar heatmap: rows = years (newest first), cols = 52 weeks or 12 months; cells are CSS colours or null.
export function svgCalendar({ title, subtitle, rows, cols, stops, lo = 'Low', hi = 'High', ticks, source, crit }) {
  const left = 64, top = 96, cw = cols === 12 ? 58 : 13, ch = cols === 12 ? 20 : 14, gap = 2, totals = rows.some(r => r.total);
  const gw = cols * (cw + gap), w = Math.max(760, left + gw + (totals ? 84 : 40)), h = top + rows.length * (ch + gap) + 110 + (crit ? 12 : 0);
  let b = '';
  MONTHS.forEach((m, i) => { b += `<text x="${left + (i + .5) * gw / 12}" y="${top - 10}" font-size="11" fill="${MUTED}" text-anchor="middle">${m}</text>`; });
  let y0 = top;
  if (crit) {
    b += `<text x="${left - 8}" y="${y0 + 6}" font-size="9" fill="#ffb27a" text-anchor="end">CRIT.</text>`;
    crit.forEach((c, i) => { b += `<rect x="${left + i * gw / 52}" y="${y0}" width="${gw / 52 - 1}" height="6" fill="${c}"/>`; });
    y0 += 12;
  }
  rows.forEach((r, j) => {
    const y = y0 + j * (ch + gap);
    b += `<text x="${left - 8}" y="${y + ch - 3}" font-size="11" fill="${MUTED}" text-anchor="end">${esc(r.year)}</text>`;
    r.cells.forEach((c, i) => {
      const cc = c && typeof c === 'object' ? c : { bg: c };
      b += `<rect x="${left + i * (cw + gap)}" y="${y}" width="${cw}" height="${ch}" rx="2" fill="${cc.bg || '#151c2c'}"/>`;
      if (cc.txt) b += `<text x="${left + i * (cw + gap) + cw / 2}" y="${y + ch - 6}" font-size="10.5" font-weight="600" fill="${cc.fg || INK}" text-anchor="middle">${esc(cc.txt)}</text>`;
    });
    if (r.total) b += `<text x="${left + gw + 66}" y="${y + ch - 6}" font-size="11" font-weight="700" fill="${INK}" text-anchor="end">${esc(r.total)}</text>`;
  });
  if (totals) b += `<text x="${left + gw + 66}" y="${top - 10}" font-size="11" fill="${MUTED}" text-anchor="end">Year</text>`;
  b += legendBar(left + 40, y0 + rows.length * (ch + gap) + 22, Math.min(360, gw - 80), stops, lo, hi, ticks);
  return { svg: frame(w, h, title, subtitle, source, b), w, h };
}

// Bars per year with the median and the interquartile band; one bar highlighted.
export function svgBars({ title, subtitle, labels, values, highlight, median, p25, p75, unit, source }) {
  const w = 980, h = 460, L = 70, R = 30, T = 90, B = 96, pw = w - L - R, ph = h - T - B;
  const { top, step } = axis(Math.max(...values.filter(v => v != null), median || 0, p75 || 0));
  const Y = v => T + ph - v / top * ph, bw = pw / values.length;
  let b = '';
  b += grid(top, step, L, R, w, Y);
  if (p25 != null && p75 != null) b += `<rect x="${L}" y="${Y(p75)}" width="${pw}" height="${Math.max(1, Y(p25) - Y(p75))}" fill="#9fb0cc" opacity=".12"/>`;
  values.forEach((v, i) => {
    if (v == null) return;
    const x = L + i * bw + bw * .15, on = i === highlight;
    b += `<rect x="${x}" y="${Y(v)}" width="${bw * .7}" height="${Math.max(0.5, T + ph - Y(v))}" rx="2" fill="${on ? '#ff7a1a' : '#3b6fb6'}"><title>${esc(labels[i])}: ${Math.round(v).toLocaleString('en-US')} ${esc(unit)}</title></rect>`;
    if (on) b += `<text x="${x + bw * .35}" y="${Y(v) - 6}" font-size="12" font-weight="700" fill="#ffb27a" text-anchor="middle">${kfmt(v)}</text>`;
  });
  labels.forEach((l, i) => { if (values.length <= 14 || i % 5 === 0 || i === values.length - 1) b += `<text x="${L + (i + .5) * bw}" y="${T + ph + 18}" font-size="11" fill="${MUTED}" text-anchor="middle">${esc(l)}</text>`; });
  if (median != null) b += `<line x1="${L}" x2="${w - R}" y1="${Y(median)}" y2="${Y(median)}" stroke="#ffffff" stroke-dasharray="6 4"/><text x="${L + 6}" y="${Y(median) - 6}" font-size="11" fill="${INK}">median ${kfmt(median)}</text>`;
  b += `<text x="${L}" y="${h - 50}" font-size="11" fill="${MUTED}"><tspan fill="#ff7a1a">■</tspan> selected   <tspan fill="#3b6fb6">■</tspan> other years   — — median 2003–2025   <tspan fill="#9fb0cc">▒</tspan> 25th–75th percentile · ${esc(unit)}</text>`;
  return { svg: frame(w, h, title, subtitle, source, b), w, h };
}

// Daily stacked bars per sensor with an optional line (the harmonized estimate).
export function svgDaily({ title, subtitle, days, series, line, source }) {
  const w = 980, h = 440, L = 64, R = 30, T = 90, B = 92, pw = w - L - R, ph = h - T - B, n = Math.max(1, days.length);
  const tot = days.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const { top, step } = axis(Math.max(...tot, ...(line ? line.values : [0])));
  const Y = v => T + ph - v / top * ph, bw = pw / n;
  let b = '';
  b += grid(top, step, L, R, w, Y);
  days.forEach((d, i) => {
    let acc = 0;
    const tip = esc(d + ' · ' + series.map(s => s.name + ' ' + (s.values[i] || 0)).join(' · ') + (line ? ' · ' + line.name + ' ' + (line.values[i] || 0) : ''));
    b += `<rect x="${L + i * bw}" y="${T}" width="${bw}" height="${ph}" fill="transparent"><title>${tip}</title></rect>`;
    series.forEach(s => { const v = s.values[i] || 0; if (!v) return; b += `<rect x="${L + i * bw + bw * .1}" y="${Y(acc + v)}" width="${Math.max(1, bw * .8)}" height="${Y(acc) - Y(acc + v)}" fill="${s.color}" pointer-events="none"/>`; acc += v; });
    const every = Math.ceil(n / 12);
    if (i % every === 0) b += `<text x="${L + (i + .5) * bw}" y="${T + ph + 18}" font-size="11" fill="${MUTED}" text-anchor="middle">${esc(d.slice(5))}</text>`;
  });
  if (line) b += `<path d="${line.values.map((v, i) => (i ? 'L' : 'M') + (L + (i + .5) * bw).toFixed(1) + ' ' + Y(v || 0).toFixed(1)).join('')}" fill="none" stroke="${line.color}" stroke-width="2"/>`;
  let lx = L;
  [...series, ...(line ? [{ ...line, isLine: true }] : [])].forEach(s => { b += `<rect x="${lx}" y="${h - 58}" width="12" height="${s.isLine ? 3 : 10}" fill="${s.color}"/><text x="${lx + 18}" y="${h - 49}" font-size="11" fill="${MUTED}">${esc(s.name)}</text>`; lx += 30 + s.name.length * 6.2; });
  return { svg: frame(w, h, title, subtitle, source, b), w, h };
}

// Monthly series (one value per month since 2000) as lines.
export function svgLines({ title, subtitle, startYear, series, source, mark }) {
  const w = 1080, h = 440, L = 70, R = 30, T = 90, B = 90, pw = w - L - R, ph = h - T - B;
  const n = Math.max(...series.map(s => s.values.length)), { top, step } = axis(Math.max(...series.flatMap(s => s.values.filter(v => v != null))));
  const X = i => L + i / Math.max(1, n - 1) * pw, Y = v => T + ph - v / top * ph;
  let b = '';
  b += grid(top, step, L, R, w, Y);
  for (let y = startYear; y <= startYear + n / 12; y += 5) { const i = (y - startYear) * 12; if (i < n) b += `<text x="${X(i)}" y="${T + ph + 18}" font-size="11" fill="${MUTED}" text-anchor="middle">${y}</text>`; }
  if (mark != null) b += `<line x1="${X(mark)}" x2="${X(mark)}" y1="${T}" y2="${T + ph}" stroke="#ffffff" stroke-dasharray="4 4" opacity=".5"/><text x="${X(mark) + 6}" y="${T + 12}" font-size="11" fill="${MUTED}">VIIRS from 2012</text>`;
  series.forEach(s => {
    let d = '', pen = false;
    s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); pen = true; });
    b += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 1.6}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`;
  });
  let lx = L;
  series.forEach(s => { b += `<rect x="${lx}" y="${h - 56}" width="14" height="3" fill="${s.color}"/><text x="${lx + 20}" y="${h - 51}" font-size="11" fill="${MUTED}">${esc(s.name)}</text>`; lx += 40 + s.name.length * 6.2; });
  return { svg: frame(w, h, title, subtitle, source, b), w, h };
}

export function svgToPng({ svg, w, h }, scale = 2) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = w * scale; c.height = h * scale;
      const x = c.getContext('2d'); x.scale(scale, scale); x.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      c.toBlob(b => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('PNG export failed')); };
    img.src = url;
  });
}

export const canvasToPng = canvas => new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'));

export function saveBlob(name, blob) {
  const u = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 1500);
}

const cell = v => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const toCsv = rows => rows.map(r => r.map(cell).join(',')).join('\n') + '\n';

// Minimal ZIP writer (stored, no compression) — enough for a handful of CSV and PNG files.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export async function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let off = 0;
  const now = new Date(), dtime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const ddate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data instanceof Blob ? new Uint8Array(await f.data.arrayBuffer()) : f.data;
    const name = enc.encode(f.name), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dtime, true); h.setUint16(12, ddate, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dtime, true); c.setUint16(14, ddate, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + data.length;
  }
  const size = central.reduce((a, p) => a + p.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, size, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
