"""Activity router - node activity tracking.

Handles logging and retrieving node activity (edits, link additions, etc.)
using the operation-log derived state via :class:`app.core.workspace_store.WorkspaceStore`.
"""

from __future__ import annotations

import json
import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.uuid import uuidv7
from app.core.workspace_store import WorkspaceStore
from app.dependencies import get_current_user, require_read_or_write_scope, require_write_scope
from app.domain.stringify_ast import ParseMode, StringifyMode, StringifyOptions, parse_ast, stringify_ast
from app.features.activity.dependencies import get_workspace_store
from app.logging_config import get_logger
from app.models import User
from app.utils import utc_now_iso

router = APIRouter(
    prefix="/activity",
    tags=["Activity"],
    dependencies=[Depends(get_current_user), Depends(require_read_or_write_scope)],
)
logger = get_logger(__name__)


# ============== Pydantic Models ==============


class NodeActivityResponse(BaseModel):
    """Node activity response."""

    id: str
    activity_uuid: str
    node_id: str
    action: str  # created, edited, link_added, link_removed, link_inserted, archived, unarchived, type_added, type_removed, property_changed, moved
    details: dict | None = None
    target_node_id: str | None = None
    target_node_name: str | None = None
    target_node_uuid: str | None = None
    create_date: str


class NodeActivityCreate(BaseModel):
    """Request to create a node activity entry."""

    action: str
    details: dict | None = None
    target_node_uuid: str | None = None


class LinkClickResponse(BaseModel):
    """Link click tracking response."""

    source_node_id: str
    target_node_id: str
    node_link_uuid: str | None = None  # UUID of the specific link instance
    click_count: int
    last_click_date: str | None = None


class LinkClickHistoryResponse(BaseModel):
    """Individual link click record."""

    id: str
    link_click_uuid: str
    source_node_id: str
    target_node_id: str
    node_link_uuid: str | None = None
    click_date: str


class LinkClickRequest(BaseModel):
    """Request to track a link click."""

    source_node_uuid: str
    target_node_uuid: str
    node_link_uuid: str | None = None  # UUID of the specific link instance clicked


# ============== Helpers ==============


