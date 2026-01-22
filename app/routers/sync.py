"""Sync and settings router.

Handles client-server synchronization and user settings.

NOTE: Sync functionality is currently a stub and needs to be redesigned
for the shared workspace model.
"""
from fastapi import APIRouter, HTTPException, Depends, Request
from datetime import datetime, timezone

from ..models import SyncRequest, SyncResponse, Node as NodeModel, User
from ..domain import Node
from .auth import get_current_user
from ..db.connection import get_pool
from ..db.schema import get_or_create_user_workspace
from ..logging_config import logger


router = APIRouter(prefix="/api", tags=["Sync & Settings"])


def _get_utc_now() -> datetime:
    """Get current UTC time (timezone-aware)."""
    return datetime.now(timezone.utc)


@router.post("/sync")
async def sync(request: SyncRequest, user: User = Depends(get_current_user)):
    """Sync data between client and server.
    
    NOTE: This endpoint is currently a stub. Sync functionality needs to be
    redesigned for PostgreSQL workspaces.
    """
    raise HTTPException(
        status_code=501,
        detail="Sync is not yet implemented for PostgreSQL. Use direct API calls instead."
    )


@router.get("/settings")
async def get_settings(user: User = Depends(get_current_user)):
    """Get all user settings."""
    pool = await get_pool()
    workspace_id = await get_or_create_user_workspace(pool, int(user.id))
    
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT key, value FROM settings WHERE workspace_id = $1",
            workspace_id
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
    workspace_id = await get_or_create_user_workspace(pool, int(user.id))
    
    # Convert value to JSON string for JSONB column
    json_value = json.dumps(value) if value is not None else None
    
    async with pool.acquire() as conn:
        # Upsert the setting
        await conn.execute("""
            INSERT INTO settings (workspace_id, key, value)
            VALUES ($1, $2, $3::jsonb)
            ON CONFLICT (workspace_id, key) 
            DO UPDATE SET value = EXCLUDED.value
        """, workspace_id, key, json_value)
    
    return {"status": "ok"}
