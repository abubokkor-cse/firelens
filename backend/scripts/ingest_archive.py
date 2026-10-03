"""
Build FireLens' historical fire archive from NASA FIRMS.

Downloads FIRMS yearly country archives (MODIS C6.1 2000–2025, VIIRS S-NPP 375 m 2012–2025),
plus the current year through the FIRMS area API (standard-processing archive, then NRT),
and reduces every detection to a weekly 0.25° grid:

    country, sensor (M = MODIS, V = VIIRS S-NPP), year, week (1–52), gy, gx, n, frp

Raw CSVs are streamed and discarded; only the aggregate is kept in data/weekly_grid.csv.gz.

Usage:
    python -m scripts.ingest_archive                      # default countries
    python -m scripts.ingest_archive --countries Chile Peru
    python -m scripts.ingest_archive --update             # fast: only days after the archive's last date (daily/weekly cron)
    python -m scripts.ingest_archive --only-current-year  # slower: rebuild the latest two years
"""
import argparse
import datetime as dt
import io
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.core.config import settings  # noqa: E402
from app.services.archive_store import DATA_DIR, GRID_PATH, COUNTRIES_PATH, META_PATH, MISSING_PATH, CELL, week_of_year  # noqa: E402

ARCHIVE_URL = "https://firms.modaps.eosdis.nasa.gov/data/country/{folder}/{year}/{folder}_{year}_{country}.csv"
AREA_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{source}/{bbox}/{days}/{date}"
AVAIL_URL = "https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/{key}/all"

SENSORS = {
    "M": {"folder": "modis", "first": 2000, "sp": "MODIS_SP", "nrt": "MODIS_NRT"},
    "V": {"folder": "viirs-snpp", "first": 2012, "sp": "VIIRS_SNPP_SP", "nrt": "VIIRS_SNPP_NRT"},
    # NOAA-20 carries the VIIRS record on when S-NPP retires (anticipated end of life: October 2026).
    "J": {"folder": "viirs-jpss1", "first": 2018, "sp": "VIIRS_NOAA20_SP", "nrt": "VIIRS_NOAA20_NRT"},
}
MISSING_URL = "https://firms.modaps.eosdis.nasa.gov/api/missing_data/?action=fetch_data"
SATELLITE_SENSOR = {"Terra (MODIS)": "M-Terra", "Aqua (MODIS)": "M-Aqua", "Suomi NPP (VIIRS)": "V", "NOAA-20 (VIIRS)": "J"}

DEFAULT_COUNTRIES = ["Bangladesh", "Argentina", "Brazil", "United_States", "Australia", "India", "Thailand", "Indonesia"]

UA = {"User-Agent": "FireLens/1.0 (NASA Space Apps Challenge 2026)"}
STATUS_URL = "https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY={key}"
_budget_lock = threading.Lock()
_budget_checked = [0.0]


class FetchError(RuntimeError):
    pass


def wait_for_budget(key: str, headroom: int = 600):
    """Block while the MAP_KEY is close to its FIRMS transaction limit (5000 per 10 minutes)."""
    with _budget_lock:
        while time.time() - _budget_checked[0] > 15:
            try:
                with urllib.request.urlopen(urllib.request.Request(STATUS_URL.format(key=key), headers=UA), timeout=30) as r:
                    st = json.loads(r.read())
                used, limit = int(st.get("current_transactions", 0)), int(st.get("transaction_limit", 5000))
            except Exception:
                used, limit = 0, 5000
            if used < limit - headroom:
                _budget_checked[0] = time.time()
                break
            print(f"   … FIRMS key at {used}/{limit} transactions — pausing 60 s")
            time.sleep(60)


def http_get(url: str, retries: int = 4, timeout: int = 180) -> bytes | None:
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            wait = 30 if e.code == 429 else 5 * (attempt + 1)
        except Exception:
            wait = 5 * (attempt + 1)
        time.sleep(wait)
    raise FetchError(f"download failed: {url.split('/data/')[-1]}")


def clean(df: pd.DataFrame, sensor: str) -> pd.DataFrame:
    """Keep presumed vegetation fires with at least nominal confidence."""
    if "type" in df.columns:
        df = df[pd.to_numeric(df["type"], errors="coerce").fillna(0) == 0]
    conf = df["confidence"].astype(str).str.strip().str.lower()
    if sensor == "M":
        df = df[pd.to_numeric(conf, errors="coerce").fillna(0) >= 30]
    else:
        df = df[conf != "l"]
    return df


