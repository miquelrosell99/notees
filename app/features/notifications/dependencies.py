"""FastAPI dependencies for the notifications feature."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import asyncpg
from fastapi import Depends, HTTPException

from app.core.workspace_store import WorkspaceStore
from app.db.connection import get_pool, get_workspace_uuid
from app.dependencies import _get_workspace_context_cached, get_current_user
from app.features.notifications.port import NotificationRepository
from app.features.notifications.repository import PostgresNotificationRepository
from app.models import User
from app.relay.dependencies import get_relay_storage


def _make_notification_repository(pool: asyncpg.Pool) -> NotificationRepository:
    return PostgresNotificationRepository(pool)


async def get_notification_repository() -> AsyncGenerator[NotificationRepository, None]:
    """Get a NotificationRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield _make_notification_repository(pool)


async def get_workspace_store(
    user: User = Depends(get_current_user),
) -> AsyncGenerator[WorkspaceStore, None]:
    """Get a WorkspaceStore for the current user's active workspace."""
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
