"""Repository interfaces (ports) for the activity feature."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class ActivityRepository(ABC):
    """Repository interface for node activity and link click tracking."""

    @abstractmethod
    async def verify_node_in_workspace(self, node_id: int) -> bool:
        """Return True if node exists in this workspace."""
        pass

    @abstractmethod
    async def get_node_is_page(self, node_id: int) -> bool | None:
        """Return is_page flag for node, or None if not found."""
        pass

    @abstractmethod
    async def get_node_activity(self, node_id: int, limit: int) -> list[Any]:
        """Fetch activity rows for a node, ordered newest first."""
        pass

    @abstractmethod
    async def create_node_activity(
        self,
        node_id: int,
        action: str,
        details: str | None,
        target_node_id: int | None,
        now: Any,
        user_id: int | None = None,
    ) -> tuple[int, str]:
        """Insert activity record and return its new (id, uuid)."""
        pass

    @abstractmethod
    async def get_target_node(self, target_node_id: int) -> tuple | None:
        """Return (name, uuid) for a node, or None if not found."""
        pass

    @abstractmethod
    async def delete_node_activity(self, activity_id: int, node_id: int) -> None:
        """Delete a specific activity record by internal ID."""
        pass

    @abstractmethod
    async def get_node_activity_by_uuid(
        self, activity_uuid: str, node_id: int
    ) -> Any | None:
        """Fetch a single activity row by its public UUID, verifying node ownership."""
        pass

    @abstractmethod
    async def delete_node_activity_by_uuid(
        self, activity_uuid: str, node_id: int
    ) -> bool:
        """Delete a specific activity record by its public UUID."""
        pass

    @abstractmethod
    async def track_link_click(
        self, source_node_id: int, target_node_id: int, node_link_uuid: str | None, now: Any, user_id: int
    ) -> int:
        """Insert a link click record and return the updated click count."""
        pass

    @abstractmethod
    async def get_link_clicks_aggregated(self, source_node_id: int) -> list[Any]:
        """Get aggregated click counts per target for a source node."""
        pass

    @abstractmethod
    async def get_link_click(self, source_node_id: int, target_node_id: int) -> Any | None:
        """Get aggregated click count/last date for a source-target pair."""
        pass

    @abstractmethod
    async def get_link_click_history(self, source_node_id: int, target_node_id: int, limit: int) -> list[Any]:
        """Get individual click records for a source-target pair."""
        pass

    @abstractmethod
    async def reset_link_clicks(self, source_node_id: int, target_node_id: int) -> None:
        """Delete all click records for a source-target pair."""
        pass
