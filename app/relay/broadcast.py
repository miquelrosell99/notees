"""Broadcast backend for relay WebSocket subscribers.

Provides two implementations:

* :class:`MemoryBroadcastBackend` — single-process fan-out, used in tests and
  single-worker dev deployments.
* :class:`RedisBroadcastBackend` — Redis pub/sub fan-out, used in production so
  multiple Uvicorn workers can forward envelopes to every connected client.

The public API (``subscribe``, ``unsubscribe``, ``broadcast``) is unchanged so
``app/relay/websocket.py`` needs no modifications.
"""

from __future__ import annotations

import asyncio
import contextlib
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

from fastapi import WebSocketDisconnect

from app.config import settings
from app.logging_config import get_logger
from app.relay.models import WsOpsMessage

try:
    from redis.asyncio import Redis

    REDIS_AVAILABLE = True
except ImportError:  # pragma: no cover
    Redis = None  # type: ignore[assignment, misc]
    REDIS_AVAILABLE = False

if TYPE_CHECKING:
    from fastapi import WebSocket

    from app.relay.models import EncryptedEnvelope

logger = get_logger(__name__)

# workspace_id -> set of locally connected WebSocket objects
_registry: dict[str, set[WebSocket]] = {}

# Protects mutation of and iteration over the local registry
_lock = asyncio.Lock()


class BroadcastBackend(ABC):
    """Abstract broadcast backend."""

    @abstractmethod
    async def publish(self, workspace_id: str, message: str) -> None:
        """Publish a serialized envelope to the given workspace channel."""

    @abstractmethod
    async def subscribe(self, workspace_id: str) -> None:
        """Subscribe this process to the workspace channel."""

    @abstractmethod
    async def unsubscribe(self, workspace_id: str) -> None:
        """Unsubscribe this process from the workspace channel."""


class MemoryBroadcastBackend(BroadcastBackend):
    """In-process fan-out backend."""

    async def publish(self, workspace_id: str, message: str) -> None:
        await _deliver_local(workspace_id, message)

    async def subscribe(self, workspace_id: str) -> None:
        return

    async def unsubscribe(self, workspace_id: str) -> None:
        return


class RedisBroadcastBackend(BroadcastBackend):
    """Redis pub/sub fan-out backend for multi-worker deployments."""

    def __init__(self, redis_url: str, *, _redis_client: Redis | None = None) -> None:
        self._redis = _redis_client or Redis.from_url(redis_url, decode_responses=True)
        self._pubsub = self._redis.pubsub()
        self._listener_task: asyncio.Task[None] | None = None
        self._subscribed_workspaces: set[str] = set()
        self._lock = asyncio.Lock()

    @staticmethod
    def _channel(workspace_id: str) -> str:
        return f"notees:relay:{workspace_id}"

    async def subscribe(self, workspace_id: str) -> None:
        async with self._lock:
            if workspace_id in self._subscribed_workspaces:
                return
            await self._pubsub.subscribe(self._channel(workspace_id))
            self._subscribed_workspaces.add(workspace_id)
            if self._listener_task is None or self._listener_task.done():
                self._listener_task = asyncio.create_task(self._listen())

    async def unsubscribe(self, workspace_id: str) -> None:
        async with self._lock:
            if workspace_id not in self._subscribed_workspaces:
                return
            await self._pubsub.unsubscribe(self._channel(workspace_id))
            self._subscribed_workspaces.discard(workspace_id)
            if not self._subscribed_workspaces and self._listener_task is not None:
                self._listener_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._listener_task
                self._listener_task = None

    async def publish(self, workspace_id: str, message: str) -> None:
        await self._redis.publish(self._channel(workspace_id), message)

    async def _listen(self) -> None:
        try:
            async for msg in self._pubsub.listen():
                if msg.get("type") != "message":
                    continue
                channel = self._decode(msg.get("channel", ""))
                workspace_id = channel.rsplit(":", 1)[-1]
                data = self._decode(msg.get("data", ""))
                await _deliver_local(workspace_id, data)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Redis broadcast listener failed")

    @staticmethod
    def _decode(value: str | bytes) -> str:
        return value.decode() if isinstance(value, bytes) else value


