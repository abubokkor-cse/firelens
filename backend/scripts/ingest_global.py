"""
Build FireLens' GLOBAL fire archive from NASA's monthly science fire-location products.

Source (University of Maryland fire SFTP, credentials published in the product user guides):
  MODIS  MCD14ML  Collection 6 (Nov 2000 – Dec 2022) and 6.1 (Jan 2023 →)   Terra + Aqua, 1 km
  VIIRS  VNP14IMGML C2.04 (Jan 2012 →)  Suomi-NPP 375 m   — version with corrected fire "Type"
  VIIRS  VJ114IMGML C2.04 (Apr 2018 →)  NOAA-20 375 m

Each monthly file is streamed, cleaned the same way as the FIRMS pipeline (Type 0 = presumed vegetation fire,
MODIS confidence ≥ 30 %, VIIRS nominal/high) and reduced to one row per sensor × year × week × 0.25° cell
(detections, summed FRP, night detections). Monthly shards land in data/global_shards/ (restartable); `--compact`
then rewrites them as Parquet tiles partitioned by 10° × 10° for fast area queries with DuckDB.

MODIS C6 → C6.1 check (Jan 2023, global, vegetation fires, conf ≥ 30): 289,873 vs 289,193 detections (0.23 %),
FRP 10.10 vs 10.08 TW — the collection change does not introduce a step in the record.

Usage:
    python -m scripts.ingest_global              # download + aggregate every missing month (4 parallel streams)
    python -m scripts.ingest_global --nrt        # near-real-time bridge: last monthly file → today (FIRMS API, world)
    python -m scripts.ingest_global --compact    # shards → data/global/ty=…/tx=…/*.parquet
    python -m scripts.ingest_global --update     # daily: new months if published, refresh NRT, recompact
"""
import argparse
import io
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd
import paramiko

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.services.archive_store import CELL, DATA_DIR, aggregate, clean_firms  # noqa: E402

HOST, USER, PASSWORD = "fuoco.geog.umd.edu", "fire", "burnt"
SOURCES = [  # (sensor, remote folder, filename regex, first month)
    ("M", "data/MODIS/C6/MCD14ML", r"MCD14ML\.(\d{6})\.006\.\d+\.txt\.gz$", "200011"),
    ("M", "data/MODIS/C61/MCD14ML", r"MCD14ML\.(\d{6})\.061\.\d+\.txt\.gz$", "202301"),
    ("V", "data/VIIRS/C2/VNP14IMGML", r"VNP14IMGML\.(\d{6})\.C2\.\d+\.csv\.gz$", "201201"),
    ("J", "data/VIIRS/C2/VJ114IMGML", r"VJ114IMGML\.(\d{6})\.C2\.\d+\.csv\.gz$", "201804"),
]
SHARDS = os.path.join(DATA_DIR, "global_shards")
TILES = os.path.join(DATA_DIR, "global")
_local = threading.local()


def sftp() -> paramiko.SFTPClient:
    if getattr(_local, "sftp", None) is None:
        t = paramiko.Transport((HOST, 22))
        t.banner_timeout = t.auth_timeout = 60
        t.connect(username=USER, password=PASSWORD)
        t.set_keepalive(30)
        _local.sftp = paramiko.SFTPClient.from_transport(t)
        _local.sftp.get_channel().settimeout(60)  # a stalled read raises instead of hanging forever
    return _local.sftp


def drop_connection():
    """The server throttles long-lived sessions to a trickle, so every file gets a fresh one."""
    c = getattr(_local, "sftp", None)
    _local.sftp = None
    if c is not None:
        try:
            c.get_channel().get_transport().close()
        except Exception:
            pass


def listing() -> list[tuple[str, str, str]]:
    """(sensor, yyyymm, remote path) for every month, C6.1 preferred over C6 where both exist."""
    jobs = {}
    for sensor, folder, rx, first in SOURCES:
        for name in sftp().listdir(folder):
            m = re.match(rx, name)
            if m and m.group(1) >= first:
                jobs[(sensor, m.group(1))] = f"{folder}/{name}"  # later SOURCES entries (C6.1) win
    return [(s, ym, p) for (s, ym), p in sorted(jobs.items())]


def load(sensor: str, raw: bytes) -> pd.DataFrame:
    if sensor == "M":
        df = pd.read_csv(io.BytesIO(raw), compression="gzip", sep=r"\s+",
                         usecols=["YYYYMMDD", "lat", "lon", "FRP", "conf", "type", "dn"])
        df = df[(df["type"] == 0) & (df["conf"] >= 30)]
        return pd.DataFrame({"date": df["YYYYMMDD"], "lat": df["lat"], "lon": df["lon"],
                             "frp": df["FRP"], "night": (df["dn"] == "N").astype("int8")})
    df = pd.read_csv(io.BytesIO(raw), compression="gzip",
                     usecols=["YYYYMMDD", "Lat", "Lon", "FRP", "Confidence", "DNFlag", "Type"])
    df = df[(df["Type"] == 0) & (df["Confidence"].astype(str).str.upper() != "L")]
    return pd.DataFrame({"date": df["YYYYMMDD"], "lat": df["Lat"], "lon": df["Lon"],
                         "frp": df["FRP"], "night": (df["DNFlag"] == "N").astype("int8")})


