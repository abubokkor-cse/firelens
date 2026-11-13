// Presentational panels: date-range analysis page, month-vs-median card, coordinate entry and the sample-data banner.
// Each takes plain values prepared by FireLens (renderVals), in the same style as the rest of the UI.
import React from 'react';

const card = { padding: '12px', borderRadius: '12px', background: 'rgba(255,255,255,.03)', border: '1px solid rgba(130,160,210,.12)' };
const lab = { fontSize: '11px', fontWeight: '700', letterSpacing: '.08em', textTransform: 'uppercase', color: '#7f8ea8' };
const input = { height: '38px', padding: '0 10px', borderRadius: '10px', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(130,160,210,.25)', color: '#e8eefb', font: '600 14px Manrope', colorScheme: 'dark', minWidth: 0 };
const chip = on => ({ height: '32px', padding: '0 12px', borderRadius: '999px', background: on ? 'rgba(255,106,26,.16)' : 'rgba(255,255,255,.03)', border: '1px solid ' + (on ? '#ff6a1a' : 'rgba(130,160,210,.2)'), color: '#e8eefb', font: '600 12px Manrope', cursor: 'pointer', whiteSpace: 'nowrap' });
const dlBtn = { textAlign: 'left', padding: '14px 16px', borderRadius: '14px', background: 'rgba(61,220,132,.06)', border: '1px solid rgba(61,220,132,.35)', color: '#e8eefb', cursor: 'pointer', fontFamily: 'Manrope' };
const Figure = ({ svg, label }) => <div role="img" aria-label={label} style={{ width: '100%', lineHeight: 0, borderRadius: '12px', overflow: 'hidden' }} dangerouslySetInnerHTML={{ __html: svg.replace('<svg ', '<svg style="width:100%;height:auto;display:block" ') }} />;

export function SampleBanner({ show }) {
  if (!show) return null;
  return <div role="alert" data-noprint style={{ position: 'relative', zIndex: 25, padding: '10px 16px', background: 'rgba(255,165,58,.14)', borderBottom: '1px solid rgba(255,165,58,.45)', color: '#ffd9a8', font: '600 13px Manrope', textAlign: 'center' }}>
    Live NASA FIRMS data could not be loaded — the maps and charts below show an illustrative sample pattern, not real detections. Downloads are disabled until the data loads.
  </div>;
}

export function CoordForm({ co, compact }) {
  if (!co) return null;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
    <button type="button" onClick={co.toggle} aria-expanded={co.open} style={{ alignSelf: 'flex-start', background: 'none', border: 0, padding: 0, color: '#ff9a5a', font: '600 13px Manrope', cursor: 'pointer' }}>{co.open ? '▾' : '▸'} Enter latitude / longitude</button>
    {co.open && <form onSubmit={co.go} style={{ display: 'grid', gridTemplateColumns: compact ? 'repeat(auto-fit,minmax(110px,1fr))' : 'repeat(auto-fit,minmax(96px,1fr))', gap: '8px', alignItems: 'end' }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}><span style={lab}>Latitude</span><input inputMode="decimal" value={co.lat} onChange={co.onLat} placeholder="-29.16" aria-label="Latitude, decimal degrees, south negative" style={input} /></label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}><span style={lab}>Longitude</span><input inputMode="decimal" value={co.lon} onChange={co.onLon} placeholder="-67.50" aria-label="Longitude, decimal degrees, west negative" style={input} /></label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}><span style={lab}>Radius</span><select value={co.r} onChange={co.onR} style={input}>{[10, 25, 50, 100, 250].map(r => <option key={r} value={r}>{r} km</option>)}</select></label>
      <button type="submit" style={{ height: '38px', border: 0, borderRadius: '10px', background: 'linear-gradient(90deg,#ff4d1a,#ff8a1f)', color: '#fff', font: '700 14px Manrope', cursor: 'pointer' }}>Go</button>
      <div style={{ gridColumn: '1/-1', fontSize: '12px', color: co.err ? '#ffa53a' : '#7f8ea8' }}>{co.err || 'Decimal degrees (south and west negative). You can also type “-29.16, -67.5” or a box “W, S, E, N” in the search.'}</div>
    </form>}
  </div>;
}

