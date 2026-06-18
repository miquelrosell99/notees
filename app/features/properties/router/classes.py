"""Class properties and class extends (inheritance) endpoints."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import (
    _get_class_extension_service as _get_extension_service,
)
from app.dependencies import (
    get_current_user,
)
from app.features.properties.dependencies import get_property_service
from app.features.properties.models import (
    ClassExtendsRequest,
    ClassPropertyRequest,
    ClassPropertyResponse,
    ClassPropertyUpdateRequest,
)
from app.features.properties.service import PropertyNotFoundError, PropertyService
from app.models import User

router = APIRouter()


def _class_property_default_value(cp) -> Any:  # type: ignore[name-defined]
    """Extract the stored default value from a ClassProperty entity."""
    return (
        cp.default_integer
        or cp.default_float
        or cp.default_text
        or cp.default_boolean
        or cp.default_node_id
        or cp.default_selection_id
    )


# ============== Batch Class Properties ==============
# NOTE: batch routes MUST be registered before parameterized {class_node_id}
# routes, otherwise FastAPI tries to parse "batch" as an integer.


class BatchClassPropertyItem(BaseModel):
    class_node_id: int
    property_id: int


class BatchClassPropertyRequest(BaseModel):
    items: list[BatchClassPropertyItem]


class BatchClassPropertyResultItem(BaseModel):
    index: int
    success: bool
    error: str | None = None


class BatchClassPropertyResponse(BaseModel):
    results: list[BatchClassPropertyResultItem]
    succeeded: int
    failed: int


@router.post("/classes/batch/properties")
async def batch_add_class_properties(
    request: BatchClassPropertyRequest,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Link properties to classes in bulk.

    Each item is processed independently.  Duplicates (already bound) are
    treated as successes.
    """
    items = [(item.class_node_id, item.property_id) for item in request.items]
    service_results = await service.batch_add_class_properties(items)

    results: list[BatchClassPropertyResultItem] = []
    succeeded = 0
    failed = 0
    for i, (ok, error) in enumerate(service_results):
        results.append(BatchClassPropertyResultItem(index=i, success=ok, error=error))
        if ok:
            succeeded += 1
        else:
            failed += 1

    return BatchClassPropertyResponse(results=results, succeeded=succeeded, failed=failed)


# ============== Class Properties ==============


