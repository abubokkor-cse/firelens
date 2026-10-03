"""
Harmonized 2000–present fire record for an area of interest, built from the FIRMS archive.

Harmonization (MODIS-equivalent units):
  • 2000–2011  MODIS observed (Terra; Terra + Aqua from mid-2002).
  • 2012 →     VIIRS S-NPP converted to MODIS-equivalent detections by the trained model (`mhat`,
               see scripts/train_harmonizer.py; VIIRS ÷ α when no model is present), then scaled by a
               local factor k so the AOI's VIIRS-derived record matches its own MODIS record over the
               stable calibration years. VIIRS is used after 2012 because it is continuous and stable,
               whereas MODIS has outage years and orbital drift and will end with Terra/Aqua.
  • FRP follows the same pattern with a local FRP factor β.
  • QA: years where MODIS under-detects are excluded from calibration.

  • Data gaps: FIRMS' official missing-data table. MODIS weeks are scaled for missing Terra/Aqua days; S-NPP weeks
    with ≥ 3 missing days use NOAA-20 (scaled to S-NPP), else MODIS. NOAA-20 also continues the record after
    S-NPP's end of life. Weeks after the standard archive ends are flagged provisional (NRT).

Baseline: 2003–2025 (full Terra + Aqua years), per week with a ±1-week window. Following the MODIS user guide
(time series binned shorter than ~8 days are biased), percentiles, z-scores and alerts use trailing 2-week means.
"""
import datetime as dt
import glob
import json
import os
from typing import Optional

import numpy as np
import pandas as pd

from app.models.schemas import BoundingBox
from app.services import archive_store as store, harmonizer_model

FIRST_YEAR, VIIRS_START = 2000, 2012
BASE_START, BASE_END = 2003, 2025
CALIB_YEARS = range(2012, 2020)  # before MODIS orbital drift; outage years are excluded separately
MODIS_START_WEEK_2000 = 44       # MODIS science data begin 2000-11-01
WEEKS = store.WEEKS
MONTH_OF_WEEK = np.array([(dt.date(2001, 1, 1) + dt.timedelta(days=(w - 1) * 7 + 3)).month for w in range(1, 53)])


def _report() -> dict:
    p = os.path.join(store.DATA_DIR, "harmonizer_report.json")
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    return {}


def last_complete_week(today: Optional[dt.date] = None) -> tuple[int, int]:
    today = today or dt.date.today()
    w = int(store.week_of_year(today.timetuple().tm_yday)) - 1
    if w < 1:
        return today.year - 1, WEEKS
    return today.year, w


QUALITY = {0: "OK", 1: "ADJUSTED", 2: "NOAA20", 3: "MODIS", 4: "GAP"}


def _week_missing(days: set, years: np.ndarray) -> np.ndarray:
    """Count official missing days per (year, fixed 52-week)."""
    out = np.zeros((len(years), WEEKS))
    y0 = int(years[0])
    for d in days:
        i = d.year - y0
        if 0 <= i < len(years):
            out[i, int(store.week_of_year(d.timetuple().tm_yday)) - 1] += 1
    return out


