from fastapi import APIRouter, HTTPException
from app.models.schemas import HarmonizeRequest, HarmonizedResult
from app.services.firms_client import firms_client
from app.services.harmonizer import harmonizer_engine
from app.api.v1.calendar import record_for

router = APIRouter(prefix="/harmonize", tags=["Harmonization"])


def _local_record(bbox):
    try:
        return record_for(bbox)
    except HTTPException:
        return None

@router.post("/calculate", response_model=HarmonizedResult)
async def calculate_harmonization(req: HarmonizeRequest):
    """
    Fetches MODIS and VIIRS records for the given bounding box and executes
    cross-sensor calibration to output a standardized, harmonized fire count and FRP.
    """
    try:
        results = await firms_client.get_all_fires(req.bbox, day_range=req.days)
        modis_list = results.get("MODIS", [])
        viirs_snpp = results.get("VIIRS_SNPP", [])
        viirs_noaa20 = results.get("VIIRS_NOAA20", []) + results.get("VIIRS_NOAA21", [])
        all_viirs = viirs_snpp + viirs_noaa20

        harmonized = harmonizer_engine.harmonize_dataset(
            bbox=req.bbox,
            modis_fires=modis_list,
            viirs_fires=all_viirs,
            landcover=req.landcover or "Default"
        )
        rec = _local_record(req.bbox) if (req.landcover or "All") == "All" else None
        if rec is not None:
            # Same calibration as the archive calendar, so live numbers sit on the 2000–present scale.
            snpp_n = len(viirs_snpp)
            snpp_frp = sum(f.frp or 0.0 for f in viirs_snpp)
            harmonized.harmonized_count = round(snpp_n / rec.alpha * rec.k, 1)
            harmonized.harmonized_frp = round(snpp_frp * rec.beta, 1)
            harmonized.scaling_factor_applied = round(rec.alpha / rec.k, 2)
            harmonized.calibration_method = (f"Local calibration from {len(rec.calib_years)} overlap years "
                                             f"(VIIRS S-NPP ÷ α={rec.alpha:.2f}, k={rec.k:.2f})")
        return harmonized
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Harmonization error: {str(e)}")


@router.get("/model")
def harmonization_model():
    """Out-of-time validation of the VIIRS→MODIS model against flat-ratio harmonization."""
    from app.services.fire_record import _report
    rep = _report()
    if not rep:
        raise HTTPException(status_code=404, detail="Model not trained yet — run `python -m scripts.train_harmonizer`.")
    return rep
