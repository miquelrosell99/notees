"""Property domain entities.

Properties define the schema for node metadata.
New property system with separate tables for:
- property: Property definitions
- node_property: Assignment of properties to nodes
- property_value_scalar: Scalar values (integer, float, boolean)
- property_value_relation: Relation values (node references for node, text, image, date types)
- property_selection_line: Selection options for selection-type properties
- property_value_selection: Selection values

Property types and storage:
- Scalar types (stored in property_value_scalar): integer, float, boolean
- Relation types (stored in property_value_relation): node, text, image, date
  - text: Links to a node that acts as text content
  - image: Links to an asset node (always single value)
  - date: Links to a day page node (UUID = YYYYMMDD)
  - node: Generic node reference
- Selection type (stored in property_value_selection): selection

Text and Image are always single value (never multi).
Local properties have is_local=True and are unique per node_id (must be page type).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional, List, Any
from dataclasses import dataclass, field
from enum import Enum

from .node import generate_uuid, utc_now_iso


class PropertyType(str, Enum):
    """Types of properties."""
    # Scalar types - stored in property_value_scalar
    INTEGER = "integer"
    FLOAT = "float"
    BOOLEAN = "boolean"
    
    # Relation types - stored in property_value_relation
    NODE = "node"       # Reference to other nodes
    TEXT = "text"       # Links to a node that acts as text content (always single)
    IMAGE = "image"     # Links to an asset node (always single)
    DATE = "date"       # Links to a day page node (UUID = YYYYMMDD)
    
    # Selection type - stored in property_value_selection
    SELECTION = "selection"


# Property types that use scalar storage
SCALAR_TYPES = {PropertyType.INTEGER, PropertyType.FLOAT, PropertyType.BOOLEAN}

# Property types that use relation storage
RELATION_TYPES = {PropertyType.NODE, PropertyType.TEXT, PropertyType.IMAGE, PropertyType.DATE}

# Property types that are always single value (never multi)
ALWAYS_SINGLE_TYPES = {PropertyType.IMAGE}


@dataclass
class Property:
    """Domain entity representing a property definition.
    
    Properties can be:
    - Global: name must be unique across all properties
    - Local: is_local=True, name must be unique within the same node_id (page node)
    """
    id: Optional[int] = None
    uuid: str = field(default_factory=generate_uuid)
    name: str = ""
    icon: Optional[str] = None
    type: PropertyType = PropertyType.TEXT
    is_multi: bool = False  # Allow multiple values? (always False for text/image)
    is_system: bool = False  # System-defined vs user-defined
    is_local: bool = False  # Local properties are unique per node_id, not globally
    node_id: Optional[int] = None  # For local properties: the page node this belongs to
    icon_visibility: str = "hidden"  # Where to show selection value icon: 'hidden' | 'before_content' | 'after_bullet'
    create_date: str = field(default_factory=utc_now_iso)
    write_date: str = field(default_factory=utc_now_iso)
    
    # For node-type properties: class IDs that filter selectable nodes
    # Stored in property_class_filter table
    _class_filters: List[int] = field(default_factory=list, repr=False)
    
    # For selection-type properties: available options
    # Stored in property_selection_line table
    _selection_lines: List['PropertySelectionLine'] = field(default_factory=list, repr=False)
    
    def __post_init__(self):
        """Enforce constraints after initialization."""
        # Text and Image are always single value
        if self.type in ALWAYS_SINGLE_TYPES:
            self.is_multi = False
    
    @property
    def is_scalar(self) -> bool:
        """Check if this property uses scalar storage."""
        return self.type in SCALAR_TYPES
    
    @property
    def is_relation(self) -> bool:
        """Check if this property uses relation storage."""
        return self.type in RELATION_TYPES
    
    @property
    def is_selection(self) -> bool:
        """Check if this property uses selection storage."""
        return self.type == PropertyType.SELECTION


@dataclass
class PropertySelectionLine:
    """Option for a selection-type property.
    
    Selection lines cannot be deleted if they are used in property_value_selection.
    They are cascade-deleted when the parent property is deleted.
    """
    id: Optional[int] = None
    property_id: int = 0
    name: str = ""
    icon: Optional[str] = None
    order: int = 0
    create_date: str = field(default_factory=utc_now_iso)
    write_date: str = field(default_factory=utc_now_iso)


@dataclass
class PropertyClassFilter:
    """Links a property to class nodes that filter selectable nodes.
    
    Used for node-class properties to restrict which nodes can be selected.
    """
    id: Optional[int] = None
    property_id: int = 0
    class_node_id: int = 0  # The class node that filters


# Type alias for property values (used in NodeProperty)
PropertyValue = Any  # Union of PropertyValueScalar, PropertyValueRelation, PropertyValueSelection


@dataclass
class NodeProperty:
    """Assignment of a property to a node.
    
    This table only stores the assignment - the actual value is stored in
    property_value_scalar, property_value_relation, or property_value_selection.
    
    The property_type field and _values list are populated by the repository
    to enable helper methods for working with values.
    """
    id: Optional[int] = None
    uuid: str = field(default_factory=generate_uuid)
    node_id: int = 0
    property_id: int = 0
    create_date: str = field(default_factory=utc_now_iso)
    write_date: str = field(default_factory=utc_now_iso)
    create_uid: Optional[int] = None
    write_uid: Optional[int] = None
    
    # Populated by repository (not stored in node_property table)
    property_type: Optional[PropertyType] = field(default=None, repr=False)
    _values: List[Any] = field(default_factory=list, repr=False)
    
    @property
    def is_scalar(self) -> bool:
        """Check if this property uses scalar storage."""
        return self.property_type in SCALAR_TYPES if self.property_type else False
    
    @property
    def is_relation(self) -> bool:
        """Check if this property uses relation storage."""
        return self.property_type in RELATION_TYPES if self.property_type else False
    
    @property
    def is_selection(self) -> bool:
        """Check if this property uses selection storage."""
        return self.property_type == PropertyType.SELECTION if self.property_type else False
    
    def get_value_table(self) -> str:
        """Get the table name for storing values of this property type."""
        if self.property_type in SCALAR_TYPES:
            return "property_value_scalar"
        elif self.property_type in RELATION_TYPES:
            return "property_value_relation"
        elif self.property_type == PropertyType.SELECTION:
            return "property_value_selection"
        raise ValueError(f"Unknown property type: {self.property_type}")
    
    def get_values(self) -> List[Any]:
        """Get all values for this property assignment.
        
        Returns list of PropertyValueScalar, PropertyValueRelation, or PropertyValueSelection
        depending on property type. Values must be loaded by repository first.
        """
        return self._values
    
    def get_value(self) -> Optional[Any]:
        """Get the single value for non-multi properties.
        
        Returns the first value or None if no values exist.
        For multi properties, use get_values() instead.
        """
        return self._values[0] if self._values else None
    
    def set_values(self, values: List[Any]) -> None:
        """Set the values for this property assignment.
        
        Used by repository to populate values after loading.
        """
        self._values = values
    
    def clear_values(self) -> None:
        """Clear all values."""
        self._values = []


@dataclass
class PropertyValueScalar:
    """Scalar property value for a node.
    
    Used for integer, float, and boolean property types.
    For multi-value properties, multiple rows are created.
    
    Schema fields (property_value_scalar table):
    - node_property_id: Links to node_property
    - property_id: Computed from node_property
    - node_id: Computed from node_property
    - value_text: For any scalar stored as text (fallback)
    - value_boolean: For boolean type
    - value_float: For float type
    - value_integer: For integer type
    """
    id: Optional[int] = None
    uuid: str = field(default_factory=generate_uuid)
    node_property_id: int = 0
    property_id: int = 0  # Computed from node_property
    node_id: int = 0  # Computed from node_property
    value_text: Optional[str] = None
    value_boolean: Optional[bool] = None
    value_float: Optional[float] = None
    value_integer: Optional[int] = None
    create_date: str = field(default_factory=utc_now_iso)
    write_date: str = field(default_factory=utc_now_iso)
    create_uid: Optional[int] = None
    write_uid: Optional[int] = None
    
    def get_value(self, property_type: PropertyType) -> Any:
        """Get the value based on property type."""
        if property_type == PropertyType.INTEGER:
            return self.value_integer
        elif property_type == PropertyType.FLOAT:
            return self.value_float
        elif property_type == PropertyType.BOOLEAN:
            return self.value_boolean
        return self.value_text
    
    def set_value(self, property_type: PropertyType, value: Any) -> None:
        """Set the value based on property type."""
        # Clear all values first
        self.value_text = None
        self.value_boolean = None
        self.value_float = None
        self.value_integer = None
        
        if value is None:
            return
            
        if property_type == PropertyType.INTEGER:
            self.value_integer = int(value)
        elif property_type == PropertyType.FLOAT:
            self.value_float = float(value)
        elif property_type == PropertyType.BOOLEAN:
            self.value_boolean = bool(value)
        else:
            self.value_text = str(value)


@dataclass
class PropertyValueRelation:
    """Relation property value for a node.
    
    Used for node, text, image, and date property types.
    For multi-value properties, multiple rows are created.
    
    Schema fields (property_value_relation table):
    - node_property_id: Links to node_property
    - property_id: Computed from node_property
    - node_id: Computed from node_property
    - target_id: The referenced node (content node for text, asset for image, day page for date, any node for node)
    - property_type: Optional, for validation only (not stored in DB)
    """
    id: Optional[int] = None
    uuid: str = field(default_factory=generate_uuid)
    node_property_id: int = 0
    property_id: int = 0  # Computed from node_property
    node_id: int = 0  # Computed from node_property
    target_id: int = 0
    create_date: str = field(default_factory=utc_now_iso)
    write_date: str = field(default_factory=utc_now_iso)
    create_uid: Optional[int] = None
    write_uid: Optional[int] = None
    # Optional field for validation (not stored in DB)
    property_type: Optional[PropertyType] = field(default=None, repr=False)


@dataclass
class PropertyValueSelection:
    """Selection property value for a node.
    
    For multi-value selection properties, multiple rows are created.
    
    Schema fields (property_value_selection table):
    - node_property_id: Links to node_property
    - property_id: Computed from node_property
    - node_id: Computed from node_property
    - selection_line_id: The selected option from property_selection_line
    """
    id: Optional[int] = None
    uuid: str = field(default_factory=generate_uuid)
    node_property_id: int = 0
    property_id: int = 0  # Computed from node_property
    node_id: int = 0  # Computed from node_property
    selection_line_id: int = 0
    create_date: str = field(default_factory=utc_now_iso)
    write_date: str = field(default_factory=utc_now_iso)
    create_uid: Optional[int] = None
    write_uid: Optional[int] = None


@dataclass
class ClassProperty:
    """Links a class to properties it applies to nodes with that class.
    
    When a node gets a class, it automatically gets these properties
    with either the default value or empty.
    """
    id: Optional[int] = None
    class_node_id: int = 0  # The class node
    property_id: int = 0  # The property to apply
    sequence: int = 0  # Order of properties on the class
    hidden: bool = False  # Whether this property is hidden by default in the UI
    
    # Default values (polymorphic - only one is used based on property type)
    default_integer: Optional[int] = None
    default_float: Optional[float] = None
    default_text: Optional[str] = None
    default_boolean: Optional[bool] = None
    default_node_id: Optional[int] = None
    default_selection_id: Optional[int] = None


# Note: ClassExtend entity is now defined in class_extension_service.py
# as it's only used by that service for managing inheritance relationships