class FireRecord:
    def __init__(self, rows: pd.DataFrame, cur_year: int, cur_week: int, standard_through: Optional[dt.date] = None,
                 through: Optional[dt.date] = None):
        self.cur_year, self.cur_week, self.through = cur_year, cur_week, through
        self.live = None  # set by build() when the newest days came from FIRMS near-real-time data
        self.years = np.arange(FIRST_YEAR, cur_year + 1)
        Y, W = len(self.years), WEEKS
        z = lambda: np.zeros((Y, W))
        self.m, self.mf, self.v, self.vf, self.j, self.jf = z(), z(), z(), z(), z(), z()
        self.mhat, self.v_unmodeled = z(), z()
        has_mhat = "mhat" in rows.columns
        if not rows.empty:
            if has_mhat and "v_unmodeled" not in rows.columns:
                # Rows ingested after the last training run have no model estimate yet; they fall back to VIIRS ÷ α.
                miss = rows["mhat"].isna() & (rows["sensor"] == "V")
                rows = rows.assign(v_unmodeled=np.where(miss, rows["n"], 0), mhat=rows["mhat"].fillna(0))
            agg = {"n": "sum", "frp": "sum", **({"mhat": "sum", "v_unmodeled": "sum"} if has_mhat else {})}
            t = rows.groupby(["sensor", "year", "week"], observed=True).agg(agg).reset_index()
            t = t[(t["year"] >= FIRST_YEAR) & (t["year"] <= cur_year)]
            yi, wi = t["year"].to_numpy() - FIRST_YEAR, t["week"].to_numpy() - 1
            sen = t["sensor"].astype(str).to_numpy()
            for code, n_arr, f_arr in (("M", self.m, self.mf), ("V", self.v, self.vf), ("J", self.j, self.jf)):
                k = sen == code
                np.add.at(n_arr, (yi[k], wi[k]), t["n"].to_numpy()[k])
                np.add.at(f_arr, (yi[k], wi[k]), t["frp"].to_numpy()[k])
            if has_mhat:
                k = sen == "V"
                np.add.at(self.mhat, (yi[k], wi[k]), t["mhat"].to_numpy()[k])
                np.add.at(self.v_unmodeled, (yi[k], wi[k]), t["v_unmodeled"].to_numpy()[k])

        # Official FIRMS missing-data table → missing days per week and sensor.
        md = store.missing_days()
        self.miss_terra = _week_missing(md.get("M-Terra", set()), self.years)
        self.miss_aqua = _week_missing(md.get("M-Aqua", set()), self.years)
        self.miss_v = _week_missing(md.get("V", set()), self.years)
        self.miss_j = _week_missing(md.get("J", set()), self.years)

        self.valid = np.ones((Y, W), bool)
        self.valid[0, :MODIS_START_WEEK_2000 - 1] = False
        self.valid[-1, cur_week:] = False
        # A sensor-year with no detections at all where the other years burn is a data gap, not a quiet year.
        yr_m, yr_v = self.m.sum(1), self.v.sum(1) + self.j.sum(1)
        typical = np.median(yr_m[yr_m > 0]) if (yr_m > 0).any() else 0
        for i, y in enumerate(self.years):
            if typical > 20 and y < cur_year and 0 < i:
                if (y < VIIRS_START and yr_m[i] == 0) or (y >= VIIRS_START and yr_v[i] == 0):
                    self.valid[i] = False

        # MODIS corrected for official missing days: each of Terra/Aqua supplies roughly half the weekly
        # observations (Terra alone before Aqua, launched May 2002).
        both = (self.years >= 2003)[:, None]
        seen = np.where(both, 1 - (self.miss_terra + self.miss_aqua) / 14.0, 1 - self.miss_terra / 7.0)
        self.m_adj = np.where(seen > 0.05, self.m / np.maximum(seen, 0.05), 0.0)
        self.mf_adj = np.where(seen > 0.05, self.mf / np.maximum(seen, 0.05), 0.0)
        self.q = np.zeros((Y, W), int)
        pre = ~(self.years >= VIIRS_START)[:, None]
        self.q[pre & (seen < 1)] = 1
        self.valid[pre & (seen < 0.5)] = False

        self._calibrate(has_mhat)
        self.viirs_era = (self.years >= VIIRS_START)[:, None] & self.valid
        if cur_week < W and self.years[-1] >= VIIRS_START:
            self.viirs_era[-1, cur_week] = True  # the week in progress ("this week so far") is on the same scale

        # VIIRS record in MODIS-equivalent units: S-NPP, NOAA-20 when S-NPP is missing (and after it retires),
        # MODIS when neither VIIRS is available.
        snpp_seen = 1 - self.miss_v / 7.0
        v_eq = np.where(snpp_seen > 0, self.vhat / np.maximum(snpp_seen, 1e-9), 0.0) * self.k
        vf_eq = np.where(snpp_seen > 0, self.vf / np.maximum(snpp_seen, 1e-9), 0.0) * self.beta
        j_ok = (self.j > 0) & (self.miss_j < 3)
        j_eq = self.j * self.rho_j * self.hat_per_v * self.k
        # Backup for gaps missing from the official table (e.g. very recent NRT interruptions). The two VIIRS
        # satellites check each other; MODIS is only a witness when S-NPP is essentially empty, because MODIS and
        # VIIRS legitimately disagree by season (e.g. Amazon wet season) and that is not a data gap.
        j_says = j_ok & (self.j * self.rho_j >= 20) & (self.v < 0.25 * self.j * self.rho_j)
        m_says = (self.j == 0) & (self.m_adj >= 20) & (self.v * self.k * self.hat_per_v < 0.05 * self.m_adj)
        snpp_bad = (self.miss_v >= 3) | j_says | m_says
        use_j = self.viirs_era & snpp_bad & j_ok
        modis_ok = seen >= 0.5  # MODIS observed the week (zero detections is a valid "no fire")
        use_m = self.viirs_era & snpp_bad & ~j_ok & modis_ok
        self.h = np.where(self.viirs_era, v_eq, self.m_adj)
        self.hf = np.where(self.viirs_era, vf_eq, self.mf_adj)
        self.h[use_j], self.hf[use_j] = j_eq[use_j], (self.jf * self.rho_jf * self.beta)[use_j]
        self.h[use_m], self.hf[use_m] = self.m_adj[use_m], self.mf_adj[use_m]
        self.q[self.viirs_era & ~snpp_bad & (self.miss_v > 0)] = 1
        self.q[use_j], self.q[use_m] = 2, 3
        lost = self.viirs_era & snpp_bad & ~j_ok & ~modis_ok
        self.q[lost] = 4
        self.valid[lost] = False
        self.viirs_gaps = [(int(self.years[i]), int(w) + 1) for i, w in zip(*np.where(use_j | use_m | lost))]

        # Weeks after the standard (science-quality) archive ends are near-real-time: provisional.
        self.provisional = np.zeros((Y, W), bool)
        if standard_through:
            sy = standard_through.year - FIRST_YEAR
            sw = int(store.week_of_year(standard_through.timetuple().tm_yday))
            if 0 <= sy < Y:
                self.provisional[sy, sw:] = True
                self.provisional[sy + 1:] = True
            elif sy < 0:
                self.provisional[:] = True
        self.standard_through = standard_through

        # The week in progress (after the last full week) — kept aside: it is shown as "this week so far" against
        # the normal for the same number of days, but never enters the calendar statistics.
        self.partial = None
        if through and cur_week < WEEKS and through.year == cur_year:
            start = dt.date(cur_year, 1, 1) + dt.timedelta(days=cur_week * 7)
            # Complete days only: the ingest day itself is still arriving (NRT lags a few hours), so it would bias the
            # comparison low. Its detections are included in the count, which errs slightly high rather than low.
            days = min(7, (through - start).days)
            if days >= 1:
                self.partial = {"week": cur_week + 1, "start": start, "end": through - dt.timedelta(days=1), "days": days,
                                "harmonized": float(self.h[-1, cur_week]), "frp": float(self.hf[-1, cur_week])}
        self.h[~self.valid] = np.nan
        self.hf[~self.valid] = np.nan
        # The MODIS user guide warns that fire time series binned shorter than ~8 days carry severe sampling
        # biases (orbit geometry, coverage gaps), so percentiles, z-scores and alerts use a trailing 2-week mean.
        flat = self.h.reshape(-1)
        prev = np.concatenate([[np.nan], flat[:-1]])
        self.h2 = np.where(np.isnan(prev), flat, (flat + prev) / 2).reshape(Y, W)
        self._baseline()

    # ── calibration ────────────────────────────────────────────────────────────
    def _calibrate(self, has_mhat: bool):
        yr_m, yr_v = self.m_adj.sum(1), self.v.sum(1)
        ov = (self.years >= VIIRS_START) & (yr_m > 0) & (yr_v > 0) & (self.years < self.cur_year)
        self.alpha = float(yr_v[ov].sum() / yr_m[ov].sum()) if ov.any() and yr_m[ov].sum() > 0 else 4.0
        self.model_used = bool(has_mhat and self.mhat.sum() > 0)
        self.vhat = self.mhat + self.v_unmodeled / self.alpha if self.model_used else self.v / self.alpha
        sv = self.v[ov].sum()
        self.hat_per_v = float(self.vhat[ov].sum() / sv) if sv > 0 else 1.0 / self.alpha
        # NOAA-20 ↔ S-NPP: same VIIRS instrument ~50 min apart; ratio from weeks both observed fully.
        both = (self.v > 0) & (self.j > 0) & (self.miss_v == 0) & (self.miss_j == 0)
        self.rho_j = float(self.v[both].sum() / self.j[both].sum()) if self.j[both].sum() > 0 else 1.0
        self.rho_jf = float(self.vf[both].sum() / self.jf[both].sum()) if self.jf[both].sum() > 0 else 1.0
        self.j_weeks = int(both.sum())

        # Yearly MODIS-vs-VIIRS consistency: flag years where MODIS falls far below the VIIRS expectation.
        yr_hat = self.vhat.sum(1)
        ratio = np.where(yr_hat > 0, yr_m / np.maximum(yr_hat, 1e-9), np.nan)
        med = np.nanmedian(ratio[ov]) if ov.any() else 1.0
        self.modis_qa = {int(y): ("MODIS_UNDERDETECTION" if ov[i] and ratio[i] < 0.7 * med else "OK")
                         for i, y in enumerate(self.years) if ov[i]}
        calib = np.array([ov[i] and y in CALIB_YEARS and self.modis_qa.get(int(y)) == "OK" for i, y in enumerate(self.years)])
        if not calib.any():
            calib = ov & np.array([self.modis_qa.get(int(y)) == "OK" for y in self.years])
        m_c, h_c = yr_m[calib].sum(), yr_hat[calib].sum()
        self.k = float(np.clip(m_c / h_c, 0.4, 2.5)) if h_c > 0 and m_c > 0 else 1.0
        mf_c, vf_c = self.mf.sum(1)[calib].sum(), self.vf.sum(1)[calib].sum()
        self.beta = float(mf_c / vf_c) if vf_c > 0 and mf_c > 0 else 1.0
        self.calib_years = [int(y) for y in self.years[calib]]
        self.yearly_ratio = [{"year": int(y), "modis": int(yr_m[i]), "viirs": int(yr_v[i]),
                              "ratio": round(float(yr_v[i] / yr_m[i]), 2) if yr_m[i] > 0 else None,
                              "qa": self.modis_qa.get(int(y), "OK")}
                             for i, y in enumerate(self.years) if y >= VIIRS_START and yr_v[i] > 0]
        # Monthly α (VIIRS per MODIS detection) over calibration years.
        am = []
        for mo in range(1, 13):
            cols = MONTH_OF_WEEK == mo
            mm, vv = self.m[calib][:, cols].sum(), self.v[calib][:, cols].sum()
            am.append(round(float(vv / mm), 2) if mm >= 10 else None)
        self.alpha_month = am

    # ── baseline & statistics ────────────────────────────────────────────────────
    def _baseline(self):
        bi = (self.years >= BASE_START) & (self.years <= BASE_END)
        base = self.h[bi]
        self.base_years = self.years[bi]
        win = np.stack([np.roll(base, s, axis=1) for s in (-1, 0, 1)], axis=0).reshape(-1, WEEKS)
        base2 = self.h2[bi]
        self.win2 = np.stack([np.roll(base2, s, axis=1) for s in (-1, 0, 1)], axis=0).reshape(-1, WEEKS)
        with np.errstate(invalid="ignore"):
            # Weekly climatology for display; 2-week statistics for percentiles, z-scores and alerts.
            self.mean = np.nanmean(base, 0)
            self.p10, self.p50, self.p90, self.p95 = (np.nanpercentile(win, q, 0) for q in (10, 50, 90, 95))
            self.mean2 = np.nanmean(base2, 0)
            self.sd2 = np.maximum(np.nanstd(self.win2, 0), 1.0)
        self.peak_week = int(np.nanargmax(self.mean)) + 1 if np.nansum(self.mean) > 0 else 1
        self.annual_mean = float(np.nansum(self.mean))
        self.in_season = self.mean >= 0.35 * np.nanmax(self.mean) if self.annual_mean > 0 else np.zeros(WEEKS, bool)
        self.floor = max(3.0, 0.05 * float(np.nanmax(self.mean))) if self.annual_mean > 0 else 3.0
        onsets = [self.onset(self.h[i]) for i in np.where(bi)[0]]
        onsets = [o for o in onsets if o is not None]
        self.onset_median = int(np.median(onsets)) if onsets else None
        self.onset_iqr = (int(np.percentile(onsets, 25)), int(np.percentile(onsets, 75))) if onsets else None
        self.critical = self.critical_period(0.8)
        self.core = self.critical_period(0.5)

    def critical_period(self, share: float) -> Optional[dict]:
        """Shortest run of consecutive weeks (wrapping over New Year) holding `share` of the baseline annual burning."""
        m = np.nan_to_num(self.mean)
        total = m.sum()
        if total <= 0:
            return None
        ext = np.concatenate([m, m])
        cum = np.concatenate([[0.0], np.cumsum(ext)])
        best = None
        for start in range(WEEKS):
            for length in range(1, WEEKS + 1):
                if cum[start + length] - cum[start] >= share * total:
                    if best is None or length < best[1]:
                        best = (start, length)
                    break
        start, length = best
        end = (start + length - 1) % WEEKS
        got = (cum[start + length] - cum[start]) / total
        return {"start_week": start + 1, "end_week": end + 1, "weeks": length, "share": round(float(got) * 100),
                "start_date": _week_label(start + 1), "end_date": _week_label(end + 1, end=True)}

    def onset(self, row: np.ndarray) -> Optional[int]:
        """First week cumulative burning reaches 15% of the baseline annual mean."""
        if self.annual_mean <= 0:
            return None
        c = np.nancumsum(np.nan_to_num(row))
        hit = np.where(c >= 0.15 * self.annual_mean)[0]
        return int(hit[0]) + 1 if len(hit) else None

    def percentile(self, w: int, v: float) -> float:
        """Rank of a 2-week value among 2003–2025 2-week values for the same week (±1)."""
        col = self.win2[:, w]
        col = col[~np.isnan(col)]
        return float((col < v).mean() * 100) if len(col) else 50.0

    def status(self, w: int, v: float) -> tuple[str, float, float]:
        """Classify a trailing 2-week value (see h2)."""
        z = (v - self.mean2[w]) / self.sd2[w]
        p = self.percentile(w, v)
        if p >= 95 and z > 2 and v >= self.floor:
            s = "EXTREME"
        elif p >= 90 and v >= self.floor:
            s = "HIGH"
        elif p <= 10 and self.in_season[w]:
            s = "LOW"
        else:
            s = "NORMAL"
        return s, float(z), p

    # ── outputs ────────────────────────────────────────────────────────────────
    def calendar(self) -> list[dict]:
        out = []
        for i, y in enumerate(self.years):
            weeks = []
            for w in range(WEEKS):
                if not self.valid[i, w]:
                    weeks.append({"week": w + 1, "modis_raw": 0, "viirs_raw": 0, "harmonized_count": None,
                                  "total_frp": None, "status": "NO_DATA", "z_score": 0.0, "percentile": None,
                                  "quality": QUALITY[int(self.q[i, w])] if self.q[i, w] else "NO_DATA"})
                    continue
                h = float(self.h[i, w])
                s, z, p = self.status(w, float(self.h2[i, w]))
                weeks.append({"week": w + 1, "modis_raw": int(self.m[i, w]), "viirs_raw": int(self.v[i, w]),
                              "noaa20_raw": int(self.j[i, w]),
                              "harmonized_count": round(h, 1), "total_frp": round(float(self.hf[i, w]), 1),
                              "status": s, "z_score": round(z, 2), "percentile": round(p, 1),
                              "quality": QUALITY[int(self.q[i, w])], "provisional": bool(self.provisional[i, w])})
            out.append({"year": int(y), "weeks": weeks})
        return out

    def anomalies(self, years: int = 2) -> list[dict]:
        alerts = []
        for i in range(len(self.years) - 1, max(-1, len(self.years) - 1 - years), -1):
            y = int(self.years[i])
            last = self.cur_week if y == self.cur_year else WEEKS
            on = self.onset(self.h[i][:last] if y == self.cur_year else self.h[i])
            if on and self.onset_median and self.onset_median - on >= 2:
                alerts.append(self._alert(y, on, "WARNING", "EARLY_ONSET",
                              f"Season onset in week {on}, {self.onset_median - on} weeks earlier than the "
                              f"2003–2025 median (week {self.onset_median}).", self.h[i, on - 1], on - 1))
            elif on and self.onset_median and on - self.onset_median >= 3:
                alerts.append(self._alert(y, on, "INFO", "LATE_ONSET",
                              f"Season onset in week {on}, {on - self.onset_median} weeks later than the median "
                              f"(week {self.onset_median}).", self.h[i, on - 1], on - 1))
            for w in range(last):
                v = self.h2[i, w]
                if np.isnan(v):
                    continue
                s, z, p = self.status(w, float(v))
                prov = " Provisional (near-real-time data)." if self.provisional[i, w] else ""
                if s == "EXTREME":
                    sev = "CRITICAL" if z > 3 or p >= 99 else "WARNING"
                    alerts.append(self._alert(y, w + 1, sev, "EXTREME_FIRE_SURGE",
                                  f"Harmonized detections over the 2 weeks to week {w + 1} were "
                                  f"{v / max(self.mean2[w], 1e-9):.1f}× the 2003–2025 mean "
                                  f"(z = {z:.1f}, above the {p:.0f}th percentile).{prov}", v, w))
                elif s == "LOW" and self.mean2[w] > 5:
                    gap = " Satellite data gap this fortnight — check before acting." if self.q[i, w] or (w and self.q[i, w - 1]) else ""
                    alerts.append(self._alert(y, w + 1, "INFO", "UNUSUAL_SUPPRESSION",
                                  f"In-season burning {100 * (1 - v / max(self.mean2[w], 1e-9)):.0f}% below the "
                                  f"2-week mean — rain, policy or reduced fuel.{gap}{prov}", v, w))
        alerts.sort(key=lambda a: (-a["year"], -a["week"]))
        return alerts

    def _alert(self, y, week, sev, kind, desc, v, w):
        return {"week": int(week), "year": int(y), "severity": sev, "alert_type": kind, "description": desc,
                "current_value": round(float(v), 1), "historical_mean": round(float(self.mean2[w]), 1),
                "percentile": round(self.percentile(w, float(v)), 1)}

    def outlook(self, horizon: int = 8, n_analogs: int = 5) -> dict:
        """Analog-year outlook: the past seasons that most resemble this year so far, and how they continued."""
        cy, cw = len(self.years) - 1, self.cur_week
        if cw < 3 or self.annual_mean <= 0:
            return {"available": False, "reason": "Too early in the year for an analog outlook."}
        span = min(cw, 12)
        now = np.log1p(np.nan_to_num(self.h[cy, cw - span:cw]))
        ytd_now = np.nansum(self.h[cy, :cw])
        cands = []
        for i, y in enumerate(self.years):
            if y < BASE_START or y > BASE_END:
                continue
            past = np.log1p(np.nan_to_num(self.h[i, cw - span:cw]))
            d = float(np.sqrt(np.mean((now - past) ** 2)))
            cands.append((d, i))
        cands.sort()
        chosen = cands[:n_analogs]
        weeks = [w for w in range(cw, min(WEEKS, cw + horizon))]
        if not weeks:
            return {"available": False, "reason": "End of the calendar year."}
        traj, wts = [], []
        for d, i in chosen:
            ytd = np.nansum(self.h[i, :cw])
            scale = float(np.clip(ytd_now / ytd, 0.5, 2.0)) if ytd > 0 else 1.0
            traj.append(np.nan_to_num(self.h[i, weeks]) * scale)
            wts.append(1 / (d + 0.05))
        traj, wts = np.array(traj), np.array(wts) / np.sum(wts)
        exp = (traj * wts[:, None]).sum(0)
        p90 = self.p90[weeks]
        meaningful = np.maximum(p90, self.floor)
        exceed = float(np.mean([(t > meaningful).any() for t in traj]) * 100)
        remaining = float(np.nansum(self.mean[cw:]) / self.annual_mean * 100)
        ratio_ytd = float(ytd_now / max(np.nansum(self.mean[:cw]), 1e-9))
        in_season_ahead = bool(self.in_season[weeks].any())
        level = ("HIGH" if exceed >= 60 or (ratio_ytd > 1.5 and in_season_ahead)
                 else "ELEVATED" if exceed >= 30 or (ratio_ytd > 1.15 and in_season_ahead) else "NORMAL")
        return {
            "available": True, "method": "Analog years (RMSE on log-scaled harmonized weekly record, last 12 weeks)",
            "from_week": cw + 1, "weeks": [w + 1 for w in weeks],
            "expected": [round(float(x), 1) for x in exp],
            "low": [round(float(x), 1) for x in traj.min(0)], "high": [round(float(x), 1) for x in traj.max(0)],
            "baseline_mean": [round(float(self.mean[w]), 1) for w in weeks],
            "baseline_p90": [round(float(x), 1) for x in p90],
            "analog_years": [int(self.years[i]) for _, i in chosen],
            "prob_exceed_p90": round(exceed),
            "ytd_vs_baseline": round(ratio_ytd, 2),
            "remaining_season_pct": round(remaining),
            "risk_level": level, "in_season_ahead": in_season_ahead,
        }

    def summary(self) -> dict:
        cy, w = len(self.years) - 1, self.cur_week - 1
        v, frp = float(np.nan_to_num(self.h[cy, w])), float(np.nan_to_num(self.hf[cy, w]))
        mean_frp = float(np.nanmean(self.hf[(self.years >= BASE_START) & (self.years <= BASE_END), w]))
        v2 = float(np.nan_to_num(self.h2[cy, w]))
        s, z, p = self.status(w, v2)
        mx = float(np.nanmax(self.mean)) if self.annual_mean > 0 else 0
        rel = self.mean[w] / mx if mx else 0
        before_peak = (self.peak_week - 1 - w) % WEEKS < WEEKS / 2
        season = ("Off-season" if rel < 0.2 else "Peak season" if rel >= 0.7
                  else "Building" if before_peak else "Waning")
        ytd, base_ytd = float(np.nansum(self.h[cy, :w + 1])), float(np.nansum(self.mean[:w + 1]))
        return {
            "year": int(self.cur_year), "week": int(w + 1), "week_start": _week_start(self.cur_year, w + 1),
            "harmonized_week": round(v, 1), "baseline_week_mean": round(float(self.mean[w]), 1),
            # Percent change, percentile and status compare the trailing 2 weeks with the same 2 weeks of 2003–2025.
            "harmonized_2wk": round(v2, 1), "baseline_2wk_mean": round(float(self.mean2[w]), 1),
            "delta_pct": round((v2 / self.mean2[w] - 1) * 100, 1) if self.mean2[w] >= self.floor else None,
            "quality": QUALITY[int(self.q[cy, w])], "provisional": bool(self.provisional[cy, w]),
            "frp_week_mw": round(frp, 1),
            "frp_delta_pct": round((frp / mean_frp - 1) * 100, 1) if mean_frp > 0 and self.mean[w] >= self.floor else None,
            "percentile": round(p, 1), "status": s, "z_score": round(z, 2),
            "season": season, "peak_week": self.peak_week, "peak_month": _MONTHS[MONTH_OF_WEEK[self.peak_week - 1] - 1],
            "onset_median_week": self.onset_median,
            "ytd_harmonized": round(ytd, 1), "ytd_baseline": round(base_ytd, 1),
            "ytd_delta_pct": round((ytd / base_ytd - 1) * 100, 1) if base_ytd > 0 else None,
            "this_week": self._this_week(),
        }

    def _this_week(self) -> Optional[dict]:
        """The week in progress, compared with the 2003–2025 normal for the same number of days."""
        p = self.partial
        if not p:
            return None
        w = p["week"] - 1
        expected = float(self.mean[w]) * p["days"] / 7
        return {"week": p["week"], "start": p["start"].isoformat(), "end": p["end"].isoformat(), "days": p["days"],
                "harmonized": round(p["harmonized"], 1), "frp_mw": round(p["frp"], 1),
                "expected": round(expected, 1),
                "delta_pct": round((p["harmonized"] / expected - 1) * 100, 1) if expected >= self.floor * p["days"] / 7 else None}

    def monthly(self) -> list[dict]:
        out = []
        for i, y in enumerate(self.years):
            for mo in range(1, 13):
                cols = MONTH_OF_WEEK == mo
                valid = self.valid[i, cols]
                if not valid.any():
                    continue
                out.append({"year": int(y), "month": mo,
                            "modis": int(self.m[i, cols].sum()), "viirs": int(self.v[i, cols].sum()) if y >= VIIRS_START else None,
                            "harmonized": round(float(np.nansum(self.h[i, cols])), 1)})
        return out

    def calibration(self) -> dict:
        rep = _report()
        return {
            "method": ("Gradient-boosted VIIRS→MODIS model + local factor k" if self.model_used
                       else "VIIRS ÷ α (local overlap ratio) + local factor k"),
            "alpha": round(self.alpha, 2), "k": round(self.k, 3), "beta_frp": round(self.beta, 3),
            "calibration_years": self.calib_years, "alpha_by_month": self.alpha_month,
            "viirs_gap_weeks": [{"year": y, "week": w, "filled_with": QUALITY[int(self.q[y - FIRST_YEAR, w - 1])]}
                                for y, w in self.viirs_gaps],
            "noaa20": {"snpp_per_noaa20": round(self.rho_j, 3), "overlap_weeks": self.j_weeks,
                       "note": "S-NPP ÷ NOAA-20 detections; NOAA-20 fills S-NPP gaps and continues the record "
                               "after S-NPP's end of life (anticipated October 2026)."},
            "official_missing_days": {"terra": int(self.miss_terra.sum()), "aqua": int(self.miss_aqua.sum()),
                                      "snpp": int(self.miss_v.sum()), "noaa20": int(self.miss_j.sum())},
            "standard_through": self.standard_through.isoformat() if self.standard_through else None,
            "yearly": self.yearly_ratio,
            "model": {k: rep[k] for k in ("train_years", "test_years", "test", "feature_importance", "final_alpha",
                                          "scope", "countries", "per_country_test") if k in rep},
        }

    def baseline(self) -> dict:
        r = lambda a: [round(float(x), 1) for x in np.nan_to_num(a)]
        return {"years": f"{BASE_START}–{BASE_END}", "mean": r(self.mean), "p10": r(self.p10), "p50": r(self.p50),
                "p90": r(self.p90), "peak_week": self.peak_week, "annual_mean": round(self.annual_mean, 1),
                "onset_median_week": self.onset_median, "onset_iqr": self.onset_iqr,
                "critical_period": self.critical, "core_period": self.core}


