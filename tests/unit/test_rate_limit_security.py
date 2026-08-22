"""Security tests for the shared rate-limiting utilities.

Covers two abuse vectors:
- ``PerKeyBucketFactory`` keyed by attacker-controlled identifiers (auth
  endpoints key buckets by raw email/username) must not grow without bound.
- ``X-Forwarded-For`` must only be honored when the direct peer is a
  configured trusted proxy; otherwise clients could spoof it to bypass
  per-IP limits.
"""

from __future__ import annotations

import pytest
from fastapi import Request
from pyrate_limiter import Duration, Rate

from app.config import settings
from app.rate_limit import DEFAULT_MAX_BUCKETS, PerKeyBucketFactory, ip_only_identifier

pytestmark = pytest.mark.unit


def _make_request(client_host: str | None, headers: dict[str, str] | None = None) -> Request:
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/auth/login",
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
        "client": (client_host, 12345) if client_host else None,
    }
    return Request(scope)


class TestBucketEviction:
    async def test_buckets_evicted_lru_beyond_maxsize(self) -> None:
        """The bucket map never exceeds ``max_buckets``; the LRU entry is dropped."""
        factory = PerKeyBucketFactory([Rate(5, Duration.MINUTE)], max_buckets=3)
        try:
            for i in range(3):
                factory.get(factory.wrap_item(f"key-{i}"))
            assert len(factory._buckets) == 3

            # Touch key-0 so key-1 becomes the least-recently used entry.
            factory.get(factory.wrap_item("key-0"))
            factory.get(factory.wrap_item("key-3"))

            assert len(factory._buckets) == 3
            assert set(factory._buckets) == {"key-0", "key-2", "key-3"}
        finally:
            factory.reset()

    async def test_stale_buckets_evicted_by_ttl(self) -> None:
        """Buckets idle longer than the TTL are evicted on the next access."""
        factory = PerKeyBucketFactory([Rate(5, Duration.MINUTE)], bucket_ttl_seconds=60.0)
        try:
            factory.get(factory.wrap_item("old-key"))
            # Age the entry past the TTL.
            factory._last_access["old-key"] -= 120.0

            factory.get(factory.wrap_item("fresh-key"))

            assert "old-key" not in factory._buckets
            assert "fresh-key" in factory._buckets
        finally:
            factory.reset()

    async def test_evicted_buckets_are_deregistered_from_leaker(self) -> None:
        """Evicted buckets must not keep leaking (and holding memory) in the background."""
        factory = PerKeyBucketFactory([Rate(5, Duration.MINUTE)], max_buckets=2)
        try:
            factory.get(factory.wrap_item("key-0"))
            factory.get(factory.wrap_item("key-1"))
            evicted = factory._buckets["key-0"]

            factory.get(factory.wrap_item("key-2"))

            assert evicted not in factory.get_buckets()
        finally:
            factory.reset()

    async def test_defaults_are_bounded(self) -> None:
        factory = PerKeyBucketFactory([Rate(5, Duration.MINUTE)])
        try:
            assert factory._max_buckets == DEFAULT_MAX_BUCKETS
            assert 0 < DEFAULT_MAX_BUCKETS <= 100_000
        finally:
            factory.reset()


class TestForwardedForTrust:
    async def test_xff_ignored_when_no_trusted_proxies_configured(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Default config (empty trusted list) must never trust the header."""
        monkeypatch.setattr(settings, "trusted_proxy_ips", [])
        request = _make_request("203.0.113.10", {"X-Forwarded-For": "198.51.100.7"})
        assert await ip_only_identifier(request) == "203.0.113.10"

    async def test_xff_ignored_from_untrusted_peer(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, "trusted_proxy_ips", ["10.0.0.1"])
        request = _make_request("203.0.113.10", {"X-Forwarded-For": "198.51.100.7"})
        assert await ip_only_identifier(request) == "203.0.113.10"

    async def test_xff_honored_from_trusted_proxy(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, "trusted_proxy_ips", ["10.0.0.1"])
        request = _make_request("10.0.0.1", {"X-Forwarded-For": "198.51.100.7, 10.0.0.1"})
        assert await ip_only_identifier(request) == "198.51.100.7"

    async def test_falls_back_to_loopback_without_client(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, "trusted_proxy_ips", [])
        request = _make_request(None)
        assert await ip_only_identifier(request) == "127.0.0.1"
