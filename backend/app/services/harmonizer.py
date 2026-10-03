from typing import List
from app.models.schemas import BoundingBox, FireHotspot, HarmonizedResult

class HarmonizerEngine:
    """Empirical calibration between MODIS (1 km) and VIIRS (375 m) fire records."""

    # Landcover scaling factors (VIIRS / MODIS)
    LANDCOVER_RATIOS = {
        "Forest": 2.2,
        "Savanna": 4.1,
        "Cropland": 6.3,
        "Shrubland": 3.4,
        "Default": 4.2
    }

    def compute_disparity(self, modis_fires: List[FireHotspot], viirs_fires: List[FireHotspot]) -> float:
        modis_count = len(modis_fires)
        viirs_count = len(viirs_fires)

        if modis_count == 0:
            return float(viirs_count) if viirs_count > 0 else 1.0
        return round(viirs_count / modis_count, 2)

    def harmonize_dataset(
        self, 
        bbox: BoundingBox,
        modis_fires: List[FireHotspot], 
        viirs_fires: List[FireHotspot],
        landcover: str = "Default"
    ) -> HarmonizedResult:
        raw_modis_count = len(modis_fires)
        raw_viirs_count = len(viirs_fires)

        raw_modis_frp = sum(f.frp for f in modis_fires if f.frp is not None)
        raw_viirs_frp = sum(f.frp for f in viirs_fires if f.frp is not None)

        ratio = self.LANDCOVER_RATIOS.get(landcover, self.LANDCOVER_RATIOS["Default"])

        if raw_modis_count > 0 and raw_viirs_count > 0:
            # Overlap: blend MODIS observations with scaled VIIRS detections
            effective_viirs_equivalent = raw_viirs_count / ratio
            harmonized_count = round((raw_modis_count * 0.4) + (effective_viirs_equivalent * 0.6), 1)
            harmonized_frp = round((raw_modis_frp * 0.5) + ((raw_viirs_frp / 1.4) * 0.5), 1)
            method = f"Ensemble Calibration ({landcover} $\\alpha={ratio}$)"
        elif raw_viirs_count > 0:
            # Map VIIRS to MODIS equivalent baseline
            harmonized_count = round(raw_viirs_count / ratio, 1)
            harmonized_frp = round(raw_viirs_frp / 1.4, 1)
            method = f"VIIRS-to-MODIS Projection ({landcover} $\\alpha={ratio}$)"
        else:
            harmonized_count = float(raw_modis_count)
            harmonized_frp = round(raw_modis_frp, 1)
            method = "MODIS Historical Baseline Direct"

        return HarmonizedResult(
            bbox=bbox,
            raw_modis_count=raw_modis_count,
            raw_viirs_count=raw_viirs_count,
            harmonized_count=harmonized_count,
            raw_modis_frp=round(raw_modis_frp, 1),
            raw_viirs_frp=round(raw_viirs_frp, 1),
            harmonized_frp=harmonized_frp,
            scaling_factor_applied=ratio,
            calibration_method=method
        )

harmonizer_engine = HarmonizerEngine()
