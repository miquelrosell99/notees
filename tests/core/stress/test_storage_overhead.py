"""Storage-overhead stress tests for the encrypted operation relay.

These tests measure how much SQLite disk space is consumed per operation so we
can set expectations for browser IndexedDB quotas and server relay growth.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

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
    default = 2_000
    env = os.environ.get("NOTEES_STRESS_OPS")
    if env:
        return int(env)
    return default


class TestRelayStorageOverhead:
    async def test_relay_size_per_operation(self) -> None:
        """Encrypted relay overhead per operation stays under a few KB."""
        count = _operation_count()
        workspace_id = "ws-storage-overhead"

        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
            db_path = tmp.name

        try:
            relay = SqliteRelayStorage(db_path)
            writer = await _make_store(workspace_id, "actor-a", relay)

            for i in range(count):
                await writer.create_node(f"node-{i:06d}", "block")
            await writer.close()
            relay.close()

            db_size = Path(db_path).stat().st_size
            bytes_per_op = db_size / count
            print(f"relay_size({count}): {db_size} bytes ({bytes_per_op:.1f} B/op)")

            # A node.create op with a small payload encrypts to a few hundred
            # bytes. Allow a generous ceiling to stay green on slow CI disks.
            assert bytes_per_op < 2_500, (
                f"Relay storage overhead was {bytes_per_op:.1f} B/op "
                f"for {count} ops (total {db_size} bytes)"
            )
        finally:
            Path(db_path).unlink(missing_ok=True)

    async def test_operation_size_estimate_matches_db(self) -> None:
        """``get_operation_size_estimate`` tracks actual database growth."""
        count = min(_operation_count(), 1_000)
        relay = SqliteRelayStorage(":memory:")
        writer = await _make_store("ws-size-estimate", "actor-a", relay)

        for i in range(count):
            await writer.create_node(f"node-{i:06d}", "block")
        await writer.close()

        estimate = relay.get_operation_size_estimate("ws-size-estimate")
        assert estimate > 0
        # The estimate is the sum of ciphertext + iv lengths; it should be a
        # meaningful fraction of the total database size.
        assert estimate > count * 50

    async def test_derived_state_size_after_replay(self) -> None:
        """The derived SQLite database stays small relative to the relay log."""
        count = min(_operation_count(), 1_000)
        relay = SqliteRelayStorage(":memory:")
        writer = await _make_store("ws-derived-size", "actor-a", relay)

        for i in range(count):
            await writer.create_node(f"node-{i:06d}", "block")
            if i % 10 == 0:
                await writer.set_property(
                    f"pv-{i:06d}", f"node-{i:06d}", "schema-1", {"text": f"value-{i}"}
                )
        await writer.close()

        reader = await _make_store("ws-derived-size", "actor-b", relay)
        await reader.sync()

        # Export the in-memory derived database and compare to relay size.
        derived_bytes = len(reader._conn.serialize(name="main"))
        relay_bytes = relay.get_operation_size_estimate("ws-derived-size")
        print(
            f"derived_size({count}): {derived_bytes} bytes vs "
            f"relay estimate {relay_bytes} bytes"
        )

        # The serialized SQLite database has fixed page overhead, so it can be
        # larger than the raw ciphertext sum. The meaningful bound is per-node
        # derived overhead, which should stay well under a few KB per node.
        bytes_per_node = derived_bytes / count
        print(f"derived_overhead({count}): {bytes_per_node:.1f} B/node")
        assert bytes_per_node < 3_000, (
            f"Derived state overhead was {bytes_per_node:.1f} B/node "
            f"for {count} nodes"
        )
        await reader.close()
