from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any

class BoundingBox(BaseModel):
    west: float = Field(..., ge=-180, le=180, description="Western longitude")
    south: float = Field(..., ge=-90, le=90, description="Southern latitude")
    east: float = Field(..., ge=-180, le=180, description="Eastern longitude")
    north: float = Field(..., ge=-90, le=90, description="Northern latitude")

class FireHotspot(BaseModel):
    sensor: str
    satellite: Optional[str] = None
    latitude: float
    longitude: float
    brightness: Optional[float] = None
    bright_t2: Optional[float] = None
    frp: Optional[float] = None
    confidence: Optional[str] = None
    confidence_pct: Optional[int] = None
    acq_date: str
    acq_time: Optional[str] = None
    daynight: Optional[str] = None
    scan: Optional[float] = None
    track: Optional[float] = None
    corroboration: Optional[str] = None      # CONFIRMED | LIKELY | POSSIBLE
    seen_by: Optional[List[str]] = None       # platforms that detected this fire

class LiveFireResponse(BaseModel):
    success: bool
    bbox: BoundingBox
    total_modis: int
    total_viirs: int
    disparity_ratio: float
    fires: List[FireHotspot]
    corroboration: Optional[Dict[str, int]] = None
    sensor_match: Optional[Dict[str, Any]] = None

class HarmonizeRequest(BaseModel):
    bbox: BoundingBox
    days: int = Field(default=1, ge=1, le=10)
    landcover: Optional[str] = "All"

class HarmonizedResult(BaseModel):
    bbox: BoundingBox
    raw_modis_count: int
    raw_viirs_count: int
    harmonized_count: float
    raw_modis_frp: float
    raw_viirs_frp: float
    harmonized_frp: float
    scaling_factor_applied: float
    calibration_method: str

class CalendarWeekData(BaseModel):
    week: int
    modis_raw: int
    viirs_raw: int
    harmonized_count: Optional[float]  # None = no sensor data for this week
    total_frp: Optional[float]
    status: str  # 'NORMAL', 'HIGH', 'EXTREME', 'LOW', 'NO_DATA'
    z_score: float
    percentile: Optional[float] = None

class CalendarYearData(BaseModel):
    year: int
    weeks: List[CalendarWeekData]

class BurningCalendarResponse(BaseModel):
    aoi_name: str
    bbox: BoundingBox
    start_year: int
    end_year: int
    baseline_peak_week: int
    baseline_annual_mean: float
    calendar: List[CalendarYearData]

class AnomalyAlert(BaseModel):
    week: int
    year: int
    severity: str  # 'INFO', 'WARNING', 'CRITICAL'
    alert_type: str  # 'EARLY_ONSET', 'LATE_ONSET', 'EXTREME_FIRE_SURGE', 'UNUSUAL_SUPPRESSION'
    description: str
    current_value: float
    historical_mean: float
    percentile: float