def aggregate(df: pd.DataFrame, sensor: str, country: str) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame()
    df = clean(df, sensor)
    d = pd.to_datetime(df["acq_date"], errors="coerce")
    out = pd.DataFrame({
        "country": country,
        "sensor": sensor,
        "year": d.dt.year,
        "week": week_of_year(d.dt.dayofyear),
        "gy": np.floor(pd.to_numeric(df["latitude"]) / CELL).astype(int),
        "gx": np.floor(pd.to_numeric(df["longitude"]) / CELL).astype(int),
        "frp": pd.to_numeric(df["frp"], errors="coerce").fillna(0.0),
        # VIIRS finds ~3× more fire pixels than MODIS by day but ~17× more at night (VIIRS C2 user guide),
        # so the night share is kept for the harmonization model.
        "night": (df["daynight"].astype(str).str.upper() == "N").astype(int) if "daynight" in df.columns else 0,
    }).dropna(subset=["year"])
    out["year"] = out["year"].astype(int)
    return (out.groupby(["country", "sensor", "year", "week", "gy", "gx"], as_index=False)
               .agg(n=("frp", "size"), frp=("frp", "sum"), n_night=("night", "sum")))


def ingest_year_file(country: str, sensor: str, year: int) -> pd.DataFrame:
    folder = SENSORS[sensor]["folder"]
    raw = http_get(ARCHIVE_URL.format(folder=folder, year=year, country=country))
    if not raw:
        return pd.DataFrame()
    usecols = ["latitude", "longitude", "acq_date", "confidence", "frp", "type", "daynight"]
    df = pd.read_csv(io.BytesIO(raw), usecols=lambda c: c in usecols, low_memory=False)
    return aggregate(df, sensor, country)


def availability(key: str) -> dict:
    raw = http_get(AVAIL_URL.format(key=key))
    if not raw:
        return {}
    df = pd.read_csv(io.BytesIO(raw))
    return {r.data_id: (pd.Timestamp(r.min_date).date(), pd.Timestamp(r.max_date).date()) for r in df.itertuples()}


