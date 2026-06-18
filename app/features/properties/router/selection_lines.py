"""Selection lines (options) endpoints for selection-type properties."""

from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import get_current_user
from app.domain.entities import PropertyType
from app.features.properties.dependencies import get_property_service
from app.features.properties.models import SelectionLineRequest, SelectionLineResponse, SelectionLineUpdateRequest
from app.features.properties.service import PropertyService
from app.models import User

router = APIRouter()


@router.get("/{property_id}/selection-lines")
async def list_selection_lines(
    property_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Get all selection lines (options) for a property."""
    prop = await service.get_property(property_id)
    if not prop:
        raise HTTPException(404, "Property not found")
    if prop.type != PropertyType.SELECTION:
        raise HTTPException(400, "Property is not a selection type")

    lines = await service.list_selection_lines(property_id)
    return {
        "selection_lines": [
            SelectionLineResponse(
                id=line.id,  # type: ignore[arg-type]
                property_id=line.property_id,
                name=line.name,
                icon=line.icon,
                color=line.color,
                order=line.order,
            )
            for line in lines
        ]
    }


@router.post("/{property_id}/selection-lines")
async def add_selection_line(
    property_id: int,
    request: SelectionLineRequest,
    service: PropertyService = Depends(get_property_service),
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

    return SelectionLineResponse(
        id=line.id,  # type: ignore[arg-type]
        property_id=line.property_id,
        name=line.name,
        icon=line.icon,
        color=line.color,
        order=line.order,
    )


@router.put("/{property_id}/selection-lines/{line_id}")
async def update_selection_line(
    property_id: int,
    line_id: int,
    request: SelectionLineUpdateRequest,
    service: PropertyService = Depends(get_property_service),
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

    return SelectionLineResponse(
        id=line.id,  # type: ignore[arg-type]
        property_id=line.property_id,
        name=line.name,
        icon=line.icon,
        color=line.color,
        order=line.order,
    )


@router.get("/{property_id}/selection-lines/{line_id}/can-delete")
async def check_can_delete_selection_line(
    property_id: int,
    line_id: int,
    service: PropertyService = Depends(get_property_service),
    user: User = Depends(get_current_user),
):
    """Check if a selection line can be deleted."""
    can_delete, reason = await service.can_delete_selection_line(line_id)
    return {"can_delete": can_delete, "reason": reason}


@router.delete("/{property_id}/selection-lines/{line_id}")
async def delete_selection_line(
    property_id: int,
    line_id: int,
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
