"""Repository interfaces (ports) for domain entities."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional, List, Any, TYPE_CHECKING

if TYPE_CHECKING:
    from ..entities import Node, NodeCreateData, NodeUpdateData
    from ..entities import (
        Property, PropertyType, PropertySelectionLine,
        PropertyTypeFilter, TypeProperty, TypeExtends,
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
    async def get_by_uuid(self, uuid: str) -> Optional[Node]:
        """Get node by UUID."""
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
    def get_connection(self) -> Any:
        """Get the underlying database connection.
        
        This is needed for raw SQL queries that aren't abstracted by the repository.
        Returns the connection object (e.g., aiosqlite.Connection).
        """
        pass
    
    @abstractmethod
    def row_to_node(self, row: Any) -> Node:
        """Convert a database row to a Node entity.
        
        This is useful when executing raw SQL queries that return node rows.
        """
        pass


class PropertyRepository(ABC):
    """Repository interface for Property operations.
    
    New property system with:
    - property: Property definitions (with local property support)
    - node_property: Assignment of properties to nodes
    - property_value_scalar: Scalar values (integer, float, boolean)
    - property_value_relation: Relation values (node, text, image, date)
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
    async def set_scalar_value(self, node_id: int, property_id: int, value: Any, order: int = 0) -> PropertyValueScalar:
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
    async def set_relation_value(self, node_id: int, property_id: int, target_node_id: int, order: int = 0) -> PropertyValueRelation:
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
    async def add_selection_line(self, property_id: int, name: str, icon: Optional[str] = None, order: int = 0) -> PropertySelectionLine:
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
    async def set_selection_value(self, node_id: int, property_id: int, selection_line_id: int, order: int = 0) -> PropertyValueSelection:
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
    
    # ============== Type Filters ==============
    
    @abstractmethod
    async def add_type_filter(self, property_id: int, type_node_id: int) -> PropertyTypeFilter:
        """Add a type filter to a relation-type property."""
        pass
    
    @abstractmethod
    async def get_type_filters(self, property_id: int) -> List[int]:
        """Get all type filter node IDs for a property."""
        pass
    
    @abstractmethod
    async def remove_type_filter(self, property_id: int, type_node_id: int) -> bool:
        """Remove a type filter from a property."""
        pass
    
    # ============== Unified Value Access ==============
    
    @abstractmethod
    async def get_all_property_values(self, node_id: int) -> dict[int, dict[str, Any]]:
        """Get all property values for a node, grouped by property_id."""
        pass
    
    @abstractmethod
    async def clear_all_property_values(self, node_id: int, property_id: int) -> None:
        """Clear all values for a property on a node (but keep the assignment)."""
        pass
    
    # ============== Type Properties ==============
    
    @abstractmethod
    async def get_type_properties(self, type_node_id: int) -> List[TypeProperty]:
        """Get properties that a type applies to typed nodes."""
        pass
    
    @abstractmethod
    async def add_type_property(self, type_node_id: int, property_id: int,
                                 sequence: int = 0, default_value: Any = None) -> TypeProperty:
        """Link a property to a type/class."""
        pass
    
    @abstractmethod
    async def remove_type_property(self, type_node_id: int, property_id: int) -> bool:
        """Remove a property from a type/class."""
        pass
    
    @abstractmethod
    async def get_all_inherited_properties(self, type_node_id: int) -> List[TypeProperty]:
        """Get all properties for a type including inherited ones."""
        pass


class LinkRepository(ABC):
    """Repository interface for NodeLink operations."""
    
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
    def get_connection(self) -> Any:
        """Get the underlying database connection.
        
        This is needed for raw SQL queries that aren't abstracted by the repository.
        Returns the connection object (e.g., aiosqlite.Connection).
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
