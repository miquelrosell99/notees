"""Pydantic models for the Properties API."""
from typing import Optional, List, Any
from pydantic import BaseModel


# ============== Response Models ==============

class PropertyResponse(BaseModel):
    """Property response model."""
    id: int
    uuid: str
    name: str
    icon: Optional[str] = None
    type: str
    multi: bool = False  # Aligned with frontend naming
    is_system: bool = False
    is_local: bool = False   # Backward compat: True when scope != 'global'
    scope: str = 'global'    # 'global' | 'class' | 'node'
    node_id: Optional[int] = None  # For scoped properties
    icon_visibility: str = "hidden"  # 'hidden' | 'before_content' | 'after_bullet'
    create_date: str
    write_date: str
    # For relation-type properties
    class_filters: List[int] = []
    # For selection-type properties
    options: List["SelectionLineResponse"] = []  # Aligned with frontend naming


class SelectionLineResponse(BaseModel):
    """Selection line (option) response."""
    id: int
    property_id: int
    name: str
    icon: Optional[str] = None
    order: int = 0


class NodePropertyResponse(BaseModel):
    """Node property assignment response."""
    id: int
    node_id: int
    property_id: int
    create_date: str
    write_date: str


class ScalarValueResponse(BaseModel):
    """Scalar value response."""
    id: int
    node_property_id: int
    property_id: int
    node_id: int
    value_text: Optional[str] = None
    value_boolean: Optional[bool] = None
    value_float: Optional[float] = None
    value_integer: Optional[int] = None
    order: int = 0


class RelationValueResponse(BaseModel):
    """Relation value response."""
    id: int
    node_property_id: int
    property_id: int
    node_id: int
    target_node_id: int
    order: int = 0


class SelectionValueResponse(BaseModel):
    """Selection value response."""
    id: int
    node_property_id: int
    property_id: int
    node_id: int
    selection_line_id: int
    order: int = 0


class ClassPropertyResponse(BaseModel):
    """Class property response."""
    id: int
    class_node_id: int
    class_node_name: str
    property_id: int
    property_name: str
    property_type: str
    sequence: int = 0
    default_value: Optional[Any] = None
    hidden: bool = False


class ClassExtendsResponse(BaseModel):
    """Class inheritance (extends) response."""
    id: int
    class_node_id: int
    class_node_name: str
    extends_class_node_id: int
    extends_class_node_name: str
    extends_class_icon: Optional[str] = None
    sequence: int = 0


# ============== Request Models ==============

class PropertyCreateRequest(BaseModel):
    """Request to create a property."""
    name: str
    icon: Optional[str] = None
    type: str = "text"  # integer, float, boolean (scalar) | node, text, image, date (relation) | selection
    is_multi: bool = False
    scope: str = "global"       # 'global' | 'class' | 'node'
    is_local: bool = False      # Backward compat — overridden by scope if scope is set
    node_id: Optional[int] = None  # For scoped properties (class or node)
    # For relation-type: which classes filter selectable nodes
    class_filters: List[int] = []
    # For selection-type: initial options
    selection_lines: List[str] = []


class PropertyUpdateRequest(BaseModel):
    """Request to update a property."""
    name: Optional[str] = None
    icon: Optional[str] = None
    multi: Optional[bool] = None  # Aligned with frontend naming
    icon_visibility: Optional[str] = None  # 'hidden' | 'before_content' | 'after_bullet'


class PropertyTypeChangeRequest(BaseModel):
    """Request to change a property's type."""
    new_type: str
    new_is_multi: Optional[bool] = None


class SelectionLineRequest(BaseModel):
    """Request to add/update a selection line."""
    name: str
    icon: Optional[str] = None
    order: int = 0


class SelectionLineUpdateRequest(BaseModel):
    """Request to update a selection line."""
    name: Optional[str] = None
    icon: Optional[str] = None
    order: Optional[int] = None


class ScalarValueRequest(BaseModel):
    """Request to set a scalar value."""
    value: Any
    order: int = 0


class RelationValueRequest(BaseModel):
    """Request to set a relation value."""
    target_node_id: int
    order: int = 0


class SelectionValueRequest(BaseModel):
    """Request to set a selection value."""
    selection_line_id: int
    order: int = 0


class ClassPropertyRequest(BaseModel):
    """Request to link a property to a class."""
    property_id: int
    sequence: int = 0
    default_value: Optional[Any] = None


class ClassExtendsRequest(BaseModel):
    """Request to add a class extension (inheritance)."""
    extends_class_node_id: int
    sequence: int = 0
