"""DI helpers for the flashcards feature."""

from __future__ import annotations

from fastapi import Depends

from app.dependencies import get_current_user, get_node_repository, get_workspace_id
from app.features.nodes.port import NodeRepository
from app.models import User

from .repository import PostgresFlashcardRepository
from .service import FlashcardService


async def get_flashcard_service(
    workspace_id: int = Depends(get_workspace_id),
    user: User = Depends(get_current_user),
    node_repo: NodeRepository = Depends(get_node_repository),
) -> FlashcardService:
    repo = PostgresFlashcardRepository(workspace_id)
    return FlashcardService(repo, workspace_id, int(user.id), node_repo)
