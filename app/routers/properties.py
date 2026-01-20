"""Properties router - managing property definitions and values.

New property system with:
- property: Property definitions (with local property support)
- node_property: Assignment of properties to nodes  
- property_value_scalar: Scalar values (integer, float, boolean)
- property_value_relation: Relation values (node, text, image, date)
- property_selection_line: Selection options
- property_value_selection: Selection values

Property types:
- Scalar: integer, float, boolean
- Relation: node, text, image, date (text/image are always single value)
- Selection: selection (with custom options)
"""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, List, Any

from ..domain.entities import (
    Property, PropertyType, PropertySelectionLine,
    NodeProperty, PropertyValueScalar, PropertyValueRelation, PropertyValueSelection,
    SCALAR_TYPES, RELATION_TYPES, ALWAYS_SINGLE_TYPES,
)
from ..domain.repositories import SQLitePropertyRepository
from .auth import get_current_user
from ..models import User


router = APIRouter(prefix="/api/properties", tags=["Properties"])


# ============== Pydantic Models ==============

class PropertyResponse(BaseModel):
    """Property response model."""
    id: int
    uuid: str
    name: str
    icon: Optional[str] = None
    type: str
    is_multi: bool = False
    is_system: bool = False
    is_local: bool = False
    node_id: Optional[int] = None  # For local properties
    create_date: str
    write_date: str
    # For relation-type properties
    type_filters: List[int] = []
    # For selection-type properties
    selection_lines: List["SelectionLineResponse"] = []


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


class TypePropertyResponse(BaseModel):
    """Type/class property response."""
    id: int
    type_node_id: int
    type_node_name: str
    property_id: int
    property_name: str
    property_type: str
    sequence: int = 0
    default_value: Optional[Any] = None
    hidden: bool = False


class TypeExtendsResponse(BaseModel):
    """Type inheritance (extends) response."""
    id: int
    type_node_id: int
    type_node_name: str
    extends_type_node_id: int
    extends_type_node_name: str
    sequence: int = 0


class PropertyCreateRequest(BaseModel):
    """Request to create a property."""
    name: str
    icon: Optional[str] = None
    type: str = "text"  # integer, float, boolean (scalar) | node, text, image, date (relation) | selection
    is_multi: bool = False
    is_local: bool = False
    node_id: Optional[int] = None  # For local properties (must be a page node)
    # For relation-type: which types filter selectable nodes
    type_filters: List[int] = []
    # For selection-type: initial options
    selection_lines: List[str] = []


class PropertyUpdateRequest(BaseModel):
    """Request to update a property."""
    name: Optional[str] = None
    icon: Optional[str] = None


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


class TypePropertyRequest(BaseModel):
    """Request to link a property to a type/class."""
    property_id: int
    sequence: int = 0
    default_value: Optional[Any] = None


class TypeExtendsRequest(BaseModel):
    """Request to add a type extension (inheritance)."""
    extends_type_node_id: int
    sequence: int = 0


# ============== Helper Functions ==============

async def _get_property_repo(user: User) -> SQLitePropertyRepository:
    """Get PropertyRepository for user's database."""
    from ..db.connection import get_db
    
    db = await get_db(user.id)
    return SQLitePropertyRepository(db)


def _property_to_response(prop: Property) -> PropertyResponse:
    """Convert domain Property to API response."""
    return PropertyResponse(
        id=prop.id,
        uuid=prop.uuid,
        name=prop.name,
        icon=prop.icon,
        type=prop.type.value,
        is_multi=prop.is_multi,
        is_system=prop.is_system,
        is_local=prop.is_local,
        node_id=prop.node_id,
        create_date=prop.create_date,
        write_date=prop.write_date,
        type_filters=prop._type_filters,
        selection_lines=[
            SelectionLineResponse(
                id=l.id,
                property_id=l.property_id,
                name=l.name,
                icon=l.icon,
                order=l.order,
            )
            for l in prop._selection_lines
        ],
    )


def _scalar_value_to_response(val: PropertyValueScalar) -> ScalarValueResponse:
    """Convert scalar value to API response."""
    return ScalarValueResponse(
        id=val.id,
        node_property_id=val.node_property_id,
        property_id=val.property_id,
        node_id=val.node_id,
        value_text=val.value_text,
        value_boolean=val.value_boolean,
        value_float=val.value_float,
        value_integer=val.value_integer,
        order=val.order,
    )


