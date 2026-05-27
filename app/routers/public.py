"""Public API endpoints for anonymous access via share tokens."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..db.connection import acquire_connection, get_pool
from ..domain.repositories import PostgresNodeRepository, PostgresShareRepository
from ..domain.services.share_service import ShareService
from ..logging_config import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/api/public", tags=["Public"])


async def _get_public_share_service(workspace_id: int) -> ShareService:
    pool = await get_pool()
    share_repo = PostgresShareRepository(pool, workspace_id, None)
    node_repo = PostgresNodeRepository(pool, workspace_id, None)
    return ShareService(share_repo, node_repo, workspace_id, 0)


def _node_to_public_dict(node, depth: int = 0) -> dict:
    """Serialize a node for public access (minimal fields)."""
    return {
        "id": node.id,
        "uuid": node.uuid,
        "name": node.name,
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

    children = [dict(r) for r in rows]

    return {
        "node": _node_to_public_dict(node),
        "children": [
            {
                "id": c["id"],
                "uuid": c["uuid"],
                "name": c["name"],
                "icon": c.get("icon"),
                "color": c.get("color"),
                "is_page": c["is_page"],
                "is_class": c.get("is_class", False),
                "is_day": c.get("is_day", False),
                "is_month": c.get("is_month", False),
                "is_year": c.get("is_year", False),
                "is_template": c.get("is_template", False),
                "parent_id": c["parent_id"],
                "sequence": c["sequence"],
                "class_ids": c.get("class_ids", []),
                "create_date": c["create_date"].isoformat() if c.get("create_date") else None,
                "write_date": c["write_date"].isoformat() if c.get("write_date") else None,
                "depth": c["depth"],
            }
            for c in children
        ],
    }
