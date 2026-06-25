"""Node property value endpoints (scalar, relation, selection)."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import get_current_user, get_node_repository, get_property_repository
from app.domain.entities import RELATION_TYPES, SCALAR_TYPES, PropertyType
from app.features.nodes.port import NodeRepository
from app.features.nodes.router.dependencies import (
    resolve_node_uuid,
    resolve_node_uuids,
    resolve_relation_value_uuid,
    resolve_scalar_value_uuid,
    resolve_selection_value_uuid,
    resolve_target_uuid,
)
from app.features.nodes.router.helpers import (
    _get_class_ids,
    _node_to_response,
)
from app.features.properties.dependencies import get_property_service
from app.features.properties.models import (
    NodePropertyResponse,
    RelationValueRequest,
    ScalarValueRequest,
    SelectionValueRequest,
)
from app.features.properties.port import PropertyRepository
from app.features.properties.router.dependencies import (
    resolve_property_uuid,
    resolve_property_uuids,
    resolve_selection_line_uuid,
)
from app.features.properties.router.helpers import (
    _build_value_response_maps,
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

    node_uuids: list[str]


@router.post("/batch/properties")
async def get_batch_property_values(
    request: BatchPropertiesRequest,
    service: PropertyService = Depends(get_property_service),
    repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
) -> dict[str, dict[str, Any]]:
    """Get property values for multiple nodes in one request.

    Returns a dict of { node_uuid -> { property_uuid -> value } }.
    """
    node_ids = await resolve_node_uuids(request.node_uuids, repo)
    uuid_to_id = dict(zip(request.node_uuids, node_ids, strict=True))
    id_to_uuid = {nid: nuuid for nuuid, nid in uuid_to_id.items()}

    batch_result = await service.get_batch_property_values(node_ids)

    response: dict[str, dict[str, Any]] = {}
    for nid, prop_values in batch_result.items():
        node_uuid = id_to_uuid[nid]
        response[node_uuid] = {}
        for _prop_id, prop_data in prop_values.items():
            prop = prop_data["property"]
            response[node_uuid][prop.uuid] = _extract_single_property_value(prop, prop_data["values"])

    return response


def _extract_single_property_value(prop: Any, values: list[Any]) -> Any:
    """Extract a single typed value from a list of property values."""
    if not values:
        return [] if prop.is_multi else None

    if prop.is_multi:
        result: list[Any] = []
        seen: set = set()
        for val in values:
            extracted = _extract_property_value(val)
            if extracted is not None and extracted not in seen:
                seen.add(extracted)
                result.append(extracted)
        return result

    return _extract_property_value(values[0])


def _extract_property_value(val: Any) -> Any:
    """Extract a single typed value from a property value row."""
    if hasattr(val, "target_id"):
        return val.target_id
    if hasattr(val, "value_integer"):
        if val.value_integer is not None:
            return val.value_integer
        if val.value_float is not None:
            return val.value_float
        if val.value_boolean is not None:
            return val.value_boolean
        return val.value_text
    if hasattr(val, "selection_line_id"):
        return val.selection_line_id
    return None


async def _resolve_property_value(
    prop: Any,
    value: Any,
    node_repo: NodeRepository,
    property_repo: PropertyRepository,
) -> Any:
    """Resolve public UUIDs inside a property value to internal IDs for the service.

    Relation-type values may be a single target node UUID or a list of UUIDs.
    Selection-type values may be a single selection line UUID or a list of UUIDs.
    Integer IDs are accepted as a backwards-compatibility fallback.
    """
    if value is None or value == "":
        return value

    if prop.type in RELATION_TYPES:
        if isinstance(value, list):
            resolved: list[int] = []
            for item in value:
                if isinstance(item, int):
                    resolved.append(item)
                elif isinstance(item, str):
                    node = await node_repo.get_by_uuid(item)
                    if node is None or node.id is None:
                        raise HTTPException(404, f"Target node {item} not found")
                    resolved.append(node.id)
                else:
                    raise HTTPException(400, f"Invalid relation value: {item}")
            return resolved
        if isinstance(value, int):
            return value
        if isinstance(value, str):
            node = await node_repo.get_by_uuid(value)
            if node is None or node.id is None:
                raise HTTPException(404, f"Target node {value} not found")
            return node.id
        raise HTTPException(400, f"Relation property expects node UUID or array of UUIDs, got {type(value)}")

    if prop.type == PropertyType.SELECTION:
        if isinstance(value, list):
            resolved = []
            for item in value:
                if isinstance(item, int):
                    resolved.append(item)
                elif isinstance(item, str):
                    line = await property_repo.get_selection_line_by_uuid(item)
                    if line is None or line.id is None:
                        raise HTTPException(404, f"Selection line {item} not found")
                    resolved.append(line.id)
                else:
                    raise HTTPException(400, f"Invalid selection value: {item}")
            return resolved
        if isinstance(value, int):
            return value
        if isinstance(value, str):
            line = await property_repo.get_selection_line_by_uuid(value)
            if line is None or line.id is None:
                raise HTTPException(404, f"Selection line {value} not found")
            return line.id
        raise HTTPException(400, f"Selection property expects selection line UUID or array of UUIDs, got {type(value)}")

    return value


class SetPropertyRequest(BaseModel):
    """Unified property value request."""

    property_uuid: str | None = None
    property_id: int | None = None  # Backwards compatibility during migration
    value: Any


@router.post("/{node_uuid}/properties")
async def set_property_value(
    node_id: int = Depends(resolve_node_uuid),
    request: SetPropertyRequest = ...,
    service: PropertyService = Depends(get_property_service),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
    user: User = Depends(get_current_user),
):
    """Set a property value for a node (auto-detects type and dispatches to the correct handler).

    Returns the updated node.
    """
    if request.property_uuid:
        prop = await service.get_property_by_uuid(request.property_uuid)
        if not prop:
            raise HTTPException(404, f"Property {request.property_uuid} not found")
        property_id = prop.id
    elif request.property_id is not None:
        prop = await service.get_property(request.property_id)
        if not prop:
            raise HTTPException(404, f"Property {request.property_id} not found")
        property_id = request.property_id
    else:
        raise HTTPException(400, "property_uuid or property_id is required")

    assert property_id is not None

    resolved_value = await _resolve_property_value(
        prop, request.value, repo, property_repo
    )

    try:
        await service.set_property_value(node_id, property_id, resolved_value)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    node = await service.node_service.get_node(node_id)
    if not node:
        raise HTTPException(404, f"Node {node_id} not found")

    class_ids = await _get_class_ids(service.node_service, node_id)
    response = _node_to_response(node, classes=class_ids)
    all_prop_values = await service.get_node_properties(node_id)
    logger.info("[SET_PROPERTY] Node %s has %s property values", node_id, len(all_prop_values))
    response.properties = _extract_properties_dict_by_uuid(all_prop_values)

    return response


def _extract_properties_dict_by_uuid(all_prop_values: dict[int, dict[str, Any]]) -> dict[str, Any]:
    """Convert raw property values into a JSON-serializable dict keyed by property UUID."""
    props_dict: dict[str, Any] = {}
    for _prop_id, prop_data in all_prop_values.items():
        prop = prop_data["property"]
        props_dict[prop.uuid] = _extract_single_property_value(prop, prop_data["values"])
    return props_dict


@router.get("/{node_uuid}/properties")
async def get_node_properties(
    node_id: int = Depends(resolve_node_uuid),
    service: PropertyService = Depends(get_property_service),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
    user: User = Depends(get_current_user),
):
    """Get all property assignments and values for a node."""
    all_values = await service.get_node_properties(node_id)

    # Build value response maps in batch.
    all_value_rows: list[Any] = []
    for data in all_values.values():
        all_value_rows.extend(data["values"])
    (
        node_uuid_map,
        property_uuid_map,
        node_property_uuid_map,
        target_node_uuid_map,
        selection_line_uuid_map,
    ) = await _build_value_response_maps(all_value_rows, repo, property_repo)

    result = []
    for _prop_id, data in all_values.items():
        prop = data["property"]
        np = data["node_property"]
        values = data["values"]

        if prop.type in SCALAR_TYPES:
            value_responses = [
                _scalar_value_to_response(
                    v,
                    node_uuid_map=node_uuid_map,
                    property_uuid_map=property_uuid_map,
                    node_property_uuid_map=node_property_uuid_map,
                )
                for v in values
            ]
        elif prop.type in RELATION_TYPES:
            value_responses = [
                _relation_value_to_response(
                    v,
                    node_uuid_map=node_uuid_map,
                    property_uuid_map=property_uuid_map,
                    node_property_uuid_map=node_property_uuid_map,
                    target_node_uuid_map=target_node_uuid_map,
                )
                for v in values
            ]
        else:
            value_responses = [
                _selection_value_to_response(
                    v,
                    node_uuid_map=node_uuid_map,
                    property_uuid_map=property_uuid_map,
                    node_property_uuid_map=node_property_uuid_map,
                    selection_line_uuid_map=selection_line_uuid_map,
                )
                for v in values
            ]

        result.append(
            {
                "property": await _property_to_response(prop),
                "node_property": NodePropertyResponse(
                    id=np.id,  # type: ignore[arg-type]
                    node_property_uuid=np.uuid,
                    node_id=np.node_id,
                    node_uuid=node_uuid_map.get(np.node_id, ""),
                    property_id=np.property_id,
                    property_uuid=property_uuid_map.get(np.property_id, ""),
                    create_date=np.create_date,
                    write_date=np.write_date,
                ),
                "values": value_responses,
            }
        )

    return {"properties": result}


@router.post("/{node_uuid}/properties/{property_uuid}/assign")
async def assign_property_to_node(
    node_id: int = Depends(resolve_node_uuid),
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
    user: User = Depends(get_current_user),
):
    """Assign a property to a node (without setting a value)."""
    np = await service.assign_property_to_node(node_id, property_id)
    prop = await property_repo.get_by_id(property_id)
    node = await repo.get_by_id(node_id)

    return NodePropertyResponse(
        id=np.id,  # type: ignore[arg-type]
        node_property_uuid=np.uuid,
        node_id=np.node_id,
        node_uuid=node.uuid if node else "",
        property_id=np.property_id,
        property_uuid=prop.uuid if prop else "",
        create_date=np.create_date,
        write_date=np.write_date,
    )


@router.delete("/{node_uuid}/properties/{property_uuid}")
async def remove_property_from_node(
    node_id: int = Depends(resolve_node_uuid),
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Remove a property assignment from a node (including all values)."""
    success = await service.remove_property_from_node(node_id, property_id)
    if not success:
        raise HTTPException(404, "Property assignment not found")
    return {"status": "ok"}


