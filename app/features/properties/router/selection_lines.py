"""Selection lines (options) endpoints for selection-type properties."""

from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import get_current_user, get_node_repository, get_property_repository
from app.domain.entities import PropertyType
from app.features.nodes.port import NodeRepository
from app.features.properties.dependencies import get_property_service
from app.features.properties.models import SelectionLineRequest, SelectionLineUpdateRequest
from app.features.properties.port import PropertyRepository
from app.features.properties.router.dependencies import resolve_property_uuid, resolve_selection_line_uuid
from app.features.properties.router.helpers import _selection_line_to_response
from app.features.properties.service import PropertyService
from app.models import User

router = APIRouter()


@router.get("/{property_uuid}/selection-lines")
async def list_selection_lines(
    property_id: int = Depends(resolve_property_uuid),
    service: PropertyService = Depends(get_property_service),
    node_repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
    user: User = Depends(get_current_user),
):
    """Get all selection lines (options) for a property."""
    prop = await service.get_property(property_id)
    if not prop:
        raise HTTPException(404, "Property not found")
    if prop.type != PropertyType.SELECTION:
        raise HTTPException(400, "Property is not a selection type")

    lines = await service.list_selection_lines(property_id)
    prop_uuid_map = {prop.id: prop.uuid} if prop.id is not None else {}
    return {
        "selection_lines": [
            _selection_line_to_response(line, property_uuid=prop_uuid_map.get(line.property_id))
            for line in lines
        ]
    }


@router.post("/{property_uuid}/selection-lines")
async def add_selection_line(
    property_id: int = Depends(resolve_property_uuid),
    request: SelectionLineRequest = ...,
    service: PropertyService = Depends(get_property_service),
    node_repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
    user: User = Depends(get_current_user),
):
    """Add a selection line (option) to a property."""
    try:
        line = await service.add_selection_line(
            property_id,
            request.name,
            icon=request.icon,
            color=request.color,
            order=request.order,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    prop = await property_repo.get_by_id(property_id)
    return _selection_line_to_response(line, property_uuid=prop.uuid if prop else None)


@router.put("/{property_uuid}/selection-lines/{selection_line_uuid}")
async def update_selection_line(
    property_id: int = Depends(resolve_property_uuid),
    line_id: int = Depends(resolve_selection_line_uuid),
    request: SelectionLineUpdateRequest = ...,
    service: PropertyService = Depends(get_property_service),
    node_repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
    user: User = Depends(get_current_user),
):
    """Update a selection line."""
    line = await service.update_selection_line(
        line_id,
        name=request.name,
        icon=request.icon,
        color=request.color,
        order=request.order,
    )

    if not line:
        raise HTTPException(404, "Selection line not found")

    prop = await property_repo.get_by_id(property_id)
    return _selection_line_to_response(line, property_uuid=prop.uuid if prop else None)


@router.get("/{property_uuid}/selection-lines/{selection_line_uuid}/can-delete")
async def check_can_delete_selection_line(
    property_id: int = Depends(resolve_property_uuid),
    line_id: int = Depends(resolve_selection_line_uuid),
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Check if a selection line can be deleted."""
    can_delete, reason = await service.can_delete_selection_line(line_id)
    return {"can_delete": can_delete, "reason": reason}


@router.delete("/{property_uuid}/selection-lines/{selection_line_uuid}")
async def delete_selection_line(
    property_id: int = Depends(resolve_property_uuid),
    line_id: int = Depends(resolve_selection_line_uuid),
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Delete a selection line (only if not in use)."""
    try:
        success = await service.delete_selection_line(line_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    if not success:
        raise HTTPException(404, "Selection line not found")
    return {"status": "ok"}
