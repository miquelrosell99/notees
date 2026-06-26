"""Sync and settings router.

Handles client-server synchronization and user settings.

Updated for workspace-based schema:
- Uses setting_user table (keyed by user_id) instead of settings (keyed by workspace_id)
- Settings are now per-user, not per-workspace

Sync redesign (v2):
- Client sends last_sync timestamp + list of nodes it has modified locally
- Server returns server-side changes + explicit conflicts
- Conflict detection based on version numbers (optimistic locking)
- Permission-filtered: only nodes the user can read/write
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import (
    get_current_user,
    get_settings_repository,
    get_sync_service,
    get_sync_service_v2,
)
from app.domain.entities.sync_v2 import (
    SyncBatchRequest,
    SyncBatchResponse,
    SyncConflictResponse,
)
from app.domain.repositories.interfaces import SettingsRepository
from app.features.sync.service import SyncService
from app.features.sync.service_v2 import SyncServiceV2
from app.features.workspaces.manager import get_active_workspace_id
from app.logging_config import get_logger
from app.models import (
    SyncRequest,
    SyncResponse,
    User,
)
from app.utils import utc_now


class SettingValueRequest(BaseModel):
    """Request body for setting a user or workspace setting value."""

    value: Any


router = APIRouter(tags=["Sync & Settings"])
logger = get_logger(__name__)


@router.post("/sync", response_model=SyncResponse)
async def sync(
    request: SyncRequest,
    user: User = Depends(get_current_user),
    sync_service: SyncService = Depends(get_sync_service),
):
    """Synchronize client state with server.

    Client sends:
    - last_sync: timestamp of last successful sync (or None for initial)
    - client_nodes: list of nodes modified locally since last_sync
    - workspace_uuid: optional workspace to sync (defaults to active)

    Server returns:
    - server_nodes: nodes the server has that are newer than client's last_sync
    - deleted_node_uuids: nodes deleted on server since last_sync
    - conflicts: nodes modified by both client and server since last_sync
    """
    return await sync_service.sync(request)


@router.post(
    "/sync/batch",
    response_model=SyncBatchResponse,
    responses={409: {"model": SyncConflictResponse}},
)
async def sync_batch(
    request: SyncBatchRequest,
    user: User = Depends(get_current_user),
    sync_service_v2: SyncServiceV2 = Depends(get_sync_service_v2),
):
    """Apply a batch of client operations using optimistic vector-clock sync.

    Client sends:
    - ops: list of OperationIntent operations to apply
    - base_vector: last server-confirmed version vectors per affected node
    - workspace_uuid: optional target workspace (defaults to active)

    Server returns either:
    - 200 SyncBatchResponse with updated version vectors, or
    - 409 SyncConflictResponse with stale nodes and current server vectors.
    """
    import sys

    base_vector_bytes = sys.getsizeof(str(request.base_vector))
    logger.info("sync/batch base_vector payload size: %s bytes", base_vector_bytes)

    result = await sync_service_v2.apply_batch(request)
    if isinstance(result, SyncConflictResponse):
        raise HTTPException(status_code=409, detail=result.model_dump())
    return result


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
    body: SettingValueRequest,
    user: User = Depends(get_current_user),
    repo: SettingsRepository = Depends(get_settings_repository),
):
    """Set a user setting."""
    await repo.set_user_setting(int(user.id), key, body.value, utc_now())
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
    body: SettingValueRequest,
    user: User = Depends(get_current_user),
    repo: SettingsRepository = Depends(get_settings_repository),
):
    """Set a workspace setting."""
    user_id = int(user.id)
    active_uuid = get_active_workspace_id(str(user_id))
    if not active_uuid:
        raise HTTPException(status_code=404, detail="No active workspace")
    workspace_id = await repo.get_workspace_id_by_uuid(active_uuid)
    if workspace_id is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    await repo.set_workspace_setting(workspace_id, key, body.value, utc_now(), user_id)
    return {"status": "ok"}
