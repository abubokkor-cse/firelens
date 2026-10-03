"""
Where fire-alert subscriptions live. Firestore in production — private, and it survives restarts and scale-to-zero
(subscriber emails must never go to the public archive bucket); a local JSON file for development.

A subscription: id, email, name, area {name, country | bbox | lat, lon, radius_km}, types {strong_fire, min_frp_mw,
confirmed_fire, unusual, min_delta_pct}, frequency (instant | daily), status (pending | active), confirm_token,
unsubscribe_token, created, confirmed, last_sent, sent {location key → ISO date}, unusual_sent (year-week).
"""
import json
import os
import threading
from typing import Optional

from app.core.config import settings
from app.services.archive_store import DATA_DIR


class LocalStore:
    def __init__(self, path: str = os.path.join(DATA_DIR, "alerts.json")):
        self.path, self._lock = path, threading.Lock()

    def _load(self) -> dict:
        if not os.path.exists(self.path):
            return {}
        with open(self.path) as f:
            return json.load(f)

    def _save(self, subs: dict) -> None:
        with open(self.path + ".part", "w") as f:
            json.dump(subs, f, indent=1)
        os.replace(self.path + ".part", self.path)

    def add(self, sub: dict) -> None:
        with self._lock:
            subs = self._load()
            subs[sub["id"]] = sub
            self._save(subs)

    def get(self, sid: str) -> Optional[dict]:
        with self._lock:
            return self._load().get(sid)

    def find(self, field: str, value) -> Optional[dict]:
        with self._lock:
            return next((s for s in self._load().values() if s.get(field) == value), None)

    def update(self, sid: str, fields: dict) -> None:
        with self._lock:
            subs = self._load()
            if sid in subs:
                subs[sid].update(fields)
                self._save(subs)

    def delete(self, sid: str) -> None:
        with self._lock:
            subs = self._load()
            subs.pop(sid, None)
            self._save(subs)

    def active(self) -> list:
        with self._lock:
            return [s for s in self._load().values() if s.get("status") == "active"]

    def count_email(self, email: str) -> int:
        with self._lock:
            return sum(1 for s in self._load().values() if s.get("email") == email)


class FirestoreStore:
    def __init__(self, collection: str = "alert_subscriptions"):
        from google.cloud import firestore
        from google.cloud.firestore_v1.base_query import FieldFilter
        self.col, self._eq = firestore.Client().collection(collection), lambda f, v: FieldFilter(f, "==", v)

    def add(self, sub: dict) -> None:
        self.col.document(sub["id"]).set(sub)

    def get(self, sid: str) -> Optional[dict]:
        d = self.col.document(sid).get()
        return d.to_dict() if d.exists else None

    def find(self, field: str, value) -> Optional[dict]:
        docs = list(self.col.where(filter=self._eq(field, value)).limit(1).stream())
        return docs[0].to_dict() if docs else None

    def update(self, sid: str, fields: dict) -> None:
        self.col.document(sid).update(fields)

    def delete(self, sid: str) -> None:
        self.col.document(sid).delete()

    def active(self) -> list:
        return [d.to_dict() for d in self.col.where(filter=self._eq("status", "active")).stream()]

    def count_email(self, email: str) -> int:
        return sum(1 for _ in self.col.where(filter=self._eq("email", email)).stream())


_store = None


def store():
    global _store
    if _store is None:
        _store = FirestoreStore() if settings.ALERTS_STORE == "firestore" else LocalStore()
    return _store
