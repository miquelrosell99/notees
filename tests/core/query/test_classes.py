"""Unit tests for the class table query helpers."""

from __future__ import annotations

import pytest

from app.core.query.classes import ClassRow, get_class, list_classes
from app.core.workspace_store import WorkspaceStore
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit


class FixedKeyStorage:
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


class TestClassQueries:
    async def test_list_classes_returns_active_classes_ordered_by_name(self) -> None:
        store = await _make_store()
        await store.create_node(
            "class-b",
            "class",
            initial_content=[{"type": "text", "text": "Beta"}],
        )
        await store.create_node(
            "class-a",
            "class",
            initial_content=[{"type": "text", "text": "Alpha"}],
        )

        results = await list_classes(store, "ws-1")

        assert [c.id for c in results] == ["class-a", "class-b"]
        assert results[0].active is True
        assert results[0].workspace_id == "ws-1"

    async def test_list_classes_filters_by_workspace(self) -> None:
        store = await _make_store(workspace_id="ws-1")
        other = await _make_store(workspace_id="ws-2", relay_storage=SqliteRelayStorage(":memory:"))
        await store.create_node("class-1", "class")
        await other.create_node("class-2", "class")

        results = await list_classes(store, "ws-1")

        assert [c.id for c in results] == ["class-1"]

    async def test_list_classes_ignores_inactive_classes(self) -> None:
        store = await _make_store()
        await store.create_node("class-1", "class")
        await store.delete_node("class-1")

        results = await list_classes(store, "ws-1")

        assert results == []

    async def test_get_class_returns_matching_row(self) -> None:
        store = await _make_store()
        await store.create_node("class-1", "class")

        row = await get_class(store, "class-1")

        assert row is not None
        assert row == ClassRow(
            id="class-1",
            workspace_id="ws-1",
            name="Untitled class",
            icon=None,
            color=None,
            description=None,
            extends_class_ids=[],
            active=True,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )

    async def test_get_class_returns_none_for_missing_id(self) -> None:
        store = await _make_store()
        row = await get_class(store, "missing")
        assert row is None

    async def test_get_class_parses_extends_json(self) -> None:
        store = await _make_store()
        await store.create_node("class-1", "class")
        await store.execute(
            "UPDATE class SET extends_class_ids = ? WHERE id = ?",
            ('["parent-1", "parent-2"]', "class-1"),
        )

        row = await get_class(store, "class-1")

        assert row is not None
        assert row.extends_class_ids == ["parent-1", "parent-2"]
