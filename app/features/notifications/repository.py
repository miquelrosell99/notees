"""PostgreSQL implementation of NotificationRepository."""

from __future__ import annotations

from typing import Any

import asyncpg

from app.db.connection import acquire_connection
from app.features.notifications.port import NotificationRepository, PushDeviceRepository


class PostgresNotificationRepository(NotificationRepository):
    """Handles in-app notification persistence."""

    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def list_notifications(self, user_id: int, include_read: bool, limit: int) -> list[Any]:
        """List notifications for a user with actor and node names."""
        async with acquire_connection(self._pool) as conn:
            if include_read:
                rows = await conn.fetch(
                    """
                    SELECT n.id, n.type, n.actor_user_id, u.name as actor_name,
                           n.node_id, nd.name as node_name, n.message, n.is_read, n.create_date
                    FROM notification n
                    LEFT JOIN "user" u ON u.id = n.actor_user_id
                    LEFT JOIN node nd ON nd.id = n.node_id
                    WHERE n.user_id = $1
                    ORDER BY n.create_date DESC
                    LIMIT $2
                    """,
                    user_id,
                    limit,
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT n.id, n.type, n.actor_user_id, u.name as actor_name,
                           n.node_id, nd.name as node_name, n.message, n.is_read, n.create_date
                    FROM notification n
                    LEFT JOIN "user" u ON u.id = n.actor_user_id
                    LEFT JOIN node nd ON nd.id = n.node_id
                    WHERE n.user_id = $1 AND n.is_read = FALSE
                    ORDER BY n.create_date DESC
                    LIMIT $2
                    """,
                    user_id,
                    limit,
                )
        return rows

    async def mark_notification_read(self, notification_id: int, user_id: int) -> bool:
        """Mark a notification as read if it belongs to the user."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "UPDATE notification SET is_read = TRUE WHERE id = $1 AND user_id = $2",
                notification_id,
                user_id,
            )
            return result.split()[-1] != "0"

    async def mark_all_notifications_read(self, user_id: int) -> None:
        """Mark all notifications for a user as read."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "UPDATE notification SET is_read = TRUE WHERE user_id = $1",
                user_id,
            )

    async def create_notification(
        self, user_id: int, type: str, actor_user_id: int | None, node_id: int | None, message: str | None
    ) -> None:
        """Create a notification row."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                INSERT INTO notification (user_id, type, actor_user_id, node_id, message)
                VALUES ($1, $2, $3, $4, $5)
                """,
                user_id,
                type,
                actor_user_id,
                node_id,
                message,
            )

    async def create_many(self, notifications: list[dict[str, Any]]) -> None:
        """Create multiple notification rows in one batch."""
        if not notifications:
            return
        values = [
            (
                n["user_id"],
                n["type"],
                n.get("actor_user_id"),
                n.get("node_id"),
                n.get("message"),
            )
            for n in notifications
        ]
        async with acquire_connection(self._pool) as conn:
            await conn.executemany(
                """
                INSERT INTO notification (user_id, type, actor_user_id, node_id, message)
                VALUES ($1, $2, $3, $4, $5)
                """,
                values,
            )


class PostgresPushDeviceRepository(PushDeviceRepository):
    """PostgreSQL persistence for push notification device tokens."""

    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def register_token(self, user_id: int, token: str, platform: str) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                INSERT INTO user_device_token (user_id, token, platform, active, create_date, write_date)
                VALUES ($1, $2, $3, TRUE, NOW(), NOW())
                ON CONFLICT (user_id, token) DO UPDATE
                SET active = TRUE, platform = EXCLUDED.platform, write_date = NOW()
                """,
                user_id,
                token,
                platform,
            )

    async def list_tokens_for_user(self, user_id: int) -> list[str]:
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT token FROM user_device_token WHERE user_id = $1 AND active = TRUE",
                user_id,
            )
        return [r["token"] for r in rows]

    async def deactivate_token(self, token: str) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "UPDATE user_device_token SET active = FALSE WHERE token = $1",
                token,
            )
