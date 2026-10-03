"""
The hourly alert check. Live FIRMS detections are fetched once per distinct area (all four satellites, last 24 h),
labelled confirmed / likely / possible, and each active subscription is emailed the fires that match its choices
and that it has not been told about yet. "Unusual week" is checked against the area's harmonized record.
"""
import datetime as dt
import logging
import math
import time
from typing import Optional

import numpy as np

from app.models.schemas import BoundingBox
from app.services import alert_email, archive_store, corroboration
from app.services.alerts_store import store
from app.services.firms_client import firms_client

logger = logging.getLogger(__name__)
REMEMBER_DAYS = 3        # a fire location already emailed is not repeated for this long
DIGEST_HOURS = 23        # daily subscriptions: at most one email per this many hours
MAX_BBOX_DEG2 = 900      # largest drawn/searched area for fire-by-fire alerts (≈ 30° × 30°); countries are allowed


def area_bbox(area: dict) -> Optional[BoundingBox]:
    if area.get("lat") is not None:
        lat, lon, r = area["lat"], area["lon"], area["radius_km"]
        dlat, dlon = r / 111.0, r / (111.0 * max(0.05, math.cos(math.radians(lat))))
        return BoundingBox(west=max(-180, lon - dlon), south=max(-90, lat - dlat),
                           east=min(180, lon + dlon), north=min(90, lat + dlat))
    if area.get("country"):
        c = archive_store.cells()
        c = c[c["country"] == area["country"].replace("_", " ")]
        if c.empty:
            return None
        k = archive_store.CELL
        return BoundingBox(west=float(c.gx.min() * k), south=float(c.gy.min() * k),
                           east=float((c.gx.max() + 1) * k), north=float((c.gy.max() + 1) * k))
    return BoundingBox(**area["bbox"]) if area.get("bbox") else None


def _km(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def _in_area(fires: list, area: dict) -> list:
    if area.get("lat") is not None:
        out = []
        for f in fires:
            d = _km(area["lat"], area["lon"], f.latitude, f.longitude)
            if d <= area["radius_km"]:
                out.append((f, d))
        return out
    if area.get("country"):
        c = archive_store.cells()
        c = c[c["country"] == area["country"].replace("_", " ")]
        keep = set(zip(c.gy.to_numpy(), c.gx.to_numpy()))
        k = archive_store.CELL
        return [(f, None) for f in fires if (int(np.floor(f.latitude / k)), int(np.floor(f.longitude / k))) in keep]
    return [(f, None) for f in fires]


def _key(f) -> str:
    """Fire location to ~1 km (0.01°): the same fire seen again on later passes is not repeated."""
    return f"{round(f.latitude * 100)}_{round(f.longitude * 100)}"


def strength(frp: float) -> str:
    """Plain-word intensity from fire radiative power (MW)."""
    return ("extreme fire" if frp >= 500 else "very strong fire" if frp >= 100 else "strong fire" if frp >= 50
            else "sizeable fire" if frp >= 20 else "small fire")


def _matches(f, types: dict) -> Optional[str]:
    frp = f.frp or 0
    if (types.get("strong_fire") and frp >= types.get("min_frp_mw", 50)) or \
            (types.get("confirmed_fire") and f.corroboration == "CONFIRMED"):
        return strength(frp)
    return None


async def _fires(bbox: BoundingBox) -> list:
    res = await firms_client.get_all_fires(bbox, day_range=1)
    fires = [f for v in res.values() for f in v]
    corroboration.analyse(fires)
    return fires


def _unusual(sub: dict, now: dt.datetime) -> Optional[tuple]:
    """(this-week, summary) when the area burns above the subscriber's threshold and this week was not sent yet."""
    from app.api.v1.calendar import record_for
    area, t = sub["area"], sub["types"]
    try:
        rec = record_for(None if area.get("country") else area_bbox(area), area.get("country"), live=True)
    except Exception:
        return None
    s = rec.summary()
    tw = s.get("this_week")
    if not tw or tw.get("delta_pct") is None or tw["days"] < 2 or tw["expected"] < 5:
        return None  # too early in the week, or too little fire to judge
    week_key = f"{rec.cur_year}-{tw['week']}"
    if tw["delta_pct"] >= t.get("min_delta_pct", 50) and sub.get("unusual_sent") != week_key:
        return tw, s, week_key
    return None


async def run(now: Optional[dt.datetime] = None) -> dict:
    t0, now = time.time(), now or dt.datetime.now(dt.timezone.utc)
    subs = store().active()
    stats = {"subscriptions": len(subs), "areas": 0, "emails": 0, "fires_found": 0, "errors": 0}
    cache: dict = {}
    for sub in subs:
        try:
            types, area = sub["types"], sub["area"]
            daily = sub.get("frequency") == "daily"
            last = dt.datetime.fromisoformat(sub["last_sent"]) if sub.get("last_sent") else None
            if daily and last and now - last < dt.timedelta(hours=DIGEST_HOURS):
                continue
            unsub = sub["unsubscribe_url"]
            updates: dict = {}

            if types.get("strong_fire") or types.get("confirmed_fire"):
                bbox = area_bbox(area)
                if bbox is not None:
                    bk = (round(bbox.west, 2), round(bbox.south, 2), round(bbox.east, 2), round(bbox.north, 2))
                    if bk not in cache:
                        cache[bk] = await _fires(bbox)
                        stats["areas"] += 1
                    sent = {k: v for k, v in (sub.get("sent") or {}).items()
                            if dt.date.fromisoformat(v) >= now.date() - dt.timedelta(days=REMEMBER_DAYS)}
                    hits, seen = [], set()
                    for f, dist in sorted(_in_area(cache[bk], area), key=lambda x: -(x[0].frp or 0)):
                        why, k = _matches(f, types), _key(f)
                        if why and k not in sent and k not in seen:
                            seen.add(k)
                            hits.append({"lat": f.latitude, "lon": f.longitude, "frp": f.frp or 0, "acq_date": f.acq_date,
                                         "acq_time": f.acq_time, "label": f.corroboration, "seen_by": f.seen_by or [],
                                         "why": why, "distance_km": dist})
                    if hits:
                        stats["fires_found"] += len(hits)
                        if alert_email.send(sub["email"], *alert_email.fires_message(sub, hits, unsub), unsubscribe_url=unsub):
                            stats["emails"] += 1
                            sent.update({f"{round(h['lat'] * 100)}_{round(h['lon'] * 100)}": now.date().isoformat() for h in hits})
                            updates["last_sent"] = now.isoformat()
                    updates["sent"] = sent

            if types.get("unusual"):
                u = _unusual(sub, now)
                if u:
                    tw, s, week_key = u
                    if alert_email.send(sub["email"], *alert_email.unusual_message(sub, tw, s, unsub), unsubscribe_url=unsub):
                        stats["emails"] += 1
                        updates.update(unusual_sent=week_key, last_sent=now.isoformat())
            if updates:
                store().update(sub["id"], updates)
        except Exception as e:
            stats["errors"] += 1
            logger.exception("alert check failed for %s: %s", sub.get("id"), e)
    stats["took_s"] = round(time.time() - t0, 1)
    return stats
