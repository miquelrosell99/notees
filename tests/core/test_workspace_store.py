"""Unit tests for the server-side WorkspaceStore."""

from __future__ import annotations

import json

import pytest

from app.core.workspace_store import WorkspaceStore
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit


class FixedKeyStorage:
    """In-memory key storage that returns a fixed 32-byte master key.

    This avoids requiring a PostgreSQL connection for WorkspaceKeyStorage in
    unit tests.
    """

    async def get_or_create_master_key(
        self, workspace_id: str, secret_key: str
    ) -> bytes:
        return b"0" * 32


async def _make_store(
    workspace_id: str = "ws-1",
    actor_id: str = "actor-1",
    relay_storage: SqliteRelayStorage | None = None,
) -> WorkspaceStore:
    return WorkspaceStore(
        workspace_id=workspace_id,
        actor_id=actor_id,
        relay_storage=relay_storage or SqliteRelayStorage(":memory:"),
        db_path=":memory:",
        key_storage=FixedKeyStorage(),
    )


class TestWorkspaceStore:
    async def test_create_node_appears_in_derived_table(self) -> None:
        store = await _make_store()
        await store.create_node("node-1", "page")

        rows = await store.query("SELECT * FROM node WHERE id = ?", ("node-1",))
        assert len(rows) == 1
        assert rows[0]["id"] == "node-1"
        assert rows[0]["kind"] == "page"
        assert rows[0]["workspace_id"] == "ws-1"

        await store.close()

    async def test_set_property_creates_property_value(self) -> None:
        store = await _make_store()
        await store.create_node("node-1", "page")
        await store.set_property("pv-1", "node-1", "schema-1", {"text": "done"})

        rows = await store.query(
            "SELECT * FROM property_value WHERE node_id = ?", ("node-1",)
        )
        assert len(rows) == 1
        assert rows[0]["property_schema_id"] == "schema-1"
        assert json.loads(rows[0]["value"]) == {"text": "done"}

        await store.close()

    async def test_record_activity_survives_sync(self) -> None:
        store = await _make_store()
        await store.create_node("node-1", "page")
        await store.record_activity(
            "act-1",
            "node-1",
            "property_changed",
            target_node_id="target-1",
            details={"property": "status", "old": "todo", "new": "done"},
        )
        await store.sync()

        rows = await store.query(
            "SELECT * FROM activity_log WHERE node_id = ? ORDER BY timestamp DESC",
            ("node-1",),
        )
        assert len(rows) == 1
        assert rows[0]["id"] == "act-1"
        assert rows[0]["action"] == "property_changed"
        assert rows[0]["target_node_id"] == "target-1"
        assert json.loads(rows[0]["details"]) == {
            "property": "status",
            "old": "todo",
            "new": "done",
        }

        await store.close()

    async def test_sync_replays_operations_from_relay(self) -> None:
        relay = SqliteRelayStorage(":memory:")
        writer = await _make_store(relay_storage=relay)
        await writer.create_node("node-1", "page")
        await writer.record_activity("act-1", "node-1", "created")
        await writer.close()

        reader = await _make_store(relay_storage=relay)
        rows = await reader.query("SELECT * FROM node WHERE id = ?", ("node-1",))
        assert len(rows) == 0

        await reader.sync()

        node_rows = await reader.query("SELECT * FROM node WHERE id = ?", ("node-1",))
        assert len(node_rows) == 1
        activity_rows = await reader.query(
            "SELECT * FROM activity_log WHERE node_id = ?", ("node-1",)
        )
        assert len(activity_rows) == 1

        await reader.close()

    async def test_idempotent_reapplication_does_not_duplicate(self) -> None:
        relay = SqliteRelayStorage(":memory:")
        writer = await _make_store(relay_storage=relay)
        await writer.record_link_click("source-1", "target-1")
        await writer.close()

        reader = await _make_store(relay_storage=relay)
        await reader.sync()
        await reader.sync()
        await reader.sync()

        rows = await reader.query(
            "SELECT * FROM link_click WHERE source_node_id = ? AND target_node_id = ?",
            ("source-1", "target-1"),
        )
        assert len(rows) == 1
        assert rows[0]["count"] == 1

        await reader.close()

    async def test_apply_many_creates_nodes_in_single_transaction(self) -> None:
        store = await _make_store()
        operations = [
            store._build_operation("node.create", {"nodeId": "batch-1", "kind": "page"}, ["batch-1"]),
            store._build_operation("node.create", {"nodeId": "batch-2", "kind": "page"}, ["batch-2"]),
            store._build_operation("node.create", {"nodeId": "batch-3", "kind": "block"}, ["batch-3"]),
        ]

        results = await store.apply_many(operations)

        assert len(results) == 3
        assert all(result is not None for result in results)
        assert all(result.id == op.id for result, op in zip(results, operations, strict=True))

        rows = await store.query("SELECT id, kind FROM node WHERE id IN (?, ?, ?) ORDER BY id", ("batch-1", "batch-2", "batch-3"))
        assert len(rows) == 3
        kinds = {row["id"]: row["kind"] for row in rows}
        assert kinds == {"batch-1": "page", "batch-2": "page", "batch-3": "block"}

        await store.close()

    async def test_apply_many_is_idempotent_on_reapplication(self) -> None:
        store = await _make_store()
        operations = [
            store._build_operation("node.create", {"nodeId": "idempotent-1", "kind": "page"}, ["idempotent-1"]),
            store._build_operation("node.create", {"nodeId": "idempotent-2", "kind": "page"}, ["idempotent-2"]),
        ]

        first_results = await store.apply_many(operations)
        assert len(first_results) == 2
        assert all(result is not None for result in first_results)

        second_results = await store.apply_many(operations)
        assert second_results == [None, None]

        rows = await store.query("SELECT id FROM node WHERE id IN (?, ?) ORDER BY id", ("idempotent-1", "idempotent-2"))
        assert len(rows) == 2

        await store.close()
