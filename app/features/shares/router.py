"""Share feature routers.

Provides both workspace-level share management and node-scoped share endpoints.
The metadata endpoints read from the operation-log derived state via
:class:`app.core.workspace_store.WorkspaceStore` and emit share operations so
that the derived share tables stay in sync with the PostgreSQL membership
metadata tables.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi_limiter.depends import RateLimiter
from pydantic import BaseModel
from pyrate_limiter import Duration, Limiter, Rate

from app.core.workspace_store import WorkspaceStore
from app.dependencies import get_current_user, require_read_or_write_scope, require_write_scope
from app.domain.stringify_ast import ParseMode, StringifyMode, StringifyOptions, parse_ast, stringify_ast
from app.features.auth import hash_password
from app.infrastructure.export.share_files import delete_share_html
from app.logging_config import get_logger
from app.models import PaginatedResponse, User
from app.utils import utc_now_iso

from .dependencies import (
    NodeIdResolver,
    get_node_id_resolver,
    get_share_repository,
    get_share_service,
    get_workspace_store,
)
from .port import ShareRepository
from .service import ShareService

logger = get_logger(__name__)


def _name_text(name: str | None, max_len: int | None = 60) -> str:
    """Extract plain text from a node name (plain or JSON AST).

    Falls back to the raw string when it cannot be parsed as AST.
    """
    if not name:
        return ""
    try:
        ast = parse_ast(name, ParseMode.JSON)
        text = stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY)) or ""
    except (ValueError, TypeError):
        text = name
    if max_len is not None and len(text) > max_len:
        return text[:max_len]
    return text


async def _resolve_display_name(store: WorkspaceStore, node_uuid: str) -> str:
    """Return a plain-text display name for ``node_uuid`` from derived state."""
    await store.sync()
    rows = await store.query(
        "SELECT content FROM node WHERE id = ?",
        (node_uuid,),
    )
    if not rows:
        return "Untitled"
    content = rows[0]["content"]
    try:
        ast = parse_ast(content, ParseMode.JSON)
        text = stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY)) or ""
    except (ValueError, TypeError):
        text = content or ""
    return text.strip() or "Untitled"


async def _resolve_referenced_display_names(
    store: WorkspaceStore,
    target_rows: list[dict],
) -> dict[str, str]:
    """Resolve display names for a list of ``{"uuid": ...}`` rows."""
    await store.sync()
    resolved: dict[str, str] = {}
    for row in target_rows:
        node_uuid = row.get("uuid")
        if node_uuid:
            resolved[node_uuid] = await _resolve_display_name(store, node_uuid)
    return resolved


# -----------------------------------------------------------------------------
# Workspace-level share router
# -----------------------------------------------------------------------------

workspace_shares_router = APIRouter(
    prefix="/shares",
    tags=["Shares"],
    dependencies=[Depends(get_current_user), Depends(require_read_or_write_scope)],
)


class WorkspaceShareResponse(BaseModel):
    """Public workspace share entry."""

    share_uuid: str
    created_at: str
    expiry_date: str | None
    url: str
    node_name: str
    node_uuid: str


def _workspace_share_to_response(row: dict, resolved_names: dict | None = None) -> dict:
    node_uuid = row["node_uuid"]
    node_name = (resolved_names or {}).get(node_uuid) or row.get("node_name") or "Untitled"
    return {
        "share_uuid": row["share_uuid"],
        "created_at": row["created_at"],
        "expiry_date": row["expiry_date"],
        "url": f"/s/{row['share_uuid']}",
        "node_name": node_name,
        "node_uuid": node_uuid,
    }


@workspace_shares_router.get("", response_model=list[WorkspaceShareResponse])
async def list_workspace_shares(
    user: User = Depends(get_current_user),  # noqa: B008
    store: WorkspaceStore = Depends(get_workspace_store),
):
    """List all active public shares in the current workspace."""
    await store.sync()
    rows = await store.query(
        """
        SELECT share_id as share_uuid, expiry_date, created_at, node_id as node_uuid, node_name
        FROM node_public_share
        WHERE workspace_id = ?
        ORDER BY created_at DESC
        """,
        (store.workspace_id,),
    )

    return [_workspace_share_to_response(dict(row)) for row in rows]


@workspace_shares_router.delete("/{share_uuid}", dependencies=[Depends(require_write_scope)])
async def delete_share(
    share_uuid: str,
    user: User = Depends(get_current_user),  # noqa: B008
    store: WorkspaceStore = Depends(get_workspace_store),
    share_service: ShareService = Depends(get_share_service),
):
    """Revoke a public share link."""
    try:
        success = await share_service.delete_share(share_uuid)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    if not success:
        raise HTTPException(status_code=404, detail="Share not found")

    await store.revoke_public_share(share_uuid)
    await store.sync()

    # Clean up static HTML file
    delete_share_html(share_uuid)

    return {"success": True}


@workspace_shares_router.get("/inbox")
async def get_share_inbox(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    user: User = Depends(get_current_user),  # noqa: B008
    share_repo: ShareRepository = Depends(get_share_repository),
):
    """Get all nodes shared with the current user (share inbox).

    Cross-workspace membership metadata is still sourced from PostgreSQL.
    """
    total, rows = await share_repo.list_share_inbox(int(user.id), page, page_size)

    items = [
        {
            "share_uuid": str(r["share_uuid"]) if r["share_uuid"] else None,
            "node_uuid": str(r["node_uuid"]),
            "node_name": r["node_name"] or "Untitled",
            "node_icon": r["node_icon"],
            "is_page": r["is_page"],
            "permission": "write" if r["can_write"] else "read",
            "shared_at": r["shared_at"].isoformat() if r["shared_at"] else None,
            "shared_by": {
                "email": r["shared_by_email"],
            },
            "workspace": {
                "uuid": str(r["workspace_uuid"]),
                "name": r["workspace_name"],
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


# -----------------------------------------------------------------------------
# Node-scoped share router
# -----------------------------------------------------------------------------

_node_shares_limiter = Limiter(Rate(30, Duration.MINUTE))
node_shares_router = APIRouter()


class PublicShareResponse(BaseModel):
    """Public share link response."""

    share_uuid: str
    created_at: str
    expiry_date: str | None
    url: str


def _node_share_to_response(row: dict, request: Request | None = None) -> dict:
    """Convert a derived public-share row to a response dict."""
    url = f"/s/{row['share_uuid']}"
    if request is not None:
        base_url = str(request.base_url).rstrip("/")
        url = f"{base_url}/s/{row['share_uuid']}"
    return {
        "share_uuid": row["share_uuid"],
        "created_at": row["created_at"] or "",
        "expiry_date": row["expiry_date"],
        "url": url,
    }


class PublicShareCreateRequest(BaseModel):
    expiry_date: str | None = None
    password: str | None = None


@node_shares_router.post(
    "/{node_uuid}/shares",
    response_model=PublicShareResponse,
    dependencies=[
        Depends(RateLimiter(limiter=_node_shares_limiter)),
        Depends(require_write_scope),
    ],
)
async def create_share(
    request: Request,
    node_uuid: str,
    body: PublicShareCreateRequest = ...,  # type: ignore[assignment]
    user: User = Depends(get_current_user),  # noqa: B008
    store: WorkspaceStore = Depends(get_workspace_store),
    share_service: ShareService = Depends(get_share_service),
    share_repo: ShareRepository = Depends(get_share_repository),
    node_id_resolver: NodeIdResolver = Depends(get_node_id_resolver),
):
    """Create a new public share link for a node."""
    workspace_id = share_repo.workspace_id
    node_id = await node_id_resolver(workspace_id, node_uuid)
    try:
        share = await share_service.create_share(node_id, expiry_date=body.expiry_date)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    password_hash = None
    if body.password:
        password_hash = hash_password(body.password)
        await share_repo.set_share_password(share.id, password_hash)

    await store.create_public_share(
        share_id=share.uuid,
        node_id=node_uuid,
        slug=share.uuid,
        password_hash=password_hash,
        expiry_date=body.expiry_date,
    )
    await store.sync()

    # Generate static HTML for the share
    try:
        await share_service.write_share_html(str(share.uuid), node_uuid)
    except (OSError, ValueError):
        logger.exception(f"Failed to generate static HTML for share {share.uuid}")

    return _node_share_to_response({"share_uuid": share.uuid, "created_at": share.created_at, "expiry_date": share.expiry_date}, request)


@node_shares_router.get("/{node_uuid}/shares")
async def list_node_shares(
    node_uuid: str,
    user: User = Depends(get_current_user),  # noqa: B008
    store: WorkspaceStore = Depends(get_workspace_store),
):
    """List all active public shares for a node."""
    await store.sync()
    rows = await store.query(
        """
        SELECT share_id as share_uuid, created_at, expiry_date
        FROM node_public_share
        WHERE node_id = ?
        ORDER BY created_at DESC
        """,
        (node_uuid,),
    )
    return {"shares": [_node_share_to_response(dict(row)) for row in rows]}


class UserShareCreateRequest(BaseModel):
    email: str
    permission: str = "read"  # read, write


class UserShareResponse(BaseModel):
    """User share response (UUIDs only)."""

    share_uuid: str
    node_uuid: str
    shared_with_user_id: str
    permission: str
    created_at: str | None = None
    created_by: str | None = None


def _share_permission_to_string(bits: int) -> str:
    """Decode a permission bitmask back to a public permission string."""
    return "write" if bits & 2 else "read"


@node_shares_router.post(
    "/{node_uuid}/user-shares",
    dependencies=[Depends(require_write_scope)],
)
async def create_user_share(
    node_uuid: str,
    body: UserShareCreateRequest = ...,  # type: ignore[assignment]
    user: User = Depends(get_current_user),  # noqa: B008
    store: WorkspaceStore = Depends(get_workspace_store),
    share_service: ShareService = Depends(get_share_service),
    share_repo: ShareRepository = Depends(get_share_repository),
    node_id_resolver: NodeIdResolver = Depends(get_node_id_resolver),
):
    """Share a node with a specific user."""
    workspace_id = share_repo.workspace_id
    node_id = await node_id_resolver(workspace_id, node_uuid)

    node_name = await _resolve_display_name(store, node_uuid)

    try:
        result = await share_service.create_node_user_share(
            node_id, node_name, body.email, body.permission
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    if result.get("status") == "error":
        raise HTTPException(status_code=500, detail=result.get("detail", "Failed to create share"))

    if result.get("status") == "pending":
        # Pending invites have no target user yet, so no operation is emitted.
        return {
            "status": "pending",
            "email": result.get("email"),
            "invite_link": result.get("invite_link"),
        }

    await store.grant_user_share(
        share_id=str(result["uuid"]),
        node_id=node_uuid,
        user_id=str(result["shared_with_user_uuid"]),
        permission=body.permission,
    )
    await store.sync()

    created_by_uuid = str(result.get("created_by_uuid") or user.uuid)
    return UserShareResponse(
        share_uuid=str(result["uuid"]),
        node_uuid=node_uuid,
        shared_with_user_id=str(result["shared_with_user_uuid"]),
        permission=result.get("permission", "read"),
        created_at=result["created_at"] if result.get("created_at") else utc_now_iso(),
        created_by=created_by_uuid,
    )


@node_shares_router.get("/{node_uuid}/user-shares", response_model=list[UserShareResponse])
async def list_node_user_shares(
    node_uuid: str,
    user: User = Depends(get_current_user),  # noqa: B008
    store: WorkspaceStore = Depends(get_workspace_store),
    share_repo: ShareRepository = Depends(get_share_repository),
    node_id_resolver: NodeIdResolver = Depends(get_node_id_resolver),
):
    """List user shares for a node."""
    workspace_id = share_repo.workspace_id
    user_id = int(user.id)
    node_id = await node_id_resolver(workspace_id, node_uuid)

    try:
        # PostgreSQL still enforces the ownership check.
        await share_repo.list_node_user_shares(node_id, workspace_id, user_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    await store.sync()
    rows = await store.query(
        """
        SELECT share_id as share_uuid, target_user_id as shared_with_user_id,
               permission_bits
        FROM node_user_share
        WHERE node_id = ?
        ORDER BY share_id DESC
        """,
        (node_uuid,),
    )

    return [
        UserShareResponse(
            share_uuid=row["share_uuid"],
            node_uuid=node_uuid,
            shared_with_user_id=row["shared_with_user_id"],
            permission=_share_permission_to_string(row["permission_bits"]),
        )
        for row in rows
    ]


@node_shares_router.delete("/user-shares/{share_uuid}", dependencies=[Depends(require_write_scope)])
async def revoke_user_share(
    share_uuid: str,
    user: User = Depends(get_current_user),  # noqa: B008
    store: WorkspaceStore = Depends(get_workspace_store),
    share_repo: ShareRepository = Depends(get_share_repository),
):
    """Revoke a user share."""
    workspace_id = share_repo.workspace_id
    user_id = int(user.id)

    try:
        result = await share_repo.revoke_user_share_by_uuid(share_uuid, workspace_id, user_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    if result is None:
        raise HTTPException(status_code=404, detail="Share not found")

    await store.revoke_user_share(share_uuid, node_id=result.get("node_uuid"))
    await store.sync()

    return {"success": True}
