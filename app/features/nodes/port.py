"""Repository ports for the nodes feature."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.domain.entities import (
        ClassExtend,
        Node,
        NodeCreateData,
        NodeLink,
        NodeMention,
        NodeUpdateData,
        NodeView,
    )


class NodeCrudRepository(ABC):
    """Repository interface for basic Node CRUD operations."""

    @abstractmethod
    async def create(self, data: NodeCreateData, user_id: int | None = None) -> Node:
        """Create a new node."""
        pass

    @abstractmethod
    async def get_by_id(self, node_id: int) -> Node | None:
        """Get node by internal ID."""
        pass

    @abstractmethod
    async def get_by_ids(self, node_ids: list[int]) -> list[Node]:
        """Get multiple nodes by internal IDs in a single query."""
        pass

    @abstractmethod
    async def get_by_uuid(self, uuid: str) -> Node | None:
        """Get node by UUID."""
        pass

    @abstractmethod
    async def get_by_uuids(self, uuids: list[str]) -> list[Node]:
        """Get multiple nodes by UUID in a single query."""
        pass

    @abstractmethod
    async def update(self, node_id: int, data: NodeUpdateData, user_id: int | None = None) -> Node | None:
        """Update a node."""
        pass

    @abstractmethod
    async def delete(self, node_id: int) -> bool:
        """Delete a node and all its children."""
        pass

    @abstractmethod
    async def get_children(self, parent_id: int, limit: int = 5000) -> list[Node]:
        """Get direct children of a node."""
        pass

    @abstractmethod
    async def get_all_pages(self, limit: int = 1000, offset: int = 0) -> list[Node]:
        """Get nodes tagged as 'page', paginated."""
        pass

    @abstractmethod
    async def get_page_content(self, page_id: int, limit: int = 5000) -> list[Node]:
        """Get all nodes belonging to a page (recursive children)."""
        pass

    @abstractmethod
    async def set_active(self, node_id: int, active: bool, user_id: int | None = None) -> Node | None:
        """Set the active status of a node (archive/unarchive)."""
        pass

    @abstractmethod
    async def get_archived_pages(self) -> list[Node]:
        """Get all archived pages."""
        pass

    @abstractmethod
    async def get_archived_pages_paginated(
        self, page: int, page_size: int
    ) -> tuple[list[Node], int]:
        """Get archived pages with total count."""
        pass

    @abstractmethod
    async def node_exists(self, node_id: int) -> bool:
        """Check if a node exists in this workspace."""
        pass

    @abstractmethod
    async def get_active_nodes(self, limit: int | None = None) -> list[Node]:
        """Get all active nodes in the workspace, optionally limited."""
        pass

    @abstractmethod
    async def get_node_versions(self, node_id: int, limit: int) -> list[Any]:
        """Get version history rows for a node."""
        pass

    @abstractmethod
    async def get_node_version(self, node_id: int, version_id: int) -> str | None:
        """Get the stored name for a specific node version."""
        pass

    @abstractmethod
    async def get_node_version_detail(
        self, version_id: int, node_id: int
    ) -> dict[str, Any] | None:
        """Get a single node version detail row including username."""
        pass

    @abstractmethod
    async def filter_existing_active_node_ids(
        self, node_ids: list[int]
    ) -> set[int]:
        """Return IDs of active, non-deleted nodes that exist in this workspace."""
        pass

    @abstractmethod
    async def get_page_node_check(self, node_id: int) -> dict[str, Any] | None:
        """Get id and is_page for a node if active and in workspace."""
        pass

    @abstractmethod
    async def list_daily_pages_paginated(
        self, page: int, page_size: int
    ) -> tuple[int, list[Any]]:
        """List daily pages ordered by UUID desc."""
        pass

    @abstractmethod
    async def get_comment_ids_paginated(
        self, parent_id: int, page: int, page_size: int
    ) -> tuple[int, list[int]]:
        """Get paginated top-level comment IDs under a node."""
        pass

    @abstractmethod
    async def get_next_comment_sequence(self, parent_id: int) -> int:
        """Get the next sequence value for a comment under a parent."""
        pass

    @abstractmethod
    async def get_comment_count(self, node_id: int) -> int:
        """Count active comments under a node."""
        pass

    @abstractmethod
    async def get_shared_node_children(
        self, node_id: int
    ) -> list[Any]:
        """Get non-page descendants of a shared node for public access."""
        pass

    @abstractmethod
    async def get_trash_paginated(
        self, page: int, page_size: int
    ) -> tuple[int, list[Any]]:
        """Get paginated soft-deleted nodes for the workspace."""
        pass

class NodeHierarchyRepository(ABC):
    """Repository interface for Node tree/hierarchy operations."""

    @abstractmethod
    async def move(
        self,
        node_id: int,
        new_parent_id: int | None = None,
        new_sequence: float | None = None,
        user_id: int | None = None,
    ) -> Node | None:
        """Move a node to a new parent and/or sequence position."""
        pass

    @abstractmethod
    async def get_breadcrumbs(self, exit_node_id: int, enter_node_id: int | None = None) -> list[Node]:
        """Get the breadcrumb path for a node using recursive CTE."""
        pass

    @abstractmethod
    async def get_breadcrumbs_batch(
        self, exit_node_ids: list[int], enter_node_id: int | None = None
    ) -> dict[int, list[Node]]:
        """Get breadcrumb paths for multiple nodes in a single recursive CTE.

        Returns a mapping of exit_node_id -> list of ancestor nodes.
        """
        pass

    @abstractmethod
    async def get_ancestors(self, node_id: int, include_self: bool = False) -> list[int]:
        """Get all ancestor IDs of a node using recursive CTE."""
        pass

    @abstractmethod
    async def get_ancestors_batch(
        self, node_ids: list[int], include_self: bool = False
    ) -> dict[int, list[int]]:
        """Get ancestor IDs for multiple nodes in a single recursive CTE.

        Returns a mapping of node_id -> list of ancestor IDs.
        """
        pass

    @abstractmethod
    async def get_descendants(self, node_id: int, include_self: bool = False) -> list[int]:
        """Get all descendant IDs of a node using recursive CTE."""
        pass

    @abstractmethod
    async def get_descendants_ordered(self, node_id: int) -> list[Node]:
        """Get all descendants as Node entities ordered by depth then sequence."""
        pass

    @abstractmethod
    async def get_descendants_batch(
        self, node_ids: list[int], include_self: bool = False
    ) -> dict[int, list[int]]:
        """Get all descendant IDs for multiple nodes in a single recursive CTE.

        Returns a mapping of root_node_id -> list of descendant IDs.
        """
        pass

    @abstractmethod
    async def get_all_descendants(self, node_id: int, include_self: bool = False) -> list[int]:
        """Get all descendant IDs regardless of soft-delete status."""
        pass

    @abstractmethod
    async def find_page_by_name(self, name: str, parent_id: int | None = None) -> list[Any]:
        """Find pages with the given name and parent, returning raw rows with class info."""
        pass

    @abstractmethod
    async def has_circular_reference(self, ancestor_id: int, descendant_id: int) -> bool:
        """Check if setting ancestor_id as parent of descendant_id would create a cycle."""
        pass

    @abstractmethod
    async def get_depth_info(self, node_id: int) -> tuple[int, int]:
        """Get (parent_depth, subtree_depth) for a node using the closure table."""
        pass

    @abstractmethod
    async def get_children_ids(self, parent_id: int) -> list[int]:
        """Get direct child IDs of a node ordered by sequence."""
        pass

    @abstractmethod
    async def get_max_sequence(self, parent_id: int) -> float:
        """Get the maximum sequence among children of a parent."""
        pass

    @abstractmethod
    async def reparent_nodes(
        self, node_ids: list[int], new_parent_id: int, new_page_id: int, start_sequence: float
    ) -> None:
        """Reparent multiple nodes to a new parent with sequential ordering."""
        pass

    @abstractmethod
    async def shift_sequences(self, parent_id: int, from_sequence: float, amount: float) -> None:
        """Shift sequences of children at or after from_sequence by amount."""
        pass

class NodeSearchRepository(ABC):
    """Repository interface for Node search and class-related queries."""

    @abstractmethod
    async def search(
        self,
        query: str,
        limit: int = 50,
        offset: int = 0,
        class_filters: list[int] | None = None,
        is_page: bool | None = None,
        is_class: bool | None = None,
        is_daily: bool | None = None,
        is_user_page: bool | None = None,
        sort_by: str = "write_date",
        order: str = "desc",
    ) -> list[Node]:
        """Search nodes by name with optional filters, sorting and pagination."""
        pass

    @abstractmethod
    async def list_nodes(
        self,
        pages_only: bool = False,
        parent_id: int | None = None,
        type_id: int | None = None,
        tag_id: int | None = None,
        class_ids: list[int] | None = None,
        root_only: bool = False,
        sort_by: str = "sequence",
        order: str = "asc",
        page: int = 1,
        page_size: int = 1000,
    ) -> tuple[list[Node], int]:
        """List nodes with server-side filtering, sorting, and pagination.

        Returns a tuple of (nodes, total_count).
        """
        pass

    @abstractmethod
    async def get_typed_with(
        self, type_node_id: int, limit: int = 1000, offset: int = 0
    ) -> list[Node]:
        """Get nodes with a specific type, paginated."""
        pass

    @abstractmethod
    async def get_task_nodes(
        self, limit: int = 1000, offset: int = 0
    ) -> list[Node]:
        """Get active task nodes using the is_task index, paginated."""
        pass

    @abstractmethod
    async def list_classes(self) -> list[Node]:
        """List all active class nodes in the workspace, ordered by name."""
        pass

    @abstractmethod
    async def search_classes(self, q: str, limit: int = 20) -> list[Node]:
        """Search class nodes by name (ILIKE) and full-text search."""
        pass

    @abstractmethod
    async def get_nodes_with_classes(self, class_ids: list[int], limit: int | None = None, offset: int | None = None) -> list[Node]:
        """Get all nodes that have any of the given class IDs in their class_ids array."""
        pass

    @abstractmethod
    async def count_nodes_with_classes(self, class_ids: list[int]) -> int:
        """Count nodes that have any of the given class IDs in their class_ids array."""
        pass

    @abstractmethod
    async def get_inline_class_ids(self, node_id: int) -> list[int]:
        """Get inline class IDs (from node_link with is_inline_class=TRUE) for a node."""
        pass

    @abstractmethod
    async def find_node_id_by_uuid(self, uuid: str) -> int | None:
        """Find a node ID by UUID in this workspace."""
        pass

    @abstractmethod
    async def get_recent_pages(self, limit: int = 10) -> list[Node]:
        """Get recently opened pages ordered by open_date DESC."""
        pass

    @abstractmethod
    async def get_random_pages(self, limit: int = 5) -> list[Node]:
        """Get random non-deleted, non-system pages."""
        pass

    @abstractmethod
    async def get_recently_created_pages(self, limit: int = 5) -> list[Node]:
        """Get recently created pages ordered by create_date DESC."""
        pass

    @abstractmethod
    async def find_active_nodes_by_name_patterns(self, patterns: list[str]) -> list[Any]:
        """Get active node id/name rows matching any of the given LIKE patterns."""
        pass

    @abstractmethod
    async def get_page_id_by_uuid(self, uuid: str) -> int | None:
        """Get the ID of an active page node by UUID."""
        pass

    @abstractmethod
    async def search_by_uuid_prefix(self, uuid_prefix: str, limit: int) -> list[Node]:
        """Search active nodes by UUID prefix."""
        pass

    @abstractmethod
    async def resolve_referenced_display_names(self, target_rows: list[Any]) -> dict[str, str]:
        """Resolve node links embedded in names and return uuid -> resolved plain-text map.

        Only returns entries for rows whose names actually contain node links.
        """
        pass

    @abstractmethod
    async def get_node_names_by_uuids(self, uuids: list[str]) -> dict[str, str | None]:
        """Fetch node names for the given UUIDs in this workspace."""
        pass

    @abstractmethod
    async def get_workspace_data(
        self, page: int, page_size: int
    ) -> tuple[int, list[dict[str, Any]], list[dict[str, Any]]]:
        """Return workspace visualization data: (total, nodes, links).

        Nodes and links are returned as plain dicts to be mapped to response
        models by the caller.
        """
        pass

    @abstractmethod
    async def get_workspace_nodes(
        self, page: int, page_size: int
    ) -> tuple[int, list[dict[str, Any]]]:
        """Return workspace nodes without links: (total, nodes)."""
        pass

    @abstractmethod
    async def get_node_suggestions(
        self, class_filter_ids: list[int] | None, limit: int
    ) -> tuple[list[Node], list[Node]]:
        """Return suggested pages: recently created and recently linked.

        Returns a tuple of (recent_nodes, linked_nodes) in priority order.
        """
        pass

class NodeTrashRepository(ABC):
    """Repository interface for Node trash and archive operations."""

    @abstractmethod
    async def get_deleted_nodes(self) -> list[Node]:
        """Get all soft-deleted nodes in the workspace ordered by deleted_at DESC."""
        pass

    @abstractmethod
    async def get_node_by_id_with_workspace(self, node_id: int) -> Node | None:
        """Get a node by ID, verifying it belongs to this workspace."""
        pass

    @abstractmethod
    async def soft_delete_nodes(self, node_ids: list[int], deleted_at: str, write_uid: int) -> None:
        """Bulk soft-delete nodes by setting is_deleted=TRUE and deleted_at."""
        pass

    @abstractmethod
    async def restore_nodes(self, node_ids: list[int], write_date: str, write_uid: int) -> None:
        """Bulk restore nodes from trash."""
        pass

    @abstractmethod
    async def hard_delete_nodes(self, node_ids: list[int]) -> None:
        """Bulk permanently delete nodes (assumes they are already in trash)."""
        pass

    @abstractmethod
    async def get_trash_node_ids(self) -> list[int]:
        """Get IDs of all soft-deleted nodes in the workspace."""
        pass

    @abstractmethod
    async def archive_nodes(self, node_ids: list[int], write_date: str, write_uid: int) -> None:
        """Bulk archive nodes by setting active=FALSE."""
        pass

    @abstractmethod
    async def unarchive_nodes(self, node_ids: list[int], write_date: str, write_uid: int) -> None:
        """Bulk unarchive nodes by setting active=TRUE."""
        pass

class NodeTemplateRepository(ABC):
    """Repository interface for Node template operations."""

    @abstractmethod
    async def list_templates(self) -> list[Node]:
        """List all active templates in the workspace."""
        pass

    @abstractmethod
    async def list_templates_paginated(
        self, page: int, page_size: int
    ) -> tuple[list[Node], int]:
        """List active templates with total count."""
        pass

    @abstractmethod
    async def get_template_descendants(self, template_id: int) -> list[Node]:
        """Get all descendant nodes of a template (excluding the template itself)."""
        pass

    @abstractmethod
    async def count_active_day_descendants(self, node_id: int) -> int:
        """Count active day-page descendants of a node."""
        pass

class NodeClassRepository(ABC):
    """Repository interface for Node class assignment operations."""

    @abstractmethod
    async def get_node_class_ids(self, node_id: int) -> list[int]:
        """Get the class_ids array for a node."""
        pass

    @abstractmethod
    async def update_node_class_ids(self, node_id: int, class_ids: list[int]) -> None:
        """Update class_ids for a node."""
        pass

    @abstractmethod
    async def get_class_ids_batch(self, node_ids: list[int]) -> dict[int, list[int]]:
        """Get class_ids arrays for multiple nodes in a single query."""
        pass

    @abstractmethod
    async def get_node_tag_ids(self, node_id: int) -> list[int]:
        """Get the tag_ids array for a node."""
        pass

    @abstractmethod
    async def update_node_tag_ids(self, node_id: int, tag_ids: list[int]) -> None:
        """Update tag_ids for a node."""
        pass

    @abstractmethod
    async def get_tag_ids_batch(self, node_ids: list[int]) -> dict[int, list[int]]:
        """Get tag_ids arrays for multiple nodes in a single query."""
        pass

    @abstractmethod
    async def remove_tag_id_from_all_nodes(self, tag_id: int) -> int:
        """Remove a tag ID from all node.tag_ids arrays. Returns number of nodes updated."""
        pass

    @abstractmethod
    async def redirect_tag_ids(self, old_tag_id: int, new_tag_id: int) -> int:
        """Replace old_tag_id with new_tag_id in all node.tag_ids arrays. Returns number of nodes updated."""
        pass

    @abstractmethod
    async def get_node_sequence(self, node_id: int) -> int | None:
        """Get the sequence of a node."""
        pass

    @abstractmethod
    async def redirect_property_relation_targets(self, old_target_id: int, new_target_id: int) -> int:
        """Update all property_value_relation records to point from old_target to new_target."""
        pass

class NodeRepository(
    NodeCrudRepository,
    NodeHierarchyRepository,
    NodeSearchRepository,
    NodeTrashRepository,
    NodeTemplateRepository,
    NodeClassRepository,
    ABC,
):
    """Combined repository interface for Node operations.

    Composed of smaller, cohesive sub-interfaces for CRUD, hierarchy,
    search, trash, template, and class operations.
    """

    pass

class LinkRepository(ABC):
    """Repository interface for NodeLink operations.

    Handles both regular node links and inline class references
    (distinguished by is_inline_class flag).
    """

    @abstractmethod
    async def create(self, link: NodeLink) -> NodeLink:
        """Create a new link."""
        pass

    @abstractmethod
    async def delete_source_links(self, source_node_id: int) -> int:
        """Delete all links from a source node (for re-parsing)."""
        pass

    @abstractmethod
    async def get_backlinks(self, target_node_id: int) -> list[NodeLink]:
        """Get all links pointing to a target node."""
        pass

    @abstractmethod
    async def get_page_backlinks(self, page_id: int) -> list[NodeLink]:
        """Get page-type backlinks (with inheritance)."""
        pass

    @abstractmethod
    async def get_outgoing_links(self, source_node_id: int) -> list[NodeLink]:
        """Get all links from a source node."""
        pass

    @abstractmethod
    async def delete_source_inline_classes(self, source_node_id: int) -> int:
        """Delete all inline class links from a source node (for re-parsing)."""
        pass

    @abstractmethod
    async def get_inline_class_references(self, target_node_id: int) -> list[NodeLink]:
        """Get all inline class links pointing to a target node."""
        pass

    @abstractmethod
    async def get_text_link_targets(self, source_node_id: int) -> list[int]:
        """Get target IDs of text links (non-inline-class) from a source node."""
        pass

    @abstractmethod
    async def delete_non_inline_class_text_links(self, source_node_id: int) -> int:
        """Delete all non-inline-class text links from a source node.

        Returns the number of links deleted.
        """
        pass

    @abstractmethod
    async def delete_property_links(self, source_node_id: int, property_id: int) -> int:
        """Delete all links for a specific property from a source node.

        Returns the number of links deleted.
        """
        pass

    @abstractmethod
    async def get_alias_node_ids(self, target_id: int) -> list[int]:
        """Get IDs of nodes that alias the target node."""
        pass

    @abstractmethod
    async def get_alias_node_ids_batch(self, target_ids: list[int]) -> dict[int, list[int]]:
        """Get alias node IDs for multiple target nodes.

        Returns a mapping of target_id -> list of alias node IDs.
        """
        pass

    @abstractmethod
    async def get_links_for_nodes(
        self,
        node_ids: list[int],
        scope: str,
        cooccurrence: bool,
        context_node_id: int | None,
    ) -> list[dict[str, Any]]:
        """Get links (reference, parent, class, extends, property-reference, cooccurrence).

        Args:
            node_ids: The set of node IDs to compute links for.
            scope: "between" (both ends in set) or "touching" (at least one end in set).
            cooccurrence: Whether to include co-occurrence links.
            context_node_id: Optional context page for local co-occurrence.

        Returns a list of link dicts with keys source, target, type, and optional weight.
        """
        pass

    @abstractmethod
    async def get_backlinks_batch(self, target_ids: list[int]) -> list[Any]:
        """Get all node_link backlinks for multiple target IDs at once.

        Returns raw rows with source node info.
        """
        pass

    @abstractmethod
    async def get_property_backlinks_batch(self, target_ids: list[int]) -> list[Any]:
        """Get all property-value relation backlinks (node-type) for multiple targets."""
        pass

    @abstractmethod
    async def get_text_property_backlinks_batch(self, target_ids: list[int]) -> list[Any]:
        """Get all text-type property backlinks for multiple targets."""
        pass

    @abstractmethod
    async def get_path_references(self, source_ids: list[int]) -> list[int]:
        """Get distinct target IDs referenced by any of the source nodes."""
        pass

    @abstractmethod
    async def get_text_link_targets_batch(self, source_ids: list[int]) -> list[int]:
        """Get distinct target IDs of text links from source nodes."""
        pass

    @abstractmethod
    async def get_backlink_counts(self, target_ids: list[int]) -> dict[int, int]:
        """Get backlink counts for multiple target nodes."""
        pass

    @abstractmethod
    async def get_node_class_ids(self, node_id: int) -> list[int]:
        """Get class_ids array for a node."""
        pass

    @abstractmethod
    async def get_distinct_class_ids(self, node_ids: list[int]) -> list[int]:
        """Get all distinct class IDs from a list of nodes."""
        pass

    @abstractmethod
    async def bulk_update_classes_path(self, updates: list[tuple[list[int], int]]) -> None:
        """Bulk update classes_path for multiple nodes.

        Args:
            updates: List of (classes_path, node_id) tuples.
        """
        pass

    @abstractmethod
    async def get_inline_class_targets(self, source_node_id: int) -> list[int]:
        """Get target IDs of inline class links from a source node."""
        pass

    @abstractmethod
    async def log_link_activity(
        self, node_id: int, action: str, details: str, target_node_id: int | None, create_date: Any
    ) -> None:
        """Log a link-related activity event."""
        pass

    @abstractmethod
    async def get_backlink_source_ids(self, target_id: int) -> list[int]:
        """Get distinct source node IDs that link to the target."""
        pass

    @abstractmethod
    async def redirect_link_targets(self, old_target_id: int, new_target_id: int) -> None:
        """Update all node_link records to point from old_target to new_target."""
        pass

    @abstractmethod
    async def get_text_links(self, source_node_id: int) -> list[NodeLink]:
        """Get all text links (property_id IS NULL) from a source node ordered by position."""
        pass

    @abstractmethod
    async def get_text_links_batch(self, node_ids: list[int]) -> list[NodeLink]:
        """Get all text links for multiple source nodes ordered by source_id, position."""
        pass

    @abstractmethod
    async def get_property_backlinks_for_node(self, node_id: int) -> tuple[list[Any], list[Any]]:
        """Get property backlinks for a node.

        Returns (date_property_rows, node_property_rows) where each row has
        node_id, property_id, property_name.
        """
        pass

    @abstractmethod
    async def set_alias(self, target_node_id: int, alias_node_id: int) -> None:
        """Set aliased_id on alias_node_id to target_node_id."""
        pass

    @abstractmethod
    async def remove_alias(self, target_node_id: int, alias_node_id: int) -> bool:
        """Clear aliased_id for an alias of target_node_id. Returns True if updated."""
        pass

    @abstractmethod
    async def delete_text_links_for_workspace(self) -> int:
        """Delete all text links (property_id IS NULL) in the workspace."""
        pass

class MentionRepository(ABC):
    """Repository interface for unlinked mention candidates."""

    @abstractmethod
    async def delete_for_source(self, source_node_id: int) -> int:
        """Delete all mentions for a source node."""
        pass

    @abstractmethod
    async def create(self, mention: NodeMention) -> NodeMention:
        """Create a mention candidate."""
        pass

    @abstractmethod
    async def create_many(self, mentions: list[NodeMention]) -> None:
        """Create multiple mention candidates in one batch."""
        pass

    @abstractmethod
    async def list_for_target(
        self,
        target_node_id: int,
        include_ignored: bool = False,
    ) -> list[NodeMention]:
        """List mentions for a target node."""
        pass

    @abstractmethod
    async def list_for_target_with_source_info(
        self,
        target_node_id: int,
        include_ignored: bool = False,
    ) -> list[dict[str, Any]]:
        """List mentions with source node name/uuid."""
        pass

    @abstractmethod
    async def get_by_id(self, mention_id: int) -> NodeMention | None:
        """Get a mention by ID."""
        pass

    @abstractmethod
    async def set_ignored(self, mention_id: int, ignored: bool = True) -> NodeMention | None:
        """Mark a mention as ignored (or un-ignored)."""
        pass

    @abstractmethod
    async def delete_for_workspace(self) -> int:
        """Delete all mentions in the workspace (e.g. for workspace deletion)."""
        pass

class ClassExtendRepository(ABC):
    """Repository interface for class extension (inheritance) operations."""

    @abstractmethod
    async def get_extended_classes(self, class_node_id: int) -> list[int]:
        """Get direct parent class IDs that this class extends, ordered by sequence."""
        pass

    @abstractmethod
    async def get_extended_classes_with_details(self, class_node_id: int) -> list[ClassExtend]:
        """Get direct parent classes with full details (name, icon)."""
        pass

    @abstractmethod
    async def add_extends(self, class_node_id: int, extends_class_id: int, sequence: int = 0) -> ClassExtend:
        """Add an extends relationship. Raises ValueError if already exists."""
        pass

    @abstractmethod
    async def remove_extends(self, class_node_id: int, extends_class_id: int) -> bool:
        """Remove an extends relationship. Returns True if deleted."""
        pass

    @abstractmethod
    async def get_classes_extended_by(self, class_node_id: int) -> list[dict[str, Any]]:
        """Get all classes that directly extend this class (reverse lookup)."""
        pass

    @abstractmethod
    async def get_direct_subclasses(self, class_node_id: int) -> list[int]:
        """Get direct subclass IDs (classes that extend this class)."""
        pass

    @abstractmethod
    async def get_extended_classes_batch(self, node_ids: list[int]) -> dict[int, list[int]]:
        """Batch-fetch class extends (parent class IDs) for a set of class nodes.

        Returns a dict mapping target_id (child class) -> list of source_ids
        (parent classes) in sequence order.
        """
        pass

    @abstractmethod
    async def expand_class_hierarchy(self, class_ids: list[int]) -> set[int]:
        """Expand a set of class IDs to include all subclasses recursively."""
        pass

class NodeViewRepository(ABC):
    """Repository interface for NodeView CRUD operations."""

    @abstractmethod
    async def create(
        self,
        node_id: int,
        name: str,
        view_type: str,
        query_json: dict[str, Any] | None = None,
        order_index: int = 0,
        is_default: bool = False,
    ) -> NodeView:
        """Create a new NodeView."""
        pass

    @abstractmethod
    async def get_by_id(self, view_id: int) -> NodeView | None:
        """Get a NodeView by ID."""
        pass

    @abstractmethod
    async def get_by_uuid(self, uuid: str) -> NodeView | None:
        """Get a NodeView by UUID."""
        pass

    @abstractmethod
    async def list_by_node(
        self,
        node_id: int,
        view_type: str | None = None,
        include_inactive: bool = False,
    ) -> list[NodeView]:
        """List NodeViews for a node."""
        pass

    @abstractmethod
    async def list_by_view_type(
        self,
        node_id: int,
        view_type: str,
    ) -> list[NodeView]:
        """List NodeViews for a specific view_type."""
        pass

    @abstractmethod
    async def count_by_view_type(
        self,
        node_id: int,
        view_type: str,
    ) -> int:
        """Count active NodeViews for a specific view_type."""
        pass

    @abstractmethod
    async def get_default_view(
        self,
        node_id: int,
        view_type: str,
    ) -> NodeView | None:
        """Get the default NodeView for a view_type."""
        pass

    @abstractmethod
    async def update(
        self,
        view_id: int,
        name: str | None = None,
        order_index: int | None = None,
        is_default: bool | None = None,
        shown_properties: list[dict[str, Any]] | None = None,
        group_by: str | None = None,
    ) -> NodeView | None:
        """Update a NodeView."""
        pass

    @abstractmethod
    async def update_query_json(
        self,
        view_id: int,
        query_json: dict[str, Any],
    ) -> NodeView | None:
        """Update a NodeView's query JSON."""
        pass

    @abstractmethod
    async def delete(self, view_id: int) -> bool:
        """Soft delete a NodeView."""
        pass

    @abstractmethod
    async def hard_delete(self, view_id: int) -> bool:
        """Permanently delete a NodeView."""
        pass

    @abstractmethod
    async def reorder(
        self,
        node_id: int,
        view_type: str,
        view_ids: list[int],
    ) -> list[NodeView]:
        """Reorder NodeViews within a view_type."""
        pass

    @abstractmethod
    async def count_by_node(self, node_id: int) -> int:
        """Count active NodeViews for a node."""
        pass
