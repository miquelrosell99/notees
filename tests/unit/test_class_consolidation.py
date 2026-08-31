"""Unit tests for the opt-in class consolidation tool (Decision 26)."""

from __future__ import annotations

import json

import pytest
import pytest_asyncio

from app.core.uuid import uuidv7
from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from app.features.workspaces.class_consolidation import (
    ConsolidationError,
    consolidate_class,
)
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit

WS = "ws-1"
ACTOR = "actor-1"


class FixedKeyStorage:
    """In-memory key storage that returns a fixed 32-byte master key."""

    async def get_or_create_master_key(self, workspace_id: str, secret_key: str) -> bytes:
        return b"0" * 32


@pytest_asyncio.fixture
async def store() -> WorkspaceStore:
    relay = SqliteRelayStorage(":memory:")
    store = WorkspaceStore(
        workspace_id=WS,
        actor_id=ACTOR,
        relay_storage=relay,
        db_path=":memory:",
        key_storage=FixedKeyStorage(),
    )
    await store.sync()
    yield store
    await store.close()


async def _make_page(store: WorkspaceStore, name: str, class_ids: list[str]) -> str:
    node_uuid = uuidv7()
    await store.create_node(
        node_id=node_uuid,
        kind="page",
        initial_content=[{"type": "paragraph", "children": [{"text": name}]}],
        class_ids=class_ids,
    )
    return node_uuid


async def _ensure_system_class(store: WorkspaceStore, name: str) -> str:
    """Materialise a system class row (production seeds these on workspace open)."""
    class_uuid = SYSTEM_CLASS_UUIDS[name]
    await store.create_class(class_id=class_uuid, name=name)
    return class_uuid


