"""Tests for the relay broadcast backend abstraction."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi import WebSocket

from app.core.clock import Hlc
from app.relay.broadcast import (
    MemoryBroadcastBackend,
    RedisBroadcastBackend,
    reset_broadcast_backend,
)
from app.relay.models import RelayEnvelope

pytestmark = pytest.mark.unit


def _envelope(
    envelope_id: str,
    workspace_id: str = "ws-1",
    actor_id: str = "actor-1",
) -> RelayEnvelope:
    return RelayEnvelope(
        id=envelope_id,
        workspace_id=workspace_id,
        actor_id=actor_id,
        hlc=Hlc(physical=1000, logical=0),
        affected_node_ids=["node-1"],
        op_type="node.create",
        payload={"nodeId": envelope_id},
        timestamp="2026-07-17T00:00:00Z",
    )


@pytest.fixture(autouse=True)
def _reset() -> None:
    reset_broadcast_backend()
    yield
    reset_broadcast_backend()


@pytest.mark.anyio
async def test_memory_backend_delivers_to_local_subscribers() -> None:
    backend = MemoryBroadcastBackend()
    ws = AsyncMock(spec=WebSocket)
    from app.relay.broadcast import _registry

    _registry["ws-1"] = {ws}
    envelope = _envelope("op-1")

    await backend.publish("ws-1", envelope.model_dump_json())

    ws.send_text.assert_awaited_once_with(envelope.model_dump_json())


@pytest.mark.anyio
async def test_memory_backend_no_subscribers_is_noop() -> None:
    backend = MemoryBroadcastBackend()
    envelope = _envelope("op-1")
    await backend.publish("ws-1", envelope.model_dump_json())


@pytest.mark.anyio
async def test_redis_backend_round_trips_between_instances() -> None:
    fakeredis = pytest.importorskip("fakeredis.aioredis")
    redis_a = fakeredis.FakeRedis()
    redis_b = fakeredis.FakeRedis()
    # Share the same underlying server so publishes from A are received by B.
    redis_b.connection_pool = redis_a.connection_pool

    backend_a = RedisBroadcastBackend("redis://localhost", _redis_client=redis_a)
    backend_b = RedisBroadcastBackend("redis://localhost", _redis_client=redis_b)

    ws_b = AsyncMock(spec=WebSocket)
    from app.relay.broadcast import _registry

    _registry["ws-1"] = {ws_b}
    await backend_b.subscribe("ws-1")
    await asyncio.sleep(0.05)

    envelope = _envelope("op-1")
    await backend_a.publish("ws-1", envelope.model_dump_json())

    # Give the listener task time to receive and deliver.
    for _ in range(50):
        if ws_b.send_text.await_count:
            break
        await asyncio.sleep(0.01)

    ws_b.send_text.assert_awaited_once_with(envelope.model_dump_json())

    await backend_b.unsubscribe("ws-1")
    task = backend_b._listener_task  # noqa: SLF001
    if task is not None and not task.done():
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


@pytest.mark.anyio
async def test_redis_backend_unsubscribe_stops_listening() -> None:
    fakeredis = pytest.importorskip("fakeredis.aioredis")
    redis = fakeredis.FakeRedis()
    backend = RedisBroadcastBackend("redis://localhost", _redis_client=redis)

    await backend.subscribe("ws-1")
    assert "ws-1" in backend._subscribed_workspaces  # noqa: SLF001
    await backend.unsubscribe("ws-1")
    assert "ws-1" not in backend._subscribed_workspaces  # noqa: SLF001
    assert backend._listener_task is None  # noqa: SLF001
