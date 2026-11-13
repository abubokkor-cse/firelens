import datetime as dt
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from app.api.v1.calendar import AOIRequest, record_for
from app.models.schemas import BoundingBox
from app.services import archive_store, hotspots

router = APIRouter(prefix="/hotspots", tags=["Hotspots"])

SENSOR_HELP = "Comma-separated: MODIS, VIIRS_SNPP, VIIRS_NOAA20, VIIRS_NOAA21 (default: the first three)"


def _area(aoi: Optional[AOIRequest], country: Optional[str]) -> tuple:
    """(bbox, geometry, cells to keep, harmonized record) for a request."""
    bbox, geometry = (aoi.bbox, aoi.geometry) if aoi else (None, None)
    keep = None
    if country:
        c = archive_store.cells()
        c = c[c["country"] == country.replace("_", " ")]
        if c.empty:
            raise HTTPException(status_code=404, detail=f"Unknown country: {country}")
        keep = set(zip(c["gy"].to_numpy().tolist(), c["gx"].to_numpy().tolist()))
        if bbox is None:
            cell = archive_store.CELL
            bbox = BoundingBox(west=float(c.gx.min() * cell), east=float(c.gx.max() * cell + cell),
                               south=float(c.gy.min() * cell), north=float(c.gy.max() * cell + cell))
    if bbox is None:
        raise HTTPException(status_code=422, detail="Send an area: a bbox (with an optional GeoJSON geometry) or a country.")
    try:  # the area's own VIIRS → MODIS calibration, when the archive covers it
        rec = record_for(bbox, country, geometry) if archive_store.available() else None
    except HTTPException:
        rec = None
    return bbox, None if country else geometry, keep, rec


def _run(aoi: Optional[AOIRequest], start: dt.date, end: dt.date, sensors: str, country: Optional[str]) -> dict:
    bbox, geometry, keep, rec = _area(aoi, country)
    try:
        return hotspots.search(bbox, start, end, [s.strip().upper() for s in sensors.split(",") if s.strip()],
                               geometry=geometry, keep_cells=keep, rec=rec)
    except hotspots.SearchError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/search")
def search_hotspots(
    aoi: Optional[AOIRequest] = None,
    start: dt.date = Query(..., description="First day (UTC), YYYY-MM-DD"),
    end: dt.date = Query(..., description="Last day (UTC), inclusive — at most 62 days after start"),
    sensors: str = Query(",".join(hotspots.DEFAULT_SENSORS), description=SENSOR_HELP),
    country: Optional[str] = Query(None, description="Ingested FIRMS country name; restricts to its cells"),
):
    """
    Every MODIS and VIIRS hotspot NASA FIRMS reported in the area between two dates: totals per sensor, a daily
    table (raw counts, detections the harmonized record uses, sensor-independent harmonized estimate, FRP) and the
    strongest detections for a map. Standard (science) products are used where they exist, near-real-time after.
    A search holding more than 300,000 detections stops at its last complete day: `truncated` is true and
    `complete_through` gives that day.
    """
    return hotspots.summary(_run(aoi, start, end, sensors, country))


@router.post("/history")
def hotspot_history(
    aoi: Optional[AOIRequest] = None,
    start: dt.date = Query(..., description="First day (UTC), YYYY-MM-DD"),
    end: dt.date = Query(..., description="Last day (UTC), inclusive — at most 7 days long"),
    country: Optional[str] = Query(None, description="Ingested FIRMS country name; restricts to its cells"),
):
    """
    The same calendar days in every year since 2000, counted from real detections: for ranges of up to a week, which
    the weekly record cannot resolve. MODIS to 2011 and VIIRS from 2012, converted to MODIS-equivalent, with the
    2003–2025 median, the selected days' rank among all years and their ratio to the median.
    """
    bbox, geometry, keep, rec = _area(aoi, country)
    try:
        return hotspots.history(bbox, start, end, geometry=geometry, keep_cells=keep, rec=rec)
    except hotspots.SearchError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/csv")
def hotspots_csv(
    aoi: Optional[AOIRequest] = None,
    start: dt.date = Query(..., description="First day (UTC), YYYY-MM-DD"),
    end: dt.date = Query(..., description="Last day (UTC), inclusive — at most 62 days after start"),
    sensors: str = Query(",".join(hotspots.DEFAULT_SENSORS), description=SENSOR_HELP),
    country: Optional[str] = Query(None),
    aoi_name: str = Query("area"),
):
    """
    The same search as a CSV file, one row per detection: sensor, satellite, position, date and time, confidence,
    FRP, brightness temperatures, pixel size, product (standard / near-real-time), `used_in_record` (passes the
    archive's cleaning rules) and `harmonized_weight` (the detection's contribution to the MODIS-equivalent record).
    """
    res = _run(aoi, start, end, sensors, country)
    body = res["rows"].to_csv(index=False, lineterminator="\n")
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in aoi_name)[:60] or "area"
    name = f"firelens-hotspots-{safe}-{start.isoformat()}_{end.isoformat()}.csv"
    headers = {"Content-Disposition": f'attachment; filename="{name}"',
               "X-FireLens-Rows": str(len(res["rows"])), "X-FireLens-Truncated": str(res["truncated"]).lower(),
               "X-FireLens-Complete-Through": res["complete_through"].isoformat(),
               "Access-Control-Expose-Headers": "Content-Disposition, X-FireLens-Rows, X-FireLens-Truncated, X-FireLens-Complete-Through"}
    return Response(content=body, media_type="text/csv; charset=utf-8", headers=headers)
