"""Repository interfaces (ports) for domain entities."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..entities import (
        ClassExtend,
        ClassProperty,
        Node,
        NodeCreateData,
        NodeLink,
        NodeProperty,
        NodeUpdateData,
        Property,
        PropertyClassFilter,
        PropertySelectionLine,
        PropertyType,
        PropertyValueRelation,
        PropertyValueScalar,
        PropertyValueSelection,
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
    async def get_children(self, parent_id: int) -> list[Node]:
        """Get direct children of a node."""
        pass

    @abstractmethod
    async def get_all_pages(self) -> list[Node]:
        """Get all nodes tagged as 'page'."""
        pass

    @abstractmethod
    async def get_page_content(self, page_id: int) -> list[Node]:
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
    async def node_exists(self, node_id: int) -> bool:
        """Check if a node exists in this workspace."""
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
    async def get_typed_with(self, type_node_id: int) -> list[Node]:
        """Get all nodes with a specific type."""
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
    async def get_nodes_with_classes(self, class_ids: list[int]) -> list[Node]:
        """Get all nodes that have any of the given class IDs in their class_ids array."""
        pass

    @abstractmethod
    async def get_inline_class_ids(self, node_id: int) -> list[int]:
        """Get inline class IDs (from node_link with is_inline_class=TRUE) for a node."""
        pass

    @abstractmethod
    async def find_node_id_by_uuid(self, uuid: str) -> int | None:
        """Find a node ID by UUID in this workspace."""
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
        """Get target IDs of text links (non-tag, non-inline-class) from a source node."""
        pass

    @abstractmethod
    async def get_tag_link_targets(self, source_node_id: int) -> list[int]:
        """Get target IDs of tag links from a source node."""
        pass

    @abstractmethod
    async def delete_non_tag_text_links(self, source_node_id: int) -> int:
        """Delete all non-tag, non-inline-class text links from a source node.

        Returns the number of links deleted.
        """
        pass

    @abstractmethod
    async def ensure_tag_link(self, source_node_id: int, target_id: int) -> bool:
        """Ensure a tag link exists between source and target.

        If a text link already exists, upgrades it to a tag link.
        Returns True if a link now exists (created or upgraded).
        """
        pass

    @abstractmethod
    async def clear_tag_link(self, source_node_id: int, target_id: int) -> bool:
        """Remove the tag flag from a link between source and target.

        Returns True if the link was updated.
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


class UserRepository(ABC):
    """Repository interface for User operations."""

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
    async def get_by_username(self, username: str) -> User | None:
        """Get user by username."""
        pass

    @abstractmethod
    async def update_password(self, user_id: int, password_hash: str) -> bool:
        """Update user password."""
        pass

    @abstractmethod
    async def deactivate(self, user_id: int) -> bool:
        """Deactivate a user."""
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
        self, node_id: int, action: str, details: str | None, target_node_id: int | None, now: Any
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


class SettingsRepository(ABC):
    """Repository interface for user and workspace settings."""

    @abstractmethod
    async def get_user_settings(self, user_id: int) -> dict:
        """Return all settings for a user as a key→value dict."""
        pass

    @abstractmethod
    async def set_user_setting(self, user_id: int, key: str, json_value: str, now: Any) -> None:
        """Upsert a single user setting (json_value is a serialised JSON string)."""
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
