"""Notification service orchestrates in-app notifications and push delivery.

The service is intentionally thin: it persists the notification, looks up the
recipient's registered device tokens, and forwards a push payload to the
configured ``PushNotificationSender`` port when available.
"""

from __future__ import annotations

import contextlib
from typing import Any

from app.domain.ports import PushNotification, PushNotificationSender
from app.features.notifications.port import NotificationRepository, PushDeviceRepository


class NotificationService:
    """Service for creating notifications and optionally sending pushes."""

    def __init__(
        self,
        repo: NotificationRepository,
        push_device_repo: PushDeviceRepository,
        push_sender: PushNotificationSender | None,
    ):
        self._repo = repo
        self._push_device_repo = push_device_repo
        self._push_sender = push_sender

    async def create_notification(
        self,
        user_id: int,
        type: str,
        actor_user_id: int | None,
        node_id: int | None,
        message: str | None,
        push_title: str | None = None,
        push_body: str | None = None,
        push_data: dict[str, Any] | None = None,
    ) -> None:
        """Persist a notification and send a push when configured.

        Push delivery is best-effort: failures are swallowed so that a
        misconfigured FCM server key never breaks the in-app notification flow.
        """
        await self._repo.create_notification(user_id, type, actor_user_id, node_id, message)

        if not self._push_sender or not self._push_sender.is_configured():
            return

        tokens = await self._push_device_repo.list_tokens_for_user(user_id)
        if not tokens or not push_title:
            return

        with contextlib.suppress(Exception):
            await self._push_sender.send_to_tokens(
                tokens,
                PushNotification(
                    title=push_title,
                    body=push_body or message or "",
                    data=push_data,
                ),
            )
