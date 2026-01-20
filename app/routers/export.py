"""Export router (refactored).

Handles exporting nodes to various formats.
Uses domain types where applicable.
"""
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import Response

from ..models import ExportRequest, ExportFormat, User
from .auth import get_current_user

# Import legacy db - export is infrastructure-level
from .. import database as db

router = APIRouter(prefix="/api/export", tags=["Export"])


@router.post("")
async def export_nodes(request: ExportRequest, user: User = Depends(get_current_user)):
    """Export nodes to Markdown, HTML, or PDF."""
    try:
        content, filename, mime_type = await db.export_nodes(
            user.id,
            node_ids=request.node_ids,
            format=request.format,
            include_children=request.include_children
        )
        
        return Response(
            content=content,
            media_type=mime_type,
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"'
            }
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{node_id}")
async def export_single_node(
    node_id: str,
    format: str = "markdown",
    include_children: bool = True,
    user: User = Depends(get_current_user)
):
    """Export a single node."""
    try:
        export_format = ExportFormat(format)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid format: {format}")
    
    try:
        content, filename, mime_type = await db.export_nodes(
            user.id,
            node_ids=[node_id],
            format=export_format,
            include_children=include_children
        )
        
        return Response(
            content=content,
            media_type=mime_type,
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"'
            }
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
