"""Tests for the live-sync WebSocket presence and broadcast logic.

The v2 sync protocol removed server-side block locks. These tests verify
presence messages, applied-op broadcast, and room isolation.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from app.features.collab import live_sync_ws as ws


class FakeWebSocket:
    """Minimal WebSocket stand-in that records sent JSON messages."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_text(self, text: str) -> None:
        self.sent.append(json.loads(text))


def make_conn(
    user_id: int, name: str = "User", protocol: str = "v1"
) -> ws._LiveSyncConnection:
    user: dict[str, Any] = {"id": user_id, "name": name}
    return ws._LiveSyncConnection(FakeWebSocket(), "room-1", user, protocol_version=protocol)


@pytest.fixture(autouse=True)
def _clean_state():
    """Reset live-sync connection state between tests."""
    ws._page_connections.clear()
    yield
    ws._page_connections.clear()


@pytest.mark.asyncio
async def test_broadcast_ops_sends_ops_applied():
    conn = make_conn(1, "Alice")
    ws._page_connections.setdefault("room-1", set()).add(conn)

    with patch.object(ws.collab_pubsub, "publish", new_callable=AsyncMock) as mock_publish:
        await ws.broadcast_ops("room-1", [{"node_uuid": "b1", "type": "update_content"}])

    assert any(m["type"] == "ops_applied" for m in conn.ws.sent)
    mock_publish.assert_awaited_once()


@pytest.mark.asyncio
async def test_focus_broadcasts_user_focus():
    alice = make_conn(1, "Alice")
    bob = make_conn(2, "Bob")
    ws._page_connections.setdefault("room-1", set()).add(alice)
    ws._page_connections.setdefault("room-1", set()).add(bob)

    with patch.object(ws.collab_pubsub, "publish", new_callable=AsyncMock):
        await ws._broadcast(
            "room-1",
            {
                "type": "user_focus",
                "block_uuid": "block-a",
                "user": {"id": 1, "name": "Alice", "color": "#ef4444"},
            },
            sender_id=1,
            exclude=alice,
        )

    assert not any(m["type"] == "user_focus" for m in alice.ws.sent)
    assert any(m["type"] == "user_focus" for m in bob.ws.sent)


@pytest.mark.asyncio
async def test_send_users_list_includes_focused_users():
    alice = make_conn(1, "Alice")
    bob = make_conn(2, "Bob")
    ws._page_connections.setdefault("room-1", set()).add(alice)
    ws._page_connections.setdefault("room-1", set()).add(bob)
    alice.focused_block = "block-a"

    await ws._send_users_list(bob)

    users_list = next((m for m in bob.ws.sent if m["type"] == "users_list"), None)
    assert users_list is not None
    assert len(users_list["users"]) == 1
    assert users_list["users"][0]["id"] == 1
    assert users_list["users"][0]["block_uuid"] == "block-a"


@pytest.mark.asyncio
async def test_room_isolation():
    room1_conn = make_conn(1, "Alice")
    room2_conn = make_conn(2, "Bob")
    ws._page_connections.setdefault("room-1", set()).add(room1_conn)
    ws._page_connections.setdefault("room-2", set()).add(room2_conn)

    with patch.object(ws.collab_pubsub, "publish", new_callable=AsyncMock):
        await ws._broadcast(
            "room-1",
            {
                "type": "user_focus",
                "block_uuid": "block-a",
                "user": {"id": 1, "name": "Alice"},
            },
            sender_id=1,
        )

    assert any(m["type"] == "user_focus" for m in room1_conn.ws.sent)
    assert not any(m["type"] == "user_focus" for m in room2_conn.ws.sent)
