"""Repository interfaces (ports) for domain entities."""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..entities import (
        ClassExtend,
        ClassProperty,
        Node,
        NodeCreateData,
        NodeLink,
        NodeMention,
        NodeProperty,
        NodeUpdateData,
        NodeView,
        Property,
        PropertyClassFilter,
        PropertySelectionLine,
        PropertyType,
        PropertyValueRelation,
        PropertyValueScalar,
        PropertyValueSelection,
        TaskCompletion,
        TaskRecurrence,
        User,
        UserCreateData,
    )
    from ..entities.share import PublicShare


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


class QueryRepository(ABC):
    """Repository interface for executing QueryAST-based queries."""

    @abstractmethod
    async def execute_query(
        self,
        query: Any,
        runtime_params: dict[str, Any] | None = None,
        limit: int | None = None,
        offset: int | None = None,
        order_by: str | None = None,
        enrich: dict[str, bool] | None = None,
    ) -> dict[str, Any]:
        """Execute a query and return results with optional pagination metadata."""
        pass

    @abstractmethod
    async def count_query_results(
        self,
        query: Any,
        runtime_params: dict[str, Any] | None = None,
    ) -> int:
        """Count results for a query without fetching all data."""
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


class PropertyRepository(ABC):
    """Repository interface for Property operations.

    New property system with:
    - property: Property definitions (with local property support)
    - node_property: Assignment of properties to nodes
    - property_value_scalar: Scalar values (integer, float, boolean, date)
    - property_value_relation: Relation values (node, text, image)
    - property_selection_line: Selection options
    - property_value_selection: Selection values
    """

    # ============== Property CRUD ==============

    @abstractmethod
    async def create(self, property: Property) -> Property:
        """Create a new property definition."""
        pass

    @abstractmethod
    async def get_by_id(self, property_id: int) -> Property | None:
        """Get property by ID with type filters and selection lines."""
        pass

    @abstractmethod
    async def get_by_uuid(self, uuid: str) -> Property | None:
        """Get property by UUID."""
        pass

    @abstractmethod
    async def get_by_name(self, name: str, node_id: int | None = None) -> Property | None:
        """Get property by name. For local properties, node_id specifies the page context."""
        pass

    @abstractmethod
    async def get_all(self, include_local: bool = True) -> list[Property]:
        """Get all property definitions."""
        pass

    @abstractmethod
    async def get_local_properties(self, node_id: int) -> list[Property]:
        """Get all local properties for a specific page node."""
        pass

    @abstractmethod
    async def update(self, property_id: int, name: str | None = None, icon: str | None = None) -> Property | None:
        """Update a property definition (name and icon only)."""
        pass

    @abstractmethod
    async def can_delete_property(self, property_id: int) -> tuple[bool, str]:
        """Check if a property can be deleted."""
        pass

    @abstractmethod
    async def can_change_property_type(self, property_id: int, new_type: PropertyType) -> tuple[bool, str]:
        """Check if a property type can be changed."""
        pass

    @abstractmethod
    async def change_property_type(
        self, property_id: int, new_type: PropertyType, new_is_multi: bool | None = None
    ) -> Property | None:
        """Change a property's type if no values exist."""
        pass

    @abstractmethod
    async def delete(self, property_id: int) -> bool:
        """Delete a property if no values exist."""
        pass

    # ============== Node Property (Assignment) ==============

    @abstractmethod
    async def assign_property_to_node(self, node_id: int, property_id: int) -> NodeProperty:
        """Assign a property to a node (without setting a value)."""
        pass

    @abstractmethod
    async def get_node_property(self, node_id: int, property_id: int) -> NodeProperty | None:
        """Get a node_property assignment."""
        pass

    @abstractmethod
    async def get_node_properties(self, node_id: int) -> list[NodeProperty]:
        """Get all property assignments for a node."""
        pass

    @abstractmethod
    async def remove_property_from_node(self, node_id: int, property_id: int) -> bool:
        """Remove a property assignment from a node."""
        pass

    @abstractmethod
    async def get_node_ids_with_property(self, property_id: int) -> list[int]:
        """Get all node IDs that have a specific property assigned."""
        pass

    # ============== Scalar Values ==============

    @abstractmethod
    async def set_scalar_value(self, node_id: int, property_id: int, value: Any) -> PropertyValueScalar:
        """Set a scalar property value for a node."""
        pass

    @abstractmethod
    async def get_scalar_values(self, node_id: int, property_id: int) -> list[PropertyValueScalar]:
        """Get all scalar values for a property on a node."""
        pass

    @abstractmethod
    async def remove_scalar_value(self, value_id: int) -> bool:
        """Remove a specific scalar value."""
        pass

    @abstractmethod
    async def clear_scalar_values(self, node_id: int, property_id: int) -> int:
        """Remove all scalar values for a property on a node."""
        pass

    # ============== Relation Values ==============

    @abstractmethod
    async def set_relation_value(self, node_id: int, property_id: int, target_id: int) -> PropertyValueRelation:
        """Set a relation property value for a node."""
        pass

    @abstractmethod
    async def get_relation_values(self, node_id: int, property_id: int) -> list[PropertyValueRelation]:
        """Get all relation values for a property on a node."""
        pass

    @abstractmethod
    async def remove_relation_value(self, value_id: int, delete_target_node: bool = False) -> bool:
        """Remove a specific relation value.

        Args:
            value_id: The ID of the property_value_relation to delete
            delete_target_node: If True, also delete the target node (for text/image types)
        """
        pass

    @abstractmethod
    async def clear_relation_values(self, node_id: int, property_id: int, delete_target_nodes: bool = False) -> int:
        """Remove all relation values for a property on a node.

        Args:
            node_id: The node to clear values from
            property_id: The property to clear values for
            delete_target_nodes: If True and property is text/image type, also delete target nodes
        """
        pass

    @abstractmethod
    async def delete_relation_values_by_target(self, target_id: int) -> int:
        """Delete all property_value_relation rows where target_id matches.

        Used when a node is deleted to clean up node-type property references.
        """
        pass

    # ============== Selection Lines (Options) ==============

    @abstractmethod
    async def add_selection_line(
        self, property_id: int, name: str, icon: str | None = None, sequence: int = 0
    ) -> PropertySelectionLine:
        """Add an option to a selection-type property."""
        pass

    @abstractmethod
    async def get_selection_lines(self, property_id: int) -> list[PropertySelectionLine]:
        """Get all selection options for a property."""
        pass

    @abstractmethod
    async def update_selection_line(
        self, line_id: int, name: str | None = None, icon: str | None = None, order: int | None = None
    ) -> PropertySelectionLine | None:
        """Update a selection option."""
        pass

    @abstractmethod
    async def can_delete_selection_line(self, line_id: int) -> tuple[bool, str]:
        """Check if a selection line can be deleted."""
        pass

    @abstractmethod
    async def delete_selection_line(self, line_id: int) -> bool:
        """Delete a selection option if not in use."""
        pass

    # ============== Selection Values ==============

    @abstractmethod
    async def set_selection_value(
        self, node_id: int, property_id: int, selection_line_id: int
    ) -> PropertyValueSelection:
        """Set a selection property value for a node."""
        pass

    @abstractmethod
    async def get_selection_values(self, node_id: int, property_id: int) -> list[PropertyValueSelection]:
        """Get all selection values for a property on a node."""
        pass

    @abstractmethod
    async def remove_selection_value(self, value_id: int) -> bool:
        """Remove a specific selection value."""
        pass

    @abstractmethod
    async def clear_selection_values(self, node_id: int, property_id: int) -> int:
        """Remove all selection values for a property on a node."""
        pass

    # ============== Class Filters ==============

    @abstractmethod
    async def add_class_filter(self, property_id: int, class_node_id: int) -> PropertyClassFilter:
        """Add a class filter to a relation-type property."""
        pass

    @abstractmethod
    async def get_class_filters(self, property_id: int) -> list[int]:
        """Get all class filter node IDs for a property."""
        pass

    @abstractmethod
    async def remove_class_filter(self, property_id: int, class_node_id: int) -> bool:
        """Remove a class filter from a property."""
        pass

    # ============== Unified Value Access ==============

    @abstractmethod
    async def get_all_property_values(self, node_id: int) -> dict[int, dict[str, Any]]:
        """Get all property values for a node, grouped by property_id."""
        pass

    @abstractmethod
    async def get_all_property_values_batch(self, node_ids: list[int]) -> dict[int, dict[int, dict[str, Any]]]:
        """Get all property values for multiple nodes at once.

        Returns: {node_id -> {property_id -> {'property': ..., 'node_property': ..., 'values': [...]}}}
        """
        pass

    @abstractmethod
    async def get_text_property_target_ids(self, target_ids: list[int]) -> set[int]:
        """Get IDs of nodes that are text-property value blocks for the given targets."""
        pass

    @abstractmethod
    async def clear_all_property_values(self, node_id: int, property_id: int) -> None:
        """Clear all values for a property on a node (but keep the assignment)."""
        pass

    # ============== Class Properties ==============

    @abstractmethod
    async def get_class_properties(self, class_node_id: int) -> list[ClassProperty]:
        """Get properties that a class applies to classed nodes."""
        pass

    @abstractmethod
    async def add_class_property(
        self, class_node_id: int, property_id: int, sequence: int = 0, default_value: Any = None, required: bool = False
    ) -> ClassProperty:
        """Link a property to a class."""
        pass

    @abstractmethod
    async def remove_class_property(self, class_node_id: int, property_id: int) -> bool:
        """Remove a property from a class."""
        pass

    @abstractmethod
    async def update_class_property(
        self,
        class_node_id: int,
        property_id: int,
        required: bool | None = None,
        hidden: bool | None = None,
    ) -> ClassProperty | None:
        """Update an existing class property (required, hidden flags)."""
        pass

    @abstractmethod
    async def get_all_inherited_properties(self, class_node_id: int) -> list[ClassProperty]:
        """Get all properties for a class including inherited ones."""
        pass

    @abstractmethod
    async def get_property_stats(self) -> list[dict[str, Any]]:
        """Return usage counts per property across all nodes in this workspace."""
        pass

    @abstractmethod
    async def get_property_suggestions(self, node_id: int | None) -> list[dict[str, Any]]:
        """Return property suggestions for a node, ranked by usage frequency."""
        pass

    @abstractmethod
    async def get_page_class_id(self) -> int | None:
        """Return the integer ID of the page class in this workspace."""
        pass

    @abstractmethod
    async def update_property_multi_and_rules(
        self,
        property_id: int,
        is_multi: bool | None,
        validation_rules: dict[str, Any] | None,
        user_id: int,
    ) -> None:
        """Update property is_multi and/or validation_rules."""
        pass

    @abstractmethod
    async def delete_excess_property_values(self, property_id: int, prop_type: PropertyType) -> None:
        """Delete all but the first value per node when switching from multi to single."""
        pass

    @abstractmethod
    async def get_nodes_with_property_detailed(
        self, property_id: int
    ) -> list[tuple[Any, list[int], dict[int, dict[str, Any]]]]:
        """Get detailed node rows, class_ids, and property values for nodes with a property."""
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


