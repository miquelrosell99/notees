"""FastAPI router for the operation relay."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi_limiter.depends import RateLimiter
from pyrate_limiter import Duration, Limiter, Rate

from app.core.clock import Hlc
from app.dependencies import get_current_user
from app.models import User
from app.rate_limit import PerKeyBucketFactory, user_identifier
from app.relay.dependencies import (
    get_actor_id,
    get_relay_service,
    get_workspace_restore_epoch,
    require_workspace_owner_or_admin,
)
from app.relay.models import (
    BatchRequest,
    CatchUpPaginatedResponse,
    CatchUpRequest,
    CompactRequest,
    CompactResponse,
    EncryptionKeyRequest,
    EncryptionKeyResponse,
    LatestSnapshotResponse,
    MemberKeyEntry,
    MemberKeysDeleteResponse,
    MemberKeysRequest,
    MemberKeysResponse,
    RelayStatsResponse,
    SnapshotResponse,
    UserPublicKeyRequest,
    UserPublicKeyResponse,
)
from app.relay.permissions import PermissionDeniedError
from app.relay.service import RelayService
from app.relay.websocket import websocket_endpoint

router = APIRouter(prefix="/api/relay", tags=["relay"])

# Per-actor/workspace batch submission limit: 30,000 envelopes per minute,
# counted per envelope (not per request) inside the handler, where the parsed
# batch size is known. The frontend pushes in 100-envelope chunks, so this
# allows ~300 chunk requests per minute.
_relay_batch_limiter = Limiter(PerKeyBucketFactory([Rate(30_000, Duration.MINUTE)]))

# Per-actor catch-up request limit: 600 requests per minute.
# Large workspaces can have 100k+ operations; paging at 10k per request still
# needs ~10 requests, so the old 60/min limit was too easy to hit.
_relay_catchup_limiter = Limiter(PerKeyBucketFactory([Rate(600, Duration.MINUTE)]))

# Snapshot downloads serve a full derived-database blob; keep them scarcer
# than catch-up pages.
_relay_snapshot_limiter = Limiter(PerKeyBucketFactory([Rate(60, Duration.MINUTE)]))

# Stats are cheap but were previously unlimited.
_relay_stats_limiter = Limiter(PerKeyBucketFactory([Rate(120, Duration.MINUTE)]))

# Snapshot/compact uploads are owner/admin-only maintenance operations.
_relay_admin_limiter = Limiter(PerKeyBucketFactory([Rate(30, Duration.MINUTE)]))


def _workspace_id_from_path_or_query(request: Request) -> str | None:
    """Return a workspace id from the request path/query parameters, if any."""
    return request.path_params.get("workspace_id") or request.query_params.get("workspace_id")


async def relay_catchup_identifier(request: Request) -> str:
    """Rate-limit key for catch-up requests (per actor and workspace)."""
    actor = await user_identifier(request)
    workspace_id = _workspace_id_from_path_or_query(request)
    return f"relay:catchup:{actor}:{workspace_id or 'unknown'}"


async def relay_snapshot_identifier(request: Request) -> str:
    """Rate-limit key for snapshot downloads (per actor and workspace)."""
    actor = await user_identifier(request)
    workspace_id = _workspace_id_from_path_or_query(request)
    return f"relay:snapshot:{actor}:{workspace_id or 'unknown'}"


async def relay_stats_identifier(request: Request) -> str:
    """Rate-limit key for relay stats (per actor and workspace)."""
    actor = await user_identifier(request)
    workspace_id = _workspace_id_from_path_or_query(request)
    return f"relay:stats:{actor}:{workspace_id or 'unknown'}"


async def relay_admin_identifier(request: Request) -> str:
    """Rate-limit key for snapshot/compact uploads (per actor and workspace)."""
    actor = await user_identifier(request)
    workspace_id = _workspace_id_from_path_or_query(request)
    return f"relay:admin:{actor}:{workspace_id or 'unknown'}"


async def _enforce_batch_rate_limit(batch: BatchRequest, actor_id: str) -> None:
    """Charge the batch rate limiter per envelope, not per request.

    Runs inside the handler because the envelope count and target workspace
    are only known after the body is parsed; the dependency-level identifier
    deliberately never reparses the request body.
    """
    workspace_ids = {envelope.workspace_id for envelope in batch.envelopes}
    workspace_id = workspace_ids.pop() if len(workspace_ids) == 1 else "unknown"
    key = f"relay:batch:user:{actor_id}:{workspace_id}"
    allowed = await _relay_batch_limiter.try_acquire_async(
        key,
        weight=max(len(batch.envelopes), 1),
        blocking=False,
    )
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Relay batch rate limit exceeded (30,000 envelopes per minute).",
        )


@router.post("/batch")
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
    await _enforce_batch_rate_limit(batch, actor_id)
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
    """Serve operation envelopes newer than the given seq cursor."""
    if actor_id == "anonymous" and share_token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication or a valid share token is required to catch up.",
        )
    share_node_id: str | None = None
    if share_token is not None:
        share_node_id = await service.get_public_share_node_id(
            request.workspace_id,
            share_token,
        )
        if share_node_id is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Invalid or expired share token.",
            )
    try:
        limit = min(request.limit, 10_000)
        if limit < 1:
            limit = 1000
        envelopes, next_after_seq = await service.catch_up_paginated(
            request.workspace_id,
            actor_id,
            request.after_seq,
            limit=limit,
            share_token=share_token,
            share_node_id=share_node_id,
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
    has_more = next_after_seq is not None
    if not has_more and envelopes:
        # Advance the cursor past the final page too, so HTTP-only clients
        # (which have no WS hello.latestSeq) don't re-fetch the tail on the
        # next pull. has_more still distinguishes pagination from completion.
        next_after_seq = envelopes[-1].seq
    return CatchUpPaginatedResponse(
        envelopes=envelopes,
        next_after_seq=next_after_seq,
        has_more=has_more,
        restore_epoch=restore_epoch,
    )


@router.put(
    "/snapshot/data",
    response_model=SnapshotResponse,
    dependencies=[
        Depends(
            RateLimiter(
                limiter=_relay_admin_limiter,
                identifier=relay_admin_identifier,
            )
        ),
    ],
)
async def upload_snapshot_data(
    request: Request,
    workspace_id: str = Query(...),
    physical: int = Query(...),
    logical: int = Query(...),
    user: User = Depends(get_current_user),  # noqa: B008
    service: RelayService = Depends(get_relay_service),
) -> SnapshotResponse:
    """Create a relay snapshot from a raw binary body (no base64-in-JSON).

    Requires admin role or workspace ownership.
    """
    await require_workspace_owner_or_admin(workspace_id, user)
    data = await request.body()
    try:
        snapshot_id, up_to_seq = await service.create_snapshot(
            workspace_id,
            Hlc(physical=physical, logical=logical),
            data=data,
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
        workspace_id=workspace_id,
        up_to_hlc=Hlc(physical=physical, logical=logical),
        up_to_seq=up_to_seq,
    )


@router.post(
    "/compact",
    response_model=CompactResponse,
    dependencies=[
        Depends(
            RateLimiter(
                limiter=_relay_admin_limiter,
                identifier=relay_admin_identifier,
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


@router.get(
    "/snapshot",
    dependencies=[
        Depends(
            RateLimiter(
                limiter=_relay_snapshot_limiter,
                identifier=relay_snapshot_identifier,
            )
        ),
    ],
)
async def get_latest_snapshot(
    workspace_id: str = Query(...),
    actor_id: str = Depends(get_actor_id),
    service: RelayService = Depends(get_relay_service),
    restore_epoch: int = Depends(get_workspace_restore_epoch),
) -> LatestSnapshotResponse:
    """Return the newest snapshot's metadata (HLC, seq cursor) — no blob.

    The blob is served as a raw binary body by ``GET /snapshot/data``;
    splitting metadata from data keeps the probe cheap and avoids the
    +33% base64 overhead and full-buffer JSON allocation on large
    workspaces.

    Snapshots contain the full derived database for the workspace, so they
    are served to authenticated workspace members only. Public share tokens
    are deliberately not accepted here: share readers get node-filtered
    catch-up instead of a full-workspace download.
    """
    if actor_id == "anonymous":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required to read snapshots.",
        )
    try:
        snapshot = await service.get_latest_snapshot_metadata_for_actor(workspace_id, actor_id)
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
            has_snapshot=False,
            restore_epoch=restore_epoch,
        )

    return LatestSnapshotResponse(
        snapshot_id=snapshot["id"],
        workspace_id=workspace_id,
        hlc=snapshot["hlc"],
        has_snapshot=True,
        restore_epoch=restore_epoch,
        up_to_seq=snapshot["up_to_seq"],
    )


@router.get(
    "/snapshot/data",
    dependencies=[
        Depends(
            RateLimiter(
                limiter=_relay_snapshot_limiter,
                identifier=relay_snapshot_identifier,
            )
        ),
    ],
)
async def get_latest_snapshot_data(
    workspace_id: str = Query(...),
    actor_id: str = Depends(get_actor_id),
    service: RelayService = Depends(get_relay_service),
) -> Response:
    """Return the newest snapshot's blob as a raw binary body (404 if none).

    Members only, same rule as the metadata endpoint.
    """
    if actor_id == "anonymous":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required to read snapshots.",
        )
    try:
        snapshot = await service.get_latest_snapshot_for_actor(workspace_id, actor_id)
    except PermissionDeniedError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc

    if snapshot is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No snapshot for this workspace.",
        )
    return Response(
        content=snapshot["data"],
        media_type="application/octet-stream",
    )


router.add_api_websocket_route("/ws/{workspace_id}", websocket_endpoint)


@router.get(
    "/encryption-key",
    response_model=EncryptionKeyResponse,
    dependencies=[
        Depends(
            RateLimiter(
                limiter=_relay_stats_limiter,
                identifier=relay_stats_identifier,
            )
        ),
    ],
)
async def get_encryption_key(
    workspace_id: str = Query(...),
    actor_id: str = Depends(get_actor_id),
    service: RelayService = Depends(get_relay_service),
) -> EncryptionKeyResponse:
    """Return the workspace's wrapped E2EE key blob (members only, SPEC §8).

    The blob is opaque: it is the workspace key wrapped client-side with a
    passphrase-derived KEK, so the server cannot unwrap it. ``enabled`` is
    false when the workspace has no E2EE key registered.
    """
    if actor_id == "anonymous":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required to read the workspace encryption key.",
        )
    try:
        wrapped_key = await service.get_workspace_wrapped_key(workspace_id, actor_id)
        # The wrapped-key read above already gated workspace membership; this
        # fetches only the caller's own per-member wrapped copies (E2EE v2).
        member_keys = await service.get_member_keys(workspace_id, actor_id, actor_id)
    except PermissionDeniedError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc
    return EncryptionKeyResponse(
        workspace_id=workspace_id,
        wrapped_key=wrapped_key,
        enabled=wrapped_key is not None,
        member_keys=[MemberKeyEntry(**row) for row in member_keys],
    )


@router.put(
    "/encryption-key",
    response_model=EncryptionKeyResponse,
    dependencies=[
        Depends(
            RateLimiter(
                limiter=_relay_admin_limiter,
                identifier=relay_admin_identifier,
            )
        ),
    ],
)
async def put_encryption_key(
    request: EncryptionKeyRequest,
    user: User = Depends(get_current_user),  # noqa: B008
    service: RelayService = Depends(get_relay_service),
) -> EncryptionKeyResponse:
    """Store the workspace's wrapped E2EE key blob. Owner or admin only."""
    await require_workspace_owner_or_admin(request.workspace_id, user)
    await service.set_workspace_wrapped_key(request.workspace_id, request.wrapped_key)
    return EncryptionKeyResponse(
        workspace_id=request.workspace_id,
        wrapped_key=request.wrapped_key,
        enabled=True,
    )


