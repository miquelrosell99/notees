"""FastAPI dependencies for the tasks feature."""

from __future__ import annotations

from collections.abc import AsyncGenerator

from fastapi import Depends, HTTPException

from app.core.workspace_store import WorkspaceStore
from app.db.connection import get_pool, get_workspace_uuid
from app.dependencies import _get_workspace_context_cached, get_current_user
from app.models import User
from app.relay.dependencies import get_relay_storage


async def get_workspace_store(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[WorkspaceStore, None]:
    """Get a WorkspaceStore for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if workspace_uuid is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    store = WorkspaceStore(
        workspace_id=workspace_uuid,
        actor_id=user.uuid,
        relay_storage=get_relay_storage(),
    )
    try:
        yield store
    finally:
        await store.close()
