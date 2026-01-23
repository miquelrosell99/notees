"""Node property value endpoints (scalar, relation, selection)."""
from fastapi import APIRouter, HTTPException, Depends

from ..auth import get_current_user
from ...models import User
from ...domain.entities import PropertyType, SCALAR_TYPES, RELATION_TYPES
from .models import (
    NodePropertyResponse,
    ScalarValueRequest,
    RelationValueRequest,
    SelectionValueRequest,
)
from .helpers import (
    _get_property_repo,
    _property_to_response,
    _scalar_value_to_response,
    _relation_value_to_response,
    _selection_value_to_response,
)


router = APIRouter()


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
                id=np.id,  # type: ignore[arg-type]  # id is set for persisted records
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
        id=np.id,  # type: ignore[arg-type]  # id is set for persisted records
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
    delete_target = bool(prop and prop.type in (PropertyType.TEXT, PropertyType.IMAGE))
    
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
    delete_targets = bool(prop and prop.type in (PropertyType.TEXT, PropertyType.IMAGE))
    
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
