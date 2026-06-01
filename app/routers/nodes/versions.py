"""Version history operations for nodes."""

from fastapi import APIRouter, Depends, HTTPException

from ...logging_config import get_logger

logger = get_logger(__name__)

from ...db.connection import acquire_connection
from ...models import User
from ..auth import get_current_user
from .helpers import (
    _get_node_service,
)

router = APIRouter()


@router.get("/{node_id}/versions/{version_id}", name="get_node_version")
async def get_node_version(
    node_id: int,
    version_id: int,
    user: User = Depends(get_current_user),
):
    """Get a specific version of a node."""
    service = await _get_node_service(user)

    async with acquire_connection(service.pool) as conn:
        row = await conn.fetchrow(
            """
            SELECT nv.id, nv.name, nv.created_at, nv.user_id,
                   u.username
            FROM node_version nv
            LEFT JOIN "user" u ON u.id = nv.user_id
            WHERE nv.id = $1 AND nv.node_id = $2 AND nv.workspace_id = $3
        """,
            version_id,
            node_id,
            service.workspace_id,
        )

    if not row:
        raise HTTPException(404, "Version not found")

    return {
        "id": row["id"],
        "name": row["name"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "user": row["username"],
    }
