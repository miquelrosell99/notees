"""Share feature routers.

Provides both workspace-level share management and node-scoped share endpoints.
"""

from __future__ import annotations

from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi_limiter.depends import RateLimiter
from pydantic import BaseModel
from pyrate_limiter import Duration, Limiter, Rate

from app.dependencies import (
    _get_node_service,
    _get_node_service_for_workspace,
    get_current_user,
    get_node_repository,
    require_read_or_write_scope,
    require_write_scope,
)
from app.features.auth import hash_password
from app.features.nodes.port import NodeRepository
from app.features.nodes.router.dependencies import resolve_node_uuid
from app.features.nodes.router.helpers import _name_text, _resolve_referenced_display_names
from app.infrastructure.export.share_files import delete_share_html
from app.logging_config import get_logger
from app.models import PaginatedResponse, User

from .dependencies import (
    _get_share_service,
    get_share_repository,
    get_share_service,
)
from .port import ShareRepository
from .service import ShareService

logger = get_logger(__name__)

# -----------------------------------------------------------------------------
# Workspace-level share router
# -----------------------------------------------------------------------------

workspace_shares_router = APIRouter(
    prefix="/shares",
    tags=["Shares"],
    dependencies=[Depends(get_current_user), Depends(require_read_or_write_scope)],
)


def _workspace_share_to_response(share, resolved_names: dict | None = None) -> dict:
    node_uuid = getattr(share, "_node_uuid", None)
    node_name_raw = getattr(share, "_node_name", None)
    if node_uuid and resolved_names:
        node_name = resolved_names.get(node_uuid) or _name_text(node_name_raw) or "Untitled"
    else:
        node_name = _name_text(node_name_raw) or "Untitled"
    return {
        "share_uuid": share.uuid,
        "created_at": share.created_at,
        "expiry_date": share.expiry_date,
        "url": f"/s/{share.uuid}",
        "node_name": node_name,
        "node_uuid": node_uuid,
    }


@workspace_shares_router.get("")
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

    return {"shares": [_workspace_share_to_response(s, resolved) for s in shares]}


@workspace_shares_router.delete("/{share_uuid}", dependencies=[Depends(require_write_scope)])
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


@workspace_shares_router.get("/inbox")
async def get_share_inbox(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    user: User = Depends(get_current_user),  # noqa: B008
    share_repo: ShareRepository = Depends(get_share_repository),
):
    """Get all nodes shared with the current user (share inbox)."""
    total, rows = await share_repo.list_share_inbox(int(user.id), page, page_size)

    # Resolve node names that contain inline links to plain text
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
            "share_uuid": str(r["share_uuid"]) if r["share_uuid"] else None,
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


# -----------------------------------------------------------------------------
# Node-scoped share router
# -----------------------------------------------------------------------------

_node_shares_limiter = Limiter(Rate(30, Duration.MINUTE))
node_shares_router = APIRouter()


def _node_share_to_response(share, request: Request | None = None) -> dict:
    """Convert a PublicShare entity to a response dict."""
    url = f"/s/{share.uuid}"
    if request is not None:
        base_url = str(request.base_url).rstrip("/")
        url = f"{base_url}/s/{share.uuid}"
    return {
        "share_uuid": share.uuid,
        "created_at": share.created_at,
        "expiry_date": share.expiry_date,
        "url": url,
    }


class PublicShareCreateRequest(BaseModel):
    expiry_date: str | None = None
    password: str | None = None


@node_shares_router.post(
    "/{node_uuid}/shares",
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
    share_repo: ShareRepository = Depends(get_share_repository),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Create a new public share link for a node."""
    service = await _get_share_service(user)
    node_id = await resolve_node_uuid(node_uuid, repo)
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
            await service.write_share_html(str(share.uuid), node.uuid)
    except (OSError, ValueError):
        logger.exception(f"Failed to generate static HTML for share {share.uuid}")

    return _node_share_to_response(share, request)


@node_shares_router.get("/{node_uuid}/shares")
async def list_node_shares(
    node_uuid: str,
    user: User = Depends(get_current_user),  # noqa: B008
    repo: NodeRepository = Depends(get_node_repository),
):
    """List all active shares for a node."""
    service = await _get_share_service(user)
    node_id = await resolve_node_uuid(node_uuid, repo)
    shares = await service.list_shares_for_node(node_id)
    return {"shares": [_node_share_to_response(s) for s in shares]}


class UserShareCreateRequest(BaseModel):
    email: str
    permission: str = "read"  # read, write


class UserShareResponse(BaseModel):
    share_id: int
    share_uuid: str
    node_id: int
    shared_with_user_id: int
    shared_with_email: str
    permission: str
    created_at: str
    created_by: int


@node_shares_router.post("/{node_uuid}/user-shares", dependencies=[Depends(require_write_scope)])
async def create_user_share(
    node_uuid: str,
    body: UserShareCreateRequest = ...,  # type: ignore[assignment]
    user: User = Depends(get_current_user),  # noqa: B008
    share_service: ShareService = Depends(get_share_service),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Share a node with a specific user."""
    node_id = await resolve_node_uuid(node_uuid, repo)
    try:
        result = await share_service.create_node_user_share(
            node_id, body.email, body.permission
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    if result.get("status") == "error":
        raise HTTPException(status_code=500, detail=result.get("detail", "Failed to create share"))

    return result


@node_shares_router.get("/{node_uuid}/user-shares")
async def list_node_user_shares(
    node_uuid: str,
    user: User = Depends(get_current_user),  # noqa: B008
    share_repo: ShareRepository = Depends(get_share_repository),
    repo: NodeRepository = Depends(get_node_repository),
):
    """List user shares for a node."""
    workspace_id = share_repo.workspace_id
    user_id = int(user.id)
    node_id = await resolve_node_uuid(node_uuid, repo)

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
                "share_uuid": str(r["share_uuid"]) if r["share_uuid"] else None,
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


@node_shares_router.delete("/user-shares/{share_uuid}", dependencies=[Depends(require_write_scope)])
async def revoke_user_share(
    share_uuid: str,
    user: User = Depends(get_current_user),  # noqa: B008
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

    return {"success": True}
