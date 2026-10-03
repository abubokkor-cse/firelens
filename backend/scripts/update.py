"""
Keeps the published archive current. Run by the Cloud Run jobs (deploy_jobs.sh), or by hand.

  python -m scripts.update daily           newest fires: rebuild only the small recent part and upload it
  python -m scripts.update rebuild         NASA published a new month: move it into the main archive, retrain,
                                           rebuild everything (started by the daily job when it sees one)
  python -m scripts.update reports         weekly: rebuild every country report from the published archive
  python -m scripts.update publish <dir>   upload a build_reports output directory; unchanged files are skipped

The bucket is the source of truth: every run downloads what it needs from it and uploads only what changed.
Environment: FIRMS_API_KEY, R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_URL; for the
jobs also FIRELENS_DATA_DIR (a scratch directory) and REBUILD_JOB / JOBS_REGION.
"""
import argparse
import gzip
import hashlib
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.services import archive_store as store  # noqa: E402

DATA = store.DATA_DIR
SHARDS = os.path.join(DATA, "global_shards")
UA = {"User-Agent": "FireLens/1.0"}
SMALL = ["meta.json", "missing_dates.json", "harmonizer.joblib", "harmonizer_report.json", "cells.parquet",
         "global_weekly.parquet", "global_weekly_hist.parquet"]


def env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        sys.exit(f"{name} is not set")
    return value


# ── the bucket: public reads, signed writes (curl's built-in SigV4, as R2 speaks the S3 API) ──────────────────────
def get(path: str, dest: str | None = None) -> bytes:
    url = env("R2_PUBLIC_URL").rstrip("/") + "/" + urllib.parse.quote(path, safe="/")
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
        data = r.read()
    if dest:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest + ".part", "wb") as f:
            f.write(data)
        os.replace(dest + ".part", dest)
    return data


def fetch(pairs: list[tuple[str, str]]) -> None:
    with ThreadPoolExecutor(8) as pool:
        list(pool.map(lambda p: get(*p), pairs))


def _curl(key: str, *args: str) -> list[str]:
    url = f"{env('R2_ENDPOINT').rstrip('/')}/{env('R2_BUCKET')}/{urllib.parse.quote(key, safe='/')}"
    return ["curl", "-sS", "--aws-sigv4", "aws:amz:auto:s3", "--user",
            f"{env('R2_ACCESS_KEY_ID')}:{env('R2_SECRET_ACCESS_KEY')}", *args, url]


def s3(method: str, key: str = "", query: str = "", body: str | None = None, headers: tuple = ()) -> bytes:
    cmd = _curl(key, "-f", "--retry", "5", "--retry-all-errors", "--retry-delay", "3", "-X", method,
                *[a for h in headers for a in ("-H", h)], *(["-T", body] if body else []))
    if query:
        cmd[-1] += "?" + query
    out = subprocess.run(cmd, capture_output=True)
    if out.returncode:
        raise RuntimeError(f"{method} {key}: {out.stderr.decode()[:200]}")
    return out.stdout


def etag(key: str) -> str | None:
    """The stored object's MD5 (R2's ETag for single-part uploads), or None when it does not exist."""
    head = subprocess.run(_curl(key, "-I"), capture_output=True, text=True).stdout
    for line in head.splitlines():
        if line.lower().startswith("etag:"):
            return line.split(":", 1)[1].strip().strip('"')
    return None


def put(local: str, key: str, cache: str = "no-cache", compress: bool = False) -> bool:
    """Upload one file unless the bucket already holds the same bytes. JSON reports go up gzip-compressed."""
    data = open(local, "rb").read()
    headers = [f"Cache-Control: {cache}",
               "Content-Type: " + ("application/json" if key.endswith(".json") else "application/octet-stream")]
    if compress:
        data = gzip.compress(data, compresslevel=9, mtime=0)
        headers.append("Content-Encoding: gzip")
    if etag(key) == hashlib.md5(data).hexdigest():
        return False
    tmp = local + ".upload"
    with open(tmp, "wb") as f:
        f.write(data)
    try:
        s3("PUT", key, body=tmp, headers=tuple(headers))
    finally:
        os.remove(tmp)
    return True


def put_many(items: list[tuple], label: str) -> None:
    with ThreadPoolExecutor(8) as pool:
        sent = sum(pool.map(lambda it: put(*it), items))
    print(f"  {label}: {sent} uploaded, {len(items) - sent} unchanged", flush=True)


