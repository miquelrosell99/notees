"""Unit tests for the server-side WorkspaceStore."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable

import pytest

from app.core import workspace_store as workspace_store_module
from app.core.workspace_store import WorkspaceStore
from app.relay.models import RelayEnvelope
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


class InterleavingRelayStorage(SqliteRelayStorage):
    """Relay storage that starts a concurrent sync right after each save.

    Simulates the production interleaving with PostgresRelayStorage, where
    awaiting ``save_envelope`` yields to the event loop and lets a concurrent
    ``sync()`` fetch and replay the just-persisted envelope before ``apply()``
    records it in ``applied_operation_id``.
    """

    def __init__(self, on_saved: Callable[[], Awaitable[None]]) -> None:
        super().__init__(":memory:")
        self._on_saved = on_saved

    async def save_envelope(self, envelope: RelayEnvelope) -> None:  # type: ignore[override]
        super().save_envelope(envelope)
        await self._on_saved()


class CountingRelayStorage(SqliteRelayStorage):
    """Relay storage that counts paginated catch-up calls and forbids the
    unpaginated variant, so tests can assert ``sync()`` pages in batches."""

    def __init__(self) -> None:
        super().__init__(":memory:")
        self.paginated_calls = 0

    def get_catch_up(
        self,
        workspace_id: str,
        after_seq: int = 0,
        node_id: str | None = None,
    ) -> list[RelayEnvelope]:
        raise AssertionError("sync() must use get_catch_up_paginated")

    def get_catch_up_paginated(
        self,
        workspace_id: str,
        after_seq: int = 0,
        limit: int = 1000,
        node_id: str | None = None,
    ) -> tuple[list[RelayEnvelope], int | None]:
        self.paginated_calls += 1
        return super().get_catch_up_paginated(
            workspace_id, after_seq, limit=limit, node_id=node_id
        )


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
            "SELECT * FROM node_link WHERE source_id = ? AND target_id = ?",
            ("source-1", "target-1"),
        )
        assert len(rows) == 1
        assert rows[0]["click_count"] == 1

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

    async def test_create_snapshot_persists_derived_state(self) -> None:
        relay = SqliteRelayStorage(":memory:")
        writer = await _make_store(relay_storage=relay)
        await writer.create_node("node-1", "page")
        await writer.create_node("node-2", "block")
        await writer.set_property("pv-1", "node-1", "schema-1", {"text": "hello"})

        snapshot_id = await writer.create_snapshot()
        latest = relay.get_latest_snapshot("ws-1")

        assert latest is not None
        assert latest["id"] == snapshot_id
        assert len(latest["data"]) > 0

        reader = await _make_store(relay_storage=relay)
        await reader.sync()

        node_rows = await reader.query(
            "SELECT id, kind FROM node WHERE id IN (?, ?) ORDER BY id",
            ("node-1", "node-2"),
        )
        assert len(node_rows) == 2
        assert node_rows[0]["kind"] == "page"
        assert node_rows[1]["kind"] == "block"

        property_rows = await reader.query(
            "SELECT value FROM property_value WHERE node_id = ?", ("node-1",)
        )
        assert len(property_rows) == 1
        assert json.loads(property_rows[0]["value"]) == {"text": "hello"}

        await writer.close()
        await reader.close()

    async def test_sync_uses_snapshot_to_skip_old_operations(self) -> None:
        relay = SqliteRelayStorage(":memory:")
        writer = await _make_store(relay_storage=relay)

        for i in range(5):
            await writer.create_node(f"old-node-{i}", "page")

        await writer.create_snapshot()
        await writer.close()

        # Add more operations after the snapshot using a separate store instance
        # so the original writer's in-memory derived DB is not reused. Sync first
        # so the appender's HLC is initialized from the relay's maximum HLC.
        appender = await _make_store(relay_storage=relay)
        await appender.sync()
        for i in range(3):
            await appender.create_node(f"new-node-{i}", "block")
        await appender.close()

        reader = await _make_store(relay_storage=relay)
        await reader.sync()

        # The 5 old operations are covered by the snapshot (reflected in the
        # restored applied_operation_id table), and the 3 new operations are
        # fetched and applied during catch-up.
        applied_rows = await reader.query(
            "SELECT COUNT(*) FROM applied_operation_id"
        )
        assert applied_rows[0][0] == 8

        snapshot = relay.get_latest_snapshot("ws-1")
        assert snapshot is not None
        newer_envelopes = relay.get_catch_up("ws-1", snapshot["up_to_seq"] or 0)
        assert len(newer_envelopes) == 3

        old_rows = await reader.query(
            "SELECT COUNT(*) FROM node WHERE id LIKE 'old-node-%'"
        )
        assert old_rows[0][0] == 5

        new_rows = await reader.query(
            "SELECT COUNT(*) FROM node WHERE id LIKE 'new-node-%'"
        )
        assert new_rows[0][0] == 3

        await reader.close()

    async def test_create_class_inserts_class_row(self) -> None:
        store = await _make_store()
        await store.create_class("class-1", "Project", icon="folder", color="#ff0000")

        rows = await store.query("SELECT * FROM class WHERE id = ?", ("class-1",))
        assert len(rows) == 1
        assert rows[0]["name"] == "Project"
        assert rows[0]["icon"] == "folder"
        assert rows[0]["color"] == "#ff0000"
        assert rows[0]["active"] == 1

        await store.close()

    async def test_update_class_updates_name(self) -> None:
        store = await _make_store()
        await store.create_class("class-1", "Project")
        await store.update_class("class-1", name="Area")

        rows = await store.query("SELECT name FROM class WHERE id = ?", ("class-1",))
        assert len(rows) == 1
        assert rows[0]["name"] == "Area"

        await store.close()

    async def test_delete_class_marks_inactive(self) -> None:
        store = await _make_store()
        await store.create_class("class-1", "Project")
        await store.delete_class("class-1")

        rows = await store.query("SELECT active FROM class WHERE id = ?", ("class-1",))
        assert len(rows) == 1
        assert rows[0]["active"] == 0

        await store.close()

    async def test_set_class_extends_updates_extends_and_hierarchy(self) -> None:
        store = await _make_store()
        await store.create_class("parent-1", "Parent")
        await store.create_class("child-1", "Child")
        await store.set_class_extends("child-1", ["parent-1"])

        rows = await store.query(
            "SELECT extends_class_ids FROM class WHERE id = ?", ("child-1",)
        )
        assert len(rows) == 1
        assert json.loads(rows[0]["extends_class_ids"]) == ["parent-1"]

        hierarchy_rows = await store.query(
            "SELECT ancestor_id FROM class_hierarchy WHERE class_id = ?",
            ("child-1",),
        )
        ancestors = {row["ancestor_id"] for row in hierarchy_rows}
        assert ancestors == {"child-1", "parent-1"}

        await store.close()

    async def test_apply_racing_sync_does_not_double_apply(self) -> None:
        """A sync interleaved between persist and apply must not double-apply.

        ``link.click`` is increment-only, so a double application is observable
        as ``click_count == 2``. The interleaving storage starts a concurrent
        sync and yields right after the envelope is persisted, which is exactly
        the window the workspace sync lock must close.
        """
        sync_tasks: list[asyncio.Task[None]] = []
        store_holder: dict[str, WorkspaceStore] = {}

        async def start_sync() -> None:
            sync_tasks.append(asyncio.create_task(store_holder["store"].sync()))
            # Yield so the concurrent sync can fetch and apply the just-saved op.
            await asyncio.sleep(0)

        store = await _make_store(
            workspace_id="ws-apply-sync-race",
            relay_storage=InterleavingRelayStorage(start_sync),
        )
        store_holder["store"] = store

        await store.record_link_click("source-1", "target-1")
        await asyncio.gather(*sync_tasks)

        rows = await store.query(
            "SELECT click_count FROM node_link WHERE source_id = ? AND target_id = ?",
            ("source-1", "target-1"),
        )
        assert len(rows) == 1
        assert rows[0]["click_count"] == 1

        await store.close()

    async def test_sync_paginates_cold_catch_up(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Cold sync pages through the relay in batches of the configured size."""
        monkeypatch.setattr(workspace_store_module, "_CATCH_UP_BATCH_SIZE", 2)

        relay = CountingRelayStorage()
        writer = await _make_store(relay_storage=relay)
        for i in range(5):
            await writer.create_node(f"node-{i}", "page")
        await writer.close()

        relay.paginated_calls = 0
        reader = await _make_store(relay_storage=relay)
        await reader.sync()

        # 5 envelopes at batch size 2 arrive in 3 pages (2 + 2 + 1).
        assert relay.paginated_calls == 3
        rows = await reader.query("SELECT COUNT(*) FROM node")
        assert rows[0][0] == 5
        applied = await reader.query("SELECT COUNT(*) FROM applied_operation_id")
        assert applied[0][0] == 5

        await reader.close()

    async def test_sync_batched_catch_up_skips_already_applied(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Batch applied-id checks must keep dedup intact across pages.

        Batch size 1 forces the batch-check query to run once per envelope and
        makes every batch of the second sync contain only already-applied ids.
        """
        monkeypatch.setattr(workspace_store_module, "_CATCH_UP_BATCH_SIZE", 1)

        relay = SqliteRelayStorage(":memory:")
        writer = await _make_store(relay_storage=relay)
        await writer.record_link_click("source-1", "target-1")
        await writer.create_node("node-1", "page")
        await writer.close()

        reader = await _make_store(relay_storage=relay)
        await reader.sync()
        await reader.sync()

        rows = await reader.query(
            "SELECT click_count FROM node_link WHERE source_id = ? AND target_id = ?",
            ("source-1", "target-1"),
        )
        assert len(rows) == 1
        assert rows[0]["click_count"] == 1

        await reader.close()


class TestClassExtendsCycleValidation:
    async def test_direct_cycle_is_rejected(self) -> None:
        store = await _make_store()
        await store.create_class("a", "A")
        await store.create_class("b", "B")
        await store.set_class_extends("a", ["b"])

        with pytest.raises(ValueError, match="inheritance cycle"):
            await store.set_class_extends("b", ["a"])

        await store.close()

    async def test_self_extends_is_rejected(self) -> None:
        store = await _make_store()
        await store.create_class("a", "A")

        with pytest.raises(ValueError, match="inheritance cycle"):
            await store.set_class_extends("a", ["a"])

        await store.close()

    async def test_indirect_cycle_is_rejected(self) -> None:
        store = await _make_store()
        for class_id in ("a", "b", "c"):
            await store.create_class(class_id, class_id.upper())
        await store.set_class_extends("a", ["b"])
        await store.set_class_extends("b", ["c"])

        with pytest.raises(ValueError, match="inheritance cycle"):
            await store.set_class_extends("c", ["a"])

        await store.close()

    async def test_rejected_cycle_emits_no_operation(self) -> None:
        store = await _make_store()
        await store.create_class("a", "A")
        await store.create_class("b", "B")
        await store.set_class_extends("a", ["b"])

        with pytest.raises(ValueError, match="inheritance cycle"):
            await store.set_class_extends("b", ["a"])

        rows = await store.query(
            "SELECT ancestor_id FROM class_hierarchy WHERE class_id = ?", ("b",)
        )
        assert {row["ancestor_id"] for row in rows} == {"b"}

        await store.close()

    async def test_create_class_with_self_extends_is_rejected(self) -> None:
        store = await _make_store()

        with pytest.raises(ValueError, match="inheritance cycle"):
            await store.create_class("a", "A", extends_class_ids=["a"])

        await store.close()

    async def test_valid_extends_chain_is_accepted(self) -> None:
        store = await _make_store()
        await store.create_class("x", "X")
        await store.create_class("source", "source", extends_class_ids=["x"])
        await store.create_class("book", "book")
        await store.set_class_extends("book", ["source"])

        rows = await store.query(
            "SELECT ancestor_id FROM class_hierarchy WHERE class_id = ?", ("book",)
        )
        assert {row["ancestor_id"] for row in rows} == {"book", "source", "x"}

        await store.close()