class UserRepository(ABC):
    """Repository interface for User operations and auth persistence.

    This port consolidates user-account persistence together with the
    API-key and refresh-token tables that are logically owned by the
    authentication subsystem. Concrete adapters implement the raw SQL;
    callers in ``app.auth`` build tokens, hashes, and caching on top.
    """

    # ============== User CRUD ==============

    @abstractmethod
    async def create(self, data: UserCreateData, password_hash: str) -> User:
        """Create a new user."""
        pass

    @abstractmethod
    async def get_by_id(self, user_id: int) -> User | None:
        """Get user by ID."""
        pass

    @abstractmethod
    async def get_by_uuid(self, uuid: str) -> User | None:
        """Get user by UUID."""
        pass

    @abstractmethod
    async def get_by_id_or_uuid(self, user_id: str) -> User | None:
        """Get user by ID or UUID string."""
        pass

    @abstractmethod
    async def get_by_email(self, email: str) -> User | None:
        """Get user by email address."""
        pass

    @abstractmethod
    async def get_user_id_by_page_node_uuid(self, node_uuid: str) -> int | None:
        """Get user ID whose user page node has the given UUID."""
        pass

    @abstractmethod
    async def update_profile(
        self,
        user_id: str,
        name: str | None = None,
        surnames: str | None = None,
        profile_pic: str | None = None,
    ) -> User | None:
        """Update a user's profile fields."""
        pass

    @abstractmethod
    async def update_password_hash(self, user_id: str, password_hash: str) -> User | None:
        """Update a user's password hash and return the updated user."""
        pass

    @abstractmethod
    async def deactivate(self, user_id: int) -> bool:
        """Deactivate a user."""
        pass

    @abstractmethod
    async def count_users(self) -> int:
        """Return the total number of users in the system."""
        pass

    @abstractmethod
    async def count_active_admins(self) -> int:
        """Return the number of active admin users in the system."""
        pass

    @abstractmethod
    async def ensure_initial_admin(self, admin_email: str, admin_password: str) -> bool:
        """Create an initial admin user if no active admin exists.

        Returns True if a new admin was created, False if an admin already exists.
        """
        pass

    # ============== Admin operations ==============

    @abstractmethod
    async def list_users_paginated(self, page: int, page_size: int) -> tuple[int, list[Any]]:
        """List all users paginated."""
        pass

    @abstractmethod
    async def count_other_admins(self, user_id: int) -> int:
        """Count active admins other than the given user."""
        pass

    @abstractmethod
    async def update_user_admin(self, user_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        """Update a user as admin. Returns the updated user row or None."""
        pass

    @abstractmethod
    async def deactivate_user_admin(self, user_id: str) -> bool:
        """Deactivate a user as admin. Returns True if updated."""
        pass

    @abstractmethod
    async def get_system_metrics(self) -> dict[str, Any]:
        """Get system-wide node/user/workspace/share counts."""
        pass

    @abstractmethod
    async def audit_assets(self, dry_run: bool) -> dict[str, Any]:
        """Audit asset files on disk vs active asset nodes."""
        pass

    # ============== API Keys ==============

    @abstractmethod
    async def create_api_key(
        self,
        user_id: int,
        name: str,
        key_hash: str,
        scopes: list[str],
        key_prefix: str,
        last_4: str,
        expires_at: datetime | None = None,
    ) -> dict:
        """Store a new API key and return the persisted record."""
        pass

    @abstractmethod
    async def list_api_keys(self, user_id: int) -> list[dict]:
        """List all non-revoked API keys for a user."""
        pass

    @abstractmethod
    async def revoke_all_api_keys(self, user_id: int) -> None:
        """Revoke all active API keys for a user."""
        pass

    @abstractmethod
    async def revoke_api_key(self, user_id: int, key_id: str) -> bool:
        """Revoke a single API key. Returns True if a row was updated."""
        pass

    @abstractmethod
    async def find_api_key_candidates(self, key_prefix: str, last_4: str) -> list[dict]:
        """Fetch non-revoked, non-expired API keys matching the prefix/last-4 pair."""
        pass

    @abstractmethod
    async def update_api_key_last_used(self, key_id: int) -> None:
        """Update the last_used_at timestamp for an API key."""
        pass

    # ============== Refresh Tokens ==============

    @abstractmethod
    async def create_refresh_token(
        self, user_id: int, token_hash: str, expires_at: datetime, family_id: str
    ) -> dict:
        """Store a refresh token and return the persisted record."""
        pass

    @abstractmethod
    async def list_active_refresh_tokens(self) -> list[dict]:
        """Fetch all non-revoked, non-expired refresh tokens."""
        pass

    @abstractmethod
    async def get_refresh_token_replacement(self, token_id: int) -> int | None:
        """Return the token_id that replaced this token, if any."""
        pass

    @abstractmethod
    async def rotate_refresh_token(self, old_token_id: int, token_hash: str, expires_at: datetime) -> dict:
        """Rotate a refresh token: revoke old, create new, link them."""
        pass

    @abstractmethod
    async def revoke_refresh_token_family(self, family_id: str) -> None:
        """Revoke all refresh tokens in a family."""
        pass

    @abstractmethod
    async def revoke_all_user_refresh_tokens(self, user_id: int) -> None:
        """Revoke all refresh tokens for a user."""
        pass


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
    ) -> int:
        """Insert activity record and return its new id."""
        pass

    @abstractmethod
    async def get_target_node(self, target_node_id: int) -> tuple | None:
        """Return (name, uuid) for a node, or None if not found."""
        pass

    @abstractmethod
    async def delete_node_activity(self, activity_id: int, node_id: int) -> None:
        """Delete a specific activity record."""
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