def listing(prefix: str) -> list[str]:
    keys, token = [], None
    while True:
        q = "list-type=2&prefix=" + urllib.parse.quote(prefix, safe="") + (f"&continuation-token={urllib.parse.quote(token, safe='')}" if token else "")
        root = ET.fromstring(s3("GET", query=q))
        ns = {"s": root.tag.split("}")[0].strip("{")}
        keys += [k.text for k in root.findall("s:Contents/s:Key", ns)]
        nxt = root.find("s:NextContinuationToken", ns)
        if nxt is None:
            return keys
        token = nxt.text


def prune(prefix: str, keep: set) -> None:
    """Delete objects under a prefix that the new manifest no longer lists (old tiles, shards moved into hist)."""
    stale = [k for k in listing(prefix) if k not in keep and not k.endswith("manifest.json")]
    with ThreadPoolExecutor(8) as pool:
        list(pool.map(lambda k: s3("DELETE", k), stale))
    print(f"  removed {len(stale)} stale objects under {prefix}")


def publish(out: str) -> None:
    """Upload a build_reports directory: reports, archive files and sources first, manifests, then meta.json and
    index.json last, so readers never see a manifest pointing at files not uploaded yet. Then prune leftovers."""
    reports = sorted(os.listdir(os.path.join(out, "reports"))) if os.path.isdir(os.path.join(out, "reports")) else []
    put_many([(os.path.join(out, "reports", f), f"reports/{f}", "public, max-age=3600, stale-while-revalidate=86400", True)
              for f in reports if f.endswith(".json")], "reports")
    for part in ("archive", "archive_src"):
        root = os.path.join(out, part)
        if not os.path.isdir(root):
            continue
        files = [os.path.relpath(os.path.join(dp, f), out) for dp, _, fs in os.walk(root) for f in fs
                 if f not in ("manifest.json", "meta.json")]
        put_many([(os.path.join(out, f), f) for f in files], part)
    for f in ("archive_src/manifest.json", "archive/manifest.json", "archive/meta.json"):
        if os.path.exists(os.path.join(out, f)):
            put(os.path.join(out, f), f)
    if os.path.exists(os.path.join(out, "index.json")):
        put(os.path.join(out, "index.json"), "index.json", "public, max-age=300")
    if os.path.exists(os.path.join(out, "archive", "manifest.json")):
        m = json.load(open(os.path.join(out, "archive", "manifest.json")))
        prune("archive/global/", {"archive/" + f["path"] for f in m["files"]})
    if os.path.exists(os.path.join(out, "archive_src", "manifest.json")):
        m = json.load(open(os.path.join(out, "archive_src", "manifest.json")))
        prune("archive_src/", {"archive_src/" + f for f in m["files"]})


# ── the three jobs ───────────────────────────────────────────────────────────────────────────────────────────────
def daily() -> None:
    """Refresh the near-real-time part (the last months), rebuild only the recent tile files and upload them."""
    from scripts.ingest_global import compact, nrt
    from app.services import fire_record
    fetch([(f"archive/{f}", os.path.join(DATA, f)) for f in SMALL])
    manifest = json.loads(get("archive/manifest.json"))
    sources = json.loads(get("archive_src/manifest.json"))["files"]
    fetch([(f"archive_src/{f}", os.path.join(SHARDS, f)) for f in sources if "_nrt_" in f])
    nrt()
    compact("recent")
    fire_record.save_planet_parts(recent_only=True)

    recent = sorted(os.path.relpath(os.path.join(dp, f), DATA) for dp, _, fs in os.walk(store.TILES_DIR)
                    for f in fs if f.startswith("recent_"))
    shards = sorted(f for f in os.listdir(SHARDS) if "_nrt_" in f)
    put_many([(os.path.join(DATA, r), f"archive/{r}") for r in recent], "recent tiles")
    put_many([(os.path.join(SHARDS, f), f"archive_src/{f}") for f in shards], "recent sources")
    for f in ("missing_dates.json", "global_weekly.parquet"):
        put(os.path.join(DATA, f), f"archive/{f}")

    sizes = {e["path"]: e["size"] for e in manifest["files"] if "/recent_" not in e["path"] and e["path"] != "meta.json"}
    for r in recent + ["missing_dates.json", "global_weekly.parquet", "meta.json"]:
        sizes[r] = os.path.getsize(os.path.join(DATA, r))
    meta = json.load(open(store.META_PATH))
    stage = os.path.join(DATA, "_stage")
    os.makedirs(stage, exist_ok=True)
    json.dump({"files": sorted(f for f in sources if "_nrt_" not in f) + shards}, open(os.path.join(stage, "src.json"), "w"))
    json.dump({"through": meta["through"], "files": [{"path": p, "size": s} for p, s in sizes.items() if p != "meta.json"]
               + [{"path": "meta.json", "size": sizes["meta.json"]}]}, open(os.path.join(stage, "manifest.json"), "w"))
    put(os.path.join(stage, "src.json"), "archive_src/manifest.json")
    put(os.path.join(stage, "manifest.json"), "archive/manifest.json")
    put(store.META_PATH, "archive/meta.json")
    prune("archive/global/", {f"archive/{p}" for p in sizes})
    prune("archive_src/", {f"archive_src/{f}" for f in json.load(open(os.path.join(stage, "src.json")))["files"]})
    print(f"daily update done: archive through {meta['through']}, standard archive through {meta['standard_through']}")

    if new_month_available(meta["standard_through"]):
        start_rebuild()