_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _week_label(week: int, end: bool = False) -> str:
    """'3 Mar'-style label for the start (or end) of a fixed 52-week calendar week."""
    d = dt.date(2001, 1, 1) + dt.timedelta(days=(week - 1) * 7 + (6 if end else 0))
    return f"{d.day} {_MONTHS[d.month - 1]}"


def _week_start(year: int, week: int) -> str:
    return (dt.date(year, 1, 1) + dt.timedelta(days=(week - 1) * 7)).isoformat()


def _weekly(rows: pd.DataFrame) -> pd.DataFrame:
    """Cell rows → sensor-week sums, with the model's MODIS-equivalent estimate for VIIRS."""
    if "mhat" not in rows.columns:
        rows = harmonizer_model.add_mhat(rows)
    # Sum in 64-bit: the tiles store 32-bit values, and 32-bit sums depend on the order the files are read in.
    rows = rows.astype({c: "float64" for c in ("frp", "mhat") if c in rows.columns})
    g = rows.groupby(["sensor", "year", "week"], observed=True)
    part = g[["n", "frp"]].sum()
    if "mhat" in rows.columns:
        part["mhat"] = g["mhat"].sum()
        part["v_unmodeled"] = rows.assign(u=np.where(rows["mhat"].isna() & (rows["sensor"] == "V"), rows["n"], 0)) \
            .groupby(["sensor", "year", "week"], observed=True)["u"].sum()
    return part.reset_index()


