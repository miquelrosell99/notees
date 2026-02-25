"""Class properties and class extends (inheritance) endpoints."""
from typing import cast, List
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
import asyncpg

from ..auth import get_current_user
from ...models import User
from .models import ClassPropertyRequest, ClassPropertyResponse
from .helpers import _get_property_repo
from ...db.connection import acquire_connection, get_pool


router = APIRouter()


async def _get_extension_service(user: User):
    """Get ClassExtensionService for user's workspace (respects active workspace)."""
    from ...domain.services.class_extension_service import ClassExtensionService
    from ...dependencies import _get_workspace_context_cached

    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    repo = await _get_property_repo(user)
    return ClassExtensionService(pool, workspace_id, repo)


# ============== Batch Class Properties ==============
# NOTE: batch routes MUST be registered before parameterized {class_node_id}
# routes, otherwise FastAPI tries to parse "batch" as an integer.

class BatchClassPropertyItem(BaseModel):
    class_node_id: int
    property_id: int


class BatchClassPropertyRequest(BaseModel):
    items: List[BatchClassPropertyItem]


class BatchClassPropertyResultItem(BaseModel):
    index: int
    success: bool
    error: str | None = None


class BatchClassPropertyResponse(BaseModel):
    results: List[BatchClassPropertyResultItem]
    succeeded: int
    failed: int


@router.post("/classes/batch/properties")
async def batch_add_class_properties(
    request: BatchClassPropertyRequest,
    user: User = Depends(get_current_user),
):
    """Link properties to classes in bulk.

    Each item is processed independently.  Duplicates (already bound) are
    treated as successes.
    """
    repo = await _get_property_repo(user)

    results: List[BatchClassPropertyResultItem] = []
    succeeded = 0
    failed = 0

    for i, item in enumerate(request.items):
        try:
            await repo.add_class_property(item.class_node_id, item.property_id)
            results.append(BatchClassPropertyResultItem(index=i, success=True))
            succeeded += 1
        except ValueError as e:
            msg = str(e)
            # Treat "already bound" as success
            if "already" in msg.lower():
                results.append(BatchClassPropertyResultItem(index=i, success=True))
                succeeded += 1
            else:
                results.append(BatchClassPropertyResultItem(index=i, success=False, error=msg))
                failed += 1
        except Exception as e:
            results.append(BatchClassPropertyResultItem(index=i, success=False, error=str(e)))
            failed += 1

    return BatchClassPropertyResponse(results=results, succeeded=succeeded, failed=failed)


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

@router.get("/classes/{class_node_id}/extends")
async def get_class_extends(
    class_node_id: int,
    user: User = Depends(get_current_user),
):
    """Get all classes that this class extends (inherits from).
    
    Returns the direct parent classes in sequence order.
    """
    extension_service = await _get_extension_service(user)
    
    try:
        extends = await extension_service.get_extended_classes_with_details(class_node_id)
    except Exception as e:
        raise HTTPException(500, f"Failed to get class extends: {str(e)}")
    
    # Return in the format expected by the frontend
    result = []
    for ext in extends:
        result.append({
            "id": ext.id,
            "class_node_id": ext.target_id,
            "class_node_name": "",  # Not needed since target is the current class
            "extends_class_node_id": ext.source_id,
            "extends_class_node_name": ext.source_name,
            "extends_class_icon": ext.source_icon,
            "sequence": ext.sequence,
        })
    
    return {"extends": result}


@router.post("/classes/{class_node_id}/extends")
async def add_class_extends(
    class_node_id: int,
    request: dict,
    user: User = Depends(get_current_user),
):
    """Add a class extension (inheritance) relationship.
    
    Request body:
        extends_class_node_id: The class to extend (parent)
        sequence: Optional order index (default 0)
    """
    from ...domain.services.class_extension_service import CircularInheritanceError
    
    extends_class_id = request.get("extends_class_node_id")
    if not extends_class_id:
        raise HTTPException(400, "extends_class_node_id is required")
    
    sequence = request.get("sequence", 0)
    
    extension_service = await _get_extension_service(user)
    
    try:
        ext = await extension_service.add_extends(class_node_id, extends_class_id, sequence)
    except CircularInheritanceError as e:
        raise HTTPException(400, f"Cannot add extension: {str(e)}")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Failed to add class extension: {str(e)}")
    
    return {
        "id": ext.id,
        "class_node_id": ext.target_id,
        "class_node_name": "",
        "extends_class_node_id": ext.source_id,
        "extends_class_node_name": ext.source_name,
        "extends_class_icon": ext.source_icon,
        "sequence": ext.sequence,
    }


@router.delete("/classes/{class_node_id}/extends/{extends_class_node_id}")
async def remove_class_extends(
    class_node_id: int,
    extends_class_node_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a class extension (inheritance) relationship."""
    extension_service = await _get_extension_service(user)
    
    try:
        success = await extension_service.remove_extends(class_node_id, extends_class_node_id)
        if not success:
            raise HTTPException(404, "Class extension not found")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to remove class extension: {str(e)}")
    
    return {"status": "ok"}


@router.get("/classes/{class_node_id}/inherited-properties")
async def get_inherited_properties_endpoint(
    class_node_id: int,
    user: User = Depends(get_current_user),
):
    """Get all properties inherited from extended classes.
    
    Returns properties with is_overridden flag indicating if they're
    also defined as dedicated class properties.
    """
    extension_service = await _get_extension_service(user)
    
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
    extension_service = await _get_extension_service(user)
    
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
    from ...domain.services.class_extension_service import CircularInheritanceError
    
    extension_service = await _get_extension_service(user)
    
    try:
        await extension_service.validate_extends_acyclic(class_node_id, extends_ids)
        return {"valid": True}
    except CircularInheritanceError as e:
        return {"valid": False, "error": str(e), "cycle_path": e.cycle_path}
    except Exception as e:
        raise HTTPException(500, f"Validation failed: {str(e)}")