export function MonthStatsCard({ ms }) {
  if (!ms || !ms.has) return null;
  const Tile = ({ t }) => !t ? null : <div style={card}><div style={{ fontSize: '12px', color: '#9fb0cc' }}>{t.k}</div><div style={{ fontFamily: "'Space Grotesk'", fontSize: '20px', fontWeight: '700', color: t.color || '#fff' }}>{t.v}</div><div style={{ fontSize: '12px', color: '#9fb0cc' }}>{t.d}</div></div>;
  return <div className="glass" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
      <span style={{ fontFamily: "'Space Grotesk'", fontSize: '17px', fontWeight: '600' }}>Compared with the median</span>
      <span style={{ fontSize: '12px', color: '#9fb0cc' }}>{ms.note}</span>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: '10px' }}><Tile t={ms.cur} /><Tile t={ms.last} /><Tile t={ms.ytd} /></div>
    <div>
      <div style={{ fontSize: '12px', color: '#9fb0cc', marginBottom: '6px' }}>Typical year — median harmonized hotspots per month, 2003–2025</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12,minmax(0,1fr))', gap: '4px', alignItems: 'end', height: '74px' }}>
        {ms.clim.map((c, i) => <div key={i} title={c.title} style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}><div style={{ height: c.h, minHeight: '2px', borderRadius: '3px 3px 0 0', background: c.top ? '#ff7a1a' : '#3b6fb6' }}></div></div>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12,minmax(0,1fr))', gap: '4px', fontSize: '10px', color: '#7f8ea8', marginTop: '3px', textAlign: 'center' }}>{ms.clim.map((c, i) => <span key={i}>{c.m}</span>)}</div>
      <div style={{ fontSize: '12px', color: '#c8d3e8', marginTop: '6px' }}>{ms.busiest}</div>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: '12px' }}>
      <div><div style={{ fontSize: '12px', color: '#9fb0cc', marginBottom: '4px' }}>Most burning — years</div>
        {ms.topYears.map((y, i) => <button key={i} onClick={y.onClick} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: '8px', padding: '5px 0', background: 'none', border: 0, borderBottom: '1px solid rgba(130,160,210,.08)', color: '#e8eefb', font: '600 13px Manrope', cursor: 'pointer' }}><span>{i + 1}. {y.label}</span><span style={{ color: '#ffb27a' }}>{y.v}</span></button>)}</div>
      <div><div style={{ fontSize: '12px', color: '#9fb0cc', marginBottom: '4px' }}>Most burning — single months</div>
        {ms.topMonths.map((y, i) => <button key={i} onClick={y.onClick} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: '8px', padding: '5px 0', background: 'none', border: 0, borderBottom: '1px solid rgba(130,160,210,.08)', color: '#e8eefb', font: '600 13px Manrope', cursor: 'pointer' }}><span>{i + 1}. {y.label}</span><span style={{ color: '#ffb27a' }}>{y.v}</span></button>)}</div>
    </div>
  </div>;
}

