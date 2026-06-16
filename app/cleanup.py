"""Disk and data cleanup scheduler for Notees.

Removes:
- Orphaned workspace and user directories from disk after a configurable grace period.
- Soft-deleted nodes (trash) older than the workspace retention setting.
- Old activity log rows when activity-log retention is enabled.
- Old task completion rows when task-completion retention is enabled.
"""

from __future__ import annotations

import asyncio
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .config import settings
from .db.connection import get_connection, get_data_dir
from .domain.services.asset_service import AssetFileService
from .logging_config import get_logger
from .system_settings import get_system_setting

logger = get_logger(__name__)

# Maximum number of nodes to hard-delete in a single trash cleanup batch.
_TRASH_BATCH_SIZE = 500

# Global singleton
_cleanup_scheduler: CleanupScheduler | None = None


class CleanupScheduler:
    """Periodic cleanup scheduler.

    Scans the data directory for orphaned workspace/user folders and applies
    workspace retention policies to trash, activity logs, and task completions.
    """

    def __init__(
        self,
        interval_seconds: int = 86400,
        workspace_max_age_days: int = 30,
        user_max_age_days: int = 30,
    ):
        self.interval = interval_seconds
        self.workspace_max_age_days = workspace_max_age_days
        self.user_max_age_days = user_max_age_days
        self.running = False
        self.task: asyncio.Task | None = None

    async def start(self):
        """Start the cleanup scheduler."""
        if self.running:
            logger.warning("Cleanup scheduler already running")
            return

        self.running = True
        self.task = asyncio.create_task(self._cleanup_loop())
        logger.info(
            f"Cleanup scheduler started "
            f"(interval: {self.interval}s, "
            f"workspace_grace: {self.workspace_max_age_days}d, "
            f"user_grace: {self.user_max_age_days}d)"
        )

    async def stop(self):
        """Stop the cleanup scheduler."""
        self.running = False
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                logger.info("Cleanup scheduler stopped")

    async def _cleanup_loop(self):
        """Main cleanup loop."""
        # Run once immediately on startup, then on interval
        while self.running:
            try:
                await self._run_cleanup()
            except Exception as e:
                logger.error(f"Cleanup failed: {e}", exc_info=True)

            # Re-read interval from system settings each cycle
            try:
                interval = await get_system_setting("cleanup_interval_seconds", self.interval)
                self.interval = max(60, int(interval))
            except (ValueError, TypeError):
                pass

            await asyncio.sleep(self.interval)

    async def _run_cleanup(self):
        """Execute one cleanup pass."""
        data_dir = get_data_dir()

        # Read current settings from DB (fall back to env vars)
        workspace_days = await get_system_setting("cleanup_workspace_max_age_days", self.workspace_max_age_days)
        user_days = await get_system_setting("cleanup_user_max_age_days", self.user_max_age_days)

        if int(workspace_days) > 0:
            await self._cleanup_workspaces(data_dir, int(workspace_days))

        if int(user_days) > 0:
            await self._cleanup_users(data_dir, int(user_days))

        # Data retention policies
        await self._cleanup_trash()
        await self._cleanup_activity_logs()
        await self._cleanup_task_completions()

    async def _cleanup_workspaces(self, data_dir: Path, max_age_days: int):
        """Remove orphaned workspace directories."""
        workspaces_dir = data_dir / "workspaces"
        if not workspaces_dir.exists():
            return

        cutoff = datetime.now(UTC) - timedelta(days=max_age_days)

        async with get_connection() as conn:
            for entry in workspaces_dir.iterdir():
                if not entry.is_dir():
                    continue

                workspace_uuid = entry.name
                # Check if workspace still exists in DB
                row = await conn.fetchrow(
                    "SELECT 1 FROM workspace WHERE uuid::text = $1 AND active = TRUE",
                    workspace_uuid,
                )
                if row is not None:
                    continue  # Workspace still exists

                # Check age
                mtime = datetime.fromtimestamp(entry.stat().st_mtime, tz=UTC)
                if mtime > cutoff:
                    continue  # Too recent

                logger.info(f"Removing orphaned workspace directory: {entry}")
                try:
                    shutil.rmtree(entry)
                except Exception as e:
                    logger.error(f"Failed to remove {entry}: {e}")

    async def _cleanup_users(self, data_dir: Path, max_age_days: int):
        """Remove orphaned user directories."""
        users_dir = data_dir / "users"
        if not users_dir.exists():
            return

        cutoff = datetime.now(UTC) - timedelta(days=max_age_days)

        async with get_connection() as conn:
            for entry in users_dir.iterdir():
                if not entry.is_dir():
                    continue

                user_id = entry.name
                # Check if user still exists in DB
                row = await conn.fetchrow(
                    'SELECT 1 FROM "user" WHERE id::text = $1 OR uuid::text = $1',
                    user_id,
                )
                if row is not None:
                    continue  # User still exists

                # Check age
                mtime = datetime.fromtimestamp(entry.stat().st_mtime, tz=UTC)
                if mtime > cutoff:
                    continue  # Too recent

                logger.info(f"Removing orphaned user directory: {entry}")
                try:
                    shutil.rmtree(entry)
                except Exception as e:
                    logger.error(f"Failed to remove {entry}: {e}")

    async def _get_workspace_setting(
        self,
        conn,
        workspace_id: int,
        key: str,
        default: Any,
    ) -> Any:
        """Read a single workspace setting, falling back to the env default.

        Values are stored as JSONB, but some legacy paths wrote JSON-encoded
        strings (e.g. the string "false" instead of the boolean false). This
        helper normalizes those string-encoded primitives back to native Python
        values.
        """
        row = await conn.fetchrow(
            "SELECT value FROM setting_workspace WHERE workspace_id = $1 AND key = $2",
            workspace_id,
            key,
        )
        if row is None or row["value"] is None:
            return default
        value = row["value"]
        if isinstance(value, str):
            lowered = value.lower()
            if lowered == "true":
                return True
            if lowered == "false":
                return False
            try:
                return int(value)
            except ValueError:
                pass
        return value

    async def _cleanup_trash(self):
        """Hard-delete soft-deleted nodes older than the workspace retention setting."""
        async with get_connection() as conn:
            workspaces = await conn.fetch(
                "SELECT id, uuid FROM workspace WHERE active = TRUE"
            )

            for ws_row in workspaces:
                workspace_id = ws_row["id"]
                workspace_uuid = str(ws_row["uuid"])

                retention_days = await self._get_workspace_setting(
                    conn,
                    workspace_id,
                    "trash_retention_days",
                    settings.default_trash_retention_days,
                )
                try:
                    retention_days = int(retention_days)
                except (ValueError, TypeError):
                    retention_days = settings.default_trash_retention_days

                if retention_days <= 0:
                    continue

                cutoff = datetime.now(UTC) - timedelta(days=retention_days)

                while True:
                    rows = await conn.fetch(
                        """
                        SELECT id, uuid, is_asset
                        FROM node
                        WHERE workspace_id = $1
                          AND is_deleted = TRUE
                          AND deleted_at < $2
                        ORDER BY id
                        LIMIT $3
                        """,
                        workspace_id,
                        cutoff,
                        _TRASH_BATCH_SIZE,
                    )
                    if not rows:
                        break

                    ids_to_delete = [row["id"] for row in rows]

                    # Delete asset folders before the DB rows disappear
                    file_service = AssetFileService(workspace_uuid)
                    for row in rows:
                        if row["is_asset"]:
                            try:
                                file_service.delete_asset(str(row["uuid"]))
                            except Exception as e:
                                logger.error(
                                    f"[TRASH_CLEANUP] Failed to delete asset folder "
                                    f"{row['uuid']} in workspace {workspace_id}: {e}"
                                )

                    await conn.execute(
                        "DELETE FROM node WHERE id = ANY($1::integer[]) AND workspace_id = $2",
                        ids_to_delete,
                        workspace_id,
                    )

                    logger.info(
                        f"[TRASH_CLEANUP] Hard-deleted {len(ids_to_delete)} trashed nodes "
                        f"in workspace {workspace_id} (retention: {retention_days} days)"
                    )

    async def _cleanup_activity_logs(self):
        """Delete old activity log rows when retention is enabled."""
        async with get_connection() as conn:
            workspaces = await conn.fetch(
                "SELECT id FROM workspace WHERE active = TRUE"
            )

            for ws_row in workspaces:
                workspace_id = ws_row["id"]

                enabled = await self._get_workspace_setting(
                    conn,
                    workspace_id,
                    "activity_log_retention_enabled",
                    settings.activity_log_retention_enabled,
                )
                if not enabled:
                    continue

                retention_days = await self._get_workspace_setting(
                    conn,
                    workspace_id,
                    "activity_log_retention_days",
                    settings.activity_log_retention_days,
                )
                try:
                    retention_days = int(retention_days)
                except (ValueError, TypeError):
                    retention_days = settings.activity_log_retention_days

                if retention_days <= 0:
                    continue

                cutoff = datetime.now(UTC) - timedelta(days=retention_days)
                result = await conn.execute(
                    """
                    DELETE FROM node_activity na
                    USING node n
                    WHERE na.node_id = n.id
                      AND n.workspace_id = $1
                      AND na.create_date < $2
                    """,
                    workspace_id,
                    cutoff,
                )
                deleted = _deleted_count_from_result(result)
                if deleted:
                    logger.info(
                        f"[ACTIVITY_LOG_CLEANUP] Deleted {deleted} old rows "
                        f"in workspace {workspace_id} (retention: {retention_days} days)"
                    )

    async def _cleanup_task_completions(self):
        """Delete old task completion rows when retention is enabled."""
        async with get_connection() as conn:
            workspaces = await conn.fetch(
                "SELECT id FROM workspace WHERE active = TRUE"
            )

            for ws_row in workspaces:
                workspace_id = ws_row["id"]

                enabled = await self._get_workspace_setting(
                    conn,
                    workspace_id,
                    "task_completion_retention_enabled",
                    settings.task_completion_retention_enabled,
                )
                if not enabled:
                    continue

                retention_days = await self._get_workspace_setting(
                    conn,
                    workspace_id,
                    "task_completion_retention_days",
                    settings.task_completion_retention_days,
                )
                try:
                    retention_days = int(retention_days)
                except (ValueError, TypeError):
                    retention_days = settings.task_completion_retention_days

                if retention_days <= 0:
                    continue

                cutoff = datetime.now(UTC) - timedelta(days=retention_days)
                result = await conn.execute(
                    "DELETE FROM task_completion WHERE workspace_id = $1 AND completed_at < $2",
                    workspace_id,
                    cutoff,
                )
                deleted = _deleted_count_from_result(result)
                if deleted:
                    logger.info(
                        f"[TASK_COMPLETION_CLEANUP] Deleted {deleted} old rows "
                        f"in workspace {workspace_id} (retention: {retention_days} days)"
                    )


def _deleted_count_from_result(result: str) -> int:
    """Extract the number of deleted rows from an asyncpg DELETE result string."""
    # asyncpg returns strings like "DELETE 42"
    try:
        parts = result.split()
        if len(parts) == 2 and parts[0] == "DELETE":
            return int(parts[1])
    except (ValueError, IndexError):
        pass
    return 0


def get_cleanup_scheduler() -> CleanupScheduler:
    """Get or create the global cleanup scheduler instance."""
    global _cleanup_scheduler
    if _cleanup_scheduler is None:
        _cleanup_scheduler = CleanupScheduler(
            interval_seconds=settings.cleanup_interval_seconds,
            workspace_max_age_days=settings.cleanup_workspace_max_age_days,
            user_max_age_days=settings.cleanup_user_max_age_days,
        )
    return _cleanup_scheduler