def weekly_rows(bbox: Optional[BoundingBox], country: Optional[str] = None,
                geometry: Optional[dict] = None) -> Optional[pd.DataFrame]:
    """Sensor-week sums for an area. Model estimates are attached per chunk and each chunk is summed right away,
    so even the whole planet is processed in bounded memory."""
    parts = [_weekly(rows) for rows in store.select_chunks(bbox, country, geometry) if not rows.empty]
    if not parts:
        return None
    return pd.concat(parts, ignore_index=True).groupby(["sensor", "year", "week"], observed=True, as_index=False) \
        .sum(numeric_only=True)


PLANET_PATH = os.path.join(store.DATA_DIR, "global_weekly.parquet")


def save_planet_weekly(rows: pd.DataFrame) -> None:
    """Keep the whole planet's sensor-week sums (a few thousand rows) next to the archive, so the Global record can
    be rebuilt — and brought up to today — without reading every tile (scripts/build_reports.py)."""
    rows.assign(through=store.through()).to_parquet(PLANET_PATH + ".part", index=False)
    os.replace(PLANET_PATH + ".part", PLANET_PATH)


PLANET_HIST_PATH = os.path.join(store.DATA_DIR, "global_weekly_hist.parquet")


def part_weekly(part: str) -> pd.DataFrame:
    """Whole-planet sensor-week sums of one part of the tiles ("hist" or "recent"), straight from the stored files."""
    import duckdb
    files = glob.glob(os.path.join(store.TILES_DIR, "ty=*", "tx=*", f"{part}_*.parquet"))
    if not files:
        return pd.DataFrame(columns=["sensor", "year", "week", "n", "frp", "mhat", "v_unmodeled"])
    with duckdb.connect() as con:
        return con.execute(f"""
            SELECT sensor, year, week, sum(n) AS n, sum(CAST(frp AS DOUBLE)) AS frp, sum(CAST(mhat AS DOUBLE)) AS mhat,
                   sum(CASE WHEN mhat IS NULL AND sensor = 'V' THEN n ELSE 0 END) AS v_unmodeled
            FROM read_parquet({files!r}) GROUP BY ALL""").df()