export function RangePage({ rg }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
    <div className="glass" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}><span style={lab}>From</span><input type="date" value={rg.from} min={rg.minDate} max={rg.maxDate} onChange={rg.onFrom} style={input} /></label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}><span style={lab}>To</span><input type="date" value={rg.to} min={rg.minDate} max={rg.maxDate} onChange={rg.onTo} style={input} /></label>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>{rg.presets.map((p, i) => <button key={i} onClick={p.onClick} style={chip(p.on)}>{p.label}</button>)}</div>
      </div>
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ fontSize: '13px', color: '#c8d3e8', maxWidth: '760px', lineHeight: '1.5' }}><b style={{ color: '#fff' }}>{rg.regionName}</b> · {rg.span}. {rg.help}</div>
        <div style={{ flex: '0 1 420px' }}><CoordForm co={rg.co} compact /></div>
      </div>
      {rg.msg && <div role="status" style={{ fontSize: '13px', color: rg.msgColor }}>{rg.msg}</div>}
      {rg.warn && <div role="alert" style={{ padding: '10px 12px', borderRadius: '10px', background: 'rgba(255,165,58,.12)', border: '1px solid rgba(255,165,58,.45)', color: '#ffd9a8', fontSize: '13px', lineHeight: '1.5' }}>{rg.warn}</div>}
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(170px,100%),1fr))', gap: '12px' }}>
      {rg.tiles.map((t, i) => <div key={i} className="glass" style={{ padding: '16px' }}><div style={{ fontSize: '12px', color: '#9fb0cc' }}>{t.k}</div><div style={{ fontFamily: "'Space Grotesk'", fontSize: '26px', fontWeight: '700', color: t.color || '#fff', marginTop: '2px' }}>{t.v}</div><div style={{ fontSize: '12px', color: '#9fb0cc', marginTop: '2px' }}>{t.d}</div></div>)}
    </div>
    {rg.plain && <p style={{ margin: 0, fontSize: '15px', color: '#c8d3e8', lineHeight: '1.6', maxWidth: '980px' }}>{rg.plain}</p>}

    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'flex-start' }}>
      <div className="glass" style={{ flex: '1.3 1 min(560px,100%)', minWidth: 0, padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ fontFamily: "'Space Grotesk'", fontSize: '17px', fontWeight: '600' }}>The same dates in every year</div>
        {rg.sdSvg ? <Figure svg={rg.sdSvg.svg} label="Harmonized hotspots over the selected dates in each year since 2000, with the 2003–2025 median" /> : <div style={{ padding: '30px 0', textAlign: 'center', color: '#9fb0cc', fontSize: '14px' }}>{rg.sdEmpty}</div>}
      </div>
      <div className="glass" style={{ flex: '1 1 min(420px,100%)', minWidth: 0, padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}><span style={{ fontFamily: "'Space Grotesk'", fontSize: '17px', fontWeight: '600' }}>Hotspots detected in the range</span><span style={{ fontSize: '12px', color: '#9fb0cc' }}>{rg.mapNote}</span></div>
        <div style={{ position: 'relative', width: '100%', aspectRatio: '4 / 3', borderRadius: '12px', overflow: 'hidden', background: '#050a14' }}>
          <canvas ref={rg.mapRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}></canvas>
          {!rg.hasPoints && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', textAlign: 'center', color: '#9fb0cc', fontSize: '13px' }}>{rg.mapEmpty}</div>}
        </div>
        <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', fontSize: '12px', color: '#c8d3e8' }}>{rg.sensorKey.map((s, i) => <span key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><span style={{ width: '10px', height: '10px', borderRadius: '50%', background: s.color }}></span>{s.name}</span>)}<span style={{ color: '#9fb0cc' }}>size = FRP</span></div>
      </div>
    </div>

    <div className="glass" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}><span style={{ fontFamily: "'Space Grotesk'", fontSize: '17px', fontWeight: '600' }}>Day by day</span><span style={{ fontSize: '12px', color: '#9fb0cc', maxWidth: '640px' }}>{rg.dailyNote}</span></div>
      {rg.dailySvg ? <Figure svg={rg.dailySvg.svg} label="Daily hotspot detections by sensor, with the harmonized estimate" /> : <div style={{ padding: '30px 0', textAlign: 'center', color: '#9fb0cc', fontSize: '14px' }}>{rg.dailyEmpty}</div>}
    </div>

    <div className="glass" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ fontFamily: "'Space Grotesk'", fontSize: '17px', fontWeight: '600' }}>Download</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(220px,100%),1fr))', gap: '10px' }}>
        {rg.downloads.map((d, i) => <button key={i} onClick={d.onClick} disabled={d.disabled} style={{ ...dlBtn, opacity: d.disabled ? .45 : 1, cursor: d.disabled ? 'not-allowed' : 'pointer', ...(d.primary ? { background: 'rgba(255,106,26,.1)', border: '1px solid rgba(255,106,26,.55)' } : {}) }}><div style={{ fontFamily: "'Space Grotesk'", fontSize: '15px', fontWeight: '700' }}>{d.title}</div><div style={{ fontSize: '12px', color: '#9fb0cc', marginTop: '3px' }}>{d.sub}</div></button>)}
      </div>
      {rg.dlMsg && <div role="status" style={{ fontSize: '13px', color: '#9fb0cc' }}>{rg.dlMsg}</div>}
      <div style={{ fontSize: '12px', color: '#7f8ea8', lineHeight: '1.55' }}>{rg.method}</div>
    </div>
  </div>;
}
