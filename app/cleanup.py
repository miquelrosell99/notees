"""Disk and data cleanup scheduler for Notees.

Removes:
- Orphaned workspace and user directories from disk after a configurable grace period.
- Soft-deleted nodes (trash) older than the workspace retention setting.
- Old activity log rows when activity-log retention is enabled.
- Old task completion rows when task-completion retention is enabled.

The scheduler only orchestrates cleanup timing; all SQL and retention business
logic lives in CleanupRepository.
"""

from __future__ import annotations

import asyncio
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .config import settings
from .db.connection import get_data_dir, get_pool, get_workspace_assets_dir
from .domain.repositories.factories import make_cleanup_repository
from .domain.repositories.interfaces import CleanupRepository
from .features.assets.repository import PostgresAssetRepository
from .features.assets.service import AssetFileService
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
        self._cleanup_repo: CleanupRepository | None = None
        self.interval = interval_seconds
        self.workspace_max_age_days = workspace_max_age_days
        self.user_max_age_days = user_max_age_days
        self.running = False
        self.task: asyncio.Task | None = None

    async def _get_repo(self) -> CleanupRepository:
        if self._cleanup_repo is None:
            self._cleanup_repo = make_cleanup_repository(await get_pool())
        return self._cleanup_repo

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
        active_uuids = {
            str(ws["uuid"]) for ws in await (await self._get_repo()).list_active_workspaces()
        }

        for entry in workspaces_dir.iterdir():
            if not entry.is_dir():
                continue

            workspace_uuid = entry.name
            if workspace_uuid in active_uuids:
                continue

            mtime = datetime.fromtimestamp(entry.stat().st_mtime, tz=UTC)
            if mtime > cutoff:
                continue

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

        for entry in users_dir.iterdir():
            if not entry.is_dir():
                continue

            user_id = entry.name
            if await (await self._get_repo()).user_exists(user_id):
                continue

            mtime = datetime.fromtimestamp(entry.stat().st_mtime, tz=UTC)
            if mtime > cutoff:
                continue

            logger.info(f"Removing orphaned user directory: {entry}")
            try:
                shutil.rmtree(entry)
            except Exception as e:
                logger.error(f"Failed to remove {entry}: {e}")

    async def _cleanup_trash(self):
        """Hard-delete soft-deleted nodes older than the workspace retention setting."""
        for ws_row in await (await self._get_repo()).list_active_workspaces():
            workspace_id = ws_row["id"]
            workspace_uuid = str(ws_row["uuid"])

            retention_days = await (await self._get_repo()).get_workspace_setting(
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
            pool = await get_pool()
            asset_repo = PostgresAssetRepository(pool, workspace_id, 0)
            file_service = AssetFileService(workspace_uuid, asset_repo)

            while True:
                rows = await (await self._get_repo()).hard_delete_trashed_nodes_batch(
                    workspace_id, cutoff, _TRASH_BATCH_SIZE
                )
                if not rows:
                    break

                for row in rows:
                    if row["is_asset"] and row.get("asset_file_id"):
                        try:
                            await file_service.delete_asset(int(row["asset_file_id"]))
                        except Exception as e:
                            logger.error(
                                f"[TRASH_CLEANUP] Failed to delete asset file "
                                f"{row['uuid']} in workspace {workspace_id}: {e}"
                            )

                    if row["is_asset"]:
                        try:
                            asset_folder = get_workspace_assets_dir(workspace_uuid) / str(row["uuid"])
                            if asset_folder.exists():
                                shutil.rmtree(asset_folder, ignore_errors=True)
                        except Exception as e:
                            logger.error(
                                f"[TRASH_CLEANUP] Failed to delete asset folder "
                                f"{row['uuid']} in workspace {workspace_id}: {e}"
                            )

                logger.info(
                    f"[TRASH_CLEANUP] Hard-deleted {len(rows)} trashed nodes "
                    f"in workspace {workspace_id} (retention: {retention_days} days)"
                )

    async def _cleanup_activity_logs(self):
        """Delete old activity log rows when retention is enabled."""
        for ws_row in await (await self._get_repo()).list_active_workspaces():
            workspace_id = ws_row["id"]

            enabled = await (await self._get_repo()).get_workspace_setting(
                workspace_id,
                "activity_log_retention_enabled",
                settings.activity_log_retention_enabled,
            )
            if not enabled:
                continue

            retention_days = await (await self._get_repo()).get_workspace_setting(
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
            deleted = await (await self._get_repo()).delete_activity_logs_older_than(
                workspace_id, cutoff
            )
            if deleted:
                logger.info(
                    f"[ACTIVITY_LOG_CLEANUP] Deleted {deleted} old rows "
                    f"in workspace {workspace_id} (retention: {retention_days} days)"
                )

    async def _cleanup_task_completions(self):
        """Delete old task completion rows when retention is enabled."""
        for ws_row in await (await self._get_repo()).list_active_workspaces():
            workspace_id = ws_row["id"]

            enabled = await (await self._get_repo()).get_workspace_setting(
                workspace_id,
                "task_completion_retention_enabled",
                settings.task_completion_retention_enabled,
            )
            if not enabled:
                continue

            retention_days = await (await self._get_repo()).get_workspace_setting(
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
            deleted = await (await self._get_repo()).delete_task_completions_older_than(
                workspace_id, cutoff
            )
            if deleted:
                logger.info(
                    f"[TASK_COMPLETION_CLEANUP] Deleted {deleted} old rows "
                    f"in workspace {workspace_id} (retention: {retention_days} days)"
                )


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
