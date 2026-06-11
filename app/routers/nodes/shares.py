"""Public share link endpoints for nodes (node-scoped)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from fastapi_limiter.depends import RateLimiter
from pydantic import BaseModel
from pyrate_limiter import Duration, Limiter, Rate

from ...auth import hash_password
from ...config import settings
from ...db.connection import acquire_connection, get_pool
from ...dependencies import _get_workspace_context_cached
from ...domain.repositories import PostgresNodeRepository, PostgresShareRepository
from ...domain.services.share_service import ShareService
from ...logging_config import get_logger
from ...models import User
from ...node_export import write_share_html
from ...utils.email import render_invite_email, send_email
from ..auth import get_current_user

logger = get_logger(__name__)
_node_shares_limiter = Limiter(Rate(30, Duration.MINUTE))
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
):
    """Create a new public share link for a node."""
    service = await _get_share_service(user)
    try:
        share = await service.create_share(node_id, expiry_date=body.expiry_date)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    # Store password hash if provided
    if body.password:
        pool = await get_pool()
        async with acquire_connection(pool) as conn:
            await conn.execute(
                "UPDATE node_public_share SET password_hash = $1 WHERE id = $2",
                hash_password(body.password),
                share.id,
            )

    # Generate static HTML for the share
    try:
        node = await service._node_repo.get_by_id(node_id)
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
):
    """Share a node with a specific user."""
    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, _ = await _get_workspace_context_cached(pool, user_id)

    async with acquire_connection(pool) as conn:
        # Verify node exists in workspace
        node_row = await conn.fetchrow(
            "SELECT id FROM node WHERE id = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE",
            node_id,
            workspace_id,
        )
        if not node_row:
            raise HTTPException(status_code=404, detail="Node not found")

        # Resolve target user
        target = await conn.fetchrow(
            'SELECT id FROM "user" WHERE email = $1 AND active = TRUE',
            body.email,
        )
        if not target:
            # Target user does not exist — create a pending invite
            invite_uuid = str(uuid.uuid4())
            expires_at = datetime.now(UTC) + timedelta(days=7)
            await conn.execute(
                """
                INSERT INTO pending_invite (uuid, email, workspace_id, node_id, role, invited_by, expires_at, active)
                VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
                ON CONFLICT (email, workspace_id, node_id)
                DO UPDATE SET
                    role = EXCLUDED.role,
                    invited_by = EXCLUDED.invited_by,
                    expires_at = EXCLUDED.expires_at,
                    active = TRUE,
                    created_at = NOW()
                """,
                invite_uuid,
                body.email,
                workspace_id,
                node_id,
                body.permission,
                user_id,
                expires_at,
            )

            invite_link = f"{settings.public_url}/enroll?token={invite_uuid}"
            node_name_row = await conn.fetchrow("SELECT name FROM node WHERE id = $1", node_id)
            node_name = node_name_row["name"] if node_name_row else None
            html, plain = render_invite_email(
                inviter_name=user.name or user.email,
                workspace_name=None,
                invite_link=invite_link,
                node_name=node_name,
            )
            sent = await send_email(body.email, "Invitation to collaborate on Notees", html, plain)

            return {
                "status": "pending",
                "email": body.email,
                "invite_link": None if sent else invite_link,
            }

        target_id = target["id"]
        if target_id == user_id:
            raise HTTPException(status_code=400, detail="Cannot share with yourself")

        can_write = body.permission == "write"

        row = await conn.fetchrow(
            """
            INSERT INTO node_share (node_id, user_id, can_read, can_write, can_create, can_delete,
                                    active, create_uid, write_uid)
            VALUES ($1, $2, TRUE, $3, $3, FALSE, TRUE, $4, $4)
            ON CONFLICT (node_id, user_id)
            DO UPDATE SET
                can_read = TRUE,
                can_write = EXCLUDED.can_write,
                can_create = EXCLUDED.can_create,
                active = TRUE,
                write_uid = EXCLUDED.write_uid,
                write_date = NOW()
            RETURNING id, node_id, user_id, can_read, can_write, create_date, create_uid
            """,
            node_id,
            target_id,
            can_write,
            user_id,
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
        "shared_with_email": body.email,
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
            node_id,
            workspace_id,
        )
        if not node_row:
            raise HTTPException(status_code=404, detail="Node not found")
        if node_row["create_uid"] != user_id:
            raise HTTPException(status_code=403, detail="Only node owners can view shares")

        rows = await conn.fetch(
            """
            SELECT ns.id, ns.node_id, ns.user_id, u.email, ns.can_read, ns.can_write,
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
            share_id,
            workspace_id,
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
