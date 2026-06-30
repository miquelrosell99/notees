"""FastAPI dependencies for the Yjs CRDT feature."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import asyncpg
from fastapi import Depends

from app.db.connection import get_pool
from app.dependencies import (
    _get_workspace_context_cached,
    get_current_user,
    get_permission_checker,
    get_workspace_id,
)
from app.domain.permissions import PermissionChecker
from app.models import User

from .yjs_repository import PostgresYjsRepository
from .yjs_service import YjsService


def _make_yjs_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> PostgresYjsRepository:
    return PostgresYjsRepository(pool, workspace_id, user_id)


async def get_yjs_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[PostgresYjsRepository, None]:
    """Get a PostgresYjsRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield _make_yjs_repository(pool, workspace_id, user_id)


async def get_yjs_service(
    user: User = Depends(get_current_user),
    workspace_id: int = Depends(get_workspace_id),
    permission_checker: PermissionChecker = Depends(get_permission_checker),
) -> AsyncGenerator[YjsService, None]:
    """Get a YjsService wired to the current user and workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    repository = _make_yjs_repository(pool, workspace_id, user_id)
    yield YjsService(repository, permission_checker)
