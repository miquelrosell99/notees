"""REST endpoints for Yjs CRDT state."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response

from .yjs_dependencies import get_yjs_service
from .yjs_service import YjsService

router = APIRouter(prefix="/nodes", tags=["Yjs"])


@router.get("/{node_uuid}/yjs_state")
async def get_yjs_state(
    node_uuid: str,
    service: YjsService = Depends(get_yjs_service),
) -> Response:
    """Return the current merged Yjs update blob for a node."""
    blob = await service.get_state(node_uuid)
    return Response(
        content=blob if blob is not None else b"",
        media_type="application/octet-stream",
    )


@router.post("/{node_uuid}/yjs_update")
async def apply_yjs_update(
    node_uuid: str,
    request: Request,
    service: YjsService = Depends(get_yjs_service),
) -> dict[str, str]:
    """Append a raw Yjs update to the stored state blob."""
    body = await request.body()
    await service.apply_update(node_uuid, body)
    return {"status": "ok"}
