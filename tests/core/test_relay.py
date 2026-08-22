"""Unit tests for the operation relay server."""

from __future__ import annotations

import pytest

from app.core.clock import Hlc
from app.relay.models import BatchRequest, RelayEnvelope
from app.relay.permissions import PermissionDeniedError, StubPermissionChecker
from app.relay.service import RelayService
from app.relay.storage import PostgresRelayStorage, SqliteRelayStorage

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


class TestSqliteRelayStorage:
    def test_save_and_retrieve_envelope(self) -> None:
        storage = SqliteRelayStorage()
        envelope = _envelope(
            envelope_id="env-1",
            workspace_id="ws-1",
            actor_id="actor-1",
            hlc=Hlc(physical=10, logical=0),
        )

        assert storage.envelope_exists(envelope.id) is False
        storage.save_envelope(envelope)
        assert storage.envelope_exists(envelope.id) is True

        results = storage.get_catch_up(envelope.workspace_id, 0)
        assert len(results) == 1
        assert results[0].id == envelope.id
        assert results[0].payload == envelope.payload

    def test_catch_up_only_returns_newer_envelopes(self) -> None:
        storage = SqliteRelayStorage()
        workspace_id = "ws-1"
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
            workspace_id="ws-2",
            actor_id="actor-1",
            hlc=Hlc(physical=20, logical=0),
        )

        for envelope in (older, same, newer, other_workspace):
            storage.save_envelope(envelope)

        same_seq = storage.get_catch_up(workspace_id, 0)[1].seq
        results = storage.get_catch_up(workspace_id, same_seq)
        assert [envelope.id for envelope in results] == [newer.id]

    def test_catch_up_sorted_by_seq(self) -> None:
        """Catch-up order is the server-assigned seq (insertion order), not
        the client-supplied HLC."""
        storage = SqliteRelayStorage()
        workspace_id = "ws-1"
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

        for envelope in (second, first, third):
            storage.save_envelope(envelope)

        results = storage.get_catch_up(workspace_id, 0)
        assert [envelope.id for envelope in results] == [second.id, first.id, third.id]

    def test_duplicate_envelope_ignored_by_id(self) -> None:
        storage = SqliteRelayStorage()
        envelope = _envelope(
            envelope_id="env-1",
            workspace_id="ws-1",
            actor_id="actor-1",
            hlc=Hlc(physical=10, logical=0),
            payload={"nodeId": "env-1", "kind": "page"},
        )
        duplicate = _envelope(
            envelope_id="env-1",
            workspace_id="ws-1",
            actor_id="actor-1",
            hlc=Hlc(physical=99, logical=99),
            payload={"nodeId": "env-1", "kind": "block"},
        )

        storage.save_envelope(envelope)
        storage.save_envelope(duplicate)

        results = storage.get_catch_up("ws-1", 0)
        assert len(results) == 1
        assert results[0].payload == envelope.payload


