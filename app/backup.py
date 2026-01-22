"""Backup scheduler for Notees.

NOTE: With PostgreSQL, database backups should be handled at the database level
using pg_dump, pg_basebackup, or WAL archiving. This module is kept for
backward compatibility but primarily manages the backup scheduler lifecycle.

For production, configure PostgreSQL backups using:
- pg_dump for logical backups
- Continuous archiving for point-in-time recovery
- Cloud provider snapshots (if applicable)
"""
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .config import settings
from .logging_config import get_logger

logger = get_logger(__name__)

MAX_BACKUPS = settings.max_backups
BACKUP_INTERVAL_SECONDS = settings.backup_interval_seconds


class BackupScheduler:
    """Manages automatic database backups.
    
    NOTE: With PostgreSQL, this scheduler logs backup reminders rather than
    performing file-based backups. Configure pg_dump or WAL archiving for
    actual database backups.
    """
    
    def __init__(self):
        self.running = False
        self.task: Optional[asyncio.Task] = None
    
    async def start(self):
        """Start the backup scheduler."""
        if self.running:
            return
        
        self.running = True
        self.task = asyncio.create_task(self._backup_loop())
        logger.info(
            f"Backup scheduler started. NOTE: PostgreSQL backups should be "
            f"configured separately using pg_dump or WAL archiving."
        )
    
    async def stop(self):
        """Stop the backup scheduler."""
        self.running = False
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
    
    async def _backup_loop(self):
        """Main backup loop - logs reminders for PostgreSQL backup."""
        while self.running:
            try:
                logger.debug(
                    f"Backup interval check. PostgreSQL backups should be "
                    f"handled via pg_dump or continuous archiving."
                )
            except Exception as e:
                logger.error(f"Backup scheduler error: {e}", exc_info=True)
            
            await asyncio.sleep(BACKUP_INTERVAL_SECONDS)
    
    async def backup_all_databases(self):
        """Placeholder for PostgreSQL backup.
        
        In a production setup, this could trigger pg_dump via subprocess.
        For now, it just logs a message.
        """
        logger.info("PostgreSQL backup triggered - use pg_dump for actual backups")
    
    def list_backups(self, user_id: str, db_name: str) -> list:
        """List available backups for a workspace.
        
        NOTE: With PostgreSQL, backups are managed at the database level.
        This returns an empty list as file-based backups no longer exist.
        """
        return []
    
    def restore_backup(self, user_id: str, db_name: str, backup_filename: str) -> bool:
        """Restore a database from a backup.
        
        NOTE: With PostgreSQL, use pg_restore or point-in-time recovery.
        """
        logger.warning(
            f"restore_backup called but PostgreSQL backups should be "
            f"restored using pg_restore. Backup: {backup_filename}"
        )
        return False


# Global backup scheduler instance
backup_scheduler = BackupScheduler()