def _relation_value_to_response(val: PropertyValueRelation) -> RelationValueResponse:
    """Convert relation value to API response."""
    return RelationValueResponse(
        id=val.id,
        node_property_id=val.node_property_id,
        property_id=val.property_id,
        node_id=val.node_id,
        target_node_id=val.target_node_id,
        order=val.order,
    )


def _selection_value_to_response(val: PropertyValueSelection) -> SelectionValueResponse:
    """Convert selection value to API response."""
    return SelectionValueResponse(
        id=val.id,
        node_property_id=val.node_property_id,
        property_id=val.property_id,
        node_id=val.node_id,
        selection_line_id=val.selection_line_id,
        order=val.order,
    )


# ============== Property CRUD Endpoints ==============

@router.get("")
async def list_properties(
    include_local: bool = True,
    user: User = Depends(get_current_user),
):
    """List all property definitions."""
    repo = await _get_property_repo(user)
    
    properties = await repo.get_all(include_local=include_local)
    return {"properties": [_property_to_response(p) for p in properties]}


@router.get("/local/{node_id}")
async def list_local_properties(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """List all local properties for a specific page node."""
    repo = await _get_property_repo(user)
    
    properties = await repo.get_local_properties(node_id)
    return {"properties": [_property_to_response(p) for p in properties]}


@router.post("")
async def create_property(
    request: PropertyCreateRequest,
    user: User = Depends(get_current_user),
):
    """Create a new property definition."""
    repo = await _get_property_repo(user)
    
    # Validate type
    try:
        prop_type = PropertyType(request.type)
    except ValueError:
        raise HTTPException(400, f"Invalid property type: {request.type}")
    
    # Check for duplicate name (for non-local properties)
    if not request.is_local:
        existing = await repo.get_by_name(request.name)
        if existing:
            raise HTTPException(409, f"Property '{request.name}' already exists")
    
    prop = Property(
        name=request.name,
        icon=request.icon,
        type=prop_type,
        is_multi=request.is_multi,
        is_local=request.is_local,
        node_id=request.node_id,
    )
    
    try:
        created = await repo.create(prop)
    except ValueError as e:
        raise HTTPException(400, str(e))
    
    # Add type filters for relation-type properties
    if prop_type in RELATION_TYPES:
        for type_id in request.type_filters:
            await repo.add_type_filter(created.id, type_id)
    
    # Add selection lines for selection-type properties
    if prop_type == PropertyType.SELECTION:
        for seq, line_name in enumerate(request.selection_lines):
            await repo.add_selection_line(created.id, line_name, order=seq)
    
    # Reload to get full data
    created = await repo.get_by_id(created.id)
    return _property_to_response(created)


@router.get("/{property_id}")
async def get_property(
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Get a property definition by ID."""
    repo = await _get_property_repo(user)
    
    prop = await repo.get_by_id(property_id)
    if not prop:
        raise HTTPException(404, "Property not found")
    
    return _property_to_response(prop)


@router.put("/{property_id}")
async def update_property(
    property_id: int,
    request: PropertyUpdateRequest,
    user: User = Depends(get_current_user),
):
    """Update a property definition (name and icon only)."""
    repo = await _get_property_repo(user)
    
    try:
        prop = await repo.update(property_id, name=request.name, icon=request.icon)
    except ValueError as e:
        raise HTTPException(400, str(e))
    
    if not prop:
        raise HTTPException(404, "Property not found")
    
    return _property_to_response(prop)


@router.post("/{property_id}/change-type")
async def change_property_type(
    property_id: int,
    request: PropertyTypeChangeRequest,
    user: User = Depends(get_current_user),
):
    """Change a property's type (only if no values exist)."""
    repo = await _get_property_repo(user)
    
    try:
        new_type = PropertyType(request.new_type)
    except ValueError:
        raise HTTPException(400, f"Invalid property type: {request.new_type}")
    
    # Check if can change
    can_change, reason = await repo.can_change_property_type(property_id, new_type)
    if not can_change:
        raise HTTPException(400, reason)
    
    try:
        prop = await repo.change_property_type(property_id, new_type, request.new_is_multi)
    except ValueError as e:
        raise HTTPException(400, str(e))
    
    if not prop:
        raise HTTPException(404, "Property not found")
    
    return _property_to_response(prop)


@router.get("/{property_id}/can-delete")
async def check_can_delete_property(
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Check if a property can be deleted."""
    repo = await _get_property_repo(user)
    
    can_delete, reason = await repo.can_delete_property(property_id)
    return {"can_delete": can_delete, "reason": reason}


@router.delete("/{property_id}")
async def delete_property(
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Delete a property definition (only if no values exist)."""
    repo = await _get_property_repo(user)
    
    try:
        success = await repo.delete(property_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    
    if not success:
        raise HTTPException(404, "Property not found")
    
    return {"status": "ok"}


# ============== Selection Lines ==============

@router.get("/{property_id}/selection-lines")
async def list_selection_lines(
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Get all selection lines (options) for a property."""
    repo = await _get_property_repo(user)
    
    prop = await repo.get_by_id(property_id)
    if not prop:
        raise HTTPException(404, "Property not found")
    
    if prop.type != PropertyType.SELECTION:
        raise HTTPException(400, "Property is not a selection type")
    
    lines = await repo.get_selection_lines(property_id)
    return {"selection_lines": [
        SelectionLineResponse(
            id=l.id,
            property_id=l.property_id,
            name=l.name,
            icon=l.icon,
            order=l.order,
        )
        for l in lines
    ]}


@router.post("/{property_id}/selection-lines")
async def add_selection_line(
    property_id: int,
    request: SelectionLineRequest,
    user: User = Depends(get_current_user),
):
    """Add a selection line (option) to a property."""
    repo = await _get_property_repo(user)
    
    try:
        line = await repo.add_selection_line(
            property_id,
            request.name,
            request.icon,
            request.order,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    
    return SelectionLineResponse(
        id=line.id,
        property_id=line.property_id,
        name=line.name,
        icon=line.icon,
        order=line.order,
    )


@router.put("/{property_id}/selection-lines/{line_id}")
async def update_selection_line(
    property_id: int,
    line_id: int,
    request: SelectionLineUpdateRequest,
    user: User = Depends(get_current_user),
):
    """Update a selection line."""
    repo = await _get_property_repo(user)
    
    line = await repo.update_selection_line(
        line_id,
        name=request.name,
        icon=request.icon,
        order=request.order,
    )
    
    if not line:
        raise HTTPException(404, "Selection line not found")
    
    return SelectionLineResponse(
        id=line.id,
        property_id=line.property_id,
        name=line.name,
        icon=line.icon,
        order=line.order,
    )


@router.get("/{property_id}/selection-lines/{line_id}/can-delete")
async def check_can_delete_selection_line(
    property_id: int,
    line_id: int,
    user: User = Depends(get_current_user),
):
    """Check if a selection line can be deleted."""
    repo = await _get_property_repo(user)
    
    can_delete, reason = await repo.can_delete_selection_line(line_id)
    return {"can_delete": can_delete, "reason": reason}


@router.delete("/{property_id}/selection-lines/{line_id}")
async def delete_selection_line(
    property_id: int,
    line_id: int,
    user: User = Depends(get_current_user),
):
    """Delete a selection line (only if not in use)."""
    repo = await _get_property_repo(user)
    
    try:
        success = await repo.delete_selection_line(line_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    
    if not success:
        raise HTTPException(404, "Selection line not found")
    
    return {"status": "ok"}


# ============== Type Filters ==============

@router.get("/{property_id}/type-filters")
async def list_type_filters(
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Get all type filters for a property."""
    repo = await _get_property_repo(user)
    
    filters = await repo.get_type_filters(property_id)
    return {"type_filters": filters}


@router.post("/{property_id}/type-filters")
async def add_type_filter(
    property_id: int,
    type_node_id: int,
    user: User = Depends(get_current_user),
):
    """Add a type filter to a relation-type property."""
    repo = await _get_property_repo(user)
    
    try:
        filter = await repo.add_type_filter(property_id, type_node_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    
    return {"id": filter.id, "type_node_id": filter.type_node_id}


@router.delete("/{property_id}/type-filters/{type_node_id}")
async def remove_type_filter(
    property_id: int,
    type_node_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a type filter from a property."""
    repo = await _get_property_repo(user)
    
    success = await repo.remove_type_filter(property_id, type_node_id)
    if not success:
        raise HTTPException(404, "Type filter not found")
    
    return {"status": "ok"}


# ============== Node Property Values ==============

@router.get("/nodes/{node_id}/properties")
async def get_node_properties(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Get all property assignments and values for a node."""
    repo = await _get_property_repo(user)
    
    all_values = await repo.get_all_property_values(node_id)
    
    result = []
    for prop_id, data in all_values.items():
        prop = data['property']
        np = data['node_property']
        values = data['values']
        
        # Convert values based on type
        if prop.type in SCALAR_TYPES:
            value_responses = [_scalar_value_to_response(v) for v in values]
        elif prop.type in RELATION_TYPES:
            value_responses = [_relation_value_to_response(v) for v in values]
        else:
            value_responses = [_selection_value_to_response(v) for v in values]
        
        result.append({
            "property": _property_to_response(prop),
            "node_property": NodePropertyResponse(
                id=np.id,
                node_id=np.node_id,
                property_id=np.property_id,
                create_date=np.create_date,
                write_date=np.write_date,
            ),
            "values": value_responses,
        })
    
    return {"properties": result}


@router.post("/nodes/{node_id}/properties/{property_id}/assign")
async def assign_property_to_node(
    node_id: int,
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Assign a property to a node (without setting a value)."""
    repo = await _get_property_repo(user)
    
    np = await repo.assign_property_to_node(node_id, property_id)
    
    return NodePropertyResponse(
        id=np.id,
        node_id=np.node_id,
        property_id=np.property_id,
        create_date=np.create_date,
        write_date=np.write_date,
    )


@router.delete("/nodes/{node_id}/properties/{property_id}")
async def remove_property_from_node(
    node_id: int,
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a property assignment from a node (including all values)."""
    repo = await _get_property_repo(user)
    
    success = await repo.remove_property_from_node(node_id, property_id)
    if not success:
        raise HTTPException(404, "Property assignment not found")
    
    return {"status": "ok"}


# ============== Scalar Values ==============

@router.post("/nodes/{node_id}/properties/{property_id}/scalar")
async def set_scalar_value(
    node_id: int,
    property_id: int,
    request: ScalarValueRequest,
    user: User = Depends(get_current_user),
):
    """Set a scalar property value for a node."""
    repo = await _get_property_repo(user)
    
    try:
        val = await repo.set_scalar_value(node_id, property_id, request.value, request.order)
    except ValueError as e:
        raise HTTPException(400, str(e))
    
    return _scalar_value_to_response(val)


@router.get("/nodes/{node_id}/properties/{property_id}/scalar")
async def get_scalar_values(
    node_id: int,
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Get all scalar values for a property on a node."""
    repo = await _get_property_repo(user)
    
    values = await repo.get_scalar_values(node_id, property_id)
    return {"values": [_scalar_value_to_response(v) for v in values]}


@router.delete("/nodes/{node_id}/properties/{property_id}/scalar/{value_id}")
async def remove_scalar_value(
    node_id: int,
    property_id: int,
    value_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a specific scalar value."""
    repo = await _get_property_repo(user)
    
    success = await repo.remove_scalar_value(value_id)
    if not success:
        raise HTTPException(404, "Value not found")
    
    return {"status": "ok"}


@router.delete("/nodes/{node_id}/properties/{property_id}/scalar")
async def clear_scalar_values(
    node_id: int,
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Clear all scalar values for a property on a node."""
    repo = await _get_property_repo(user)
    
    count = await repo.clear_scalar_values(node_id, property_id)
    return {"status": "ok", "deleted_count": count}


# ============== Relation Values ==============

@router.post("/nodes/{node_id}/properties/{property_id}/relation")
async def set_relation_value(
    node_id: int,
    property_id: int,
    request: RelationValueRequest,
    user: User = Depends(get_current_user),
):
    """Set a relation property value for a node."""
    repo = await _get_property_repo(user)
    
    try:
        val = await repo.set_relation_value(node_id, property_id, request.target_node_id, request.order)
    except ValueError as e:
        raise HTTPException(400, str(e))
    
    return _relation_value_to_response(val)


@router.get("/nodes/{node_id}/properties/{property_id}/relation")
async def get_relation_values(
    node_id: int,
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Get all relation values for a property on a node."""
    repo = await _get_property_repo(user)
    
    values = await repo.get_relation_values(node_id, property_id)
    return {"values": [_relation_value_to_response(v) for v in values]}


@router.delete("/nodes/{node_id}/properties/{property_id}/relation/{value_id}")
async def remove_relation_value(
    node_id: int,
    property_id: int,
    value_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a specific relation value.
    
    For text/image types, also deletes the target node to avoid floating blocks.
    """
    repo = await _get_property_repo(user)
    
    # Check property type to determine if we should delete target node
    prop = await repo.get_by_id(property_id)
    delete_target = prop and prop.type in (PropertyType.TEXT, PropertyType.IMAGE)
    
    success = await repo.remove_relation_value(value_id, delete_target_node=delete_target)
    if not success:
        raise HTTPException(404, "Value not found")
    
    return {"status": "ok"}


@router.delete("/nodes/{node_id}/properties/{property_id}/relation")
async def clear_relation_values(
    node_id: int,
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Clear all relation values for a property on a node.
    
    For text/image types, also deletes the target nodes to avoid floating blocks.
    """
    repo = await _get_property_repo(user)
    
    # Check property type to determine if we should delete target nodes
    prop = await repo.get_by_id(property_id)
    delete_targets = prop and prop.type in (PropertyType.TEXT, PropertyType.IMAGE)
    
    count = await repo.clear_relation_values(node_id, property_id, delete_target_nodes=delete_targets)
    return {"status": "ok", "deleted_count": count}


# ============== Selection Values ==============

@router.post("/nodes/{node_id}/properties/{property_id}/selection")
async def set_selection_value(
    node_id: int,
    property_id: int,
    request: SelectionValueRequest,
    user: User = Depends(get_current_user),
):
    """Set a selection property value for a node."""
    repo = await _get_property_repo(user)
    
    try:
        val = await repo.set_selection_value(node_id, property_id, request.selection_line_id, request.order)
    except ValueError as e:
        raise HTTPException(400, str(e))
    
    return _selection_value_to_response(val)


@router.get("/nodes/{node_id}/properties/{property_id}/selection")
async def get_selection_values(
    node_id: int,
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Get all selection values for a property on a node."""
    repo = await _get_property_repo(user)
    
    values = await repo.get_selection_values(node_id, property_id)
    return {"values": [_selection_value_to_response(v) for v in values]}


@router.delete("/nodes/{node_id}/properties/{property_id}/selection/{value_id}")
async def remove_selection_value(
    node_id: int,
    property_id: int,
    value_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a specific selection value."""
    repo = await _get_property_repo(user)
    
    success = await repo.remove_selection_value(value_id)
    if not success:
        raise HTTPException(404, "Value not found")
    
    return {"status": "ok"}


@router.delete("/nodes/{node_id}/properties/{property_id}/selection")
async def clear_selection_values(
    node_id: int,
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Clear all selection values for a property on a node."""
    repo = await _get_property_repo(user)
    
    count = await repo.clear_selection_values(node_id, property_id)
    return {"status": "ok", "deleted_count": count}


# ============== Type Properties ==============

@router.get("/types/{type_node_id}/properties")
async def get_type_properties(
    type_node_id: int,
    include_inherited: bool = False,
    user: User = Depends(get_current_user),
):
    """Get all properties that a type/class applies to nodes with that type."""
    repo = await _get_property_repo(user)
    
    if include_inherited:
        type_properties = await repo.get_all_inherited_properties(type_node_id)
    else:
        type_properties = await repo.get_type_properties(type_node_id)
    
    result = []
    for tp in type_properties:
        prop = await repo.get_by_id(tp.property_id)
        if not prop:
            continue
        
        default_value = (
            tp.default_integer or tp.default_float or tp.default_text or
            tp.default_boolean or tp.default_node_id or tp.default_selection_id
        )
        
        result.append(TypePropertyResponse(
            id=tp.id,
            type_node_id=tp.type_node_id,
            type_node_name="",  # Would need node repo to fetch
            property_id=tp.property_id,
            property_name=prop.name,
            property_type=prop.type.value,
            sequence=tp.sequence,
            default_value=default_value,
            hidden=tp.hidden,
        ))
    
    return {"type_properties": result}


@router.post("/types/{type_node_id}/properties")
async def add_type_property(
    type_node_id: int,
    request: TypePropertyRequest,
    user: User = Depends(get_current_user),
):
    """Link a property to a type/class."""
    repo = await _get_property_repo(user)
    
    prop = await repo.get_by_id(request.property_id)
    if not prop:
        raise HTTPException(404, "Property not found")
    
    try:
        tp = await repo.add_type_property(
            type_node_id,
            request.property_id,
            request.sequence,
            request.default_value,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    
    return TypePropertyResponse(
        id=tp.id,
        type_node_id=tp.type_node_id,
        type_node_name="",
        property_id=tp.property_id,
        property_name=prop.name,
        property_type=prop.type.value,
        sequence=tp.sequence,
        default_value=request.default_value,
        hidden=tp.hidden,
    )


@router.delete("/types/{type_node_id}/properties/{property_id}")
async def remove_type_property(
    type_node_id: int,
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a property from a type/class."""
    repo = await _get_property_repo(user)
    
    success = await repo.remove_type_property(type_node_id, property_id)
    if not success:
        raise HTTPException(404, "Type property not found")
    
    return {"status": "ok"}


# ============== Type Extends (Inheritance) ==============

@router.get("/types/{type_node_id}/extends")
async def get_type_extends(
    type_node_id: int,
    user: User = Depends(get_current_user),
):
    """Get all types that this type extends (inherits from)."""
    from ..db.connection import get_db
    
    db = await get_db(user.id)
    repo = SQLitePropertyRepository(db)
    
    extends = await repo.get_type_extends(type_node_id)
    
    result = []
    for ext in extends:
        # Get the parent type name
        cursor = await db.execute(
            "SELECT name FROM node WHERE id = ?",
            (ext.extends_type_node_id,)
        )
        row = await cursor.fetchone()
        parent_name = row['name'] if row else ""
        
        # Get the child type name
        cursor = await db.execute(
            "SELECT name FROM node WHERE id = ?",
            (ext.type_node_id,)
        )
        row = await cursor.fetchone()
        type_name = row['name'] if row else ""
        
        result.append(TypeExtendsResponse(
            id=ext.id,
            type_node_id=ext.type_node_id,
            type_node_name=type_name,
            extends_type_node_id=ext.extends_type_node_id,
            extends_type_node_name=parent_name,
            sequence=ext.sequence,
        ))
    
    return {"extends": result}


@router.post("/types/{type_node_id}/extends")
async def add_type_extends(
    type_node_id: int,
    request: TypeExtendsRequest,
    user: User = Depends(get_current_user),
):
    """Add a type that this type extends (inherits from)."""
    from ..db.connection import get_db
    
    db = await get_db(user.id)
    repo = SQLitePropertyRepository(db)
    
    try:
        ext = await repo.add_type_extends(
            type_node_id,
            request.extends_type_node_id,
            request.sequence,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    
    # Get type names for response
    cursor = await db.execute(
        "SELECT name FROM node WHERE id = ?",
        (ext.extends_type_node_id,)
    )
    row = await cursor.fetchone()
    parent_name = row['name'] if row else ""
    
    cursor = await db.execute(
        "SELECT name FROM node WHERE id = ?",
        (ext.type_node_id,)
    )
    row = await cursor.fetchone()
    type_name = row['name'] if row else ""
    
    return TypeExtendsResponse(
        id=ext.id,
        type_node_id=ext.type_node_id,
        type_node_name=type_name,
        extends_type_node_id=ext.extends_type_node_id,
        extends_type_node_name=parent_name,
        sequence=ext.sequence,
    )


@router.delete("/types/{type_node_id}/extends/{extends_type_node_id}")
async def remove_type_extends(
    type_node_id: int,
    extends_type_node_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a type extension (inheritance link)."""
    repo = await _get_property_repo(user)
    
    success = await repo.remove_type_extends(type_node_id, extends_type_node_id)
    if not success:
        raise HTTPException(404, "Type extension not found")
    
    return {"status": "ok"}


# ============== Property Usage Info ==============

@router.get("/{property_id}/nodes")
async def get_nodes_with_property(
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Get all nodes that have this property assigned."""
    repo = await _get_property_repo(user)
    
    # Check property exists
    prop = await repo.get_by_id(property_id)
    if not prop:
        raise HTTPException(404, "Property not found")
    
    # Get node IDs with this property
    node_ids = await repo.get_node_ids_with_property(property_id)
    
    # Build response with node details
    from ..db.connection import get_db
    db = await get_db(user.id)
    
    result = []
    for node_id in node_ids:
        # Get node details
        cursor = await db.execute(
            "SELECT id, uuid, name, icon, color, parent_id, page_id, is_page, is_type, "
            "create_date, write_date FROM node WHERE id = ? AND active = 1",
            (node_id,)
        )
        node_row = await cursor.fetchone()
        if not node_row:
            continue
        
        result.append({
            "node_id": node_row['id'],
            "node_uuid": node_row['uuid'],
            "node_name": node_row['name'],
            "node_icon": node_row['icon'],
            "node_color": node_row['color'],
            "parent_id": node_row['parent_id'],
            "page_id": node_row['page_id'],
            "is_page": bool(node_row['is_page']),
            "is_type": bool(node_row['is_type']),
            "create_date": node_row['create_date'],
            "write_date": node_row['write_date'],
        })
    
    return {"nodes": result, "property": _property_to_response(prop)}
