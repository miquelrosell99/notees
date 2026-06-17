"""Public share link endpoints for nodes (node-scoped)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from fastapi_limiter.depends import RateLimiter
from pydantic import BaseModel
from pyrate_limiter import Duration, Limiter, Rate

from ...auth import hash_password
from ...dependencies import _get_share_service, get_current_user, get_share_repository
from ...domain.repositories.interfaces import ShareRepository
from ...logging_config import get_logger
from ...models import User
from ...node_export import write_share_html

logger = get_logger(__name__)
_node_shares_limiter = Limiter(Rate(30, Duration.MINUTE))
router = APIRouter()


def _share_to_response(share, request: Request | None = None) -> dict:
    """Convert a PublicShare entity to a response dict."""
    url = f"/s/{share.uuid}"
    if request is not None:
        base_url = str(request.base_url).rstrip("/")
        url = f"{base_url}/s/{share.uuid}"
    return {
        "share_uuid": share.uuid,
        "node_id": share.node_id,
        "created_at": share.created_at,
        "expiry_date": share.expiry_date,
        "url": url,
    }


class PublicShareCreateRequest(BaseModel):
    expiry_date: str | None = None
    password: str | None = None


@router.post(
    "/{node_id}/shares",
    dependencies=[Depends(RateLimiter(limiter=_node_shares_limiter))],
)
async def create_share(
    request: Request,
    node_id: int = Path(..., ge=1),
    body: PublicShareCreateRequest = ...,  # type: ignore[assignment]
    user: User = Depends(get_current_user),  # noqa: B008
    share_repo: ShareRepository = Depends(get_share_repository),
):
    """Create a new public share link for a node."""
    service = await _get_share_service(user)
    try:
        share = await service.create_share(node_id, expiry_date=body.expiry_date)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    # Store password hash if provided
    if body.password:
        await share_repo.set_share_password(share.id, hash_password(body.password))

    # Generate static HTML for the share
    try:
        node = await service.get_node_by_id(node_id)
        if node is not None:
            await write_share_html(share.uuid, share.workspace_id, node.uuid)
    except (OSError, ValueError):
        logger.exception(f"Failed to generate static HTML for share {share.uuid}")

    return _share_to_response(share, request)


@router.get("/{node_id}/shares")
async def list_node_shares(
    node_id: int = Path(..., ge=1),
    user: User = Depends(get_current_user),  # noqa: B008
):
    """List all active shares for a node."""
    service = await _get_share_service(user)
    shares = await service.list_shares_for_node(node_id)
    return {"shares": [_share_to_response(s) for s in shares]}


class UserShareCreateRequest(BaseModel):
    email: str
    permission: str = "read"  # read, write


class UserShareResponse(BaseModel):
    share_id: int
    node_id: int
    shared_with_user_id: int
    shared_with_email: str
    permission: str
    created_at: str
    created_by: int


@router.post("/{node_id}/user-shares")
async def create_user_share(
    node_id: int = Path(..., ge=1),
    body: UserShareCreateRequest = ...,  # type: ignore[assignment]
    user: User = Depends(get_current_user),  # noqa: B008
    share_repo: ShareRepository = Depends(get_share_repository),
):
    """Share a node with a specific user."""
    workspace_id = share_repo.workspace_id
    user_id = int(user.id)

    try:
        result = await share_repo.create_node_user_share(
            node_id, workspace_id, user_id, body.email, body.permission
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    if result is None:
        raise HTTPException(status_code=500, detail="Failed to create share")

    # Pending invite result
    if result.get("status") == "pending":
        return result

    return {
        "share_id": result["id"],
        "node_id": result["node_id"],
        "shared_with_user_id": result["user_id"],
        "shared_with_email": body.email,
        "permission": "write" if result["can_write"] else "read",
        "created_at": result["create_date"].isoformat() if result["create_date"] else None,
        "created_by": result["create_uid"],
    }


@router.get("/{node_id}/user-shares")
async def list_node_user_shares(
    node_id: int = Path(..., ge=1),
    user: User = Depends(get_current_user),  # noqa: B008
    share_repo: ShareRepository = Depends(get_share_repository),
):
    """List user shares for a node."""
    workspace_id = share_repo.workspace_id
    user_id = int(user.id)

    try:
        _is_owner, rows = await share_repo.list_node_user_shares(node_id, workspace_id, user_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    return {
        "shares": [
            {
                "share_id": r["id"],
                "node_id": r["node_id"],
                "shared_with_user_id": r["user_id"],
                "shared_with_email": r["email"],
                "permission": "write" if r["can_write"] else "read",
                "created_at": r["create_date"].isoformat() if r["create_date"] else None,
                "created_by": r["create_uid"],
            }
            for r in rows
        ]
    }


@router.delete("/user-shares/{share_id}")
async def revoke_user_share(
    share_id: int,
    user: User = Depends(get_current_user),  # noqa: B008
    share_repo: ShareRepository = Depends(get_share_repository),
):
    """Revoke a user share."""
    workspace_id = share_repo.workspace_id
    user_id = int(user.id)

    try:
        result = await share_repo.revoke_user_share(share_id, workspace_id, user_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    if result is None:
        raise HTTPException(status_code=404, detail="Share not found")

    return {"success": True}
