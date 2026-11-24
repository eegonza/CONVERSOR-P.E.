from asyncio import Lock
from collections import deque
from dataclasses import dataclass, field
from secrets import compare_digest, token_urlsafe
from time import monotonic

from .supabase import Supabase


@dataclass
class Session:
    user_id: str
    access_token: str
    refresh_token: str
    token_expires: float
    last_seen: float
    absolute_expiry: float
    csrf: str = field(default_factory=lambda: token_urlsafe(32))
    lock: Lock = field(default_factory=Lock)

    def expired(self, now: float) -> bool:
        return now >= self.absolute_expiry or now >= self.last_seen + 30 * 60

    def accepts_csrf(self, header: str) -> bool:
        return header.isascii() and compare_digest(header, self.csrf)

    async def access(self, backend: Supabase) -> str:
        async with self.lock:
            if self.token_expires <= monotonic() + 30:
                response = await backend.refresh(self.refresh_token)
                self.access_token = response["access_token"]
                self.refresh_token = response["refresh_token"]
                self.token_expires = monotonic() + int(response["expires_in"])
            return self.access_token


class Sessions:
    def __init__(self):
        self.entries: dict[str, Session] = {}

    def new(self, payload: dict) -> tuple[str, Session]:
        now = monotonic()
        self.entries = {
            key: value for key, value in self.entries.items() if not value.expired(now)
        }
        if len(self.entries) >= 2048:
            oldest = min(self.entries, key=lambda key: self.entries[key].last_seen)
            del self.entries[oldest]
        key = token_urlsafe(32)
        session = Session(
            user_id=payload["user"]["id"],
            access_token=payload["access_token"],
            refresh_token=payload["refresh_token"],
            token_expires=now + int(payload["expires_in"]),
            last_seen=now,
            absolute_expiry=now + 8 * 60 * 60,
        )
        self.entries[key] = session
        return key, session

    def get(self, key: str) -> Session | None:
        value = self.entries.get(key)
        now = monotonic()
        if value and value.expired(now):
            self.remove(key)
            return None
        return value

    def remove(self, key: str) -> None:
        self.entries.pop(key, None)

    def remove_user(self, user_id: str) -> None:
        self.entries = {
            key: value
            for key, value in self.entries.items()
            if value.user_id != user_id
        }


class RateLimiter:
    def __init__(self):
        self.buckets: dict[tuple[str, str], deque[float]] = {}

    def hit(self, action: str, identity: str, capacity: int, period: int) -> int:
        now = monotonic()
        key = (action, identity)
        if len(self.buckets) >= 4096 and key not in self.buckets:
            self.buckets = {
                entry: hits
                for entry, hits in self.buckets.items()
                if hits and hits[-1] > now - 900
            }
            if len(self.buckets) >= 4096:
                return period
        bucket = self.buckets.setdefault(key, deque())
        while bucket and bucket[0] <= now - period:
            bucket.popleft()
        if len(bucket) >= capacity:
            return 1 + int(bucket[0] + period - now)
        bucket.append(now)
        return 0
