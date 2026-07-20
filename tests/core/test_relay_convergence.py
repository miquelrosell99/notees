"""Multi-client convergence tests for the encrypted operation relay.

These tests exercise two independent ``WorkspaceStore`` instances connected
through a shared in-memory relay. They prove that sequential edits, interleaved
offline edits, and concurrent property writes converge to the same derived
state after sync.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.core.clock import Hlc
from app.core.operation import create_operation
from app.core.sync import SyncEngine
from app.core.transport import MemoryRelay, MemoryTransport
from app.core.workspace_store import WorkspaceStore
from app.relay.storage import SqliteRelayStorage
from tests.core.fakes import FakeKeyStorage

pytestmark = pytest.mark.unit

WORKSPACE_ID = "ws-convergence-0001"
ACTOR_A = "actor-a-0001"
ACTOR_B = "actor-b-0001"


def _make_store(actor_id: str) -> WorkspaceStore:
    return WorkspaceStore(
        workspace_id=WORKSPACE_ID,
        actor_id=actor_id,
        db_path=":memory:",
        relay_storage=SqliteRelayStorage(":memory:"),
        key_storage=FakeKeyStorage(),
    )


def _make_sync(store: WorkspaceStore, relay: MemoryRelay) -> SyncEngine:
    transport = MemoryTransport(relay, WORKSPACE_ID)
    return SyncEngine(store, transport)


def _install_deterministic_clock(*stores: WorkspaceStore) -> None:
    """Patch stores so local operations use deterministic, ordered HLCs.

    Each call to ``_advance_clock`` bumps a per-store logical counter while
    keeping the physical component unique per store. Remote operations are
    merged without jumping the clock to wall-clock time. This makes
    convergence assertions reproducible without relying on wall-clock timing.
    """
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


async def _node_set(store: WorkspaceStore) -> set[str]:
    return {row["id"] for row in await store.list_nodes()}


async def _derived_state(store: WorkspaceStore) -> dict[str, Any]:
    nodes = {
        row["id"]: {
            "kind": row["kind"],
            "parent_id": row["parent_id"],
            "class_ids": sorted(row["class_ids"]),
            "content": row["content"],
        }
        for row in await store.list_nodes()
    }
    children: dict[str, list[str]] = {}
    for node_id in nodes:
        kids = await store.get_children(node_id)
        if kids:
            children[node_id] = kids
    return {"nodes": nodes, "children": children}


class TestSequentialEdits:
    async def test_store_a_creates_store_b_receives(self) -> None:
        relay = MemoryRelay()
        store_a = _make_store(ACTOR_A)
        store_b = _make_store(ACTOR_B)
        _install_deterministic_clock(store_a, store_b)

        sync_a = _make_sync(store_a, relay)
        sync_b = _make_sync(store_b, relay)

        node_ids = [f"node-a-{i:03d}" for i in range(5)]
        for node_id in node_ids:
            await store_a.create_node(node_id, kind="block")

        await sync_a.sync_once()
        await sync_b.sync_once()

        assert await _node_set(store_b) == set(node_ids)
        for node_id in node_ids:
            assert (await store_b.get_node(node_id))["kind"] == "block"


class TestInterleavedOfflineEdits:
    async def test_both_create_move_delete_then_sync(self) -> None:
        relay = MemoryRelay()
        store_a = _make_store(ACTOR_A)
        store_b = _make_store(ACTOR_B)
        _install_deterministic_clock(store_a, store_b)

        sync_a = _make_sync(store_a, relay)
        sync_b = _make_sync(store_b, relay)

        # Both stores create nodes while disconnected.
        a_nodes = [f"a-{i}" for i in range(3)]
        b_nodes = [f"b-{i}" for i in range(3)]
        for node_id in a_nodes:
            await store_a.create_node(node_id, kind="block")
        for node_id in b_nodes:
            await store_b.create_node(node_id, kind="block")

        # Reconnect and sync both ways.
        await sync_a.sync_once()
        await sync_b.sync_once()
        await sync_a.sync_once()

        assert await _node_set(store_a) == await _node_set(store_b)
        assert await _node_set(store_a) == set(a_nodes + b_nodes)

        # Both stores mutate the now-shared tree while disconnected again.
        # A moves b-0 under a-0; B moves a-0 under b-0.
        # The last writer wins for each node independently.
        await store_a.move_node("b-0", "a-0", 0)
        await store_b.move_node("a-0", "b-0", 0)

        # B deletes a-1 while A deletes b-1.
        await store_a.delete_node("b-1")
        await store_b.delete_node("a-1")

        await sync_a.sync_once()
        await sync_b.sync_once()
        await sync_a.sync_once()

        assert await _node_set(store_a) == await _node_set(store_b)
        assert "a-1" not in await _node_set(store_a)
        assert "b-1" not in await _node_set(store_a)

        # Derived state (parent relationships and child order) must match.
        state_a = await _derived_state(store_a)
        state_b = await _derived_state(store_b)
        assert state_a == state_b


class TestPropertyConvergence:
    async def test_last_write_wins_per_hlc(self) -> None:
        relay = MemoryRelay()
        store_a = _make_store(ACTOR_A)
        store_b = _make_store(ACTOR_B)
        _install_deterministic_clock(store_a, store_b)

        sync_a = _make_sync(store_a, relay)
        sync_b = _make_sync(store_b, relay)

        await store_a.create_node("node-x", kind="block")
        await sync_a.sync_once()
        await sync_b.sync_once()

        # A writes first, B writes second (deterministic clock guarantees
        # B's HLC is later, so B wins).
        await store_a.set_property(
            property_value_id="pv-1",
            node_id="node-x",
            schema_id="schema-status",
            value="from-a",
        )
        await store_b.set_property(
            property_value_id="pv-2",
            node_id="node-x",
            schema_id="schema-status",
            value="from-b",
        )

        await sync_a.sync_once()
        await sync_b.sync_once()
        await sync_a.sync_once()

        assert await store_a.get_property(node_id="node-x", schema_id="schema-status") == "from-b"
        assert await store_b.get_property(node_id="node-x", schema_id="schema-status") == "from-b"

    async def test_earlier_hlc_does_not_overwrite_later(self) -> None:
        relay = MemoryRelay()
        store_a = _make_store(ACTOR_A)
        store_b = _make_store(ACTOR_B)
        _install_deterministic_clock(store_a, store_b)

        sync_a = _make_sync(store_a, relay)
        sync_b = _make_sync(store_b, relay)

        await store_a.create_node("node-y", kind="block")
        await sync_a.sync_once()
        await sync_b.sync_once()

        # B writes later than A.
        await store_b.set_property(
            property_value_id="pv-b",
            node_id="node-y",
            schema_id="schema-priority",
            value="from-b",
        )
        await store_a.set_property(
            property_value_id="pv-a",
            node_id="node-y",
            schema_id="schema-priority",
            value="from-a",
        )

        await sync_b.sync_once()
        await sync_a.sync_once()
        await sync_b.sync_once()

        assert await store_a.get_property(node_id="node-y", schema_id="schema-priority") == "from-b"
        assert await store_b.get_property(node_id="node-y", schema_id="schema-priority") == "from-b"


class TestContentConvergence:
    async def test_both_edit_same_node_content_offline(self) -> None:
        relay = MemoryRelay()
        store_a = _make_store(ACTOR_A)
        store_b = _make_store(ACTOR_B)
        _install_deterministic_clock(store_a, store_b)

        sync_a = _make_sync(store_a, relay)
        sync_b = _make_sync(store_b, relay)

        await store_a.create_node("shared-node", kind="block")
        await sync_a.sync_once()
        await sync_b.sync_once()

        # Both stores edit the same node while disconnected. B's clock is later,
        # so its content wins the last-write-wins merge.
        await store_a.update_content(
            "shared-node",
            [{"type": "paragraph", "children": [{"type": "text", "text": "from A"}]}],
        )
        await store_b.update_content(
            "shared-node",
            [{"type": "paragraph", "children": [{"type": "text", "text": "from B"}]}],
        )

        await sync_a.sync_once()
        await sync_b.sync_once()
        await sync_a.sync_once()

        expected = [{"type": "paragraph", "children": [{"type": "text", "text": "from B"}]}]
        assert (await store_a.get_node("shared-node"))["content"] == expected
        assert (await store_b.get_node("shared-node"))["content"] == expected


class TestAssetConvergence:
    async def test_both_upload_assets_offline_and_converge(self) -> None:
        relay = MemoryRelay()
        store_a = _make_store(ACTOR_A)
        store_b = _make_store(ACTOR_B)
        _install_deterministic_clock(store_a, store_b)

        sync_a = _make_sync(store_a, relay)
        sync_b = _make_sync(store_b, relay)

        # Each store creates a local asset node and applies an asset.upload op.
        await store_a.create_node("asset-a", kind="block")
        await store_b.create_node("asset-b", kind="block")

        await _apply_asset_upload(
            store_a,
            "asset-a",
            asset_hash="sha256-aaaa",
            mime_type="image/png",
            size_bytes=100,
            original_name="a.png",
        )
        await _apply_asset_upload(
            store_b,
            "asset-b",
            asset_hash="sha256-bbbb",
            mime_type="image/jpeg",
            size_bytes=200,
            original_name="b.jpg",
        )

        # Sync both ways so each store receives the other's asset upload.
        await sync_a.sync_once()
        await sync_b.sync_once()
        await sync_a.sync_once()

        assets_a = await _node_asset_rows(store_a)
        assets_b = await _node_asset_rows(store_b)
        assert assets_a == assets_b
        assert set(assets_a.keys()) == {"asset-a", "asset-b"}
        assert assets_a["asset-a"]["asset_hash"] == "sha256-aaaa"
        assert assets_a["asset-b"]["asset_hash"] == "sha256-bbbb"


async def _apply_asset_upload(
    store: WorkspaceStore,
    node_id: str,
    asset_hash: str,
    mime_type: str,
    size_bytes: int,
    original_name: str,
) -> None:
    op = create_operation(
        {
            "workspace_id": store.workspace_id,
            "actor_id": store.actor_id,
            "hlc": store._advance_clock(),  # noqa: SLF001
            "affected_node_ids": [node_id],
            "op_type": "asset.upload",
        },
        {
            "nodeId": node_id,
            "assetHash": asset_hash,
            "mimeType": mime_type,
            "sizeBytes": size_bytes,
            "originalName": original_name,
        },
    )
    await store.apply(op)


async def _node_asset_rows(store: WorkspaceStore) -> dict[str, dict[str, object]]:
    db = await store.get_db()
    rows = db.execute("SELECT * FROM node_asset").fetchall()
    return {
        row["node_id"]: {
            "asset_hash": row["asset_hash"],
            "mime_type": row["mime_type"],
            "size_bytes": row["size_bytes"],
            "original_name": row["original_name"],
        }
        for row in rows
    }
