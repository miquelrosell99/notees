"""Repository interfaces (ports) for the assets feature."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class AssetRepository(ABC):
    """Repository interface for asset-specific persistence operations."""

    @abstractmethod
    async def get_page_and_asset_class_ids(self, user_id: int) -> tuple[int, int]:
        """Return (page_class_id, asset_class_id), creating the asset class if needed."""
        pass

    @abstractmethod
    async def convert_node_to_asset(
        self,
        node_id: int,
        asset_uuid: str,
        name: str,
        asset_class_id: int,
        user_id: int,
        asset_id: int | None = None,
    ) -> None:
        """Update an existing node so it becomes an asset node."""
        pass

    @abstractmethod
    async def asset_exists_by_uuid(self, uuid: str) -> bool:
        """Return True if an asset node with the given UUID exists in the workspace."""
        pass

    @abstractmethod
    async def create_asset(
        self,
        hash: str,
        size: int,
        mime_type: str | None,
        original_name: str | None,
        user_id: int,
    ) -> int:
        """Create an asset record and return its internal id."""
        pass

    @abstractmethod
    async def find_asset_by_hash(self, hash: str) -> dict[str, Any] | None:
        """Return an existing asset row for the given hash in the workspace."""
        pass

    @abstractmethod
    async def get_asset_by_id(self, asset_id: int) -> dict[str, Any] | None:
        """Return an asset row by internal id."""
        pass

    @abstractmethod
    async def increment_asset_ref_count(self, asset_id: int) -> None:
        """Increment the refs_count of an asset."""
        pass

    @abstractmethod
    async def decrement_asset_ref_count(self, asset_id: int) -> int:
        """Decrement the refs_count and return the new value."""
        pass
