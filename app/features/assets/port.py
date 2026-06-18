"""Repository interfaces (ports) for the assets feature."""

from __future__ import annotations

from abc import ABC, abstractmethod


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
    ) -> None:
        """Update an existing node so it becomes an asset node."""
        pass

    @abstractmethod
    async def asset_exists_by_uuid(self, uuid: str) -> bool:
        """Return True if an asset node with the given UUID exists in the workspace."""
        pass
