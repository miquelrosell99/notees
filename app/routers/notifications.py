"""Notifications router.

Handles in-app notifications for mentions, shares, and comments.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..db.connection import acquire_connection, get_pool
from ..logging_config import get_logger
from ..models import NotificationResponse, User
from .auth import get_current_user

router = APIRouter(prefix="/notifications", tags=["Notifications"])
logger = get_logger(__name__)


@router.get("")
async def list_notifications(
    include_read: bool = False,
    limit: int = 20,
    user: User = Depends(get_current_user),
):
    """List notifications for the current user."""
    pool = await get_pool()
    user_id = int(user.id)

    async with acquire_connection(pool) as conn:
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

    notifications = []
    for r in rows:
        notifications.append(
            NotificationResponse(
                id=str(r["id"]),
                type=r["type"],
                actor_user_id=str(r["actor_user_id"]) if r["actor_user_id"] else None,
                actor_name=r["actor_name"],
                node_id=str(r["node_id"]) if r["node_id"] else None,
                node_name=r["node_name"],
                message=r["message"],
                is_read=r["is_read"],
                create_date=r["create_date"],
            )
        )

    return {"notifications": notifications, "unread_count": sum(1 for n in notifications if not n.is_read)}


@router.post("/{notification_id}/read")
async def mark_notification_read(
    notification_id: int,
    user: User = Depends(get_current_user),
):
    """Mark a notification as read."""
    pool = await get_pool()
    user_id = int(user.id)

    async with acquire_connection(pool) as conn:
        result = await conn.execute(
            "UPDATE notification SET is_read = TRUE WHERE id = $1 AND user_id = $2",
            notification_id,
            user_id,
        )
        if result.split()[-1] == "0":
            raise HTTPException(status_code=404, detail="Notification not found")

    return {"status": "ok"}


@router.post("/read-all")
async def mark_all_notifications_read(
    user: User = Depends(get_current_user),
):
    """Mark all notifications as read."""
    pool = await get_pool()
    user_id = int(user.id)

    async with acquire_connection(pool) as conn:
        await conn.execute(
            "UPDATE notification SET is_read = TRUE WHERE user_id = $1",
            user_id,
        )

    return {"status": "ok"}


async def create_notification(
    user_id: int,
    type: str,
    actor_user_id: int | None,
    node_id: int | None,
    message: str | None,
) -> None:
    """Create a notification (internal helper).

    Can be called from other routers/services.
    """
    pool = await get_pool()
    async with acquire_connection(pool) as conn:
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
