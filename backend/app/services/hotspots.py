"""
Individual MODIS and VIIRS hotspots for an area of interest and a date range, straight from NASA FIRMS.

The burning calendar is built from the aggregated archive (0.25° × week). This module answers the other question a
responder asks — "which fires, exactly, were detected here between these dates?" — with every detection as a row:

  • each day is read from the FIRMS standard (science-quality, SP) product while it exists and from the
    near-real-time (NRT) product after that, using FIRMS' own data-availability table;
  • the archive's cleaning rules are applied as a flag (`used_in_record`), not as a filter, so the CSV keeps every
    detection FIRMS reported;
  • `harmonized_weight` is what the detection adds to the harmonized, MODIS-equivalent record: 1 for a MODIS
    detection before 2012, the area's VIIRS → MODIS conversion for an S-NPP detection from 2012, NOAA-20 only on days
    without S-NPP data, and 0 otherwise. Summing it per day gives a sensor-independent daily count.

A peak-season search over a large country can hold millions of detections, so a search is bounded: text columns are
stored as categories, requests run in date order and stop once MAX_ROWS is reached, and the result then ends at the
last complete day (`complete_through`) and says so. The cache is limited by rows, not by entries.
"""
import datetime as dt
import hashlib
import io
import json
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import numpy as np
import pandas as pd

from app.core.config import settings
from app.models.schemas import BoundingBox
from pandas.api.types import union_categoricals

from app.services import archive_store as store
from app.services.fire_record import _shift

AREA_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{source}/{area}/{days}/{date}"
AVAIL_URL = "https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/{key}/ALL"
UA = {"User-Agent": "FireLens/1.0 (NASA Space Apps Challenge 2026)"}
FIRST_DAY = dt.date(2000, 11, 1)
MAX_DAYS = 62          # one search: up to ~2 months (FIRMS serves 5 days per request)
MAX_ROWS = 300_000     # detections per search; a larger search stops at the last complete day below this
HISTORY_MAX_DAYS = 7   # real same-dates history in every year: one week at most (longer ranges use the record)
CACHE_ROWS = 900_000   # rows kept across all cached searches
SPAN = 5
VIIRS_START = 2012

# sensor → (standard product, near-real-time product)
SENSORS = {
    "MODIS": ("MODIS_SP", "MODIS_NRT"),
    "VIIRS_SNPP": ("VIIRS_SNPP_SP", "VIIRS_SNPP_NRT"),
    "VIIRS_NOAA20": ("VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT"),
    "VIIRS_NOAA21": ("VIIRS_NOAA21_SP", "VIIRS_NOAA21_NRT"),
}
DEFAULT_SENSORS = ("MODIS", "VIIRS_SNPP", "VIIRS_NOAA20")
COLUMNS = ["sensor", "satellite", "instrument", "latitude", "longitude", "acq_date", "acq_time", "daynight",
           "confidence", "frp", "brightness", "bright_t31", "scan", "track", "version", "type", "product",
           "used_in_record", "harmonized_weight"]

CATEGORIES = ("sensor", "satellite", "instrument", "acq_date", "acq_time", "daynight", "confidence", "version", "product")

_avail: dict = {}
_cache: dict = {}
_lock = threading.Lock()
_gate = threading.BoundedSemaphore(2)  # searches fetching and processing at once, per instance


class SearchError(ValueError):
    pass


def _get(url: str) -> bytes:
    last = ""
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                raw = r.read()
            if raw.startswith(b"latitude") or raw.startswith(b"data_id"):
                return raw
            if not raw.strip():
                return b""
            last = raw[:160].decode("utf-8", "replace").strip()
            if "Invalid" in last:  # a request error, not a transient one
                break
        except Exception as e:  # network hiccup: retry
            last = str(e)
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"NASA FIRMS: {last or 'no response'}")


def availability() -> dict:
    """{product: (first day, last day)} from FIRMS' data-availability table, refreshed every 6 hours."""
    if _avail.get("at", 0) > time.time() - 6 * 3600:
        return _avail["table"]
    raw = _get(AVAIL_URL.format(key=settings.FIRMS_API_KEY))
    t = pd.read_csv(io.BytesIO(raw))
    table = {r.data_id: (dt.date.fromisoformat(r.min_date), dt.date.fromisoformat(r.max_date)) for r in t.itertuples()}
    _avail.update(at=time.time(), table=table)
    return table


