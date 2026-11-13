import threading

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app.api.v1.alerts import router as alerts_router
from app.api.v1.calendar import archive_router, router as calendar_router
from app.api.v1.fires import router as fires_router
from app.api.v1.harmonize import router as harmonize_router
from app.api.v1.hotspots import router as hotspots_router
from app.core.config import settings
from app.services import archive_store, archive_sync

app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    description=(
        "Harmonized MODIS × VIIRS active-fire record (2000–present) from NASA FIRMS: burning activity "
        "calendars, anomalies and early warning for any area of interest, plus live hotspots."
    ),
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=2048)


@app.middleware("http")
async def no_search_indexing(request, call_next):
    """Keep the API and its /docs pages out of search engines."""
    response = await call_next(request)
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    return response

app.include_router(fires_router, prefix=settings.API_V1_STR)
app.include_router(harmonize_router, prefix=settings.API_V1_STR)
app.include_router(calendar_router, prefix=settings.API_V1_STR)
app.include_router(archive_router, prefix=settings.API_V1_STR)
app.include_router(alerts_router, prefix=settings.API_V1_STR)
app.include_router(hotspots_router, prefix=settings.API_V1_STR)


@app.on_event("startup")
def load_archive():
    archive_sync.start()

    def warm():  # the whole-planet record takes a few seconds; build it before the first visitor asks
        try:
            from app.api.v1.calendar import record_for
            record_for(None)
        except Exception:
            pass

    # With a published (remote) archive, Global comes pre-built from the CDN, so cold starts stay light; only its
    # live top-up (the days after the archive, fetched from FIRMS) is prepared in the background.
    if not archive_store.remote_tiles():
        threading.Thread(target=warm, daemon=True).start()
    else:
        def warm_live():
            try:
                from app.api.v1.calendar import _behind, record_for
                from app.services import fire_record
                if _behind() and fire_record.planet_weekly() is not None:
                    record_for(None, live=True)
            except Exception:
                pass
        threading.Thread(target=warm_live, daemon=True).start()


@app.get("/", tags=["Health"])
def root():
    return {"service": "FireLens API", "status": "online", "docs": "/docs", "version": settings.VERSION}


@app.get("/health", tags=["Health"])
def health_check():
    return {
        "status": "healthy",
        "firms_api_configured": bool(settings.FIRMS_API_KEY),
        "archive_through": archive_store.through(),
        "archive_countries": len(archive_store.countries()),
    }
