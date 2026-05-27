"""Selection lines (options) endpoints for selection-type properties."""

from fastapi import APIRouter, Depends, HTTPException

from ...domain.entities import PropertyType
from ...models import User
from ..auth import get_current_user
from .helpers import _get_property_repo
from .models import SelectionLineRequest, SelectionLineResponse, SelectionLineUpdateRequest

router = APIRouter()


@router.get("/{property_id}/selection-lines")
async def list_selection_lines(
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Get all selection lines (options) for a property."""
    repo = await _get_property_repo(user)

    prop = await repo.get_by_id(property_id)
    if not prop:
        raise HTTPException(404, "Property not found")

    if prop.type != PropertyType.SELECTION:
        raise HTTPException(400, "Property is not a selection type")

    lines = await repo.get_selection_lines(property_id)
    return {
        "selection_lines": [
            SelectionLineResponse(
                id=l.id,  # type: ignore[arg-type]  # id is set for persisted lines
                property_id=l.property_id,
                name=l.name,
                icon=l.icon,
                color=l.color,
                order=l.order,
            )
            for l in lines
        ]
    }


@router.post("/{property_id}/selection-lines")
async def add_selection_line(
    property_id: int,
    request: SelectionLineRequest,
    user: User = Depends(get_current_user),
):
    """Add a selection line (option) to a property."""
    repo = await _get_property_repo(user)

    try:
        line = await repo.add_selection_line(
            property_id,
            request.name,
            request.icon,
            sequence=request.order,
            color=request.color,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    return SelectionLineResponse(
        id=line.id,  # type: ignore[arg-type]  # id is set for persisted lines
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
    user: User = Depends(get_current_user),
):
    """Update a selection line."""
    repo = await _get_property_repo(user)

    line = await repo.update_selection_line(
        line_id,
        name=request.name,
        icon=request.icon,
        order=request.order,
        color=request.color,
    )

    if not line:
        raise HTTPException(404, "Selection line not found")

    return SelectionLineResponse(
        id=line.id,  # type: ignore[arg-type]  # id is set for persisted lines
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
    user: User = Depends(get_current_user),
):
    """Check if a selection line can be deleted."""
    repo = await _get_property_repo(user)

    can_delete, reason = await repo.can_delete_selection_line(line_id)
    return {"can_delete": can_delete, "reason": reason}


@router.delete("/{property_id}/selection-lines/{line_id}")
async def delete_selection_line(
    property_id: int,
    line_id: int,
    user: User = Depends(get_current_user),
):
    """Delete a selection line (only if not in use)."""
    repo = await _get_property_repo(user)

    try:
        success = await repo.delete_selection_line(line_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    if not success:
        raise HTTPException(404, "Selection line not found")

    return {"status": "ok"}