class ShareRepository(ABC):
    """Repository interface for public share link operations."""

    @abstractmethod
    async def create_share(
        self,
        node_id: int,
        workspace_id: int,
        created_by: int,
        expiry_date: str | None = None,
    ) -> PublicShare:
        """Create a new public share for a node."""
        pass

    @abstractmethod
    async def get_share_by_uuid(self, share_uuid: str) -> PublicShare | None:
        """Get a share by its UUID token."""
        pass

    @abstractmethod
    async def list_shares_for_node(self, node_id: int) -> list[PublicShare]:
        """List all active shares for a node."""
        pass

    @abstractmethod
    async def list_shares_for_workspace(self, workspace_id: int) -> list[PublicShare]:
        """List all active shares in a workspace."""
        pass

    @abstractmethod
    async def delete_share(self, share_uuid: str) -> bool:
        """Revoke (soft-delete) a share by its UUID."""
        pass

    @abstractmethod
    async def get_shared_node(self, share_uuid: str) -> Node | None:
        """Get the node associated with a valid share."""
        pass

    @abstractmethod
    async def set_share_password(self, share_id: int, password_hash: str) -> None:
        """Set a password hash on a public share."""
        pass

    @abstractmethod
    async def list_share_inbox(
        self, user_id: int, page: int, page_size: int
    ) -> tuple[int, list[Any]]:
        """Get paginated node shares for a user."""
        pass

    @abstractmethod
    async def create_node_user_share(
        self,
        node_id: int,
        workspace_id: int,
        user_id: int,
        target_email: str,
        permission: str,
    ) -> dict[str, Any] | None:
        """Create or update a node-level user share. May create a pending invite.

        Returns a dict describing the result. For direct shares it includes the
        inserted share row; for invites it returns {"status": "pending", ...}.
        """
        pass

    @abstractmethod
    async def list_node_user_shares(
        self, node_id: int, workspace_id: int, user_id: int
    ) -> tuple[bool, list[Any]]:
        """List user shares for a node.

        Returns (is_owner, rows).
        """
        pass

    @abstractmethod
    async def revoke_user_share(
        self, share_id: int, workspace_id: int, user_id: int
    ) -> dict[str, Any] | None:
        """Revoke a node user share and clear is_shared if no shares remain.

        Returns {"node_id": node_id} on success, or None if not found/forbidden.
        """
        pass


