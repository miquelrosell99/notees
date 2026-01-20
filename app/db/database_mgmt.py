"""Database management operations for Notees.

Handles database lifecycle: create, list, switch, delete, import, export.

Database folder structure:
  data/users/{user_id}/databases/{db_name}/
    ├── db.sqlite      # The SQLite database file
    └── assets/        # Assets folder for uploaded files
"""
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Any

from .connection import (
    get_db, get_databases_dir, get_db_path, get_active_db_name, 
    set_active_db, get_user_data_dir, init_db, get_database_folder,
    get_assets_dir
)
from ..logging_config import get_logger

logger = get_logger(__name__)


def _get_db_size(user_id: str, name: str) -> int:
    """Get total size of database folder (including assets)."""
    db_folder = get_database_folder(user_id, name)
    total_size = 0
    for f in db_folder.rglob("*"):
        if f.is_file():
            total_size += f.stat().st_size
    return total_size


async def list_databases(user_id: str) -> List[Dict[str, Any]]:
    """List all available databases for a user (folder-based format only)."""
    db_dir = get_databases_dir(user_id)
    active_name = get_active_db_name(user_id)
    databases = []
    
    # Check folder format databases
    for db_folder in db_dir.iterdir():
        if db_folder.is_dir():
            db_file = db_folder / "db.sqlite"
            if db_file.exists():
                name = db_folder.name
                
                try:
                    db = await get_db(user_id, name)
                    try:
                        # Get node count (active = 1 means not deleted)
                        cursor = await db.execute(
                            "SELECT COUNT(*) as count FROM node WHERE active = 1"
                        )
                        row = await cursor.fetchone()
                        node_count = row["count"] if row else 0
                        
                        # Get page count using is_page column
                        cursor = await db.execute(
                            "SELECT COUNT(*) as count FROM node WHERE is_page = 1 AND active = 1"
                        )
                        row = await cursor.fetchone()
                        page_count = row["count"] if row else 0
                        
                        # Get created_at from file creation time (fallback to current time)
                        created_at = datetime.fromtimestamp(
                            db_file.stat().st_ctime, tz=timezone.utc
                        ).isoformat()
                        
                    finally:
                        await db.close()
                    
                    # Count assets
                    assets_dir = get_assets_dir(user_id, name)
                    asset_count = len(list(assets_dir.glob("*"))) if assets_dir.exists() else 0
                    
                    databases.append({
                        "name": name,
                        "filename": "db.sqlite",
                        "created_at": created_at,
                        "updated_at": datetime.fromtimestamp(db_file.stat().st_mtime).isoformat(),
                        "node_count": node_count,
                        "page_count": page_count,
                        "asset_count": asset_count,
                        "is_active": name == active_name,
                        "size_bytes": _get_db_size(user_id, name),
                        "user_id": user_id
                    })
                except Exception as e:
                    logger.error(f"Error reading database {name}: {e}", exc_info=True)
                    continue
    
    return sorted(databases, key=lambda x: x["name"])


async def create_database(user_id: str, name: str) -> Dict[str, Any]:
    """Create a new database for a user.
    
    Creates folder structure:
      databases/{name}/
        ├── db.sqlite
        └── assets/
    """
    # Sanitize name
    name = re.sub(r'[^\w\-]', '_', name.lower())
    
    db_folder = get_database_folder(user_id, name)
    db_path = db_folder / "db.sqlite"
    if db_path.exists():
        raise ValueError(f"Database '{name}' already exists")
    
    # Initialize the new database (this also creates the assets folder)
    conn = await init_db(user_id, name)
    if conn:
        await conn.close()
    logger.info(f"Created database '{name}' for user {user_id}")
    
    # Auto-set as active if no database is currently active
    is_active = False
    current_active = get_active_db_name(user_id)
    if current_active is None:
        set_active_db(user_id, name)
        is_active = True
        logger.info(f"Auto-activated database '{name}' for user {user_id}")
    
    # Return info directly (don't rely on list_databases which might fail on fresh db)
    now = datetime.now(timezone.utc).isoformat()
    return {
        "name": name,
        "filename": "db.sqlite",
        "created_at": now,
        "updated_at": now,
        "node_count": 0,
        "page_count": 0,
        "asset_count": 0,
        "is_active": is_active,
        "size_bytes": db_path.stat().st_size if db_path.exists() else 0,
        "user_id": user_id
    }