def process(sensor: str, ym: str, path: str) -> str:
    dest = os.path.join(SHARDS, f"{sensor}_{ym}.parquet")
    if os.path.exists(dest):
        return f"{sensor} {ym} (cached)"
    for attempt in range(5):
        try:
            buf = io.BytesIO()
            t0 = time.time()
            sftp().getfo(path, buf)
            raw = buf.getvalue()
            drop_connection()
            break
        except Exception as e:  # stalled or dropped: reconnect and retry
            drop_connection()
            if attempt == 4:
                raise RuntimeError(f"{path}: {e}")
            time.sleep(10 * (attempt + 1))
    agg = aggregate(sensor, load(sensor, raw))
    agg.to_parquet(dest + ".part", index=False)
    os.replace(dest + ".part", dest)
    return f"{sensor} {ym}: {int(agg['n'].sum()):>9,} detections · {len(raw) / 1e6:5.0f} MB in {time.time() - t0:4.0f}s"


NRT = {"M": "MODIS_NRT", "V": "VIIRS_SNPP_NRT", "J": "VIIRS_NOAA20_NRT"}


def standard_month() -> str | None:
    """Last month (YYYYMM) that every sensor has as a monthly science file: the end of the standard archive.
    A month one sensor publishes early stays out of the archive, and in the NRT bridge, until the others catch up."""
    last: dict = {}
    for f in os.listdir(SHARDS) if os.path.isdir(SHARDS) else []:
        if f.endswith(".parquet") and "_nrt_" not in f:
            sensor, ym = f[:-8].split("_")
            last[sensor] = max(last.get(sensor, ""), ym)
    return min(last.values()) if len(last) == len(NRT) else None


def standard_end():
    """Last day of the standard archive: from the monthly files, or from meta.json when only the NRT part is here."""
    import datetime as dt
    import json
    from app.services.archive_store import META_PATH
    ym = standard_month()
    if ym:
        first = dt.date(int(ym[:4]), int(ym[4:]), 1)
        return (first.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1)
    return dt.date.fromisoformat(json.load(open(META_PATH))["standard_through"])


def nrt(refresh_days: int = 8):
    """Near-real-time bridge: FIRMS worldwide NRT detections from the day after the last monthly science file to
    today, in 5-day windows (shards <S>_nrt_<YYYYMMDD>.parquet). The last `refresh_days` are always refetched,
    because NRT data for recent days is still being completed. NRT has no fire-type field, so static industrial
    sources are not removed there; those weeks are flagged provisional."""
    import datetime as dt
    import json
    from app.core.config import settings
    from scripts.ingest_archive import AREA_URL, availability, fetch_area, missing_dates
    from app.services.archive_store import META_PATH, MISSING_PATH

    os.makedirs(SHARDS, exist_ok=True)
    std_end = standard_end()
    today, key = dt.date.today(), settings.FIRMS_API_KEY
    avail = availability(key)
    for f in os.listdir(SHARDS):  # drop windows that may still change
        if "_nrt_" in f:
            d = dt.date.fromisoformat(f.split("_nrt_")[1][:8][:4] + "-" + f.split("_nrt_")[1][4:6] + "-" + f.split("_nrt_")[1][6:8])
            if d >= today - dt.timedelta(days=refresh_days) or d <= std_end:
                os.remove(os.path.join(SHARDS, f))
    day = std_end + dt.timedelta(days=1)
    while day <= today:
        span = min(5, (today - day).days + 1)
        for sensor, code in NRT.items():
            dest = os.path.join(SHARDS, f"{sensor}_nrt_{day:%Y%m%d}.parquet")
            if os.path.exists(dest):
                continue
            # Standard-processing data may already cover some of these days — prefer it where available.
            sp = code.replace("_NRT", "_SP")
            src = sp if sp in avail and avail[sp][1] >= day + dt.timedelta(days=span - 1) else code
            raw = fetch_area(AREA_URL.format(key=key, source=src, bbox="world", days=span, date=day.isoformat()), key)
            agg = aggregate(sensor, clean_firms(sensor, pd.read_csv(io.BytesIO(raw), low_memory=False)))
            agg.to_parquet(dest + ".part", index=False)
            os.replace(dest + ".part", dest)
            print(f"  {sensor} NRT {day} +{span}d ({src}): {int(agg['n'].sum()):,} detections", flush=True)
        day += dt.timedelta(days=span)
    with open(MISSING_PATH, "w") as f:
        json.dump(missing_dates(), f)
    with open(META_PATH, "w") as f:
        json.dump({"through": today.isoformat(), "standard_through": std_end.isoformat(), "scope": "global"}, f)
    print(f"NRT bridge {std_end + dt.timedelta(days=1)} → {today} done; standard archive through {std_end}")


