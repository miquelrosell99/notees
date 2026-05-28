"""Workspace-level public share endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from slowapi import Limiter
from slowapi.util import get_remote_address

from ..db.connection import acquire_connection, get_pool
from ..dependencies import _get_workspace_context_cached
from ..domain.repositories import PostgresNodeRepository, PostgresShareRepository
from ..domain.services.share_service import ShareService
from ..logging_config import get_logger
from ..models import User
from .auth import get_current_user
from .nodes.helpers import _name_text, _resolve_referenced_display_names

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
        pool = await get_pool()
        workspace_id, _ = await _get_workspace_context_cached(pool, int(user.id))
        resolved = await _resolve_referenced_display_names(pool, workspace_id, share_rows)

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
    return {"success": True}


@router.get("/inbox")
async def get_share_inbox(
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Get all nodes shared with the current user (share inbox)."""
    pool = await get_pool()
    user_id = int(user.id)

    async with acquire_connection(pool) as conn:
        rows = await conn.fetch(
            """
            SELECT ns.id, ns.node_id, ns.can_read, ns.can_write,
                   ns.create_date as shared_at, ns.create_uid as shared_by_id,
                   u.email as shared_by_email,
                   n.uuid as node_uuid, n.name as node_name, n.icon as node_icon,
                   n.is_page, n.workspace_id, w.name as workspace_name, w.uuid as workspace_uuid
            FROM node_share ns
            JOIN node n ON n.id = ns.node_id
            JOIN "user" u ON u.id = ns.create_uid
            JOIN workspace w ON w.id = n.workspace_id
            WHERE ns.user_id = $1 AND ns.active = TRUE
              AND n.active = TRUE AND n.is_deleted = FALSE
            ORDER BY ns.create_date DESC
            """,
            user_id,
        )

    # Resolve node names that contain inline links to plain text
    from collections import defaultdict

    workspace_rows: dict[int, list[dict]] = defaultdict(list)
    for r in rows:
        workspace_rows[r["workspace_id"]].append({"name": r["node_name"], "uuid": r["node_uuid"]})

    resolved: dict[str, str] = {}
    for ws_id, ws_rows in workspace_rows.items():
        ws_resolved = await _resolve_referenced_display_names(pool, ws_id, ws_rows)
        resolved.update(ws_resolved)

    return {
        "items": [
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
    }
