"""Repository interfaces (ports) for domain entities."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional, List, Any, TYPE_CHECKING

if TYPE_CHECKING:
    from ..entities import Node, NodeCreateData, NodeUpdateData
    from ..entities import (
        Property, PropertyType, PropertySelectionLine,
        PropertyClassFilter, ClassProperty,
        NodeProperty, PropertyValueScalar, PropertyValueRelation, PropertyValueSelection,
    )
    from ..entities import NodeLink
    from ..entities import User, UserCreateData


class NodeRepository(ABC):
    """Repository interface for Node operations."""
    
    @abstractmethod
    async def create(self, data: NodeCreateData, user_id: Optional[int] = None) -> Node:
        """Create a new node."""
        pass
    
    @abstractmethod
    async def get_by_id(self, node_id: int) -> Optional[Node]:
        """Get node by internal ID."""
        pass
    
    @abstractmethod
    async def get_by_ids(self, node_ids: List[int]) -> List[Node]:
        """Get multiple nodes by internal IDs in a single query.
        
        Returns nodes in no particular order. Missing/inaccessible IDs are silently skipped.
        """
        pass
    
    @abstractmethod
    async def get_by_uuid(self, uuid: str) -> Optional[Node]:
        """Get node by UUID."""
        pass

    @abstractmethod
    async def get_by_uuids(self, uuids: List[str]) -> List[Node]:
        """Get multiple nodes by UUID in a single query.

        Returns nodes in no particular order. Missing/inaccessible UUIDs are silently skipped.
        """
        pass
    
    @abstractmethod
    async def update(self, node_id: int, data: NodeUpdateData, user_id: Optional[int] = None) -> Optional[Node]:
        """Update a node."""
        pass
    
    @abstractmethod
    async def delete(self, node_id: int) -> bool:
        """Delete a node and all its children."""
        pass
    
    @abstractmethod
    async def get_children(self, parent_id: int) -> List[Node]:
        """Get direct children of a node."""
        pass
    
    @abstractmethod
    async def get_all_pages(self) -> List[Node]:
        """Get all nodes tagged as 'page'."""
        pass
    
    @abstractmethod
    async def get_page_content(self, page_id: int) -> List[Node]:
        """Get all nodes belonging to a page (recursive children)."""
        pass
    
    @abstractmethod
    async def search(self, query: str, limit: int = 50) -> List[Node]:
        """Search nodes by name."""
        pass
    
    @abstractmethod
    async def get_typed_with(self, type_node_id: int) -> List[Node]:
        """Get all nodes with a specific type."""
        pass
    
    @abstractmethod
    async def set_active(self, node_id: int, active: bool, user_id: Optional[int] = None) -> Optional[Node]:
        """Set the active status of a node (archive/unarchive)."""
        pass
    
    @abstractmethod
    async def get_archived_pages(self) -> List[Node]:
        """Get all archived pages."""
        pass
    
    @abstractmethod
    async def move(
        self,
        node_id: int,
        new_parent_id: Optional[int] = None,
        new_sequence: Optional[int] = None,
        user_id: Optional[int] = None
    ) -> Optional[Node]:
        """Move a node to a new parent and/or sequence position.
        
        Handles sibling resequencing to maintain order consistency.
        """
        pass
    
    @abstractmethod
    def get_connection(self) -> Any:
        """Get the underlying database connection pool.
        
        This is needed for raw SQL queries that aren't abstracted by the repository.
        Returns the pool object (e.g., asyncpg.Pool).
        """
        pass
    
    @abstractmethod
    def row_to_node(self, row: Any) -> Node:
        """Convert a database row to a Node entity.
        
        This is useful when executing raw SQL queries that return node rows.
        """
        pass
    
    @abstractmethod
    async def get_breadcrumbs(
        self,
        exit_node_id: int,
        enter_node_id: Optional[int] = None
    ) -> List[Node]:
        """Get the breadcrumb path for a node using the closure table.
        
        Returns ordered list of ancestor nodes from root (or enter_node) down to exit_node.
        Uses the node_path closure table for efficient O(1) ancestor lookup.
        
        Args:
            exit_node_id: The node to get breadcrumbs for
            enter_node_id: Optional starting ancestor (if None, starts from root)
            
        Returns:
            List of Node entities ordered from root/enter_node to exit_node
        """
        pass
    
    @abstractmethod
    async def get_ancestors(
        self,
        node_id: int,
        include_self: bool = False
    ) -> List[int]:
        """Get all ancestor IDs of a node using the closure table.
        
        Uses the node_path closure table for efficient O(1) lookup.
        
        Args:
            node_id: The node to get ancestors for
            include_self: Whether to include the node itself in the result
            
        Returns:
            List of ancestor node IDs (ordered from root to immediate parent)
        """
        pass
    
    @abstractmethod
    async def get_descendants(
        self,
        node_id: int,
        include_self: bool = False
    ) -> List[int]:
        """Get all descendant IDs of a node using the closure table.
        
        Uses the node_path closure table for efficient O(1) lookup.
        
        Args:
            node_id: The node to get descendants for
            include_self: Whether to include the node itself in the result
            
        Returns:
            List of descendant node IDs
        """
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
    async def get_by_id(self, property_id: int) -> Optional[Property]:
        """Get property by ID with type filters and selection lines."""
        pass
    
    @abstractmethod
    async def get_by_uuid(self, uuid: str) -> Optional[Property]:
        """Get property by UUID."""
        pass
    
    @abstractmethod
    async def get_by_name(self, name: str, node_id: Optional[int] = None) -> Optional[Property]:
        """Get property by name. For local properties, node_id specifies the page context."""
        pass
    
    @abstractmethod
    async def get_all(self, include_local: bool = True) -> List[Property]:
        """Get all property definitions."""
        pass
    
    @abstractmethod
    async def get_local_properties(self, node_id: int) -> List[Property]:
        """Get all local properties for a specific page node."""
        pass
    
    @abstractmethod
    async def update(self, property_id: int, name: Optional[str] = None, 
                     icon: Optional[str] = None) -> Optional[Property]:
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
    async def change_property_type(self, property_id: int, new_type: PropertyType,
                                    new_is_multi: Optional[bool] = None) -> Optional[Property]:
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
    async def get_node_property(self, node_id: int, property_id: int) -> Optional[NodeProperty]:
        """Get a node_property assignment."""
        pass
    
    @abstractmethod
    async def get_node_properties(self, node_id: int) -> List[NodeProperty]:
        """Get all property assignments for a node."""
        pass
    
    @abstractmethod
    async def remove_property_from_node(self, node_id: int, property_id: int) -> bool:
        """Remove a property assignment from a node."""
        pass
    
    @abstractmethod
    async def get_node_ids_with_property(self, property_id: int) -> List[int]:
        """Get all node IDs that have a specific property assigned."""
        pass
    
    # ============== Scalar Values ==============
    
    @abstractmethod
    async def set_scalar_value(self, node_id: int, property_id: int, value: Any) -> PropertyValueScalar:
        """Set a scalar property value for a node."""
        pass
    
    @abstractmethod
    async def get_scalar_values(self, node_id: int, property_id: int) -> List[PropertyValueScalar]:
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
    async def get_relation_values(self, node_id: int, property_id: int) -> List[PropertyValueRelation]:
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
    
    # ============== Selection Lines (Options) ==============
    
    @abstractmethod
    async def add_selection_line(self, property_id: int, name: str, icon: Optional[str] = None, sequence: int = 0) -> PropertySelectionLine:
        """Add an option to a selection-type property."""
        pass
    
    @abstractmethod
    async def get_selection_lines(self, property_id: int) -> List[PropertySelectionLine]:
        """Get all selection options for a property."""
        pass
    
    @abstractmethod
    async def update_selection_line(self, line_id: int, name: Optional[str] = None,
                                     icon: Optional[str] = None, order: Optional[int] = None) -> Optional[PropertySelectionLine]:
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
    async def set_selection_value(self, node_id: int, property_id: int, selection_line_id: int) -> PropertyValueSelection:
        """Set a selection property value for a node."""
        pass
    
    @abstractmethod
    async def get_selection_values(self, node_id: int, property_id: int) -> List[PropertyValueSelection]:
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
    async def get_class_filters(self, property_id: int) -> List[int]:
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
    async def get_all_property_values_batch(self, node_ids: List[int]) -> dict[int, dict[int, dict[str, Any]]]:
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
    async def get_class_properties(self, class_node_id: int) -> List[ClassProperty]:
        """Get properties that a class applies to classed nodes."""
        pass
    
    @abstractmethod
    async def add_class_property(self, class_node_id: int, property_id: int,
                                 sequence: int = 0, default_value: Any = None) -> ClassProperty:
        """Link a property to a class."""
        pass
    
    @abstractmethod
    async def remove_class_property(self, class_node_id: int, property_id: int) -> bool:
        """Remove a property from a class."""
        pass
    
    @abstractmethod
    async def get_all_inherited_properties(self, class_node_id: int) -> List[ClassProperty]:
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
    async def get_backlinks(self, target_node_id: int) -> List[NodeLink]:
        """Get all links pointing to a target node."""
        pass
    
    @abstractmethod
    async def get_page_backlinks(self, page_id: int) -> List[NodeLink]:
        """Get page-type backlinks (with inheritance)."""
        pass
    
    @abstractmethod
    async def get_outgoing_links(self, source_node_id: int) -> List[NodeLink]:
        """Get all links from a source node."""
        pass
    
    @abstractmethod
    async def delete_source_inline_classes(self, source_node_id: int) -> int:
        """Delete all inline class links from a source node (for re-parsing)."""
        pass
    
    @abstractmethod
    async def get_inline_class_references(self, target_node_id: int) -> List[NodeLink]:
        """Get all inline class links pointing to a target node."""
        pass
    
    @abstractmethod
    def get_connection(self) -> Any:
        """Get the underlying database connection pool.
        
        This is needed for raw SQL queries that aren't abstracted by the repository.
        Returns the pool object (e.g., asyncpg.Pool).
        """
        pass


class UserRepository(ABC):
    """Repository interface for User operations."""
    
    @abstractmethod
    async def create(self, data: UserCreateData, password_hash: str) -> User:
        """Create a new user."""
        pass
    
    @abstractmethod
    async def get_by_id(self, user_id: int) -> Optional[User]:
        """Get user by ID."""
        pass
    
    @abstractmethod
    async def get_by_uuid(self, uuid: str) -> Optional[User]:
        """Get user by UUID."""
        pass
    
    @abstractmethod
    async def get_by_username(self, username: str) -> Optional[User]:
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