@router.get("/classes/{class_node_id}/properties")
async def get_class_properties(
    class_node_id: int,
    include_inherited: bool = False,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Get all properties that a class applies to nodes with that class."""
    class_properties = await service.get_class_properties(
        class_node_id, include_inherited=include_inherited
    )

    result = []
    for cp, prop in class_properties:
        result.append(
            ClassPropertyResponse(
                id=cp.id,  # type: ignore[arg-type]
                class_node_id=cp.class_node_id,
                class_node_name="",
                property_id=cp.property_id,
                property_name=prop.name,
                property_type=prop.type.value,
                sequence=cp.sequence,
                default_value=_class_property_default_value(cp),
                hidden=cp.hidden,
                required=cp.required,
            )
        )

    return {"class_properties": result}


@router.post("/classes/{class_node_id}/properties")
async def add_class_property(
    class_node_id: int,
    request: ClassPropertyRequest,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Link a property to a class."""
    try:
        cp, prop = await service.add_class_property(
            class_node_id,
            request.property_id,
            sequence=request.sequence,
            default_value=request.default_value,
            required=request.required,
            hidden=request.hidden,
        )
    except PropertyNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    return ClassPropertyResponse(
        id=cp.id,  # type: ignore[arg-type]
        class_node_id=cp.class_node_id,
        class_node_name="",
        property_id=cp.property_id,
        property_name=prop.name,
        property_type=prop.type.value,
        sequence=cp.sequence,
        default_value=request.default_value,
        hidden=cp.hidden,
        required=cp.required,
    )


@router.delete("/classes/{class_node_id}/properties/{property_id}")
async def remove_class_property(
    class_node_id: int,
    property_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Remove a property from a class."""
    success = await service.remove_class_property(class_node_id, property_id)
    if not success:
        raise HTTPException(404, "Class property not found")
    return {"status": "ok"}


@router.patch("/classes/{class_node_id}/properties/{property_id}")
async def update_class_property(
    class_node_id: int,
    property_id: int,
    request: ClassPropertyUpdateRequest,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Update an existing class property (required, hidden flags)."""
    result = await service.update_class_property(
        class_node_id,
        property_id,
        required=request.required,
        hidden=request.hidden,
    )
    if result is None:
        raise HTTPException(404, "Class property not found")

    cp, prop = result
    return ClassPropertyResponse(
        id=cp.id,  # type: ignore[arg-type]
        class_node_id=cp.class_node_id,
        class_node_name="",
        property_id=cp.property_id,
        property_name=prop.name,
        property_type=prop.type.value,
        sequence=cp.sequence,
        default_value=_class_property_default_value(cp),
        hidden=cp.hidden,
        required=cp.required,
    )


class ReorderClassPropertiesRequest(BaseModel):
    property_ids: list[int]


@router.put("/classes/{class_node_id}/properties/reorder")
async def reorder_class_properties(
    class_node_id: int,
    request: ReorderClassPropertiesRequest,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Reorder properties on a class by updating their sequence values.

    Accepts an ordered list of property IDs. Each property's sequence is
    set to its position in the list.
    """
    await service.reorder_class_properties(class_node_id, request.property_ids)
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
        raise HTTPException(500, f"Failed to get class extends: {str(e)}") from e

    result = []
    for ext in extends:
        result.append(
            {
                "id": ext.id,
                "class_node_id": ext.target_id,
                "class_node_name": "",  # Not needed since target is the current class
                "extends_class_node_id": ext.source_id,
                "extends_class_node_name": ext.source_name,
                "extends_class_icon": ext.source_icon,
                "sequence": ext.sequence,
            }
        )

    return {"extends": result}


@router.post("/classes/{class_node_id}/extends")
async def add_class_extends(
    class_node_id: int,
    request: ClassExtendsRequest,
    user: User = Depends(get_current_user),
):
    """Add a class extension (inheritance) relationship.

    Request body:
        extends_class_node_id: The class to extend (parent)
        sequence: Optional order index (default 0)
    """
    from app.features.nodes.class_extension_service import CircularInheritanceError

    extends_class_id = request.extends_class_node_id
    sequence = request.sequence

    extension_service = await _get_extension_service(user)

    try:
        ext = await extension_service.add_extends(class_node_id, extends_class_id, sequence)
    except CircularInheritanceError as e:
        raise HTTPException(400, f"Cannot add extension: {str(e)}") from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        raise HTTPException(500, f"Failed to add class extension: {str(e)}") from e

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
        raise HTTPException(500, f"Failed to remove class extension: {str(e)}") from e

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
        raise HTTPException(500, f"Failed to get inherited properties: {str(e)}") from e

    result = []
    for ip in inherited_props:
        result.append(
            {
                "property_id": ip.property_id,
                "property_name": ip.property_name,
                "property_type": ip.property_type,
                "from_class_id": ip.from_class_id,
                "from_class_name": ip.from_class_name,
                "sequence": ip.sequence,
                "default_value": ip.default_value,
                "hidden": ip.hidden,
                "is_overridden": ip.is_overridden,
            }
        )

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
        raise HTTPException(500, f"Failed to get extended-by classes: {str(e)}") from e

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
    from app.features.nodes.class_extension_service import CircularInheritanceError

    extension_service = await _get_extension_service(user)

    try:
        await extension_service.validate_extends_acyclic(class_node_id, extends_ids)
        return {"valid": True}
    except CircularInheritanceError as e:
        return {"valid": False, "error": str(e), "cycle_path": e.cycle_path}
    except Exception as e:
        raise HTTPException(500, f"Validation failed: {str(e)}") from e
