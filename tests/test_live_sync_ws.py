"""Tests for the live-sync WebSocket locking and queue logic.

These tests exercise the internal state machine directly so we don't need a
full WebSocket transport.  They cover lock grants/denials, wait queues,
expiration, and hand-off.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from app.routers import live_sync_ws as ws


class FakeWebSocket:
    """Minimal WebSocket stand-in that records sent JSON messages."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_text(self, text: str) -> None:
        self.sent.append(json.loads(text))


def make_conn(user_id: int, name: str = "User") -> ws._LiveSyncConnection:
    user: dict[str, Any] = {"id": user_id, "name": name}
    return ws._LiveSyncConnection(FakeWebSocket(), "page-1", user)


def clear_state() -> None:
    """Reset all live-sync global state."""
    for timers in ws._lock_timers.values():
        for task in timers.values():
            if not task.done():
                try:
                    task.cancel()
                except RuntimeError:
                    # Event loop may already be closed during teardown.
                    pass
    ws._lock_timers.clear()
    ws._page_locks.clear()
    ws._lock_queues.clear()
    ws._page_connections.clear()


@pytest.fixture(autouse=True)
def _clean_state():
    clear_state()
    yield
    clear_state()


@pytest.mark.asyncio
async def test_lock_granted_for_free_block():
    conn = make_conn(1, "Alice")
    ws._page_connections.setdefault("page-1", set()).add(conn)

    granted = await ws._try_acquire_lock(conn, "page-1", "block-a")

    assert granted is True
    assert ws._page_locks["page-1"]["block-a"] is conn
    # Lock timer scheduled
    assert "block-a" in ws._lock_timers["page-1"]
    # Broadcast block_locked to other connections (none here) and sent to self
    assert any(m["type"] == "block_locked" for m in conn.ws.sent)


@pytest.mark.asyncio
async def test_lock_denied_and_queued_for_second_user():
    alice = make_conn(1, "Alice")
    bob = make_conn(2, "Bob")
    ws._page_connections.setdefault("page-1", set()).add(alice)
    ws._page_connections.setdefault("page-1", set()).add(bob)

    await ws._try_acquire_lock(alice, "page-1", "block-a")
    granted = await ws._try_acquire_lock(bob, "page-1", "block-a")

    assert granted is False
    assert ws._page_locks["page-1"]["block-a"] is alice
    assert bob in ws._lock_queues["page-1"]["block-a"]
    denied = next(m for m in bob.ws.sent if m["type"] == "block_lock_denied")
    assert denied["reason"] == "already_locked"
    assert denied["queued"] is True
    assert denied["locked_by"]["name"] == "Alice"


@pytest.mark.asyncio
async def test_release_hands_lock_to_queued_user():
    alice = make_conn(1, "Alice")
    bob = make_conn(2, "Bob")
    ws._page_connections.setdefault("page-1", set()).add(alice)
    ws._page_connections.setdefault("page-1", set()).add(bob)

    await ws._try_acquire_lock(alice, "page-1", "block-a")
    await ws._try_acquire_lock(bob, "page-1", "block-a")

    await ws._release_lock("page-1", "block-a", 1)

    assert ws._page_locks["page-1"]["block-a"] is bob
    assert "block-a" not in ws._lock_queues.get("page-1", {})
    assert bob.focused_block == "block-a"
    assert any(m["type"] == "lock_granted" for m in bob.ws.sent)
    assert any(m["type"] == "block_locked" for m in bob.ws.sent)


@pytest.mark.asyncio
async def test_release_broadcasts_when_no_waiters():
    alice = make_conn(1, "Alice")
    ws._page_connections.setdefault("page-1", set()).add(alice)

    await ws._try_acquire_lock(alice, "page-1", "block-a")
    await ws._release_lock("page-1", "block-a", 1)

    assert "page-1" not in ws._page_locks
    assert any(m["type"] == "block_lock_released" for m in alice.ws.sent)


@pytest.mark.asyncio
async def test_lock_expires_after_timeout():
    alice = make_conn(1, "Alice")
    ws._page_connections.setdefault("page-1", set()).add(alice)

    await ws._try_acquire_lock(alice, "page-1", "block-a")
    assert "block-a" in ws._page_locks.get("page-1", {})

    # Cancel the long-running timer and run the expiration directly.
    ws._cancel_lock_timer("page-1", "block-a")
    await ws._expire_lock("page-1", "block-a", 1)

    assert "page-1" not in ws._page_locks
    assert any(m["type"] == "lock_expired" for m in alice.ws.sent)


@pytest.mark.asyncio
async def test_disconnect_removes_from_wait_queue():
    alice = make_conn(1, "Alice")
    bob = make_conn(2, "Bob")
    ws._page_connections.setdefault("page-1", set()).add(alice)
    ws._page_connections.setdefault("page-1", set()).add(bob)

    await ws._try_acquire_lock(alice, "page-1", "block-a")
    await ws._try_acquire_lock(bob, "page-1", "block-a")
    assert bob in ws._lock_queues["page-1"]["block-a"]

    ws._page_connections["page-1"].discard(bob)
    ws._clear_connection_lock_requests(bob, "page-1")

    assert bob not in ws._lock_queues.get("page-1", {}).get("block-a", [])


@pytest.mark.asyncio
async def test_grant_queued_lock_skips_disconnected_users():
    alice = make_conn(1, "Alice")
    bob = make_conn(2, "Bob")
    carol = make_conn(3, "Carol")
    conns = ws._page_connections.setdefault("page-1", set())
    conns.add(alice)
    conns.add(bob)
    conns.add(carol)

    await ws._try_acquire_lock(alice, "page-1", "block-a")
    await ws._try_acquire_lock(bob, "page-1", "block-a")
    await ws._try_acquire_lock(carol, "page-1", "block-a")

    # Bob disconnects before Alice releases.
    conns.discard(bob)
    await ws._release_lock("page-1", "block-a", 1)

    assert ws._page_locks["page-1"]["block-a"] is carol
    assert bob not in ws._lock_queues.get("page-1", {}).get("block-a", [])
    assert any(m["type"] == "lock_granted" for m in carol.ws.sent)
    assert not any(m["type"] == "lock_granted" for m in bob.ws.sent)


@pytest.mark.asyncio
async def test_typing_message_refreshes_lock_timer():
    alice = make_conn(1, "Alice")
    ws._page_connections.setdefault("page-1", set()).add(alice)

    await ws._try_acquire_lock(alice, "page-1", "block-a")
    first_timer = ws._lock_timers["page-1"]["block-a"]

    # Simulate the typing handler: verify holder and re-schedule.
    locks = ws._page_locks.get("page-1", {})
    holder = locks.get("block-a")
    assert holder is not None and holder.user_id == 1
    ws._schedule_lock_expiration("page-1", "block-a", 1)

    second_timer = ws._lock_timers["page-1"]["block-a"]
    assert second_timer is not first_timer
    first_timer.cancel()
    second_timer.cancel()
