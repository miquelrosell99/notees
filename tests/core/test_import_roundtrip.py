"""Import round-trip tests for the local-first operation log.

These tests feed Markdown through :class:`app.features.import_.service.ImportService`
backed by an in-memory, fixed-key :class:`app.core.workspace_store.WorkspaceStore`,
then read the derived state to verify that node, property, and content operations
round-trip correctly without PostgreSQL.
"""

from __future__ import annotations

import json

import pytest

from app.core.workspace_store import WorkspaceStore
from app.features.import_.service import ImportService
from app.relay.storage import SqliteRelayStorage

pytestmark = [pytest.mark.unit, pytest.mark.asyncio]


class FixedKeyStorage:
    """In-memory key storage that returns a fixed 32-byte master key."""

    async def get_or_create_master_key(
        self, workspace_id: str, secret_key: str
    ) -> bytes:
        return b"\x00" * 32


async def _make_store(
    workspace_id: str = "ws-import-0001",
    actor_id: str = "actor-importer",
) -> WorkspaceStore:
    return WorkspaceStore(
        workspace_id=workspace_id,
        actor_id=actor_id,
        relay_storage=SqliteRelayStorage(":memory:"),
        db_path=":memory:",
        key_storage=FixedKeyStorage(),
    )


class TestMarkdownImportRoundTrip:
    async def test_import_round_trips_node_property_and_content(self) -> None:
        store = await _make_store()
        service = ImportService(store)

        markdown = """---
title: Round Trip Page
icon: "📝"
color: "#3366ff"
properties:
  Status: In Progress
  Priority: High
---
# Heading from body

This is the imported body paragraph.
"""
        node_uuid, title, created = await service.import_markdown(markdown)

        assert created is True
        assert title == "Round Trip Page"

        # 1. The page node was created in derived state.
        node_rows = await store.query(
            "SELECT id, kind, content FROM node WHERE id = ?",
            (node_uuid,),
        )
        assert len(node_rows) == 1
        assert node_rows[0]["kind"] == "page"
        page_content = json.loads(node_rows[0]["content"])
        assert page_content[0]["children"][0]["text"] == "Round Trip Page"

        # 2. Frontmatter properties round-trip to property_value rows.
        prop_rows = await store.query(
            "SELECT property_schema_id, value FROM property_value WHERE node_id = ?",
            (node_uuid,),
        )
        values_by_schema = {row["property_schema_id"]: json.loads(row["value"]) for row in prop_rows}

        from app.features.import_.service import _schema_uuid_for_name

        assert values_by_schema[_schema_uuid_for_name("icon")] == "📝"
        assert values_by_schema[_schema_uuid_for_name("color")] == "#3366ff"
        assert values_by_schema[_schema_uuid_for_name("Status")] == "In Progress"
        assert values_by_schema[_schema_uuid_for_name("Priority")] == "High"

        # 3. The Markdown body was appended as a child block.
        child_rows = await store.query(
            "SELECT id, kind, content FROM node WHERE parent_id = ?",
            (node_uuid,),
        )
        assert len(child_rows) == 1
        assert child_rows[0]["kind"] == "block"
        child_json = child_rows[0]["content"]
        assert "imported body paragraph" in child_json

        # 4. The derived idempotency table records that operations were applied.
        applied_rows = await store.query("SELECT COUNT(*) AS cnt FROM applied_operation_id")
        assert applied_rows[0]["cnt"] >= 4

        # 5. Replaying from the relay (server-side sync) is idempotent.
        await store.sync()
        node_rows_after_sync = await store.query(
            "SELECT id FROM node WHERE id = ?", (node_uuid,)
        )
        assert len(node_rows_after_sync) == 1

        await store.close()
