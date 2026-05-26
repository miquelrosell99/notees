"""Public share link endpoints for nodes (node-scoped)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

from ...db.connection import acquire_connection, get_pool
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





class UserShareCreateRequest(BaseModel):
    username: str
    permission: str = "read"  # read, write


class UserShareResponse(BaseModel):
    share_id: int
    node_id: int
    shared_with_user_id: int
    shared_with_username: str
    permission: str
    created_at: str
    created_by: int


@router.post("/{node_id}/user-shares")
async def create_user_share(
    node_id: int = Path(..., ge=1),
    body: UserShareCreateRequest = ...,  # type: ignore[assignment]
    user: User = Depends(get_current_user),  # noqa: B008
):
    """Share a node with a specific user."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)

    async with acquire_connection(pool) as conn:
        # Verify node exists in workspace
        node_row = await conn.fetchrow(
            "SELECT id FROM node WHERE id = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE",
            node_id, workspace_id,
        )
        if not node_row:
            raise HTTPException(status_code=404, detail="Node not found")

        # Resolve target user
        target = await conn.fetchrow(
            'SELECT id FROM "user" WHERE username = $1 AND active = TRUE',
            body.username,
        )
        if not target:
            raise HTTPException(status_code=404, detail=f"User '{body.username}' not found")
        target_id = target["id"]
        if target_id == user_id:
            raise HTTPException(status_code=400, detail="Cannot share with yourself")

        can_write = body.permission == "write"

        row = await conn.fetchrow(
            """
            INSERT INTO node_share (node_id, user_id, can_read, can_write, can_create, can_delete,
                                    active, create_uid, write_uid)
            VALUES ($1, $2, TRUE, $3, FALSE, FALSE, TRUE, $4, $4)
            ON CONFLICT (node_id, user_id)
            DO UPDATE SET
                can_read = TRUE,
                can_write = EXCLUDED.can_write,
                active = TRUE,
                write_uid = EXCLUDED.write_uid,
                write_date = NOW()
            RETURNING id, node_id, user_id, can_read, can_write, create_date, create_uid
            """,
            node_id, target_id, can_write, user_id,
        )

        # Mark node as shared
        await conn.execute(
            "UPDATE node SET is_shared = TRUE WHERE id = $1",
            node_id,
        )

    return {
        "share_id": row["id"],
        "node_id": row["node_id"],
        "shared_with_user_id": row["user_id"],
        "shared_with_username": body.username,
        "permission": "write" if row["can_write"] else "read",
        "created_at": row["create_date"].isoformat() if row["create_date"] else None,
        "created_by": row["create_uid"],
    }


@router.get("/{node_id}/user-shares")
async def list_node_user_shares(
    node_id: int = Path(..., ge=1),
    user: User = Depends(get_current_user),  # noqa: B008
):
    """List user shares for a node."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)

    async with acquire_connection(pool) as conn:
        node_row = await conn.fetchrow(
            "SELECT create_uid FROM node WHERE id = $1 AND workspace_id = $2 AND active = TRUE",
            node_id, workspace_id,
        )
        if not node_row:
            raise HTTPException(status_code=404, detail="Node not found")
        if node_row["create_uid"] != user_id:
            raise HTTPException(status_code=403, detail="Only node owners can view shares")

        rows = await conn.fetch(
            """
            SELECT ns.id, ns.node_id, ns.user_id, u.username, ns.can_read, ns.can_write,
                   ns.create_date, ns.create_uid
            FROM node_share ns
            JOIN "user" u ON u.id = ns.user_id
            WHERE ns.node_id = $1 AND ns.active = TRUE
            ORDER BY ns.create_date DESC
            """,
            node_id,
        )

    return {
        "shares": [
            {
                "share_id": r["id"],
                "node_id": r["node_id"],
                "shared_with_user_id": r["user_id"],
                "shared_with_username": r["username"],
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
):
    """Revoke a user share."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)

    async with acquire_connection(pool) as conn:
        # Verify the share exists and user is the creator or node owner
        share_row = await conn.fetchrow(
            """
            SELECT ns.node_id, ns.create_uid, n.create_uid as node_owner_id
            FROM node_share ns
            JOIN node n ON n.id = ns.node_id
            WHERE ns.id = $1 AND ns.active = TRUE AND n.workspace_id = $2
            """,
            share_id, workspace_id,
        )
        if not share_row:
            raise HTTPException(status_code=404, detail="Share not found")
        if share_row["create_uid"] != user_id and share_row["node_owner_id"] != user_id:
            raise HTTPException(status_code=403, detail="Only the share creator or node owner can revoke")

        await conn.execute(
            "UPDATE node_share SET active = FALSE WHERE id = $1",
            share_id,
        )

        # Check if any shares remain; if not, clear is_shared flag
        remaining = await conn.fetchrow(
            "SELECT 1 FROM node_share WHERE node_id = $1 AND active = TRUE LIMIT 1",
            share_row["node_id"],
        )
        public_remaining = await conn.fetchrow(
            "SELECT 1 FROM node_public_share WHERE node_id = $1 AND active = TRUE LIMIT 1",
            share_row["node_id"],
        )
        if not remaining and not public_remaining:
            await conn.execute(
                "UPDATE node SET is_shared = FALSE WHERE id = $1",
                share_row["node_id"],
            )

    return {"success": True}
