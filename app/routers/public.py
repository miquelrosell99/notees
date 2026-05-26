"""Public API endpoints for anonymous access via share tokens."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..db.connection import get_pool
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


def _node_to_public_dict(node) -> dict:
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

    # Get direct children (page content)
    node_repo = PostgresNodeRepository(pool, share.workspace_id, None)
    children = await node_repo.get_children(node.id) if node.is_page else []

    return {
        "node": _node_to_public_dict(node),
        "children": [_node_to_public_dict(c) for c in children],
    }
