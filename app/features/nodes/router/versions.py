"""Version history operations for nodes."""

from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import get_current_user, get_node_repository
from app.features.nodes.port import NodeRepository
from app.features.nodes.router.dependencies import resolve_node_uuid
from app.logging_config import get_logger
from app.models import User

logger = get_logger(__name__)

router = APIRouter()


@router.get("/{node_uuid}/versions/{version_uuid}", name="get_node_version")
async def get_node_version(
    version_uuid: str,
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Get a specific version of a node."""
    row = await repo.get_node_version_detail_by_uuid(version_uuid, node_id)

    if not row:
        raise HTTPException(404, "Version not found")

    return {
        "id": row["id"],
        "uuid": str(row["uuid"]) if row["uuid"] else None,
        "name": row["name"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "user": row["username"],
    }
