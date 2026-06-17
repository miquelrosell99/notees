"""Shared rate-limiting utilities.

Extracted from app.main so that router-specific limiters can reuse the same
per-IP bucket factory and identifier without creating a circular import.
"""

from fastapi import Request
from pyrate_limiter import Duration, Limiter, Rate
from pyrate_limiter.abstracts import BucketFactory, RateItem
from pyrate_limiter.buckets import InMemoryBucket
from pyrate_limiter.clocks import MonotonicClock


class PerKeyBucketFactory(BucketFactory):
    """Bucket factory that creates a separate InMemoryBucket per rate-limit key.

    The default pyrate_limiter ``SingleBucketFactory`` uses one shared bucket for
    *all* keys, which means every API endpoint and every user draws from the same
    global quota. For a React SPA that fires many parallel requests during normal
    browsing, a global 200 req/min limit is exhausted almost immediately.

    This factory isolates each key so that rate limits apply per-client (or per
    client+endpoint combination), preventing one user's navigation from blocking
    another and giving each key its own independent budget.
    """

    _instances: list["PerKeyBucketFactory"] = []

    def __init__(self, rates: list[Rate]) -> None:
        super().__init__()
        self._rates = rates
        self._buckets: dict[str, InMemoryBucket] = {}
        self._clock = MonotonicClock()
        PerKeyBucketFactory._instances.append(self)

    def wrap_item(self, name: str, weight: int = 1) -> RateItem:
        return RateItem(name, self._clock.now(), weight=weight)

    def get(self, item: RateItem) -> InMemoryBucket:
        key = item.name
        if key not in self._buckets:
            bucket = InMemoryBucket(self._rates)
            self._buckets[key] = bucket
            self.schedule_leak(bucket)
        return self._buckets[key]

    def reset(self) -> None:
        """Drop all in-memory buckets and stop the background leaker."""
        self._buckets.clear()
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
    """
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        ip = forwarded.split(",")[0].strip()
    elif request.client:
        ip = request.client.host
    else:
        ip = "127.0.0.1"
    return ip


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