def _write_part(con, part: str, files: list, out: str) -> None:
    """One part of every 10° tile (hist_0.parquet or recent_0.parquet), with the model's estimate stored in it."""
    import glob as _glob
    import shutil
    shutil.rmtree(out, ignore_errors=True)
    if not files:
        return
    con.execute(f"""
        COPY (
            SELECT sensor, year, week, gy, gx, n, frp, n_night,
                   CAST(floor(gy * {CELL} / 10) AS INTEGER) AS ty, CAST(floor(gx * {CELL} / 10) AS INTEGER) AS tx
            FROM read_parquet({files!r})
            ORDER BY ty, tx, gy, gx, sensor, year, week
        ) TO '{out}' (FORMAT PARQUET, PARTITION_BY (ty, tx), COMPRESSION ZSTD, FILENAME_PATTERN '{part}_{{i}}')""")
    # Store the model's MODIS-equivalent estimate (mhat) in the tiles, so queries never have to run the model.
    from app.services import harmonizer_model
    if harmonizer_model.model() is not None:
        for fp in _glob.glob(os.path.join(out, "*", "*", "*.parquet")):
            df = harmonizer_model.add_mhat(pd.read_parquet(fp))
            df["mhat"] = df["mhat"].round(2).astype("float32")  # 0.01 detection precision compresses far better
            df.to_parquet(fp, index=False, compression="zstd")


def compact(part: str = "all"):
    """Rewrite the tiles. Each 10° tile holds two files: hist_0.parquet from the monthly science files (changes only
    when NASA publishes a new month) and recent_0.parquet from the near-real-time bridge (small, rewritten daily).
    part="recent" rewrites only the recent files; part="all" rebuilds both and swaps them in at once."""
    import duckdb
    import glob as _glob
    import shutil
    std = standard_month()
    shards = sorted(_glob.glob(os.path.join(SHARDS, "*.parquet")))
    hist = [f for f in shards if "_nrt_" not in f and std and os.path.basename(f)[:-8].split("_")[1] <= std]
    recent = [f for f in shards if "_nrt_" in f]
    con = duckdb.connect()
    if part == "recent":
        tmp = TILES + ".recent"
        _write_part(con, "recent", recent, tmp)
        for fp in _glob.glob(os.path.join(TILES, "ty=*", "tx=*", "recent_*.parquet")):
            os.remove(fp)
        for fp in _glob.glob(os.path.join(tmp, "*", "*", "*.parquet")):
            dest = os.path.join(TILES, os.path.relpath(fp, tmp))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            os.replace(fp, dest)
        shutil.rmtree(tmp, ignore_errors=True)
    else:
        new, old = TILES + ".new", TILES + ".old"
        _write_part(con, "hist", hist, new)
        _write_part(con, "recent", recent, new + ".recent")
        for fp in _glob.glob(os.path.join(new + ".recent", "*", "*", "*.parquet")):
            dest = os.path.join(new, os.path.relpath(fp, new + ".recent"))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            os.replace(fp, dest)
        shutil.rmtree(new + ".recent", ignore_errors=True)
        # Swap in the new tiles in one step so readers never see a half-written archive.
        shutil.rmtree(old, ignore_errors=True)
        if os.path.isdir(TILES):
            os.replace(TILES, old)
        os.replace(new, TILES)
        shutil.rmtree(old, ignore_errors=True)
    rows = con.execute(f"SELECT count(*), sum(n) FROM read_parquet('{TILES}/**/*.parquet')").fetchone()
    size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(TILES) for f in fs)
    print(f"compacted ({part}) → {TILES}: {rows[0]:,} cell-weeks, {int(rows[1] or 0):,} detections, {size / 1e6:.0f} MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--compact", action="store_true")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--nrt", action="store_true", help="fetch the near-real-time bridge after the monthly files")
    ap.add_argument("--update", action="store_true", help="daily: new monthly files if any, refresh NRT, recompact")
    ap.add_argument("--until-done", action="store_true",
                    help="keep retrying failed files every 15 min until every month is in (the UMD server throttles)")
    args = ap.parse_args()
    if args.compact:
        return compact()
    if args.nrt:
        return nrt()
    os.makedirs(SHARDS, exist_ok=True)
    rnd = 0
    while True:
        rnd += 1
        try:
            jobs = listing()
        except Exception as e:
            print(f"  listing failed ({e}); retrying in 15 min", flush=True)
            drop_connection()
            time.sleep(900)
            continue
        drop_connection()
        todo = [j for j in jobs if not os.path.exists(os.path.join(SHARDS, f"{j[0]}_{j[1]}.parquet"))]
        print(f"round {rnd}: {len(jobs)} monthly files, {len(todo)} to fetch", flush=True)
        failed = []
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futs = {pool.submit(process, *j): j for j in todo}
            for f in as_completed(futs):
                try:
                    print("  " + f.result(), flush=True)
                except Exception as e:
                    failed.append(futs[f])
                    print(f"  ✗ {e}", flush=True)
        if not failed or not args.until_done:
            break
        print(f"  {len(failed)} files still missing — waiting 15 min for the server", flush=True)
        time.sleep(900)
    print(f"done — {len(failed)} failed" + (" (re-run to retry)" if failed else ""))
    if args.update and not failed:
        nrt()
        compact()


if __name__ == "__main__":
    main()
