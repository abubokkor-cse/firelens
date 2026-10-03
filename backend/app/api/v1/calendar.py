import datetime as dt
import gzip
import hashlib
import json
from collections import OrderedDict
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.models.schemas import AnomalyAlert, BoundingBox, BurningCalendarResponse
from app.core.config import settings
from app.services import archive_store, fire_record, harmonizer_model, recent

router = APIRouter(prefix="/calendar", tags=["Burning Calendar"])

_cache: "OrderedDict[tuple, fire_record.FireRecord]" = OrderedDict()


def record_for(bbox: Optional[BoundingBox], country: Optional[str] = None,
               geometry: Optional[dict] = None, live: bool = False) -> fire_record.FireRecord:
    """Harmonized record for a bbox (or a whole ingested country); 404 when the AOI is outside the archive.
    `live` tops the record up to today from FIRMS near-real-time data; the record is rebuilt whenever that top-up
    is refreshed (every 30 minutes for an area)."""
    if not archive_store.available():
        raise HTTPException(status_code=503, detail="Fire archive not built yet — run `python -m scripts.ingest_archive`.")
    key = (country, None if bbox is None else tuple(round(v, 3) for v in (bbox.west, bbox.south, bbox.east, bbox.north)),
           archive_store.version(),
           hashlib.md5(json.dumps(geometry, sort_keys=True).encode()).hexdigest() if geometry else None,
           None)
    top = None
    if live and archive_store.through():
        top = recent.recent(bbox, country, geometry, dt.date.fromisoformat(archive_store.through()))
        key = key[:-1] + (top["fetched"] if top else None,)
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]
    if bbox is not None and not country and archive_store.coverage(bbox) < 0.02:
        names = ", ".join(c["country"].replace("_", " ") for c in archive_store.countries())
        raise HTTPException(status_code=404, detail=f"This area is outside the ingested FIRMS archive. Covered: {names}.")
    rec = fire_record.build(bbox, country, geometry=geometry, top=top)
    if rec is None:
        raise HTTPException(status_code=404, detail="No archived detections for this area.")
    _cache[key] = rec
    if len(_cache) > 48:
        _cache.popitem(last=False)
    return rec


@router.post("/generate", response_model=BurningCalendarResponse)
def generate_burning_calendar(
    bbox: BoundingBox,
    aoi_name: str = Query("Selected Region"),
    start_year: int = Query(2000, ge=2000, le=2026),
    end_year: int = Query(2026, ge=2000, le=2026),
):
    """
    52-week × 2000–present burning calendar for the AOI, harmonized to MODIS-equivalent detections
    from the NASA FIRMS MODIS C6.1 and VIIRS S-NPP 375 m archives.
    """
    rec = record_for(bbox)
    cal = [y for y in rec.calendar() if start_year <= y["year"] <= end_year]
    b = rec.baseline()
    return BurningCalendarResponse(aoi_name=aoi_name, bbox=bbox, start_year=start_year, end_year=end_year,
                                   baseline_peak_week=b["peak_week"], baseline_annual_mean=b["annual_mean"],
                                   calendar=cal)


@router.post("/anomalies", response_model=List[AnomalyAlert])
def get_critical_anomalies(bbox: BoundingBox, aoi_name: str = Query("Selected Region")):
    """
    Weeks of the current and previous year that depart from the 2003–2025 baseline:
    early/late season onset, extreme surges (≥95th percentile, z > 2) and in-season suppression.
    """
    return record_for(bbox).anomalies()


class AOIRequest(BaseModel):
    bbox: Optional[BoundingBox] = None
    geometry: Optional[dict] = Field(None, description="GeoJSON Polygon/MultiPolygon; cells outside it are excluded")


@router.post("/report")
def get_aoi_report(
    aoi: Optional[AOIRequest] = None,
    aoi_name: str = Query("Selected Region"),
    country: Optional[str] = Query(None, description="Ingested FIRMS country name, e.g. Bangladesh"),
    live: bool = Query(True, description="Top the record up to today from FIRMS near-real-time data"),
):
    """
    Everything the dashboard needs for one AOI in a single call: harmonized calendar, weekly baseline,
    anomalies, analog-year outlook, current-week summary, monthly series and calibration details.
    Body: {"bbox": {...}, "geometry": GeoJSON (optional)}. Send no body for all ingested countries.
    """
    bbox, geometry = (aoi.bbox, aoi.geometry) if aoi else (None, None)
    if geometry is not None and bbox is None:
        raise HTTPException(status_code=422, detail="Send a bbox together with the geometry.")
    # Every area is brought up to today from FIRMS; the pre-built report is used when the archive is already
    # current. The whole planet needs the saved planet table, so a fresh instance never reads every tile for it.
    planet = bbox is None and not country
    live = live and _behind() and not (planet and archive_store.remote_tiles() and fire_record.planet_weekly() is None)
    if not live:
        prebuilt = _prebuilt(aoi_name, bbox, country, geometry)
        if prebuilt is not None:
            return prebuilt
    return report_payload(record_for(bbox, country, geometry, live), aoi_name, bbox, country, geometry)


def _behind() -> bool:
    """True when the newest days can be refreshed from FIRMS. Always, when a key is configured: even an archive
    updated today was fetched hours ago, and the refresh (every 30 minutes per area) keeps it to the hour."""
    return bool(settings.FIRMS_API_KEY) and bool(archive_store.through())


_prebuilt_cache: dict = {}


