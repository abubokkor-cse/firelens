import datetime as dt
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

    MAX_SPAN = 5  # the FIRMS area API serves at most 5 days per request

    def _build_url(self, source_code: str, bbox: BoundingBox, day_range: int = 1, date: Optional[dt.date] = None) -> str:
        coords = f"{bbox.west:.4f},{bbox.south:.4f},{bbox.east:.4f},{bbox.north:.4f}"
        return f"{self.base_url}/{self.api_key}/{source_code}/{coords}/{day_range}" + (f"/{date.isoformat()}" if date else "")

    def _fetch_source_sync(self, source_code: str, bbox: BoundingBox, day_range: int = 1) -> List[Dict[str, Any]]:
        """The last `day_range` days (UTC, today included). FIRMS caps one request at 5 days, so longer windows are
        fetched as consecutive dated pieces of up to 5 days."""
        if day_range <= self.MAX_SPAN:
            return self._fetch_url(self._build_url(source_code, bbox, day_range), source_code)
        today = dt.datetime.now(dt.timezone.utc).date()
        day, rows = today - dt.timedelta(days=day_range - 1), []
        while day <= today:
            span = min(self.MAX_SPAN, (today - day).days + 1)
            rows += self._fetch_url(self._build_url(source_code, bbox, span, day), source_code)
            day += dt.timedelta(days=span)
        return rows

    def _fetch_url(self, url: str, source_code: str) -> List[Dict[str, Any]]:
        logger.info(f"FIRMS: querying {source_code}")
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
                if not content.startswith('latitude'):
                    # FIRMS answers errors (bad key, invalid day range, rate limit) with 200 and a plain message.
                    logger.warning(f"FIRMS {source_code}: {content[:120]}")
                    return []
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

    async def get_all_fires(self, bbox: BoundingBox, day_range: int = 1, rolling: bool = False) -> Dict[str, List[FireHotspot]]:
        """
        Asynchronously fetches both MODIS and VIIRS sources in parallel. FIRMS counts whole UTC days, so `day_range=1`
        alone is "today so far" and can be almost empty early in the UTC day; `rolling` gives the true last
        day_range × 24 hours instead (one extra day is fetched and cut at the exact time).
        """
        loop = asyncio.get_event_loop()
        fetch_days = day_range + 1 if rolling else day_range
        
        sources = {
            "MODIS": "MODIS_NRT",
            "VIIRS_SNPP": "VIIRS_SNPP_NRT",
            "VIIRS_NOAA20": "VIIRS_NOAA20_NRT",
            "VIIRS_NOAA21": "VIIRS_NOAA21_NRT",
        }

        tasks = [
            loop.run_in_executor(None, self._fetch_source_sync, code, bbox, fetch_days)
            for code in sources.values()
        ]
        
        raw_results = await asyncio.gather(*tasks)
        
        parsed_results = {}
        for (sensor_name, _), raw_data in zip(sources.items(), raw_results):
            parsed_results[sensor_name] = self.parse_hotspots(raw_data, sensor_name)
            
        if rolling:
            cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=day_range)
            stamp = cutoff.strftime("%Y-%m-%d%H%M")
            parsed_results = {k: [f for f in v if f"{f.acq_date}{(f.acq_time or '').zfill(4)}" >= stamp]
                              for k, v in parsed_results.items()}
        return parsed_results

firms_client = FIRMSClient()
