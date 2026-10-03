"""
"Where to look now": the 0.25° cells inside an area whose last two weeks of harmonized burning stand furthest
above their own 2003–2025 normal for the same two weeks — a short list to guide monitoring within large areas.

Per cell, harmonized detections are MODIS before 2012 and the model's MODIS-equivalent VIIRS estimate from 2012
(NOAA-20 where S-NPP has nothing). The anomaly is a Poisson-style z = (current − mean) / √(mean + 1), so a jump from
2 to 12 detections is not ranked above a jump from 200 to 600.
"""
import numpy as np
import pandas as pd

from app.services import archive_store as store, harmonizer_model
from app.services.fire_record import BASE_START, BASE_END, VIIRS_START, last_complete_week


def watchlist(bbox=None, country=None, geometry=None, top: int = 10) -> dict:
    import datetime as dt
    thr = store.through()
    cy, cw = last_complete_week(dt.date.fromisoformat(thr) if thr else None)
    weeks = (max(1, cw - 1), cw)
    rows = store.select(bbox, country, geometry, weeks=weeks)
    if rows.empty:
        return {"year": cy, "weeks": list(weeks), "cells": []}
    rows = harmonizer_model.add_mhat(rows) if "mhat" not in rows.columns else rows
    m = harmonizer_model.model()
    rows = rows.assign(h=np.where(rows["sensor"] == "M", rows["n"],
                                  rows["mhat"] if "mhat" in rows.columns else rows["n"] / (m["alpha"] if m else 4.0)))
    # Per cell-year: MODIS before 2012; S-NPP estimate from 2012, NOAA-20 (≈ S-NPP) where S-NPP is empty.
    t = rows.groupby(["gy", "gx", "year", "sensor"], observed=True)["h"].sum().unstack("sensor", fill_value=0)
    for s in ("M", "V", "J"):
        if s not in t.columns:
            t[s] = 0.0
    alpha = m["alpha"] if m else 4.0
    viirs = np.where(t["V"] > 0, t["V"], t["J"] / alpha)
    yr = t.index.get_level_values("year").to_numpy()
    t["hz"] = np.where(yr < VIIRS_START, t["M"], viirs)
    t = t["hz"].unstack("year", fill_value=0)
    base_cols = [y for y in t.columns if BASE_START <= y <= BASE_END]
    if cy not in t.columns or not base_cols:
        return {"year": cy, "weeks": list(weeks), "cells": []}
    cur, mean = t[cy], t[base_cols].mean(axis=1)
    z = (cur - mean) / np.sqrt(mean + 1)
    out = pd.DataFrame({"current": cur, "mean": mean, "z": z})
    out = out[(out["current"] >= 5) & (out["z"] > 2)].sort_values("z", ascending=False).head(top)
    names = store.cells().set_index(["gy", "gx"])["country"] if store.is_global() else None
    cells = []
    for (gy, gx), r in out.iterrows():
        cells.append({"lat": round((gy + .5) * store.CELL, 3), "lon": round((gx + .5) * store.CELL, 3),
                      "current": round(float(r["current"]), 1), "baseline_mean": round(float(r["mean"]), 1),
                      "ratio": round(float(r["current"] / max(r["mean"], .5)), 1), "z": round(float(r["z"]), 1),
                      "country": str(names.get((gy, gx), "")) if names is not None else None})
    return {"year": cy, "weeks": list(weeks), "cells": cells,
            "method": "Last 2 weeks vs the same 2 weeks of 2003–2025 per 0.25° cell (harmonized detections)"}
