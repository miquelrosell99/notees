"""Workspace-level public share endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from ..dependencies import (
    _get_node_service,
    _get_node_service_for_workspace,
    _get_share_service,
    get_current_user,
    get_share_repository,
)
from ..domain.repositories.interfaces import ShareRepository
from ..logging_config import get_logger
from ..models import PaginatedResponse, User
from ..node_export import delete_share_html
from .nodes.helpers import _name_text, _resolve_referenced_display_names

logger = get_logger(__name__)
router = APIRouter(prefix="/shares", tags=["Shares"])


def _share_to_response(share, resolved_names: dict | None = None) -> dict:
    node_uuid = getattr(share, "_node_uuid", None)
    node_name_raw = getattr(share, "_node_name", None)
    if node_uuid and resolved_names:
        node_name = resolved_names.get(node_uuid) or _name_text(node_name_raw) or "Untitled"
    else:
        node_name = _name_text(node_name_raw) or "Untitled"
    return {
        "share_uuid": share.uuid,
        "node_id": share.node_id,
        "created_at": share.created_at,
        "expiry_date": share.expiry_date,
        "url": f"/s/{share.uuid}",
        "node_name": node_name,
        "node_uuid": node_uuid,
    }


@router.get("")
async def list_workspace_shares(
    user: User = Depends(get_current_user),  # noqa: B008
    share_repo: ShareRepository = Depends(get_share_repository),
):
    """List all active shares in the current workspace."""
    service = await _get_share_service(user)
    shares = await service.list_workspace_shares()

    # Resolve node names that contain inline links to plain text
    share_rows = [
        {"name": getattr(s, "_node_name", None), "uuid": getattr(s, "_node_uuid", None)}
        for s in shares
        if getattr(s, "_node_uuid", None)
    ]
    resolved = {}
    if share_rows:
        node_service = await _get_node_service(user)
        resolved = await _resolve_referenced_display_names(node_service, share_rows)

    return {"shares": [_share_to_response(s, resolved) for s in shares]}


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

    # Clean up static HTML file
    delete_share_html(share_uuid)

    return {"success": True}


@router.get("/inbox")
async def get_share_inbox(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    user: User = Depends(get_current_user),  # noqa: B008
    share_repo: ShareRepository = Depends(get_share_repository),
):
    """Get all nodes shared with the current user (share inbox)."""
    total, rows = await share_repo.list_share_inbox(int(user.id), page, page_size)

    # Resolve node names that contain inline links to plain text
    from collections import defaultdict

    workspace_rows: dict[int, list[dict]] = defaultdict(list)
    for r in rows:
        workspace_rows[r["workspace_id"]].append({"name": r["node_name"], "uuid": r["node_uuid"]})

    resolved: dict[str, str] = {}
    for ws_id, ws_rows in workspace_rows.items():
        node_service = await _get_node_service_for_workspace(user, ws_id)
        ws_resolved = await _resolve_referenced_display_names(node_service, ws_rows)
        resolved.update(ws_resolved)

    items = [
        {
            "share_id": r["id"],
            "node_id": r["node_id"],
            "node_uuid": str(r["node_uuid"]),
            "node_name": resolved.get(str(r["node_uuid"])) or _name_text(r["node_name"]) or "Untitled",
            "node_icon": r["node_icon"],
            "is_page": r["is_page"],
            "permission": "write" if r["can_write"] else "read",
            "shared_at": r["shared_at"].isoformat() if r["shared_at"] else None,
            "shared_by": {
                "user_id": r["shared_by_id"],
                "email": r["shared_by_email"],
            },
            "workspace": {
                "id": r["workspace_id"],
                "name": r["workspace_name"],
                "uuid": str(r["workspace_uuid"]),
            },
        }
        for r in rows
    ]

    return PaginatedResponse[dict](
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        has_next=(page * page_size) < total,
        has_prev=page > 1,
    )
