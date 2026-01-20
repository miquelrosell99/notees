"""Sync operations for data synchronization."""
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
import sqlite3
import json

from ..logging_config import logger
from .connection import get_db
from .utils import generate_uuid


def parse_node(row: sqlite3.Row) -> Dict[str, Any]:
    """Parse a database row into a node dictionary."""
    if row is None:
        return None
    return dict(row)


async def get_changes_since(user_id: str, last_sync: Optional[datetime]) -> Tuple[List[Dict], List[str]]:
    """Get all changes since last sync."""
    db = await get_db(user_id)
    try:
        if last_sync:
            sync_time = last_sync.isoformat()
            
            # Get updated nodes
            cursor = await db.execute(
                "SELECT * FROM nodes WHERE updated_at > ? AND deleted = 0",
                (sync_time,)
            )
            nodes = [parse_node(row) for row in await cursor.fetchall()]
            
            # Get deleted nodes
            cursor = await db.execute(
                "SELECT id FROM nodes WHERE updated_at > ? AND deleted = 1",
                (sync_time,)
            )
            deleted_nodes = [row["id"] for row in await cursor.fetchall()]
        else:
            # Full sync
            cursor = await db.execute("SELECT * FROM nodes WHERE deleted = 0")
            nodes = [parse_node(row) for row in await cursor.fetchall()]
            deleted_nodes = []
        
        return nodes, deleted_nodes
    finally:
        await db.close()


async def apply_remote_changes(user_id: str, nodes: List[Dict], deleted_node_ids: List[str]) -> Dict[str, int]:
    """Apply changes from remote source."""
    db = await get_db(user_id)
    try:
        stats = {"updated": 0, "created": 0, "deleted": 0}
        
        # Apply node updates/creates
        for node_data in nodes:
            # Check if node exists
            cursor = await db.execute("SELECT id FROM nodes WHERE id = ?", (node_data["id"],))
            existing = await cursor.fetchone()
            
            if existing:
                # Update existing
                await db.execute("""
                    UPDATE nodes SET 
                        content = ?, parent_id = ?, 
                        tags = ?, properties = ?, title = ?,
                        is_daily = ?, daily_date = ?, page_id = ?,
                        updated_at = ?, version = ?, write_uid = ?
                    WHERE id = ?
                """, (
                    node_data.get("content"),
                    node_data.get("parent_id"),
                    json.dumps(node_data.get("tags", [])),
                    json.dumps(node_data.get("properties", {})),
                    node_data.get("title"),
                    1 if node_data.get("is_daily") else 0,
                    node_data.get("daily_date"),
                    node_data.get("page_id"),
                    node_data.get("updated_at"),
                    node_data.get("version", 1),
                    node_data.get("write_uid"),
                    node_data["id"]
                ))
                stats["updated"] += 1
            else:
                # Create new — ensure uuid is present to satisfy schema
                node_uuid = node_data.get("uuid") or generate_uuid()
                await db.execute("""
                    INSERT INTO nodes (
                        id, uuid, content, parent_id, tags, properties,
                        title, is_daily, daily_date, page_id,
                        created_at, updated_at, version, create_uid, write_uid
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    node_data["id"],
                    node_uuid,
                    node_data.get("content"),
                    node_data.get("parent_id"),
                    json.dumps(node_data.get("tags", [])),
                    json.dumps(node_data.get("properties", {})),
                    node_data.get("title"),
                    1 if node_data.get("is_daily") else 0,
                    node_data.get("daily_date"),
                    node_data.get("page_id"),
                    node_data.get("created_at", datetime.now().isoformat()),
                    node_data.get("updated_at", datetime.now().isoformat()),
                    node_data.get("version", 1),
                    node_data.get("create_uid"),
                    node_data.get("write_uid")
                ))
                stats["created"] += 1
        
        # Apply deletions
        for node_id in deleted_node_ids:
            await db.execute(
                "UPDATE nodes SET deleted = 1, updated_at = ? WHERE id = ?",
                (datetime.now().isoformat(), node_id)
            )
            stats["deleted"] += 1
        
        await db.commit()
        return stats
    except sqlite3.OperationalError as e:
        logger.error(f"Failed to apply remote changes: {e}")
        raise
    finally:
        await db.close()


async def get_sync_status(user_id: str) -> Dict[str, Any]:
    """Get sync status information."""
    db = await get_db(user_id)
    try:
        # Get last sync time from settings
        cursor = await db.execute("SELECT value FROM settings WHERE key = 'last_sync'")
        row = await cursor.fetchone()
        last_sync = None
        if row:
            try:
                last_sync = datetime.fromisoformat(json.loads(row["value"]))
            except:
                pass
        
        # Count pending changes
        cursor = await db.execute(
            "SELECT COUNT(*) as count FROM nodes WHERE updated_at > ? OR deleted = 1",
            (last_sync.isoformat() if last_sync else "1970-01-01",)
        )
        row = await cursor.fetchone()
        pending_changes = row["count"] if row else 0
        
        return {
            "last_sync": last_sync.isoformat() if last_sync else None,
            "pending_changes": pending_changes,
            "is_syncing": False  # Would be managed by sync service
        }
    finally:
        await db.close()


async def set_last_sync_time(user_id: str, sync_time: Optional[datetime] = None) -> None:
    """Set the last sync time."""
    if sync_time is None:
        sync_time = datetime.now()
    
    db = await get_db(user_id)
    try:
        await db.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('last_sync', ?)",
            (json.dumps(sync_time.isoformat()),)
        )
        await db.commit()
    finally:
        await db.close()
