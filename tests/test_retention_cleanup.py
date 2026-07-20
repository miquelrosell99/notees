"""Tests for data retention cleanup policies.

Covers automatic cleanup of trashed nodes, activity logs, and task completion
history based on workspace settings. These tests use the local-first
WorkspaceStore rather than the legacy PostgreSQL content tables.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import pytest_asyncio

from app.cleanup import CleanupScheduler
from app.core.workspace_store import WorkspaceStore
from app.db.connection import get_workspace_assets_dir
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS

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


def _make_store(test_user: dict) -> WorkspaceStore:
    """Create a WorkspaceStore for the test user's workspace."""
    return WorkspaceStore(
        workspace_id=test_user["workspace_uuid"],
        actor_id=str(test_user["uuid"]),
    )


async def _create_node(
    store: WorkspaceStore,
    node_id: str,
    *,
    kind: str = "page",
    class_ids: list[str] | None = None,
) -> None:
    """Create a node through the operation log."""
    await store.create_node(node_id, kind=kind, class_ids=class_ids)


async def _delete_node(store: WorkspaceStore, node_id: str) -> None:
    """Delete a node through the operation log (records it in trash)."""
    await store.delete_node(node_id)


async def _set_trash_deleted_at(
    store: WorkspaceStore, node_id: str, deleted_at: datetime
) -> None:
    """Backdate a trash entry to simulate an old deletion."""
    await store.execute(
        "UPDATE trash SET deleted_at = ? WHERE node_id = ?",
        (deleted_at.isoformat(), node_id),
    )


async def _record_activity(
    store: WorkspaceStore,
    activity_id: str,
    node_id: str,
    action: str,
    details: dict | None = None,
) -> None:
    """Record an activity log entry through the operation log."""
    await store.record_activity(
        activity_id,
        node_id,
        action,
        details=details,
    )


async def _set_activity_timestamp(
    store: WorkspaceStore, activity_id: str, timestamp: datetime
) -> None:
    """Backdate an activity log entry to simulate an old record."""
    await store.execute(
        "UPDATE activity_log SET timestamp = ? WHERE id = ?",
        (timestamp.isoformat(), activity_id),
    )


async def _node_exists(store: WorkspaceStore, node_id: str) -> bool:
    rows = await store.query("SELECT 1 FROM node WHERE id = ?", (node_id,))
    return bool(rows)


async def _trash_exists(store: WorkspaceStore, node_id: str) -> bool:
    rows = await store.query("SELECT 1 FROM trash WHERE node_id = ?", (node_id,))
    return bool(rows)


async def _activity_details(store: WorkspaceStore) -> set[str]:
    rows = await store.query("SELECT details FROM activity_log")
    result: set[str] = set()
    for row in rows:
        details = row["details"]
        if not details:
            continue
        try:
            parsed = json.loads(details)
            if isinstance(parsed, dict):
                result.add(str(parsed.get("detail", "")))
            else:
                result.add(str(parsed))
        except json.JSONDecodeError:
            result.add(str(details))
    return result


async def _task_completion_count(store: WorkspaceStore) -> int:
    rows = await store.query("SELECT 1 FROM task_completion")
    return len(rows)


@pytest_asyncio.fixture
async def scheduler():
    """Create a fresh cleanup scheduler instance."""
    return CleanupScheduler()


async def test_trash_retention_deletes_old_nodes(db_pool, test_user, scheduler):
    """Trashed nodes older than the retention period are hard-deleted."""
    store = _make_store(test_user)
    try:
        node_id = str(uuid4())
        await _create_node(store, node_id)
        await _delete_node(store, node_id)
        old_date = datetime.now(UTC) - timedelta(days=31)
        await _set_trash_deleted_at(store, node_id, old_date)

        await scheduler._cleanup_trash()

        assert not await _node_exists(store, node_id)
        assert not await _trash_exists(store, node_id)
    finally:
        await store.close()


async def test_trash_retention_keeps_recent_nodes(db_pool, test_user, scheduler):
    """Trashed nodes newer than the retention period are kept."""
    store = _make_store(test_user)
    try:
        node_id = str(uuid4())
        await _create_node(store, node_id)
        await _delete_node(store, node_id)
        recent_date = datetime.now(UTC) - timedelta(days=29)
        await _set_trash_deleted_at(store, node_id, recent_date)

        await scheduler._cleanup_trash()

        # The trash entry is recent, so the node row is still gone (delete is
        # immediate) but the trash record remains.
        assert not await _node_exists(store, node_id)
        assert await _trash_exists(store, node_id)
    finally:
        await store.close()


