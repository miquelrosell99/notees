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
        asset_file_id: int | None = None,
    ) -> None:
        """Update an existing node so it becomes an asset node."""
        pass

    @abstractmethod
    async def asset_exists_by_uuid(self, uuid: str) -> bool:
        """Return True if an asset node with the given UUID exists in the workspace."""
        pass

    @abstractmethod
    async def create_asset_file(
        self,
        hash: str,
        size_bytes: int,
        extension: str,
        storage_path: str,
        user_id: int,
    ) -> int:
        """Create an asset_file record and return its internal id."""
        pass

    @abstractmethod
    async def find_asset_file_by_hash(self, hash: str) -> dict[str, Any] | None:
        """Return an existing asset_file row for the given hash in the workspace."""
        pass

    @abstractmethod
    async def get_asset_file_by_id(self, asset_file_id: int) -> dict[str, Any] | None:
        """Return an asset_file row by internal id."""
        pass

    @abstractmethod
    async def increment_asset_file_ref_count(self, asset_file_id: int) -> None:
        """Increment the ref_count of an asset_file."""
        pass

    @abstractmethod
    async def decrement_asset_file_ref_count(self, asset_file_id: int) -> int:
        """Decrement the ref_count and return the new value."""
        pass
