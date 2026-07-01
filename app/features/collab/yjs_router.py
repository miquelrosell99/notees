"""REST endpoints for Yjs CRDT state."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response

from app.config import settings
from app.dependencies import get_current_user, require_read_or_write_scope, require_write_scope
from app.models import User

from .yjs_dependencies import get_yjs_service
from .yjs_service import YjsService

router = APIRouter(
    prefix="/nodes",
    tags=["Yjs"],
    dependencies=[Depends(get_current_user), Depends(require_read_or_write_scope)],
)


@router.get("/{node_uuid}/yjs_state")
async def get_yjs_state(
    node_uuid: str,
    user: User = Depends(get_current_user),  # noqa: B008
    service: YjsService = Depends(get_yjs_service),
) -> Response:
    """Return the current merged Yjs update blob for a node."""
    blob = await service.get_state(node_uuid)
    return Response(
        content=blob if blob is not None else b"",
        media_type="application/octet-stream",
    )


@router.post(
    "/{node_uuid}/yjs_update",
    dependencies=[Depends(require_write_scope)],
)
async def apply_yjs_update(
    node_uuid: str,
    request: Request,
    user: User = Depends(get_current_user),  # noqa: B008
    service: YjsService = Depends(get_yjs_service),
) -> dict[str, str]:
    """Append a raw Yjs update to the stored state blob."""
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            size = int(content_length)
        except ValueError:
            size = 0
        if size > settings.yjs_max_update_size_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"Yjs update too large. Maximum size is {settings.yjs_max_update_size_bytes} bytes.",
            )
    body = await request.body()
    if len(body) > settings.yjs_max_update_size_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Yjs update too large. Maximum size is {settings.yjs_max_update_size_bytes} bytes.",
        )
    await service.apply_update(node_uuid, body)
    return {"status": "ok"}
