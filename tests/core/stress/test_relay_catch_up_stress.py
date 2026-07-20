"""Stress tests for operation-log catch-up latency.

These tests seed a workspace with a large operation log and measure how long a
client that is N operations behind takes to catch up via the relay.
"""

from __future__ import annotations

import os
import time

import pytest

from app.core.clock import Hlc
from app.core.crypto import derive_workspace_key
from app.core.store import WorkspaceStore as CoreWorkspaceStore
from app.core.sync import SyncEngine
from app.core.transport import MemoryRelay, MemoryTransport
from app.relay.models import EncryptedEnvelope
from app.relay.permissions import StubPermissionChecker
from app.relay.service import RelayService
from app.relay.storage import SqliteRelayStorage

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
) -> list[EncryptedEnvelope]:
    """Generate deterministic encrypted envelopes and persist them."""
    import random

    rng = random.Random(SEED)
    key = derive_workspace_key(workspace_id, "x" * 32)
    from app.core.crypto import encrypt_operation_payload

    envelopes: list[EncryptedEnvelope] = []
    for i in range(count):
        payload = {"nodeId": f"node-{i:06d}", "kind": "block"}
        encrypted = encrypt_operation_payload(payload, key)
        envelope = EncryptedEnvelope(
            id=f"env-{workspace_id}-{i:08d}-{rng.randint(0, 1_000_000):06d}",
            workspace_id=workspace_id,
            actor_id=actor_id,
            hlc=Hlc(physical=i + 1, logical=0),
            affected_node_ids=[f"node-{i:06d}"],
            op_type="node.create",
            ciphertext=encrypted["ciphertext"],
            iv=encrypted["iv"],
        )
        envelopes.append(envelope)
    storage.save_envelopes(envelopes)
    return envelopes


class TestRelayCatchUpLatency:
    async def test_catch_up_from_hlc_zero(self) -> None:
        """A client at HLC zero catches up N operations within the bound."""
        count = _operation_count()
        storage = SqliteRelayStorage(":memory:")
        workspace_id = "ws-catch-up-zero"
        _seed_relay_storage(storage, workspace_id, "actor-a", count)
        service = RelayService(storage, StubPermissionChecker())

        start = time.perf_counter()
        results = await service.catch_up(
            workspace_id, "actor-b", Hlc(physical=0, logical=0)
        )
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
        envelopes = _seed_relay_storage(storage, workspace_id, "actor-a", count)
        service = RelayService(storage, StubPermissionChecker())

        # Pretend the client already has everything up to (count - delta).
        cursor = envelopes[count - delta - 1].hlc
        start = time.perf_counter()
        results = await service.catch_up(workspace_id, "actor-b", cursor)
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
        key = derive_workspace_key(workspace_id, "x" * 32)

        # Seed the relay through a local writer.
        import sqlite3

        writer_db = sqlite3.connect(":memory:")
        writer = CoreWorkspaceStore(writer_db, workspace_id, "actor-a")
        for i in range(count):
            writer.create_node(f"node-{i:06d}", kind="block")

        sync_a = SyncEngine(writer, key, MemoryTransport(relay, workspace_id))
        await sync_a.push()

        reader_db = sqlite3.connect(":memory:")
        reader = CoreWorkspaceStore(reader_db, workspace_id, "actor-b")
        sync_b = SyncEngine(reader, key, MemoryTransport(relay, workspace_id))

        start = time.perf_counter()
        await sync_b.pull()
        elapsed = time.perf_counter() - start

        node_rows = reader.get_db().execute("SELECT COUNT(*) FROM node").fetchone()
        assert node_rows[0] == count
        assert elapsed < _catch_up_timeout_s(count), (
            f"WorkspaceStore catch-up for {count} ops took {elapsed:.3f}s "
            f"(bound {_catch_up_timeout_s(count):.3f}s)"
        )
        print(f"workspace_store_catch_up({count}) elapsed: {elapsed:.3f}s")
