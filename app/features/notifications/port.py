"""Repository interfaces (ports) for the notifications feature."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class NotificationRepository(ABC):
    """Repository interface for in-app notification operations."""

    @abstractmethod
    async def list_notifications(self, user_id: int, include_read: bool, limit: int) -> list[Any]:
        """List notifications for a user, optionally including read ones."""
        pass

    @abstractmethod
    async def mark_notification_read(self, notification_id: int, user_id: int) -> bool:
        """Mark a single notification as read. Returns True if updated."""
        pass

    @abstractmethod
    async def mark_all_notifications_read(self, user_id: int) -> None:
        """Mark all notifications for a user as read."""
        pass

    @abstractmethod
    async def create_notification(
        self, user_id: int, type: str, actor_user_id: int | None, node_id: int | None, message: str | None
    ) -> None:
        """Create a notification for a user."""
        pass

    @abstractmethod
    async def create_many(self, notifications: list[dict[str, Any]]) -> None:
        """Create multiple notifications in a single batch."""
        pass


class PushDeviceRepository(ABC):
    """Repository interface for push notification device tokens."""

    @abstractmethod
    async def register_token(self, user_id: int, token: str, platform: str) -> None:
        """Register or reactivate a device token for a user."""
        pass

    @abstractmethod
    async def list_tokens_for_user(self, user_id: int) -> list[str]:
        """Return active device tokens for a user."""
        pass

    @abstractmethod
    async def deactivate_token(self, token: str) -> None:
        """Mark a token as inactive (e.g., after FCM reports it as invalid)."""
        pass
