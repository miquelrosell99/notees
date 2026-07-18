"""Unit tests for the collab live-sync WebSocket Yjs path."""

from __future__ import annotations

import base64
import json
from collections.abc import Generator
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import WebSocketDisconnect

from app.core.workspace_store import WorkspaceStore
from app.features.collab import live_sync_ws as ws
from app.relay.key_storage import WorkspaceKeyStorage
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit


class FixedKeyStorage(WorkspaceKeyStorage):
    """In-memory key storage that returns a fixed 32-byte master key."""

    async def get_or_create_master_key(
        self, workspace_id: str, secret_key: str
    ) -> bytes:
        return b"0" * 32


async def _make_test_store(
    workspace_id: str = "ws-uuid-1",
    actor_id: str = "actor-1",
    db_path: str = ":memory:",
) -> WorkspaceStore:
    return WorkspaceStore(
        workspace_id=workspace_id,
        actor_id=actor_id,
        relay_storage=SqliteRelayStorage(":memory:"),
        db_path=db_path,
        key_storage=FixedKeyStorage(),
    )


@pytest.fixture(autouse=True)
def _clean_state() -> Generator[None, None, None]:
    """Reset live-sync connection state between tests."""
    ws._page_connections.clear()
    yield
    ws._page_connections.clear()


class FakeWebSocket:
    """Minimal WebSocket stand-in for the live-sync endpoint."""

    def __init__(self, messages: list[str]) -> None:
        self.cookies: dict[str, str] = {}
        self._messages = list(messages)
        self._accepted = False
        self.sent: list[dict[str, Any]] = []
        self._closed = False

    async def accept(self) -> None:
        self._accepted = True

    async def receive_text(self) -> str:
        if self._messages:
            return self._messages.pop(0)
        raise WebSocketDisconnect()

    async def send_text(self, text: str) -> None:
        self.sent.append(json.loads(text))

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self._closed = True





@pytest.mark.asyncio
async def test_yjs_update_message_persists_operation(
    monkeypatch: Any, tmp_path: Path
) -> None:
    """A yjs_update message is stored as an op and broadcast over the relay."""
    store = await _make_test_store(db_path=str(tmp_path / "derived.db"))
    await store.create_node("node-uuid-1", "page")
    await store.sync()

    monkeypatch.setattr(
        ws,
        "_authenticate_ws",
        AsyncMock(return_value={"id": 1, "uuid": "user-uuid-1", "name": "Test"}),
    )
    monkeypatch.setattr(
        ws, "_authorize_v2_room", AsyncMock(return_value=("ws-uuid-1", True))
    )
    monkeypatch.setattr(ws, "_make_workspace_store", lambda w, a: store)
    monkeypatch.setattr(ws.collab_pubsub, "publish", AsyncMock())

    broadcasts: list[Any] = []

    async def _fake_broadcast(room_id: str, envelope: Any) -> None:
        broadcasts.append(envelope)

    monkeypatch.setattr(ws, "relay_broadcast", _fake_broadcast)

    update = b"\x00\x01\x02yjs-ws"
    message = json.dumps(
        {
            "type": "yjs_update",
            "node_uuid": "node-uuid-1",
            "update_blob": base64.b64encode(update).decode("ascii"),
        }
    )
    fake_ws = FakeWebSocket([message])

    await ws.live_sync_websocket(fake_ws, "ws-uuid-1")  # type: ignore[arg-type]

    # The operation should be applied to derived state.
    rows = await store.query(
        "SELECT text_state FROM crdt_state WHERE node_id = ?",
        ("node-uuid-1",),
    )
    assert len(rows) == 1
    assert rows[0]["text_state"] == update

    # The encrypted envelope should have been broadcast over the relay.
    assert len(broadcasts) == 1
    assert broadcasts[0].op_type == "node.updateContent"
    assert broadcasts[0].workspace_id == "ws-uuid-1"

    await store.close()


@pytest.mark.asyncio
async def test_yjs_update_message_rejected_without_write_permission(
    monkeypatch: Any, tmp_path: Path
) -> None:
    """A read-only user cannot publish Yjs updates through the WebSocket."""
    store = await _make_test_store(db_path=str(tmp_path / "derived.db"))

    monkeypatch.setattr(
        ws,
        "_authenticate_ws",
        AsyncMock(return_value={"id": 1, "uuid": "user-uuid-1", "name": "Test"}),
    )
    monkeypatch.setattr(
        ws, "_authorize_v2_room", AsyncMock(return_value=("ws-uuid-1", False))
    )
    monkeypatch.setattr(ws, "_make_workspace_store", lambda w, a: store)
    monkeypatch.setattr(ws.collab_pubsub, "publish", AsyncMock())

    update = b"\x00\x01"
    message = json.dumps(
        {
            "type": "yjs_update",
            "node_uuid": "node-uuid-1",
            "update_blob": base64.b64encode(update).decode("ascii"),
        }
    )
    fake_ws = FakeWebSocket([message])

    await ws.live_sync_websocket(fake_ws, "ws-uuid-1")  # type: ignore[arg-type]

    # No operation should have been persisted.
    rows = await store.query("SELECT 1 FROM crdt_state WHERE node_id = ?", ("node-uuid-1",))
    assert len(rows) == 0

    await store.close()
