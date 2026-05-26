"""Public share link endpoints for nodes (node-scoped)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from ...db.connection import get_pool
from ...dependencies import _get_workspace_context_cached
from ...domain.repositories import PostgresNodeRepository, PostgresShareRepository
from ...domain.services.share_service import ShareService
from ...logging_config import get_logger
from ...models import User
from ..auth import get_current_user

logger = get_logger(__name__)
limiter = Limiter(key_func=get_remote_address)
router = APIRouter()


async def _get_share_service(user: User) -> ShareService:
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    share_repo = PostgresShareRepository(pool, workspace_id, user_id)
    node_repo = PostgresNodeRepository(pool, workspace_id, user_id)
    return ShareService(share_repo, node_repo, workspace_id, user_id)


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


@router.post("/{node_id}/shares")
@limiter.limit("30/minute")
async def create_share(
    request: Request,
    node_id: int = Path(..., ge=1),
    body: dict | None = None,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Create a new public share link for a node."""
    service = await _get_share_service(user)
    body = body or {}
    expiry_date = body.get("expiry_date")
    try:
        share = await service.create_share(node_id, expiry_date=expiry_date)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
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