# ============== Scalar Values ==============


@router.post("/{node_uuid}/properties/{property_uuid}/scalar")
async def set_scalar_value(
    node_id: int = Depends(resolve_node_uuid),
    property_id: int = Depends(resolve_property_uuid),
    request: ScalarValueRequest = ...,
    service: PropertyService = Depends(get_property_service),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
    user: User = Depends(get_current_user),
):
    """Set a scalar property value for a node."""
    try:
        val = await service.set_scalar_value(
            node_id, property_id, request.value, request.order
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    maps = await _build_value_response_maps([val], repo, property_repo)
    return _scalar_value_to_response(
        val,
        node_uuid_map=maps[0],
        property_uuid_map=maps[1],
        node_property_uuid_map=maps[2],
    )


@router.get("/{node_uuid}/properties/{property_uuid}/scalar")
async def get_scalar_values(
    node_id: int = Depends(resolve_node_uuid),
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
    user: User = Depends(get_current_user),
):
    """Get all scalar values for a property on a node."""
    values = await service.get_scalar_values(node_id, property_id)
    maps = await _build_value_response_maps(values, repo, property_repo)
    return {
        "values": [
            _scalar_value_to_response(
                v,
                node_uuid_map=maps[0],
                property_uuid_map=maps[1],
                node_property_uuid_map=maps[2],
            )
            for v in values
        ]
    }


@router.delete("/{node_uuid}/properties/{property_uuid}/scalar/{value_uuid}")
async def remove_scalar_value(
    value_id: int = Depends(resolve_scalar_value_uuid),
    node_id: int = Depends(resolve_node_uuid),
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Remove a specific scalar value."""
    success = await service.remove_scalar_value(value_id)
    if not success:
        raise HTTPException(404, "Value not found")
    return {"status": "ok"}


@router.delete("/{node_uuid}/properties/{property_uuid}/scalar")
async def clear_scalar_values(
    node_id: int = Depends(resolve_node_uuid),
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Clear all scalar values for a property on a node."""
    count = await service.clear_scalar_values(node_id, property_id)
    return {"status": "ok", "deleted_count": count}


# ============== Relation Values ==============


@router.post("/{node_uuid}/properties/{property_uuid}/relation")
async def set_relation_value(
    node_id: int = Depends(resolve_node_uuid),
    property_id: int = Depends(resolve_property_uuid),
    request: RelationValueRequest = ...,
    service: PropertyService = Depends(get_property_service),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
    user: User = Depends(get_current_user),
):
    """Set a relation property value for a node."""
    if request.target_node_uuid:
        target_node_id = await resolve_target_uuid(request.target_node_uuid, repo)
    elif request.target_node_id is not None:
        target_node_id = request.target_node_id
    else:
        raise HTTPException(400, "target_node_uuid or target_node_id is required")

    try:
        val = await service.set_relation_value(
            node_id, property_id, target_node_id, request.order
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    maps = await _build_value_response_maps([val], repo, property_repo)
    return _relation_value_to_response(
        val,
        node_uuid_map=maps[0],
        property_uuid_map=maps[1],
        node_property_uuid_map=maps[2],
        target_node_uuid_map=maps[3],
    )


@router.get("/{node_uuid}/properties/{property_uuid}/relation")
async def get_relation_values(
    node_id: int = Depends(resolve_node_uuid),
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
    user: User = Depends(get_current_user),
):
    """Get all relation values for a property on a node."""
    values = await service.get_relation_values(node_id, property_id)
    maps = await _build_value_response_maps(values, repo, property_repo)
    return {
        "values": [
            _relation_value_to_response(
                v,
                node_uuid_map=maps[0],
                property_uuid_map=maps[1],
                node_property_uuid_map=maps[2],
                target_node_uuid_map=maps[3],
            )
            for v in values
        ]
    }


@router.delete("/{node_uuid}/properties/{property_uuid}/relation/{value_uuid}")
async def remove_relation_value(
    value_id: int = Depends(resolve_relation_value_uuid),
    node_id: int = Depends(resolve_node_uuid),
    property_id: int = Depends(resolve_property_uuid),
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


@router.delete("/{node_uuid}/properties/{property_uuid}/relation")
async def clear_relation_values(
    node_id: int = Depends(resolve_node_uuid),
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Clear all relation values for a property on a node.

    For text/image types, also deletes the target nodes to avoid floating blocks.
    """
    count = await service.clear_relation_values(node_id, property_id)
    return {"status": "ok", "deleted_count": count}


# ============== Selection Values ==============


@router.post("/{node_uuid}/properties/{property_uuid}/selection")
async def set_selection_value(
    node_id: int = Depends(resolve_node_uuid),
    property_id: int = Depends(resolve_property_uuid),
    request: SelectionValueRequest = ...,
    service: PropertyService = Depends(get_property_service),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
    user: User = Depends(get_current_user),
):
    """Set a selection property value for a node."""
    if request.selection_line_uuid:
        selection_line_id = await resolve_selection_line_uuid(
            request.selection_line_uuid, property_repo
        )
    elif request.selection_line_id is not None:
        selection_line_id = request.selection_line_id
    else:
        raise HTTPException(400, "selection_line_uuid or selection_line_id is required")

    try:
        val = await service.set_selection_value(
            node_id, property_id, selection_line_id, request.order
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    maps = await _build_value_response_maps([val], repo, property_repo)
    return _selection_value_to_response(
        val,
        node_uuid_map=maps[0],
        property_uuid_map=maps[1],
        node_property_uuid_map=maps[2],
        selection_line_uuid_map=maps[4],
    )


@router.get("/{node_uuid}/properties/{property_uuid}/selection")
async def get_selection_values(
    node_id: int = Depends(resolve_node_uuid),
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
    user: User = Depends(get_current_user),
):
    """Get all selection values for a property on a node."""
    values = await service.get_selection_values(node_id, property_id)
    maps = await _build_value_response_maps(values, repo, property_repo)
    return {
        "values": [
            _selection_value_to_response(
                v,
                node_uuid_map=maps[0],
                property_uuid_map=maps[1],
                node_property_uuid_map=maps[2],
                selection_line_uuid_map=maps[4],
            )
            for v in values
        ]
    }


@router.delete("/{node_uuid}/properties/{property_uuid}/selection/{value_uuid}")
async def remove_selection_value(
    value_id: int = Depends(resolve_selection_value_uuid),
    node_id: int = Depends(resolve_node_uuid),
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Remove a specific selection value."""
    success = await service.remove_selection_value(value_id)
    if not success:
        raise HTTPException(404, "Value not found")
    return {"status": "ok"}


@router.delete("/{node_uuid}/properties/{property_uuid}/selection")
async def clear_selection_values(
    node_id: int = Depends(resolve_node_uuid),
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Clear all selection values for a property on a node."""
    count = await service.clear_selection_values(node_id, property_id)
    return {"status": "ok", "deleted_count": count}


# ============== Batch set property values ==============


class BatchSetPropertyItem(BaseModel):
    """One property assignment in a batch."""

    node_uuid: str
    property_uuid: str | None = None
    property_id: int | None = None  # Backwards compatibility during migration
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
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
    user: User = Depends(get_current_user),
):
    """Set property values for many (node, property, value) tuples in one request.

    Each item is processed independently — a failure on one does not prevent
    others from being set.  Returns per-item results.
    """
    # Resolve node UUIDs.
    item_node_uuids = [item.node_uuid for item in request.items]
    resolved_node_ids = await resolve_node_uuids(item_node_uuids, repo)
    node_uuid_to_id = dict(zip(item_node_uuids, resolved_node_ids, strict=True))

    # Resolve property UUIDs/IDs.
    property_uuid_items = [
        item.property_uuid for item in request.items if item.property_uuid
    ]
    resolved_property_ids = await resolve_property_uuids(property_uuid_items, property_repo)
    property_uuid_to_id = dict(zip(property_uuid_items, resolved_property_ids, strict=True))

    items: list[tuple[int, int, Any]] = []
    for item in request.items:
        node_id = node_uuid_to_id[item.node_uuid]
        if item.property_uuid:
            property_id = property_uuid_to_id[item.property_uuid]
        elif item.property_id is not None:
            property_id = item.property_id
        else:
            raise HTTPException(400, "property_uuid or property_id is required")

        prop = await property_repo.get_by_id(property_id)
        if prop is None:
            raise HTTPException(404, f"Property {property_id} not found")
        resolved_value = await _resolve_property_value(
            prop, item.value, repo, property_repo
        )
        items.append((node_id, property_id, resolved_value))

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