def new_month_available(standard_through: str) -> bool:
    """True when every sensor has a monthly science file newer than the current standard archive."""
    from scripts.ingest_global import NRT, drop_connection, listing as months
    try:
        latest: dict = {}
        for sensor, ym, _ in months():
            latest[sensor] = max(latest.get(sensor, ""), ym)
        drop_connection()
    except Exception as e:  # the UMD server is sometimes slow; tomorrow's run asks again
        print(f"monthly check skipped: {e}")
        return False
    ready = min(latest.values()) if len(latest) == len(NRT) else ""
    print(f"monthly files: every sensor has up to {ready or '?'}; standard archive ends {standard_through[:7]}")
    return ready > standard_through[:7].replace("-", "")


def start_rebuild() -> None:
    job, region = os.environ.get("REBUILD_JOB"), os.environ.get("JOBS_REGION")
    if not (job and region):
        print("a new month is ready — run: python -m scripts.update rebuild")
        return
    meta = "http://metadata.google.internal/computeMetadata/v1/"
    hdr = {"Metadata-Flavor": "Google"}
    project = urllib.request.urlopen(urllib.request.Request(meta + "project/project-id", headers=hdr)).read().decode()
    token = json.load(urllib.request.urlopen(urllib.request.Request(meta + "instance/service-accounts/default/token", headers=hdr)))
    req = urllib.request.Request(f"https://run.googleapis.com/v2/projects/{project}/locations/{region}/jobs/{job}:run",
                                 data=json.dumps({"overrides": {"containerOverrides": [
                                     {"args": ["-m", "scripts.update", "rebuild"]}]}}).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {token['access_token']}", "Content-Type": "application/json"})
    urllib.request.urlopen(req)
    print(f"a new month is ready — started {job}")


def rebuild() -> None:
    """Full rebuild: add the new monthly files, move them into the main archive, retrain, rebuild every report."""
    from scripts import build_cells, build_reports, train_harmonizer
    from scripts.ingest_global import compact, listing as months, nrt, process
    fetch([(f"archive/{f}", os.path.join(DATA, f)) for f in SMALL])
    sources = json.loads(get("archive_src/manifest.json"))["files"]
    fetch([(f"archive_src/{f}", os.path.join(SHARDS, f)) for f in sources])
    todo = [j for j in months() if not os.path.exists(os.path.join(SHARDS, f"{j[0]}_{j[1]}.parquet"))]
    for job in todo:  # any failure stops here, before anything is published
        print("  " + process(*job), flush=True)
    nrt()
    compact("all")
    build_cells.main()
    sys.argv = ["train_harmonizer"]
    train_harmonizer.main()  # retrains and rewrites the tiles' stored estimates
    out = os.path.join(DATA, "_publish")
    sys.argv = ["build_reports", "--out", out]
    build_reports.main()
    publish(out)


def reports() -> None:
    """Weekly: rebuild every country report and the Global watchlist from the published archive."""
    from scripts import build_reports
    fetch([(f"archive/{f}", os.path.join(DATA, f)) for f in SMALL])
    manifest = json.loads(get("archive/manifest.json"))
    fetch([(f"archive/{e['path']}", os.path.join(DATA, e["path"])) for e in manifest["files"] if e["path"].startswith("global/")])
    out = os.path.join(DATA, "_publish")
    sys.argv = ["build_reports", "--out", out, "--reports-only"]
    build_reports.main()
    publish(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["daily", "rebuild", "reports", "publish"])
    ap.add_argument("dir", nargs="?", default="publish", help="for publish: the build_reports output directory")
    args = ap.parse_args()
    {"daily": daily, "rebuild": rebuild, "reports": reports, "publish": lambda: publish(args.dir)}[args.mode]()


if __name__ == "__main__":
    main()
