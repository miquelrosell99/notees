"""FastAPI dependencies for the undo feature."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import asyncpg
from fastapi import Depends

from app.db.connection import get_pool
from app.dependencies import _get_workspace_context_cached, get_current_user
from app.features.undo.port import UndoRepository
from app.features.undo.repository import PostgresUndoRepository
from app.features.undo.service import UndoService
from app.models import User


async def get_undo_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[UndoRepository, None]:
    """Get an UndoRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield _make_undo_repository(pool, workspace_id, user_id)


def _make_undo_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> UndoRepository:
    return PostgresUndoRepository(pool, workspace_id, user_id)


async def _get_undo_service(user: User) -> UndoService:
    """Return an UndoService wired to the user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    undo_repo = _make_undo_repository(pool, workspace_id, user_id)
    return UndoService(undo_repo)
