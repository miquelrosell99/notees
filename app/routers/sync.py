"""Sync and settings router.

Handles client-server synchronization and user settings.

Updated for workspace-based schema:
- Uses setting_user table (keyed by user_id) instead of settings (keyed by workspace_id)
- Settings are now per-user, not per-workspace

NOTE: Sync functionality is currently a stub and needs to be redesigned
for the shared workspace model.
"""

import json

from fastapi import APIRouter, Depends, HTTPException, Request

from ..dependencies import get_settings_repository
from ..domain.repositories import SettingsRepository
from ..models import SyncRequest, User
from ..utils import utc_now
from ..workspace_manager import get_active_workspace_id
from .auth import get_current_user

router = APIRouter(tags=["Sync & Settings"])


@router.post("/sync")
async def sync(request: SyncRequest, user: User = Depends(get_current_user)):
    """Minimal sync endpoint for offline recovery.

    Returns nodes modified since last_sync and applies client-side changes.
    This is a pragmatic v1 implementation — full CRDT sync is future work.
    """
    from ..db.connection import acquire_connection, get_pool
    from ..dependencies import _get_workspace_context_cached

    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)

    now = utc_now()

    async with acquire_connection(pool) as conn:
        # Fetch nodes modified since last_sync
        if request.last_sync:
            rows = await conn.fetch(
                """
                SELECT uuid, name, is_page, parent_id, sequence, active, is_deleted,
                       write_date, version
                FROM node
                WHERE workspace_id = $1 AND write_date > $2
                ORDER BY write_date DESC
                LIMIT 1000
                """,
                workspace_id,
                request.last_sync,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT uuid, name, is_page, parent_id, sequence, active, is_deleted,
                       write_date, version
                FROM node
                WHERE workspace_id = $1 AND active = TRUE AND is_deleted = FALSE
                ORDER BY write_date DESC
                LIMIT 1000
                """,
                workspace_id,
            )

        nodes = [
            {
                "uuid": str(row["uuid"]),
                "name": row["name"],
                "is_page": row["is_page"],
                "parent_id": row["parent_id"],
                "sequence": row["sequence"],
                "active": row["active"],
                "is_deleted": row["is_deleted"],
                "write_date": row["write_date"].isoformat() if row["write_date"] else None,
                "version": row["version"],
            }
            for row in rows
        ]

    return {
        "server_time": now.isoformat(),
        "nodes": nodes,
        "deleted_nodes": request.deleted_nodes,
        "conflicts": [],
    }


@router.get("/settings")
async def get_settings(
    user: User = Depends(get_current_user),
    repo: SettingsRepository = Depends(get_settings_repository),
):
    """Get all user settings."""
    return await repo.get_user_settings(int(user.id))


@router.put("/settings/{key}")
async def set_setting(
    key: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: SettingsRepository = Depends(get_settings_repository),
):
    """Set a user setting."""
    data = await request.json()
    value = data.get("value")
    json_value = json.dumps(value) if value is not None else "null"
    await repo.set_user_setting(int(user.id), key, json_value, utc_now())
    return {"status": "ok"}


@router.get("/workspace-settings")
async def get_workspace_settings(
    user: User = Depends(get_current_user),
    repo: SettingsRepository = Depends(get_settings_repository),
):
    """Get all settings for the user's active workspace."""
    active_uuid = get_active_workspace_id(str(int(user.id)))
    if not active_uuid:
        return {}
    workspace_id = await repo.get_workspace_id_by_uuid(active_uuid)
    if workspace_id is None:
        return {}
    return await repo.get_workspace_settings(workspace_id)


@router.put("/workspace-settings/{key}")
async def set_workspace_setting(
    key: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: SettingsRepository = Depends(get_settings_repository),
):
    """Set a workspace setting."""
    data = await request.json()
    value = data.get("value")
    user_id = int(user.id)
    active_uuid = get_active_workspace_id(str(user_id))
    if not active_uuid:
        raise HTTPException(status_code=404, detail="No active workspace")
    workspace_id = await repo.get_workspace_id_by_uuid(active_uuid)
    if workspace_id is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    json_value = json.dumps(value) if value is not None else "null"
    await repo.set_workspace_setting(workspace_id, key, json_value, utc_now(), user_id)
    return {"status": "ok"}