class UndoRepository(ABC):
    """Repository interface for undo / redo log operations."""

    @abstractmethod
    async def record(
        self,
        operation: str,
        entity_type: str,
        entity_id: int,
        before_state: dict | None,
        after_state: dict | None,
        description: str = "",
    ) -> None:
        """Append an entry to the undo log.

        Also clears any redo entries and trims old entries to the configured
        maximum stack size.
        """
        pass

    @abstractmethod
    async def get_undo(self) -> dict | None:
        """Return the most recent non-undone entry, or None if empty."""
        pass

    @abstractmethod
    async def get_redo(self) -> dict | None:
        """Return the most recently undone entry, or None if empty."""
        pass

    @abstractmethod
    async def undo(self) -> dict | None:
        """Undo the most recent operation and mark it undone.

        Returns a summary dict on success, or None if nothing to undo.
        """
        pass

    @abstractmethod
    async def redo(self) -> dict | None:
        """Redo the most recently undone operation and mark it not undone.

        Returns a summary dict on success, or None if nothing to redo.
        """
        pass

    @abstractmethod
    async def get_undo_entries(self) -> list[dict]:
        """Return all non-undone entries ordered newest first."""
        pass

    @abstractmethod
    async def get_redo_entries(self) -> list[dict]:
        """Return all undone entries ordered oldest first."""
        pass

    @abstractmethod
    async def undo_to(self, entry_id: int) -> list[dict]:
        """Undo all operations down to and including entry_id."""
        pass

    @abstractmethod
    async def redo_to(self, entry_id: int) -> list[dict]:
        """Redo all operations up to and including entry_id."""
        pass

    @abstractmethod
    async def clear(self) -> None:
        """Delete all undo/redo entries for the current user+workspace."""
        pass

    @abstractmethod
    async def clear_for_node(self, node_id: int) -> None:
        """Delete all undo/redo entries affecting the given node."""
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