def _prebuilt(aoi_name: str, bbox: Optional[BoundingBox], country: Optional[str], geometry: Optional[dict]):
    """When running from the published archive, Global, whole countries and preset areas are answered with the
    report built nightly (identical numbers) instead of being recomputed — the whole planet would otherwise need
    every tile on a cold instance. Drawn and uploaded areas are always computed."""
    import os
    import urllib.request
    from app.services.presets import PRESETS, slug
    base = os.environ.get("FIRELENS_ARCHIVE_URL", "").rstrip("/")
    if not base or geometry is not None or not archive_store.remote_tiles():
        return None
    preset = PRESETS.get(aoi_name)
    if country:
        name = country.replace("_", " ")
    elif bbox is None:
        name = "Global"
    elif preset and preset["bbox"] and all(abs(getattr(bbox, k) - preset["bbox"][k]) < 1e-6 for k in preset["bbox"]):
        name = aoi_name
    else:
        return None
    key = (slug(name), archive_store.through())
    if key not in _prebuilt_cache:
        url = base.rsplit("/archive", 1)[0] + f"/reports/{slug(name)}.json"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "FireLens/1.0"}), timeout=20) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":  # reports are stored compressed
                    raw = gzip.decompress(raw)
                _prebuilt_cache[key] = json.loads(raw)
        except Exception:
            return None
        if len(_prebuilt_cache) > 300:
            _prebuilt_cache.pop(next(iter(_prebuilt_cache)))
    body = dict(_prebuilt_cache[key])
    body["aoi_name"] = aoi_name
    return body


def report_payload(rec: fire_record.FireRecord, aoi_name: str, bbox: Optional[BoundingBox] = None,
                   country: Optional[str] = None, geometry: Optional[dict] = None) -> dict:
    """The /calendar/report body; also used by scripts/build_reports.py for the pre-built CDN reports."""
    return {
        "aoi_name": aoi_name,
        "bbox": bbox.model_dump() if bbox else None,
        "coverage": 1.0 if bbox is None or country else round(archive_store.coverage(bbox), 3),
        "clipped_to_geometry": bool(geometry) and not country,
        "source": "NASA FIRMS archive — MODIS C6.1 (Terra/Aqua, 1 km) & VIIRS S-NPP (375 m)",
        "through": rec.through.isoformat() if rec.through else archive_store.through(),
        "live": rec.live,
        "current_year": rec.cur_year,
        "current_week": rec.cur_week,
        "summary": rec.summary(),
        "baseline": rec.baseline(),
        "anomalies": rec.anomalies(),
        "outlook": rec.outlook(),
        "calibration": rec.calibration(),
        "monthly": rec.monthly(),
        "calendar": rec.calendar(),
    }


@router.post("/watchlist")
def get_watchlist(aoi: Optional[AOIRequest] = None, country: Optional[str] = Query(None), top: int = Query(10, ge=1, le=50)):
    """"Where to look now": cells in the area burning furthest above their own normal over the last two weeks."""
    from app.services.watchlist import watchlist
    if not archive_store.available():
        raise HTTPException(status_code=503, detail="Fire archive not built yet.")
    bbox, geometry = (aoi.bbox, aoi.geometry) if aoi else (None, None)
    return watchlist(bbox, country, geometry, top)


archive_router = APIRouter(prefix="/archive", tags=["Archive"])


@archive_router.get("/regions")
def archive_regions():
    """Countries in the local FIRMS archive, their bounding boxes and the date it runs through."""
    return {"through": archive_store.through(), "countries": archive_store.countries()}


@archive_router.get("/grid")
def archive_grid(year: int = Query(..., ge=2000, le=2026), source: str = Query("harmonized", pattern="^(harmonized|modis|viirs)$"),
                 cell: float = Query(0.5, ge=0.25, le=2.0)):
    """
    One year of archived detections on a grid, for the globe's timeline. `harmonized` uses MODIS before 2012 and
    the model's MODIS-equivalent VIIRS estimate from 2012. Cells: [lat, lon, value, summed FRP (MW)].
    """
    if not archive_store.available():
        raise HTTPException(status_code=503, detail="Fire archive not built yet.")
    key = (year, source, cell, archive_store.version())
    if key in _grid_cache:
        return _grid_cache[key]
    sensor = "M" if source == "modis" or (source == "harmonized" and year < fire_record.VIIRS_START) else "V"
    rows = archive_store.year_grid(year, sensor)
    if sensor == "V" and rows.empty:
        rows = archive_store.year_grid(year, "J")  # S-NPP gap or retirement: NOAA-20 (S-NPP ÷ NOAA-20 ≈ 1.02)
    val = "n"
    if source == "harmonized" and sensor == "V" and not rows.empty:
        # Annual totals: convert with each cell's learned VIIRS/MODIS ratio (the weekly model is not meant for
        # yearly sums); without a trained model, the global ratio.
        m = harmonizer_model.model()
        idx = list(zip(rows["gy"].to_numpy(), rows["gx"].to_numpy()))
        ratio = m["ratios"].reindex(idx).fillna(m["alpha"]).to_numpy() if m else 4.0
        rows = rows.assign(meq=rows["n"].to_numpy() / ratio)
        val = "meq"
    f = cell / archive_store.CELL
    t = (rows.assign(cy=(rows["gy"] // f).astype(int), cx=(rows["gx"] // f).astype(int))
             .groupby(["cy", "cx"]).agg(v=(val, "sum"), frp=("frp", "sum")).reset_index())
    t = t[t["v"] > 0]
    out = {"year": year, "source": source, "cell": cell,
           "cells": [[round((y + .5) * cell, 3), round((x + .5) * cell, 3), round(float(v), 1), round(float(fr), 1)]
                     for y, x, v, fr in t[["cy", "cx", "v", "frp"]].itertuples(index=False)]}
    _grid_cache[key] = out
    if len(_grid_cache) > 120:
        _grid_cache.pop(next(iter(_grid_cache)))
    return out


_grid_cache: dict = {}
