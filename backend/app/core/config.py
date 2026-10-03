from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings, read from environment variables (and backend/.env for local development)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    PROJECT_NAME: str = "FireLens API"
    VERSION: str = "1.0.0"
    API_V1_STR: str = "/api/v1"

    # NASA FIRMS — free MAP_KEY from https://firms.modaps.eosdis.nasa.gov/api/map_key/
    FIRMS_API_KEY: str = ""
    FIRMS_BASE_URL: str = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"

    # Fire alerts by email (Resend: https://resend.com). ALERTS_FROM must use a domain verified in Resend.
    RESEND_API_KEY: str = ""
    ALERTS_FROM: str = "FireLens Alerts <onboarding@resend.dev>"
    ALERTS_RUN_TOKEN: str = ""        # shared secret for the scheduled POST /alerts/run
    ALERTS_STORE: str = "local"       # "firestore" in production, "local" (data/alerts.json) for development
    SITE_URL: str = "https://firelens.pages.dev"
    PUBLIC_API_URL: str = ""          # this API's public base URL, for links in emails (default: from the request)

    # Comma-separated browser origins allowed to call the API
    CORS_ORIGINS_RAW: str = "http://localhost:5173,http://127.0.0.1:5173"

    @property
    def CORS_ORIGINS(self) -> List[str]:
        return [o.strip() for o in self.CORS_ORIGINS_RAW.split(",") if o.strip()]


settings = Settings()