class ExportRepository(ABC):
    """Repository interface for node export SQL operations."""

    @abstractmethod
    async def get_export_node_tree(
        self, workspace_id: int, node_uuid: str, include_children: bool, include_child_pages: bool = False
    ) -> list[Any]:
        """Fetch a node and optionally all its descendants.

        Returns raw rows ordered by path_order.  When include_children is False
        only the matching root node is returned.  When include_child_pages is True,
        nested page nodes are included as section boundaries; otherwise only
        non-page descendants are returned.
        """
        pass

    @abstractmethod
    async def filter_text_property_node_ids(self, node_ids: list[int]) -> set[int]:
        """Return IDs of nodes that are text-property relation targets."""
        pass

    @abstractmethod
    async def get_system_class_map(self, workspace_id: int, uuids: list[str]) -> dict[int, str]:
        """Fetch system class IDs/names for the given class UUIDs."""
        pass

    @abstractmethod
    async def resolve_link_targets(
        self, workspace_id: int, uuids: list[str]
    ) -> list[Any]:
        """Fetch node rows for link target UUIDs."""
        pass

    @abstractmethod
    async def get_node_properties_data(self, node_ids: list[int]) -> list[Any]:
        """Fetch all property rows for the given node IDs."""
        pass

    @abstractmethod
    async def get_relation_target_names(self, target_ids: list[int]) -> dict[int, str]:
        """Fetch plain-text names for relation target IDs."""
        pass

    @abstractmethod
    async def get_node_class_and_tag_names(
        self, page_node_ids: list[int], workspace_id: int
    ) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
        """Return (class_names_by_node_uuid, tag_labels_by_node_uuid)."""
        pass

    @abstractmethod
    async def get_text_property_subtrees(
        self, target_ids: list[int]
    ) -> dict[int, list[dict[str, Any]]]:
        """Fetch descendant blocks for text-property target IDs."""
        pass

    @abstractmethod
    async def get_page_metadata(
        self, workspace_id: int, node_uuid: str, include_properties: bool = True
    ) -> dict[str, Any]:
        """Fetch full metadata for a page's YAML frontmatter."""
        pass

    @abstractmethod
    async def get_auto_export_metadata(
        self, workspace_id: int, node_uuid: str
    ) -> dict[str, Any]:
        """Fetch node metadata for auto-export YAML frontmatter."""
        pass

    @abstractmethod
    async def list_exportable_pages(
        self, workspace_id: int
    ) -> list[dict[str, Any]]:
        """List active non-deleted page UUIDs and names for batch export."""
        pass


