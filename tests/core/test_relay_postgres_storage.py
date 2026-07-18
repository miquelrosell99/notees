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
    ciphertext: str = "ZW5jcnlwdGVkLXN0dWI=",
    iv: str = "c3R1Yml2",
) -> EncryptedEnvelope:
    return EncryptedEnvelope(
        id=envelope_id,
        workspace_id=workspace_id,
        actor_id=actor_id,
        hlc=hlc,
        affected_node_ids=affected_node_ids or [],
        op_type=op_type,
        ciphertext=ciphertext,
        iv=iv,
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
        assert results[0].ciphertext == envelope.ciphertext
        assert results[0].iv == envelope.iv

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
            ciphertext="Zmlyc3Q=",
            iv="aXYx",
        )
        duplicate = _envelope(
            envelope_id="env-1",
            workspace_id="ws-pg-dup",
            actor_id="actor-1",
            hlc=Hlc(physical=99, logical=99),
            ciphertext="c2Vjb25k",
            iv="aXYy",
        )

        await storage.save_envelope(envelope)
        await storage.save_envelope(duplicate)

        results = await storage.get_catch_up("ws-pg-dup", Hlc(physical=0, logical=0))
        assert len(results) == 1
        assert results[0].ciphertext == "Zmlyc3Q="

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

        page, next_after_id = await storage.get_catch_up_paginated(
            workspace_id, Hlc(physical=0, logical=0), limit=2
        )
        assert len(page) == 2
        assert next_after_id == page[-1].id

        page2, next_after_id2 = await storage.get_catch_up_paginated(
            workspace_id, Hlc(physical=0, logical=0), limit=2, after_id=next_after_id
        )
        assert len(page2) == 2
        assert next_after_id2 == page2[-1].id

        page3, next_after_id3 = await storage.get_catch_up_paginated(
            workspace_id, Hlc(physical=0, logical=0), limit=2, after_id=next_after_id2
        )
        assert len(page3) == 1
        assert next_after_id3 is None

    @pytest.mark.asyncio
    async def test_count_operations_and_size_estimate(self, storage: PostgresRelayStorage) -> None:
        workspace_id = "ws-pg-metrics"
        envelopes = [
            _envelope(
                envelope_id=f"env-m-{i}",
                workspace_id=workspace_id,
                actor_id="actor-1",
                hlc=Hlc(physical=i, logical=0),
                ciphertext="YQ==",
                iv="Yg==",
            )
            for i in range(3)
        ]
        await storage.save_envelopes(envelopes)

        assert await storage.count_operations(workspace_id) == 3
        assert await storage.count_operations("ws-missing") == 0
        size = await storage.get_operation_size_estimate(workspace_id)
        assert size > 0
        expected = sum(len(env.ciphertext) + len(env.iv) for env in envelopes)
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
            workspace_id, Hlc(physical=3, logical=0), prune=True
        )
        assert result["operation_count"] == 3
        assert len(result["snapshot_id"]) > 0
        assert len(result["segment_id"]) > 0

        remaining = await storage.count_operations(workspace_id)
        assert remaining == 2