def tiles(cells: set, size: float = 20.0) -> list[str]:
    """Bounding boxes (size° tiles, shrunk to their cells) that cover the country's grid cells."""
    groups: dict = {}
    for gy, gx in cells:
        groups.setdefault((int(gy * CELL // size), int(gx * CELL // size)), []).append((gy, gx))
    out = []
    for cs in groups.values():
        ys, xs = [c[0] for c in cs], [c[1] for c in cs]
        out.append(f"{min(xs) * CELL:.2f},{min(ys) * CELL:.2f},{(max(xs) + 1) * CELL:.2f},{(max(ys) + 1) * CELL:.2f}")
    return out


def fetch_area(url: str, key: str, attempts: int = 5) -> bytes:
    """One FIRMS area request. Returns the CSV bytes (header only when there were no fires); raises on anything else."""
    last = ""
    for attempt in range(attempts):
        wait_for_budget(key)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
                raw = r.read()
            if raw.startswith(b"latitude"):
                return raw
            last = raw[:120].decode("utf-8", "replace").strip()
        except Exception as e:
            last = str(e)
        _budget_checked[0] = 0.0
        time.sleep(10 * (attempt + 1))
    raise FetchError(f"{url.split('/csv/')[1].split('/', 1)[1]} → {last}")


def ingest_area_year(country: str, sensor: str, year: int, cells: set, key: str, avail: dict,
                     since: dt.date | None = None) -> pd.DataFrame:
    """A year not yet published as a country file, via the area API: SP archive where processed, NRT afterwards.
    Clipped to the grid cells the country's archive files cover."""
    start, end = max(dt.date(year, 1, 1), since or dt.date(year, 1, 1)), min(dt.date.today(), dt.date(year, 12, 31))
    sp_end = avail.get(SENSORS[sensor]["sp"], (None, start - dt.timedelta(days=1)))[1]
    urls, day = [], start
    while day <= end:
        source = SENSORS[sensor]["sp"] if day <= sp_end else SENSORS[sensor]["nrt"]
        span = min(5, (end - day).days + 1)
        if source == SENSORS[sensor]["sp"]:
            span = min(span, (sp_end - day).days + 1)
        urls += [AREA_URL.format(key=key, source=source, bbox=bb, days=span, date=day.isoformat()) for bb in tiles(cells)]
        day += dt.timedelta(days=span)

    def fetch(url):
        raw = fetch_area(url, key)
        if raw.count(b"\n") > 1:
            agg = aggregate(pd.read_csv(io.BytesIO(raw), low_memory=False), sensor, country)
            return agg[agg["year"] == year]
        return None

    with ThreadPoolExecutor(max_workers=4) as pool:
        frames = [f for f in pool.map(fetch, urls) if f is not None and len(f)]
    if not frames:
        return pd.DataFrame()
    agg = (pd.concat(frames, ignore_index=True)
             .groupby(["country", "sensor", "year", "week", "gy", "gx"], as_index=False, observed=True)[["n", "frp", "n_night"]].sum())
    keep = [(y, x) in cells for y, x in zip(agg["gy"], agg["gx"])]
    return agg[keep]


def missing_dates() -> list[dict]:
    """NASA FIRMS' official table of days with missing satellite data (standard and NRT)."""
    import html as _html
    import re
    raw = http_get(MISSING_URL)
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", json.loads(raw)["html"], re.S)
    out = []
    for r in rows:
        c = [_html.unescape(re.sub(r"<[^>]+>", "", x)).strip() for x in re.findall(r"<td[^>]*>(.*?)</td>", r, re.S)]
        for kind, i in (("SP", 0), ("NRT", 2)):
            if len(c) > i + 1 and c[i] and c[i + 1] in SATELLITE_SENSOR:
                out.append({"date": c[i], "sensor": SATELLITE_SENSOR[c[i + 1]], "kind": kind})
    return out


def write_index(grid: pd.DataFrame, avail: dict | None = None):
    """countries.csv, meta.json and missing_dates.json — written after every saved country."""
    countries = (grid.groupby("country")
                 .agg(gy0=("gy", "min"), gy1=("gy", "max"), gx0=("gx", "min"), gx1=("gx", "max"))
                 .reset_index())
    countries["west"], countries["east"] = countries["gx0"] * CELL, (countries["gx1"] + 1) * CELL
    countries["south"], countries["north"] = countries["gy0"] * CELL, (countries["gy1"] + 1) * CELL
    countries[["country", "west", "south", "east", "north"]].to_csv(COUNTRIES_PATH, index=False)
    meta = {"through": dt.date.today().isoformat(), "countries": sorted(countries["country"].tolist())}
    if avail:
        # After this date the archive is near-real-time data: provisional, may still have processing gaps.
        sp = [avail[k][1] for k in ("MODIS_SP", "VIIRS_SNPP_SP") if k in avail]
        if sp:
            meta["standard_through"] = min(sp).isoformat()
    try:
        with open(MISSING_PATH, "w") as f:
            json.dump(missing_dates(), f)
    except Exception as e:
        print(f"   ! could not refresh the FIRMS missing-data table: {e}")
    with open(META_PATH, "w") as f:
        json.dump(meta, f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--countries", nargs="*", default=DEFAULT_COUNTRIES, help="FIRMS country names, e.g. United_States")
    ap.add_argument("--last-full-year", type=int, default=dt.date.today().year - 1)
    ap.add_argument("--only-current-year", action="store_true")
    ap.add_argument("--skip-existing", action="store_true", help="skip countries already in the archive")
    ap.add_argument("--update", action="store_true",
                    help="fast refresh: fetch only the days after the archive's last date for every archived country")
    args = ap.parse_args()
    if args.update:
        return update()

    os.makedirs(DATA_DIR, exist_ok=True)
    existing = pd.read_csv(GRID_PATH) if os.path.exists(GRID_PATH) else pd.DataFrame()
    key = settings.FIRMS_API_KEY
    avail = availability(key)
    cur_year = dt.date.today().year

    for country in args.countries:
        if args.skip_existing and not existing.empty and country in set(existing["country"]):
            print(f"\n== {country} (already in archive, skipped)")
            continue
        print(f"\n== {country}")
        parts = []
        if not args.only_current_year:
            for sensor, meta in SENSORS.items():
                for year in range(meta["first"], args.last_full_year + 1):
                    try:
                        agg = ingest_year_file(country, sensor, year)
                    except FetchError as e:
                        print(f"   ✗ {e} — retry later")
                        parts = None
                        break
                    if agg.empty and year >= args.last_full_year:
                        continue  # not published yet — fetched through the area API below
                    print(f"   {sensor} {year}: {int(agg['n'].sum()) if len(agg) else 0:>8,} detections")
                    parts.append(agg)
                if parts is None:
                    break
            if parts is None:
                print(f"   ✗ {country} not saved")
                continue
            hist = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
        else:
            hist = existing[(existing["country"] == country) & (existing["year"] < cur_year)]
            hist = hist[~hist.set_index(["sensor", "year"]).index.isin(
                [(s, y) for s in SENSORS for y in range(args.last_full_year, cur_year)])]
        if hist.empty:
            print("   no archive data — check the FIRMS country name (underscores for spaces)")
            continue

        cells = set(zip(hist["gy"], hist["gx"]))
        have = set(zip(hist["sensor"], hist["year"]))
        area_parts, failed = [], False
        for sensor in SENSORS:
            for year in range(args.last_full_year, cur_year + 1):
                if (sensor, year) in have and year < cur_year:
                    continue
                try:
                    agg = ingest_area_year(country, sensor, year, cells, key, avail)
                except FetchError as e:
                    print(f"   ✗ {sensor} {year}: {e}")
                    failed = True
                    break
                print(f"   {sensor} {year}: {int(agg['n'].sum()) if len(agg) else 0:>8,} detections (area API)")
                area_parts.append(agg)
        parts = [hist] + area_parts

        if failed:
            print(f"   ✗ {country} not saved — FIRMS requests kept failing; re-run to fill the gap")
            continue
        new = pd.concat(parts, ignore_index=True)
        if not existing.empty:
            existing = existing[existing["country"] != country]
        existing = pd.concat([existing, new], ignore_index=True)
        existing.to_csv(GRID_PATH + ".part", index=False, compression="gzip")
        os.replace(GRID_PATH + ".part", GRID_PATH)  # atomic: readers never see a half-written archive
        write_index(existing, avail)
        print(f"   saved · {len(new):,} grid-weeks")

    write_index(existing, avail)
    print(f"\nDone → {GRID_PATH}")


def update():
    """Incremental refresh: re-fetch from the start of the week before the archive's `through` date to today,
    replace those weeks, keep everything older. Typically a few hundred requests and a few minutes."""
    if not os.path.exists(GRID_PATH) or not os.path.exists(META_PATH):
        sys.exit("No archive yet — run a full ingest first.")
    with open(META_PATH) as f:
        meta = json.load(f)
    through = dt.date.fromisoformat(meta["through"])
    today = dt.date.today()
    # Restart at the beginning of the (fixed 52-week) week containing through − 7 days: NRT data for the last
    # days is revised, and partial weeks must be rebuilt whole.
    ref = through - dt.timedelta(days=7)
    sw = int(week_of_year(ref.timetuple().tm_yday))
    since = dt.date(ref.year, 1, 1) + dt.timedelta(days=(sw - 1) * 7)
    print(f"Updating archive {through} → {today}, rebuilding from {since} (week {sw} of {ref.year})")

    grid = pd.read_csv(GRID_PATH)
    key, avail = settings.FIRMS_API_KEY, availability(settings.FIRMS_API_KEY)
    stale = (grid["year"] > since.year) | ((grid["year"] == since.year) & (grid["week"] >= sw))
    keep, fresh, failed = [grid[~stale]], [], []
    for country in sorted(grid["country"].unique()):
        hist = grid[(grid["country"] == country) & ~stale]
        cells = set(zip(hist["gy"], hist["gx"]))
        try:
            for sensor in SENSORS:
                for year in range(since.year, today.year + 1):
                    agg = ingest_area_year(country, sensor, year, cells, key, avail, since=since)
                    print(f"   {country} {sensor} {year}: {int(agg['n'].sum()) if len(agg) else 0:,} detections")
                    fresh.append(agg)
        except FetchError as e:
            print(f"   ✗ {country}: {e} — keeping its previous data")
            failed.append(country)
            keep.append(grid[(grid["country"] == country) & stale])
            fresh = [f for f in fresh if f.empty or (f["country"] != country).all()]
    out = pd.concat(keep + fresh, ignore_index=True)
    out.to_csv(GRID_PATH + ".part", index=False, compression="gzip")
    os.replace(GRID_PATH + ".part", GRID_PATH)
    if not failed:
        write_index(out, avail)  # advances `through`, refreshes the missing-data table
    print(f"Done → through {today if not failed else through}" + (f" (failed: {', '.join(failed)})" if failed else ""))


if __name__ == "__main__":
    main()
