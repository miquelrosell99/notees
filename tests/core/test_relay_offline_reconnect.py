"""Offline -> reconnect tests for the local-first operation relay.

These tests model clients that queue edits while disconnected from the relay,
then reconnect and converge. They use the same in-memory ``WorkspaceStore`` and
``MemoryRelay`` stack as the convergence suite so they run without PostgreSQL.
"""

from __future__ import annotations

import sqlite3
from typing import Any

import pytest

from app.core.clock import Hlc
from app.core.crypto import derive_workspace_key
from app.core.store import WorkspaceStore
from app.core.sync import SyncEngine
from app.core.transport import MemoryRelay, MemoryTransport

pytestmark = pytest.mark.unit

WORKSPACE_ID = "ws-offline-0001"
ACTOR_A = "actor-a-0001"
ACTOR_B = "actor-b-0001"
SECRET = "x" * 32


def _make_db() -> sqlite3.Connection:
    return sqlite3.connect(":memory:")


def _make_store(conn: sqlite3.Connection, actor_id: str) -> WorkspaceStore:
    return WorkspaceStore(conn, WORKSPACE_ID, actor_id)


def _make_sync(store: WorkspaceStore, relay: MemoryRelay) -> SyncEngine:
    key = derive_workspace_key(WORKSPACE_ID, SECRET)
    transport = MemoryTransport(relay, WORKSPACE_ID)
    return SyncEngine(store, key, transport)


def _install_deterministic_clock(*stores: WorkspaceStore) -> None:
    from app.core.clock import max_hlc

    counter = {"physical": 1}
    base = {store.actor_id: 1000 * (i + 1) for i, store in enumerate(stores)}

    def _advance(store: WorkspaceStore) -> Hlc:
        counter["physical"] += 1
        phys = base[store.actor_id] + counter["physical"]
        return store._clock.advance(phys)  # noqa: SLF001

    def _update(store, received, physical_time):  # noqa: ARG001
        store._clock._last = max_hlc(store._clock._last, received)  # noqa: SLF001
        return store._clock._last  # noqa: SLF001

    for store in stores:
        store._advance_clock = lambda s=store: _advance(s)  # noqa: SLF001
        store._clock.update = lambda r, p, s=store: _update(s, r, p)  # noqa: SLF001


def _node_set(store: WorkspaceStore) -> set[str]:
    return {row["id"] for row in store.list_nodes()}


def _derived_state(store: WorkspaceStore) -> dict[str, Any]:
    nodes = {
        row["id"]: {
            "kind": row["kind"],
            "parent_id": row["parent_id"],
            "class_ids": sorted(row["class_ids"]),
            "content": row["content"],
        }
        for row in store.list_nodes()
    }
    children: dict[str, list[str]] = {}
    for node_id in nodes:
        kids = store.get_children(node_id)
        if kids:
            children[node_id] = kids
    return {"nodes": nodes, "children": children}


class TestOfflineReconnect:
    async def test_store_edits_while_disconnected_then_catches_up(self) -> None:
        relay = MemoryRelay()
        store = _make_store(_make_db(), ACTOR_A)
        _install_deterministic_clock(store)

        sync = _make_sync(store, relay)

        # Offline edits are queued locally.
        store.create_node("offline-node-1", kind="page")
        store.create_node("offline-node-2", kind="block")
        store.update_content(
            "offline-node-1",
            [{"type": "paragraph", "children": [{"type": "text", "text": "title"}]}],
        )

        # Locally visible before reconnect.
        assert _node_set(store) == {"offline-node-1", "offline-node-2"}
        assert store.get_node("offline-node-1")["content"][0]["children"][0]["text"] == "title"

        # Reconnect: push local ops to the relay and pull anything remote.
        # The simple in-memory relay echoes back the ops just pushed, so pulled
        # equals pushed even though no other client wrote to the workspace.
        pushed, pulled = await sync.sync_once()
        assert pushed == 3
        assert pulled == pushed

        # A second store coming online should receive the queued operations.
        store_late = _make_store(_make_db(), ACTOR_B)
        _install_deterministic_clock(store, store_late)
        sync_late = _make_sync(store_late, relay)
        await sync_late.sync_once()

        assert _node_set(store_late) == {"offline-node-1", "offline-node-2"}
        assert _derived_state(store) == _derived_state(store_late)

    async def test_both_stores_edit_while_disconnected_then_converge(self) -> None:
        relay = MemoryRelay()
        store_a = _make_store(_make_db(), ACTOR_A)
        store_b = _make_store(_make_db(), ACTOR_B)
        _install_deterministic_clock(store_a, store_b)

        sync_a = _make_sync(store_a, relay)
        sync_b = _make_sync(store_b, relay)

        # Both stores create independent structures while offline.
        store_a.create_node("a-page", kind="page")
        store_a.create_node("a-block", kind="block")
        store_a.move_node("a-block", "a-page", 0)
        store_a.update_content(
            "a-page",
            [{"type": "paragraph", "children": [{"type": "text", "text": "A page"}]}],
        )

        store_b.create_node("b-page", kind="page")
        store_b.create_node("b-block", kind="block")
        store_b.move_node("b-block", "b-page", 0)
        store_b.update_content(
            "b-page",
            [{"type": "paragraph", "children": [{"type": "text", "text": "B page"}]}],
        )

        # Neither store has seen the other's edits yet.
        assert "b-page" not in _node_set(store_a)
        assert "a-page" not in _node_set(store_b)

        # Reconnect both and converge.
        await sync_a.sync_once()
        await sync_b.sync_once()
        await sync_a.sync_once()

        assert _node_set(store_a) == _node_set(store_b)
        assert _derived_state(store_a) == _derived_state(store_b)

        # Each store keeps its own page content.
        assert store_a.get_node("a-page")["content"][0]["children"][0]["text"] == "A page"
        assert store_b.get_node("a-page")["content"][0]["children"][0]["text"] == "A page"
        assert store_a.get_node("b-page")["content"][0]["children"][0]["text"] == "B page"
        assert store_b.get_node("b-page")["content"][0]["children"][0]["text"] == "B page"

        # Child order under each page is preserved.
        assert store_a.get_children("a-page") == ["a-block"]
        assert store_a.get_children("b-page") == ["b-block"]
        assert store_b.get_children("a-page") == ["a-block"]
        assert store_b.get_children("b-page") == ["b-block"]
