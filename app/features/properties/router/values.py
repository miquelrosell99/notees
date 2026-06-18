"""Node property value endpoints (scalar, relation, selection)."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import get_current_user
from app.domain.entities import RELATION_TYPES, SCALAR_TYPES
from app.features.nodes.router.helpers import (
    _get_class_ids,
    _node_to_response,
    extract_properties_dict,
)
from app.features.properties.dependencies import get_property_service
from app.features.properties.models import (
    NodePropertyResponse,
    RelationValueRequest,
    ScalarValueRequest,
    SelectionValueRequest,
)
from app.features.properties.router.helpers import (
    _property_to_response,
    _relation_value_to_response,
    _scalar_value_to_response,
    _selection_value_to_response,
)
from app.features.properties.service import PropertyService
from app.logging_config import get_logger
from app.models import User

logger = get_logger(__name__)

router = APIRouter()


class BatchPropertiesRequest(BaseModel):
    """Request body for batch property values."""

    node_ids: list[int]


@router.post("/batch/properties")
async def get_batch_property_values(
    request: BatchPropertiesRequest,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
) -> dict[str, dict[str, Any]]:
    """Get property values for multiple nodes in one request.

    Returns a dict of { node_id -> { property_id -> value } }.
    """
    batch_result = await service.get_batch_property_values(request.node_ids)

    response: dict[str, dict[str, Any]] = {}
    for nid, prop_values in batch_result.items():
        response[str(nid)] = extract_properties_dict(prop_values)

    return response


class SetPropertyRequest(BaseModel):
    """Unified property value request."""

    property_id: int
    value: Any


@router.post("/{node_id}/properties")
async def set_property_value(
    node_id: int,
    request: SetPropertyRequest,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Set a property value for a node (auto-detects type and dispatches to the correct handler).

    Returns the updated node.
    """
    prop = await service.get_property(request.property_id)
    if not prop:
        raise HTTPException(404, f"Property {request.property_id} not found")

    try:
        await service.set_property_value(node_id, request.property_id, request.value)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    node = await service.node_service.get_node(node_id)
    if not node:
        raise HTTPException(404, f"Node {node_id} not found")

    class_ids = await _get_class_ids(service.node_service, node_id)
    response = _node_to_response(node, classes=class_ids)
    all_prop_values = await service.get_node_properties(node_id)
    logger.info("[SET_PROPERTY] Node %s has %s property values", node_id, len(all_prop_values))
    response.properties = extract_properties_dict(all_prop_values)

    return response


