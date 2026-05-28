"""Public API endpoints for anonymous access via share tokens."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..db.connection import acquire_connection, get_pool
from ..domain.repositories import PostgresNodeRepository, PostgresShareRepository
from ..domain.services.share_service import ShareService
from ..logging_config import get_logger
from .nodes.helpers import _name_text, _resolve_referenced_display_names

logger = get_logger(__name__)
router = APIRouter(prefix="/api/public", tags=["Public"])


async def _get_public_share_service(workspace_id: int) -> ShareService:
    pool = await get_pool()
    share_repo = PostgresShareRepository(pool, workspace_id, None)
    node_repo = PostgresNodeRepository(pool, workspace_id, None)
    return ShareService(share_repo, node_repo, workspace_id, 0)


def _node_to_public_dict(node, depth: int = 0, display_name: str = "") -> dict:
    """Serialize a node for public access (minimal fields)."""
    return {
        "id": node.id,
        "uuid": node.uuid,
        "name": node.name,
        "display_name": display_name,
        "icon": node.icon,
        "color": node.color,
        "is_page": node.is_page,
        "is_class": node.is_class,
        "is_day": node.is_day,
        "is_month": node.is_month,
        "is_year": node.is_year,
        "is_template": node.is_template,
        "parent_id": node.parent_id,
        "sequence": node.sequence,
        "class_ids": node.class_ids,
        "create_date": node.create_date,
        "write_date": node.write_date,
        "depth": depth,
    }


@router.get("/n/{share_uuid}")
async def get_shared_node(
    share_uuid: str,
):
    """Get a publicly shared node and its direct children."""
    # First, resolve the share to get the workspace_id
    pool = await get_pool()
    share_repo = PostgresShareRepository(pool, 0, None)
    share = await share_repo.get_share_by_uuid(share_uuid)

    if share is None or not share.is_valid():
        raise HTTPException(status_code=404, detail="Share not found or expired")

    service = await _get_public_share_service(share.workspace_id)
    node = await service.get_shared_node(share_uuid)

    if node is None:
        raise HTTPException(status_code=404, detail="Share not found or expired")

    # Get all non-page descendants (full block hierarchy, excluding child pages)
    async with acquire_connection(pool) as conn:
        rows = await conn.fetch(
            """
            WITH RECURSIVE tree AS (
                SELECT id, parent_id, sequence, 1 as depth,
                       LPAD(sequence::text, 4, '0') as path
                FROM node
                WHERE parent_id = $1
                  AND workspace_id = $2
                  AND active = TRUE
                  AND is_deleted = FALSE
                  AND is_page = FALSE
                UNION ALL
                SELECT n.id, n.parent_id, n.sequence, t.depth + 1,
                       t.path || '/' || LPAD(n.sequence::text, 4, '0')
                FROM node n
                JOIN tree t ON n.parent_id = t.id
                WHERE n.workspace_id = $2
                  AND n.active = TRUE
                  AND n.is_deleted = FALSE
                  AND n.is_page = FALSE
            )
            SELECT n.*, t.depth
            FROM node n
            JOIN tree t ON n.id = t.id
            ORDER BY t.path
            """,
            node.id,
            share.workspace_id,
        )

    # Resolve display names for nodes that contain inline links
    rows_as_dicts = [{"name": node.name, "uuid": node.uuid}] + [dict(r) for r in rows]
    resolved = await _resolve_referenced_display_names(pool, share.workspace_id, rows_as_dicts)

    node_display_name = resolved.get(node.uuid) or _name_text(node.name, max_len=1000) or "Untitled"

    children = []
    for r in rows:
        uuid_str = str(r["uuid"])
        child_display_name = resolved.get(uuid_str) or _name_text(r["name"], max_len=1000) or "Untitled"
        children.append({
            "id": r["id"],
            "uuid": uuid_str,
            "name": r["name"],
            "display_name": child_display_name,
            "icon": r.get("icon"),
            "color": r.get("color"),
            "is_page": r["is_page"],
            "is_class": r.get("is_class", False),
            "is_day": r.get("is_day", False),
            "is_month": r.get("is_month", False),
            "is_year": r.get("is_year", False),
            "is_template": r.get("is_template", False),
            "parent_id": r["parent_id"],
            "sequence": r["sequence"],
            "class_ids": r.get("class_ids", []),
            "create_date": r["create_date"].isoformat() if r.get("create_date") else None,
            "write_date": r["write_date"].isoformat() if r.get("write_date") else None,
            "depth": r["depth"],
        })

    return {
        "node": _node_to_public_dict(node, display_name=node_display_name),
        "children": children,
    }
