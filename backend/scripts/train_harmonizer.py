"""
Train FireLens' MODIS ↔ VIIRS harmonization model on the 2012–present overlap.

Target  : MODIS detections in a 0.25° cell-week (Terra + Aqua, 1 km)
Features: VIIRS S-NPP detections and FRP in the same cell-week, mean FRP per VIIRS detection
          (a proxy for fire size/type: small crop burns vs. large forest fronts), the night share of VIIRS
          detections (VIIRS finds ~3× MODIS by day, ~17× at night), latitude, seasonality (week of year),
          and the cell's long-run VIIRS/MODIS ratio from training years.

Validation is out-of-time: train on 2012–2021, test on 2022 onward, and compare against the
flat-ratio method (VIIRS ÷ α) most harmonization attempts use. The final model is refit on all overlap
years and saved with its per-cell ratios; estimates are made at query time (app/services/harmonizer_model.py).

Usage: python -m scripts.train_harmonizer [--max-rows 4000000]
"""
import argparse
import json
import os
import sys

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, r2_score

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.services import archive_store as store  # noqa: E402
from app.services.harmonizer_model import FEATURES, MODEL_PATH, add_features  # noqa: E402

REPORT_PATH = os.path.join(store.DATA_DIR, "harmonizer_report.json")
OVERLAP_START, TEST_START = 2012, 2022


def cell_weeks() -> pd.DataFrame:
    """One row per cell-week of the overlap with MODIS and S-NPP side by side, plus the cell's country."""
    if store.is_global():
        import duckdb
        src = f"read_parquet('{store.TILES_DIR}/*/*/*.parquet', hive_partitioning = true)"
        with duckdb.connect() as con:
            df = con.execute(f"""
                SELECT gy, gx, year, week,
                       sum(n) FILTER (WHERE sensor = 'M')        AS m_n,
                       sum(frp) FILTER (WHERE sensor = 'M')      AS m_frp,
                       sum(n) FILTER (WHERE sensor = 'V')        AS v_n,
                       sum(frp) FILTER (WHERE sensor = 'V')      AS v_frp,
                       sum(n_night) FILTER (WHERE sensor = 'V')  AS v_n_night
                FROM {src}
                WHERE year >= {OVERLAP_START} AND sensor IN ('M', 'V')
                GROUP BY gy, gx, year, week""").df().fillna(0)
        c = store.cells()
        df = df.merge(c, on=["gy", "gx"], how="left")
        df["country"] = df["country"].fillna("Ocean")
    else:
        g = store.grid()
        g = g[(g["year"] >= OVERLAP_START) & g["sensor"].isin(["M", "V"])]
        p = g.pivot_table(index=["country", "gy", "gx", "year", "week"], columns="sensor",
                          values=["n", "frp", "n_night"], aggfunc="sum", fill_value=0, observed=True)
        p.columns = [f"{'m' if s == 'M' else 'v'}_{v}" for v, s in p.columns]
        for col in ("m_n", "m_frp", "v_n", "v_frp", "v_n_night"):
            if col not in p.columns:
                p[col] = 0
        df = p.reset_index()
    # Only country-years where both sensors reported, so a missing sensor-year is never read as "no fire".
    both = df.groupby(["country", "year"])[["m_n", "v_n"]].transform("sum")
    df = df[(both["m_n"] > 0) & (both["v_n"] > 0)]
    return df[(df["m_n"] > 0) | (df["v_n"] > 0)]


def cell_ratios(train: pd.DataFrame, prior: float, k: float = 20.0) -> pd.Series:
    """VIIRS/MODIS ratio per cell, shrunk towards the global ratio (k pseudo-detections)."""
    s = train.groupby(["gy", "gx"])[["m_n", "v_n"]].sum()
    return (s["v_n"] + k * prior) / (s["m_n"] + k)


def fit(train: pd.DataFrame) -> HistGradientBoostingRegressor:
    model = HistGradientBoostingRegressor(loss="poisson", max_iter=400, learning_rate=0.06,
                                          max_leaf_nodes=48, min_samples_leaf=40, l2_regularization=1.0,
                                          random_state=7)
    model.fit(train[FEATURES], train["m_n"])
    return model


