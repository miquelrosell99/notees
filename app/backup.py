"""Backup scheduler for Notees.

Provides automated PostgreSQL backups using pg_dump.
Backups are stored as custom-format .dump files for efficient compression and restore.
"""
import asyncio
import os
import sys
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List

from .config import settings
from .db.connection import get_database_url
from .logging_config import get_logger

logger = get_logger(__name__)


def find_pg_dump() -> Optional[str]:
    """Find pg_dump executable on Windows."""
    if sys.platform != 'win32':
        return 'pg_dump'  # Assume it's in PATH on Unix
    
    # Common PostgreSQL installation paths on Windows
    possible_paths = [
        Path(os.environ.get('PROGRAMFILES', 'C:\\Program Files')) / 'PostgreSQL',
        Path(os.environ.get('PROGRAMFILES(X86)', 'C:\\Program Files (x86)')) / 'PostgreSQL',
    ]
    
    for base_path in possible_paths:
        if base_path.exists():
            # Look for version directories (18, 17, 16, etc.)
            for version_dir in sorted(base_path.iterdir(), reverse=True):
                if version_dir.is_dir():
                    bin_dir = version_dir / 'bin'
                    pg_dump_path = bin_dir / 'pg_dump.exe'
                    if pg_dump_path.exists():
                        return str(pg_dump_path)
    
    return 'pg_dump'  # Fallback to PATH


class BackupScheduler:
    """PostgreSQL backup scheduler using pg_dump."""
    
    def __init__(self, interval_seconds: int = 3600, max_backups: int = 50):
        """Initialize backup scheduler.
        
        Args:
            interval_seconds: Time between backups (default: 1 hour)
            max_backups: Maximum number of backups to keep (default: 50)
        """
        self.interval = interval_seconds
        self.max_backups = max_backups
        self.backup_dir = Path("data/backups")
        self.running = False
        self.task: Optional[asyncio.Task] = None
    
    async def start(self):
        """Start the backup scheduler."""
        if self.running:
            logger.warning("Backup scheduler already running")
            return
        
        self.running = True
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        self.task = asyncio.create_task(self._backup_loop())
        logger.info(f"Backup scheduler started (interval: {self.interval}s, max_backups: {self.max_backups})")
    
    async def stop(self):
        """Stop the backup scheduler."""
        self.running = False
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                logger.info("Backup scheduler stopped")
    
    async def _backup_loop(self):
        """Main backup loop."""
        while self.running:
            try:
                await self._create_backup()
                await self._cleanup_old_backups()
            except Exception as e:
                logger.error(f"Backup failed: {e}", exc_info=True)
            
            await asyncio.sleep(self.interval)
    
    async def _create_backup(self):
        """Create a PostgreSQL backup using pg_dump."""
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        backup_file = self.backup_dir / f"notees_backup_{timestamp}.dump"
        
        # Get database URL
        db_url = get_database_url()
        
        # Find pg_dump executable
        pg_dump = find_pg_dump()
        
        logger.info(f"Creating backup: {backup_file.name}")
        
        try:
            # Run pg_dump with custom format for better compression
            process = await asyncio.create_subprocess_exec(
                pg_dump,
                db_url,
                "--file", str(backup_file),
                "--format", "custom",
                "--compress", "9",
                "--verbose",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            
            stdout, stderr = await process.communicate()
            
            if process.returncode != 0:
                error_msg = stderr.decode() if stderr else "Unknown error"
                raise RuntimeError(f"pg_dump failed with code {process.returncode}: {error_msg}")
            
            # Get file size
            size_mb = backup_file.stat().st_size / (1024 * 1024)
            logger.info(f"Backup created successfully: {backup_file.name} ({size_mb:.2f} MB)")
            
        except FileNotFoundError:
            logger.error(
                "pg_dump command not found. Please install PostgreSQL client tools. "
                "On Ubuntu: apt install postgresql-client, on macOS: brew install postgresql"
            )
        except Exception as e:
            logger.error(f"Failed to create backup: {e}", exc_info=True)
            # Clean up partial backup file
            if backup_file.exists():
                backup_file.unlink()
    
    async def _cleanup_old_backups(self):
        """Remove old backups exceeding max_backups limit."""
        backups = sorted(self.backup_dir.glob("notees_backup_*.dump"), key=lambda p: p.stat().st_mtime)
        
        while len(backups) > self.max_backups:
            oldest = backups.pop(0)
            try:
                oldest.unlink()
                logger.info(f"Removed old backup: {oldest.name}")
            except Exception as e:
                logger.error(f"Failed to remove old backup {oldest.name}: {e}")
    
    def list_backups(self) -> List[dict]:
        """List all available backups.
        
        Returns:
            List of backup info dicts with name, path, size, and created timestamp
        """
        backups = []
        for backup_file in sorted(self.backup_dir.glob("notees_backup_*.dump"), reverse=True):
            stat = backup_file.stat()
            backups.append({
                "name": backup_file.name,
                "path": str(backup_file),
                "size_mb": stat.st_size / (1024 * 1024),
                "created": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
            })
        return backups
    
    async def restore_backup(self, backup_filename: str) -> bool:
        """Restore a database from a backup using pg_restore.
        
        WARNING: This will drop and recreate the database. All current data will be lost.
        
        Args:
            backup_filename: Name of the backup file to restore
            
        Returns:
            True if restore was successful, False otherwise
        """
        backup_file = self.backup_dir / backup_filename
        
        if not backup_file.exists():
            logger.error(f"Backup file not found: {backup_filename}")
            return False
        
        db_url = get_database_url()
        
        logger.warning(f"Starting database restore from {backup_filename} - THIS WILL ERASE CURRENT DATA")
        
        try:
            # Use pg_restore with --clean to drop existing objects first
            process = await asyncio.create_subprocess_exec(
                "pg_restore",
                "--dbname", db_url,
                "--clean",
                "--if-exists",
                "--verbose",
                str(backup_file),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            
            stdout, stderr = await process.communicate()
            
            if process.returncode != 0:
                error_msg = stderr.decode() if stderr else "Unknown error"
                logger.error(f"pg_restore failed: {error_msg}")
                return False
            
            logger.info(f"Database restored successfully from {backup_filename}")
            return True
            
        except FileNotFoundError:
            logger.error("pg_restore command not found. Please install PostgreSQL client tools.")
            return False
        except Exception as e:
            logger.error(f"Failed to restore backup: {e}", exc_info=True)
            return False


# Global backup scheduler instance using settings
backup_scheduler = BackupScheduler(
    interval_seconds=settings.backup_interval_seconds,
    max_backups=settings.max_backups
)
