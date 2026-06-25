"""Pydantic models for the Properties API."""

from typing import Any

from pydantic import BaseModel, model_validator

# ============== Response Models ==============


class ClassExtendsRequest(BaseModel):
    """Request body for adding a class extension (inheritance) relationship."""

    extends_class_node_uuid: str
    sequence: int = 0


class PropertyResponse(BaseModel):
    """Property response model."""

    id: int
    property_uuid: str
    uuid: str = ""  # Deprecated alias for property_uuid; kept for backwards compatibility
    name: str
    icon: str | None = None
    type: str
    multi: bool = False  # Aligned with frontend naming
    is_system: bool = False
    scope: str = "global"  # 'global' | 'class' | 'node'
    node_uuid: str | None = None  # For scoped properties
    icon_visibility: str = "hidden"  # 'hidden' | 'before_content' | 'after_bullet'
    validation_rules: dict | None = None  # Optional validation constraints
    create_date: str
    write_date: str
    # For relation-type properties
    class_filters: list[str] = []
    # For selection-type properties
    options: list["SelectionLineResponse"] = []  # Aligned with frontend naming

    @model_validator(mode="after")
    def _sync_uuid_alias(self):
        self.uuid = self.property_uuid
        return self


class SelectionLineResponse(BaseModel):
    """Selection line (option) response."""

    id: int
    selection_line_uuid: str
    uuid: str = ""  # Deprecated alias
    property_id: int
    property_uuid: str
    name: str
    icon: str | None = None
    color: str | None = None  # Hex or CSS color for the pill
    order: int = 0

    @model_validator(mode="after")
    def _sync_uuid_alias(self):
        self.uuid = self.selection_line_uuid
        return self


class NodePropertyResponse(BaseModel):
    """Node property assignment response."""

    id: int
    node_property_uuid: str
    uuid: str = ""  # Deprecated alias
    node_id: int
    node_uuid: str
    property_id: int
    property_uuid: str
    create_date: str
    write_date: str

    @model_validator(mode="after")
    def _sync_uuid_alias(self):
        self.uuid = self.node_property_uuid
        return self


class ScalarValueResponse(BaseModel):
    """Scalar value response."""

    id: int
    scalar_value_uuid: str
    uuid: str = ""  # Deprecated alias
    node_property_id: int
    node_property_uuid: str
    property_id: int
    property_uuid: str
    node_id: int
    node_uuid: str
    value_text: str | None = None
    value_boolean: bool | None = None
    value_float: float | None = None
    value_integer: int | None = None
    order: int = 0

    @model_validator(mode="after")
    def _sync_uuid_alias(self):
        self.uuid = self.scalar_value_uuid
        return self


class RelationValueResponse(BaseModel):
    """Relation value response."""

    id: int
    relation_value_uuid: str
    uuid: str = ""  # Deprecated alias
    node_property_id: int
    node_property_uuid: str
    property_id: int
    property_uuid: str
    node_id: int
    node_uuid: str
    target_node_id: int
    target_node_uuid: str
    order: int = 0

    @model_validator(mode="after")
    def _sync_uuid_alias(self):
        self.uuid = self.relation_value_uuid
        return self


class SelectionValueResponse(BaseModel):
    """Selection value response."""

    id: int
    selection_value_uuid: str
    uuid: str = ""  # Deprecated alias
    node_property_id: int
    node_property_uuid: str
    property_id: int
    property_uuid: str
    node_id: int
    node_uuid: str
    selection_line_id: int
    selection_line_uuid: str
    order: int = 0

    @model_validator(mode="after")
    def _sync_uuid_alias(self):
        self.uuid = self.selection_value_uuid
        return self


class ClassFilterResponse(BaseModel):
    """Class filter response."""

    id: int
    class_filter_uuid: str
    property_id: int
    class_node_id: int
    class_node_uuid: str


class ClassPropertyResponse(BaseModel):
    """Class property response."""

    id: int
    class_property_uuid: str
    class_node_id: int
    class_node_uuid: str
    class_node_name: str
    property_id: int
    property_uuid: str
    property_name: str
    property_type: str
    sequence: int = 0
    default_value: Any | None = None
    hidden: bool = False
    required: bool = False  # Whether this property is required for nodes of this class


class ClassExtendsResponse(BaseModel):
    """Class inheritance (extends) response."""

    id: int
    class_extend_uuid: str
    class_node_id: int
    class_node_uuid: str
    class_node_name: str
    extends_class_node_id: int
    extends_class_node_uuid: str
    extends_class_node_name: str
    extends_class_icon: str | None = None
    sequence: int = 0


# ============== Request Models ==============


class PropertyCreateRequest(BaseModel):
    """Request to create a property."""

    name: str
    icon: str | None = None
    type: str = "text"  # integer, float, boolean, url, email, date_range (scalar) | node, text, image, date (relation) | selection
    is_multi: bool = False
    scope: str = "global"  # 'global' | 'class' | 'node'
    node_uuid: str | None = None  # For scoped properties (class or node)
    # For relation-type: which classes filter selectable nodes
    class_filters: list[str] = []
    # For selection-type: initial options
    selection_lines: list[str] = []
    # Optional validation rules: {min?, max?, pattern?, required?, min_date?, max_date?}
    validation_rules: dict | None = None


class PropertyUpdateRequest(BaseModel):
    """Request to update a property."""

    name: str | None = None
    icon: str | None = None
    multi: bool | None = None  # Aligned with frontend naming
    icon_visibility: str | None = None  # 'hidden' | 'before_content' | 'after_bullet'
    validation_rules: dict | None = None  # Optional validation constraints


class PropertyTypeChangeRequest(BaseModel):
    """Request to change a property's type."""

    new_type: str
    new_is_multi: bool | None = None


class SelectionLineRequest(BaseModel):
    """Request to add/update a selection line."""

    name: str
    icon: str | None = None
    color: str | None = None  # Hex or CSS color for the pill
    order: int = 0


class SelectionLineUpdateRequest(BaseModel):
    """Request to update a selection line."""

    name: str | None = None
    icon: str | None = None
    color: str | None = None  # Hex or CSS color for the pill
    order: int | None = None


class ScalarValueRequest(BaseModel):
    """Request to set a scalar value."""

    value: Any
    order: int = 0


class RelationValueRequest(BaseModel):
    """Request to set a relation value."""

    target_node_uuid: str
    target_node_id: int | None = None  # Backwards compatibility during migration
    order: int = 0


class SelectionValueRequest(BaseModel):
    """Request to set a selection value."""

    selection_line_uuid: str
    selection_line_id: int | None = None  # Backwards compatibility during migration
    order: int = 0


class ClassPropertyRequest(BaseModel):
    """Request to link a property to a class."""

    property_id: int | None = None  # Backwards compatibility during migration
    property_uuid: str | None = None  # Preferred public identifier
    sequence: int = 0
    default_value: Any | None = None
    required: bool = False
    hidden: bool = False


class ClassPropertyUpdateRequest(BaseModel):
    """Request to update a class property binding (required, hidden, default)."""

    required: bool | None = None
    hidden: bool | None = None
    default_value: Any | None = None