class WorkspaceRepository(ABC):
    """Repository interface for workspace lifecycle, membership, and invite operations."""

    @abstractmethod
    async def list_workspaces(self, user_id: int) -> list[Any]:
        """List all workspaces accessible to a user (owned + shared).

        Returns raw rows with workspace info plus share permission columns.
        """
        pass

    @abstractmethod
    async def get_by_name_and_owner(self, name: str, owner_id: int) -> Any | None:
        """Get an active workspace by name and owner."""
        pass

    @abstractmethod
    async def create(self, name: str, owner_id: int) -> Any:
        """Create a new workspace and return the inserted row."""
        pass

    @abstractmethod
    async def get_by_uuid_for_user(self, workspace_uuid: str, user_id: int) -> Any | None:
        """Get a workspace by UUID if the user has access."""
        pass

    @abstractmethod
    async def rename(self, workspace_id: int, new_name: str, owner_id: int) -> Any | None:
        """Rename a workspace (owner only) and return the updated row."""
        pass

    @abstractmethod
    async def get_id_by_uuid_and_owner(self, workspace_uuid: str, owner_id: int) -> int | None:
        """Get a workspace ID by UUID, verifying the user is the owner."""
        pass

    @abstractmethod
    async def delete_cascade(self, workspace_id: int) -> bool:
        """Hard-delete a workspace and all its data.

        Disables triggers for bulk deletion, removes node/activity/link/property
        rows, deletes the workspace row, and returns True if a row was deleted.
        """
        pass

    @abstractmethod
    async def resolve_workspace_for_export(
        self, user_id: int, workspace_uuid: str | None = None
    ) -> int:
        """Resolve a workspace ID for export operations."""
        pass

    @abstractmethod
    async def seed_workspace(self, workspace_id: int, user_id: int) -> None:
        """Seed a new workspace with system classes, properties, and pages."""
        pass

    @abstractmethod
    async def ensure_user_page(self, workspace_id: int, user_id: int) -> int | None:
        """Create a system user page node if the user doesn't have one yet."""
        pass

    @abstractmethod
    async def get_workspace_uuid_by_name_for_user(self, name: str, user_id: int) -> str | None:
        """Resolve a workspace UUID from its name for a user (owner or shared)."""
        pass

    @abstractmethod
    async def get_workspace_id_owner(self, workspace_uuid: str) -> tuple[int, int] | None:
        """Return (workspace_id, owner_id) for an active workspace, or None."""
        pass

    @abstractmethod
    async def is_workspace_member(self, workspace_id: int, user_id: int) -> bool:
        """Return True if the user has an active workspace_share record."""
        pass

    @abstractmethod
    async def invite_existing_member(
        self, workspace_id: int, target_id: int, role: str, owner_id: int
    ) -> None:
        """Upsert a workspace_share record for an existing user."""
        pass

    @abstractmethod
    async def create_pending_invite(
        self, workspace_id: int, email: str, role: str, invited_by: int
    ) -> str:
        """Create or refresh a pending_invite record and return its UUID."""
        pass

    @abstractmethod
    async def list_members(
        self, workspace_id: int, page: int, page_size: int
    ) -> dict[str, Any]:
        """Return owner, shared members, and pending invites for a workspace."""
        pass

    @abstractmethod
    async def update_member_role(
        self, workspace_id: int, member_user_id: int, role: str, owner_id: int
    ) -> bool:
        """Update an active member's role. Returns True if a row was updated."""
        pass

    @abstractmethod
    async def remove_member(self, workspace_id: int, member_user_id: int) -> None:
        """Soft-remove a member by marking their workspace_share record inactive."""
        pass

    @abstractmethod
    async def remove_pending_invite(self, workspace_id: int, email: str) -> None:
        """Cancel a pending invite by email for a workspace-wide invite."""
        pass


