"""Stress tests for operation-log catch-up latency.

These tests seed a workspace with a large operation log and measure how long a
client that is N operations behind takes to catch up via the relay.
"""

from __future__ import annotations

import os
import time

import pytest

from app.core.clock import Hlc
from app.core.sync import SyncEngine
from app.core.transport import MemoryRelay, MemoryTransport
from app.core.workspace_store import WorkspaceStore
from app.relay.models import RelayEnvelope
from app.relay.permissions import StubPermissionChecker
from app.relay.service import RelayService
from app.relay.storage import SqliteRelayStorage
from tests.core.fakes import FakeKeyStorage

pytestmark = [pytest.mark.unit, pytest.mark.stress]

SEED = 42


def _operation_count() -> int:
    """Return the operation count for catch-up stress tests."""
    default = 2_000
    env = os.environ.get("NOTEES_STRESS_OPS")
    if env:
        return int(env)
    return default


def _catch_up_timeout_s(count: int) -> float:
    """Return a generous catch-up bound for ``count`` ops."""
    return max(2.0, 0.5 + count / 2_000)


def _seed_relay_storage(
    storage: SqliteRelayStorage,
    workspace_id: str,
    actor_id: str,
    count: int,
) -> list[RelayEnvelope]:
    """Generate deterministic envelopes and persist them."""
    import random

    rng = random.Random(SEED)

    envelopes: list[RelayEnvelope] = []
    for i in range(count):
        payload = {"nodeId": f"node-{i:06d}", "kind": "block"}
        envelope = RelayEnvelope(
            id=f"env-{workspace_id}-{i:08d}-{rng.randint(0, 1_000_000):06d}",
            workspace_id=workspace_id,
            actor_id=actor_id,
            hlc=Hlc(physical=i + 1, logical=0),
            affected_node_ids=[f"node-{i:06d}"],
            op_type="node.create",
            payload=payload,
        )
        envelopes.append(envelope)
    storage.save_envelopes(envelopes)
    return envelopes


class TestRelayCatchUpLatency:
    async def test_catch_up_from_seq_zero(self) -> None:
        """A client at seq zero catches up N operations within the bound."""
        count = _operation_count()
        storage = SqliteRelayStorage(":memory:")
        workspace_id = "ws-catch-up-zero"
        _seed_relay_storage(storage, workspace_id, "actor-a", count)
        service = RelayService(storage, StubPermissionChecker())

        start = time.perf_counter()
        results = await service.catch_up(workspace_id, "actor-b", 0)
        elapsed = time.perf_counter() - start

        assert len(results) == count
        assert elapsed < _catch_up_timeout_s(count), (
            f"catch_up from zero for {count} ops took {elapsed:.3f}s "
            f"(bound {_catch_up_timeout_s(count):.3f}s)"
        )
        print(f"relay_catch_up_zero({count}) elapsed: {elapsed:.3f}s")

    async def test_catch_up_with_delta(self) -> None:
        """A client that is delta operations behind catches up quickly."""
        count = _operation_count()
        delta = min(count, 500)
        storage = SqliteRelayStorage(":memory:")
        workspace_id = "ws-catch-up-delta"
        _seed_relay_storage(storage, workspace_id, "actor-a", count)
        service = RelayService(storage, StubPermissionChecker())

        # Envelopes were seeded in order into a fresh store, so seqs are
        # 1..count; pretend the client already has everything up to
        # seq (count - delta).
        start = time.perf_counter()
        results = await service.catch_up(workspace_id, "actor-b", count - delta)
        elapsed = time.perf_counter() - start

        assert len(results) == delta
        # Catching up a small delta should be much faster than a full replay.
        assert elapsed < _catch_up_timeout_s(delta), (
            f"catch_up delta {delta} took {elapsed:.3f}s "
            f"(bound {_catch_up_timeout_s(delta):.3f}s)"
        )
        print(f"relay_catch_up_delta({delta}) elapsed: {elapsed:.3f}s")


class TestWorkspaceStoreCatchUpLatency:
    async def test_store_catch_up_from_empty(self) -> None:
        """A fresh core WorkspaceStore catches up N ops via MemoryTransport."""
        count = min(_operation_count(), 1_000)
        relay = MemoryRelay()
        workspace_id = "ws-store-catch-up"

        # Seed the relay through a local writer.
        writer = WorkspaceStore(
            workspace_id=workspace_id,
            actor_id="actor-a",
            db_path=":memory:",
            relay_storage=SqliteRelayStorage(":memory:"),
            key_storage=FakeKeyStorage(),
        )
        for i in range(count):
            await writer.create_node(f"node-{i:06d}", kind="block")

        sync_a = SyncEngine(writer, MemoryTransport(relay, workspace_id))
        await sync_a.push()

        reader = WorkspaceStore(
            workspace_id=workspace_id,
            actor_id="actor-b",
            db_path=":memory:",
            relay_storage=SqliteRelayStorage(":memory:"),
            key_storage=FakeKeyStorage(),
        )
        sync_b = SyncEngine(reader, MemoryTransport(relay, workspace_id))

        start = time.perf_counter()
        await sync_b.pull()
        elapsed = time.perf_counter() - start

        node_rows = await reader.query("SELECT COUNT(*) FROM node")
        assert node_rows[0][0] == count
        assert elapsed < _catch_up_timeout_s(count), (
            f"WorkspaceStore catch-up for {count} ops took {elapsed:.3f}s "
            f"(bound {_catch_up_timeout_s(count):.3f}s)"
        )
        print(f"workspace_store_catch_up({count}) elapsed: {elapsed:.3f}s")

        await writer.close()
        await reader.close()