def _content_to_text(raw_content: str | None) -> str | None:
    """Extract plain text from a node's JSON content, falling back to None."""
    if not raw_content:
        return None
    try:
        content = parse_ast(raw_content, ParseMode.JSON)
        text = stringify_ast(content, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
        return text.strip() or None
    except (ValueError, TypeError, KeyError):
        return None


# ============== Activity Endpoints ==============


@router.get("/node/{node_uuid}", response_model=list[NodeActivityResponse])
async def get_node_activity(
    node_uuid: str,
    limit: int = 50,
    user: User = Depends(get_current_user),
    store: WorkspaceStore = Depends(get_workspace_store),
):
    """Get activity log for a node."""
    await store.sync()
    rows = await store.query(
        """
        SELECT id, node_id, action, target_node_id, details, timestamp
        FROM activity_log
        WHERE node_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
        """,
        (node_uuid, limit),
    )

    target_ids = [row["target_node_id"] for row in rows if row["target_node_id"]]
    target_rows: list[sqlite3.Row] = []
    if target_ids:
        placeholders = ",".join("?" for _ in target_ids)
        target_rows = await store.query(
            f"SELECT id, content FROM node WHERE id IN ({placeholders})",
            tuple(target_ids),
        )
    target_content = {row["id"]: row["content"] for row in target_rows}

    return [
        NodeActivityResponse(
            id=row["id"],
            activity_uuid=row["id"],
            node_id=row["node_id"],
            action=row["action"],
            details=json.loads(row["details"]) if row["details"] else None,
            target_node_id=row["target_node_id"],
            target_node_name=_content_to_text(target_content.get(row["target_node_id"]))
            if row["target_node_id"]
            else None,
            target_node_uuid=row["target_node_id"],
            create_date=row["timestamp"],
        )
        for row in rows
    ]


@router.post("/node/{node_uuid}", response_model=NodeActivityResponse, dependencies=[Depends(require_write_scope)])
async def create_node_activity(
    node_uuid: str,
    data: NodeActivityCreate,
    user: User = Depends(get_current_user),
    store: WorkspaceStore = Depends(get_workspace_store),
):
    """Create a new activity entry for a node.

    Only tracks activity for page nodes (kind = ``page``).
    """
    await store.sync()
    node_rows = await store.query("SELECT kind FROM node WHERE id = ?", (node_uuid,))
    if not node_rows:
        raise HTTPException(404, "Node not found")
    if node_rows[0]["kind"] != "page":
        raise HTTPException(400, "Activity tracking only available for page nodes")

    activity_id = uuidv7()
    await store.record_activity(
        activity_id=activity_id,
        node_id=node_uuid,
        action=data.action,
        target_node_id=data.target_node_uuid,
        details=data.details,
    )
    await store.sync()

    target_name = None
    if data.target_node_uuid:
        target_rows = await store.query(
            "SELECT content FROM node WHERE id = ?", (data.target_node_uuid,)
        )
        if target_rows:
            target_name = _content_to_text(target_rows[0]["content"])

    return NodeActivityResponse(
        id=activity_id,
        activity_uuid=activity_id,
        node_id=node_uuid,
        action=data.action,
        details=data.details,
        target_node_id=data.target_node_uuid,
        target_node_name=target_name,
        target_node_uuid=data.target_node_uuid,
        create_date=utc_now_iso(),
    )


@router.delete("/node/{node_uuid}/{activity_uuid}", dependencies=[Depends(require_write_scope)])
async def delete_node_activity(
    node_uuid: str,
    activity_uuid: str,
    user: User = Depends(get_current_user),
    store: WorkspaceStore = Depends(get_workspace_store),
):
    """Delete a node activity entry from the derived store.

    The operation log remains append-only; this removes the visible derived row.
    Deletion semantics will be refined in a later phase.
    """
    await store.sync()
    existing = await store.query(
        "SELECT 1 FROM activity_log WHERE id = ? AND node_id = ?",
        (activity_uuid, node_uuid),
    )
    if not existing:
        raise HTTPException(404, "Activity not found")
    await store.execute(
        "DELETE FROM activity_log WHERE id = ? AND node_id = ?",
        (activity_uuid, node_uuid),
    )
    return {"success": True}


# ============== Link Click Tracking Endpoints ==============


@router.post("/link/click", response_model=LinkClickResponse, dependencies=[Depends(require_write_scope)])
async def track_link_click(
    data: LinkClickRequest,
    user: User = Depends(get_current_user),
    store: WorkspaceStore = Depends(get_workspace_store),
):
    """Track a link click by emitting a ``link.click`` operation.

    The derived ``link_click`` table aggregates clicks per source-target pair.
    """
    await store.sync()
    source_rows = await store.query("SELECT 1 FROM node WHERE id = ?", (data.source_node_uuid,))
    target_rows = await store.query("SELECT 1 FROM node WHERE id = ?", (data.target_node_uuid,))
    if not source_rows or not target_rows:
        raise HTTPException(404, "Node not found")

    now = utc_now_iso()
    await store.record_link_click(
        data.source_node_uuid,
        data.target_node_uuid,
        clicked_at=now,
        link_uuid=data.node_link_uuid,
    )
    await store.sync()

    if data.node_link_uuid:
        rows = await store.query(
            """
            SELECT click_count, last_navigated_at
            FROM node_link
            WHERE id = ?
            """,
            (data.node_link_uuid,),
        )
    else:
        rows = await store.query(
            """
            SELECT SUM(click_count) AS click_count, MAX(last_navigated_at) AS last_navigated_at
            FROM node_link
            WHERE source_id = ? AND target_id = ?
            """,
            (data.source_node_uuid, data.target_node_uuid),
        )
    click_count = rows[0]["click_count"] if rows and rows[0]["click_count"] is not None else 1
    last_click_date = rows[0]["last_navigated_at"] if rows else now

    return LinkClickResponse(
        source_node_id=data.source_node_uuid,
        target_node_id=data.target_node_uuid,
        node_link_uuid=data.node_link_uuid,
        click_count=click_count,
        last_click_date=last_click_date,
    )


@router.get("/link/clicks/{source_node_uuid}", response_model=list[LinkClickResponse])
async def get_link_clicks(
    source_node_uuid: str,
    user: User = Depends(get_current_user),
    store: WorkspaceStore = Depends(get_workspace_store),
):
    """Get all link click counts from a source node (aggregated by target)."""
    await store.sync()
    rows = await store.query(
        """
        SELECT target_id,
               SUM(click_count) AS click_count,
               MAX(last_navigated_at) AS last_navigated_at
        FROM node_link
        WHERE source_id = ?
        GROUP BY target_id
        """,
        (source_node_uuid,),
    )

    return [
        LinkClickResponse(
            source_node_id=source_node_uuid,
            target_node_id=row["target_id"],
            click_count=row["click_count"] or 0,
            last_click_date=row["last_navigated_at"],
        )
        for row in rows
    ]


@router.get("/link/click/{source_node_uuid}/{target_node_uuid}", response_model=LinkClickResponse)
async def get_link_click(
    source_node_uuid: str,
    target_node_uuid: str,
    user: User = Depends(get_current_user),
    store: WorkspaceStore = Depends(get_workspace_store),
):
    """Get aggregated click count for all links from source to target."""
    await store.sync()
    rows = await store.query(
        """
        SELECT SUM(click_count) AS click_count, MAX(last_navigated_at) AS last_navigated_at
        FROM node_link
        WHERE source_id = ? AND target_id = ?
        """,
        (source_node_uuid, target_node_uuid),
    )
    if rows and rows[0]["click_count"] is not None:
        return LinkClickResponse(
            source_node_id=source_node_uuid,
            target_node_id=target_node_uuid,
            click_count=rows[0]["click_count"],
            last_click_date=rows[0]["last_navigated_at"],
        )
    return LinkClickResponse(
        source_node_id=source_node_uuid,
        target_node_id=target_node_uuid,
        click_count=0,
        last_click_date=None,
    )


@router.get("/link/history/{source_node_uuid}/{target_node_uuid}", response_model=list[LinkClickHistoryResponse])
async def get_link_click_history(
    source_node_uuid: str,
    target_node_uuid: str,
    limit: int = 100,
    user: User = Depends(get_current_user),
    store: WorkspaceStore = Depends(get_workspace_store),
):
    """Get per-instance click history for links from source to target."""
    await store.sync()
    rows = await store.query(
        """
        SELECT id, click_count, last_navigated_at
        FROM node_link
        WHERE source_id = ? AND target_id = ?
        ORDER BY last_navigated_at IS NULL, last_navigated_at DESC
        LIMIT ?
        """,
        (source_node_uuid, target_node_uuid, limit),
    )
    return [
        LinkClickHistoryResponse(
            id=row["id"] or "",
            link_click_uuid=row["id"] or "",
            source_node_id=source_node_uuid,
            target_node_id=target_node_uuid,
            node_link_uuid=row["id"],
            click_date=row["last_navigated_at"],
        )
        for row in rows
    ]


@router.post("/link/reset/{source_node_uuid}/{target_node_uuid}", dependencies=[Depends(require_write_scope)])
async def reset_link_click(
    source_node_uuid: str,
    target_node_uuid: str,
    user: User = Depends(get_current_user),
    store: WorkspaceStore = Depends(get_workspace_store),
):
    """Reset click counters for all links from source to target."""
    await store.sync()
    await store.execute(
        "DELETE FROM node_link WHERE source_id = ? AND target_id = ?",
        (source_node_uuid, target_node_uuid),
    )
    return {"success": True}
