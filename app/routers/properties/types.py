"""Type properties and type extends (inheritance) endpoints."""
from fastapi import APIRouter, HTTPException, Depends

from ..auth import get_current_user
from ...models import User
from .models import TypePropertyRequest, TypePropertyResponse
from .helpers import _get_property_repo


router = APIRouter()


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
            id=tp.id,  # type: ignore[arg-type]  # id is set for persisted records
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
        id=tp.id,  # type: ignore[arg-type]  # id is set for persisted records
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
# NOTE: These endpoints are currently disabled because the repository
# methods (get_type_extends, add_type_extends, remove_type_extends) 
# are not yet implemented.
# TODO: Implement type inheritance in PostgresPropertyRepository
