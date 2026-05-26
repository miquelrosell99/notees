"""Workspace-level public share endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from slowapi import Limiter
from slowapi.util import get_remote_address

from ..db.connection import get_pool
from ..dependencies import _get_workspace_context_cached
from ..domain.repositories import PostgresNodeRepository, PostgresShareRepository
from ..domain.services.share_service import ShareService
from ..logging_config import get_logger
from ..models import User
from .auth import get_current_user

logger = get_logger(__name__)
limiter = Limiter(key_func=get_remote_address)
router = APIRouter(prefix="/api/shares", tags=["Shares"])


async def _get_share_service(user: User) -> ShareService:
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)
    share_repo = PostgresShareRepository(pool, workspace_id, user_id)
    node_repo = PostgresNodeRepository(pool, workspace_id, user_id)
    return ShareService(share_repo, node_repo, workspace_id, user_id)


def _share_to_response(share) -> dict:
    return {
        "share_uuid": share.uuid,
        "node_id": share.node_id,
        "created_at": share.created_at,
        "expiry_date": share.expiry_date,
        "url": f"/s/{share.uuid}",
        "node_name": getattr(share, "_node_name", None),
        "node_uuid": getattr(share, "_node_uuid", None),
    }


@router.get("")
async def list_workspace_shares(
    user: User = Depends(get_current_user),  # noqa: B008
):
    """List all active shares in the current workspace."""
    service = await _get_share_service(user)
    shares = await service.list_workspace_shares()
    return {"shares": [_share_to_response(s) for s in shares]}


@router.delete("/{share_uuid}")
async def delete_share(
    share_uuid: str,
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Revoke a public share link."""
    service = await _get_share_service(user)
    try:
        success = await service.delete_share(share_uuid)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    if not success:
        raise HTTPException(status_code=404, detail="Share not found")
    return {"success": True}