class SettingsRepository(ABC):
    """Repository interface for user and workspace settings."""

    @abstractmethod
    async def get_user_settings(self, user_id: int) -> dict:
        """Return all settings for a user as a key→value dict."""
        pass

    @abstractmethod
    async def get_user_setting(self, user_id: int, key: str) -> Any | None:
        """Return a single user setting value, or None if not set."""
        pass

    @abstractmethod
    async def set_user_setting(self, user_id: int, key: str, json_value: str, now: Any) -> None:
        """Upsert a single user setting (json_value is a serialised JSON string)."""
        pass

    @abstractmethod
    async def get_user_favorites(self, user_id: int) -> list[int]:
        """Return the user's favorite node IDs as a list of ints."""
        pass

    @abstractmethod
    async def set_user_favorites(self, user_id: int, favorites: list[int], now: Any | None = None) -> None:
        """Persist the user's favorite node IDs."""
        pass

    @abstractmethod
    async def get_workspace_id_by_uuid(self, uuid: str) -> int | None:
        """Resolve a workspace UUID to its integer primary key."""
        pass

    @abstractmethod
    async def get_workspace_settings(self, workspace_id: int) -> dict:
        """Return all settings for a workspace as a key→value dict."""
        pass

    @abstractmethod
    async def set_workspace_setting(self, workspace_id: int, key: str, json_value: str, now: Any, user_id: int) -> None:
        """Upsert a single workspace setting (json_value is a serialised JSON string)."""
        pass

    @abstractmethod
    async def remove_node_from_favorites(self, node_id: int) -> None:
        """Remove a node ID from all users' favorites lists."""
        pass


