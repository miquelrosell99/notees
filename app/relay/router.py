"""FastAPI router for the operation relay."""

from __future__ import annotations

import base64
import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi_limiter.depends import RateLimiter
from pyrate_limiter import Duration, Limiter, Rate

from app.dependencies import get_current_user
from app.models import User
from app.rate_limit import PerKeyBucketFactory, user_identifier
from app.relay.dependencies import (
    get_actor_id,
    get_relay_service,
    get_workspace_restore_epoch,
    require_workspace_owner_or_admin,
)
from app.relay.key_router import router as key_router
from app.relay.models import (
    BatchRequest,
    CatchUpPaginatedResponse,
    CatchUpRequest,
    CompactRequest,
    CompactResponse,
    LatestSnapshotResponse,
    RelayStatsResponse,
    SnapshotRequest,
    SnapshotResponse,
)
from app.relay.permissions import PermissionDeniedError
from app.relay.service import RelayService
from app.relay.websocket import websocket_endpoint

router = APIRouter(prefix="/api/relay", tags=["relay"])

router.include_router(key_router)

# Per-actor/workspace batch submission limit: 30,000 envelopes per minute.
# The frontend currently pushes one envelope per request during catch-up, so
# this needs to be high enough for initial sync of large workspaces.
_relay_batch_limiter = Limiter(PerKeyBucketFactory([Rate(30_000, Duration.MINUTE)]))

# Per-actor catch-up request limit: 600 requests per minute.
# Large workspaces can have 100k+ operations; paging at 10k per request still
# needs ~10 requests, so the old 60/min limit was too easy to hit.
_relay_catchup_limiter = Limiter(PerKeyBucketFactory([Rate(600, Duration.MINUTE)]))


async def relay_batch_identifier(request: Request) -> str:
    """Rate-limit key combining actor and target workspace."""
    actor = await user_identifier(request)
    workspace_id: str | None = None
    try:
        body = await request.body()
        if body:
            data = json.loads(body)
            workspace_id = data.get("workspace_id")
            if not workspace_id and data.get("envelopes"):
                workspace_id = data["envelopes"][0].get("workspace_id")
    except Exception:
        workspace_id = None
    return f"relay:batch:{actor}:{workspace_id or 'unknown'}"


async def relay_catchup_identifier(request: Request) -> str:
    """Rate-limit key for catch-up requests (per actor)."""
    actor = await user_identifier(request)
    return f"relay:catchup:{actor}"


@router.post(
    "/batch",
    dependencies=[
        Depends(
            RateLimiter(
                limiter=_relay_batch_limiter,
                identifier=relay_batch_identifier,
            )
        ),
    ],
)
async def receive_batch(
    batch: BatchRequest,
    response: Response,
    actor_id: str = Depends(get_actor_id),
    service: RelayService = Depends(get_relay_service),
) -> dict[str, int | list[str]]:
    """Accept a batch of operation envelopes."""
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
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    response.headers["X-RateLimit-Limit"] = "30000"
    return {"saved_count": len(saved), "saved_ids": [envelope.id for envelope in saved]}


async def _catch_up_restore_epoch(request: CatchUpRequest) -> int:
    return await get_workspace_restore_epoch(request.workspace_id)


@router.post(
    "/catch-up",
    dependencies=[
        Depends(
            RateLimiter(
                limiter=_relay_catchup_limiter,
                identifier=relay_catchup_identifier,
            )
        ),
    ],
)
async def catch_up(
    request: CatchUpRequest,
    share_token: str | None = Query(None),
    actor_id: str = Depends(get_actor_id),
    service: RelayService = Depends(get_relay_service),
    restore_epoch: int = Depends(_catch_up_restore_epoch),
) -> CatchUpPaginatedResponse:
    """Serve operation envelopes newer than the given HLC."""
    if actor_id == "anonymous" and share_token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication or a valid share token is required to catch up.",
        )
    try:
        limit = min(request.limit, 10_000)
        if limit < 1:
            limit = 1000
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
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    return CatchUpPaginatedResponse(
        envelopes=envelopes,
        next_after_id=next_after_id,
        has_more=next_after_id is not None,
        restore_epoch=restore_epoch,
    )


