"""DI helpers for the EPUB plugin router."""

from __future__ import annotations

from collections.abc import AsyncGenerator

from fastapi import Depends, HTTPException

from app.core.workspace_store import WorkspaceStore
from app.db.connection import get_pool, get_workspace_uuid
from app.dependencies import _get_workspace_context_cached, get_current_user
from app.features.assets.dependencies import get_workspace_store
from app.features.assets.metadata.service import AssetMetadataService
from app.features.assets.service import AssetService
from app.models import User


async def get_asset_metadata_service(
    user: User = Depends(get_current_user),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> AsyncGenerator[AssetMetadataService, None]:
    """Build an AssetMetadataService wired to the current user's workspace."""
    pool = await get_pool()
    workspace_id, _ = await _get_workspace_context_cached(pool, int(user.id))
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if workspace_uuid is None:
        raise HTTPException(status_code=500, detail="Workspace UUID not found")
    yield AssetMetadataService(
        store=store,
        asset_service=AssetService(
            workspace_uuid=workspace_uuid,
            user_id=str(user.uuid),
            store=store,
        ),
    )
