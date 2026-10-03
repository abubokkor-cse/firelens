import logging
import urllib.request
import asyncio
from typing import List, Dict, Any, Optional
from app.core.config import settings
from app.models.schemas import BoundingBox, FireHotspot

logger = logging.getLogger(__name__)

class FIRMSClient:
    """
    NASA FIRMS Multi-Sensor API Client.
    Fetches real-time and archive active fire detections for:
    - MODIS (Terra & Aqua - 1 km)
    - VIIRS (Suomi-NPP - 375 m)
    - VIIRS (NOAA-20 / JPSS-1 - 375 m)
    - VIIRS (NOAA-21 / JPSS-2 - 375 m)
    """

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or settings.FIRMS_API_KEY
        self.base_url = settings.FIRMS_BASE_URL.rstrip('/')

    def _build_url(self, source_code: str, bbox: BoundingBox, day_range: int = 1) -> str:
        coords = f"{bbox.west:.4f},{bbox.south:.4f},{bbox.east:.4f},{bbox.north:.4f}"
        return f"{self.base_url}/{self.api_key}/{source_code}/{coords}/{day_range}"

    def _fetch_source_sync(self, source_code: str, bbox: BoundingBox, day_range: int = 1) -> List[Dict[str, Any]]:
        url = self._build_url(source_code, bbox, day_range)
        logger.info(f"FIRMS: querying {source_code} for bbox [{bbox.west}, {bbox.south}, {bbox.east}, {bbox.north}]")
        
        try:
            req = urllib.request.Request(
                url, 
                headers={"User-Agent": "FireLens/1.0 (NASA Space Apps Challenge 2026)"}
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                if resp.status != 200:
                    logger.warning(f"FIRMS returned HTTP {resp.status} for {source_code}")
                    return []
                
                content = resp.read().decode('utf-8').strip()
                lines = content.split('\n')
                if len(lines) <= 1:
                    return []
                
                header = [h.strip() for h in lines[0].split(',')]
                rows = []
                for line in lines[1:]:
                    if not line.strip():
                        continue
                    parts = [p.strip() for p in line.split(',')]
                    if len(parts) == len(header):
                        rows.append(dict(zip(header, parts)))
                return rows
        except Exception as e:
            logger.error(f"FIRMS request failed ({source_code}): {e}")
            return []

    def parse_hotspots(self, raw_rows: List[Dict[str, Any]], sensor_type: str) -> List[FireHotspot]:
        """
        Standardizes raw FIRMS CSV records across MODIS and VIIRS into unified FireHotspot objects.
        """
        hotspots = []
        is_viirs = "VIIRS" in sensor_type.upper()

        for r in raw_rows:
            try:
                lat = float(r.get('latitude', 0.0))
                lon = float(r.get('longitude', 0.0))
                frp = float(r.get('frp', 0.0)) if r.get('frp') else None
                acq_date = r.get('acq_date', '')
                acq_time = r.get('acq_time', '')
                satellite = r.get('satellite', '')
                daynight = r.get('daynight', '')
                scan = float(r.get('scan', 0.0)) if r.get('scan') else None
                track = float(r.get('track', 0.0)) if r.get('track') else None

                if is_viirs:
                    # VIIRS specific fields
                    brightness = float(r.get('bright_ti4', 0.0)) if r.get('bright_ti4') else None
                    bright_t2 = float(r.get('bright_ti5', 0.0)) if r.get('bright_ti5') else None
                    conf_raw = r.get('confidence', 'n').lower()
                    # Map 'l', 'n', 'h' to percentage equivalent
                    conf_map = {'l': 30, 'n': 60, 'h': 95}
                    conf_pct = conf_map.get(conf_raw, 50)
                else:
                    # MODIS specific fields
                    brightness = float(r.get('brightness', 0.0)) if r.get('brightness') else None
                    bright_t2 = float(r.get('bright_t31', 0.0)) if r.get('bright_t31') else None
                    conf_raw = r.get('confidence', '0')
                    try:
                        conf_pct = int(conf_raw)
                    except ValueError:
                        conf_pct = 50

                hotspots.append(FireHotspot(
                    sensor=sensor_type,
                    satellite=satellite,
                    latitude=lat,
                    longitude=lon,
                    brightness=brightness,
                    bright_t2=bright_t2,
                    frp=frp,
                    confidence=conf_raw,
                    confidence_pct=conf_pct,
                    acq_date=acq_date,
                    acq_time=acq_time,
                    daynight=daynight,
                    scan=scan,
                    track=track
                ))
            except Exception as parse_err:
                logger.debug(f"Row parse error: {parse_err}")
                continue

        return hotspots

    async def get_all_fires(self, bbox: BoundingBox, day_range: int = 1) -> Dict[str, List[FireHotspot]]:
        """
        Asynchronously fetches both MODIS and VIIRS sources in parallel.
        """
        loop = asyncio.get_event_loop()
        
        sources = {
            "MODIS": "MODIS_NRT",
            "VIIRS_SNPP": "VIIRS_SNPP_NRT",
            "VIIRS_NOAA20": "VIIRS_NOAA20_NRT",
            "VIIRS_NOAA21": "VIIRS_NOAA21_NRT",
        }

        tasks = [
            loop.run_in_executor(None, self._fetch_source_sync, code, bbox, day_range)
            for code in sources.values()
        ]
        
        raw_results = await asyncio.gather(*tasks)
        
        parsed_results = {}
        for (sensor_name, _), raw_data in zip(sources.items(), raw_results):
            parsed_results[sensor_name] = self.parse_hotspots(raw_data, sensor_name)
            
        return parsed_results

firms_client = FIRMSClient()
