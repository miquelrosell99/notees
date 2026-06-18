"""FastAPI dependencies for the notifications feature."""

from __future__ import annotations

from collections.abc import AsyncGenerator

import asyncpg

from app.db.connection import get_pool
from app.features.notifications.port import NotificationRepository
from app.features.notifications.repository import PostgresNotificationRepository


def _make_notification_repository(pool: asyncpg.Pool) -> NotificationRepository:
    return PostgresNotificationRepository(pool)


async def get_notification_repository() -> AsyncGenerator[NotificationRepository, None]:
    """Get a NotificationRepository (not workspace-scoped)."""
    pool = await get_pool()
    yield _make_notification_repository(pool)