def save_planet_parts(recent_only: bool = False) -> None:
    """The planet table from its two parts. The hist part changes only with a new monthly archive, so the daily
    update reuses it and adds the freshly built recent part."""
    if not recent_only:
        part_weekly("hist").to_parquet(PLANET_HIST_PATH, index=False)
    hist = pd.read_parquet(PLANET_HIST_PATH)
    rows = pd.concat([hist, part_weekly("recent")], ignore_index=True)
    save_planet_weekly(rows.groupby(["sensor", "year", "week"], as_index=False).sum(numeric_only=True))


def planet_weekly() -> Optional[pd.DataFrame]:
    """The saved whole-planet sensor-week sums, if they belong to the current archive."""
    if not os.path.exists(PLANET_PATH):
        return None
    rows = pd.read_parquet(PLANET_PATH)
    if rows.empty or str(rows["through"].iloc[0]) != str(store.through()):
        return None
    return rows.drop(columns="through")


def build(bbox: Optional[BoundingBox], country: Optional[str] = None, today: Optional[dt.date] = None,
          geometry: Optional[dict] = None, live: bool = False, top: Optional[dict] = None) -> Optional[FireRecord]:
    """The harmonized record for an area. With `live`, the days after the archive's last full week are taken from
    NASA FIRMS near-real-time data for this area (services/recent.py), so the record runs to today."""
    if not store.available():
        return None
    thr = store.through()
    rows = planet_weekly() if bbox is None and not country and not geometry else None
    if rows is None:
        rows = weekly_rows(bbox, country, geometry)
    if rows is None:
        return None
    ref = dt.date.fromisoformat(thr) if thr and not today else today
    if top is None and live and ref and not today:
        from app.services import recent
        top = recent.recent(bbox, country, geometry, ref)
    if top is not None and not today:
        start = top["from"]
        first = start.year * 100 + int(store.week_of_year(start.timetuple().tm_yday))
        rows = rows[rows["year"].astype(int) * 100 + rows["week"].astype(int) < first]
        if len(top["rows"]):
            rows = pd.concat([rows, _weekly(top["rows"])], ignore_index=True)
        ref = top["to"].date()
    rows = rows.groupby(["sensor", "year", "week"], observed=True, as_index=False).sum(numeric_only=True)
    cy, cw = last_complete_week(ref)
    st = store.meta().get("standard_through")
    rec = FireRecord(rows, cy, cw, dt.date.fromisoformat(st) if st else None, ref)
    rec.live = None if top is None else {
        "archive_through": thr, "from": top["from"].isoformat(), "to": top["to"].strftime("%Y-%m-%dT%H:%MZ"),
        "detections": top["detections"], "source": "NASA FIRMS near-real-time (MODIS, VIIRS S-NPP, VIIRS NOAA-20)"}
    return rec
