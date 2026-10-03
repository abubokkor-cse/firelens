"""
Read access to FireLens' aggregated fire archive.

Two layouts, same row shape (sensor, year, week, gy, gx, n, frp, n_night [+ lat, lon]):
  • global  data/global/ty=…/tx=…/*.parquet — the whole planet, 10° × 10° tiles (scripts/ingest_global.py),
            queried with DuckDB so only the tiles under an area of interest are read;
  • legacy  data/weekly_grid.csv.gz — per-country grid built from FIRMS country files (scripts/ingest_archive.py).
Sensors: M = MODIS Terra+Aqua 1 km, V = VIIRS S-NPP 375 m, J = VIIRS NOAA-20 375 m. Cells are 0.25°.
"""
import glob
import json
import os
from functools import lru_cache
from typing import Optional

import numpy as np
import pandas as pd

from app.models.schemas import BoundingBox

DATA_DIR = os.environ.get("FIRELENS_DATA_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data")
GRID_PATH = os.path.join(DATA_DIR, "weekly_grid.csv.gz")
TILES_DIR = os.path.join(DATA_DIR, "global")
CELLS_PATH = os.path.join(DATA_DIR, "cells.parquet")          # 0.25° cell → country (scripts/build_cells.py)
COUNTRIES_PATH = os.path.join(DATA_DIR, "countries.csv")
META_PATH = os.path.join(DATA_DIR, "meta.json")
MANIFEST_PATH = os.path.join(DATA_DIR, "manifest.json")      # publication manifest (remote tiles, fetched lazily)
MISSING_PATH = os.path.join(DATA_DIR, "missing_dates.json")
CELL = 0.25
WEEKS = 52
COLUMNS = ["sensor", "year", "week", "gy", "gx", "n", "frp", "n_night"]


