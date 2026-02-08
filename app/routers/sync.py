"""Sync and settings router.

Handles client-server synchronization and user settings.

Updated for graph-based schema:
- Uses setting_user table (keyed by user_id) instead of settings (keyed by workspace_id)
- Settings are now per-user, not per-graph

NOTE: Sync functionality is currently a stub and needs to be redesigned
for the shared graph model.
"""
from fastapi import APIRouter, HTTPException, Depends, Request

from ..models import SyncRequest, SyncResponse, Node as NodeModel, User
from ..domain import Node
from .auth import get_current_user
from ..db.connection import acquire_connection, get_pool
from ..logging_config import logger
from ..utils import utc_now


router = APIRouter(prefix="/api", tags=["Sync & Settings"])


@router.post("/sync")
async def sync(request: SyncRequest, user: User = Depends(get_current_user)):
    """Sync endpoint - Coming soon.
    
    For now, use the export/import endpoints for data transfer.
    """
    raise HTTPException(
        status_code=501,
        detail={
            "message": "Sync is planned for v2.1",
            "alternative": "Use /api/export and /api/import for data transfer",
            "docs": "/docs#/export"
        }
    )


@router.get("/settings")
async def get_settings(user: User = Depends(get_current_user)):
    """Get all user settings."""
    pool = await get_pool()
    user_id = int(user.id)
    
    async with acquire_connection(pool) as conn:
        rows = await conn.fetch(
            "SELECT key, value FROM setting_user WHERE user_id = $1",
            user_id
        )
        settings = {row["key"]: row["value"] for row in rows}
        return settings


@router.put("/settings/{key}")
async def set_setting(key: str, request: Request, user: User = Depends(get_current_user)):
    """Set a user setting."""
    import json
    data = await request.json()
    value = data.get("value")
    
    pool = await get_pool()
    user_id = int(user.id)
    
    # Value is already a JSON-compatible Python value (string, number, list, dict, etc.)
    # Serialize to JSON string for JSONB insertion
    json_value = json.dumps(value) if value is not None else 'null'
    now = utc_now()
    
    async with acquire_connection(pool) as conn:
        # Upsert the setting - the ::jsonb cast will parse the JSON string
        await conn.execute("""
            INSERT INTO setting_user (user_id, key, value, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, $3::jsonb, $4, $4, $1, $1)
            ON CONFLICT (user_id, key) 
            DO UPDATE SET value = $3::jsonb, write_date = $4, write_uid = $1
        """, user_id, key, json_value, now)
    
    return {"status": "ok"}
