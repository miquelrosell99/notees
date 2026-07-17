"""FastAPI router for the encrypted operation relay."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.relay.dependencies import get_actor_id, get_relay_service
from app.relay.models import BatchRequest, CatchUpRequest, CatchUpResponse
from app.relay.permissions import PermissionDeniedError
from app.relay.service import RelayService

router = APIRouter(prefix="/api/relay", tags=["relay"])


@router.post("/batch")
def receive_batch(
    batch: BatchRequest,
    actor_id: str = Depends(get_actor_id),
    service: RelayService = Depends(get_relay_service),
) -> dict[str, int | list[str]]:
    """Accept an encrypted batch of operation envelopes."""
    try:
        saved = service.receive_batch(batch, actor_id)
    except PermissionDeniedError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc
    return {"saved_count": len(saved), "saved_ids": [envelope.id for envelope in saved]}


@router.post("/catch-up")
def catch_up(
    request: CatchUpRequest,
    actor_id: str = Depends(get_actor_id),
    service: RelayService = Depends(get_relay_service),
) -> CatchUpResponse:
    """Serve encrypted operation envelopes newer than the given HLC."""
    try:
        envelopes = service.catch_up_from_request(request, actor_id)
    except PermissionDeniedError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc
    return CatchUpResponse(envelopes=envelopes)
