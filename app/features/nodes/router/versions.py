"""Version history operations for nodes."""

from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import get_current_user, get_node_repository
from app.features.nodes.port import NodeRepository
from app.logging_config import get_logger
from app.models import User

logger = get_logger(__name__)

router = APIRouter()


@router.get("/{node_id}/versions/{version_id}", name="get_node_version")
async def get_node_version(
    node_id: int,
    version_id: int,
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Get a specific version of a node."""
    row = await repo.get_node_version_detail(version_id, node_id)

    if not row:
        raise HTTPException(404, "Version not found")

    return {
        "id": row["id"],
        "name": row["name"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "user": row["username"],
    }
