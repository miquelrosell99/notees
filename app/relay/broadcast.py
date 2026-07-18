"""In-memory broadcast registry for relay WebSocket subscribers.

A single-process, per-workspace fan-out used by the WebSocket endpoint to
forward saved operation envelopes to every connected client in real time.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import TYPE_CHECKING

from fastapi import WebSocketDisconnect

from app.logging_config import get_logger

if TYPE_CHECKING:
    from fastapi import WebSocket

    from app.relay.models import EncryptedEnvelope

logger = get_logger(__name__)

# workspace_id -> set of connected WebSocket objects
_registry: dict[str, set[WebSocket]] = {}

# Protects mutation of and iteration over the registry
_lock = asyncio.Lock()


def _get_connections(workspace_id: str) -> set[WebSocket]:
    """Return the connection set for ``workspace_id``, creating it if needed.

    This is a synchronous helper; callers must hold ``_lock`` when mutating
    the returned set.
    """
    if workspace_id not in _registry:
        _registry[workspace_id] = set()
    return _registry[workspace_id]


async def subscribe(workspace_id: str, websocket: WebSocket) -> None:
    """Add ``websocket`` to the subscriber list for ``workspace_id``."""
    async with _lock:
        _get_connections(workspace_id).add(websocket)


async def unsubscribe(workspace_id: str, websocket: WebSocket) -> None:
    """Remove ``websocket`` from the subscriber list for ``workspace_id``."""
    async with _lock:
        connections = _registry.get(workspace_id)
        if connections is None:
            return
        connections.discard(websocket)
        if not connections:
            del _registry[workspace_id]


async def broadcast(workspace_id: str, envelope: EncryptedEnvelope) -> None:
    """Send ``envelope`` as JSON to every subscriber of ``workspace_id``.

    Disconnected or closing sockets are removed from the registry without
    interrupting delivery to the remaining subscribers.
    """
    message = envelope.model_dump(mode="json")

    async with _lock:
        connections = list(_registry.get(workspace_id, set()))

    stale: set[WebSocket] = set()
    for websocket in connections:
        with contextlib.suppress(WebSocketDisconnect, RuntimeError):
            await websocket.send_json(message)
            continue
        stale.add(websocket)

    if stale:
        async with _lock:
            connections = _registry.get(workspace_id)
            if connections is not None:
                connections -= stale
                if not connections:
                    del _registry[workspace_id]
