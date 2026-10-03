"""
Assign every 0.25° cell in the global archive to a country (data/cells.parquet: gy, gx, country).

Borders: Natural Earth 1:50m admin-0 countries. A cell belongs to the country containing its centre; coastal
cells whose centre is at sea go to the nearest country within 0.5° (their fires are on the coast), the rest
are "Ocean" (offshore detections are already excluded by the FIRMS type filter).

Usage: python -m scripts.build_cells
"""
import glob
import json
import os
import sys
import urllib.request

import numpy as np
import pandas as pd
import shapely
from shapely.geometry import shape

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.services.archive_store import CELL, CELLS_PATH, DATA_DIR, TILES_DIR  # noqa: E402

NE_URL = "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_admin_0_countries.geojson"
NE_PATH = os.path.join(DATA_DIR, "ne_50m_admin_0_countries.geojson")
SHARDS = os.path.join(DATA_DIR, "global_shards")


def archive_cells() -> pd.DataFrame:
    import duckdb
    src = (f"read_parquet('{TILES_DIR}/*/*/*.parquet', hive_partitioning = true)"
           if glob.glob(os.path.join(TILES_DIR, "ty=*")) else f"read_parquet('{SHARDS}/*.parquet')")
    with duckdb.connect() as con:
        return con.execute(f"SELECT DISTINCT gy, gx FROM {src}").df()


def main():
    if not os.path.exists(NE_PATH):
        urllib.request.urlretrieve(NE_URL, NE_PATH)
    with open(NE_PATH) as f:
        feats = json.load(f)["features"]
    names = [f["properties"]["ADMIN"] for f in feats]
    geoms = [shape(f["geometry"]) for f in feats]
    tree = shapely.STRtree(geoms)

    cells = archive_cells()
    pts = shapely.points((cells["gx"].to_numpy() + 0.5) * CELL, (cells["gy"].to_numpy() + 0.5) * CELL)
    country = np.full(len(cells), "Ocean", dtype=object)
    pi, gi = tree.query(pts, predicate="within")
    country[pi] = np.asarray(names, dtype=object)[gi]
    sea = np.where(country == "Ocean")[0]
    if len(sea):
        pi, gi = tree.query_nearest(pts[sea], max_distance=0.5, all_matches=False)
        country[sea[pi]] = np.asarray(names, dtype=object)[gi]
    out = cells.assign(country=country)
    out.to_parquet(CELLS_PATH, index=False)
    print(f"{len(out):,} cells → {out['country'].nunique() - 1} countries, "
          f"{(out['country'] == 'Ocean').sum():,} offshore → {CELLS_PATH}")


if __name__ == "__main__":
    main()
