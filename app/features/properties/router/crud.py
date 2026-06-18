"""Property CRUD and class filter endpoints."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import get_current_user
from app.domain.entities import PropertyScope, PropertyType
from app.features.nodes.router.helpers import extract_properties_dict
from app.features.properties.dependencies import get_property_service
from app.features.properties.models import (
    PropertyCreateRequest,
    PropertyResponse,
    PropertyTypeChangeRequest,
    PropertyUpdateRequest,
)
from app.features.properties.router.helpers import _property_to_response
from app.features.properties.service import PropertyNotFoundError, PropertyService
from app.logging_config import get_logger
from app.models import User

logger = get_logger(__name__)

router = APIRouter()


@router.get("/", name="list_properties", response_model=dict[str, list[PropertyResponse]])
async def list_properties(
    include_local: bool = True,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """List all property definitions."""
    properties = await service.list_properties(include_local=include_local)
    logger.info(
        "[LIST_PROPERTIES] Returning %s properties: %s",
        len(properties),
        [(p.id, p.name) for p in properties],
    )
    return {"properties": [_property_to_response(p) for p in properties]}


@router.get("/local/{node_id}", response_model=dict[str, list[PropertyResponse]])
async def list_local_properties(
    node_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """List all local properties for a specific page node."""
    properties = await service.list_local_properties(node_id)
    return {"properties": [_property_to_response(p) for p in properties]}


@router.get("/available", response_model=dict[str, list[PropertyResponse]])
async def list_available_properties(
    context_node_id: int | None = None,
    context_class_ids: str | None = None,  # comma-separated list of ints
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """List properties available in a given context: global + class-scoped + node-scoped."""
    class_ids: list[int] = []
    if context_class_ids:
        try:
            class_ids = [int(x) for x in context_class_ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(
                400, "context_class_ids must be a comma-separated list of integers"
            ) from None

    properties = await service.list_available_properties(
        context_node_id=context_node_id,
        context_class_ids=class_ids or None,
    )
    return {"properties": [_property_to_response(p) for p in properties]}


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
    node_id: int | None = None,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Return property suggestions for a node, ranked by usage frequency."""
    suggestions = await service.get_property_suggestions(node_id)
    return {"suggestions": suggestions}


@router.post("/", name="create_property", response_model=PropertyResponse)
async def create_property(
    request: PropertyCreateRequest,
    service: PropertyService = Depends(get_property_service),
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

    try:
        created = await service.create_property(
            name=request.name,
            prop_type=prop_type,
            scope=scope,
            is_multi=request.is_multi,
            icon=request.icon,
            node_id=request.node_id,
            class_filters=request.class_filters,
            selection_lines=request.selection_lines,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    return _property_to_response(created)


@router.get("/{property_id}", response_model=PropertyResponse)
async def get_property(
    property_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Get a property definition by ID."""
    prop = await service.get_property(property_id)
    if not prop:
        raise HTTPException(404, "Property not found")
    return _property_to_response(prop)


@router.get("/uuid/{uuid}")
async def get_property_by_uuid(
    uuid: str,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Get a property definition by UUID."""
    prop = await service.get_property_by_uuid(uuid)
    if not prop:
        raise HTTPException(404, "Property not found")
    return _property_to_response(prop)


@router.put("/{property_id}", response_model=PropertyResponse)
async def update_property(
    property_id: int,
    request: PropertyUpdateRequest,
    service: PropertyService = Depends(get_property_service),
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
    return _property_to_response(prop)


@router.post("/{property_id}/change-type")
async def change_property_type(
    property_id: int,
    request: PropertyTypeChangeRequest,
    service: PropertyService = Depends(get_property_service),
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
    return _property_to_response(prop)


@router.get("/{property_id}/can-delete")
async def check_can_delete_property(
    property_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Check if a property can be deleted."""
    can_delete, reason = await service.can_delete_property(property_id)
    return {"can_delete": can_delete, "reason": reason}


@router.delete("/{property_id}")
async def delete_property(
    property_id: int,
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


@router.get("/{property_id}/class-filters")
async def list_class_filters(
    property_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Get all class filters for a property."""
    filters = await service.list_class_filters(property_id)
    return {"class_filters": filters}


@router.post("/{property_id}/class-filters")
async def add_class_filter(
    property_id: int,
    class_node_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Add a class filter to a node-type property."""
    try:
        filter_obj = await service.add_class_filter(property_id, class_node_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    return {"id": filter_obj.id, "class_node_id": filter_obj.class_node_id}


@router.delete("/{property_id}/class-filters/{class_node_id}")
async def remove_class_filter(
    property_id: int,
    class_node_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Remove a class filter from a property."""
    success = await service.remove_class_filter(property_id, class_node_id)
    if not success:
        raise HTTPException(404, "Class filter not found")
    return {"status": "ok"}


# ============== Property Usage Info ==============


@router.get("/{property_id}/nodes")
async def get_nodes_with_property(
    property_id: int,
    service: PropertyService = Depends(get_property_service),
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

    result = []
    for node_info in nodes:
        properties_dict = extract_properties_dict(node_info["properties"])
        result.append(
            {
                "node_id": node_info["node_id"],
                "node_uuid": node_info["node_uuid"],
                "node_name": node_info["node_name"],
                "node_icon": node_info["node_icon"],
                "node_color": node_info["node_color"],
                "parent_id": node_info["parent_id"],
                "page_id": node_info["page_id"],
                "is_page": node_info["is_page"],
                "is_class": node_info["is_class"],
                "create_date": node_info["create_date"],
                "write_date": node_info["write_date"],
                "properties": properties_dict,
                "class_ids": node_info["class_ids"],
            }
        )

    return {"nodes": result, "property": _property_to_response(prop)}
