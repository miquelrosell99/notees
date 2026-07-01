"""Property CRUD and class filter endpoints."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import get_current_user, get_node_repository, require_write_scope
from app.domain.entities import PropertyScope, PropertyType
from app.features.nodes.port import NodeRepository
from app.features.nodes.router.dependencies import (
    resolve_class_uuid,
    resolve_class_uuids,
    resolve_node_uuid,
    resolve_property_uuid,
)
from app.features.nodes.router.helpers import extract_properties_dict
from app.features.properties.dependencies import get_property_service
from app.features.properties.models import (
    PropertyCreateRequest,
    PropertyResponse,
    PropertyTypeChangeRequest,
    PropertyUpdateRequest,
)
from app.features.properties.router.helpers import _build_node_uuid_map, _property_to_response
from app.features.properties.service import PropertyNotFoundError, PropertyService
from app.logging_config import get_logger
from app.models import User

logger = get_logger(__name__)

router = APIRouter()


async def _build_property_response_maps(
    node_repo: NodeRepository,
    properties: list[Any],
) -> tuple[dict[int, str], dict[int, str]]:
    """Build node_uuid and class_filter UUID maps for a list of properties."""
    node_ids: set[int] = set()
    class_filter_ids: set[int] = set()
    for prop in properties:
        if prop.node_id is not None:
            node_ids.add(prop.node_id)
        for class_id in prop._class_filters:
            class_filter_ids.add(class_id)

    node_uuid_map = await _build_node_uuid_map(node_repo, list(node_ids))
    class_uuid_map = await _build_node_uuid_map(node_repo, list(class_filter_ids))
    return node_uuid_map, class_uuid_map


async def _properties_to_responses(
    properties: list[Any],
    node_repo: NodeRepository,
) -> list[PropertyResponse]:
    """Convert multiple domain Property entities to API responses with UUID references."""
    node_uuid_map, class_uuid_map = await _build_property_response_maps(node_repo, properties)
    return [await _property_to_response(p, node_uuid_map=node_uuid_map, class_uuid_map=class_uuid_map) for p in properties]


@router.get("/", name="list_properties", response_model=dict[str, list[PropertyResponse]])
async def list_properties(
    include_local: bool = True,
    service: PropertyService = Depends(get_property_service),
    node_repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """List all property definitions."""
    properties = await service.list_properties(include_local=include_local)
    logger.info(
        "[LIST_PROPERTIES] Returning %s properties: %s",
        len(properties),
        [(p.id, p.name) for p in properties],
    )
    return {"properties": await _properties_to_responses(properties, node_repo)}


@router.get("/local/{node_uuid}", response_model=dict[str, list[PropertyResponse]])
async def list_local_properties(
    node_id: int = Depends(resolve_node_uuid),
    service: PropertyService = Depends(get_property_service),
    node_repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """List all local properties for a specific page node."""
    properties = await service.list_local_properties(node_id)
    return {"properties": await _properties_to_responses(properties, node_repo)}


@router.get("/available", response_model=dict[str, list[PropertyResponse]])
async def list_available_properties(
    context_node_uuid: str | None = None,
    context_class_ids: str | None = None,  # comma-separated list of class UUIDs
    service: PropertyService = Depends(get_property_service),
    node_repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """List properties available in a given context: global + class-scoped + node-scoped."""
    context_node_id: int | None = None
    if context_node_uuid:
        node = await node_repo.get_by_uuid(context_node_uuid)
        if node is None or node.id is None:
            raise HTTPException(status_code=404, detail="Context node not found")
        context_node_id = node.id

    class_ids: list[int] = []
    if context_class_ids:
        try:
            parsed_uuids = [x.strip() for x in context_class_ids.split(",") if x.strip()]
            class_ids = await resolve_class_uuids(parsed_uuids, node_repo)
        except ValueError:
            raise HTTPException(
                400, "context_class_ids must be a comma-separated list of class UUIDs"
            ) from None

    properties = await service.list_available_properties(
        context_node_id=context_node_id,
        context_class_ids=class_ids or None,
    )
    return {"properties": await _properties_to_responses(properties, node_repo)}


@router.get("/stats", response_model=dict[str, Any])
async def get_property_stats(
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Return usage counts per property across all nodes in this workspace."""
    rows = await service.get_property_stats()
    return {"stats": rows}