async def test_trash_retention_zero_disables_cleanup(db_pool, test_user, scheduler):
    """Setting trash_retention_days to 0 disables automatic trash cleanup."""
    workspace_id = test_user["workspace_id"]
    await _set_workspace_setting(db_pool, workspace_id, "trash_retention_days", 0)

    store = _make_store(test_user)
    try:
        node_id = str(uuid4())
        await _create_node(store, node_id)
        await _delete_node(store, node_id)
        old_date = datetime.now(UTC) - timedelta(days=365)
        await _set_trash_deleted_at(store, node_id, old_date)

        await scheduler._cleanup_trash()

        assert not await _node_exists(store, node_id)
        assert await _trash_exists(store, node_id)
    finally:
        await store.close()


async def test_trash_retention_deletes_asset_folder(
    db_pool, test_user, scheduler, temp_data_dir
):
    """Asset folders for auto-deleted trashed assets are removed from disk."""
    store = _make_store(test_user)
    try:
        asset_uuid = str(uuid4())
        await _create_node(
            store,
            asset_uuid,
            kind="block",
            class_ids=[SYSTEM_CLASS_UUIDS["asset"]],
        )
        await _delete_node(store, asset_uuid)
        old_date = datetime.now(UTC) - timedelta(days=31)
        await _set_trash_deleted_at(store, asset_uuid, old_date)

        # Create a fake asset folder on disk (legacy layout by node UUID)
        workspace_uuid = test_user["workspace_uuid"]
        assets_dir = get_workspace_assets_dir(workspace_uuid)
        asset_folder = assets_dir / asset_uuid
        asset_folder.mkdir(parents=True, exist_ok=True)
        (asset_folder / "dummy.bin").write_text("data")

        await scheduler._cleanup_trash()

        assert not await _trash_exists(store, asset_uuid)
        assert not asset_folder.exists()
    finally:
        await store.close()


async def test_activity_log_retention_deletes_old_rows(db_pool, test_user, scheduler):
    """Old activity log rows are deleted when retention is enabled."""
    store = _make_store(test_user)
    try:
        node_id = str(uuid4())
        await _create_node(store, node_id)

        old_activity_id = str(uuid4())
        await _record_activity(store, old_activity_id, node_id, "created", {"detail": "Old entry"})
        old_date = datetime.now(UTC) - timedelta(days=91)
        await _set_activity_timestamp(store, old_activity_id, old_date)

        recent_activity_id = str(uuid4())
        await _record_activity(
            store, recent_activity_id, node_id, "edited", {"detail": "Recent entry"}
        )

        await scheduler._cleanup_activity_logs()

        details = await _activity_details(store)
        assert "Old entry" not in details
        assert "Recent entry" in details
    finally:
        await store.close()


async def test_activity_log_retention_disabled_keeps_rows(
    db_pool, test_user, scheduler
):
    """Activity log rows are kept when retention is disabled."""
    workspace_id = test_user["workspace_id"]
    await _set_workspace_setting(
        db_pool, workspace_id, "activity_log_retention_enabled", False
    )

    store = _make_store(test_user)
    try:
        node_id = str(uuid4())
        await _create_node(store, node_id)

        activity_id = str(uuid4())
        await _record_activity(store, activity_id, node_id, "created", {"detail": "Very old entry"})
        old_date = datetime.now(UTC) - timedelta(days=365)
        await _set_activity_timestamp(store, activity_id, old_date)

        await scheduler._cleanup_activity_logs()

        details = await _activity_details(store)
        assert "Very old entry" in details
    finally:
        await store.close()


async def test_task_completion_retention_deletes_old_rows(
    db_pool, test_user, scheduler
):
    """Old task completion rows are deleted when retention is enabled."""
    store = _make_store(test_user)
    try:
        node_id = str(uuid4())
        await _create_node(
            store,
            node_id,
            kind="block",
            class_ids=[SYSTEM_CLASS_UUIDS["task"]],
        )

        old_date = datetime.now(UTC) - timedelta(days=366)
        await store.record_task_completion(
            str(uuid4()),
            node_id,
            completed_at=old_date.isoformat(),
        )
        recent_date = datetime.now(UTC) - timedelta(days=1)
        await store.record_task_completion(
            str(uuid4()),
            node_id,
            completed_at=recent_date.isoformat(),
        )

        await scheduler._cleanup_task_completions()

        assert await _task_completion_count(store) == 1
    finally:
        await store.close()


async def test_task_completion_retention_disabled_keeps_rows(
    db_pool, test_user, scheduler
):
    """Task completion rows are kept when retention is disabled."""
    workspace_id = test_user["workspace_id"]
    await _set_workspace_setting(
        db_pool, workspace_id, "task_completion_retention_enabled", False
    )

    store = _make_store(test_user)
    try:
        node_id = str(uuid4())
        await _create_node(
            store,
            node_id,
            kind="block",
            class_ids=[SYSTEM_CLASS_UUIDS["task"]],
        )

        old_date = datetime.now(UTC) - timedelta(days=1000)
        await store.record_task_completion(
            str(uuid4()),
            node_id,
            completed_at=old_date.isoformat(),
        )

        await scheduler._cleanup_task_completions()

        assert await _task_completion_count(store) == 1
    finally:
        await store.close()
