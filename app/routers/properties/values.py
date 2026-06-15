"""Node property value endpoints (scalar, relation, selection)."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ...db.schema.constants import SYSTEM_PROPERTY_UUIDS
from ...dependencies import (
    get_activity_repository,
    get_current_user,
    get_task_automation_service,
)
from ...domain.entities import RELATION_TYPES, SCALAR_TYPES, PropertyType
from ...domain.repositories.interfaces import ActivityRepository
from ...domain.services import TaskAutomationService
from ...logging_config import get_logger
from ...models import User
from ..nodes.helpers import _get_class_ids, _node_to_response, extract_properties_dict
from .helpers import (
    _get_property_repo,
    _property_to_response,
    _relation_value_to_response,
    _scalar_value_to_response,
    _selection_value_to_response,
)
from .models import (
    NodePropertyResponse,
    RelationValueRequest,
    ScalarValueRequest,
    SelectionValueRequest,
)

logger = get_logger(__name__)


def _normalize_selection_value(value: Any) -> int | None:
    """Extract a single selection line ID from a scalar, list, or empty value."""
    if value is None or value == "":
        return None
    if isinstance(value, list):
        return value[0] if value else None
    return int(value)


async def _run_task_automations(
    node_id: int,
    prop: Any,
    value: Any,
    task_service: TaskAutomationService,
) -> None:
    """Delegate task lifecycle automations to the domain service."""
    if prop.uuid != SYSTEM_PROPERTY_UUIDS["task_status"]:
        return
    status_line_id = _normalize_selection_value(value)
    try:
        await task_service.handle_status_change(node_id, status_line_id)
    except Exception as e:
        logger.warning(f"[TASK_AUTOMATION] Failed for node {node_id}: {e}")


router = APIRouter()


class BatchPropertiesRequest(BaseModel):
    """Request body for batch property values."""

    node_ids: list[int]


@router.post("/batch/properties")
async def get_batch_property_values(
    request: BatchPropertiesRequest,
    user: User = Depends(get_current_user),
) -> dict[str, dict[str, Any]]:
    """Get property values for multiple nodes in one request.

    Returns a dict of { node_id -> { property_id -> value } }.
    Uses batched SQL queries (3 total) instead of N*3.
    """
    repo = await _get_property_repo(user)

    batch_result = await repo.get_all_property_values_batch(request.node_ids)

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
    user: User = Depends(get_current_user),
    activity_repo: ActivityRepository = Depends(get_activity_repository),
    task_service: TaskAutomationService = Depends(get_task_automation_service),
):
    """Set a property value for a node (auto-detects type and dispatches to correct handler).

    This is a convenience endpoint that determines the property type and calls
    the appropriate type-specific endpoint. Returns the updated node.
    """
    repo = await _get_property_repo(user)
    node_service = task_service.node_service

    # Get the property to determine its type
    prop = await repo.get_by_id(request.property_id)
    if not prop:
        raise HTTPException(404, f"Property {request.property_id} not found")

    # Dispatch to the appropriate handler based on property type
    try:
        if prop.type in SCALAR_TYPES:
            # Scalar value - allow empty strings
            logger.info(
                f"[SET_PROPERTY] Setting scalar value for node {node_id}, prop {request.property_id}, value={repr(request.value)}, type={prop.type}"
            )
            result = await repo.set_scalar_value(node_id, request.property_id, request.value)
            logger.info(f"[SET_PROPERTY] Scalar value set result: {result}")
        elif prop.type in RELATION_TYPES:
            # Relation value (expects node_id or array of node_ids for multi-value)
            # Skip if empty string (placeholder value from frontend)
            logger.info(
                f"[SET_PROPERTY] Setting relation value for node {node_id}, prop {request.property_id}, value={repr(request.value)}, type={prop.type}"
            )
            if request.value == "" or request.value is None:
                # Just assign the property without setting a value
                logger.info("[SET_PROPERTY] Empty/null value - assigning property without value")
                await repo.assign_property_to_node(node_id, request.property_id)
            elif isinstance(request.value, list):
                # Multi-value property: clear existing and set all values
                # Deduplicate to prevent duplicate entries
                unique_values = list(dict.fromkeys(request.value))
                logger.info(
                    f"[SET_PROPERTY] Array of {len(unique_values)} unique node IDs (from {len(request.value)}): {unique_values}"
                )
                # First clear existing values
                await repo.clear_relation_values(node_id, request.property_id)
                # Then add each value
                for target_id in unique_values:
                    if not isinstance(target_id, int):
                        raise ValueError(f"Relation property expects node ID, got {type(target_id)} in array")
                    result = await repo.set_relation_value(node_id, request.property_id, target_id)
                    logger.info(f"[SET_PROPERTY] Set relation to node {target_id}, result: {result}")
            elif isinstance(request.value, int):
                result = await repo.set_relation_value(node_id, request.property_id, request.value)
                logger.info(f"[SET_PROPERTY] Set single relation to node {request.value}, result: {result}")
            else:
                raise ValueError(f"Relation property expects node ID or array of node IDs, got {type(request.value)}")
        else:
            # Selection value (expects selection_line_id or array for multi-value)
            # Skip if empty string (placeholder value from frontend)
            logger.info(
                f"[SET_PROPERTY] Setting selection value for node {node_id}, prop {request.property_id}, value={repr(request.value)}, type={prop.type}"
            )
            if request.value == "" or request.value is None:
                # Just assign the property without setting a value
                logger.info("[SET_PROPERTY] Empty/null value - assigning property without value")
                await repo.assign_property_to_node(node_id, request.property_id)
            elif isinstance(request.value, list):
                # Multi-value property: clear existing and set all values
                # Deduplicate to prevent duplicate entries
                unique_values = list(dict.fromkeys(request.value))
                logger.info(
                    f"[SET_PROPERTY] Array of {len(unique_values)} unique selection IDs (from {len(request.value)}): {unique_values}"
                )
                # First clear existing values
                await repo.clear_selection_values(node_id, request.property_id)
                # Then add each value
                for selection_id in unique_values:
                    if not isinstance(selection_id, int):
                        raise ValueError(
                            f"Selection property expects selection_line_id, got {type(selection_id)} in array"
                        )
                    result = await repo.set_selection_value(node_id, request.property_id, selection_id)
                    logger.info(f"[SET_PROPERTY] Set selection {selection_id}, result: {result}")
            elif isinstance(request.value, int):
                result = await repo.set_selection_value(node_id, request.property_id, request.value)
                logger.info(f"[SET_PROPERTY] Set single selection {request.value}, result: {result}")
            else:
                raise ValueError(
                    f"Selection property expects selection_line_id or array of IDs, got {type(request.value)}"
                )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    # Run task lifecycle automations when task_status changes.
    if prop.type not in SCALAR_TYPES and prop.type not in RELATION_TYPES:
        await _run_task_automations(node_id, prop, request.value, task_service)

    # Log property change activity
    try:
        from ...utils import utc_now

        await activity_repo.create_node_activity(
            node_id=node_id,
            action="property_changed",
            details=f"Property '{prop.name}' changed",
            target_node_id=request.property_id,
            now=utc_now(),
        )
    except (ValueError, TypeError, LookupError):
        pass  # Activity logging must never fail the user operation

    # Fetch and return the updated node with properties
    node = await node_service.get_node(node_id)
    if not node:
        raise HTTPException(404, f"Node {node_id} not found")

    # Get classes for the node
    class_ids = await _get_class_ids(node_service, node_id)

    # Build response with properties populated
    response = _node_to_response(node, classes=class_ids)
    all_prop_values = await repo.get_all_property_values(node_id)
    logger.info(f"[SET_PROPERTY] Node {node_id} has {len(all_prop_values)} property values")
    response.properties = extract_properties_dict(all_prop_values)

    return response


@router.get("/{node_id}/properties")
async def get_node_properties(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Get all property assignments and values for a node."""
    repo = await _get_property_repo(user)

    all_values = await repo.get_all_property_values(node_id)

    result = []
    for _prop_id, data in all_values.items():
        prop = data["property"]
        np = data["node_property"]
        values = data["values"]

        # Convert values based on type
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
                    id=np.id,  # type: ignore[arg-type]  # id is set for persisted records
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


