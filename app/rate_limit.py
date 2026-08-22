"""Shared rate-limiting utilities.

Extracted from app.main so that router-specific limiters can reuse the same
per-IP bucket factory and identifier without creating a circular import.
"""

import time

from fastapi import Request
from pyrate_limiter import Duration, Limiter, Rate
from pyrate_limiter.abstracts import BucketFactory, RateItem
from pyrate_limiter.buckets import InMemoryBucket
from pyrate_limiter.clocks import MonotonicClock

from app.config import settings
from app.features import auth as auth_module

# Default bounds for PerKeyBucketFactory. Auth endpoints key buckets by raw
# email/username from request bodies, so an unbounded map lets an attacker
# exhaust memory by spraying random identifiers. Buckets idle longer than the
# TTL are evicted; the map never grows past MAX_BUCKETS (LRU eviction).
DEFAULT_MAX_BUCKETS = 10_000
DEFAULT_BUCKET_TTL_SECONDS = 3_600.0


class PerKeyBucketFactory(BucketFactory):
    """Bucket factory that creates a separate InMemoryBucket per rate-limit key.

    The default pyrate_limiter ``SingleBucketFactory`` uses one shared bucket for
    *all* keys, which means every API endpoint and every user draws from the same
    global quota. For a React SPA that fires many parallel requests during normal
    browsing, a global 200 req/min limit is exhausted almost immediately.

    This factory isolates each key so that rate limits apply per-client (or per
    client+endpoint combination), preventing one user's navigation from blocking
    another and giving each key its own independent budget.

    The bucket map is bounded: entries idle longer than ``bucket_ttl_seconds``
    are evicted on the next access, and when the map is full the least-recently
    used bucket is dropped (and deregistered from the background leaker) before
    a new one is created.
    """

    _instances: list["PerKeyBucketFactory"] = []

    def __init__(
        self,
        rates: list[Rate],
        max_buckets: int = DEFAULT_MAX_BUCKETS,
        bucket_ttl_seconds: float = DEFAULT_BUCKET_TTL_SECONDS,
    ) -> None:
        super().__init__()
        self._rates = rates
        self._buckets: dict[str, InMemoryBucket] = {}
        self._last_access: dict[str, float] = {}
        self._max_buckets = max_buckets
        self._bucket_ttl_seconds = bucket_ttl_seconds
        self._clock = MonotonicClock()
        PerKeyBucketFactory._instances.append(self)

    def wrap_item(self, name: str, weight: int = 1) -> RateItem:
        return RateItem(name, self._clock.now(), weight=weight)

    def _drop(self, key: str) -> None:
        bucket = self._buckets.pop(key, None)
        self._last_access.pop(key, None)
        if bucket is not None:
            self.dispose(bucket)

    def _evict_stale(self, now: float) -> None:
        # ``_buckets`` is LRU-ordered, so stale entries are always at the front.
        stale_keys: list[str] = []
        for key in self._buckets:
            if now - self._last_access.get(key, 0.0) <= self._bucket_ttl_seconds:
                break
            stale_keys.append(key)
        for key in stale_keys:
            self._drop(key)

    def get(self, item: RateItem) -> InMemoryBucket:
        key = item.name
        now = time.monotonic()
        self._evict_stale(now)
        bucket = self._buckets.get(key)
        if bucket is None:
            while len(self._buckets) >= self._max_buckets:
                self._drop(next(iter(self._buckets)))
            bucket = InMemoryBucket(self._rates)
            self._buckets[key] = bucket
            self.schedule_leak(bucket)
        else:
            # Move to the end so iteration order reflects recency (LRU).
            self._buckets[key] = self._buckets.pop(key)
        self._last_access[key] = now
        return bucket

    def reset(self) -> None:
        """Drop all in-memory buckets and stop the background leaker."""
        self._buckets.clear()
        self._last_access.clear()
        if self._leaker is not None:
            self._leaker.close()
            self._leaker = None

    @classmethod
    def reset_all(cls) -> None:
        """Reset every registered factory. Useful for test isolation."""
        for instance in list(cls._instances):
            instance.reset()


