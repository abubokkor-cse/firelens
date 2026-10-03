import asyncio
import io
import time
import urllib.request

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from typing import List, Dict, Any
from app.models.schemas import BoundingBox, LiveFireResponse
from app.services.firms_client import firms_client
from app.services.harmonizer import harmonizer_engine
from app.services import corroboration
from app.core.config import settings

router = APIRouter(prefix="/fires", tags=["Fires"])

DEMO_REGIONS = [
    {
        "id": "bangladesh_rajshahi",
        "name": "Rajshahi Division, Bangladesh",
        "category": "Regional",
        "bbox": {"west": 88.0, "south": 24.0, "east": 89.5, "north": 25.5}
    },
    {
        "id": "amazon_basin",
        "name": "Amazon Rainforest Core, Brazil",
        "category": "Forest",
        "bbox": {"west": -65.0, "south": -15.0, "east": -50.0, "north": -5.0}
    },
    {
        "id": "california_sierra",
        "name": "Sierra Nevada, California, USA",
        "category": "Wildfire Zone",
        "bbox": {"west": -121.5, "south": 36.5, "east": -118.0, "north": 40.0}
    },
    {
        "id": "australia_southeast",
        "name": "Southeast Bushfire Zone, Australia",
        "category": "Wildfire Zone",
        "bbox": {"west": 148.0, "south": -38.0, "east": 151.0, "north": -34.0}
    }
]

@router.get("/demo-regions")
def get_demo_regions() -> List[Dict[str, Any]]:
    """Returns pre-configured active fire monitoring regions."""
    return DEMO_REGIONS

_live_cache: Dict[tuple, tuple] = {}
_live_locks: Dict[tuple, asyncio.Lock] = {}
LIVE_TTL = 600  # FIRMS publishes new passes every few hours; one fetch per area per 10 minutes is plenty


@router.post("/live", response_model=LiveFireResponse)
async def get_live_fires(bbox: BoundingBox, days: int = Query(1, ge=1, le=10)):
    """
    Fetches real-time active fire hotspots from NASA FIRMS for both MODIS and VIIRS.
    Highlights the disparity ratio between the two sensors. The same area is fetched once per 10 minutes, and
    simultaneous requests for it share that one fetch.
    """
    key = (round(bbox.west, 2), round(bbox.south, 2), round(bbox.east, 2), round(bbox.north, 2), days)
    hit = _live_cache.get(key)
    if hit and time.time() - hit[0] < LIVE_TTL:
        return hit[1]
    async with _live_locks.setdefault(key, asyncio.Lock()):
        hit = _live_cache.get(key)
        if hit and time.time() - hit[0] < LIVE_TTL:
            return hit[1]
        out = await _fetch_live(bbox, days)
        _live_cache[key] = (time.time(), out)
        if len(_live_cache) > 300:
            _live_cache.pop(next(iter(_live_cache)))
        return out


async def _fetch_live(bbox: BoundingBox, days: int) -> LiveFireResponse:
    try:
        results = await firms_client.get_all_fires(bbox, day_range=days)
        modis_list = results.get("MODIS", [])
        viirs_snpp = results.get("VIIRS_SNPP", [])
        viirs_noaa20 = results.get("VIIRS_NOAA20", []) + results.get("VIIRS_NOAA21", [])
        
        all_viirs = viirs_snpp + viirs_noaa20
        ratio = harmonizer_engine.compute_disparity(modis_list, all_viirs)
        
        all_fires = modis_list + all_viirs
        checks = corroboration.analyse(all_fires)
        
        return LiveFireResponse(
            success=True,
            bbox=bbox,
            total_modis=len(modis_list),
            total_viirs=len(all_viirs),
            disparity_ratio=ratio,
            fires=sorted(all_fires, key=lambda f: -(f.frp or 0))[:2000],  # strongest 2,000 keep the payload light
            corroboration=checks["corroboration"],
            sensor_match=checks["sensor_match"],
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch live fire data: {str(e)}")


_global_cache: dict = {}


def _world(source: str, days: int) -> pd.DataFrame:
    url = f"{settings.FIRMS_BASE_URL.rstrip('/')}/{settings.FIRMS_API_KEY}/{source}/world/{days}"
    req = urllib.request.Request(url, headers={"User-Agent": "FireLens/1.0 (NASA Space Apps Challenge 2026)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    if not raw.startswith(b"latitude"):
        return pd.DataFrame(columns=["latitude", "longitude", "frp"])
    return pd.read_csv(io.BytesIO(raw), usecols=["latitude", "longitude", "frp", "confidence"])


@router.get("/global")
def global_fires(days: int = Query(1, ge=1, le=5), cell: float = Query(0.5, ge=0.25, le=2.0)):
    """
    Today's worldwide VIIRS S-NPP 375 m detections from NASA FIRMS NRT, aggregated to a grid for the globe.
    Cached for one hour. Cells: [lat, lon, detections, summed FRP (MW)].
    """
    key = (days, cell)
    hit = _global_cache.get(key)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    try:
        df = _world("VIIRS_SNPP_NRT", days)
    except Exception as e:
        if hit:
            return hit[1]
        raise HTTPException(status_code=502, detail=f"NASA FIRMS unavailable: {e}")
    df = df[df["confidence"].astype(str).str.lower() != "l"]
    gy, gx = np.floor(df["latitude"] / cell), np.floor(df["longitude"] / cell)
    g = df.assign(gy=gy, gx=gx).groupby(["gy", "gx"]).agg(n=("frp", "size"), frp=("frp", "sum")).reset_index()
    cells = [[round((y + .5) * cell, 3), round((x + .5) * cell, 3), int(n), round(float(f), 1)]
             for y, x, n, f in g[["gy", "gx", "n", "frp"]].itertuples(index=False)]
    out = {"source": "VIIRS_SNPP_NRT", "days": days, "cell": cell, "detections": int(len(df)),
           "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "cells": cells}
    _global_cache[key] = (time.time(), out)
    return out