@router.post(
    "/snapshot",
    response_model=SnapshotResponse,
    dependencies=[
        Depends(
            RateLimiter(
                limiter=_relay_batch_limiter,
                identifier=relay_batch_identifier,
            )
        ),
    ],
)
async def create_snapshot(
    request: SnapshotRequest,
    user: User = Depends(get_current_user),  # noqa: B008
    service: RelayService = Depends(get_relay_service),
) -> SnapshotResponse:
    """Create a relay snapshot up to the given HLC.

    Requires admin role or workspace ownership.
    """
    await require_workspace_owner_or_admin(request.workspace_id, user)
    try:
        snapshot_id = await service.create_snapshot(
            request.workspace_id,
            request.up_to_hlc,
            data=request.data,
        )
    except PermissionDeniedError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    return SnapshotResponse(
        snapshot_id=snapshot_id,
        workspace_id=request.workspace_id,
        up_to_hlc=request.up_to_hlc,
    )


@router.post(
    "/compact",
    response_model=CompactResponse,
    dependencies=[
        Depends(
            RateLimiter(
                limiter=_relay_batch_limiter,
                identifier=relay_batch_identifier,
            )
        ),
    ],
)
async def compact_operations(
    request: CompactRequest,
    user: User = Depends(get_current_user),  # noqa: B008
    service: RelayService = Depends(get_relay_service),
) -> CompactResponse:
    """Compact relay envelopes up to the given HLC.

    Requires admin role or workspace ownership.
    """
    await require_workspace_owner_or_admin(request.workspace_id, user)
    try:
        result = await service.create_compaction_segment(
            request.workspace_id,
            request.up_to_hlc,
            prune=request.prune,
            data=request.data,
        )
    except PermissionDeniedError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    return CompactResponse(
        snapshot_id=result["snapshot_id"],
        segment_id=result["segment_id"],
        workspace_id=request.workspace_id,
        up_to_hlc=request.up_to_hlc,
        operation_count=result["operation_count"],
    )


@router.get("/snapshot")
async def get_latest_snapshot(
    workspace_id: str = Query(...),
    share_token: str | None = Query(None),
    actor_id: str = Depends(get_actor_id),
    service: RelayService = Depends(get_relay_service),
    restore_epoch: int = Depends(get_workspace_restore_epoch),
) -> LatestSnapshotResponse:
    """Return the newest snapshot for a workspace.

    Clients can restore the returned SQLite database bytes and then catch up
    only operations newer than the snapshot HLC.
    """
    if actor_id == "anonymous" and share_token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication or a valid share token is required.",
        )
    try:
        snapshot = await service.get_latest_snapshot_for_actor(
            workspace_id, actor_id, share_token
        )
    except PermissionDeniedError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc

    if snapshot is None:
        return LatestSnapshotResponse(
            snapshot_id="",
            workspace_id=workspace_id,
            hlc={"physical": 0, "logical": 0},
            data_base64="",
            has_snapshot=False,
            restore_epoch=restore_epoch,
        )

    return LatestSnapshotResponse(
        snapshot_id=snapshot["id"],
        workspace_id=workspace_id,
        hlc=snapshot["hlc"],
        data_base64=base64.b64encode(snapshot["data"]).decode("ascii"),
        has_snapshot=True,
        restore_epoch=restore_epoch,
    )


router.add_api_websocket_route("/ws/{workspace_id}", websocket_endpoint)


@router.get("/stats")
async def get_relay_stats(
    workspace_id: str = Query(...),
    actor_id: str = Depends(get_actor_id),
    service: RelayService = Depends(get_relay_service),
    restore_epoch: int = Depends(get_workspace_restore_epoch),
) -> RelayStatsResponse:
    """Return operational statistics for a workspace relay.

    Requires read access to the workspace.
    """
    if actor_id == "anonymous":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required to view relay stats.",
        )
    try:
        stats = await service.get_workspace_stats(workspace_id, actor_id)
    except PermissionDeniedError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc

    return RelayStatsResponse(
        workspace_id=workspace_id,
        envelope_count=stats["envelope_count"],
        envelope_size_bytes=stats["envelope_size_bytes"],
        snapshot_count=stats["snapshot_count"],
        latest_snapshot_hlc=stats["latest_snapshot_hlc"],
        compacted_segment_count=stats["compacted_segment_count"],
        compacted_operation_count=stats["compacted_operation_count"],
        max_hlc=stats["max_hlc"],
        restore_epoch=restore_epoch,
    )
