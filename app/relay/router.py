"""FastAPI router for the encrypted operation relay."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.relay.dependencies import get_actor_id, get_relay_service
from app.relay.models import (
    BatchRequest,
    CatchUpPaginatedResponse,
    CatchUpRequest,
)
from app.relay.permissions import PermissionDeniedError
from app.relay.service import RelayService
from app.relay.websocket import websocket_endpoint

router = APIRouter(prefix="/api/relay", tags=["relay"])


@router.post("/batch")
async def receive_batch(
    batch: BatchRequest,
    actor_id: str = Depends(get_actor_id),
    service: RelayService = Depends(get_relay_service),
) -> dict[str, int | list[str]]:
    """Accept an encrypted batch of operation envelopes."""
    if actor_id == "anonymous":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required to submit batches.",
        )
    try:
        saved = await service.receive_batch(batch, actor_id)
    except PermissionDeniedError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc
    return {"saved_count": len(saved), "saved_ids": [envelope.id for envelope in saved]}


@router.post("/catch-up")
async def catch_up(
    request: CatchUpRequest,
    share_token: str | None = Query(None),
    actor_id: str = Depends(get_actor_id),
    service: RelayService = Depends(get_relay_service),
) -> CatchUpPaginatedResponse:
    """Serve encrypted operation envelopes newer than the given HLC."""
    if actor_id == "anonymous" and share_token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication or a valid share token is required to catch up.",
        )
    try:
        limit = min(request.limit, 10_000)
        envelopes, next_after_id = await service.catch_up_paginated(
            request.workspace_id,
            actor_id,
            request.hlc,
            limit=limit,
            after_id=request.after_id,
            share_token=share_token,
        )
    except PermissionDeniedError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc
    return CatchUpPaginatedResponse(
        envelopes=envelopes,
        next_after_id=next_after_id,
        has_more=next_after_id is not None,
    )


@router.get("/snapshot")
def snapshot() -> None:
    """Placeholder for snapshot-based catch-up support.

    Snapshot sync will be implemented in a later phase; this endpoint reserves
    the route and returns a clear 501 Not Implemented response.
    """
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Snapshot sync is not implemented yet.",
    )


router.add_api_websocket_route("/ws/{workspace_id}", websocket_endpoint)
