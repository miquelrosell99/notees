"""Repository interface (port) for client-server node synchronization."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class SyncRepository(ABC):
    """Repository interface for client-server node synchronization."""

    @abstractmethod
    async def get_server_nodes_since(
        self, workspace_id: int, last_sync: str | None, limit: int
    ) -> list[dict[str, Any]]:
        """Fetch server-side node states modified since last_sync (or all active nodes)."""
        pass

    @abstractmethod
    async def get_node_state_by_uuid(self, uuid: str) -> dict[str, Any] | None:
        """Fetch minimal node state (id, version, is_deleted, workspace_id) by UUID."""
        pass

    @abstractmethod
    async def apply_client_node_update(
        self,
        node_id: int,
        name: str | None,
        parent_id: int | None,
        sequence: float | None,
        is_deleted: bool,
        user_id: int,
    ) -> None:
        """Apply a client change to a node (metadata-only)."""
        pass
