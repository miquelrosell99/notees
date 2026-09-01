"""Unit tests for the SQLite relay storage adapter."""

from __future__ import annotations

import pytest

from app.core.clock import Hlc
from app.relay.models import RelayEnvelope
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit


def _envelope(
    *,
    envelope_id: str,
    workspace_id: str,
    actor_id: str = "actor-1",
    hlc: Hlc,
    op_type: str = "node.create",
    payload: dict | None = None,
) -> RelayEnvelope:
    return RelayEnvelope(
        id=envelope_id,
        workspace_id=workspace_id,
        actor_id=actor_id,
        hlc=hlc,
        affected_node_ids=[],
        op_type=op_type,
        payload=payload or {"nodeId": envelope_id, "kind": "page"},
    )


class TestSqliteRelayStorageSnapshots:
    async def test_get_latest_snapshot_returns_newest_by_hlc(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        storage.save_envelope(
            _envelope(envelope_id="env-1", workspace_id="ws-1", hlc=Hlc(10, 0))
        )

        first_id, _ = storage.create_snapshot(
            "ws-1", Hlc(physical=10, logical=0), data=b"first-snapshot"
        )
        second_id, second_seq = storage.create_snapshot(
            "ws-1", Hlc(physical=20, logical=0), data=b"second-snapshot"
        )
        # An older snapshot inserted out of order should not be returned.
        storage.create_snapshot(
            "ws-1", Hlc(physical=5, logical=0), data=b"oldest-snapshot"
        )

        latest = storage.get_latest_snapshot("ws-1")
        assert latest is not None
        assert latest["id"] == second_id
        assert latest["hlc"] == Hlc(physical=20, logical=0)
        assert latest["up_to_seq"] == second_seq
        assert latest["data"] == b"second-snapshot"
        assert latest["id"] != first_id

    async def test_get_latest_snapshot_returns_none_when_missing(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        assert storage.get_latest_snapshot("ws-missing") is None

    async def test_get_latest_snapshot_metadata_omits_blob(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        storage.save_envelope(
            _envelope(envelope_id="env-1", workspace_id="ws-1", hlc=Hlc(10, 0))
        )
        snapshot_id, up_to_seq = storage.create_snapshot(
            "ws-1", Hlc(physical=10, logical=0), data=b"snapshot-blob"
        )

        metadata = storage.get_latest_snapshot_metadata("ws-1")
        assert metadata is not None
        assert metadata["id"] == snapshot_id
        assert metadata["hlc"] == Hlc(physical=10, logical=0)
        assert metadata["up_to_seq"] == up_to_seq
        assert "data" not in metadata

    async def test_get_latest_snapshot_metadata_returns_none_when_missing(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        assert storage.get_latest_snapshot_metadata("ws-missing") is None

    async def test_create_snapshot_stores_data_round_trip(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        payload = b"\x00\x01\x02serialized-database-bytes"

        snapshot_id, _ = storage.create_snapshot(
            "ws-1", Hlc(physical=42, logical=1), data=payload
        )

        latest = storage.get_latest_snapshot("ws-1")
        assert latest is not None
        assert latest["id"] == snapshot_id
        assert latest["data"] == payload
        assert latest["hlc"] == Hlc(physical=42, logical=1)

    async def test_create_snapshot_records_highest_covered_seq(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        storage.save_envelope(
            _envelope(envelope_id="env-1", workspace_id="ws-1", hlc=Hlc(10, 0))
        )
        storage.save_envelope(
            _envelope(envelope_id="env-2", workspace_id="ws-1", hlc=Hlc(20, 0))
        )

        # A snapshot at HLC (10, 0) covers only env-1.
        _, up_to_seq = storage.create_snapshot(
            "ws-1", Hlc(physical=10, logical=0), data=b"snapshot"
        )
        env_1 = storage.get_catch_up("ws-1", 0)[0]
        assert up_to_seq == env_1.seq

        latest = storage.get_latest_snapshot("ws-1")
        assert latest is not None
        assert latest["up_to_seq"] == up_to_seq

    async def test_get_max_hlc_returns_highest_envelope_hlc(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        assert storage.get_max_hlc("ws-1") == Hlc(0, 0)

        storage.save_envelope(
            _envelope(envelope_id="env-a", workspace_id="ws-1", hlc=Hlc(10, 0))
        )
        storage.save_envelope(
            _envelope(envelope_id="env-b", workspace_id="ws-1", hlc=Hlc(10, 5))
        )
        storage.save_envelope(
            _envelope(envelope_id="env-c", workspace_id="ws-1", hlc=Hlc(20, 0))
        )
        storage.save_envelope(
            _envelope(
                envelope_id="env-other",
                workspace_id="ws-2",
                hlc=Hlc(100, 0),
            )
        )

        assert storage.get_max_hlc("ws-1") == Hlc(20, 0)


class TestSqliteRelayStorageCompaction:
    def test_compaction_refuses_prune_without_data(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        storage.save_envelope(
            _envelope(
                envelope_id="env-1", workspace_id="ws-1", hlc=Hlc(physical=1, logical=0)
            )
        )

        with pytest.raises(ValueError, match="non-empty snapshot data"):
            storage.create_compaction_segment(
                "ws-1", Hlc(physical=1, logical=0), prune=True
            )

        assert storage.count_operations("ws-1") == 1

    def test_compaction_prunes_with_data(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        storage.save_envelope(
            _envelope(
                envelope_id="env-1", workspace_id="ws-1", hlc=Hlc(physical=1, logical=0)
            )
        )
        storage.save_envelope(
            _envelope(
                envelope_id="env-2", workspace_id="ws-1", hlc=Hlc(physical=2, logical=0)
            )
        )

        result = storage.create_compaction_segment(
            "ws-1",
            Hlc(physical=1, logical=0),
            prune=True,
            data=b"snapshot-bytes",
        )
        assert result["operation_count"] == 1
        assert storage.count_operations("ws-1") == 1

        latest = storage.get_latest_snapshot("ws-1")
        assert latest is not None
        assert latest["data"] == b"snapshot-bytes"

    def test_create_snapshot_rejects_empty_data_when_pruned_operations_exist(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        storage.save_envelope(
            _envelope(
                envelope_id="env-1", workspace_id="ws-1", hlc=Hlc(physical=1, logical=0)
            )
        )
        storage.create_compaction_segment(
            "ws-1",
            Hlc(physical=1, logical=0),
            prune=True,
            data=b"snapshot-bytes",
        )

        with pytest.raises(ValueError, match="non-empty"):
            storage.create_snapshot("ws-1", Hlc(physical=2, logical=0), data=b"")


class TestSqliteRelayStoragePagination:
    def test_get_catch_up_paginated_by_seq_includes_concurrent_insert(self) -> None:
        """A concurrent insert after a page boundary always lands on a later
        page: the seq cursor is assigned at insert time, so a new envelope is
        strictly after any previously returned cursor — regardless of its id
        or client-supplied HLC.
        """
        storage = SqliteRelayStorage(":memory:")
        workspace_id = "ws-race"
        first = _envelope(
            envelope_id="env-a", workspace_id=workspace_id, hlc=Hlc(physical=1, logical=0)
        )
        second = _envelope(
            envelope_id="env-b", workspace_id=workspace_id, hlc=Hlc(physical=2, logical=0)
        )
        storage.save_envelopes([first, second])

        page1, after1 = storage.get_catch_up_paginated(workspace_id, 0, limit=1)
        assert [envelope.id for envelope in page1] == [first.id]
        assert after1 == page1[-1].seq

        # Inserted after page 1 with an id and HLC that both sort before the
        # cursor envelope's — the seq cursor still picks it up on page 2.
        concurrent = _envelope(
            envelope_id="env-aa",
            workspace_id=workspace_id,
            hlc=Hlc(physical=1, logical=0),
        )
        storage.save_envelope(concurrent)

        page2, after2 = storage.get_catch_up_paginated(
            workspace_id, after1, limit=10
        )
        ids = [envelope.id for envelope in page2]
        assert ids == [second.id, concurrent.id]
        assert after2 is None

    def test_get_catch_up_paginated_tolerates_pruned_cursor(self) -> None:
        """A seq cursor below pruned rows still yields the remaining rows —
        no cursor lookup can fail because the cursor is a plain integer."""
        storage = SqliteRelayStorage(":memory:")
        storage.save_envelope(
            _envelope(
                envelope_id="env-a", workspace_id="ws-1", hlc=Hlc(physical=1, logical=0)
            )
        )
        storage.save_envelope(
            _envelope(
                envelope_id="env-b", workspace_id="ws-1", hlc=Hlc(physical=2, logical=0)
            )
        )
        storage.prune_envelopes("ws-1", Hlc(physical=1, logical=0))

        results, next_after_seq = storage.get_catch_up_paginated("ws-1", 1, limit=10)
        assert [envelope.id for envelope in results] == ["env-b"]
        assert next_after_seq is None

    def test_get_catch_up_paginated_pages_by_seq(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        envelopes = [
            _envelope(
                envelope_id=f"env-{i:02d}",
                workspace_id="ws-1",
                hlc=Hlc(physical=i, logical=0),
            )
            for i in range(1, 6)
        ]
        storage.save_envelopes(envelopes)

        page1, after1 = storage.get_catch_up_paginated("ws-1", 0, limit=2)
        assert [envelope.id for envelope in page1] == ["env-01", "env-02"]
        assert after1 == page1[-1].seq

        page2, after2 = storage.get_catch_up_paginated("ws-1", after1, limit=2)
        assert [envelope.id for envelope in page2] == ["env-03", "env-04"]
        assert after2 == page2[-1].seq

        page3, after3 = storage.get_catch_up_paginated("ws-1", after2, limit=2)
        assert [envelope.id for envelope in page3] == ["env-05"]
        assert after3 is None


class TestSqliteRelayStorageCatchUp:
    def test_get_catch_up_filters_by_seq_in_sql(self) -> None:
        """The seq filter is pushed into SQL, not applied in Python."""
        storage = SqliteRelayStorage(":memory:")
        storage.save_envelope(
            _envelope(
                envelope_id="env-old", workspace_id="ws-1", hlc=Hlc(physical=1, logical=0)
            )
        )
        storage.save_envelope(
            _envelope(
                envelope_id="env-new", workspace_id="ws-1", hlc=Hlc(physical=2, logical=0)
            )
        )

        old_seq = storage.get_catch_up("ws-1", 0)[0].seq
        results = storage.get_catch_up("ws-1", old_seq)
        assert [envelope.id for envelope in results] == ["env-new"]

    def test_get_catch_up_paginated_filters_by_seq_in_sql(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        storage.save_envelope(
            _envelope(
                envelope_id="env-old", workspace_id="ws-1", hlc=Hlc(physical=1, logical=0)
            )
        )
        storage.save_envelope(
            _envelope(
                envelope_id="env-new", workspace_id="ws-1", hlc=Hlc(physical=2, logical=0)
            )
        )

        old_seq = storage.get_catch_up("ws-1", 0)[0].seq
        results, next_after_seq = storage.get_catch_up_paginated(
            "ws-1", old_seq, limit=10
        )
        assert [envelope.id for envelope in results] == ["env-new"]
        assert next_after_seq is None


class TestSqliteRelayStorageSeq:
    def test_seq_is_monotonic_in_insert_order(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        # Insert out of HLC order: seq follows insertion order, not HLC.
        storage.save_envelope(
            _envelope(envelope_id="env-late", workspace_id="ws-1", hlc=Hlc(50, 0))
        )
        storage.save_envelope(
            _envelope(envelope_id="env-early", workspace_id="ws-1", hlc=Hlc(10, 0))
        )

        results = storage.get_catch_up("ws-1", 0)
        assert [envelope.id for envelope in results] == ["env-late", "env-early"]
        seqs = [envelope.seq for envelope in results]
        assert seqs == sorted(seqs)
        assert all(seq is not None and seq > 0 for seq in seqs)

    def test_dedupe_keeps_original_seq(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        envelope = _envelope(
            envelope_id="env-1", workspace_id="ws-1", hlc=Hlc(10, 0)
        )
        storage.save_envelope(envelope)
        original_seq = storage.get_catch_up("ws-1", 0)[0].seq

        # Re-submitting the same id is a no-op: the row (and its seq) is kept.
        duplicate = _envelope(
            envelope_id="env-1", workspace_id="ws-1", hlc=Hlc(99, 99)
        )
        storage.save_envelope(duplicate)
        storage.save_envelopes([duplicate])

        results = storage.get_catch_up("ws-1", 0)
        assert len(results) == 1
        assert results[0].seq == original_seq

    def test_get_latest_seq(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        assert storage.get_latest_seq("ws-1") == 0

        storage.save_envelope(
            _envelope(envelope_id="env-1", workspace_id="ws-1", hlc=Hlc(10, 0))
        )
        storage.save_envelope(
            _envelope(envelope_id="env-2", workspace_id="ws-1", hlc=Hlc(20, 0))
        )
        storage.save_envelope(
            _envelope(envelope_id="env-other", workspace_id="ws-2", hlc=Hlc(30, 0))
        )

        latest = storage.get_latest_seq("ws-1")
        assert latest == storage.get_catch_up("ws-1", 0)[-1].seq
        assert storage.get_latest_seq("ws-2") > latest

    def test_seq_not_reused_after_prune(self) -> None:
        """AUTOINCREMENT keeps seq monotonic even when the highest rows are pruned."""
        storage = SqliteRelayStorage(":memory:")
        for i in range(1, 4):
            storage.save_envelope(
                _envelope(
                    envelope_id=f"env-{i}", workspace_id="ws-1", hlc=Hlc(i, 0)
                )
            )
        max_before = storage.get_latest_seq("ws-1")
        storage.prune_envelopes("ws-1", Hlc(physical=3, logical=0))
        assert storage.count_operations("ws-1") == 0

        storage.save_envelope(
            _envelope(envelope_id="env-4", workspace_id="ws-1", hlc=Hlc(4, 0))
        )
        assert storage.get_latest_seq("ws-1") > max_before

    def test_existing_database_is_rebuilt_with_seq(self, tmp_path) -> None:
        """A pre-seq database keeps its rows; seqs are backfilled in the old
        (physical, logical, id) catch-up order."""
        import sqlite3

        db_path = tmp_path / "relay.db"
        conn = sqlite3.connect(db_path)
        conn.executescript(
            """
            CREATE TABLE relay_envelope (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                physical INTEGER NOT NULL,
                logical INTEGER NOT NULL,
                affected_node_ids TEXT NOT NULL DEFAULT '[]',
                op_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                timestamp TEXT,
                protocol_version INTEGER NOT NULL DEFAULT 1
            );
            """
        )
        conn.execute(
            """
            INSERT INTO relay_envelope (
                id, workspace_id, actor_id, physical, logical, op_type, payload
            ) VALUES ('env-b', 'ws-1', 'actor-1', 20, 0, 'node.create', '{}')
            """
        )
        conn.execute(
            """
            INSERT INTO relay_envelope (
                id, workspace_id, actor_id, physical, logical, op_type, payload
            ) VALUES ('env-a', 'ws-1', 'actor-1', 10, 0, 'node.create', '{}')
            """
        )
        conn.commit()
        conn.close()

        storage = SqliteRelayStorage(db_path)
        results = storage.get_catch_up("ws-1", 0)
        # env-a has the lower HLC, so the backfill assigns it the lower seq
        # and it now comes first in seq order.
        assert [envelope.id for envelope in results] == ["env-a", "env-b"]
        env_a, env_b = results[0], results[1]
        assert env_a.seq < env_b.seq
        # New inserts continue past the backfilled seqs.
        storage.save_envelope(
            _envelope(envelope_id="env-c", workspace_id="ws-1", hlc=Hlc(30, 0))
        )
        assert storage.get_catch_up("ws-1", 0)[-1].id == "env-c"
        storage.close()


class TestSqliteRelayStorageBulkSave:
    def test_save_envelopes_returns_inserted_ids_and_skips_duplicates(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        first = _envelope(
            envelope_id="env-1", workspace_id="ws-1", hlc=Hlc(physical=1, logical=0)
        )
        second = _envelope(
            envelope_id="env-2", workspace_id="ws-1", hlc=Hlc(physical=2, logical=0)
        )

        inserted = storage.save_envelopes([first, second])
        assert inserted == ["env-1", "env-2"]

        inserted_again = storage.save_envelopes([first])
        assert inserted_again == []


class TestSqliteRelayStorageLegacyRows:
    def test_null_timestamp_falls_back_to_hlc_physical(self) -> None:
        """Legacy raw-SQL writers may insert rows with NULL timestamp; reading
        them must not crash — the HLC physical component (ms epoch) is the fallback."""
        storage = SqliteRelayStorage(":memory:")
        storage._connection.execute(
            """
            INSERT INTO relay_envelope (
                id, workspace_id, actor_id, physical, logical,
                affected_node_ids, op_type, payload, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                "env-legacy",
                "ws-1",
                "actor-1",
                1_700_000_000_000,
                0,
                "[]",
                "node.create",
                '{"nodeId": "env-legacy"}',
            ),
        )
        storage._connection.commit()

        envelopes = storage.get_catch_up("ws-1", 0)
        assert len(envelopes) == 1
        assert envelopes[0].timestamp.timestamp() == pytest.approx(1_700_000_000)
