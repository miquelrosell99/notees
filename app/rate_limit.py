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

    def __init__(self, rates: list[Rate]) -> None:
        super().__init__()
        self._rates = rates
        self._buckets: dict[str, InMemoryBucket] = {}
        self._clock = MonotonicClock()

    def wrap_item(self, name: str, weight: int = 1) -> RateItem:
        return RateItem(name, self._clock.now(), weight=weight)

    def get(self, item: RateItem) -> InMemoryBucket:
        key = item.name
        if key not in self._buckets:
            bucket = InMemoryBucket(self._rates)
            self._buckets[key] = bucket
            self.schedule_leak(bucket)
        return self._buckets[key]


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


def per_ip_limiter(requests: int, duration: Duration) -> Limiter:
    """Build a per-IP limiter with the shared bucket factory."""
    return Limiter(PerKeyBucketFactory([Rate(requests, duration)]))
