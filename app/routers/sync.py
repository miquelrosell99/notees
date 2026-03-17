"""Sync and settings router.

Handles client-server synchronization and user settings.

Updated for workspace-based schema:
- Uses setting_user table (keyed by user_id) instead of settings (keyed by workspace_id)
- Settings are now per-user, not per-workspace

NOTE: Sync functionality is currently a stub and needs to be redesigned
for the shared workspace model.
"""
import json

from fastapi import APIRouter, HTTPException, Depends, Request

from ..models import SyncRequest, SyncResponse, Node as NodeModel, User
from ..domain import Node
from .auth import get_current_user
from ..dependencies import get_settings_repository
from ..domain.repositories import SettingsRepository
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
    json_value = json.dumps(value) if value is not None else 'null'
    await repo.set_user_setting(int(user.id), key, json_value, utc_now())
    return {"status": "ok"}

@router.get("/workspace-settings")
async def get_workspace_settings(
    user: User = Depends(get_current_user),
    repo: SettingsRepository = Depends(get_settings_repository),
):
    """Get all settings for the user's active workspace."""
    from ..database import get_active_workspace_id
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
    from ..database import get_active_workspace_id
    data = await request.json()
    value = data.get("value")
    user_id = int(user.id)
    active_uuid = get_active_workspace_id(str(user_id))
    if not active_uuid:
        raise HTTPException(status_code=404, detail="No active workspace")
    workspace_id = await repo.get_workspace_id_by_uuid(active_uuid)
    if workspace_id is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    json_value = json.dumps(value) if value is not None else 'null'
    await repo.set_workspace_setting(workspace_id, key, json_value, utc_now(), user_id)
    return {"status": "ok"}