def week_of_year(doy):
    """Fixed 52-week calendar: week 52 absorbs the last 8–9 days of the year."""
    return np.minimum(WEEKS, (np.asarray(doy) - 1) // 7 + 1)


def aggregate(sensor: str, df: pd.DataFrame) -> pd.DataFrame:
    d = pd.to_datetime(df["date"].astype(str), format="%Y%m%d", errors="coerce")
    out = pd.DataFrame({
        "sensor": sensor,
        "year": d.dt.year.astype("int16"),
        "week": week_of_year(d.dt.dayofyear).astype("int8"),
        "gy": np.floor(df["lat"].to_numpy() / CELL).astype("int16"),
        "gx": np.floor(df["lon"].to_numpy() / CELL).astype("int16"),
        "frp": df["frp"].fillna(0).astype("float32"),
        "night": df["night"],
    })
    return (out.groupby(["sensor", "year", "week", "gy", "gx"], as_index=False, observed=True)
               .agg(n=("frp", "size"), frp=("frp", "sum"), n_night=("night", "sum")))


def clean_firms(sensor: str, df: pd.DataFrame) -> pd.DataFrame:
    """A FIRMS area-API CSV with the archive's cleaning rules (vegetation fires only where the type field exists,
    MODIS confidence ≥ 30 %, VIIRS nominal/high), in the columns aggregate() expects."""
    if "type" in df.columns:
        df = df[pd.to_numeric(df["type"], errors="coerce").fillna(0) == 0]
    conf = df["confidence"].astype(str).str.strip().str.lower()
    df = df[pd.to_numeric(conf, errors="coerce").fillna(0) >= 30] if sensor == "M" else df[conf != "l"]
    return pd.DataFrame({"date": df["acq_date"].astype(str).str.replace("-", ""), "lat": df["latitude"],
                         "lon": df["longitude"], "frp": df["frp"], "night": (df["daynight"] == "N").astype("int8")})


# ── layout & versioning ────────────────────────────────────────────────────────
@lru_cache(maxsize=2)
def _manifest_cached(mtime: float) -> dict:
    with open(MANIFEST_PATH) as f:
        return {e["path"]: e["size"] for e in json.load(f)["files"] if e["path"].startswith("global/")}


def remote_tiles() -> dict:
    """{relative tile path: size} listed in the publication manifest (empty when running from local tiles)."""
    if not os.environ.get("FIRELENS_ARCHIVE_URL") or not os.path.exists(MANIFEST_PATH):
        return {}
    return _manifest_cached(os.path.getmtime(MANIFEST_PATH))


def is_global() -> bool:
    return bool(remote_tiles()) or bool(glob.glob(os.path.join(TILES_DIR, "ty=*", "tx=*", "*.parquet")))


def available() -> bool:
    return is_global() or os.path.exists(GRID_PATH)


def version() -> str:
    """Changes whenever the archive changes — part of every cache key."""
    if remote_tiles():
        return f"R:{os.path.getmtime(MANIFEST_PATH):.0f}:{through()}"
    path = TILES_DIR if is_global() else GRID_PATH
    stamp = max((os.path.getmtime(p) for p in glob.glob(os.path.join(path, "**"), recursive=True)), default=0) \
        if os.path.isdir(path) else (os.path.getmtime(path) if os.path.exists(path) else 0)
    return f"{'G' if is_global() else 'L'}:{stamp:.0f}:{through()}"


def through() -> Optional[str]:
    """Date the archive was last ingested (ISO), if known."""
    return meta().get("through")


def meta() -> dict:
    if not os.path.exists(META_PATH):
        return {}
    with open(META_PATH) as f:
        return json.load(f)


def missing_days() -> dict:
    """{sensor: set(dates)} from FIRMS' official missing-data table. Sensors: M-Terra, M-Aqua, V (S-NPP), J (NOAA-20)."""
    if not os.path.exists(MISSING_PATH):
        return {}
    import datetime as _dt
    out: dict = {}
    with open(MISSING_PATH) as f:
        for r in json.load(f):
            out.setdefault(r["sensor"], set()).add(_dt.date.fromisoformat(r["date"]))
    return out


def _finish(df: pd.DataFrame) -> pd.DataFrame:
    df["sensor"] = df["sensor"].astype("category")
    df["n_night"] = df["n_night"].fillna(0).astype("int32") if "n_night" in df.columns else 0
    df["lat"] = ((df["gy"] + 0.5) * CELL).astype("float32")
    df["lon"] = ((df["gx"] + 0.5) * CELL).astype("float32")
    return df


# ── legacy per-country grid ────────────────────────────────────────────────────
@lru_cache(maxsize=1)
def _grid_cached(mtime: float) -> pd.DataFrame:
    df = pd.read_csv(GRID_PATH, dtype={"country": "category", "sensor": "category", "year": "int16", "week": "int8",
                                       "gy": "int16", "gx": "int16", "n": "int32", "frp": "float32", "mhat": "float32",
                                       "n_night": "float32"})
    return _finish(df)


def grid() -> Optional[pd.DataFrame]:
    """The legacy in-memory grid (None in global mode or when absent)."""
    if is_global() or not os.path.exists(GRID_PATH):
        return None
    return _grid_cached(os.path.getmtime(GRID_PATH))


# ── global tiles (DuckDB) ──────────────────────────────────────────────────────
def _tile_of(rel: str) -> tuple:
    parts = dict(p.split("=") for p in rel.split("/") if "=" in p)
    return int(parts["ty"]), int(parts["tx"])


def _ensure_local(paths: list) -> None:
    """Download the listed tiles that are not on disk yet (in parallel) from FIRELENS_ARCHIVE_URL."""
    missing = [p for p in paths if not os.path.exists(os.path.join(DATA_DIR, p))]
    if not missing:
        return
    import urllib.parse
    import urllib.request
    from concurrent.futures import ThreadPoolExecutor
    base = os.environ["FIRELENS_ARCHIVE_URL"].rstrip("/")

    def get(rel):
        import threading
        import time
        dest = os.path.join(DATA_DIR, rel)
        req = urllib.request.Request(f"{base}/{urllib.parse.quote(rel, safe='/-_.~')}", headers={"User-Agent": "FireLens/1.0"})
        for attempt in range(4):  # a download cut off midway (IncompleteRead, reset) is simply retried
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    data = r.read()
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(1.5 * (attempt + 1))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        part = dest + f".{os.getpid()}-{threading.get_ident()}.part"
        with open(part, "wb") as fh:
            fh.write(data)
        os.replace(part, dest)
    with ThreadPoolExecutor(16) as pool:
        list(pool.map(get, missing))


def _tile_files(tiles: Optional[tuple]) -> list:
    """Absolute paths of the tiles covering a ty/tx range (all tiles when None), fetched first if remote."""
    rt = remote_tiles()
    if rt:
        rels = [p for p in rt if tiles is None or (tiles[0] <= _tile_of(p)[0] <= tiles[1] and tiles[2] <= _tile_of(p)[1] <= tiles[3])]
        _ensure_local(rels)
        return [os.path.join(DATA_DIR, p) for p in rels]
    files = glob.glob(os.path.join(TILES_DIR, "ty=*", "tx=*", "*.parquet"))
    if tiles is not None:
        files = [f for f in files if tiles[0] <= _tile_of(os.path.relpath(f, DATA_DIR))[0] <= tiles[1]
                 and tiles[2] <= _tile_of(os.path.relpath(f, DATA_DIR))[1] <= tiles[3]]
    return files


def _query(where: str = "", params: Optional[list] = None, tiles: Optional[tuple] = None) -> pd.DataFrame:
    import duckdb
    files = _tile_files(tiles)
    if not files:
        return pd.DataFrame(columns=COLUMNS)
    src = f"read_parquet({files!r}, hive_partitioning = true, union_by_name = true)"
    cond = []
    if where:
        cond.append(where)
    cols = ", ".join(COLUMNS + (["mhat"] if _tiles_have_mhat() else []))
    sql = f"SELECT {cols} FROM {src}" + (" WHERE " + " AND ".join(cond) if cond else "")
    with duckdb.connect() as con:
        return con.execute(sql, params or []).df()


def _weeks_sql(weeks: Optional[tuple]) -> str:
    return f" AND week IN ({', '.join(str(int(w)) for w in weeks)})" if weeks else ""


@lru_cache(maxsize=4)
def _mhat_cached(stamp: str) -> bool:
    import duckdb
    rt = remote_tiles()
    if rt:
        first = sorted(rt)[0]
        _ensure_local([first])
        files = [os.path.join(DATA_DIR, first)]
    else:
        files = glob.glob(os.path.join(TILES_DIR, "ty=*", "tx=*", "*.parquet"))
    if not files:
        return False
    with duckdb.connect() as con:
        return "mhat" in [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{files[0]}')").fetchall()]


def _tiles_have_mhat() -> bool:
    """True when the tiles carry precomputed model estimates (written at compaction)."""
    return _mhat_cached(version())


def _tile_range(gy0: int, gy1: int, gx0: int, gx1: int) -> tuple:
    f = 10 / CELL
    return int(np.floor(gy0 / f)), int(np.floor(gy1 / f)), int(np.floor(gx0 / f)), int(np.floor(gx1 / f))


@lru_cache(maxsize=1)
def _cells_cached(mtime: float) -> pd.DataFrame:
    return pd.read_parquet(CELLS_PATH)


def cells() -> pd.DataFrame:
    """0.25° cell → country lookup (empty if not built)."""
    if not os.path.exists(CELLS_PATH):
        return pd.DataFrame(columns=["gy", "gx", "country"])
    return _cells_cached(os.path.getmtime(CELLS_PATH))


def _global_select(bbox: Optional[BoundingBox], country: Optional[str], weeks: Optional[tuple] = None) -> pd.DataFrame:
    if country:
        c = cells()
        c = c[c["country"] == country.replace("_", " ")]
        if c.empty:
            return pd.DataFrame(columns=COLUMNS)
        gy0, gy1, gx0, gx1 = int(c.gy.min()), int(c.gy.max()), int(c.gx.min()), int(c.gx.max())
        df = _query("gy BETWEEN ? AND ? AND gx BETWEEN ? AND ?" + _weeks_sql(weeks), [gy0, gy1, gx0, gx1],
                    _tile_range(gy0, gy1, gx0, gx1))
        keep = set(zip(c.gy.to_numpy(), c.gx.to_numpy()))
        return df[[k in keep for k in zip(df["gy"].to_numpy(), df["gx"].to_numpy())]]
    if bbox is None:
        return _query(_weeks_sql(weeks)[5:])
    gy0, gy1 = int(np.floor(bbox.south / CELL)), int(np.floor(bbox.north / CELL))
    if bbox.west <= bbox.east:
        gx0, gx1 = int(np.floor(bbox.west / CELL)), int(np.floor(bbox.east / CELL))
        return _query("gy BETWEEN ? AND ? AND gx BETWEEN ? AND ?" + _weeks_sql(weeks), [gy0, gy1, gx0, gx1],
                      _tile_range(gy0, gy1, gx0, gx1))
    # crosses the antimeridian
    a = _global_select(BoundingBox(west=bbox.west, south=bbox.south, east=180, north=bbox.north), None, weeks)
    b = _global_select(BoundingBox(west=-180, south=bbox.south, east=bbox.east, north=bbox.north), None, weeks)
    return pd.concat([a, b], ignore_index=True)


# ── public selection API ───────────────────────────────────────────────────────
def countries() -> list[dict]:
    """Countries in the archive with their bounding boxes."""
    if is_global():
        c = cells()
        if c.empty:
            return []
        t = c.groupby("country").agg(gy0=("gy", "min"), gy1=("gy", "max"), gx0=("gx", "min"), gx1=("gx", "max"), n=("gy", "size"))
        return [{"country": k, "west": r.gx0 * CELL, "south": r.gy0 * CELL, "east": (r.gx1 + 1) * CELL,
                 "north": (r.gy1 + 1) * CELL, "cells": int(r.n)} for k, r in t.iterrows() if k != "Ocean"]
    if os.path.exists(COUNTRIES_PATH):
        return pd.read_csv(COUNTRIES_PATH).to_dict("records")
    g = grid()
    if g is None:
        return []
    t = g.groupby("country", observed=True).agg(gy0=("gy", "min"), gy1=("gy", "max"), gx0=("gx", "min"), gx1=("gx", "max"))
    return [{"country": c, "west": r.gx0 * CELL, "south": r.gy0 * CELL, "east": (r.gx1 + 1) * CELL, "north": (r.gy1 + 1) * CELL}
            for c, r in t.iterrows()]


def _rings(geometry: dict) -> list:
    t, c = geometry.get("type"), geometry.get("coordinates") or []
    if t == "Polygon":
        return [np.asarray(r, float) for r in c]
    if t == "MultiPolygon":
        return [np.asarray(r, float) for poly in c for r in poly]
    return []


def in_geometry(lon: np.ndarray, lat: np.ndarray, geometry: dict) -> np.ndarray:
    """Even-odd point-in-polygon test for GeoJSON Polygon/MultiPolygon (holes handled by the even-odd rule)."""
    inside = np.zeros(len(lon), bool)
    for ring in _rings(geometry):
        if len(ring) < 3:
            continue
        x1, y1 = ring[:, 0], ring[:, 1]
        x2, y2 = np.roll(x1, -1), np.roll(y1, -1)
        for a, b, c, d in zip(x1, y1, x2, y2):
            if b == d:
                continue
            cross = ((b > lat) != (d > lat)) & (lon < (c - a) * (lat - b) / (d - b) + a)
            inside ^= cross
    return inside


def select(bbox: Optional[BoundingBox] = None, country: Optional[str] = None,
           geometry: Optional[dict] = None, weeks: Optional[tuple] = None) -> pd.DataFrame:
    """Rows whose cell centre falls inside the AOI: a country, a GeoJSON polygon (with its bbox), or a bbox.
    `weeks` optionally restricts to those weeks of the year (all years)."""
    if is_global():
        rows = _finish(_global_select(bbox, country, weeks))
    else:
        g = grid()
        if g is None:
            return pd.DataFrame()
        if weeks:
            g = g[g["week"].isin(list(weeks))]
        if country:
            return g[g["country"] == country]
        if bbox is None:
            return g
        lon_ok = (g["lon"] >= bbox.west) & (g["lon"] <= bbox.east) if bbox.west <= bbox.east \
            else (g["lon"] >= bbox.west) | (g["lon"] <= bbox.east)
        rows = g[lon_ok & (g["lat"] >= bbox.south) & (g["lat"] <= bbox.north)]
    if geometry and _rings(geometry) and not country:
        cs = rows[["gy", "gx", "lon", "lat"]].drop_duplicates(["gy", "gx"])
        ok = in_geometry(cs["lon"].to_numpy(float), cs["lat"].to_numpy(float), geometry)
        keep = set(zip(cs["gy"].to_numpy()[ok], cs["gx"].to_numpy()[ok]))
        rows = rows[[k in keep for k in zip(rows["gy"].to_numpy(), rows["gx"].to_numpy())]]
    return rows


def select_chunks(bbox: Optional[BoundingBox] = None, country: Optional[str] = None,
                  geometry: Optional[dict] = None, band_deg: int = 10):
    """Like select(), but yields the area in 10°-latitude bands so a continent or the planet never has to sit in
    memory at once. Small areas come back as a single chunk."""
    if not is_global() or country:
        yield select(bbox, country, geometry)
        return
    south, north = (bbox.south, bbox.north) if bbox else (-90.0, 90.0)
    if north - south <= band_deg:
        yield select(bbox, None, geometry)
        return
    lat = np.floor(south / band_deg) * band_deg
    while lat < north:
        lo, hi = max(south, lat), min(north, lat + band_deg - CELL / 2)
        part = BoundingBox(west=bbox.west if bbox else -180, east=bbox.east if bbox else 180, south=lo, north=hi)
        chunk = select(part, None, geometry)
        if not chunk.empty:
            yield chunk
        lat += band_deg


def coverage(bbox: BoundingBox) -> float:
    """Share of the bbox covered by the archive (0–1). The global archive covers every land cell."""
    if is_global():
        return 1.0
    g = grid()
    if g is None:
        return 0.0
    cs = select(bbox)[["gy", "gx"]].drop_duplicates()
    lat_span = max(CELL, bbox.north - bbox.south)
    lon_span = max(CELL, (bbox.east - bbox.west) % 360 or 360)
    return float(min(1.0, len(cs) * CELL * CELL / (lat_span * lon_span)))


def year_grid(year: int, sensor: str) -> pd.DataFrame:
    """One sensor-year aggregated per 0.25° cell (for the globe): gy, gx, n, frp."""
    if is_global():
        df = _query("year = ? AND sensor = ?", [year, sensor])
    else:
        g = grid()
        if g is None:
            return pd.DataFrame(columns=["gy", "gx", "n", "frp"])
        df = g[(g["year"] == year) & (g["sensor"] == sensor)]
    return df.groupby(["gy", "gx"], as_index=False)[["n", "frp", "n_night"]].sum()
