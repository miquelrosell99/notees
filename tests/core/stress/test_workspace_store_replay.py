"""Stress tests for server-side WorkspaceStore replay and snapshot acceleration.

These tests generate thousands of operations, persist them through the relay,
close the store, and measure how long a fresh store takes to reach the same
derived state via ``sync()``. They also verify that snapshots reduce replay time
significantly.
"""

from __future__ import annotations

import os
import time

import pytest

from app.core.workspace_store import WorkspaceStore
from app.relay.storage import SqliteRelayStorage

pytestmark = [pytest.mark.unit, pytest.mark.stress]


class FixedKeyStorage:
    """In-memory key storage that returns a fixed 32-byte master key."""

    async def get_or_create_master_key(
        self, workspace_id: str, secret_key: str
    ) -> bytes:
        return b"0" * 32


async def _make_store(
    workspace_id: str,
    actor_id: str,
    relay_storage: SqliteRelayStorage,
) -> WorkspaceStore:
    return WorkspaceStore(
        workspace_id=workspace_id,
        actor_id=actor_id,
        relay_storage=relay_storage,
        db_path=":memory:",
        key_storage=FixedKeyStorage(),
    )


def _operation_count() -> int:
    """Return the operation count for this run.

    CI uses a modest count to keep the suite fast; larger counts can be run
    locally by setting ``NOTEES_STRESS_OPS``.
    """
    default = 2_000
    env = os.environ.get("NOTEES_STRESS_OPS")
    if env:
        return int(env)
    return default


def _replay_timeout_s(count: int) -> float:
    """Return a generous but CI-friendly replay bound for ``count`` ops."""
    # Linear interpolation: 1s for 1k ops, scaling up to ~5s for 10k ops.
    return max(2.0, 0.5 + count / 2_000)


class TestWorkspaceStoreReplay:
    async def test_replay_time_from_empty(self) -> None:
        """A fresh store syncs N operations within a reasonable time bound."""
        count = _operation_count()
        relay = SqliteRelayStorage(":memory:")
        writer = await _make_store("ws-replay", "actor-a", relay)

        for i in range(count):
            await writer.create_node(f"node-{i:06d}", "block")
        await writer.close()

        reader = await _make_store("ws-replay", "actor-b", relay)
        start = time.perf_counter()
        await reader.sync()
        elapsed = time.perf_counter() - start

        rows = await reader.query("SELECT COUNT(*) FROM node")
        assert rows[0][0] == count
        assert elapsed < _replay_timeout_s(count), (
            f"Replay of {count} ops took {elapsed:.3f}s "
            f"(bound {_replay_timeout_s(count):.3f}s)"
        )
        print(f"replay({count}) elapsed: {elapsed:.3f}s")
        await reader.close()

    async def test_replay_time_with_snapshot(self) -> None:
        """Snapshot restoration makes sync much faster for old operations."""
        count = _operation_count()
        relay = SqliteRelayStorage(":memory:")
        writer = await _make_store("ws-snapshot", "actor-a", relay)

        # Create initial batch and snapshot.
        half = count // 2
        for i in range(half):
            await writer.create_node(f"node-{i:06d}", "block")
        await writer.create_snapshot()

        # Add remaining operations after the snapshot.
        for i in range(half, count):
            await writer.create_node(f"node-{i:06d}", "block")
        await writer.close()

        reader = await _make_store("ws-snapshot", "actor-b", relay)
        start = time.perf_counter()
        await reader.sync()
        elapsed = time.perf_counter() - start

        rows = await reader.query("SELECT COUNT(*) FROM node")
        assert rows[0][0] == count

        # With a snapshot covering half the ops, replay should be materially
        # faster than replaying everything from scratch.
        full_bound = _replay_timeout_s(count)
        assert elapsed < full_bound * 0.75, (
            f"Snapshot-accelerated replay of {count} ops took {elapsed:.3f}s "
            f"(expected < {full_bound * 0.75:.3f}s)"
        )
        print(f"snapshot_replay({count}) elapsed: {elapsed:.3f}s")
        await reader.close()

    async def test_sync_is_idempotent_at_scale(self) -> None:
        """Repeated sync calls do not change derived state or duplicate rows."""
        count = min(_operation_count(), 1_000)
        relay = SqliteRelayStorage(":memory:")
        writer = await _make_store("ws-idempotent", "actor-a", relay)

        for i in range(count):
            await writer.create_node(f"node-{i:06d}", "block")
            if i % 100 == 0:
                await writer.set_property(
                    f"pv-{i:06d}", f"node-{i:06d}", "schema-1", {"text": f"v{i}"}
                )
        await writer.close()

        reader = await _make_store("ws-idempotent", "actor-b", relay)
        await reader.sync()
        await reader.sync()
        await reader.sync()

        node_rows = await reader.query("SELECT COUNT(*) FROM node")
        property_rows = await reader.query("SELECT COUNT(*) FROM property_value")
        applied_rows = await reader.query(
            "SELECT COUNT(*) FROM applied_operation_id"
        )
        property_count = (count - 1) // 100 + 1
        assert node_rows[0][0] == count
        assert property_rows[0][0] == property_count
        assert applied_rows[0][0] == count + property_count
        await reader.close()

    async def test_compaction_reduces_operation_count(self) -> None:
        """Compaction prunes old envelopes while keeping a snapshot record."""
        count = min(_operation_count(), 1_000)
        relay = SqliteRelayStorage(":memory:")
        writer = await _make_store("ws-compact", "actor-a", relay)

        for i in range(count):
            await writer.create_node(f"node-{i:06d}", "block")
        await writer.sync()

        # Create a real derived-state snapshot so clients can recover after
        # the old envelopes are pruned.
        await writer.create_snapshot()

        # Compact everything older than the highest relay HLC, reusing the
        # serialized derived-state bytes so the compaction snapshot is restorable.
        max_hlc = relay.get_max_hlc("ws-compact")
        latest_snapshot = relay.get_latest_snapshot("ws-compact")
        snapshot_data = latest_snapshot["data"] if latest_snapshot else b""
        result = relay.create_compaction_segment(
            "ws-compact", max_hlc, prune=True, data=snapshot_data
        )
        assert result["operation_count"] == count

        remaining = relay.count_operations("ws-compact")
        assert remaining == 0

        # A fresh reader restores from the snapshot and sees the full state.
        reader = await _make_store("ws-compact", "actor-b", relay)
        await reader.sync()
        node_rows = await reader.query("SELECT COUNT(*) FROM node")
        assert node_rows[0][0] == count
        await reader.close()
        await writer.close()
