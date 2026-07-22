"""PostgreSQL-backed relay storage tests."""

from __future__ import annotations

import pytest

from app.core.clock import Hlc
from app.relay.models import EncryptedEnvelope
from app.relay.storage import PostgresRelayStorage

pytestmark = pytest.mark.unit


def _envelope(
    *,
    envelope_id: str,
    workspace_id: str,
    actor_id: str,
    hlc: Hlc,
    affected_node_ids: list[str] | None = None,
    op_type: str = "node.create",
    payload: dict | None = None,
) -> EncryptedEnvelope:
    return EncryptedEnvelope(
        id=envelope_id,
        workspace_id=workspace_id,
        actor_id=actor_id,
        hlc=hlc,
        affected_node_ids=affected_node_ids or [],
        op_type=op_type,
        payload=payload or {"nodeId": envelope_id, "kind": "page"},
    )


@pytest.fixture
def storage(db_pool) -> PostgresRelayStorage:
    return PostgresRelayStorage(db_pool)


class TestPostgresRelayStorage:
    @pytest.mark.asyncio
    async def test_save_and_retrieve_envelope(self, storage: PostgresRelayStorage) -> None:
        envelope = _envelope(
            envelope_id="env-1",
            workspace_id="ws-pg-1",
            actor_id="actor-1",
            hlc=Hlc(physical=10, logical=0),
        )

        assert await storage.envelope_exists(envelope.id) is False
        await storage.save_envelope(envelope)
        assert await storage.envelope_exists(envelope.id) is True

        results = await storage.get_catch_up(envelope.workspace_id, Hlc(physical=0, logical=0))
        assert len(results) == 1
        assert results[0].id == envelope.id
        assert results[0].payload == envelope.payload

    @pytest.mark.asyncio
    async def test_save_envelopes_bulk(self, storage: PostgresRelayStorage) -> None:
        envelopes = [
            _envelope(
                envelope_id=f"env-bulk-{i}",
                workspace_id="ws-bulk",
                actor_id="actor-1",
                hlc=Hlc(physical=i, logical=0),
            )
            for i in range(1, 11)
        ]
        await storage.save_envelopes(envelopes)
        assert await storage.count_operations("ws-bulk") == 10

    @pytest.mark.asyncio
    async def test_catch_up_only_returns_newer_envelopes(self, storage: PostgresRelayStorage) -> None:
        workspace_id = "ws-pg-catchup"
        older = _envelope(
            envelope_id="env-old",
            workspace_id=workspace_id,
            actor_id="actor-1",
            hlc=Hlc(physical=5, logical=0),
        )
        same = _envelope(
            envelope_id="env-same",
            workspace_id=workspace_id,
            actor_id="actor-1",
            hlc=Hlc(physical=10, logical=0),
        )
        newer = _envelope(
            envelope_id="env-new",
            workspace_id=workspace_id,
            actor_id="actor-1",
            hlc=Hlc(physical=10, logical=1),
        )
        other_workspace = _envelope(
            envelope_id="env-other",
            workspace_id="ws-other",
            actor_id="actor-1",
            hlc=Hlc(physical=20, logical=0),
        )

        await storage.save_envelopes([older, same, newer, other_workspace])

        results = await storage.get_catch_up(workspace_id, Hlc(physical=10, logical=0))
        assert [envelope.id for envelope in results] == [newer.id]

    @pytest.mark.asyncio
    async def test_catch_up_sorted_by_hlc_then_id(self, storage: PostgresRelayStorage) -> None:
        workspace_id = "ws-pg-sort"
        second = _envelope(
            envelope_id="env-b",
            workspace_id=workspace_id,
            actor_id="actor-1",
            hlc=Hlc(physical=20, logical=0),
        )
        first = _envelope(
            envelope_id="env-a",
            workspace_id=workspace_id,
            actor_id="actor-1",
            hlc=Hlc(physical=10, logical=5),
        )
        third = _envelope(
            envelope_id="env-c",
            workspace_id=workspace_id,
            actor_id="actor-1",
            hlc=Hlc(physical=20, logical=0),
        )

        await storage.save_envelopes([second, first, third])

        results = await storage.get_catch_up(workspace_id, Hlc(physical=0, logical=0))
        assert [envelope.id for envelope in results] == [first.id, second.id, third.id]

    @pytest.mark.asyncio
    async def test_duplicate_envelope_ignored_by_id(self, storage: PostgresRelayStorage) -> None:
        envelope = _envelope(
            envelope_id="env-1",
            workspace_id="ws-pg-dup",
            actor_id="actor-1",
            hlc=Hlc(physical=10, logical=0),
            payload={"nodeId": "env-1", "kind": "page"},
        )
        duplicate = _envelope(
            envelope_id="env-1",
            workspace_id="ws-pg-dup",
            actor_id="actor-1",
            hlc=Hlc(physical=99, logical=99),
            payload={"nodeId": "env-1", "kind": "block"},
        )

        await storage.save_envelope(envelope)
        await storage.save_envelope(duplicate)

        results = await storage.get_catch_up("ws-pg-dup", Hlc(physical=0, logical=0))
        assert len(results) == 1
        assert results[0].payload == envelope.payload

    @pytest.mark.asyncio
    async def test_get_catch_up_paginated(self, storage: PostgresRelayStorage) -> None:
        workspace_id = "ws-pg-page"
        envelopes = [
            _envelope(
                envelope_id=f"env-{i:02d}",
                workspace_id=workspace_id,
                actor_id="actor-1",
                hlc=Hlc(physical=i, logical=0),
            )
            for i in range(1, 6)
        ]
        await storage.save_envelopes(envelopes)

        start_hlc = Hlc(physical=0, logical=0)
        page, next_after_id = await storage.get_catch_up_paginated(
            workspace_id, start_hlc, limit=2
        )
        assert len(page) == 2
        assert next_after_id == page[-1].id

        page2, next_after_id2 = await storage.get_catch_up_paginated(
            workspace_id, start_hlc, limit=2, after_id=next_after_id
        )
        assert len(page2) == 2
        assert next_after_id2 == page2[-1].id

        page3, next_after_id3 = await storage.get_catch_up_paginated(
            workspace_id, start_hlc, limit=2, after_id=next_after_id2
        )
        assert len(page3) == 1
        assert next_after_id3 is None

    @pytest.mark.asyncio
    async def test_get_catch_up_paginated_detects_missing_after_id(
        self, storage: PostgresRelayStorage
    ) -> None:
        workspace_id = "ws-pg-missing-cursor"
        await storage.save_envelope(
            _envelope(
                envelope_id="env-a",
                workspace_id=workspace_id,
                actor_id="actor-1",
                hlc=Hlc(physical=1, logical=0),
            )
        )

        with pytest.raises(ValueError, match="no longer exists"):
            await storage.get_catch_up_paginated(
                workspace_id,
                Hlc(physical=0, logical=0),
                limit=2,
                after_id="does-not-exist",
            )

    @pytest.mark.asyncio
    async def test_get_catch_up_paginated_includes_concurrent_insert_with_smaller_id(
        self, storage: PostgresRelayStorage
    ) -> None:
        """A concurrent insert whose id sorts before the cursor id but whose HLC
        is ahead of the cursor must not be skipped across pages.
        """
        workspace_id = "ws-pg-race"
        first = _envelope(
            envelope_id="env-a",
            workspace_id=workspace_id,
            actor_id="actor-1",
            hlc=Hlc(physical=1, logical=0),
        )
        second = _envelope(
            envelope_id="env-b",
            workspace_id=workspace_id,
            actor_id="actor-1",
            hlc=Hlc(physical=2, logical=0),
        )
        await storage.save_envelopes([first, second])

        start_hlc = Hlc(physical=0, logical=0)
        page1, after1 = await storage.get_catch_up_paginated(
            workspace_id, start_hlc, limit=1
        )
        assert [envelope.id for envelope in page1] == [first.id]
        assert after1 == first.id

        # Inserted after page 1: HLC is ahead of the cursor so it belongs on
        # page 2, but its id is lexicographically smaller than the cursor id.
        concurrent = _envelope(
            envelope_id="env-concurrent",
            workspace_id=workspace_id,
            actor_id="actor-1",
            hlc=Hlc(physical=2, logical=0),
        )
        concurrent.id = "env-aa"
        await storage.save_envelope(concurrent)

        page2, after2 = await storage.get_catch_up_paginated(
            workspace_id, start_hlc, limit=10, after_id=after1
        )
        ids = [envelope.id for envelope in page2]
        assert concurrent.id in ids
        assert after2 is None

    @pytest.mark.asyncio
    async def test_count_operations_and_size_estimate(self, storage: PostgresRelayStorage) -> None:
        workspace_id = "ws-pg-metrics"
        envelopes = [
            _envelope(
                envelope_id=f"env-m-{i}",
                workspace_id=workspace_id,
                actor_id="actor-1",
                hlc=Hlc(physical=i, logical=0),
                payload={"nodeId": f"env-m-{i}", "data": "x"},
            )
            for i in range(3)
        ]
        await storage.save_envelopes(envelopes)

        assert await storage.count_operations(workspace_id) == 3
        assert await storage.count_operations("ws-missing") == 0
        size = await storage.get_operation_size_estimate(workspace_id)
        assert size > 0
        import json

        expected = sum(len(json.dumps(env.payload)) for env in envelopes)
        assert size == expected

    @pytest.mark.asyncio
    async def test_create_snapshot(self, storage: PostgresRelayStorage) -> None:
        workspace_id = "ws-pg-snapshot"
        snapshot_id = await storage.create_snapshot(
            workspace_id, Hlc(physical=100, logical=0)
        )
        assert isinstance(snapshot_id, str)
        assert len(snapshot_id) > 0

    @pytest.mark.asyncio
    async def test_create_compaction_segment_prunes_envelopes(
        self, storage: PostgresRelayStorage
    ) -> None:
        workspace_id = "ws-pg-compact"
        envelopes = [
            _envelope(
                envelope_id=f"env-c-{i}",
                workspace_id=workspace_id,
                actor_id="actor-1",
                hlc=Hlc(physical=i, logical=0),
            )
            for i in range(1, 6)
        ]
        await storage.save_envelopes(envelopes)

        result = await storage.create_compaction_segment(
            workspace_id,
            Hlc(physical=3, logical=0),
            prune=True,
            data=b"derived-state-bytes",
        )
        assert result["operation_count"] == 3
        assert len(result["snapshot_id"]) > 0
        assert len(result["segment_id"]) > 0

        remaining = await storage.count_operations(workspace_id)
        assert remaining == 2

        latest = await storage.get_latest_snapshot(workspace_id)
        assert latest is not None
        assert latest["data"] == b"derived-state-bytes"

    @pytest.mark.asyncio
    async def test_create_compaction_segment_refuses_prune_without_data(
        self, storage: PostgresRelayStorage
    ) -> None:
        workspace_id = "ws-pg-compact-no-data"
        await storage.save_envelope(
            _envelope(
                envelope_id="env-c-1",
                workspace_id=workspace_id,
                actor_id="actor-1",
                hlc=Hlc(physical=1, logical=0),
            )
        )

        with pytest.raises(ValueError, match="non-empty snapshot data"):
            await storage.create_compaction_segment(
                workspace_id, Hlc(physical=1, logical=0), prune=True
            )

        # No envelopes should have been pruned.
        assert await storage.count_operations(workspace_id) == 1

    @pytest.mark.asyncio
    async def test_create_snapshot_rejects_empty_data_when_pruned_operations_exist(
        self, storage: PostgresRelayStorage
    ) -> None:
        workspace_id = "ws-pg-empty-snapshot"
        await storage.save_envelope(
            _envelope(
                envelope_id="env-s-1",
                workspace_id=workspace_id,
                actor_id="actor-1",
                hlc=Hlc(physical=1, logical=0),
            )
        )
        await storage.create_compaction_segment(
            workspace_id,
            Hlc(physical=1, logical=0),
            prune=True,
            data=b"snapshot-bytes",
        )

        with pytest.raises(ValueError, match="non-empty"):
            await storage.create_snapshot(
                workspace_id, Hlc(physical=2, logical=0), data=b""
            )