@router.get("/{node_id}/properties")
async def get_node_properties(
    node_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Get all property assignments and values for a node."""
    all_values = await service.get_node_properties(node_id)

    result = []
    for _prop_id, data in all_values.items():
        prop = data["property"]
        np = data["node_property"]
        values = data["values"]

        if prop.type in SCALAR_TYPES:
            value_responses = [_scalar_value_to_response(v) for v in values]
        elif prop.type in RELATION_TYPES:
            value_responses = [_relation_value_to_response(v) for v in values]
        else:
            value_responses = [_selection_value_to_response(v) for v in values]

        result.append(
            {
                "property": _property_to_response(prop),
                "node_property": NodePropertyResponse(
                    id=np.id,  # type: ignore[arg-type]
                    node_id=np.node_id,
                    property_id=np.property_id,
                    create_date=np.create_date,
                    write_date=np.write_date,
                ),
                "values": value_responses,
            }
        )

    return {"properties": result}


@router.post("/{node_id}/properties/{property_id}/assign")
async def assign_property_to_node(
    node_id: int,
    property_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Assign a property to a node (without setting a value)."""
    np = await service.assign_property_to_node(node_id, property_id)

    return NodePropertyResponse(
        id=np.id,  # type: ignore[arg-type]
        node_id=np.node_id,
        property_id=np.property_id,
        create_date=np.create_date,
        write_date=np.write_date,
    )


@router.delete("/{node_id}/properties/{property_id}")
async def remove_property_from_node(
    node_id: int,
    property_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Remove a property assignment from a node (including all values)."""
    success = await service.remove_property_from_node(node_id, property_id)
    if not success:
        raise HTTPException(404, "Property assignment not found")
    return {"status": "ok"}


# ============== Scalar Values ==============


@router.post("/{node_id}/properties/{property_id}/scalar")
async def set_scalar_value(
    node_id: int,
    property_id: int,
    request: ScalarValueRequest,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Set a scalar property value for a node."""
    try:
        val = await service.set_scalar_value(
            node_id, property_id, request.value, request.order
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    return _scalar_value_to_response(val)


@router.get("/{node_id}/properties/{property_id}/scalar")
async def get_scalar_values(
    node_id: int,
    property_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Get all scalar values for a property on a node."""
    values = await service.get_scalar_values(node_id, property_id)
    return {"values": [_scalar_value_to_response(v) for v in values]}


@router.delete("/{node_id}/properties/{property_id}/scalar/{value_id}")
async def remove_scalar_value(
    node_id: int,
    property_id: int,
    value_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Remove a specific scalar value."""
    success = await service.remove_scalar_value(value_id)
    if not success:
        raise HTTPException(404, "Value not found")
    return {"status": "ok"}


@router.delete("/{node_id}/properties/{property_id}/scalar")
async def clear_scalar_values(
    node_id: int,
    property_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Clear all scalar values for a property on a node."""
    count = await service.clear_scalar_values(node_id, property_id)
    return {"status": "ok", "deleted_count": count}


# ============== Relation Values ==============


@router.post("/{node_id}/properties/{property_id}/relation")
async def set_relation_value(
    node_id: int,
    property_id: int,
    request: RelationValueRequest,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Set a relation property value for a node."""
    try:
        val = await service.set_relation_value(
            node_id, property_id, request.target_node_id, request.order
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    return _relation_value_to_response(val)


@router.get("/{node_id}/properties/{property_id}/relation")
async def get_relation_values(
    node_id: int,
    property_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Get all relation values for a property on a node."""
    values = await service.get_relation_values(node_id, property_id)
    return {"values": [_relation_value_to_response(v) for v in values]}


@router.delete("/{node_id}/properties/{property_id}/relation/{value_id}")
async def remove_relation_value(
    node_id: int,
    property_id: int,
    value_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Remove a specific relation value.

    For text/image types, also deletes the target node to avoid floating blocks.
    """
    success = await service.remove_relation_value(value_id, property_id)
    if not success:
        raise HTTPException(404, "Value not found")
    return {"status": "ok"}


@router.delete("/{node_id}/properties/{property_id}/relation")
async def clear_relation_values(
    node_id: int,
    property_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Clear all relation values for a property on a node.

    For text/image types, also deletes the target nodes to avoid floating blocks.
    """
    count = await service.clear_relation_values(node_id, property_id)
    return {"status": "ok", "deleted_count": count}


# ============== Selection Values ==============


@router.post("/{node_id}/properties/{property_id}/selection")
async def set_selection_value(
    node_id: int,
    property_id: int,
    request: SelectionValueRequest,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Set a selection property value for a node."""
    try:
        val = await service.set_selection_value(
            node_id, property_id, request.selection_line_id, request.order
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    return _selection_value_to_response(val)


@router.get("/{node_id}/properties/{property_id}/selection")
async def get_selection_values(
    node_id: int,
    property_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Get all selection values for a property on a node."""
    values = await service.get_selection_values(node_id, property_id)
    return {"values": [_selection_value_to_response(v) for v in values]}


@router.delete("/{node_id}/properties/{property_id}/selection/{value_id}")
async def remove_selection_value(
    node_id: int,
    property_id: int,
    value_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Remove a specific selection value."""
    success = await service.remove_selection_value(value_id)
    if not success:
        raise HTTPException(404, "Value not found")
    return {"status": "ok"}


@router.delete("/{node_id}/properties/{property_id}/selection")
async def clear_selection_values(
    node_id: int,
    property_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Clear all selection values for a property on a node."""
    count = await service.clear_selection_values(node_id, property_id)
    return {"status": "ok", "deleted_count": count}


# ============== Batch set property values ==============


class BatchSetPropertyItem(BaseModel):
    """One property assignment in a batch."""

    node_id: int
    property_id: int
    value: Any


class BatchSetPropertyRequest(BaseModel):
    """Request body for batch property value assignment."""

    items: list[BatchSetPropertyItem]


class BatchSetPropertyResultItem(BaseModel):
    index: int
    success: bool
    error: str | None = None


class BatchSetPropertyResponse(BaseModel):
    results: list[BatchSetPropertyResultItem]
    succeeded: int
    failed: int


@router.post("/batch/set")
async def batch_set_property_values(
    request: BatchSetPropertyRequest,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Set property values for many (node, property, value) tuples in one request.

    Each item is processed independently — a failure on one does not prevent
    others from being set.  Returns per-item results.
    """
    items = [(item.node_id, item.property_id, item.value) for item in request.items]
    service_results = await service.batch_set_property_values(items)

    results: list[BatchSetPropertyResultItem] = []
    succeeded = 0
    failed = 0
    for i, (ok, error) in enumerate(service_results):
        results.append(BatchSetPropertyResultItem(index=i, success=ok, error=error))
        if ok:
            succeeded += 1
        else:
            failed += 1

    return BatchSetPropertyResponse(results=results, succeeded=succeeded, failed=failed)
