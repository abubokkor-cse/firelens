"""
Alert emails: sending through Resend and the three messages (confirm subscription, fires found, unusual week).
Without RESEND_API_KEY the messages are written to data/outbox/ instead, for development.
"""
import datetime as dt
import html
import json
import logging
import os
import urllib.request
from typing import Optional

from app.core.config import settings
from app.services.archive_store import DATA_DIR

logger = logging.getLogger(__name__)
RESEND_URL = "https://api.resend.com/emails"
ORANGE, INK, MUTED, LINE = "#ff6a1a", "#10131a", "#5b6477", "#e6e9ef"


def send(to: str, subject: str, body_html: str, text: str, unsubscribe_url: Optional[str] = None) -> bool:
    msg = {"from": settings.ALERTS_FROM, "to": [to], "subject": subject, "html": body_html, "text": text}
    if unsubscribe_url:  # one-click unsubscribe in the mail client (RFC 8058)
        msg["headers"] = {"List-Unsubscribe": f"<{unsubscribe_url}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"}
    if not settings.RESEND_API_KEY:
        out = os.path.join(DATA_DIR, "outbox")
        os.makedirs(out, exist_ok=True)
        stem = os.path.join(out, dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
        with open(stem + ".html", "w") as f:
            f.write(body_html)
        with open(stem + ".json", "w") as f:
            json.dump({k: v for k, v in msg.items() if k != "html"}, f, indent=1)
        logger.info("RESEND_API_KEY not set; email to %s saved to %s.html", to, stem)
        return True
    req = urllib.request.Request(RESEND_URL, data=json.dumps(msg).encode(), method="POST", headers={
        "Authorization": f"Bearer {settings.RESEND_API_KEY}", "Content-Type": "application/json",
        "User-Agent": "FireLens/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return 200 <= r.status < 300
    except urllib.error.HTTPError as e:
        logger.warning("Resend refused the email to %s: %s %s", to, e.code, e.read()[:300])
    except Exception as e:
        logger.warning("Resend unreachable: %s", e)
    return False


# ── layout ─────────────────────────────────────────────────────────────────────
def _page(title: str, body: str, unsubscribe_url: Optional[str] = None) -> str:
    foot = ("Satellite detections are not an official warning and can miss fires under cloud or include hot "
            "industrial sites. In an emergency, follow your local authorities.")
    unsub = f' · <a href="{unsubscribe_url}" style="color:{MUTED}">Unsubscribe</a>' if unsubscribe_url else ""
    return f"""<!doctype html><html><body style="margin:0;background:#f4f5f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:{INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f8;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid {LINE}">
<tr><td style="background:#07090f;padding:18px 24px;color:#fff;font-size:18px;font-weight:700">🔥 FireLens <span style="color:#9fb0cc;font-weight:400;font-size:13px">· MODIS × VIIRS fire alerts</span></td></tr>
<tr><td style="padding:24px"><h1 style="margin:0 0 12px;font-size:20px;line-height:1.3">{title}</h1>{body}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid {LINE};font-size:12px;line-height:1.5;color:{MUTED}">{foot}<br>
Data: NASA FIRMS near-real-time (MODIS, VIIRS S-NPP, NOAA-20, NOAA-21) · <a href="{settings.SITE_URL}" style="color:{MUTED}">FireLens</a>{unsub}</td></tr>
</table></td></tr></table></body></html>"""


def _button(url: str, label: str) -> str:
    return (f'<a href="{url}" style="display:inline-block;background:{ORANGE};color:#fff;text-decoration:none;'
            f'font-weight:700;padding:12px 20px;border-radius:10px">{label}</a>')


def describe(sub: dict) -> list[str]:
    """The subscription's alert choices in plain words."""
    t, out = sub["types"], []
    if t.get("strong_fire"):
        out.append(f"a fire stronger than {t.get('min_frp_mw', 50):g} MW")
    if t.get("confirmed_fire"):
        out.append("any fire confirmed by two satellites")
    if t.get("unusual"):
        out.append(f"burning at least {t.get('min_delta_pct', 50):g}% above the 2003–2025 normal this week")
    return out


def area_label(area: dict, prep: str = "") -> str:
    """"within 25 km of Rajshahi", or the area's name after `prep` ("for Brazil", "in Brazil")."""
    if area.get("lat") is not None:
        return f"within {area['radius_km']:g} km of {html.escape(area.get('name') or 'your location')}"
    return (prep + " " if prep else "") + html.escape(area.get("name") or "your area")


# ── messages ───────────────────────────────────────────────────────────────────
def confirm_message(sub: dict, confirm_url: str) -> tuple[str, str, str]:
    what = "".join(f"<li>{w}</li>" for w in describe(sub))
    when = "within the hour (we check every hour)" if sub["frequency"] == "instant" else "once a day, in one summary,"
    body = (f'<p style="margin:0 0 12px;line-height:1.55">Please confirm that you want FireLens fire alerts '
            f'<b>{area_label(sub["area"], "for")}</b>. We will email you {when} when we detect:</p>'
            f'<ul style="margin:0 0 18px;padding-left:20px;line-height:1.6">{what}</ul>'
            f'<p style="margin:0 0 18px">{_button(confirm_url, "Confirm my alerts")}</p>'
            f'<p style="margin:0;font-size:13px;color:{MUTED}">If you did not ask for this, ignore this email — nothing '
            f'will be sent.</p>')
    text = (f"Confirm FireLens fire alerts {area_label(sub['area'], 'for')}:\n{confirm_url}\n\n"
            "If you did not ask for this, ignore this email.")
    return "Confirm your FireLens fire alerts", _page("Confirm your fire alerts", body), text


def _when(f: dict) -> str:
    t = (f.get("acq_time") or "").zfill(4)
    try:
        d = dt.datetime.strptime(f["acq_date"] + t, "%Y-%m-%d%H%M")
        return d.strftime("%-d %b %H:%M UTC")
    except ValueError:
        return f["acq_date"]


def fires_message(sub: dict, fires: list[dict], unsubscribe_url: str) -> tuple[str, str, str]:
    """`fires`: dicts with lat, lon, frp, acq_date, acq_time, label, seen_by, why, distance_km (optional)."""
    area = area_label(sub["area"], "in")
    top = max(f["frp"] for f in fires)
    rows, lines = [], []
    for f in fires[:10]:
        where = f"{abs(f['lat']):.4f}°{'N' if f['lat'] >= 0 else 'S'}, {abs(f['lon']):.4f}°{'E' if f['lon'] >= 0 else 'W'}"
        dist = f" · {f['distance_km']:.0f} km away" if f.get("distance_km") is not None else ""
        seen = {"CONFIRMED": "Confirmed — seen by " + " & ".join(f["seen_by"]), "LIKELY": "Likely fire (" + ", ".join(f["seen_by"]) + ")",
                "POSSIBLE": "Possible fire (" + ", ".join(f["seen_by"]) + ", single detection)"}.get(f["label"], "")
        gmap = f"https://www.google.com/maps?q={f['lat']:.5f},{f['lon']:.5f}"
        firms = f"https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@{f['lon']:.4f},{f['lat']:.4f},12.0z"
        rows.append(
            f'<tr><td style="padding:12px 0;border-top:1px solid {LINE}">'
            f'<div style="font-weight:700;font-size:15px">{f["frp"]:.0f} MW · {f["why"]}</div>'
            f'<div style="font-size:13px;color:{MUTED};line-height:1.5">{seen}<br>{where}{dist} · {_when(f)}</div>'
            f'<div style="font-size:13px;margin-top:4px"><a href="{gmap}" style="color:{ORANGE}">Google Maps</a> · '
            f'<a href="{firms}" style="color:{ORANGE}">NASA FIRMS map</a></div></td></tr>')
        lines.append(f"- {f['frp']:.0f} MW, {f['why']}, {seen}; {where}{dist}; {_when(f)}; {gmap}")
    more = f'<p style="font-size:13px;color:{MUTED}">…and {len(fires) - 10} more.</p>' if len(fires) > 10 else ""
    n = len(fires)
    title = f"{n} fire{'s' if n > 1 else ''} detected {area}"
    body = (f'<p style="margin:0 0 6px;line-height:1.55">Strongest: <b>{top:.0f} MW</b> fire radiative power '
            f'(how much heat the fire gives off; above 100 MW is a large, intense fire).</p>'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(rows)}</table>{more}'
            f'<p style="margin:18px 0 0">{_button(settings.SITE_URL, "Open FireLens")}</p>')
    subject = f"🔥 {n} fire{'s' if n > 1 else ''} {area} — strongest {top:.0f} MW"
    text = f"{title}\n\n" + "\n".join(lines) + f"\n\nFireLens: {settings.SITE_URL}\nUnsubscribe: {unsubscribe_url}"
    return subject, _page(title, body, unsubscribe_url), text


def unusual_message(sub: dict, tw: dict, summary: dict, unsubscribe_url: str) -> tuple[str, str, str]:
    area = area_label(sub["area"], "in")
    title = f"Unusual burning {area}: {tw['delta_pct']:+.0f}% vs. normal"
    body = (f'<p style="margin:0 0 12px;line-height:1.55">So far this week (since {tw["start"]}), satellites have '
            f'recorded <b>{tw["harmonized"]:,.0f}</b> harmonized fire detections {area}, against a 2003–2025 normal of '
            f'<b>{tw["expected"]:,.0f}</b> for the same days — <b>{tw["delta_pct"]:+.0f}%</b>.</p>'
            f'<p style="margin:0 0 12px;line-height:1.55;color:{MUTED}">Season: {summary.get("season", "—")} · the last two '
            f'full weeks rank in the {summary.get("percentile", 0):.0f}th percentile of all weeks since 2003.</p>'
            f'<p style="margin:18px 0 0">{_button(settings.SITE_URL, "See the burning calendar")}</p>')
    text = f"{title}\nThis week so far: {tw['harmonized']:,.0f} vs normal {tw['expected']:,.0f}.\n{settings.SITE_URL}\nUnsubscribe: {unsubscribe_url}"
    return f"📈 {title}", _page(title, body, unsubscribe_url), text


def result_page(title: str, message: str) -> str:
    """Small page shown after clicking confirm / unsubscribe links."""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)} · FireLens</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#04060c;color:#e8eefc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:16px">
<div style="max-width:440px;width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:28px">
<div style="font-size:18px;font-weight:700;margin-bottom:14px">🔥 FireLens</div>
<h1 style="font-size:22px;margin:0 0 10px">{html.escape(title)}</h1>
<p style="color:#9fb0cc;line-height:1.6;margin:0 0 20px">{message}</p>
<a href="{settings.SITE_URL}" style="display:inline-block;background:{ORANGE};color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:10px">Open FireLens</a>
</div></body></html>"""
