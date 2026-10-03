"""
Detection-level cross-checks on live FIRMS data.

1. Corroboration — is a hotspot a real fire? A detection is
     CONFIRMED  when another satellite (MODIS Terra/Aqua, VIIRS S-NPP/NOAA-20/NOAA-21) detected fire within
                1.5 km and 12 h of it — two independent instruments agree;
     LIKELY     when only one satellite saw it but with high confidence (MODIS ≥ 80 %, VIIRS "h"),
                or the same satellite saw it again on another overpass;
     POSSIBLE   otherwise (single, nominal/low-confidence detection).
   Archive statistics additionally exclude FIRMS static/industrial sources (type ≠ 0).

2. Sensor matching — MODIS on Aqua and VIIRS on S-NPP were designed to share the ~13:30 afternoon orbit.
   Aqua has since drifted (in 2026 it passes ~2 h after S-NPP; Terra has drifted earlier), so detections
   are paired within 1.5 km on the same afternoon pass (≤ 3 h) and the measured time gap is reported.
   This shows how many fires both instruments see, how many only VIIRS resolves (small/cool fires below
   MODIS's 1 km detection limit), and how their FRP compares on the same fires.
"""
from typing import Dict, List

import numpy as np
from sklearn.neighbors import BallTree

from app.models.schemas import FireHotspot

EARTH_KM = 6371.0
RADIUS_KM = 1.5            # MODIS pixel ≈ 1 km at nadir, larger off-nadir, plus geolocation error
CORROBORATION_HOURS = 12
SAME_PASS_MIN = 180


def _platform(f: FireHotspot) -> str:
    if f.sensor == "MODIS":
        return "Aqua" if (f.satellite or "").upper().startswith("A") else "Terra"
    return {"VIIRS_NOAA20": "NOAA-20", "VIIRS_NOAA21": "NOAA-21"}.get(f.sensor, "S-NPP")


def _minutes(f: FireHotspot) -> float:
    try:
        y, m, d = (int(x) for x in f.acq_date.split("-"))
        t = int(f.acq_time or 0)
    except ValueError:
        return 0.0
    days = np.datetime64(f"{y:04d}-{m:02d}-{d:02d}", "D").astype(int)
    return days * 1440.0 + (t // 100) * 60 + t % 100


def _high_conf(f: FireHotspot) -> bool:
    if f.sensor == "MODIS":
        return (f.confidence_pct or 0) >= 80
    return (f.confidence or "").lower().startswith("h")


def analyse(fires: List[FireHotspot]) -> Dict:
    """Label every detection (in place) and return corroboration + sensor-match statistics."""
    n = len(fires)
    summary = {"CONFIRMED": 0, "LIKELY": 0, "POSSIBLE": 0}
    match = {"aqua_modis": 0, "snpp_viirs": 0, "modis_matched": 0, "viirs_matched": 0,
             "modis_matched_pct": None, "viirs_matched_pct": None, "frp_ratio_matched": None,
             "median_gap_min": None,
             "note": "Aqua MODIS vs S-NPP VIIRS on the same afternoon pass (≤ 3 h apart, ≤ 1.5 km)"}
    if n == 0:
        return {"corroboration": summary, "sensor_match": match}

    xy = np.radians([[f.latitude, f.longitude] for f in fires])
    tmin = np.array([_minutes(f) for f in fires])
    plat = np.array([_platform(f) for f in fires])
    tree = BallTree(xy, metric="haversine")
    neigh = tree.query_radius(xy, r=RADIUS_KM / EARTH_KM)

    for i, f in enumerate(fires):
        nb = neigh[i][neigh[i] != i]
        close = nb[np.abs(tmin[nb] - tmin[i]) <= CORROBORATION_HOURS * 60] if len(nb) else nb
        other = close[plat[close] != plat[i]] if len(close) else close
        revisit = close[(plat[close] == plat[i]) & (np.abs(tmin[close] - tmin[i]) > 60)] if len(close) else close
        if len(other):
            label = "CONFIRMED"
        elif _high_conf(f) or len(revisit):
            label = "LIKELY"
        else:
            label = "POSSIBLE"
        f.corroboration = label
        f.seen_by = sorted({plat[i], *plat[other].tolist()}) if len(other) else [plat[i]]
        summary[label] += 1

    # Aqua MODIS ↔ S-NPP VIIRS simultaneous matching
    aqua, snpp = np.where(plat == "Aqua")[0], np.where(plat == "S-NPP")[0]
    match["aqua_modis"], match["snpp_viirs"] = int(len(aqua)), int(len(snpp))
    if len(aqua) and len(snpp):
        vt = BallTree(xy[snpp], metric="haversine")
        hits = vt.query_radius(xy[aqua], r=RADIUS_KM / EARTH_KM)
        m_frp, v_frp, v_used, gaps = 0.0, 0.0, set(), []
        for k, idx in enumerate(hits):
            idx = snpp[idx]
            idx = idx[np.abs(tmin[idx] - tmin[aqua[k]]) <= SAME_PASS_MIN]
            if len(idx):
                gaps.append(float(np.min(np.abs(tmin[idx] - tmin[aqua[k]]))))
                match["modis_matched"] += 1
                m_frp += fires[aqua[k]].frp or 0.0
                new = [j for j in idx if j not in v_used]
                v_frp += sum(fires[j].frp or 0.0 for j in new)
                v_used.update(new)
        match["viirs_matched"] = len(v_used)
        match["modis_matched_pct"] = round(100 * match["modis_matched"] / len(aqua), 1)
        match["viirs_matched_pct"] = round(100 * len(v_used) / len(snpp), 1)
        match["frp_ratio_matched"] = round(v_frp / m_frp, 2) if m_frp > 0 else None
        match["median_gap_min"] = round(float(np.median(gaps))) if gaps else None
    return {"corroboration": summary, "sensor_match": match}
