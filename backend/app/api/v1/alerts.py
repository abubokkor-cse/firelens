import datetime as dt
import re
import secrets
import time
from collections import defaultdict, deque
from typing import Literal, Optional

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from app.core.config import settings
from app.models.schemas import BoundingBox
from app.services import alert_email, alerts
from app.services.alerts_store import store

router = APIRouter(prefix="/alerts", tags=["Fire Alerts"])

EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[A-Za-z]{2,}$")
MAX_PER_EMAIL = 5
_recent_ips: dict = defaultdict(deque)


class AlertArea(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    country: Optional[str] = Field(None, max_length=80)
    bbox: Optional[BoundingBox] = None
    lat: Optional[float] = Field(None, ge=-90, le=90)
    lon: Optional[float] = Field(None, ge=-180, le=180)
    radius_km: Optional[float] = Field(None, ge=1, le=200)


class AlertTypes(BaseModel):
    strong_fire: bool = True
    min_frp_mw: float = Field(50, ge=5, le=5000, description="Fire radiative power threshold for a 'strong fire'")
    confirmed_fire: bool = False
    unusual: bool = False
    min_delta_pct: float = Field(50, ge=10, le=1000, description="How far above the 2003–2025 normal counts as unusual")


class SubscribeRequest(BaseModel):
    email: str = Field(..., max_length=254)
    name: Optional[str] = Field(None, max_length=60)
    area: AlertArea
    types: AlertTypes = AlertTypes()
    frequency: Literal["instant", "daily"] = "instant"
    consent: bool = False


def _api_base(request: Request) -> str:
    if settings.PUBLIC_API_URL:
        return settings.PUBLIC_API_URL.rstrip("/")
    base = str(request.base_url).rstrip("/")
    return base if "localhost" in base or "127.0.0.1" in base else base.replace("http://", "https://", 1)


def _rate_limited(ip: str, limit: int = 5, window_s: int = 3600) -> bool:
    q, now = _recent_ips[ip], time.time()
    while q and now - q[0] > window_s:
        q.popleft()
    if len(q) >= limit:
        return True
    q.append(now)
    return False


@router.post("/subscribe")
def subscribe(req: SubscribeRequest, request: Request):
    """
    Ask for fire-alert emails for an area. Nothing is sent until the address is confirmed through the link in the
    confirmation email. Types: a single strong fire (FRP ≥ min_frp_mw), any fire confirmed by two satellites, or an
    unusual week for the area (≥ min_delta_pct above its 2003–2025 normal).
    """
    email = req.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(422, "Please enter a valid email address.")
    if not req.consent:
        raise HTTPException(422, "Please agree to receive alert emails.")
    t, a = req.types, req.area
    if not (t.strong_fire or t.confirmed_fire or t.unusual):
        raise HTTPException(422, "Choose at least one kind of alert.")
    point = a.lat is not None and a.lon is not None
    if point and not a.radius_km:
        raise HTTPException(422, "Choose a radius around the location.")
    if not (point or a.country or a.bbox):
        raise HTTPException(422, "Choose a country, a place or your location — alerts for the whole planet are not offered.")
    if a.bbox and not (point or a.country) and (t.strong_fire or t.confirmed_fire):
        span = (a.bbox.north - a.bbox.south) * ((a.bbox.east - a.bbox.west) % 360 or 360)
        if span > alerts.MAX_BBOX_DEG2:
            raise HTTPException(422, "This area is too large for fire-by-fire alerts. Pick a country or a smaller area.")
    if a.country and alerts.area_bbox(a.model_dump()) is None:
        raise HTTPException(422, "Unknown country.")
    ip = (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "?")).split(",")[0].strip()
    if _rate_limited(ip):
        raise HTTPException(429, "Too many requests — please try again later.")
    if store().count_email(email) >= MAX_PER_EMAIL:
        raise HTTPException(429, f"This address already has {MAX_PER_EMAIL} alert subscriptions.")

    base = _api_base(request)
    sid, confirm, unsub = secrets.token_hex(8), secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    sub = {"id": sid, "email": email, "name": (req.name or "").strip() or None,
           "area": a.model_dump(exclude_none=True, mode="json"), "types": t.model_dump(), "frequency": req.frequency,
           "status": "pending", "confirm_token": confirm, "unsubscribe_token": unsub,
           "unsubscribe_url": f"{base}{settings.API_V1_STR}/alerts/unsubscribe?token={unsub}",
           "created": dt.datetime.now(dt.timezone.utc).isoformat(), "sent": {}}
    store().add(sub)
    if not alert_email.send(email, *alert_email.confirm_message(sub, f"{base}{settings.API_V1_STR}/alerts/confirm?token={confirm}")):
        store().delete(sid)
        raise HTTPException(502, "The confirmation email could not be sent. Please try again later.")
    return {"status": "pending", "message": f"Check {email} and click the link to turn your alerts on."}


@router.get("/confirm", response_class=HTMLResponse)
def confirm(token: str = Query(..., min_length=16, max_length=64)):
    sub = store().find("confirm_token", token)
    if not sub:
        return HTMLResponse(alert_email.result_page("Link expired", "This confirmation link is no longer valid. "
                                                    "You can sign up again on FireLens."), status_code=404)
    if sub["status"] != "active":
        store().update(sub["id"], {"status": "active", "confirmed": dt.datetime.now(dt.timezone.utc).isoformat()})
    what = ", ".join(alert_email.describe(sub))
    when = "within the hour" if sub["frequency"] == "instant" else "in a daily summary"
    return alert_email.result_page("Your fire alerts are on",
                                   f"We will email {sub['email']} {when} about {what} — "
                                   f"{alert_email.area_label(sub['area'])}. Every email has an unsubscribe link.")


@router.api_route("/unsubscribe", methods=["GET", "POST"], response_class=HTMLResponse)
def unsubscribe(token: str = Query(..., min_length=16, max_length=64)):
    sub = store().find("unsubscribe_token", token)
    if sub:
        store().delete(sub["id"])
    return alert_email.result_page("Unsubscribed", "You will not receive these fire alerts any more.")


@router.post("/run")
async def run_alerts(x_alerts_token: str = Header("")):
    """Hourly check (called by Cloud Scheduler with the X-Alerts-Token header)."""
    if not settings.ALERTS_RUN_TOKEN or not secrets.compare_digest(x_alerts_token, settings.ALERTS_RUN_TOKEN):
        raise HTTPException(403, "Forbidden")
    return await alerts.run()