@router.delete("/{node_id}/properties/{property_id}")
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


@router.post("/{node_id}/properties/{property_id}/scalar")
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
        raise HTTPException(400, str(e)) from e

    return _scalar_value_to_response(val)


@router.get("/{node_id}/properties/{property_id}/scalar")
async def get_scalar_values(
    node_id: int,
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Get all scalar values for a property on a node."""
    repo = await _get_property_repo(user)

    values = await repo.get_scalar_values(node_id, property_id)
    return {"values": [_scalar_value_to_response(v) for v in values]}


@router.delete("/{node_id}/properties/{property_id}/scalar/{value_id}")
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


@router.delete("/{node_id}/properties/{property_id}/scalar")
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


@router.post("/{node_id}/properties/{property_id}/relation")
async def set_relation_value(
    node_id: int,
    property_id: int,
    request: RelationValueRequest,
    user: User = Depends(get_current_user),
):
    """Set a relation property value for a node."""
    repo = await _get_property_repo(user)

    try:
        val = await repo.set_relation_value(node_id, property_id, request.target_node_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    return _relation_value_to_response(val)


@router.get("/{node_id}/properties/{property_id}/relation")
async def get_relation_values(
    node_id: int,
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Get all relation values for a property on a node."""
    repo = await _get_property_repo(user)

    values = await repo.get_relation_values(node_id, property_id)
    return {"values": [_relation_value_to_response(v) for v in values]}


@router.delete("/{node_id}/properties/{property_id}/relation/{value_id}")
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


@router.delete("/{node_id}/properties/{property_id}/relation")
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


@router.post("/{node_id}/properties/{property_id}/selection")
async def set_selection_value(
    node_id: int,
    property_id: int,
    request: SelectionValueRequest,
    user: User = Depends(get_current_user),
):
    """Set a selection property value for a node."""
    repo = await _get_property_repo(user)

    try:
        val = await repo.set_selection_value(node_id, property_id, request.selection_line_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    return _selection_value_to_response(val)


@router.get("/{node_id}/properties/{property_id}/selection")
async def get_selection_values(
    node_id: int,
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Get all selection values for a property on a node."""
    repo = await _get_property_repo(user)

    values = await repo.get_selection_values(node_id, property_id)
    return {"values": [_selection_value_to_response(v) for v in values]}


@router.delete("/{node_id}/properties/{property_id}/selection/{value_id}")
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


@router.delete("/{node_id}/properties/{property_id}/selection")
async def clear_selection_values(
    node_id: int,
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Clear all selection values for a property on a node."""
    repo = await _get_property_repo(user)

    count = await repo.clear_selection_values(node_id, property_id)
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
    user: User = Depends(get_current_user),
    task_service: TaskAutomationService = Depends(get_task_automation_service),
):
    """Set property values for many (node, property, value) tuples in one request.

    Each item is processed independently — a failure on one does not prevent
    others from being set.  Returns per-item results.
    """
    repo = await _get_property_repo(user)

    # Pre-fetch all referenced properties once to avoid N lookups
    prop_ids = list({item.property_id for item in request.items})
    prop_cache: dict[int, Any] = {}
    for pid in prop_ids:
        p = await repo.get_by_id(pid)
        if p:
            prop_cache[pid] = p

    results: list[BatchSetPropertyResultItem] = []
    succeeded = 0
    failed = 0

    for i, item in enumerate(request.items):
        try:
            prop = prop_cache.get(item.property_id)
            if not prop:
                raise ValueError(f"Property {item.property_id} not found")

            if prop.type in SCALAR_TYPES:
                await repo.set_scalar_value(item.node_id, item.property_id, item.value)
            elif prop.type in RELATION_TYPES:
                if item.value == "" or item.value is None:
                    await repo.assign_property_to_node(item.node_id, item.property_id)
                elif isinstance(item.value, list):
                    unique_values = list(dict.fromkeys(item.value))
                    await repo.clear_relation_values(item.node_id, item.property_id)
                    for target_id in unique_values:
                        await repo.set_relation_value(item.node_id, item.property_id, int(target_id))
                elif isinstance(item.value, int):
                    await repo.set_relation_value(item.node_id, item.property_id, item.value)
                else:
                    raise ValueError(f"Relation property expects int or list, got {type(item.value)}")
            else:
                # selection type
                if item.value == "" or item.value is None:
                    await repo.assign_property_to_node(item.node_id, item.property_id)
                elif isinstance(item.value, list):
                    unique_values = list(dict.fromkeys(item.value))
                    await repo.clear_selection_values(item.node_id, item.property_id)
                    for sel_id in unique_values:
                        await repo.set_selection_value(item.node_id, item.property_id, int(sel_id))
                elif isinstance(item.value, int):
                    await repo.set_selection_value(item.node_id, item.property_id, item.value)
                else:
                    raise ValueError(f"Selection property expects int or list, got {type(item.value)}")

                # Run task automations for selection properties
                if prop.uuid == SYSTEM_PROPERTY_UUIDS["task_status"]:
                    await _run_task_automations(
                        item.node_id, prop, item.value, task_service
                    )

            results.append(BatchSetPropertyResultItem(index=i, success=True))
            succeeded += 1
        except Exception as e:
            results.append(BatchSetPropertyResultItem(index=i, success=False, error=str(e)))
            failed += 1

    return BatchSetPropertyResponse(results=results, succeeded=succeeded, failed=failed)
