"""Tests for workspace restore atomicity and dump validation."""

from __future__ import annotations

import pytest

from app.features.workspaces.repository import (
    PostgresWorkspaceIORepository,
    _validate_dump_schema,
)


def test_validate_dump_schema_rejects_non_dict() -> None:
    with pytest.raises(ValueError, match="Dump data must be a JSON object"):
        _validate_dump_schema("not a dict")


def test_validate_dump_schema_rejects_bad_version() -> None:
    with pytest.raises(ValueError, match="Unsupported dump version"):
        _validate_dump_schema(
            {"version": 2, "workspace": {"uuid": "11111111-1111-1111-1111-111111111111"}, "nodes": []}
        )


def test_validate_dump_schema_rejects_missing_workspace() -> None:
    with pytest.raises(ValueError, match="missing 'workspace' object"):
        _validate_dump_schema({"version": 3, "nodes": []})


def test_validate_dump_schema_rejects_invalid_workspace_uuid() -> None:
    with pytest.raises(ValueError, match="missing a valid uuid"):
        _validate_dump_schema(
            {"version": 3, "workspace": {"uuid": "not-a-uuid"}, "nodes": []}
        )


def test_validate_dump_schema_rejects_missing_nodes() -> None:
    with pytest.raises(ValueError, match="missing 'nodes' list"):
        _validate_dump_schema(
            {"version": 3, "workspace": {"uuid": "11111111-1111-1111-1111-111111111111"}}
        )


def test_validate_dump_schema_accepts_valid_dump() -> None:
    _validate_dump_schema(
        {
            "version": 3,
            "workspace": {"uuid": "11111111-1111-1111-1111-111111111111", "name": "ws"},
            "nodes": [],
            "links": [],
            "properties": [],
            "property_selection_lines": [],
            "node_views": [],
        }
    )


@pytest.mark.asyncio
async def test_restore_workspace_validates_schema_before_deleting(
    db_pool, test_user
) -> None:
    """A malformed dump is rejected before any workspace data is removed."""
    repo = PostgresWorkspaceIORepository(db_pool)
    workspace_id = test_user["workspace_id"]

    with pytest.raises(ValueError):
        await repo.restore_workspace(
            workspace_id,
            int(test_user["id"]),
            {"version": 1, "workspace": {"uuid": "11111111-1111-1111-1111-111111111111"}, "nodes": []},
        )


@pytest.mark.asyncio
async def test_restore_workspace_imports_data_and_bumps_epoch(
    db_pool, test_user
) -> None:
    """A valid dump is imported and restore_epoch is incremented."""
    repo = PostgresWorkspaceIORepository(db_pool)
    workspace_id = test_user["workspace_id"]
    user_id = int(test_user["id"])

    dump = {
        "version": 3,
        "workspace": {"uuid": test_user["workspace_uuid"], "name": "restored"},
        "nodes": [
            {
                "uuid": "11111111-1111-1111-1111-111111111111",
                "id": "11111111-1111-1111-1111-111111111111",
                "name": "Restored Page",
                "kind": "page",
                "is_class": False,
                "is_page": True,
                "is_day": False,
                "is_month": False,
                "is_year": False,
                "is_asset": False,
                "is_template": False,
                "is_comment": False,
                "is_task": False,
                "is_table": False,
                "is_card": False,
                "is_cloze": False,
                "parent_id": None,
                "class_ids": [],
                "active": True,
                "create_date": "2026-07-17T00:00:00Z",
                "write_date": "2026-07-17T00:00:00Z",
            }
        ],
        "links": [],
        "properties": [],
        "property_selection_lines": [],
        "node_properties": [],
        "property_value_scalars": [],
        "property_value_relations": [],
        "property_value_selections": [],
        "class_properties": [],
        "class_extends": [],
        "property_class_filters": [],
        "node_views": [],
        "settings": [],
    }

    stats = await repo.restore_workspace(workspace_id, user_id, dump)
    assert stats["nodes"] == 1

    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT restore_epoch FROM workspace WHERE id = $1",
            workspace_id,
        )
    assert row is not None
    assert row["restore_epoch"] == 1
