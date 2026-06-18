"""FastAPI dependencies for the activity feature."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import asyncpg
from fastapi import Depends

from app.db.connection import get_pool
from app.dependencies import _get_workspace_context_cached, get_current_user
from app.features.activity.port import ActivityRepository
from app.features.activity.repository import PostgresActivityRepository
from app.models import User


async def get_activity_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[ActivityRepository, None]:
    """Get an ActivityRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield _make_activity_repository(pool, workspace_id, user_id)


def _make_activity_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> ActivityRepository:
    return PostgresActivityRepository(pool, workspace_id, user_id)
