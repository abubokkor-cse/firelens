"""
Build the static files served from Cloudflare R2 / CDN.

    publish/
      index.json                     through date, available report slugs, archive countries
      reports/<slug>.json            /calendar/report payload for every preset and archived country
      archive/                       the aggregated archive itself — Cloud Run loads it at start-up

Usage: python -m scripts.build_reports [--out publish]
"""
import argparse
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.api.v1.calendar import report_payload  # noqa: E402
from app.models.schemas import BoundingBox  # noqa: E402
from app.services import archive_store, fire_record  # noqa: E402
from app.services.presets import PRESETS, slug  # noqa: E402

# Everything the API needs at run time. meta.json is listed last in the manifest so it acts as the commit marker.
ARCHIVE_FILES = ["weekly_grid.csv.gz", "countries.csv", "cells.parquet", "harmonizer.joblib",
                 "harmonizer_report.json", "missing_dates.json", "global_weekly.parquet", "global_weekly_hist.parquet"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="publish")
    ap.add_argument("--reports-only", action="store_true", help="build the reports and index; skip copying the archive")
    args = ap.parse_args()
    out = args.out
    os.makedirs(os.path.join(out, "reports"), exist_ok=True)
    os.makedirs(os.path.join(out, "archive"), exist_ok=True)

    areas = {name: (p["country"], p["bbox"]) for name, p in PRESETS.items()}
    for c in archive_store.countries():
        name = c["country"].replace("_", " ")
        if name not in areas:
            areas[name] = (c["country"], {k: c[k] for k in ("west", "south", "east", "north")})

    if archive_store.is_global():
        fire_record.save_planet_parts()

    built = []
    for name, (country, bb) in areas.items():
        bbox = BoundingBox(**bb) if bb else None
        if country and country not in {c["country"] for c in archive_store.countries()}:
            print(f"  – {name}: not in the archive yet")
            continue
        rec = fire_record.build(bbox, country)
        if rec is None:
            print(f"  – {name}: no data")
            continue
        body = report_payload(rec, name, bbox, country)
        with open(os.path.join(out, "reports", slug(name) + ".json"), "w") as f:
            json.dump(body, f, separators=(",", ":"))
        built.append({"name": name, "slug": slug(name), "country": country})
        print(f"  ✓ {name}")

    # "Where to look now" for the whole planet reads every tile, so it is pre-built too (countries are fast).
    from app.services.watchlist import watchlist
    with open(os.path.join(out, "reports", "global-watch.json"), "w") as f:
        json.dump(watchlist(None, None, None, 8), f, separators=(",", ":"))
    print("  ✓ Global watchlist")

    if args.reports_only:
        write_index(out, built)
        return

    files = [fn for fn in ARCHIVE_FILES if os.path.exists(os.path.join(archive_store.DATA_DIR, fn))
             and not (fn in ("weekly_grid.csv.gz", "countries.csv") and archive_store.is_global())]
    if archive_store.is_global():
        for dp, _, fs in os.walk(archive_store.TILES_DIR):
            files += [os.path.relpath(os.path.join(dp, f), archive_store.DATA_DIR) for f in fs if f.endswith(".parquet")]
    files.append("meta.json")
    manifest = []
    for rel in files:
        src, dst = os.path.join(archive_store.DATA_DIR, rel), os.path.join(out, "archive", rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        manifest.append({"path": rel, "size": os.path.getsize(src)})
    with open(os.path.join(out, "archive", "manifest.json"), "w") as f:
        json.dump({"through": archive_store.through(), "files": manifest}, f)
    # Source shards (not needed by the API), so the update jobs can extend the archive incrementally.
    shards = os.path.join(archive_store.DATA_DIR, "global_shards")
    if os.path.isdir(shards):
        os.makedirs(os.path.join(out, "archive_src"), exist_ok=True)
        names = sorted(f for f in os.listdir(shards) if f.endswith(".parquet"))
        for fn in names:
            shutil.copy2(os.path.join(shards, fn), os.path.join(out, "archive_src", fn))
        with open(os.path.join(out, "archive_src", "manifest.json"), "w") as f:
            json.dump({"files": names}, f)
    write_index(out, built)


def write_index(out: str, built: list) -> None:
    with open(os.path.join(out, "index.json"), "w") as f:
        json.dump({"through": archive_store.through(), "scope": "global" if archive_store.is_global() else "countries",
                   "reports": built,
                   "countries": [c["country"] for c in archive_store.countries()]}, f)
    print(f"{len(built)} reports → {out}/")


if __name__ == "__main__":
    main()