@router.put(
    "/user-public-key",
    response_model=UserPublicKeyResponse,
    dependencies=[
        Depends(
            RateLimiter(
                limiter=_relay_admin_limiter,
                identifier=relay_admin_identifier,
            )
        ),
    ],
)
async def put_user_public_key(
    request: UserPublicKeyRequest,
    user: User = Depends(get_current_user),  # noqa: B008
    service: RelayService = Depends(get_relay_service),
) -> UserPublicKeyResponse:
    """Publish the caller's X25519 identity public key (E2EE v2, SPEC §8).

    Keyed by the caller's uuid: users can only publish for themselves.
    """
    await service.set_user_public_key(str(user.uuid), request.public_key)
    return UserPublicKeyResponse(user_id=str(user.uuid), public_key=request.public_key)


@router.get(
    "/user-public-key",
    response_model=UserPublicKeyResponse,
    dependencies=[
        Depends(
            RateLimiter(
                limiter=_relay_stats_limiter,
                identifier=relay_stats_identifier,
            )
        ),
    ],
)
async def get_user_public_key(
    user_id: str = Query(...),
    _user: User = Depends(get_current_user),  # noqa: B008
    service: RelayService = Depends(get_relay_service),
) -> UserPublicKeyResponse:
    """Return any user's published X25519 public key (authenticated callers)."""
    public_key = await service.get_user_public_key(user_id)
    return UserPublicKeyResponse(user_id=user_id, public_key=public_key)


