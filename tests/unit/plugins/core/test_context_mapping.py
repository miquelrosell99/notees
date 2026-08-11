"""Tests for PluginContext workspace helpers backed by WorkspaceStore."""

from __future__ import annotations

from typing import Any

import pytest

from app.core.uuid import uuidv7
from app.core.workspace_store import WorkspaceStore
from app.plugins.core.context import PluginContext
from app.plugins.core.exceptions import PluginPermissionError
from app.plugins.core.ports import ImportContext
from app.plugins.core.registry import PluginRegistry
from app.relay.storage import SqliteRelayStorage


class FixedKeyStorage:
    """In-memory key storage that returns a fixed 32-byte master key."""

    async def get_or_create_master_key(
        self, workspace_id: str, secret_key: str
    ) -> bytes:
        return b"0" * 32


class _TestRelay:
    """Shared in-memory relay storage for a single test context."""

    def __init__(self) -> None:
        self.relay = SqliteRelayStorage(":memory:")


async def _make_workspace_store_factory(
    relay: _TestRelay,
) -> Any:
    async def factory(workspace_uuid: str, actor_uuid: str) -> WorkspaceStore:
        return WorkspaceStore(
            workspace_id=workspace_uuid,
            actor_id=actor_uuid,
            relay_storage=relay.relay,
            db_path=":memory:",
            key_storage=FixedKeyStorage(),
        )

    return factory


async def _settings_repository_factory(_workspace_id: int, _user_id: int) -> dict:
    """Fake settings repository factory."""
    return {}


async def _make_context(
    permissions: set[str] | None = None,
) -> PluginContext:
    permissions = (
        {"write_nodes", "read_nodes", "write_properties", "settings"}
        if permissions is None
        else permissions
    )
    relay = _TestRelay()
    return PluginContext(
        plugin_id="notees.test",
        permissions=permissions,
        registry=PluginRegistry(),
        port_factories={
            "WorkspaceStore": await _make_workspace_store_factory(relay),
            "SettingsRepository": _settings_repository_factory,
        },
    )


@pytest.mark.unit
async def test_ensure_property_schema_emits_operation() -> None:
    context = await _make_context()

    schema_uuid = await context.ensure_property_schema("ws-1", "actor-1", "External ID")

    assert schema_uuid is not None
    store = await context._get_workspace_store("ws-1", "actor-1")
    await store.sync()
    assert store._relay_storage.count_operations("ws-1") == 1
    await store.close()


@pytest.mark.unit
async def test_ensure_property_schema_requires_write_properties_permission() -> None:
    context = await _make_context(permissions=set())

    with pytest.raises(PluginPermissionError):
        await context.ensure_property_schema("ws-1", "actor-1", "External ID")


@pytest.mark.unit
async def test_upsert_page_by_external_id_creates_page() -> None:
    context = await _make_context()
    schema_uuid = uuidv7()

    page_uuid = await context.upsert_page_by_external_id(
        "ws-1",
        "actor-1",
        "ext-123",
        external_id_schema_uuid=schema_uuid,
        name="Imported Page",
    )

    assert page_uuid is not None
    store = await context._get_workspace_store("ws-1", "actor-1")
    await store.sync()
    rows = await store.query(
        "SELECT node_id FROM property_value WHERE property_schema_id = ?",
        (schema_uuid,),
    )
    assert len(rows) == 1
    assert rows[0]["node_id"] == page_uuid
    await store.close()


@pytest.mark.unit
async def test_upsert_page_by_external_id_updates_existing_by_property() -> None:
    context = await _make_context()
    schema_uuid = uuidv7()

    first = await context.upsert_page_by_external_id(
        "ws-1", "actor-1", "ext-123", external_id_schema_uuid=schema_uuid, name="First"
    )
    second = await context.upsert_page_by_external_id(
        "ws-1", "actor-1", "ext-123", external_id_schema_uuid=schema_uuid, name="Updated"
    )

    assert first == second


@pytest.mark.unit
async def test_upsert_page_by_external_id_falls_back_to_name_and_class() -> None:
    context = await _make_context()
    source_class_uuid = uuidv7()
    existing = await context.create_page(
        "ws-1", "actor-1", "@doe2023", class_uuids=[source_class_uuid]
    )

    doi_schema_uuid = uuidv7()
    page_uuid = await context.upsert_page_by_external_id(
        "ws-1",
        "actor-1",
        "10.1000/xyz",
        external_id_schema_uuid=doi_schema_uuid,
        name="@doe2023",
        class_uuids=[source_class_uuid],
    )

    assert page_uuid == existing


@pytest.mark.unit
async def test_create_page_applies_property_values() -> None:
    context = await _make_context()
    schema_uuid = uuidv7()

    page_uuid = await context.create_page(
        "ws-1",
        "actor-1",
        "My Page",
        property_values={schema_uuid: "abc"},
    )

    store = await context._get_workspace_store("ws-1", "actor-1")
    await store.sync()
    rows = await store.query(
        "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?",
        (page_uuid, schema_uuid),
    )
    assert len(rows) == 1
    import json

    assert json.loads(rows[0]["value"]) == "abc"
    await store.close()


@pytest.mark.unit
async def test_import_context_includes_uuid_fields() -> None:
    context = await _make_context()
    import_context = ImportContext(
        workspace_id=1,
        user_id=1,
        workspace_uuid="ws-uuid-1",
        actor_uuid="actor-uuid-1",
        plugin_context=context,
        filename="test.md",
    )

    assert import_context.workspace_uuid == "ws-uuid-1"
    assert import_context.actor_uuid == "actor-uuid-1"
