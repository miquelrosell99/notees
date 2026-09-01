"""PostgreSQL-backed relay storage tests."""

from __future__ import annotations

import pytest

from app.core.clock import Hlc
from app.relay.models import RelayEnvelope
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
) -> RelayEnvelope:
    return RelayEnvelope(
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

        results = await storage.get_catch_up(envelope.workspace_id, 0)
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

        all_results = await storage.get_catch_up(workspace_id, 0)
        same_seq = next(e.seq for e in all_results if e.id == same.id)
        results = await storage.get_catch_up(workspace_id, same_seq)
        assert [envelope.id for envelope in results] == [newer.id]

    @pytest.mark.asyncio
    async def test_catch_up_sorted_by_seq(self, storage: PostgresRelayStorage) -> None:
        """Catch-up order is the server-assigned seq (insertion order), not
        the client-supplied HLC."""
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

        results = await storage.get_catch_up(workspace_id, 0)
        assert [envelope.id for envelope in results] == [second.id, first.id, third.id]

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

        results = await storage.get_catch_up("ws-pg-dup", 0)
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

        page, next_after_seq = await storage.get_catch_up_paginated(
            workspace_id, 0, limit=2
        )
        assert len(page) == 2
        assert next_after_seq == page[-1].seq

        page2, next_after_seq2 = await storage.get_catch_up_paginated(
            workspace_id, next_after_seq, limit=2
        )
        assert len(page2) == 2
        assert next_after_seq2 == page2[-1].seq

        page3, next_after_seq3 = await storage.get_catch_up_paginated(
            workspace_id, next_after_seq2, limit=2
        )
        assert len(page3) == 1
        assert next_after_seq3 is None

    @pytest.mark.asyncio
    async def test_get_catch_up_paginated_tolerates_pruned_cursor(
        self, storage: PostgresRelayStorage
    ) -> None:
        """A seq cursor below pruned rows still yields the remaining rows —
        no cursor lookup can fail because the cursor is a plain integer."""
        workspace_id = "ws-pg-pruned-cursor"
        await storage.save_envelopes(
            [
                _envelope(
                    envelope_id="env-a",
                    workspace_id=workspace_id,
                    actor_id="actor-1",
                    hlc=Hlc(physical=1, logical=0),
                ),
                _envelope(
                    envelope_id="env-b",
                    workspace_id=workspace_id,
                    actor_id="actor-1",
                    hlc=Hlc(physical=2, logical=0),
                ),
            ]
        )
        cursor = (await storage.get_catch_up(workspace_id, 0))[0].seq
        await storage.prune_envelopes(workspace_id, Hlc(physical=1, logical=0))

        results, next_after_seq = await storage.get_catch_up_paginated(
            workspace_id, cursor, limit=10
        )
        assert [envelope.id for envelope in results] == ["env-b"]
        assert next_after_seq is None

    @pytest.mark.asyncio
    async def test_get_catch_up_paginated_by_seq_includes_concurrent_insert(
        self, storage: PostgresRelayStorage
    ) -> None:
        """A concurrent insert after a page boundary always lands on a later
        page: the seq cursor is assigned at insert time, so a new envelope is
        strictly after any previously returned cursor — regardless of its id
        or client-supplied HLC.
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

        page1, after1 = await storage.get_catch_up_paginated(
            workspace_id, 0, limit=1
        )
        assert [envelope.id for envelope in page1] == [first.id]
        assert after1 == page1[-1].seq

        # Inserted after page 1 with an id and HLC that both sort before the
        # cursor envelope's — the seq cursor still picks it up on page 2.
        concurrent = _envelope(
            envelope_id="env-aa",
            workspace_id=workspace_id,
            actor_id="actor-1",
            hlc=Hlc(physical=1, logical=0),
        )
        await storage.save_envelope(concurrent)

        page2, after2 = await storage.get_catch_up_paginated(
            workspace_id, after1, limit=10
        )
        ids = [envelope.id for envelope in page2]
        assert ids == [second.id, concurrent.id]
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
        snapshot_id, up_to_seq = await storage.create_snapshot(
            workspace_id, Hlc(physical=100, logical=0)
        )
        assert isinstance(snapshot_id, str)
        assert len(snapshot_id) > 0
        # No envelopes in this workspace, so the snapshot covers seq 0.
        assert up_to_seq == 0

    @pytest.mark.asyncio
    async def test_get_latest_snapshot_metadata_omits_blob(
        self, storage: PostgresRelayStorage
    ) -> None:
        workspace_id = "ws-pg-snapshot-metadata"
        snapshot_id, up_to_seq = await storage.create_snapshot(
            workspace_id, Hlc(physical=100, logical=0), data=b"snapshot-blob"
        )

        metadata = await storage.get_latest_snapshot_metadata(workspace_id)
        assert metadata is not None
        assert metadata["id"] == snapshot_id
        assert metadata["hlc"] == Hlc(physical=100, logical=0)
        assert metadata["up_to_seq"] == up_to_seq
        assert "data" not in metadata

        # The full read still returns the blob for the same snapshot.
        latest = await storage.get_latest_snapshot(workspace_id)
        assert latest is not None
        assert latest["data"] == b"snapshot-blob"

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
