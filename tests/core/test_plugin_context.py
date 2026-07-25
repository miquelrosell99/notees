"""Unit tests for PluginContext helpers ported to WorkspaceStore."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable

import pytest
import pytest_asyncio

from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS
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
    async def test_ensure_class_returns_system_class_uuid(
        self, plugin_context: PluginContext
    ) -> None:
        page_uuid = SYSTEM_CLASS_UUIDS["page"]
        result = await plugin_context.ensure_class("ws-1", "actor-1", "page")
        assert result == page_uuid

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


class TestEnsurePropertySchema:
    async def test_ensure_property_schema_emits_operation(
        self, plugin_context: PluginContext
    ) -> None:
        schema_uuid = await plugin_context.ensure_property_schema(
            "ws-1", "actor-1", "external_id", prop_type="text"
        )

        store = await plugin_context._get_workspace_store("ws-1", "actor-1")
        await store.sync()
        # propertySchema.create does not materialise in derived state, but the
        # operation is persisted through the relay.
        assert store._relay_storage.count_operations("ws-1") == 1
        assert schema_uuid
        await store.close()
