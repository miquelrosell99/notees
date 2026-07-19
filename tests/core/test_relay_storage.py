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
    ciphertext: str = "ZW5jcnlwdGVkLXN0dWI=",
    iv: str = "c3R1Yml2",
) -> EncryptedEnvelope:
    return EncryptedEnvelope(
        id=envelope_id,
        workspace_id=workspace_id,
        actor_id=actor_id,
        hlc=hlc,
        affected_node_ids=[],
        op_type=op_type,
        ciphertext=ciphertext,
        iv=iv,
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
