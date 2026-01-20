"""Backup scheduler for Notees.

Creates hourly backups of databases and keeps the last 50.
"""
import asyncio
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .config import settings
from .logging_config import get_logger

logger = get_logger(__name__)

MAX_BACKUPS = settings.max_backups
BACKUP_INTERVAL_SECONDS = settings.backup_interval_seconds


class BackupScheduler:
    """Manages automatic database backups."""
    
    def __init__(self):
        self.running = False
        self.task: Optional[asyncio.Task] = None
    
    async def start(self):
        """Start the backup scheduler."""
        if self.running:
            return
        
        self.running = True
        self.task = asyncio.create_task(self._backup_loop())
        logger.info(f"Backup scheduler started (interval: {BACKUP_INTERVAL_SECONDS}s, max backups: {MAX_BACKUPS})")
    
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
        """Main backup loop."""
        while self.running:
            try:
                await self.backup_all_databases()
            except Exception as e:
                logger.error(f"Backup error: {e}", exc_info=True)
            
            await asyncio.sleep(BACKUP_INTERVAL_SECONDS)
    
    async def backup_all_databases(self):
        """Backup all user databases."""
        users_dir = Path("data/users")
        if not users_dir.exists():
            return
        
        for user_dir in users_dir.iterdir():
            if not user_dir.is_dir():
                continue
            
            user_id = user_dir.name
            databases_dir = user_dir / "databases"
            
            if not databases_dir.exists():
                continue
            
            for db_file in databases_dir.glob("*.db"):
                await self.backup_database(user_id, db_file.stem, db_file)
    
    async def backup_database(self, user_id: str, db_name: str, db_path: Path):
        """Backup a single database."""
        backups_dir = Path(f"data/users/{user_id}/backups/{db_name}")
        backups_dir.mkdir(parents=True, exist_ok=True)
        
        # Create backup filename with timestamp
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        backup_file = backups_dir / f"{db_name}_{timestamp}.db"
        
        # Copy database file
        try:
            shutil.copy2(db_path, backup_file)
            logger.info(f"Backup created: {backup_file}")
        except Exception as e:
            logger.error(f"Failed to backup {db_path}: {e}", exc_info=True)
            return
        
        # Clean up old backups
        await self.cleanup_old_backups(backups_dir)
    
    async def cleanup_old_backups(self, backups_dir: Path):
        """Remove old backups, keeping only the last MAX_BACKUPS."""
        backups = sorted(backups_dir.glob("*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
        
        for old_backup in backups[MAX_BACKUPS:]:
            try:
                old_backup.unlink()
                logger.debug(f"Removed old backup: {old_backup}")
            except Exception as e:
                logger.error(f"Failed to remove backup {old_backup}: {e}")
    
    def list_backups(self, user_id: str, db_name: str) -> list:
        """List available backups for a database."""
        backups_dir = Path(f"data/users/{user_id}/backups/{db_name}")
        if not backups_dir.exists():
            return []
        
        backups = []
        for backup_file in sorted(backups_dir.glob("*.db"), reverse=True):
            backups.append({
                "filename": backup_file.name,
                "size_bytes": backup_file.stat().st_size,
                "created_at": datetime.fromtimestamp(backup_file.stat().st_mtime).isoformat()
            })
        
        return backups
    
    def restore_backup(self, user_id: str, db_name: str, backup_filename: str) -> bool:
        """Restore a database from a backup."""
        backups_dir = Path(f"data/users/{user_id}/backups/{db_name}")
        backup_file = backups_dir / backup_filename
        
        if not backup_file.exists():
            return False
        
        databases_dir = Path(f"data/users/{user_id}/databases")
        db_file = databases_dir / f"{db_name}.db"
        
        try:
            shutil.copy2(backup_file, db_file)
            print(f"Restored backup: {backup_file} -> {db_file}")
            return True
        except Exception as e:
            print(f"Failed to restore backup: {e}")
            return False


# Global backup scheduler instance
backup_scheduler = BackupScheduler()
