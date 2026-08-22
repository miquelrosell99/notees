"""Public API endpoints for anonymous access via share tokens."""

from __future__ import annotations

import contextlib
import json

from fastapi import APIRouter, Depends, HTTPException, Request

from app.core.workspace_store import WorkspaceStore
from app.domain.stringify_ast import ParseMode, StringifyMode, StringifyOptions, parse_ast, stringify_ast
from app.features.shares.dependencies import (
    get_public_workspace_store,
    get_share_repository_for_public,
)
from app.features.shares.port import ShareRepository
from app.logging_config import get_logger
from app.utils.password import PasswordVerificationError, verify_password

logger = get_logger(__name__)
router = APIRouter(prefix="/public", tags=["Public"])


def _content_to_display_name(content: list | str | None) -> str:
    """Extract plain text from node content for public display."""
    if not content:
        return "Untitled"
    raw = json.dumps(content) if isinstance(content, list) else str(content)
    try:
        ast = parse_ast(raw, ParseMode.JSON)
        text = stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
        return text.strip() or "Untitled"
    except (ValueError, TypeError, KeyError):
        text = raw.strip()
        return text or "Untitled"


def _node_row_to_public_dict(row: dict, depth: int = 0) -> dict:
    """Serialize a derived node row for public access (UUIDs only)."""
    content: list | str = []
    with contextlib.suppress(json.JSONDecodeError, TypeError):
        content = json.loads(row.get("content") or "[]")

    class_ids: list | str = []
    with contextlib.suppress(json.JSONDecodeError, TypeError):
        class_ids = json.loads(row.get("class_ids") or "[]")

    return {
        "uuid": row["id"],
        "display_name": _content_to_display_name(content),
        "icon": row.get("icon"),
        "color": row.get("color"),
        "is_page": row.get("kind") == "page",
        "is_class": "class" in class_ids,
        "class_ids": class_ids,
        "create_date": row.get("created_at"),
        "write_date": row.get("updated_at"),
        "depth": depth,
    }


@router.get("/n/{share_uuid}")
async def get_shared_node(
    share_uuid: str,
    request: Request,
    share_repo: ShareRepository = Depends(get_share_repository_for_public),
    store: WorkspaceStore = Depends(get_public_workspace_store),
):
    """Get a publicly shared node and its direct children.

    PostgreSQL resolves the share token to a workspace; the node content is read
    from the WorkspaceStore derived state.
    """
    share = await share_repo.get_share_by_uuid(share_uuid)
    if share is None or not share.is_valid():
        raise HTTPException(status_code=404, detail="Share not found or expired")

    await store.sync()

    # Verify the share exists in derived state and check password if set.
    share_rows = await store.query(
        "SELECT node_id, password_hash, expiry_date FROM node_public_share WHERE share_id = ?",
        (share_uuid,),
    )
    if not share_rows:
        raise HTTPException(status_code=404, detail="Share not found or expired")

    derived_share = dict(share_rows[0])
    password_hash = derived_share.get("password_hash") or share.password_hash
    if password_hash:
        # Header, not a query param: query strings leak into access/proxy logs
        # and browser history.
        password = request.headers.get("X-Share-Password") or ""
        try:
            password_ok = bool(password) and verify_password(password, password_hash)
        except PasswordVerificationError:
            raise HTTPException(
                status_code=503,
                detail="This share is temporarily unavailable. Please try again shortly.",
            ) from None
        if not password_ok:
            raise HTTPException(status_code=403, detail="password_required")

    node_uuid = derived_share["node_id"]
    node_rows = await store.query("SELECT * FROM node WHERE id = ?", (node_uuid,))
    if not node_rows:
        raise HTTPException(status_code=404, detail="Share not found or expired")

    node = _node_row_to_public_dict(dict(node_rows[0]), depth=0)

    # Load direct children (non-page descendants one level deep).
    child_rows = await store.query(
        """
        SELECT c.*
        FROM node_child_order o
        JOIN node c ON c.id = o.child_id
        WHERE o.parent_id = ?
        ORDER BY o.position
        """,
        (node_uuid,),
    )
    children = [_node_row_to_public_dict(dict(row), depth=1) for row in child_rows]

    # Load property values from the derived state.
    prop_rows = await store.query(
        "SELECT property_schema_id, value FROM property_value WHERE node_id = ?",
        (node_uuid,),
    )
    properties: dict[str, list] = {}
    for row in prop_rows:
        key = row["property_schema_id"]
        try:
            value = json.loads(row["value"])
        except (json.JSONDecodeError, TypeError):
            value = row["value"]
        properties.setdefault(key, []).append(value)
    node["properties"] = properties

    # Property definitions are not yet materialized in the derived state.
    property_definitions: list[dict] = []

    return {
        "node": node,
        "children": children,
        "property_definitions": property_definitions,
    }
