"""
VIIRS → MODIS-equivalent harmonization model: features shared by training (scripts/train_harmonizer.py) and
query time, so estimates are computed for whatever rows an area selects — including data added since training.
"""
import os
from functools import lru_cache
from typing import Optional

import joblib
import numpy as np
import pandas as pd

from app.services.archive_store import CELL, DATA_DIR

MODEL_PATH = os.path.join(DATA_DIR, "harmonizer.joblib")
FEATURES = ["v_n", "v_frp", "v_mean_frp", "v_night_frac", "lat", "wk_sin", "wk_cos", "cell_ratio"]


def add_features(df: pd.DataFrame, ratios: pd.Series, global_ratio: float) -> pd.DataFrame:
    """df needs v_n, v_frp, v_n_night, gy, gx, week. ratios: VIIRS/MODIS per (gy, gx)."""
    df = df.copy()
    df["v_mean_frp"] = np.where(df["v_n"] > 0, df["v_frp"] / df["v_n"].clip(lower=1), 0.0)
    # VIIRS out-detects MODIS ~3× by day but ~17× at night (VIIRS C2 user guide).
    df["v_night_frac"] = np.where(df["v_n"] > 0, df["v_n_night"] / df["v_n"].clip(lower=1), 0.0)
    df["lat"] = (df["gy"] + 0.5) * CELL
    df["wk_sin"] = np.sin(2 * np.pi * df["week"] / 52)
    df["wk_cos"] = np.cos(2 * np.pi * df["week"] / 52)
    idx = pd.MultiIndex.from_arrays([df["gy"].to_numpy(), df["gx"].to_numpy()])
    df["cell_ratio"] = ratios.reindex(idx).fillna(global_ratio).to_numpy()
    return df


@lru_cache(maxsize=1)
def _load(mtime: float) -> dict:
    return joblib.load(MODEL_PATH)


def model() -> Optional[dict]:
    """{'model', 'alpha', 'ratios'} or None when no model has been trained."""
    if not os.path.exists(MODEL_PATH):
        return None
    m = _load(os.path.getmtime(MODEL_PATH))
    return m if "ratios" in m else None


def add_mhat(rows: pd.DataFrame) -> pd.DataFrame:
    """Attach `mhat` (MODIS-equivalent detections) to VIIRS S-NPP rows; other sensors get 0."""
    m = model()
    if m is None or rows.empty:
        return rows
    rows = rows.copy()
    v = (rows["sensor"] == "V").to_numpy()
    rows["mhat"] = np.float32(0)
    if v.any():
        sub = rows.loc[v, ["gy", "gx", "week", "n", "frp", "n_night"]].rename(
            columns={"n": "v_n", "frp": "v_frp", "n_night": "v_n_night"})
        feats = add_features(sub, m["ratios"], m["alpha"])
        rows.loc[v, "mhat"] = np.clip(m["model"].predict(feats[FEATURES]), 0, None).astype("float32")
    return rows
