"""Class properties and class extends (inheritance) endpoints."""
from fastapi import APIRouter, HTTPException, Depends

from ..auth import get_current_user
from ...models import User
from .models import ClassPropertyRequest, ClassPropertyResponse
from .helpers import _get_property_repo


router = APIRouter()


# ============== Class Properties ==============

@router.get("/classes/{class_node_id}/properties")
async def get_class_properties(
    class_node_id: int,
    include_inherited: bool = False,
    user: User = Depends(get_current_user),
):
    """Get all properties that a class applies to nodes with that class."""
    repo = await _get_property_repo(user)
    
    if include_inherited:
        class_properties = await repo.get_all_inherited_properties(class_node_id)
    else:
        class_properties = await repo.get_class_properties(class_node_id)
    
    result = []
    for cp in class_properties:
        prop = await repo.get_by_id(cp.property_id)
        if not prop:
            continue
        
        default_value = (
            cp.default_integer or cp.default_float or cp.default_text or
            cp.default_boolean or cp.default_node_id or cp.default_selection_id
        )
        
        result.append(ClassPropertyResponse(
            id=cp.id,  # type: ignore[arg-type]  # id is set for persisted records
            class_node_id=cp.class_node_id,
            class_node_name="",  # Would need node repo to fetch
            property_id=cp.property_id,
            property_name=prop.name,
            property_type=prop.type.value,
            sequence=cp.sequence,
            default_value=default_value,
            hidden=cp.hidden,
        ))
    
    return {"class_properties": result}


@router.post("/classes/{class_node_id}/properties")
async def add_class_property(
    class_node_id: int,
    request: ClassPropertyRequest,
    user: User = Depends(get_current_user),
):
    """Link a property to a class."""
    repo = await _get_property_repo(user)
    
    prop = await repo.get_by_id(request.property_id)
    if not prop:
        raise HTTPException(404, "Property not found")
    
    try:
        cp = await repo.add_class_property(
            class_node_id,
            request.property_id,
            request.sequence,
            request.default_value,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    
    return ClassPropertyResponse(
        id=cp.id,  # type: ignore[arg-type]  # id is set for persisted records
        class_node_id=cp.class_node_id,
        class_node_name="",
        property_id=cp.property_id,
        property_name=prop.name,
        property_type=prop.type.value,
        sequence=cp.sequence,
        default_value=request.default_value,
        hidden=cp.hidden,
    )


@router.delete("/classes/{class_node_id}/properties/{property_id}")
async def remove_class_property(
    class_node_id: int,
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a property from a class."""
    repo = await _get_property_repo(user)
    
    success = await repo.remove_class_property(class_node_id, property_id)
    if not success:
        raise HTTPException(404, "Class property not found")
    
    return {"status": "ok"}


# ============== Class Extends (Inheritance) ==============
# NOTE: These endpoints are currently disabled because the repository
# methods (get_class_extends, add_class_extends, remove_class_extends) 
# are not yet implemented.
# TODO: Implement class inheritance in PostgresPropertyRepository
