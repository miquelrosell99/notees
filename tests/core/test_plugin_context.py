"""Unit tests for PluginContext helpers ported to WorkspaceStore."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable

import pytest
import pytest_asyncio

from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from app.plugins.core.context import PluginContext
from app.plugins.core.registry import PluginRegistry
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit


class FixedKeyStorage:
    """In-memory key storage that returns a fixed 32-byte master key."""

    async def get_or_create_master_key(
        self, workspace_id: str, secret_key: str
    ) -> bytes:
        return b"0" * 32


class _TestRelay:
    """Shared in-memory relay storage for a single test."""

    def __init__(self) -> None:
        self.relay = SqliteRelayStorage(":memory:")


async def _make_workspace_store_factory(
    relay: _TestRelay,
) -> Callable[..., Awaitable[WorkspaceStore]]:
    """Return a factory that shares relay storage across WorkspaceStore instances.

    Each call creates a fresh derived SQLite database, mirroring production where
    every request gets its own store but all instances converge through the
    shared relay.
    """

    async def factory(workspace_uuid: str, actor_uuid: str) -> WorkspaceStore:
        return WorkspaceStore(
            workspace_id=workspace_uuid,
            actor_id=actor_uuid,
            relay_storage=relay.relay,
            db_path=":memory:",
            key_storage=FixedKeyStorage(),
        )

    return factory


async def _settings_repository_factory(
    _workspace_id: int, _user_id: int
) -> dict:
    """Fake settings repository factory (not used by workspace helpers)."""
    return {}


@pytest_asyncio.fixture
async def plugin_context() -> PluginContext:
    """PluginContext wired to an in-memory WorkspaceStore factory."""
    registry = PluginRegistry()
    relay = _TestRelay()
    workspace_store_factory = await _make_workspace_store_factory(relay)
    port_factories = {
        "WorkspaceStore": workspace_store_factory,
        "SettingsRepository": _settings_repository_factory,
    }
    return PluginContext(
        plugin_id="test.plugin",
        permissions={
            "read_nodes",
            "write_nodes",
            "write_properties",
            "settings",
        },
        registry=registry,
        port_factories=port_factories,
    )


class TestEmitOp:
    async def test_emit_op_creates_plugin_op_log_row(
        self, plugin_context: PluginContext
    ) -> None:
        await plugin_context.emit_op(
            workspace_uuid="ws-1",
            actor_uuid="actor-1",
            op_type="test.op",
            data={"foo": "bar"},
        )

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        rows = await store.query(
            "SELECT plugin_id, op_type, data_json FROM plugin_op_log"
        )
        assert len(rows) == 1
        assert rows[0]["plugin_id"] == "test.plugin"
        assert rows[0]["op_type"] == "test.op"
        assert json.loads(rows[0]["data_json"]) == {"foo": "bar"}
        await store.close()

    async def test_emit_op_with_node_id_includes_node_id(
        self, plugin_context: PluginContext
    ) -> None:
        await plugin_context.emit_op(
            workspace_uuid="ws-1",
            actor_uuid="actor-1",
            op_type="test.op",
            data={"foo": "bar"},
            node_id="node-1",
        )

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        rows = await store.query(
            "SELECT plugin_id, op_type, node_id, data_json FROM plugin_op_log"
        )
        assert len(rows) == 1
        assert rows[0]["node_id"] == "node-1"
        await store.close()


class TestCreatePage:
    async def test_create_page_emits_node_and_properties(
        self, plugin_context: PluginContext
    ) -> None:
        schema_uuid = "schema-1"
        node_uuid = await plugin_context.create_page(
            workspace_uuid="ws-1",
            actor_uuid="actor-1",
            name="My Page",
            class_uuids=["class-1"],
            property_values={schema_uuid: "value-1"},
            icon="📝",
        )

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        rows = await store.query("SELECT id, kind, class_ids, content FROM node")
        assert len(rows) == 1
        assert rows[0]["id"] == node_uuid
        assert rows[0]["kind"] == "page"
        assert json.loads(rows[0]["class_ids"]) == ["class-1"]

        prop_rows = await store.query(
            "SELECT property_schema_id, value FROM property_value"
        )
        values = {row["property_schema_id"]: json.loads(row["value"]) for row in prop_rows}
        assert values[schema_uuid] == "value-1"
        assert values["system:icon"] == "📝"
        await store.close()


class TestFindPageByName:
    async def test_find_page_by_name_returns_matching_uuid(
        self, plugin_context: PluginContext
    ) -> None:
        node_uuid = await plugin_context.create_page(
            workspace_uuid="ws-1",
            actor_uuid="actor-1",
            name="Target Page",
        )
        await plugin_context.create_page(
            workspace_uuid="ws-1",
            actor_uuid="actor-1",
            name="Other Page",
        )

        found = await plugin_context.find_page_by_name("ws-1", "actor-1", "Target Page")
        assert found == node_uuid

    async def test_find_page_by_name_returns_none_when_missing(
        self, plugin_context: PluginContext
    ) -> None:
        result = await plugin_context.find_page_by_name("ws-1", "actor-1", "Missing")
        assert result is None


class TestUpsertPageByExternalId:
    async def test_upsert_creates_new_page(
        self, plugin_context: PluginContext
    ) -> None:
        schema_uuid = "ext-schema-1"
        node_uuid = await plugin_context.upsert_page_by_external_id(
            workspace_uuid="ws-1",
            actor_uuid="actor-1",
            external_id="ext-123",
            external_id_schema_uuid=schema_uuid,
            name="Imported Page",
        )

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        rows = await store.query(
            "SELECT node_id, value FROM property_value WHERE property_schema_id = ?",
            (schema_uuid,),
        )
        assert len(rows) == 1
        assert rows[0]["node_id"] == node_uuid
        assert json.loads(rows[0]["value"]) == "ext-123"
        await store.close()

    async def test_upsert_updates_existing_page(
        self, plugin_context: PluginContext
    ) -> None:
        schema_uuid = "ext-schema-1"
        node_uuid = await plugin_context.upsert_page_by_external_id(
            workspace_uuid="ws-1",
            actor_uuid="actor-1",
            external_id="ext-123",
            external_id_schema_uuid=schema_uuid,
            name="Original Name",
        )

        same_uuid = await plugin_context.upsert_page_by_external_id(
            workspace_uuid="ws-1",
            actor_uuid="actor-1",
            external_id="ext-123",
            external_id_schema_uuid=schema_uuid,
            name="Updated Name",
        )
        assert same_uuid == node_uuid

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        rows = await store.query(
            "SELECT id, content FROM node WHERE id = ?", (node_uuid,)
        )
        assert len(rows) == 1
        assert "Updated Name" in rows[0]["content"]
        await store.close()


class TestEnsureClass:
    async def test_ensure_class_returns_none_for_page_kind(
        self, plugin_context: PluginContext
    ) -> None:
        """``page`` is a structural kind, not a class, so ensure_class returns None."""
        result = await plugin_context.ensure_class("ws-1", "actor-1", "page")
        assert result is None

    async def test_ensure_class_creates_new_class_for_unknown_name(
        self, plugin_context: PluginContext
    ) -> None:
        class_uuid = await plugin_context.ensure_class("ws-1", "actor-1", "custom")

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        rows = await store.query(
            "SELECT id, name FROM class WHERE id = ?", (class_uuid,)
        )
        assert len(rows) == 1
        assert rows[0]["name"] == "custom"
        await store.close()

    async def test_ensure_class_resolves_system_name_without_emitting(
        self, plugin_context: PluginContext
    ) -> None:
        """System names resolve to the fixed UUID without creating a class."""
        result = await plugin_context.ensure_class("ws-1", "actor-1", "source")
        assert result == SYSTEM_CLASS_UUIDS["source"]
        # Zotero provisions "Source" (capitalized); it must converge too.
        again = await plugin_context.ensure_class(
            "ws-1", "actor-1", "Source", icon="book-open-variant"
        )
        assert again == SYSTEM_CLASS_UUIDS["source"]

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        rows = await store.query("SELECT id FROM class")
        assert rows == []
        await store.close()

    async def test_ensure_class_converges_on_repeated_calls(
        self, plugin_context: PluginContext
    ) -> None:
        first = await plugin_context.ensure_class("ws-1", "actor-1", "Zotero Source")
        for _ in range(3):
            again = await plugin_context.ensure_class("ws-1", "actor-1", "Zotero Source")
            assert again == first

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        rows = await store.query("SELECT id FROM class")
        assert [row["id"] for row in rows] == [first]
        await store.close()

    async def test_ensure_class_finds_preexisting_class_by_name(
        self, plugin_context: PluginContext
    ) -> None:
        """A class created outside ensure_class is reused, never duplicated."""
        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        await store.create_class(class_id="existing-class", name="Legacy Source")
        await store.close()

        result = await plugin_context.ensure_class("ws-1", "actor-1", "legacy source")
        assert result == "existing-class"


class TestEnsurePropertySchema:
    async def test_ensure_property_schema_emits_operation(
        self, plugin_context: PluginContext
    ) -> None:
        schema_uuid = await plugin_context.ensure_property_schema(
            "ws-1", "actor-1", "external_id", prop_type="text"
        )

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        # The operation is persisted through the relay and materialises in the
        # derived property_schema table.
        assert store._relay_storage.count_operations("ws-1") == 1
        assert schema_uuid
        await store.close()

    async def test_ensure_property_schema_resolves_system_name_without_emitting(
        self, plugin_context: PluginContext
    ) -> None:
        result = await plugin_context.ensure_property_schema(
            "ws-1", "actor-1", "citekey"
        )
        assert result == SYSTEM_PROPERTY_UUIDS["citekey"]

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        rows = await store.query("SELECT id FROM property_schema")
        assert rows == []
        await store.close()

    async def test_ensure_property_schema_converges_on_repeated_calls(
        self, plugin_context: PluginContext
    ) -> None:
        first = await plugin_context.ensure_property_schema(
            "ws-1", "actor-1", "Zotero Key", icon="identifier"
        )
        for _ in range(3):
            again = await plugin_context.ensure_property_schema(
                "ws-1", "actor-1", "Zotero Key", icon="identifier"
            )
            assert again == first

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        rows = await store.query("SELECT id, name FROM property_schema")
        assert [row["id"] for row in rows] == [first]
        await store.close()

    async def test_ensure_property_schema_passes_through_schema_attributes(
        self, plugin_context: PluginContext
    ) -> None:
        schema_uuid = await plugin_context.ensure_property_schema(
            "ws-1",
            "actor-1",
            "Authors Ref",
            prop_type="node",
            multi=True,
            is_system=True,
            scope="class",
            class_filter_uuids=[SYSTEM_CLASS_UUIDS["agent"]],
            default_value="",
        )

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        rows = await store.query(
            "SELECT type, multi, is_system, scope, class_filter_uuids "
            "FROM property_schema WHERE id = ?",
            (schema_uuid,),
        )
        assert len(rows) == 1
        row = rows[0]
        assert row["type"] == "node"
        assert row["multi"] == 1
        assert row["is_system"] == 1
        assert row["scope"] == "class"
        assert json.loads(row["class_filter_uuids"]) == [SYSTEM_CLASS_UUIDS["agent"]]
        await store.close()


class TestSetClassExtends:
    async def test_set_class_extends_sets_parents(
        self, plugin_context: PluginContext
    ) -> None:
        parent = await plugin_context.ensure_class("ws-1", "actor-1", "ParentCls")
        child = await plugin_context.ensure_class("ws-1", "actor-1", "ChildCls")

        await plugin_context.set_class_extends("ws-1", "actor-1", child, [parent])

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        rows = await store.query(
            "SELECT extends_class_ids FROM class WHERE id = ?", (child,)
        )
        assert len(rows) == 1
        assert json.loads(rows[0]["extends_class_ids"]) == [parent]
        await store.close()

    async def test_set_class_extends_rejects_cycles(
        self, plugin_context: PluginContext
    ) -> None:
        class_a = await plugin_context.ensure_class("ws-1", "actor-1", "CycleA")
        class_b = await plugin_context.ensure_class("ws-1", "actor-1", "CycleB")
        await plugin_context.set_class_extends("ws-1", "actor-1", class_a, [class_b])

        with pytest.raises(ValueError, match="cycle"):
            await plugin_context.set_class_extends(
                "ws-1", "actor-1", class_b, [class_a]
            )


class TestFindOrCreateNodeByName:
    async def test_returns_same_node_on_repeated_calls(
        self, plugin_context: PluginContext
    ) -> None:
        agent = SYSTEM_CLASS_UUIDS["agent"]
        first = await plugin_context.find_or_create_node_by_name(
            "ws-1", "actor-1", agent, "Frank Herbert"
        )
        second = await plugin_context.find_or_create_node_by_name(
            "ws-1", "actor-1", agent, "Frank Herbert"
        )
        assert first == second

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        rows = await store.query("SELECT id, class_ids FROM node")
        assert [row["id"] for row in rows] == [first]
        assert json.loads(rows[0]["class_ids"]) == [agent]
        await store.close()

    async def test_same_name_with_different_class_creates_new_node(
        self, plugin_context: PluginContext
    ) -> None:
        agent = SYSTEM_CLASS_UUIDS["agent"]
        other = await plugin_context.ensure_class("ws-1", "actor-1", "OtherCls")
        first = await plugin_context.find_or_create_node_by_name(
            "ws-1", "actor-1", agent, "Frank Herbert"
        )
        second = await plugin_context.find_or_create_node_by_name(
            "ws-1", "actor-1", other, "Frank Herbert"
        )
        assert first != second

    async def test_creates_node_with_property_values(
        self, plugin_context: PluginContext
    ) -> None:
        agent = SYSTEM_CLASS_UUIDS["agent"]
        schema_uuid = await plugin_context.ensure_property_schema(
            "ws-1", "actor-1", "External Ref"
        )
        node_uuid = await plugin_context.find_or_create_node_by_name(
            "ws-1",
            "actor-1",
            agent,
            "Frank Herbert",
            property_values={schema_uuid: "ext-1"},
        )

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        rows = await store.query(
            "SELECT node_id, value FROM property_value WHERE property_schema_id = ?",
            (schema_uuid,),
        )
        assert len(rows) == 1
        assert rows[0]["node_id"] == node_uuid
        assert json.loads(rows[0]["value"]) == "ext-1"
        await store.close()


class TestZoteroStyleDoubleProvisioning:
    async def test_two_syncs_converge_without_duplicates(
        self, plugin_context: PluginContext
    ) -> None:
        """Two Zotero-style syncs produce one schema, no ad-hoc class, one agent."""

        async def _sync_once() -> tuple[str | None, str, str]:
            source_class_uuid = await plugin_context.ensure_class(
                "ws-1", "actor-1", "Source", icon="book-open-variant"
            )
            key_schema_uuid = await plugin_context.ensure_property_schema(
                "ws-1", "actor-1", "Zotero Key", icon="identifier"
            )
            author_uuid = await plugin_context.find_or_create_node_by_name(
                "ws-1",
                "actor-1",
                SYSTEM_CLASS_UUIDS["agent"],
                "Frank Herbert",
            )
            return source_class_uuid, key_schema_uuid, author_uuid

        first = await _sync_once()
        second = await _sync_once()

        assert first == second
        assert first[0] == SYSTEM_CLASS_UUIDS["source"]

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        # "Source" resolved to the system class: no ad-hoc duplicate created.
        class_rows = await store.query("SELECT id FROM class")
        assert class_rows == []
        schema_rows = await store.query("SELECT id FROM property_schema")
        assert [row["id"] for row in schema_rows] == [first[1]]
        node_rows = await store.query("SELECT id FROM node")
        assert [row["id"] for row in node_rows] == [first[2]]
        await store.close()
