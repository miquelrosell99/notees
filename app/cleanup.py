"""Disk cleanup scheduler for Notees.

Removes orphaned workspace and user directories from disk after they have
been deleted from the database for a configurable grace period.
"""

from __future__ import annotations

import asyncio
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .config import settings
from .db.connection import get_connection, get_data_dir
from .logging_config import get_logger
from .system_settings import get_system_setting

logger = get_logger(__name__)

# Global singleton
_cleanup_scheduler: CleanupScheduler | None = None


class CleanupScheduler:
    """Periodic disk cleanup scheduler.

    Scans the data directory for workspace and user folders whose DB records
    no longer exist. Folders are only removed after they have been orphaned
    for longer than the configured grace period. A grace period of 0 disables
    cleanup for that category entirely.
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