async def ip_only_identifier(request: Request) -> str:
    """Return the client IP without the request path.

    The default ``fastapi_limiter`` identifier includes ``request.scope["path"]``,
    which creates a new bucket for every unique URL. In a note-taking app with
    many node-specific endpoints, that causes bucket proliferation and makes
    per-key limits hard to reason about.

    Using the IP alone keeps the bucket count bounded to the number of active
    clients while still isolating users from one another.

    ``X-Forwarded-For`` is honored only when the direct peer is listed in
    ``settings.trusted_proxy_ips``; otherwise the header is attacker-controlled
    and would let clients bypass per-IP limits by spoofing it.
    """
    peer_ip = request.client.host if request.client else "127.0.0.1"
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded and peer_ip in settings.trusted_proxy_ips:
        return forwarded.split(",")[0].strip()
    return peer_ip


async def _extract_auth_identifier(request: Request) -> str | None:
    """Extract username/email from JSON body or form data for auth endpoints."""
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        try:
            import json

            data = json.loads(await request.body())
            return data.get("email") or data.get("username")
        except Exception:
            return None
    elif "application/x-www-form-urlencoded" in content_type or "multipart/form-data" in content_type:
        try:
            form = await request.form()
            return form.get("email") or form.get("username")
        except Exception:
            return None
    return None


async def auth_identifier(request: Request) -> str:
    """Return a rate-limit key combining endpoint path and account identifier.

    For auth endpoints we want per-account limits in addition to the existing
    per-IP limits. The key includes the request path so each auth endpoint gets
    its own bucket, plus the username/email when available. When no identifier
    can be extracted, the client IP is used as a fallback so the bucket still
    isolates anonymous clients.
    """
    identifier = await _extract_auth_identifier(request)
    if identifier:
        return f"auth:{request.scope.get('path', request.url.path)}:{identifier.lower()}"
    ip = await ip_only_identifier(request)
    return f"auth:{request.scope.get('path', request.url.path)}:{ip}"


def per_ip_limiter(requests: int, duration: Duration) -> Limiter:
    """Build a per-IP limiter with the shared bucket factory."""
    return Limiter(PerKeyBucketFactory([Rate(requests, duration)]))


def auth_per_account_limiter(requests: int, duration: Duration) -> Limiter:
    """Build a per-account auth limiter with the shared bucket factory.

    The actual rate-limit key is produced by ``auth_identifier`` and includes
    the endpoint path, client IP, and the account email/username when available.
    """
    return Limiter(PerKeyBucketFactory([Rate(requests, duration)]))


async def user_identifier(request: Request) -> str:
    """Return a rate-limit key for the authenticated user, falling back to IP.

    Light-weight re-implementation of the auth resolution in ``get_current_user``
    so rate limiting can run before the full dependency chain. API keys and JWT
    cookies/headers are supported.
    """
    api_key = request.headers.get("X-API-Key")
    if api_key:
        user = await auth_module.authenticate_api_key(api_key)
        if user:
            return f"user:{user['id']}"

    jwt_token = request.cookies.get("access_token")
    auth_header = request.headers.get("Authorization", "")
    if auth_header.lower().startswith("bearer "):
        jwt_token = auth_header[7:]

    if jwt_token:
        payload = auth_module.decode_token(jwt_token)
        if payload:
            user_id = payload.get("user_id")
            if user_id:
                return f"user:{user_id}"

    return await ip_only_identifier(request)


def per_user_limiter(requests: int, duration: Duration) -> Limiter:
    """Build a per-user rate limiter keyed by authenticated user ID or IP."""
    return Limiter(PerKeyBucketFactory([Rate(requests, duration)]))
