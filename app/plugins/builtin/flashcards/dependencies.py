"""DI helpers for the flashcards feature."""

from __future__ import annotations

from fastapi import Depends

from app.dependencies import get_current_user, get_workspace_id
from app.models import User

from .repository import PostgresFlashcardRepository
from .service import FlashcardService


async def get_flashcard_service(
    workspace_id: int = Depends(get_workspace_id),
    user: User = Depends(get_current_user),
) -> FlashcardService:
    repo = PostgresFlashcardRepository(workspace_id)
    return FlashcardService(repo, workspace_id, int(user.id))
