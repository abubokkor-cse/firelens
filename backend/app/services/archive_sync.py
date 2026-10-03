"""
Keep the local archive in step with the published copy on Cloudflare R2.

When FIRELENS_ARCHIVE_URL is set (e.g. https://data.example.com/archive), the service downloads the archive at
start-up and re-checks meta.json every few hours, so the nightly update reaches Cloud Run without a redeploy.
Without it, the archive bundled in data/ is used as-is.
"""
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from app.services import archive_store

log = logging.getLogger(__name__)
FILES = ["weekly_grid.csv.gz", "countries.csv", "harmonizer_report.json", "missing_dates.json", "meta.json"]  # meta last
OPTIONAL = {"countries.csv", "harmonizer_report.json", "missing_dates.json", "cells.parquet", "harmonizer.joblib",
            "global_weekly.parquet", "global_weekly_hist.parquet"}
CHECK_EVERY_S = 3 * 3600


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "FireLens/1.0", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def sync_once(base: str) -> bool:
    """Bring the small archive files (model, cell lookup, metadata) up to date with the publication and save its
    manifest. Tiles are NOT downloaded here: archive_store fetches the ones an area needs on first use, so a cold
    Cloud Run instance serves requests within seconds. Local tiles that changed upstream are dropped for re-fetch."""
    base = base.rstrip("/")
    remote = json.loads(_get(f"{base}/meta.json"))
    if remote.get("through") and remote.get("through") == archive_store.through() and os.path.exists(archive_store.MANIFEST_PATH):
        return False
    try:
        manifest = json.loads(_get(f"{base}/manifest.json"))
        files = manifest["files"]
    except urllib.error.HTTPError:  # older publication without a manifest
        manifest, files = None, [{"path": fn, "size": None} for fn in FILES]
    os.makedirs(archive_store.DATA_DIR, exist_ok=True)
    small = [f for f in files if not f["path"].startswith("global/")]

    def fetch(f):
        dest = os.path.join(archive_store.DATA_DIR, f["path"])
        if f["size"] is not None and os.path.exists(dest) and os.path.getsize(dest) == f["size"]:
            return
        try:
            data = _get(f"{base}/{urllib.parse.quote(f['path'], safe='/-_.~')}")
        except urllib.error.HTTPError as e:
            if e.code == 404 and f["path"] in OPTIONAL:
                return
            raise
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest + ".part", "wb") as fh:
            fh.write(data)
        os.replace(dest + ".part", dest)

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(8) as pool:
        list(pool.map(fetch, [f for f in small if f["path"] != "meta.json"]))
    # Local tiles that are gone or changed upstream are removed; they are fetched again when needed.
    sizes = {f["path"]: f["size"] for f in files}
    tiles = os.path.join(archive_store.DATA_DIR, "global")
    for dp, _, fs in os.walk(tiles):
        for fn in fs:
            full = os.path.join(dp, fn)
            rel = os.path.relpath(full, archive_store.DATA_DIR)
            if fn.endswith(".parquet") and (rel not in sizes or os.path.getsize(full) != sizes[rel]):
                os.remove(full)
    if manifest is not None:
        with open(archive_store.MANIFEST_PATH + ".part", "w") as fh:
            json.dump(manifest, fh)
        os.replace(archive_store.MANIFEST_PATH + ".part", archive_store.MANIFEST_PATH)
    fetch(next(f for f in files if f["path"] == "meta.json"))  # last: marks the update complete
    log.info("archive synced from %s (through %s, %d files listed)", base, remote.get("through"), len(files))
    return True


def start():
    base = os.environ.get("FIRELENS_ARCHIVE_URL")
    if base:
        try:
            sync_once(base)
        except Exception as e:  # keep serving the bundled archive
            log.warning("archive sync failed: %s", e)

        def loop():
            while True:
                time.sleep(CHECK_EVERY_S)
                try:
                    sync_once(base)
                except Exception as e:
                    log.warning("archive sync failed: %s", e)
        threading.Thread(target=loop, daemon=True).start()
    if archive_store.available():
        archive_store.grid()  # load into memory now, not on the first request
