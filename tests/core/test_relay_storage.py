"""Unit tests for the SQLite relay storage adapter."""

from __future__ import annotations

import pytest

from app.core.clock import Hlc
from app.relay.models import EncryptedEnvelope
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
) -> EncryptedEnvelope:
    return EncryptedEnvelope(
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

        first_id = storage.create_snapshot(
            "ws-1", Hlc(physical=10, logical=0), data=b"first-snapshot"
        )
        second_id = storage.create_snapshot(
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
        assert latest["data"] == b"second-snapshot"
        assert latest["id"] != first_id

    async def test_get_latest_snapshot_returns_none_when_missing(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        assert storage.get_latest_snapshot("ws-missing") is None

    async def test_create_snapshot_stores_data_round_trip(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        payload = b"\x00\x01\x02serialized-database-bytes"

        snapshot_id = storage.create_snapshot(
            "ws-1", Hlc(physical=42, logical=1), data=payload
        )

        latest = storage.get_latest_snapshot("ws-1")
        assert latest is not None
        assert latest["id"] == snapshot_id
        assert latest["data"] == payload
        assert latest["hlc"] == Hlc(physical=42, logical=1)

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
    def test_get_catch_up_paginated_includes_concurrent_insert_with_smaller_id(
        self,
    ) -> None:
        """A concurrent insert whose id sorts before the cursor id but whose HLC
        is ahead of the cursor must not be skipped across pages.
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

        start_hlc = Hlc(physical=0, logical=0)
        page1, after1 = storage.get_catch_up_paginated(
            workspace_id, start_hlc, limit=1
        )
        assert [envelope.id for envelope in page1] == [first.id]
        assert after1 == first.id

        # Inserted after page 1: HLC is ahead of the cursor so it belongs on
        # page 2, but its id is lexicographically smaller than the cursor id.
        concurrent = _envelope(
            envelope_id="env-concurrent",
            workspace_id=workspace_id,
            hlc=Hlc(physical=2, logical=0),
        )
        concurrent.id = "env-aa"
        storage.save_envelope(concurrent)

        page2, after2 = storage.get_catch_up_paginated(
            workspace_id, start_hlc, limit=10, after_id=after1
        )
        ids = [envelope.id for envelope in page2]
        assert concurrent.id in ids
        assert after2 is None

    def test_get_catch_up_paginated_detects_missing_after_id(self) -> None:
        storage = SqliteRelayStorage(":memory:")
        storage.save_envelope(
            _envelope(
                envelope_id="env-a", workspace_id="ws-1", hlc=Hlc(physical=1, logical=0)
            )
        )

        with pytest.raises(ValueError, match="no longer exists"):
            storage.get_catch_up_paginated(
                "ws-1",
                Hlc(physical=0, logical=0),
                limit=2,
                after_id="missing",
            )


class TestSqliteRelayStorageCatchUp:
    def test_get_catch_up_filters_by_hlc_in_sql(self) -> None:
        """The HLC filter is pushed into SQL, not applied in Python."""
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

        results = storage.get_catch_up("ws-1", Hlc(physical=1, logical=0))
        assert [envelope.id for envelope in results] == ["env-new"]

    def test_get_catch_up_paginated_filters_by_hlc_in_sql(self) -> None:
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

        results, next_after_id = storage.get_catch_up_paginated(
            "ws-1", Hlc(physical=1, logical=0), limit=10
        )
        assert [envelope.id for envelope in results] == ["env-new"]
        assert next_after_id is None


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

        envelopes = storage.get_catch_up("ws-1", Hlc(0, 0))
        assert len(envelopes) == 1
        assert envelopes[0].timestamp.timestamp() == pytest.approx(1_700_000_000)
