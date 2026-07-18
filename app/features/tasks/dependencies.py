"""FastAPI dependencies for the tasks feature."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import asyncpg
from fastapi import Depends, HTTPException, Path

from app.core.workspace_store import WorkspaceStore
from app.db.connection import get_pool, get_workspace_uuid
from app.dependencies import _get_workspace_context_cached, get_current_user
from app.features.tasks.port import TaskCompletionRepository, TaskRecurrenceRepository
from app.features.tasks.repository import PostgresTaskRecurrenceRepository
from app.features.tasks.repository_completion import PostgresTaskCompletionRepository
from app.models import User


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
    )
    try:
        yield store
    finally:
        await store.close()


def _make_task_recurrence_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> TaskRecurrenceRepository:
    return PostgresTaskRecurrenceRepository(pool, workspace_id, user_id)


def _make_task_completion_repository(
    pool: asyncpg.Pool,
    workspace_id: int,
    user_id: int,
) -> TaskCompletionRepository:
    return PostgresTaskCompletionRepository(pool, workspace_id, user_id)


async def get_task_recurrence_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[TaskRecurrenceRepository, None]:
    """Get a TaskRecurrenceRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield _make_task_recurrence_repository(pool, workspace_id, user_id)


async def get_task_completion_repository(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[TaskCompletionRepository, None]:
    """Get a TaskCompletionRepository for the current user's workspace."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    yield _make_task_completion_repository(pool, workspace_id, user_id)


async def resolve_task_completion_uuid(
    completion_uuid: str = Path(..., description="Public task completion UUID"),
    repo: TaskCompletionRepository = Depends(get_task_completion_repository),
) -> int:
    """Resolve a task completion UUID to its internal numeric ID."""
    completion = await repo.get_by_uuid(completion_uuid)
    if completion is None or completion.id is None:
        raise HTTPException(status_code=404, detail="Task completion not found")
    return completion.id