@router.put(
    "/encryption-key/members",
    response_model=MemberKeysResponse,
    dependencies=[
        Depends(
            RateLimiter(
                limiter=_relay_admin_limiter,
                identifier=relay_admin_identifier,
            )
        ),
    ],
)
async def put_member_keys(
    request: MemberKeysRequest,
    user: User = Depends(get_current_user),  # noqa: B008
    service: RelayService = Depends(get_relay_service),
) -> MemberKeysResponse:
    """Upsert wrapped workspace-key copies for members. Owner or admin only.

    Only the submitted rows are written; other members' rows are untouched so
    incremental joins and rotation re-wraps can share the endpoint.
    """
    await require_workspace_owner_or_admin(request.workspace_id, user)
    for member in request.members:
        await service.set_member_key(
            request.workspace_id, member.user_id, member.key_version, member.wrapped_key
        )
    return MemberKeysResponse(workspace_id=request.workspace_id, stored=len(request.members))


@router.delete(
    "/encryption-key/members/{workspace_id}/{user_id}",
    response_model=MemberKeysDeleteResponse,
    dependencies=[
        Depends(
            RateLimiter(
                limiter=_relay_admin_limiter,
                identifier=relay_admin_identifier,
            )
        ),
    ],
)
async def delete_member_keys(
    workspace_id: str,
    user_id: str,
    user: User = Depends(get_current_user),  # noqa: B008
    service: RelayService = Depends(get_relay_service),
) -> MemberKeysDeleteResponse:
    """Delete all wrapped-key copies of one member. Owner or admin only.

    Part of member removal: the owner then rotates the workspace key and
    re-wraps it for the remaining members (E2EE v2, SPEC §8).
    """
    await require_workspace_owner_or_admin(workspace_id, user)
    deleted = await service.delete_member_keys(workspace_id, user_id)
    return MemberKeysDeleteResponse(workspace_id=workspace_id, user_id=user_id, deleted=deleted)


@router.get(
    "/stats",
    dependencies=[
        Depends(
            RateLimiter(
                limiter=_relay_stats_limiter,
                identifier=relay_stats_identifier,
            )
        ),
    ],
)
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