def plan(sensor: str, start: dt.date, end: dt.date, avail: dict) -> list:
    """[(product, first day, days)] covering start..end for one sensor: the standard product while it lasts, then
    near-real-time; consecutive days of one product are grouped into requests of at most 5 days."""
    sp, nrt = SENSORS[sensor]
    jobs, day = [], start
    while day <= end:
        if sp in avail and avail[sp][0] <= day <= avail[sp][1]:
            prod, last = sp, avail[sp][1]
        elif nrt in avail and avail[nrt][0] <= day <= avail[nrt][1]:
            prod, last = nrt, avail[nrt][1]
        else:  # no product has this day (before the sensor launched, or not processed yet)
            day += dt.timedelta(days=1)
            continue
        span = min(SPAN, (min(end, last) - day).days + 1)
        jobs.append((prod, day, span))
        day += dt.timedelta(days=span)
    return jobs


def _areas(bbox: BoundingBox) -> list:
    """FIRMS area strings for a bbox, split at the antimeridian (FIRMS wants west < east)."""
    f = lambda a, b, c, d: f"{a:.4f},{b:.4f},{c:.4f},{d:.4f}"
    if bbox.west <= bbox.east:
        return [f(bbox.west, bbox.south, bbox.east, bbox.north)]
    return [f(bbox.west, bbox.south, 180, bbox.north), f(-180, bbox.south, bbox.east, bbox.north)]


def _used(df: pd.DataFrame) -> np.ndarray:
    """The archive's cleaning rules (archive_store.clean_firms): vegetation fires only where a type is reported,
    MODIS confidence ≥ 30 %, VIIRS nominal or high."""
    t = pd.to_numeric(df["type"], errors="coerce").astype("float64")
    veg = (t.isna() | (t == 0)).to_numpy()
    conf = df["confidence"].astype(str).str.lower()
    modis = (df["sensor"] == "MODIS").to_numpy()
    ok = np.where(modis, pd.to_numeric(conf, errors="coerce").fillna(0).to_numpy() >= 30, (conf != "l").to_numpy())
    return veg & ok


