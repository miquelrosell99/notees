"""Database connection and initialization utilities.

Database folder structure:
  data/users/{user_id}/databases/{db_name}/
    ├── db.sqlite      # The SQLite database file
    └── assets/        # Assets folder for uploaded files
"""
import aiosqlite
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
import uuid as uuid_module

# Base data directory
DATA_DIR = Path(__file__).parent.parent.parent / "data"

# Cache for current user context
_current_user_id: Optional[str] = None
_current_db_name: Optional[str] = None


def set_current_user(user_id: str):
    """Set the current user context."""
    global _current_user_id
    _current_user_id = user_id


def get_current_user() -> Optional[str]:
    """Get the current user ID."""
    return _current_user_id


def get_user_data_dir(user_id: str) -> Path:
    """Get the data directory for a user."""
    user_dir = DATA_DIR / "users" / user_id
    user_dir.mkdir(parents=True, exist_ok=True)
    return user_dir


def get_databases_dir(user_id: str) -> Path:
    """Get the databases directory for a user."""
    db_dir = get_user_data_dir(user_id) / "databases"
    db_dir.mkdir(parents=True, exist_ok=True)
    return db_dir


def get_database_folder(user_id: str, name: str) -> Path:
    """Get the folder for a specific database.
    
    Each database has its own folder containing:
    - db.sqlite: The database file
    - assets/: Folder for uploaded assets
    """
    db_folder = get_databases_dir(user_id) / name
    db_folder.mkdir(parents=True, exist_ok=True)
    return db_folder


def get_assets_dir(user_id: str, db_name: Optional[str] = None) -> Path:
    """Get the assets directory for a database.
    
    Assets are stored as files named with their node UUID.
    """
    if db_name is None:
        db_name = get_active_db_name(user_id)
    assets_dir = get_database_folder(user_id, db_name) / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    return assets_dir


def get_export_dir(user_id: str, db_name: str) -> Path:
    """Get the export directory for a database."""
    export_dir = get_user_data_dir(user_id) / "export" / db_name
    export_dir.mkdir(parents=True, exist_ok=True)
    return export_dir


def get_active_db_file(user_id: str) -> Path:
    """Get the file that stores the active database name."""
    return get_user_data_dir(user_id) / ".active_database"


def _db_exists(user_id: str, name: str) -> bool:
    """Check if a database exists (folder-based format)."""
    db_folder = get_databases_dir(user_id) / name
    return db_folder.is_dir() and (db_folder / "db.sqlite").exists()


def get_active_db_name(user_id: str) -> Optional[str]:
    """Get the name of the currently active database for a user.
    
    Returns None if no active database is set or if the active database doesn't exist.
    """
    active_file = get_active_db_file(user_id)
    
    if active_file.exists():
        name = active_file.read_text().strip()
        if name and _db_exists(user_id, name):
            return name
    
    return None


def set_active_db(user_id: str, name: str) -> bool:
    """Set the active database for a user."""
    global _current_db_name
    
    if not _db_exists(user_id, name):
        return False
    
    _current_db_name = name
    get_active_db_file(user_id).write_text(name)
    
    return True


def clear_active_db(user_id: str) -> None:
    """Clear the active database for a user (set to none)."""
    global _current_db_name
    _current_db_name = None
    active_file = get_active_db_file(user_id)
    if active_file.exists():
        active_file.unlink()


def get_db_path(user_id: str, name: Optional[str] = None) -> Path:
    """Get path to a database file (folder-based format)."""
    if name is None:
        name = get_active_db_name(user_id)
    
    db_folder = get_databases_dir(user_id) / name
    return db_folder / "db.sqlite"


async def get_db(user_id: str, name: Optional[str] = None) -> aiosqlite.Connection:
    """Get database connection for a user's database."""
    db_path = get_db_path(user_id, name)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    
    db = await aiosqlite.connect(db_path)
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA foreign_keys = ON")
    await db.execute("PRAGMA journal_mode = WAL")
    await db.execute("PRAGMA busy_timeout = 5000")  # Wait up to 5 seconds if locked
    return db


async def init_db(user_id: str, name: Optional[str] = None) -> aiosqlite.Connection:
    """Initialize database tables using the proper schema from schema.py."""
    from .schema import init_database
    
    # Ensure the database folder and assets directory exist
    if name is None:
        name = get_active_db_name(user_id)
    get_assets_dir(user_id, name)
    
    db_path = get_db_path(user_id, name)
    return await init_database(db_path)
