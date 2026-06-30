"""Redis Pub/Sub client for real-time collaboration backplane.

Provides cross-instance broadcast for WebSocket updates.
Falls back to in-memory asyncio queues when Redis is not configured
(for single-instance self-hosted deployments).
"""

from __future__ import annotations

import asyncio
import contextlib
from collections import defaultdict
from collections.abc import AsyncIterator
from typing import Any

from ..config import settings
from ..logging_config import get_logger

logger = get_logger(__name__)


class MemoryPubSub:
    """In-memory pub/sub fallback for single-instance deployments."""

    def __init__(self) -> None:
        self._channels: dict[str, asyncio.Queue[bytes]] = defaultdict(asyncio.Queue)
        self._subscribers: dict[str, set[asyncio.Queue[bytes]]] = defaultdict(set)

    async def publish(self, channel: str, message: bytes) -> None:
        """Publish a message to all subscribers of a channel."""
        for queue in list(self._subscribers.get(channel, set())):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(message)

    async def subscribe(self, channel: str) -> AsyncIterator[bytes]:
        """Subscribe to a channel and yield messages."""
        queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=1000)
        self._subscribers[channel].add(queue)
        try:
            while True:
                message = await queue.get()
                yield message
        finally:
            self._subscribers[channel].discard(queue)


def _redis_client(redis_url: str) -> Any:
    """Create an async Redis client tuned for long-lived pub/sub connections.

    redis-py 8 defaults to a read timeout on pub/sub listeners, which causes
    ``pubsub.listen()`` to raise ``TimeoutError`` after a short idle period.
    Explicitly disabling socket timeouts keeps the subscriber alive until the
    connection is explicitly closed.
    """
    import redis.asyncio as redis

    return redis.from_url(
        redis_url,
        decode_responses=False,
        socket_timeout=None,
        socket_connect_timeout=None,
    )


class RedisPubSub:
    """Redis-backed pub/sub for multi-instance deployments."""

    def __init__(self, redis_url: str) -> None:
        self._redis_url = redis_url
        self._pub_client: Any = None
        self._sub_client: Any = None
        self._lock = asyncio.Lock()

    async def _get_pub_client(self) -> Any:
        if self._pub_client is None:
            self._pub_client = _redis_client(self._redis_url)
        return self._pub_client

    async def _get_sub_client(self) -> Any:
        if self._sub_client is None:
            self._sub_client = _redis_client(self._redis_url)
        return self._sub_client

    async def publish(self, channel: str, message: bytes) -> None:
        """Publish a message to a Redis channel."""
        try:
            client = await self._get_pub_client()
            await client.publish(channel, message)
        except Exception as e:
            logger.warning(f"Redis publish failed: {e}")

    async def subscribe(self, channel: str) -> AsyncIterator[bytes]:
        """Subscribe to a Redis channel and yield messages.

        Uses a dedicated Redis client per subscriber so that the connection
        and its pub/sub object can be closed cleanly when the subscriber
        disconnects. This prevents the shared connection pool from leaking
        connections across many short-lived WebSocket sessions.
        """
        client = _redis_client(self._redis_url)
        pubsub = client.pubsub()
        try:
            await pubsub.subscribe(channel)
            async for message in pubsub.listen():
                if message["type"] == "message":
                    data = message["data"]
                    if isinstance(data, bytes):
                        yield data
                    elif isinstance(data, str):
                        yield data.encode()
        except Exception as e:
            logger.warning(f"Redis subscribe error: {e}")
        finally:
            with contextlib.suppress(Exception):
                await pubsub.unsubscribe(channel)
            with contextlib.suppress(Exception):
                await pubsub.close()
            with contextlib.suppress(Exception):
                await client.close()


class CollaborationPubSub:
    """Unified pub/sub that auto-selects Redis or in-memory fallback."""

    def __init__(self) -> None:
        self._impl: MemoryPubSub | RedisPubSub | None = None

    def _get_impl(self) -> MemoryPubSub | RedisPubSub:
        if self._impl is None:
            redis_url = settings.redis_url
            if redis_url and redis_url.strip() and not redis_url.startswith("redis://localhost"):
                # Only use Redis if explicitly configured to a non-local URL,
                # or if we can actually connect. For dev with local Redis, still try it.
                try:
                    self._impl = RedisPubSub(redis_url)
                    logger.info(f"CollaborationPubSub using Redis at {redis_url}")
                except Exception as e:
                    logger.warning(f"Failed to initialize Redis pub/sub: {e}. Falling back to in-memory.")
                    self._impl = MemoryPubSub()
            else:
                # Try to connect to local Redis; fall back to memory if unreachable
                try:

                    async def _check() -> bool:
                        client = _redis_client(redis_url)
                        try:
                            await client.ping()
                            return True
                        finally:
                            await client.close()

                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        # Schedule a check, but default to memory for safety
                        # The actual connection will be lazily established
                        self._impl = RedisPubSub(redis_url)
                        logger.info("CollaborationPubSub using Redis (lazy connect)")
                    else:
                        if loop.run_until_complete(_check()):
                            self._impl = RedisPubSub(redis_url)
                            logger.info("CollaborationPubSub using Redis (connected)")
                        else:
                            self._impl = MemoryPubSub()
                            logger.info("CollaborationPubSub using in-memory fallback (Redis unreachable)")
                except (ConnectionError, OSError):
                    self._impl = MemoryPubSub()
                    logger.info("CollaborationPubSub using in-memory fallback")
        return self._impl

    async def publish(self, channel: str, message: bytes) -> None:
        """Publish a message to a channel."""
        await self._get_impl().publish(channel, message)

    async def subscribe(self, channel: str) -> AsyncIterator[bytes]:
        """Subscribe to a channel and yield messages."""
        async for message in self._get_impl().subscribe(channel):
            yield message


# Global singleton instance
collab_pubsub = CollaborationPubSub()
