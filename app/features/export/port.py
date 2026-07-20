"""Repository interface (port) for node export operations."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class ExportRepository(ABC):
    """Repository interface for node export SQL operations."""

    @abstractmethod
    async def get_export_node_tree(
        self, workspace_uuid: str, node_uuid: str, include_children: bool, include_child_pages: bool = False
    ) -> list[Any]:
        """Fetch a node and optionally all its descendants.

        Returns raw rows ordered by path_order.  When include_children is False
        only the matching root node is returned.  When include_child_pages is True
        nested page nodes are included as section boundaries; otherwise only
        non-page descendants are returned.
        """
        pass

    @abstractmethod
    async def filter_text_property_node_ids(
        self, workspace_uuid: str, node_uuids: list[str]
    ) -> set[str]:
        """Return UUIDs of nodes that are text-property relation targets."""
        pass

    @abstractmethod
    async def get_system_class_map(
        self, workspace_uuid: str, uuids: list[str]
    ) -> dict[str, str]:
        """Fetch system class UUIDs/names for the given class UUIDs."""
        pass

    @abstractmethod
    async def resolve_link_targets(
        self, workspace_uuid: str, uuids: list[str]
    ) -> list[Any]:
        """Fetch node rows for link target UUIDs."""
        pass

    @abstractmethod
    async def get_node_properties_data(
        self, workspace_uuid: str, node_uuids: list[str]
    ) -> list[Any]:
        """Fetch all property rows for the given node UUIDs."""
        pass

    @abstractmethod
    async def get_relation_target_names(
        self, workspace_uuid: str, target_uuids: list[str]
    ) -> dict[str, str]:
        """Fetch plain-text names for relation target UUIDs."""
        pass

    @abstractmethod
    async def get_node_class_and_tag_names(
        self, page_node_uuids: list[str], workspace_uuid: str
    ) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
        """Return (class_names_by_node_uuid, tag_labels_by_node_uuid)."""
        pass

    @abstractmethod
    async def get_text_property_subtrees(
        self, workspace_uuid: str, target_uuids: list[str]
    ) -> dict[str, list[dict[str, Any]]]:
        """Fetch descendant blocks for text-property target UUIDs."""
        pass

    @abstractmethod
    async def get_page_metadata(
        self, workspace_uuid: str, node_uuid: str, include_properties: bool = True
    ) -> dict[str, Any]:
        """Fetch full metadata for a page's YAML frontmatter."""
        pass

    @abstractmethod
    async def get_auto_export_metadata(
        self, workspace_uuid: str, node_uuid: str
    ) -> dict[str, Any]:
        """Fetch node metadata for auto-export YAML frontmatter."""
        pass

    @abstractmethod
    async def list_exportable_pages(
        self, workspace_uuid: str
    ) -> list[dict[str, Any]]:
        """List active non-deleted page UUIDs and names for batch export."""
        pass

    @abstractmethod
    async def resolve_node_ids(
        self, workspace_uuid: str, node_uuids: list[str]
    ) -> list[str]:
        """Return node UUIDs for the given UUIDs in the workspace."""
        pass
