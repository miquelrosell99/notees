"""Sync and settings router (refactored).

Handles client-server synchronization and user settings.
Uses domain types where applicable.
"""
from fastapi import APIRouter, HTTPException, Depends, Request
from datetime import datetime, timezone

from ..models import SyncRequest, SyncResponse, Node as NodeModel, User
from ..domain import Node
from .auth import get_current_user
from ..logging_config import logger

# Import legacy db - sync is complex and will be migrated incrementally
from .. import database as db

router = APIRouter(prefix="/api", tags=["Sync & Settings"])


def _get_utc_now() -> datetime:
    """Get current UTC time (timezone-aware)."""
    return datetime.now(timezone.utc)


@router.post("/sync")
async def sync(request: SyncRequest, user: User = Depends(get_current_user)):
    """Sync data between client and server.
    
    This endpoint handles bidirectional sync:
    1. Receives client changes (nodes to upsert, nodes to delete)
    2. Returns server changes since client's last sync
    """
    try:
        logger.info(f"Sync request from user {user.id}: {len(request.nodes)} nodes, {len(request.deleted_nodes)} deletions")
        
        # Helper to check if parent exists
        async def parent_exists(parent_id):
            if not parent_id:
                return True
            try:
                node = await db.get_node(user.id, parent_id)
                return node is not None
            except Exception:
                return False
        
        # Sort nodes to ensure parents are created before children
        # This prevents FOREIGN KEY constraint errors
        def get_parent_id(n):
            if hasattr(n, 'parent_id'):
                return n.parent_id
            return n.get('parent_id') if isinstance(n, dict) else None
        
        def get_created_at(n):
            if hasattr(n, 'created_at'):
                return n.created_at or ""
            return n.get('created_at', "") if isinstance(n, dict) else ""
        
        sorted_nodes = sorted(request.nodes, key=lambda n: (
            # Pages without parents first (they might be parent pages)
            0 if not get_parent_id(n) else 1,
            # Then by creation time if available
            get_created_at(n)
        ))
        
        # Process incoming changes from client with retry for missing parents
        deferred_nodes = []
        max_retries = 3
        
        for node_data in sorted_nodes:
            try:
                await db.upsert_node(user.id, node_data)
            except Exception as e:
                if "FOREIGN KEY constraint failed" in str(e):
                    logger.warning(f"Deferring node due to missing parent: {node_data.get('id', 'unknown')}")
                    deferred_nodes.append(node_data)
                else:
                    raise
        
        # Retry deferred nodes (parents might have been created)
        retry_count = 0
        while deferred_nodes and retry_count < max_retries:
            retry_count += 1
            still_deferred = []
            
            for node_data in deferred_nodes:
                parent_id = get_parent_id(node_data)
                
                # Check if parent now exists, or set to None if it doesn't
                if parent_id and not await parent_exists(parent_id):
                    logger.warning(f"Parent {parent_id} still missing for node {node_data.get('id')}, setting parent_id to None")
                    # Set parent_id to None to break the constraint
                    if hasattr(node_data, 'parent_id'):
                        node_data.parent_id = None
                    elif isinstance(node_data, dict):
                        node_data['parent_id'] = None
                
                try:
                    await db.upsert_node(user.id, node_data)
                except Exception as e:
                    if "FOREIGN KEY constraint failed" in str(e) and retry_count < max_retries:
                        still_deferred.append(node_data)
                    else:
                        logger.error(f"Failed to sync node after retries: {node_data.get('id')}: {e}")
            
            deferred_nodes = still_deferred
        
        if deferred_nodes:
            logger.warning(f"Could not sync {len(deferred_nodes)} nodes after {max_retries} retries")
        
        # Process deletions
        for node_id in request.deleted_nodes:
            await db.delete_node(user.id, node_id)
        
        # Get changes since last sync
        nodes, deleted_nodes = await db.get_changes_since(user.id, request.last_sync)
        
        # Ensure proper typing for response model
        node_models = [NodeModel(**n) if not isinstance(n, NodeModel) else n for n in nodes]
        
        logger.info(f"Sync response: {len(node_models)} nodes, {len(deleted_nodes)} deletions")
        
        return SyncResponse(
            server_time=_get_utc_now(),
            nodes=node_models,
            deleted_nodes=deleted_nodes
        )
    except Exception as e:
        logger.error(f"Sync error for user {user.id}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Sync failed: {str(e)}")


@router.get("/settings")
async def get_settings(user: User = Depends(get_current_user)):
    """Get all user settings."""
    from ..db.connection import get_db
    
    user_db = await get_db(user.id)
    try:
        cursor = await user_db.execute("SELECT key, value FROM settings")
        rows = await cursor.fetchall()
        settings = {row["key"]: row["value"] for row in rows}
        return settings
    finally:
        await user_db.close()


@router.put("/settings/{key}")
async def set_setting(key: str, request: Request, user: User = Depends(get_current_user)):
    """Set a user setting."""
    data = await request.json()
    value = data.get("value")
    
    if key == "date_format":
        await db.set_date_format_and_update_titles(user.id, value)
    else:
        await db.set_user_setting(user.id, key, value)
    
    return {"status": "ok"}