class TestConsolidateClass:
    async def test_reassigns_nodes_and_soft_deletes(self, store: WorkspaceStore) -> None:
        old_class = uuidv7()
        await store.create_class(class_id=old_class, name="fuente")
        source_class = await _ensure_system_class(store, "source")
        node_a = await _make_page(store, "A", [old_class])
        node_b = await _make_page(store, "B", [old_class])
        node_c = await _make_page(store, "C", [])

        summary = await consolidate_class(
            store,
            old_class_uuid=old_class,
            new_class_uuid=source_class,
        )

        assert summary["nodes_reassigned"] == 2
        assert summary["old_class_name"] == "fuente"
        assert summary["new_class_name"] == "source"

        rows = await store.query("SELECT id, class_ids FROM node WHERE active = 1")
        classes = {row["id"]: json.loads(row["class_ids"]) for row in rows}
        assert classes[node_a] == [SYSTEM_CLASS_UUIDS["source"]]
        assert classes[node_b] == [SYSTEM_CLASS_UUIDS["source"]]
        assert classes[node_c] == []

        class_row = await store.query("SELECT active FROM class WHERE id = ?", (old_class,))
        assert class_row[0]["active"] == 0

    async def test_node_already_in_target_class_is_not_double_assigned(self, store: WorkspaceStore) -> None:
        old_class = uuidv7()
        await store.create_class(class_id=old_class, name="libros")
        book_class = await _ensure_system_class(store, "book")
        node = await _make_page(store, "A", [old_class, book_class])

        summary = await consolidate_class(
            store,
            old_class_uuid=old_class,
            new_class_uuid=book_class,
        )
        assert summary["nodes_reassigned"] == 1
        rows = await store.query("SELECT class_ids FROM node WHERE id = ?", (node,))
        assert json.loads(rows[0]["class_ids"]) == [book_class]

    async def test_matching_property_edges_remap_to_system_schemas(self, store: WorkspaceStore) -> None:
        old_class = uuidv7()
        await store.create_class(class_id=old_class, name="fuente")
        source_class = await _ensure_system_class(store, "source")
        # User schema named "authors" bound to the old class; its values must
        # migrate to the system authors schema.
        user_schema = uuidv7()
        await store.create_property_schema(schema_id=user_schema, name="Authors", prop_type="node")
        await store.create_class_property_edge(old_class, user_schema, sequence=0)
        node = await _make_page(store, "A", [old_class])
        await store.set_property(
            property_value_id=uuidv7(),
            node_id=node,
            schema_id=user_schema,
            value="agent-node-1",
        )

        summary = await consolidate_class(
            store,
            old_class_uuid=old_class,
            new_class_uuid=source_class,
        )
        assert summary["property_edges_remapped"] == 1
        assert summary["property_values_migrated"] == 1

        # Edge now points from the system class to the system schema.
        edge_rows = await store.query(
            "SELECT property_schema_id FROM class_property_edge WHERE class_id = ?",
            (SYSTEM_CLASS_UUIDS["source"],),
        )
        assert [r["property_schema_id"] for r in edge_rows] == [SYSTEM_PROPERTY_UUIDS["authors"]]

        # Value migrated; old value unset.
        new_value = await store.get_property(node_id=node, schema_id=SYSTEM_PROPERTY_UUIDS["authors"])
        assert new_value == "agent-node-1"
        old_value = await store.get_property(node_id=node, schema_id=user_schema)
        assert old_value is None

    async def test_non_matching_schema_is_rebound_unchanged(self, store: WorkspaceStore) -> None:
        old_class = uuidv7()
        await store.create_class(class_id=old_class, name="fuente")
        source_class = await _ensure_system_class(store, "source")
        user_schema = uuidv7()
        await store.create_property_schema(schema_id=user_schema, name="valoración", prop_type="number")
        await store.create_class_property_edge(old_class, user_schema, sequence=3)
        node = await _make_page(store, "A", [old_class])
        await store.set_property(
            property_value_id=uuidv7(),
            node_id=node,
            schema_id=user_schema,
            value=5,
        )

        summary = await consolidate_class(
            store,
            old_class_uuid=old_class,
            new_class_uuid=source_class,
        )
        assert summary["property_values_migrated"] == 0

        edge_rows = await store.query(
            "SELECT property_schema_id FROM class_property_edge WHERE class_id = ?",
            (SYSTEM_CLASS_UUIDS["source"],),
        )
        assert [r["property_schema_id"] for r in edge_rows] == [user_schema]
        # Value stays under the user schema.
        assert await store.get_property(node_id=node, schema_id=user_schema) == 5

    async def test_refuses_system_class_as_source(self, store: WorkspaceStore) -> None:
        await store.create_class(class_id=SYSTEM_CLASS_UUIDS["source"], name="source")
        with pytest.raises(ConsolidationError, match="system class"):
            await consolidate_class(
                store,
                old_class_uuid=SYSTEM_CLASS_UUIDS["source"],
                new_class_uuid=SYSTEM_CLASS_UUIDS["book"],
            )

    async def test_refuses_same_class(self, store: WorkspaceStore) -> None:
        old_class = uuidv7()
        await store.create_class(class_id=old_class, name="fuente")
        with pytest.raises(ConsolidationError, match="differ"):
            await consolidate_class(store, old_class_uuid=old_class, new_class_uuid=old_class)

    async def test_refuses_unknown_classes(self, store: WorkspaceStore) -> None:
        with pytest.raises(ConsolidationError, match="not found"):
            await consolidate_class(
                store,
                old_class_uuid=uuidv7(),
                new_class_uuid=SYSTEM_CLASS_UUIDS["source"],
            )

        old_class = uuidv7()
        await store.create_class(class_id=old_class, name="fuente")
        with pytest.raises(ConsolidationError, match="not found"):
            await consolidate_class(store, old_class_uuid=old_class, new_class_uuid=uuidv7())

    async def test_refuses_inactive_old_class(self, store: WorkspaceStore) -> None:
        old_class = uuidv7()
        await store.create_class(class_id=old_class, name="fuente")
        await store.delete_class(old_class)
        with pytest.raises(ConsolidationError, match="not found or inactive"):
            await consolidate_class(
                store,
                old_class_uuid=old_class,
                new_class_uuid=SYSTEM_CLASS_UUIDS["source"],
            )
