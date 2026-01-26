"""Class properties and class extends (inheritance) endpoints."""
from typing import cast
from fastapi import APIRouter, HTTPException, Depends
import asyncpg

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

@router.get("/classes/{class_node_id}/inherited-properties")
async def get_inherited_properties_endpoint(
    class_node_id: int,
    user: User = Depends(get_current_user),
):
    """Get all properties inherited from extended classes.
    
    Returns properties with is_overridden flag indicating if they're
    also defined as dedicated class properties.
    """
    from ...domain.services.class_extension_service import ClassExtensionService
    from ...dependencies import get_pool, get_graph_id
    
    pool = await get_pool()
    graph_id = await get_graph_id(user)
    repo = await _get_property_repo(user)
    
    extension_service = ClassExtensionService(pool, graph_id, repo)
    
    try:
        inherited_props = await extension_service.get_inherited_properties(class_node_id)
    except Exception as e:
        raise HTTPException(500, f"Failed to get inherited properties: {str(e)}")
    
    result = []
    for ip in inherited_props:
        result.append({
            "property_id": ip.property_id,
            "property_name": ip.property_name,
            "property_type": ip.property_type,
            "from_class_id": ip.from_class_id,
            "from_class_name": ip.from_class_name,
            "sequence": ip.sequence,
            "default_value": ip.default_value,
            "hidden": ip.hidden,
            "is_overridden": ip.is_overridden,
        })
    
    return {"inherited_properties": result}


@router.get("/classes/{class_node_id}/extended-by")
async def get_extended_by_classes_endpoint(
    class_node_id: int,
    user: User = Depends(get_current_user),
):
    """Get all classes that extend this class (reverse lookup).
    
    Returns a flat list of classes for display in the 'Extended By' section.
    """
    from ...domain.services.class_extension_service import ClassExtensionService
    from ...dependencies import get_pool
    from ...db.schema import get_or_create_user_graph
    
    pool = await get_pool()
    user_id = int(user.id)
    async with pool.acquire() as conn:
        graph_id = await get_or_create_user_graph(cast(asyncpg.Connection, conn), user_id)
    repo = await _get_property_repo(user)
    
    extension_service = ClassExtensionService(pool, graph_id, repo)
    
    try:
        classes = await extension_service.get_classes_extended_by(class_node_id)
    except Exception as e:
        raise HTTPException(500, f"Failed to get extended-by classes: {str(e)}")
    
    return {"classes": classes}


@router.post("/classes/{class_node_id}/validate-extends")
async def validate_class_extends_endpoint(
    class_node_id: int,
    extends_ids: list[int],
    user: User = Depends(get_current_user),
):
    """Validate that setting these extends would not create a circular reference.
    
    Returns {"valid": true} if OK, or {"valid": false, "error": "..."} if cycle detected.
    """
    from ...domain.services.class_extension_service import ClassExtensionService, CircularInheritanceError
    from ...dependencies import get_pool
    from ...db.schema import get_or_create_user_graph
    
    pool = await get_pool()
    user_id = int(user.id)
    async with pool.acquire() as conn:
        graph_id = await get_or_create_user_graph(cast(asyncpg.Connection, conn), user_id)
    repo = await _get_property_repo(user)
    
    extension_service = ClassExtensionService(pool, graph_id, repo)
    
    try:
        await extension_service.validate_extends_acyclic(class_node_id, extends_ids)
        return {"valid": True}
    except CircularInheritanceError as e:
        return {"valid": False, "error": str(e), "cycle_path": e.cycle_path}
    except Exception as e:
        raise HTTPException(500, f"Validation failed: {str(e)}")