class TestRelayService:
    @pytest.mark.asyncio
    async def test_receive_batch_saves_envelopes(self) -> None:
        storage = SqliteRelayStorage()
        service = RelayService(storage, StubPermissionChecker())
        envelope = _envelope(
            envelope_id="env-1",
            workspace_id="ws-1",
            actor_id="actor-1",
            hlc=Hlc(physical=10, logical=0),
        )

        saved = await service.receive_batch(BatchRequest(envelopes=[envelope]), "actor-1")

        assert [envelope.id for envelope in saved] == ["env-1"]
        assert storage.envelope_exists("env-1") is True

    @pytest.mark.asyncio
    async def test_receive_batch_deduplicates_existing_envelopes(self) -> None:
        storage = SqliteRelayStorage()
        service = RelayService(storage, StubPermissionChecker())
        first = _envelope(
            envelope_id="env-1",
            workspace_id="ws-1",
            actor_id="actor-1",
            hlc=Hlc(physical=10, logical=0),
        )
        second = _envelope(
            envelope_id="env-2",
            workspace_id="ws-1",
            actor_id="actor-1",
            hlc=Hlc(physical=10, logical=1),
        )

        await service.receive_batch(BatchRequest(envelopes=[first]), "actor-1")
        saved = await service.receive_batch(
            BatchRequest(envelopes=[first, second]),
            "actor-1",
        )

        assert [envelope.id for envelope in saved] == ["env-2"]
        assert len(storage.get_catch_up("ws-1", 0)) == 2

    @pytest.mark.asyncio
    async def test_receive_batch_allows_envelope_actor_id_to_differ_from_authenticated_actor(
        self,
    ) -> None:
        """Envelope actor ids are CRDT device identifiers and may differ from the
        authenticated user's id. Permission is checked against the authenticated
        actor, so a device-issued envelope from a permitted user is accepted.
        """
        storage = SqliteRelayStorage()
        service = RelayService(storage, StubPermissionChecker())
        envelope = _envelope(
            envelope_id="env-1",
            workspace_id="ws-1",
            actor_id="device-actor-1",
            hlc=Hlc(physical=10, logical=0),
        )

        saved = await service.receive_batch(BatchRequest(envelopes=[envelope]), "user-actor-1")

        assert [envelope.id for envelope in saved] == ["env-1"]
        assert storage.envelope_exists("env-1") is True

    @pytest.mark.asyncio
    async def test_receive_batch_rejects_write_permission_denied(self) -> None:
        storage = SqliteRelayStorage()

        class DenyWriteChecker(StubPermissionChecker):
            async def can_write(
                self,
                workspace_id: str,
                actor_id: str,
                affected_node_ids: list[str],
            ) -> bool:
                return False

        service = RelayService(storage, DenyWriteChecker())
        envelope = _envelope(
            envelope_id="env-1",
            workspace_id="ws-1",
            actor_id="actor-1",
            hlc=Hlc(physical=10, logical=0),
        )

        with pytest.raises(PermissionDeniedError):
            await service.receive_batch(BatchRequest(envelopes=[envelope]), "actor-1")

        assert storage.envelope_exists("env-1") is False

    @pytest.mark.asyncio
    async def test_catch_up_returns_newer_envelopes(self) -> None:
        storage = SqliteRelayStorage()
        service = RelayService(storage, StubPermissionChecker())
        old = _envelope(
            envelope_id="env-old",
            workspace_id="ws-1",
            actor_id="actor-1",
            hlc=Hlc(physical=5, logical=0),
        )
        new = _envelope(
            envelope_id="env-new",
            workspace_id="ws-1",
            actor_id="actor-1",
            hlc=Hlc(physical=10, logical=0),
        )

        await service.receive_batch(BatchRequest(envelopes=[old, new]), "actor-1")
        old_seq = (await service.catch_up("ws-1", "actor-1", 0))[0].seq
        results = await service.catch_up("ws-1", "actor-1", old_seq)

        assert [envelope.id for envelope in results] == [new.id]

    @pytest.mark.asyncio
    async def test_catch_up_rejects_read_permission_denied(self) -> None:
        storage = SqliteRelayStorage()

        class DenyReadChecker(StubPermissionChecker):
            async def can_read(self, workspace_id: str, actor_id: str) -> bool:
                return False

        service = RelayService(storage, DenyReadChecker())

        with pytest.raises(PermissionDeniedError):
            await service.catch_up("ws-1", "actor-1", 0)


class TestPostgresRelayStorage:
    def test_postgres_storage_can_be_instantiated(self) -> None:
        storage = PostgresRelayStorage()
        assert isinstance(storage, PostgresRelayStorage)


class TestRelayEnvelopeValidation:
    def test_rejects_unknown_op_type(self) -> None:
        with pytest.raises(ValueError):
            _envelope(
                envelope_id="env-1",
                workspace_id="ws-1",
                actor_id="actor-1",
                hlc=Hlc(physical=10, logical=0),
                op_type="node.unknown",
            )

    def test_rejects_negative_hlc(self) -> None:
        with pytest.raises(ValueError):
            RelayEnvelope(
                id="env-1",
                workspace_id="ws-1",
                actor_id="actor-1",
                hlc={"physical": -1, "logical": 0},
                op_type="node.create",
                payload={"nodeId": "env-1"},
            )