@router.get("/suggestions", response_model=dict[str, Any])
async def get_property_suggestions(
    node_uuid: str | None = None,
    node_repo: NodeRepository = Depends(get_node_repository),
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Return property suggestions for a node, ranked by usage frequency."""
    node_id: int | None = None
    if node_uuid:
        node = await node_repo.get_by_uuid(node_uuid)
        if node is None or node.id is None:
            raise HTTPException(status_code=404, detail="Node not found")
        node_id = node.id
    suggestions = await service.get_property_suggestions(node_id)
    return {"suggestions": suggestions}


@router.post("/", name="create_property", response_model=PropertyResponse, dependencies=[Depends(require_write_scope)])
async def create_property(
    request: PropertyCreateRequest,
    service: PropertyService = Depends(get_property_service),
    node_repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """Create a new property definition."""
    try:
        prop_type = PropertyType(request.type)
    except ValueError:
        raise HTTPException(400, f"Invalid property type: {request.type}") from None

    try:
        scope = PropertyScope(request.scope)
    except ValueError:
        raise HTTPException(400, f"Invalid property scope: {request.scope}") from None

    # Resolve scoped node UUID and class filter UUIDs to internal numeric IDs.
    node_id: int | None = None
    if request.node_uuid:
        node = await node_repo.get_by_uuid(request.node_uuid)
        if node is None or node.id is None:
            raise HTTPException(status_code=404, detail="Scoped node not found")
        node_id = node.id

    class_filter_ids: list[int] = []
    if request.class_filters:
        class_filter_ids = await resolve_class_uuids(request.class_filters, node_repo)

    try:
        created = await service.create_property(
            name=request.name,
            prop_type=prop_type,
            scope=scope,
            is_multi=request.is_multi,
            icon=request.icon,
            node_id=node_id,
            class_filters=class_filter_ids or None,
            selection_lines=request.selection_lines,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    return await _property_to_response(created, node_uuid_map={node_id: request.node_uuid} if node_id and request.node_uuid else None)


@router.get("/{property_uuid}", response_model=PropertyResponse)
async def get_property(
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    node_repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """Get a property definition by UUID."""
    prop = await service.get_property(property_id)
    if not prop:
        raise HTTPException(404, "Property not found")
    node_uuid_map, class_uuid_map = await _build_property_response_maps(node_repo, [prop])
    return await _property_to_response(prop, node_uuid_map=node_uuid_map, class_uuid_map=class_uuid_map)


@router.get("/uuid/{uuid}")
async def get_property_by_uuid(
    uuid: str,
    service: PropertyService = Depends(get_property_service),
    node_repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """Get a property definition by UUID."""
    prop = await service.get_property_by_uuid(uuid)
    if not prop:
        raise HTTPException(404, "Property not found")
    node_uuid_map, class_uuid_map = await _build_property_response_maps(node_repo, [prop])
    return await _property_to_response(prop, node_uuid_map=node_uuid_map, class_uuid_map=class_uuid_map)


@router.put("/{property_uuid}", response_model=PropertyResponse, dependencies=[Depends(require_write_scope)])
async def update_property(
    request: PropertyUpdateRequest,
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    node_repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """Update a property definition (name, icon, and optionally multi)."""
    try:
        prop = await service.update_property(
            property_id,
            name=request.name,
            icon=request.icon,
            icon_visibility=request.icon_visibility,
            is_multi=request.multi,
            validation_rules=request.validation_rules,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    if not prop:
        raise HTTPException(404, "Property not found")
    node_uuid_map, class_uuid_map = await _build_property_response_maps(node_repo, [prop])
    return await _property_to_response(prop, node_uuid_map=node_uuid_map, class_uuid_map=class_uuid_map)


@router.post("/{property_uuid}/change-type", dependencies=[Depends(require_write_scope)])
async def change_property_type(
    request: PropertyTypeChangeRequest,
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    node_repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """Change a property's type (only if no values exist)."""
    try:
        new_type = PropertyType(request.new_type)
    except ValueError:
        raise HTTPException(400, f"Invalid property type: {request.new_type}") from None

    try:
        prop = await service.change_property_type(
            property_id, new_type, request.new_is_multi
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    if not prop:
        raise HTTPException(404, "Property not found")
    node_uuid_map, class_uuid_map = await _build_property_response_maps(node_repo, [prop])
    return await _property_to_response(prop, node_uuid_map=node_uuid_map, class_uuid_map=class_uuid_map)


@router.get("/{property_uuid}/can-delete")
async def check_can_delete_property(
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Check if a property can be deleted."""
    can_delete, reason = await service.can_delete_property(property_id)
    return {"can_delete": can_delete, "reason": reason}


@router.delete("/{property_uuid}", dependencies=[Depends(require_write_scope)])
async def delete_property(
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Delete a property definition (only if no values exist)."""
    try:
        success = await service.delete_property(property_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    if not success:
        raise HTTPException(404, "Property not found")
    return {"status": "ok"}


# ============== Class Filters ==============


@router.get("/{property_uuid}/class-filters")
async def list_class_filters(
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    node_repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """Get all class filters for a property."""
    filters = await service.list_class_filters(property_id)
    uuid_map = await _build_node_uuid_map(node_repo, [f.class_node_id for f in filters])
    return {
        "class_filters": [
            {
                "id": f.id,
                "class_filter_uuid": f.uuid,
                "property_id": f.property_id,
                "class_node_id": f.class_node_id,
                "class_node_uuid": uuid_map.get(f.class_node_id, ""),
            }
            for f in filters
        ]
    }


@router.post("/{property_uuid}/class-filters", dependencies=[Depends(require_write_scope)])
async def add_class_filter(
    property_id: int = Depends(resolve_property_uuid),
    class_node_uuid: str = ...,
    service: PropertyService = Depends(get_property_service),
    node_repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """Add a class filter to a node-type property."""
    class_node = await node_repo.get_by_uuid(class_node_uuid)
    if class_node is None or class_node.id is None:
        raise HTTPException(status_code=404, detail="Class not found")
    class_node_id = class_node.id

    try:
        filter_obj = await service.add_class_filter(property_id, class_node_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    return {
        "id": filter_obj.id,
        "class_filter_uuid": filter_obj.uuid,
        "property_id": filter_obj.property_id,
        "class_node_id": class_node_id,
        "class_node_uuid": class_node_uuid,
    }


@router.delete("/{property_uuid}/class-filters/{class_node_uuid}", dependencies=[Depends(require_write_scope)])
async def remove_class_filter(
    property_id: int = Depends(resolve_property_uuid),
    class_node_id: int = Depends(resolve_class_uuid),
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Remove a class filter from a property."""
    success = await service.remove_class_filter(property_id, class_node_id)
    if not success:
        raise HTTPException(404, "Class filter not found")
    return {"status": "ok"}


# ============== Property Usage Info ==============


@router.get("/{property_uuid}/nodes")
async def get_nodes_with_property(
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    node_repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """Get all nodes that have this property assigned."""
    try:
        prop = await service.get_property(property_id)
    except PropertyNotFoundError:
        raise HTTPException(404, "Property not found") from None
    if not prop:
        raise HTTPException(404, "Property not found")

    nodes = await service.get_nodes_with_property(property_id)

    # Collect IDs that need UUID lookups.
    parent_ids: set[int] = set()
    page_ids: set[int] = set()
    class_ids: set[int] = set()
    for node_info in nodes:
        if node_info.get("parent_id") is not None:
            parent_ids.add(node_info["parent_id"])
        if node_info.get("page_id") is not None:
            page_ids.add(node_info["page_id"])
        for cid in node_info.get("class_ids", []) or []:
            class_ids.add(cid)

    node_uuid_map = await _build_node_uuid_map(
        node_repo, list(parent_ids | page_ids | class_ids)
    )

    result = []
    for node_info in nodes:
        properties_dict = extract_properties_dict(node_info["properties"])
        parent_id = node_info.get("parent_id")
        page_id = node_info.get("page_id")
        node_class_ids = node_info.get("class_ids", []) or []
        result.append(
            {
                "node_id": node_info["node_id"],
                "node_uuid": node_info["node_uuid"],
                "node_name": node_info["node_name"],
                "node_icon": node_info["node_icon"],
                "node_color": node_info["node_color"],
                "parent_id": parent_id,
                "parent_uuid": node_uuid_map.get(parent_id) if parent_id is not None else None,
                "page_id": page_id,
                "page_uuid": node_uuid_map.get(page_id) if page_id is not None else None,
                "is_page": node_info["is_page"],
                "is_class": node_info["is_class"],
                "create_date": node_info["create_date"],
                "write_date": node_info["write_date"],
                "properties": properties_dict,
                "class_ids": node_class_ids,
                "class_uuids": [node_uuid_map[cid] for cid in node_class_ids if cid in node_uuid_map],
            }
        )

    node_uuid_map, class_uuid_map = await _build_property_response_maps(node_repo, [prop])
    return {"nodes": result, "property": await _property_to_response(prop, node_uuid_map=node_uuid_map, class_uuid_map=class_uuid_map)}
