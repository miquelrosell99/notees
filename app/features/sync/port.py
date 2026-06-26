"""Repository interface (port) for client-server node synchronization."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from app.domain.entities.sync_v2 import VersionVector


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

    @abstractmethod
    async def get_vectors(self, node_ids: list[int]) -> dict[int, VersionVector]:
        """Fetch version vectors for a list of node IDs."""
        pass

    @abstractmethod
    async def get_vectors_by_uuids(self, uuids: list[str]) -> dict[str, VersionVector]:
        """Fetch version vectors for a list of node UUIDs."""
        pass

    @abstractmethod
    async def advance_vectors(
        self, updates: list[tuple[int, str, int]]
    ) -> dict[int, VersionVector]:
        """Upsert (node_id, client_id) -> seq and return updated vectors per node."""
        pass