_backend_instance: BroadcastBackend | None = None


async def get_broadcast_backend() -> BroadcastBackend:
    """Return the shared broadcast backend, lazily creating it.

    Redis is preferred when ``redis_url`` is set and reachable; otherwise the
    in-memory backend is used.
    """
    global _backend_instance
    if _backend_instance is None:
        if REDIS_AVAILABLE and settings.redis_url:
            try:
                backend = RedisBroadcastBackend(settings.redis_url)
                await backend._redis.ping()  # noqa: SLF001
                _backend_instance = backend
                logger.info("Using Redis pub/sub for WebSocket broadcasts")
            except Exception as exc:  # pragma: no cover
                logger.warning(
                    "Redis broadcast unavailable, falling back to memory: %s", exc
                )
                _backend_instance = MemoryBroadcastBackend()
        else:
            _backend_instance = MemoryBroadcastBackend()
    return _backend_instance


def _get_connections(workspace_id: str) -> set[WebSocket]:
    """Return the local connection set for ``workspace_id``.

    This is a synchronous helper; callers must hold ``_lock`` when mutating
    the returned set.
    """
    if workspace_id not in _registry:
        _registry[workspace_id] = set()
    return _registry[workspace_id]


async def _deliver_local(workspace_id: str, message: str) -> None:
    """Send ``message`` to every local subscriber of ``workspace_id``.

    Disconnected or closing sockets are removed from the registry without
    interrupting delivery to the remaining subscribers.
    """
    async with _lock:
        connections = list(_registry.get(workspace_id, set()))

    stale: set[WebSocket] = set()
    for websocket in connections:
        with contextlib.suppress(WebSocketDisconnect, RuntimeError):
            await websocket.send_text(message)
            continue
        stale.add(websocket)

    if stale:
        async with _lock:
            connections = _registry.get(workspace_id)
            if connections is not None:
                connections -= stale
                if not connections:
                    del _registry[workspace_id]


async def subscribe(workspace_id: str, websocket: WebSocket) -> None:
    """Add ``websocket`` to the local subscriber list and subscribe the process."""
    async with _lock:
        _get_connections(workspace_id).add(websocket)
    backend = await get_broadcast_backend()
    await backend.subscribe(workspace_id)


async def unsubscribe(workspace_id: str, websocket: WebSocket) -> None:
    """Remove ``websocket`` and unsubscribe the process if it was the last one."""
    async with _lock:
        connections = _registry.get(workspace_id)
        if connections is None:
            return
        connections.discard(websocket)
        if not connections:
            del _registry[workspace_id]
    backend = await get_broadcast_backend()
    await backend.unsubscribe(workspace_id)


async def broadcast(workspace_id: str, envelopes: list[EncryptedEnvelope]) -> None:
    """Send a batch of envelopes to every subscriber of ``workspace_id``.

    Envelopes go out as one typed ``ops`` message (camelCase wire format) per
    saved batch, not one bare frame per envelope — see protocol/SPEC.md §4.3.
    With the Redis backend this publishes to the workspace channel; local
    subscribers receive the message through the Redis listener. With the
    in-memory backend delivery happens directly.
    """
    if not envelopes:
        return
    message = WsOpsMessage(envelopes=envelopes).model_dump_json(by_alias=True)
    backend = await get_broadcast_backend()
    await backend.publish(workspace_id, message)


def reset_broadcast_backend() -> None:
    """Reset the shared backend and local registry. Intended for tests only."""
    global _backend_instance
    if _backend_instance is not None:
        if isinstance(_backend_instance, RedisBroadcastBackend):
            task = _backend_instance._listener_task  # noqa: SLF001
            if task is not None and not task.done():
                task.cancel()
        _backend_instance = None
    _registry.clear()