def _cell_codes(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    return (np.floor(lat / store.CELL).astype(np.int64) + 400) * 2000 + np.floor(lon / store.CELL).astype(np.int64) + 800


def _normalise(sensor: str, product: str, raw: bytes, start: dt.date, end: dt.date, geometry: Optional[dict],
               keep: Optional[np.ndarray]) -> Optional[pd.DataFrame]:
    """One FIRMS answer as compact rows, already limited to the dates and the area."""
    if raw.count(b"\n") < 1:
        return None
    df = pd.read_csv(io.BytesIO(raw), low_memory=False, dtype={"acq_date": str, "acq_time": str, "confidence": str, "version": str})
    del raw
    df = df[(df["acq_date"] >= start.isoformat()) & (df["acq_date"] <= end.isoformat())]
    if len(df):
        lat, lon = df["latitude"].to_numpy(float), df["longitude"].to_numpy(float)
        if keep is not None:
            df = df[np.isin(_cell_codes(lat, lon), keep)]
        elif geometry:
            df = df[store.in_geometry(lon, lat, geometry)]
    if df.empty:
        return None
    viirs = "bright_ti4" in df.columns
    num = lambda c: pd.to_numeric(df[c], errors="coerce").astype("float64") if c in df.columns else pd.Series(np.nan, index=df.index)
    out = pd.DataFrame({
        "sensor": sensor, "satellite": df["satellite"].astype(str), "instrument": df["instrument"].astype(str),
        "latitude": num("latitude"), "longitude": num("longitude"), "acq_date": df["acq_date"],
        "acq_time": df["acq_time"].str.zfill(4), "daynight": df["daynight"].astype(str),
        "confidence": df["confidence"].str.strip(), "frp": num("frp"),
        "brightness": num("bright_ti4" if viirs else "brightness"), "bright_t31": num("bright_ti5" if viirs else "bright_t31"),
        "scan": num("scan"), "track": num("track"), "version": df["version"],
        "type": num("type").astype("Int8"), "product": "standard" if product.endswith("_SP") else "near-real-time",
    })
    out["used_in_record"] = _used(out)
    return out.astype({c: "category" for c in CATEGORIES}).reset_index(drop=True)


def _concat(frames: list) -> pd.DataFrame:
    """Stack frames, keeping text columns as categories (a plain concat would expand them back to strings)."""
    cols = {}
    for c in frames[0].columns:
        parts = [f[c] for f in frames]
        cols[c] = pd.Series(union_categoricals(parts)) if c in CATEGORIES else pd.concat(parts, ignore_index=True)
    return pd.DataFrame(cols)


def weights(df: pd.DataFrame, conv: dict) -> np.ndarray:
    """Each detection's contribution to the harmonized (MODIS-equivalent) record; see the module docstring."""
    date = df["acq_date"].astype(str)
    year = date.str.slice(0, 4).astype(int).to_numpy()
    used, sen = df["used_in_record"].to_numpy(dtype=bool), df["sensor"].astype(str).to_numpy()
    w = np.zeros(len(df))
    w[(sen == "MODIS") & (year < VIIRS_START) & used] = 1.0
    w[(sen == "VIIRS_SNPP") & (year >= VIIRS_START) & used] = conv["snpp"]
    # NOAA-20 stands in for S-NPP on days S-NPP has no data at all for the area (outage, or after S-NPP retires).
    snpp_days = set(date[sen == "VIIRS_SNPP"])
    j = (sen == "VIIRS_NOAA20") & (year >= VIIRS_START) & used & ~date.isin(snpp_days).to_numpy()
    w[j] = conv["noaa20"]
    return w


def conversion(rec) -> dict:
    """VIIRS → MODIS-equivalent conversion for the area, from its harmonized record (or the literature ratio)."""
    if rec is None:
        a = 4.2
        return {"snpp": round(1 / a, 4), "noaa20": round(1.02 / a, 4),
                "method": "Global literature ratio (VIIRS ÷ 4.2): no archive record for this area"}
    snpp = float(rec.hat_per_v * rec.k)
    return {"snpp": round(snpp, 4), "noaa20": round(snpp * float(rec.rho_j), 4),
            "method": f"This area's calibration: one S-NPP detection = {snpp:.3f} MODIS-equivalent "
                      f"(model average × local factor k = {rec.k:.2f}); NOAA-20 × {rec.rho_j:.2f} (S-NPP ÷ NOAA-20)"}


def _empty() -> pd.DataFrame:
    df = pd.DataFrame({c: pd.Series(dtype="object") for c in COLUMNS})
    return df.astype({"used_in_record": bool, "harmonized_weight": float})


def whole_days(day_counts: pd.Series, limit: int) -> Optional[str]:
    """The last day (sorted index of date → rows) that fits in `limit` rows, always at least the first day."""
    fits = day_counts.cumsum() <= limit
    return day_counts.index[fits][-1] if fits.any() else (day_counts.index[0] if len(day_counts) else None)


def _fetch(bbox, start, end, sensors, geometry, keep) -> tuple:
    """(frames, requests, products, stopped early) in date order, stopping once MAX_ROWS detections are in."""
    avail = availability()
    frames, rows, requests, products = [], 0, 0, set()
    day = start
    while day <= end:
        last = min(end, day + dt.timedelta(days=SPAN - 1))
        jobs = [(s, p, d, n, a) for s in sensors for p, d, n in plan(s, day, last, avail) for a in _areas(bbox)]

        def run(job):
            s, p, d, n, a = job
            raw = _get(AREA_URL.format(key=settings.FIRMS_API_KEY, source=p, area=a, days=n, date=d.isoformat()))
            return _normalise(s, p, raw, start, end, geometry, keep)

        with ThreadPoolExecutor(max_workers=6) as pool:
            got = [f for f in pool.map(run, jobs) if f is not None]
        frames += got
        rows += sum(len(f) for f in got)
        requests += len(jobs)
        products |= {(s, p) for s, p, _, _, _ in jobs}
        if rows > MAX_ROWS and last < end:
            return frames, requests, products, True
        day = last + dt.timedelta(days=1)
    return frames, requests, products, False


def search(bbox: BoundingBox, start: dt.date, end: dt.date, sensors=DEFAULT_SENSORS, geometry: Optional[dict] = None,
           keep_cells: Optional[set] = None, rec=None) -> dict:
    """All detections in the AOI between start and end (inclusive, UTC dates), up to MAX_ROWS: a larger search ends at
    its last complete day (`complete_through`). Cached for 30 minutes (24 hours for standard products only)."""
    if not settings.FIRMS_API_KEY:
        raise SearchError("No NASA FIRMS key is configured on the server.")
    today = dt.datetime.now(dt.timezone.utc).date()
    if start > end:
        raise SearchError("The start date is after the end date.")
    if end > today:
        raise SearchError(f"The end date is in the future (today is {today.isoformat()} UTC).")
    if start < FIRST_DAY:
        raise SearchError("Satellite fire records start on 2000-11-01.")
    if (end - start).days + 1 > MAX_DAYS:
        raise SearchError(f"Pick at most {MAX_DAYS} days per search (the calendar covers longer periods).")
    sensors = tuple(s for s in sensors if s in SENSORS) or DEFAULT_SENSORS
    conv = conversion(rec)
    key = (tuple(_areas(bbox)), start, end, sensors,
           hashlib.md5(json.dumps(geometry, sort_keys=True).encode()).hexdigest() if geometry else None,
           None if keep_cells is None else hash(frozenset(keep_cells)), conv["snpp"])

    def cached():
        with _lock:
            hit = _cache.get(key)
        return hit if hit and time.time() - hit["fetched"] < hit["ttl"] else None

    hit = cached()
    if hit:
        return hit
    keep = None
    if keep_cells is not None:
        k = np.array(sorted(keep_cells), dtype=np.int64).reshape(-1, 2)
        keep = (k[:, 0] + 400) * 2000 + k[:, 1] + 800
    with _gate:
        hit = cached()  # the same search may have finished while this one waited
        if hit:
            return hit
        return _build(key, bbox, start, end, sensors, geometry, keep, conv)


def _build(key, bbox, start, end, sensors, geometry, keep, conv) -> dict:
    frames, requests, products, stopped = _fetch(bbox, start, end, sensors, geometry, keep)
    complete = end
    if frames:
        df = _concat(frames)
        del frames
        date, tm = df["acq_date"].astype(str).to_numpy(), df["acq_time"].astype(str).to_numpy()
        df = df.iloc[np.lexsort((df["sensor"].astype(str).to_numpy(), tm, date))].reset_index(drop=True)
        del date, tm
        if stopped or len(df) > MAX_ROWS:
            last = whole_days(df["acq_date"].astype(str).value_counts().sort_index(), MAX_ROWS)
            df = df[df["acq_date"].astype(str) <= last].reset_index(drop=True)
            complete = dt.date.fromisoformat(last)
            stopped = True
        df["harmonized_weight"] = np.round(weights(df, conv), 4)
        df = df[COLUMNS]
        df["acq_date"] = df["acq_date"].cat.remove_unused_categories()
    else:
        df = _empty()

    sp_only = all(p.endswith("_SP") for _, p in products)
    out = {"rows": df, "start": start, "end": end, "complete_through": complete, "sensors": list(sensors), "conversion": conv,
           "truncated": bool(stopped), "requests": requests, "fetched": time.time(), "ttl": 86400 if sp_only else 1800,
           "products": sorted(products)}
    with _lock:
        _cache[key] = out
        while len(_cache) > 1 and (len(_cache) > 60 or sum(len(v["rows"]) for v in _cache.values()) > CACHE_ROWS):
            _cache.pop(next(iter(_cache)))
    return out


def daily(res: dict) -> list:
    """Per-day counts by sensor, detections used by the record, harmonized estimate and FRP."""
    df = res["rows"]
    days = pd.date_range(res["start"], res["complete_through"], freq="D").strftime("%Y-%m-%d")
    names = [s.lower() for s in res["sensors"]]
    if len(df):
        d = df["acq_date"].astype(str)
        by = pd.crosstab(d, df["sensor"].astype(str)).reindex(index=days, columns=res["sensors"], fill_value=0)
        agg = pd.DataFrame({"d": d, "used": df["used_in_record"].astype(int), "h": df["harmonized_weight"],
                            "f": pd.to_numeric(df["frp"], errors="coerce")}).groupby("d").sum().reindex(days, fill_value=0)
    out = []
    for i, day in enumerate(days):
        row = {"date": day, **{n: 0 for n in names}, "used": 0, "harmonized": 0.0, "frp_mw": 0.0}
        if len(df):
            row.update({n: int(by.iat[i, j]) for j, n in enumerate(names)})
            row.update(used=int(agg["used"].iat[i]), harmonized=round(float(agg["h"].iat[i]), 1), frp_mw=round(float(agg["f"].iat[i]), 1))
        out.append(row)
    return out


def summary(res: dict, max_points: int = 4000) -> dict:
    """The JSON answer: totals, the daily table and the strongest detections for a map."""
    df = res["rows"]
    frp = pd.to_numeric(df["frp"], errors="coerce").fillna(0) if len(df) else pd.Series(dtype=float)
    top = df.assign(frp_n=frp).nlargest(max_points, "frp_n") if len(df) else df
    sen = df["sensor"].astype(str) if len(df) else pd.Series(dtype=str)
    return {
        "start": res["start"].isoformat(), "end": res["end"].isoformat(), "days": (res["end"] - res["start"]).days + 1,
        "complete_through": res["complete_through"].isoformat(), "truncated": res["truncated"], "max_rows": MAX_ROWS,
        "sensors": res["sensors"], "detections": int(len(df)),
        "by_sensor": {s: int((sen == s).sum()) for s in res["sensors"]},
        "used_in_record": int(df["used_in_record"].sum()) if len(df) else 0,
        "harmonized": round(float(df["harmonized_weight"].sum()), 1) if len(df) else 0.0,
        "frp_mw": round(float(frp.sum()), 1), "max_frp_mw": round(float(frp.max()), 1) if len(df) else 0.0,
        "conversion": res["conversion"],
        "products": [{"sensor": s, "product": p} for s, p in res["products"]],
        "daily": daily(res),
        "points": [[round(float(r.latitude), 4), round(float(r.longitude), 4), str(r.acq_date), str(r.sensor),
                    round(float(r.frp_n), 1), str(r.confidence)] for r in top.itertuples()],
        "points_shown": int(len(top)),
    }


def history(bbox: BoundingBox, start: dt.date, end: dt.date, geometry: Optional[dict] = None,
            keep_cells: Optional[set] = None, rec=None) -> dict:
    """The same calendar days in every year from real detections, for ranges too short for the weekly record: the
    sensor that carries the harmonized record that year (MODIS to 2011, VIIRS from 2012) converted to MODIS-equivalent
    exactly as in the hotspot search. A year without full sensor coverage of the dates is left empty."""
    days = (end - start).days + 1
    if days < 1 or days > HISTORY_MAX_DAYS:
        raise SearchError(f"Same-day history covers up to {HISTORY_MAX_DAYS} days.")
    today = dt.datetime.now(dt.timezone.utc).date()
    avail = availability()

    def one(y: int) -> dict:
        k = y - end.year
        a, b = _shift(start, k), _shift(end, k)
        row = {"year": y, "harmonized": None, "detections": None}
        sensors = ("MODIS",) if y < VIIRS_START else ("VIIRS_SNPP",)
        backup = y >= 2018  # NOAA-20 exists: it fills days S-NPP has nothing for, exactly as in the hotspot search
        have = {d + dt.timedelta(days=i) for s in sensors + (("VIIRS_NOAA20",) if backup else ())
                for _, d, n in plan(s, a, b, avail) for i in range(n)}
        if a < FIRST_DAY or b > today or len(have) < (b - a).days + 1:
            return row
        try:
            res = search(bbox, a, b, sensors, geometry, keep_cells, rec)
            seen = set(res["rows"]["acq_date"].astype(str)) if len(res["rows"]) else set()
            if backup and len(seen) < (b - a).days + 1:  # only then is the second satellite needed
                res = search(bbox, a, b, ("VIIRS_SNPP", "VIIRS_NOAA20"), geometry, keep_cells, rec)
        except (RuntimeError, SearchError):
            return row
        if not res["truncated"]:
            row.update(harmonized=round(float(res["rows"]["harmonized_weight"].sum()), 1), detections=int(len(res["rows"])))
        return row

    with ThreadPoolExecutor(max_workers=4) as pool:
        per = list(pool.map(one, range(FIRST_DAY.year, today.year + 1)))
    vals = np.array([np.nan if p["harmonized"] is None else p["harmonized"] for p in per], float)
    yrs = np.array([p["year"] for p in per])
    if not np.isfinite(vals).any():
        raise RuntimeError("NASA FIRMS: no year could be read for these dates")
    base = vals[(yrs >= 2003) & (yrs <= 2025)]
    base = base[np.isfinite(base)]
    sel = vals[yrs == end.year][0] if end.year in yrs else float("nan")
    ok = vals[np.isfinite(vals)]
    md = float(np.median(base)) if len(base) else float("nan")
    r1 = lambda x: None if x is None or not np.isfinite(x) else round(float(x), 1)
    enough = np.isfinite(sel) and np.isfinite(md) and md >= 1  # a ratio to almost nothing says nothing
    return {
        "source": "hotspots", "start": start.isoformat(), "end": end.isoformat(), "days": days, "baseline": "2003–2025",
        "selected": r1(sel), "median": r1(md), "mean": r1(float(np.mean(base))) if len(base) else None,
        "p25": r1(float(np.percentile(base, 25))) if len(base) else None,
        "p75": r1(float(np.percentile(base, 75))) if len(base) else None,
        "x_median": round(float(sel / md), 2) if enough else None,
        "delta_vs_median_pct": r1((sel / md - 1) * 100) if enough else None,
        "rank": int((ok > sel).sum()) + 1 if np.isfinite(sel) else None, "of_years": int(len(ok)),
        "percentile": r1(float((base < sel).mean() * 100)) if np.isfinite(sel) and len(base) else None,
        "years": per,
    }
