"""Tests for data retention cleanup policies.

Covers automatic cleanup of trashed nodes, activity logs, and task completion
history based on workspace settings.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import pytest_asyncio

from app.cleanup import CleanupScheduler
from app.db.connection import get_workspace_assets_dir
from app.db.schema import SYSTEM_CLASS_UUIDS

pytestmark = pytest.mark.asyncio


async def _set_workspace_setting(db_pool, workspace_id: int, key: str, value):
    """Helper to set a workspace setting directly in the database."""
    async with db_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO setting_workspace (workspace_id, key, value, create_date, write_date)
            VALUES ($1, $2, $3::jsonb, NOW(), NOW())
            ON CONFLICT (workspace_id, key) DO UPDATE SET value = $3::jsonb, write_date = NOW()
            """,
            workspace_id,
            key,
            value,
        )
        row = await conn.fetchrow(
            "SELECT value FROM setting_workspace WHERE workspace_id = $1 AND key = $2",
            workspace_id,
            key,
        )
        assert row is not None, f"Setting {key} was not stored"


async def _get_class_id(db_pool, workspace_id: int, class_key: str) -> int | None:
    """Get the node ID for a system class in a workspace."""
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE workspace_id = $1 AND uuid = $2",
            workspace_id,
            SYSTEM_CLASS_UUIDS[class_key],
        )
        return row["id"] if row else None


async def _insert_node(
    db_pool,
    workspace_id: int,
    user_id: int,
    *,
    name: str,
    is_page: bool = False,
    is_task: bool = False,
    is_asset: bool = False,
    class_ids: list[int] | None = None,
):
    """Insert a node directly and return its generated id and uuid."""
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO node (
                workspace_id, name, uuid, is_page, is_task, is_asset,
                class_ids, active, create_uid, write_uid
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $8)
            RETURNING id, uuid
            """,
            workspace_id,
            name,
            str(uuid4()),
            is_page,
            is_task,
            is_asset,
            class_ids or [],
            int(user_id),
        )
        return row["id"], str(row["uuid"])


async def _soft_delete_node(db_pool, node_id: int, deleted_at: datetime):
    """Mark a node as soft-deleted with a specific timestamp."""
    async with db_pool.acquire() as conn:
        await conn.execute(
            "UPDATE node SET is_deleted = TRUE, deleted_at = $1 WHERE id = $2",
            deleted_at,
            node_id,
        )


async def _node_exists(db_pool, workspace_id: int, node_id: int) -> bool:
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT 1 FROM node WHERE workspace_id = $1 AND id = $2",
            workspace_id,
            node_id,
        )
        return row is not None


@pytest_asyncio.fixture
async def scheduler():
    """Create a fresh cleanup scheduler instance."""
    return CleanupScheduler()


async def test_trash_retention_deletes_old_nodes(db_pool, test_user, scheduler):
    """Trashed nodes older than the retention period are hard-deleted."""
    workspace_id = test_user["workspace_id"]
    user_id = int(test_user["id"])

    node_id, _ = await _insert_node(db_pool, workspace_id, user_id, name="Old trash page", is_page=True)
    old_date = datetime.now(UTC) - timedelta(days=31)
    await _soft_delete_node(db_pool, node_id, old_date)

    await scheduler._cleanup_trash()

    assert not await _node_exists(db_pool, workspace_id, node_id)


async def test_trash_retention_keeps_recent_nodes(db_pool, test_user, scheduler):
    """Trashed nodes newer than the retention period are kept."""
    workspace_id = test_user["workspace_id"]
    user_id = int(test_user["id"])

    node_id, _ = await _insert_node(db_pool, workspace_id, user_id, name="Recent trash page", is_page=True)
    recent_date = datetime.now(UTC) - timedelta(days=29)
    await _soft_delete_node(db_pool, node_id, recent_date)

    await scheduler._cleanup_trash()

    assert await _node_exists(db_pool, workspace_id, node_id)


async def test_trash_retention_zero_disables_cleanup(db_pool, test_user, scheduler):
    """Setting trash_retention_days to 0 disables automatic trash cleanup."""
    workspace_id = test_user["workspace_id"]
    user_id = int(test_user["id"])
    await _set_workspace_setting(db_pool, workspace_id, "trash_retention_days", 0)

    node_id, _ = await _insert_node(db_pool, workspace_id, user_id, name="Never delete page", is_page=True)
    old_date = datetime.now(UTC) - timedelta(days=365)
    await _soft_delete_node(db_pool, node_id, old_date)

    await scheduler._cleanup_trash()

    assert await _node_exists(db_pool, workspace_id, node_id)


async def test_trash_retention_deletes_asset_folder(db_pool, test_user, scheduler, temp_data_dir):
    """Asset folders for auto-deleted trashed assets are removed from disk."""
    workspace_id = test_user["workspace_id"]
    workspace_uuid = test_user["workspace_uuid"]
    user_id = int(test_user["id"])

    asset_class_id = await _get_class_id(db_pool, workspace_id, "asset")
    assert asset_class_id is not None

    node_id, asset_uuid = await _insert_node(
        db_pool,
        workspace_id,
        user_id,
        name="old-asset.png",
        is_asset=True,
        class_ids=[asset_class_id],
    )
    old_date = datetime.now(UTC) - timedelta(days=31)
    await _soft_delete_node(db_pool, node_id, old_date)

    # Create a fake asset folder on disk
    assets_dir = get_workspace_assets_dir(workspace_uuid)
    asset_folder = assets_dir / asset_uuid
    asset_folder.mkdir(parents=True, exist_ok=True)
    (asset_folder / "dummy.bin").write_text("data")

    await scheduler._cleanup_trash()

    assert not await _node_exists(db_pool, workspace_id, node_id)
    assert not asset_folder.exists()


async def test_activity_log_retention_deletes_old_rows(db_pool, test_user, scheduler):
    """Old activity log rows are deleted when retention is enabled."""
    workspace_id = test_user["workspace_id"]
    user_id = int(test_user["id"])

    node_id, _ = await _insert_node(db_pool, workspace_id, user_id, name="Activity page", is_page=True)

    async with db_pool.acquire() as conn:
        # Insert old activity row
        old_date = datetime.now(UTC) - timedelta(days=91)
        await conn.execute(
            """
            INSERT INTO node_activity (node_id, action, details, create_date)
            VALUES ($1, 'created', 'Old entry', $2)
            """,
            node_id,
            old_date,
        )
        # Insert recent activity row
        recent_date = datetime.now(UTC) - timedelta(days=1)
        await conn.execute(
            """
            INSERT INTO node_activity (node_id, action, details, create_date)
            VALUES ($1, 'edited', 'Recent entry', $2)
            """,
            node_id,
            recent_date,
        )

    await scheduler._cleanup_activity_logs()

    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT na.details
            FROM node_activity na
            JOIN node n ON na.node_id = n.id
            WHERE n.workspace_id = $1
            """,
            workspace_id,
        )

    details = {r["details"] for r in rows}
    assert "Old entry" not in details
    assert "Recent entry" in details