class InviteRepository(ABC):
    """Repository interface for pending-invite acceptance operations."""

    @abstractmethod
    async def get_pending_invite(self, token: str) -> Any | None:
        """Get an active pending invite by its UUID token."""
        pass

    @abstractmethod
    async def expire_invite(self, invite_id: int) -> None:
        """Mark a pending invite as inactive."""
        pass

    @abstractmethod
    async def apply_invite_shares(
        self,
        invite: Any,
        user_id: int,
    ) -> None:
        """Create workspace/node shares from an invite in a single transaction."""
        pass


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


class TaskRecurrenceRepository(ABC):
    """Repository interface for task recurrence rules."""

    @abstractmethod
    async def get_by_task(self, task_node_id: int) -> TaskRecurrence | None:
        """Get the recurrence rule for a task node."""
        pass

    @abstractmethod
    async def upsert(self, data: TaskRecurrence) -> TaskRecurrence:
        """Create or update a recurrence rule for a task node."""
        pass

    @abstractmethod
    async def delete(self, task_node_id: int) -> bool:
        """Delete the recurrence rule for a task node. Returns True if deleted."""
        pass


class TaskCompletionRepository(ABC):
    """Repository interface for task completion history."""

    @abstractmethod
    async def list_by_task(
        self, task_node_id: int, limit: int = 50, offset: int = 0
    ) -> list[TaskCompletion]:
        """List completion records for a task node, newest first."""
        pass

    @abstractmethod
    async def create(self, completion: TaskCompletion) -> TaskCompletion:
        """Record a new task completion."""
        pass

    @abstractmethod
    async def count_by_task(self, task_node_id: int) -> int:
        """Count total completions for a task node."""
        pass

    @abstractmethod
    async def delete(self, completion_id: int) -> bool:
        """Delete a completion record. Returns True if deleted."""
        pass
