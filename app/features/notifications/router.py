"""Notifications router.

Handles in-app notifications for mentions, shares, and comments.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.workspace_store import WorkspaceStore
from app.dependencies import (
    get_current_user,
    get_notification_service,
    require_read_or_write_scope,
    require_write_scope,
)
from app.domain.stringify_ast import ParseMode, StringifyMode, StringifyOptions, parse_ast, stringify_ast
from app.features.notifications.dependencies import get_workspace_store
from app.features.notifications.port import NotificationRepository
from app.features.notifications.service import NotificationService
from app.logging_config import get_logger
from app.models import NotificationResponse, User

router = APIRouter(
    prefix="/notifications",
    tags=["Notifications"],
    dependencies=[Depends(get_current_user), Depends(require_read_or_write_scope)],
)
logger = get_logger(__name__)


def _node_name_from_content(content: str | None) -> str | None:
    """Extract a plain-text node name from a JSON content AST."""
    if not content:
        return None
    try:
        ast = parse_ast(content, ParseMode.JSON)
        text = stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
        return text or None
    except Exception:
        return None


@router.get("")
async def list_notifications(
    include_read: bool = False,
    limit: int = 20,
    user: User = Depends(get_current_user),
    service: NotificationService = Depends(get_notification_service),
    store: WorkspaceStore = Depends(get_workspace_store),
):
    """List notifications for the current user, enriched from the operation log."""
    await store.sync()
    rows = await service._repo.list_notifications(int(user.id), include_read, limit)

    notifications = []
    for r in rows:
        node_uuid = str(r["node_uuid"]) if r["node_uuid"] else None
        node_name: str | None = None
        if node_uuid:
            node_rows = await store.query(
                "SELECT content FROM node WHERE id = ?", (node_uuid,)
            )
            if node_rows:
                node_name = _node_name_from_content(node_rows[0]["content"])

        notifications.append(
            NotificationResponse(
                id=str(r["id"]),
                notification_uuid=str(r["uuid"]) if r["uuid"] else "",
                type=r["type"],
                actor_user_id=str(r["actor_user_id"]) if r["actor_user_id"] else None,
                actor_name=r["actor_name"],
                node_uuid=node_uuid,
                node_name=node_name,
                message=r["message"],
                is_read=r["is_read"],
                create_date=r["create_date"],
            )
        )

    return {"notifications": notifications, "unread_count": sum(1 for n in notifications if not n.is_read)}


@router.post("/read-all", dependencies=[Depends(require_write_scope)])
async def mark_all_notifications_read(
    user: User = Depends(get_current_user),
    service: NotificationService = Depends(get_notification_service),
):
    """Mark all notifications as read."""
    await service._repo.mark_all_notifications_read(int(user.id))

    return {"status": "ok"}


@router.post("/{notification_uuid}/read", dependencies=[Depends(require_write_scope)])
async def mark_notification_read(
    notification_uuid: str,
    user: User = Depends(get_current_user),
    service: NotificationService = Depends(get_notification_service),
):
    """Mark a notification as read."""
    updated = await service._repo.mark_notification_read_by_uuid(notification_uuid, int(user.id))
    if not updated:
        raise HTTPException(status_code=404, detail="Notification not found")

    return {"status": "ok"}


async def create_notification(
    user_id: int,
    type: str,
    actor_user_id: int | None,
    node_uuid: str | None,
    message: str | None,
    repo: NotificationRepository,
) -> None:
    """Create a notification (internal helper).

    Can be called from other routers/services.

    .. deprecated::
        Use ``NotificationService.create_notification`` for new callers so that
        push delivery can be triggered.
    """
    await repo.create_notification(user_id, type, actor_user_id, node_uuid, message)
