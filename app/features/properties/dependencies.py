"""FastAPI dependencies for the properties feature."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import asyncpg
from fastapi import Depends

from app.db.connection import get_pool
from app.dependencies import (
    _get_node_service_for_workspace,
    _get_workspace_context_cached,
    get_current_user,
)
from app.features.activity.repository import PostgresActivityRepository
from app.features.properties.port import PropertyRepository
from app.features.properties.repository import PostgresPropertyRepository
from app.features.properties.service import PropertyService
from app.features.tasks.repository import PostgresTaskRecurrenceRepository
from app.features.tasks.repository_completion import PostgresTaskCompletionRepository
from app.features.tasks.service import TaskAutomationService
from app.models import User


def _make_property_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> PropertyRepository:
    return PostgresPropertyRepository(pool, workspace_id, user_id)


async def get_property_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[PropertyRepository, None]:
    """Get a PropertyRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield _make_property_repository(pool, workspace_id, user_id)


async def _get_property_service(user: User) -> PropertyService:
    """Return a PropertyService wired to the user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    node_service = await _get_node_service_for_workspace(user, workspace_id, 0)
    property_repo = _make_property_repository(pool, workspace_id, user_id)
    recurrence_repo = PostgresTaskRecurrenceRepository(pool, workspace_id, user_id)
    completion_repo = PostgresTaskCompletionRepository(pool, workspace_id, user_id)
    task_service = TaskAutomationService(
        node_service,
        property_repo,
        recurrence_repo,
        completion_repo,
        user_id=user_id,
    )
    activity_repo = PostgresActivityRepository(pool, workspace_id, user_id)
    return PropertyService(
        workspace_id,
        property_repo,
        node_service,
        task_service=task_service,
        activity_repo=activity_repo,
        user_id=user_id,
    )


async def get_property_service(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[PropertyService, None]:
    """FastAPI dependency yielding a PropertyService."""
    yield await _get_property_service(user)


async def _make_public_property_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
) -> PropertyRepository:
    """Build a PropertyRepository for anonymous public access."""
    return PostgresPropertyRepository(pool, workspace_id, 0)


async def get_public_property_repository(
    workspace_id: int,
) -> PropertyRepository:
    """Get a PropertyRepository scoped to a workspace for public access."""
    pool = await get_pool()
    return _make_public_property_repository(pool, workspace_id)