def region_week_metrics(df: pd.DataFrame, pred_col: str) -> dict:
    """Metrics on country-week totals — the scale the burning calendar is read at."""
    t = df.groupby(["country", "year", "week"])[["m_n", pred_col]].sum()
    return {"r2": round(float(r2_score(t["m_n"], t[pred_col])), 3),
            "mae": round(float(mean_absolute_error(t["m_n"], t[pred_col])), 2),
            "bias_pct": round(float((t[pred_col].sum() / max(1, t["m_n"].sum()) - 1) * 100), 1)}


def importance(model, df: pd.DataFrame) -> dict:
    """Increase in MAE when each feature is shuffled."""
    rng = np.random.default_rng(0)
    base = mean_absolute_error(df["m_n"], model.predict(df[FEATURES]))
    out = {}
    for f in FEATURES:
        x = df[FEATURES].copy()
        x[f] = rng.permutation(x[f].to_numpy())
        out[f] = round(float(mean_absolute_error(df["m_n"], model.predict(x)) - base), 4)
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-rows", type=int, default=4_000_000, help="subsample training cell-weeks above this")
    args = ap.parse_args()

    cw = cell_weeks()
    print(f"overlap cell-weeks: {len(cw):,} across {cw['country'].nunique()} countries")
    train, test = cw[cw["year"] < TEST_START], cw[cw["year"] >= TEST_START]
    alpha = train["v_n"].sum() / max(1, train["m_n"].sum())
    ratios = cell_ratios(train, alpha)
    fit_rows = train.sample(args.max_rows, random_state=1) if len(train) > args.max_rows else train
    model = fit(add_features(fit_rows, ratios, alpha))
    test_f = add_features(test, ratios, alpha)
    test_f["pred_model"] = model.predict(test_f[FEATURES])
    test_f["pred_flat"] = test_f["v_n"] / alpha
    test_f["pred_lit"] = test_f["v_n"] / 4.2

    report = {
        "scope": "global" if store.is_global() else "countries",
        "countries": int(cw["country"].nunique()),
        "train_years": f"{OVERLAP_START}–{TEST_START - 1}",
        "test_years": f"{TEST_START}–{int(test['year'].max())}",
        "cell_weeks_train": int(len(train)), "cell_weeks_test": int(len(test)),
        "global_alpha": round(float(alpha), 2),
        "features": FEATURES,
        "test": {
            "gradient_boosting": region_week_metrics(test_f, "pred_model"),
            "flat_ratio_learned": region_week_metrics(test_f, "pred_flat"),
            "flat_ratio_4_2": region_week_metrics(test_f, "pred_lit"),
        },
        "per_country_test": {},
    }
    top = test_f.groupby("country")["m_n"].sum().sort_values(ascending=False).head(25).index
    for c in top:
        sub = test_f[test_f["country"] == c]
        report["per_country_test"][c] = {"model": region_week_metrics(sub, "pred_model"),
                                         "flat": region_week_metrics(sub, "pred_flat")}
    print(json.dumps(report["test"], indent=2))

    # Refit on every overlap year; save the model with the ratios it needs at query time.
    alpha_all = cw["v_n"].sum() / max(1, cw["m_n"].sum())
    ratios_all = cell_ratios(cw, alpha_all)
    full = cw.sample(args.max_rows, random_state=2) if len(cw) > args.max_rows else cw
    full = add_features(full, ratios_all, alpha_all)
    model = fit(full)
    report["final_alpha"] = round(float(alpha_all), 2)
    report["feature_importance"] = importance(model, full.sample(min(len(full), 60000), random_state=1))
    joblib.dump({"model": model, "alpha": float(alpha_all), "ratios": ratios_all.astype("float32")}, MODEL_PATH)
    with open(REPORT_PATH, "w") as f:
        json.dump(report, f, indent=2)
    print(f"saved model → {MODEL_PATH}\nreport → {REPORT_PATH}")
    if store.is_global():
        from scripts.ingest_global import compact
        compact()  # re-write the tiles' stored estimates with the new model


if __name__ == "__main__":
    main()