async def test_activity_log_retention_disabled_keeps_rows(db_pool, test_user, scheduler):
    """Activity log rows are kept when retention is disabled."""
    workspace_id = test_user["workspace_id"]
    user_id = int(test_user["id"])
    await _set_workspace_setting(db_pool, workspace_id, "activity_log_retention_enabled", False)

    node_id, _ = await _insert_node(db_pool, workspace_id, user_id, name="Activity page 2", is_page=True)

    async with db_pool.acquire() as conn:
        old_date = datetime.now(UTC) - timedelta(days=365)
        await conn.execute(
            """
            INSERT INTO node_activity (node_id, action, details, create_date)
            VALUES ($1, 'created', 'Very old entry', $2)
            """,
            node_id,
            old_date,
        )

    await scheduler._cleanup_activity_logs()

    async with db_pool.acquire() as conn:
        count = await conn.fetchval(
            """
            SELECT COUNT(*)
            FROM node_activity na
            JOIN node n ON na.node_id = n.id
            WHERE n.workspace_id = $1
            """,
            workspace_id,
        )

    assert count == 1


async def test_task_completion_retention_deletes_old_rows(db_pool, test_user, scheduler):
    """Old task completion rows are deleted when retention is enabled."""
    workspace_id = test_user["workspace_id"]
    user_id = int(test_user["id"])
    task_class_id = await _get_class_id(db_pool, workspace_id, "task")
    assert task_class_id is not None

    node_id, _ = await _insert_node(
        db_pool,
        workspace_id,
        user_id,
        name="Task",
        is_task=True,
        class_ids=[task_class_id],
    )

    async with db_pool.acquire() as conn:
        # Insert old completion
        old_date = datetime.now(UTC) - timedelta(days=366)
        await conn.execute(
            """
            INSERT INTO task_completion (task_node_id, workspace_id, status, completed_at)
            VALUES ($1, $2, 'completed', $3)
            """,
            node_id,
            workspace_id,
            old_date,
        )
        # Insert recent completion
        recent_date = datetime.now(UTC) - timedelta(days=1)
        await conn.execute(
            """
            INSERT INTO task_completion (task_node_id, workspace_id, status, completed_at)
            VALUES ($1, $2, 'completed', $3)
            """,
            node_id,
            workspace_id,
            recent_date,
        )

    await scheduler._cleanup_task_completions()

    async with db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT completed_at FROM task_completion WHERE workspace_id = $1",
            workspace_id,
        )

    completion_dates = [r["completed_at"] for r in rows]
    assert len(completion_dates) == 1
    assert (completion_dates[0] - (datetime.now(UTC) - timedelta(days=1))).days < 1


async def test_task_completion_retention_disabled_keeps_rows(db_pool, test_user, scheduler):
    """Task completion rows are kept when retention is disabled."""
    workspace_id = test_user["workspace_id"]
    user_id = int(test_user["id"])
    task_class_id = await _get_class_id(db_pool, workspace_id, "task")
    assert task_class_id is not None
    await _set_workspace_setting(db_pool, workspace_id, "task_completion_retention_enabled", False)

    node_id, _ = await _insert_node(
        db_pool,
        workspace_id,
        user_id,
        name="Task 2",
        is_task=True,
        class_ids=[task_class_id],
    )

    async with db_pool.acquire() as conn:
        old_date = datetime.now(UTC) - timedelta(days=1000)
        await conn.execute(
            """
            INSERT INTO task_completion (task_node_id, workspace_id, status, completed_at)
            VALUES ($1, $2, 'completed', $3)
            """,
            node_id,
            workspace_id,
            old_date,
        )

    await scheduler._cleanup_task_completions()

    async with db_pool.acquire() as conn:
        count = await conn.fetchval(
            "SELECT COUNT(*) FROM task_completion WHERE workspace_id = $1",
            workspace_id,
        )

    assert count == 1