async def delete_database(user_id: str, name: str) -> bool:
    """Delete a database and all its assets."""
    active_db = get_active_db_name(user_id)
    if active_db and name == active_db:
        raise ValueError("Cannot delete the active database")
    
    db_folder = get_databases_dir(user_id) / name
    if not db_folder.is_dir():
        return False
    
    # Delete entire folder including assets
    shutil.rmtree(db_folder)
    logger.info(f"Deleted database folder '{name}' for user {user_id}")
    
    return True


async def switch_database(user_id: str, name: str) -> bool:
    """Switch to a different database."""
    db_path = get_db_path(user_id, name)
    if not db_path.exists():
        return False
    
    result = set_active_db(user_id, name)
    if result:
        logger.info(f"Switched to database '{name}' for user {user_id}")
    return result


async def export_database(user_id: str, name: str) -> Path:
    """Export a database file for download."""
    db_path = get_db_path(user_id, name)
    if not db_path.exists():
        raise ValueError(f"Database '{name}' not found")
    
    # Create export directory
    export_dir = get_user_data_dir(user_id) / "exports"
    export_dir.mkdir(exist_ok=True)
    
    # Copy database file
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    export_path = export_dir / f"{name}_{timestamp}.db"
    shutil.copy2(db_path, export_path)
    logger.info(f"Exported database '{name}' to {export_path}")
    
    return export_path


async def rename_database(user_id: str, old_name: str, new_name: str) -> Dict[str, Any]:
    """Rename a database (folder).
    
    Renames the database folder from old_name to new_name.
    Cannot rename the active database.
    """
    # Sanitize new name
    new_name = re.sub(r'[^\w\-]', '_', new_name.lower())
    
    active_db = get_active_db_name(user_id)
    if active_db and old_name == active_db:
        raise ValueError("Cannot rename the active database. Please switch to another database first.")
    
    old_folder = get_database_folder(user_id, old_name)
    if not old_folder.is_dir():
        raise ValueError(f"Database '{old_name}' not found")
    
    new_folder = get_database_folder(user_id, new_name)
    if new_folder.exists():
        raise ValueError(f"Database '{new_name}' already exists")
    
    # Rename the folder
    old_folder.rename(new_folder)
    logger.info(f"Renamed database '{old_name}' to '{new_name}' for user {user_id}")
    
    # Return updated info
    databases = await list_databases(user_id)
    return next((d for d in databases if d["name"] == new_name), {})


async def import_database(user_id: str, file_path: Path, name: str) -> Dict[str, Any]:
    """Import a database file into the new folder structure."""
    name = re.sub(r'[^\w\-]', '_', name.lower())
    
    db_folder = get_database_folder(user_id, name)
    target_path = db_folder / "db.sqlite"
    if target_path.exists():
        raise ValueError(f"Database '{name}' already exists")
    
    # Ensure folder structure exists
    db_folder.mkdir(parents=True, exist_ok=True)
    (db_folder / "assets").mkdir(exist_ok=True)
    
    # Copy the file
    shutil.copy2(file_path, target_path)
    
    # Verify it's a valid database
    try:
        db = await get_db(user_id, name)
        await db.execute("SELECT COUNT(*) FROM node")
        await db.close()
        logger.info(f"Imported database '{name}' for user {user_id}")
    except Exception as e:
        # Clean up on failure
        shutil.rmtree(db_folder)
        raise ValueError(f"Invalid database file: {e}")
    
    # Return info
    databases = await list_databases(user_id)
    return next((d for d in databases if d["name"] == name), {})

