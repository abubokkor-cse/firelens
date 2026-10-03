"""
The newest days for a searched area, fetched from NASA FIRMS on request.

The stored archive is extended for the whole planet once a day (scripts/ingest_global.py --update). Between those
runs an area's record is topped up when it is asked for: FIRMS near-real-time detections from the first day of the
archive's last week up to now are fetched for the area, cleaned and gridded exactly like the archive, and replace
those weeks. An area is reused for 30 minutes and then fetched again, and simultaneous searches for it share one
fetch; the daily run then stores the same days permanently for everyone.
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
from app.services import archive_store as store

SOURCES = {"M": "MODIS_NRT", "V": "VIIRS_SNPP_NRT", "J": "VIIRS_NOAA20_NRT"}
AREA_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{source}/{bbox}/{days}/{date}"
UA = {"User-Agent": "FireLens/1.0"}
TTL = 1800          # an area's top-up is reused for 30 minutes, then fetched again (~2–3 s)
WORLD_TTL = 3600    # the whole planet: an hour, refreshed in the background (a worldwide fetch takes ~25 s)
STALE_OK = 6 * 3600  # how old a worldwide top-up may be while its refresh runs
MAX_DAYS = 31       # beyond this the archive itself is out of date; leave it to the daily update

_cache: dict = {}
_busy: dict = {}
_lock = threading.Lock()


def week_start(day: dt.date) -> dt.date:
    """First day of the fixed 52-week calendar week that contains `day`."""
    w = int(store.week_of_year(day.timetuple().tm_yday))
    return dt.date(day.year, 1, 1) + dt.timedelta(days=(w - 1) * 7)


def _pieces(bbox: BoundingBox) -> list:
    """The bbox snapped outwards to whole 0.25° cells, split at the antimeridian (FIRMS wants west < east), as
    FIRMS area strings."""
    c = store.CELL
    s, n = max(-90.0, np.floor(bbox.south / c) * c), min(90.0, (np.floor(bbox.north / c) + 1) * c)
    w, e = np.floor(bbox.west / c) * c, (np.floor(bbox.east / c) + 1) * c
    boxes = [(max(-180.0, w), s, min(180.0, e), n)] if bbox.west <= bbox.east else \
        [(max(-180.0, w), s, 180.0, n), (-180.0, s, min(180.0, e), n)]
    return [f"{a:g},{b:g},{c_:g},{d:g}" for a, b, c_, d in boxes]


def _get(url: str) -> bytes:
    last = ""
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                raw = r.read()
            if raw.startswith(b"latitude"):
                return raw
            last = raw[:120].decode("utf-8", "replace").strip()
        except Exception as e:
            last = str(e)
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"FIRMS request failed: {last}")


def _area(bbox: Optional[BoundingBox], country: Optional[str]):
    """(FIRMS area strings, cell keep-set or None) for a country, a bbox or the whole planet."""
    if country:
        c = store.cells()
        c = c[c["country"] == country.replace("_", " ")]
        if c.empty:
            return None
        cell = store.CELL
        gx = c["gx"].to_numpy()
        box = BoundingBox(west=float(gx.min() * cell), east=float(gx.max() * cell + cell - 1e-6),
                          south=float(c["gy"].min() * cell), north=float(c["gy"].max() * cell + cell - 1e-6))
        return _pieces(box), set(zip(c["gy"].to_numpy(), gx))
    if bbox is None:
        return ["world"], None
    return _pieces(bbox), None


def recent(bbox: Optional[BoundingBox], country: Optional[str], geometry: Optional[dict], through: dt.date,
           now: Optional[dt.datetime] = None) -> Optional[dict]:
    """Archive-shaped rows (sensor, year, week, gy, gx, n, frp, n_night) for the area from the first day of the
    archive's last week to today, or None when there is nothing to add or FIRMS cannot be reached (the stored
    archive is then shown as it is — never a partial top-up)."""
    key_ = settings.FIRMS_API_KEY
    now = now or dt.datetime.now(dt.timezone.utc)
    today = now.date()
    start = week_start(through)
    if not key_ or (today - start).days > MAX_DAYS or today < through:
        return None
    area = _area(bbox, country)
    if area is None:
        return None
    pieces, keep = area
    ck = (country, tuple(pieces), hashlib.md5(json.dumps(geometry, sort_keys=True).encode()).hexdigest() if geometry else None,
          start)
    ttl = WORLD_TTL if pieces == ["world"] else TTL
    with _lock:
        hit = _cache.get(ck)
        if hit and time.time() - hit["fetched"] < ttl:
            return hit
        busy = _busy.setdefault(ck, threading.Lock())
    if pieces == ["world"] and hit and hit["from"] == start and time.time() - hit["fetched"] < STALE_OK:
        # Serve the previous top-up at once and refresh it in the background (a worldwide fetch takes ~25 s).
        def refresh():
            if busy.acquire(blocking=False):
                try:
                    _fetch(ck, pieces, keep, bbox, country, geometry, start, dt.datetime.now(dt.timezone.utc))
                finally:
                    busy.release()
        threading.Thread(target=refresh, daemon=True).start()
        return hit
    with busy:  # one fetch per area at a time; later callers get its result
        with _lock:
            hit = _cache.get(ck)
            if hit and time.time() - hit["fetched"] < ttl:
                return hit
        return _fetch(ck, pieces, keep, bbox, country, geometry, start, now)


def _points(sensor: str, url: str, start: dt.date, today: dt.date) -> Optional[pd.DataFrame]:
    """One FIRMS request, cleaned and gridded. Read in chunks: a worldwide week is a few hundred thousand rows."""
    raw = _get(url)
    if raw.count(b"\n") < 2:
        return None
    frames = []
    for chunk in pd.read_csv(io.BytesIO(raw), low_memory=False, chunksize=250_000):
        pts = store.clean_firms(sensor, chunk)
        pts = pts[(pts["date"] >= f"{start:%Y%m%d}") & (pts["date"] <= f"{today:%Y%m%d}")]
        if len(pts):
            frames.append(store.aggregate(sensor, pts))
    return pd.concat(frames, ignore_index=True) if frames else None


def _fetch(ck, pieces, keep, bbox, country, geometry, start: dt.date, now: dt.datetime) -> Optional[dict]:
    key_, today = settings.FIRMS_API_KEY, now.date()

    days = (today - start).days + 1
    jobs = []
    d = start
    while d <= today:
        span = min(5, (today - d).days + 1)  # the area API serves at most 5 days per request
        for sensor, source in SOURCES.items():
            for area in pieces:
                jobs.append((sensor, AREA_URL.format(key=key_, source=source, bbox=area, days=span, date=d.isoformat())))
        d += dt.timedelta(days=span)
    try:  # worldwide requests are large, so fewer at a time
        with ThreadPoolExecutor(max_workers=3 if pieces == ["world"] else 6) as pool:
            frames = [f for f in pool.map(lambda j: _points(j[0], j[1], start, today), jobs) if f is not None]
    except Exception:
        return None
    rows = (pd.concat(frames, ignore_index=True)
              .groupby(["sensor", "year", "week", "gy", "gx"], as_index=False, observed=True).sum()
            if frames else pd.DataFrame(columns=store.COLUMNS))
    if len(rows) and pieces != ["world"]:
        gy, gx = rows["gy"].to_numpy(), rows["gx"].to_numpy()
        if keep is not None:
            rows = rows[[k in keep for k in zip(gy, gx)]]
        else:
            c = store.CELL
            ok = (gy >= np.floor(bbox.south / c)) & (gy <= np.floor(bbox.north / c))
            ok &= ((gx >= np.floor(bbox.west / c)) & (gx <= np.floor(bbox.east / c))) if bbox.west <= bbox.east \
                else ((gx >= np.floor(bbox.west / c)) | (gx <= np.floor(bbox.east / c)))
            rows = rows[ok]
        if geometry and not country and len(rows):
            lat, lon = (rows["gy"].to_numpy() + .5) * store.CELL, (rows["gx"].to_numpy() + .5) * store.CELL
            rows = rows[store.in_geometry(lon, lat, geometry)]
    rows = rows.astype({"n": "int64", "n_night": "int64", "frp": "float64"}).reset_index(drop=True)

    out = {"rows": rows, "from": start, "to": now, "days": days, "requests": len(jobs), "fetched": time.time(),
           "detections": {s: int(rows.loc[rows["sensor"] == s, "n"].sum()) for s in SOURCES}}
    with _lock:
        _cache[ck] = out
        if len(_cache) > 200:
            _cache.pop(next(iter(_cache)))
    return out
