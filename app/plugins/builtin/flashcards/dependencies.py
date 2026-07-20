"""DI helpers for the flashcards feature."""

from __future__ import annotations

from fastapi import Depends, HTTPException

from app.core.workspace_store import WorkspaceStore
from app.db.connection import get_workspace_uuid
from app.dependencies import get_current_user, get_workspace_id
from app.models import User
from app.relay.dependencies import get_relay_storage

from .repository import WorkspaceStoreFlashcardRepository
from .service import FlashcardService


async def get_workspace_store(
    workspace_id: int = Depends(get_workspace_id),
    user: User = Depends(get_current_user),
) -> WorkspaceStore:
    """Return a server-side WorkspaceStore for the current user/workspace."""
    workspace_uuid = await get_workspace_uuid(workspace_id)
    if workspace_uuid is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return WorkspaceStore(
        workspace_id=workspace_uuid,
        actor_id=user.uuid,
        relay_storage=get_relay_storage(),
    )


async def get_flashcard_service(
    workspace_id: int = Depends(get_workspace_id),
    user: User = Depends(get_current_user),
    store: WorkspaceStore = Depends(get_workspace_store),
) -> FlashcardService:
    repo = WorkspaceStoreFlashcardRepository(store, workspace_id, int(user.id))
    return FlashcardService(repo, workspace_id, int(user.id), store)
