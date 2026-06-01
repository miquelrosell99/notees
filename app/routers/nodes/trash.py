"""Trash operations for nodes."""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi_limiter.depends import RateLimiter
from pyrate_limiter import Duration, Limiter, Rate

from ...logging_config import get_logger

logger = get_logger(__name__)

from ...models import User
from ..auth import get_current_user
from .helpers import (
    _get_node_service,
    _node_to_response,
)
from .models import (
    BatchPermanentDeleteRequest,
    BatchPermanentDeleteResponse,
    BatchPermanentDeleteResultItem,
)

_trash_limiter = Limiter(Rate(120, Duration.MINUTE))
router = APIRouter()


@router.get("/trash", name="get_trash")
async def get_trash(
    user: User = Depends(get_current_user),
):
    """Get all soft-deleted nodes (trash) for the current workspace.

    Returns nodes that have been soft-deleted (is_deleted=true) but not
    permanently removed from the database.
    """
    service = await _get_node_service(user)
    deleted_nodes = await service.get_deleted_nodes()

    # Convert to response format
    responses = []
    for node in deleted_nodes:
        types = await service.get_node_classes(node.id) if node.id else []
        responses.append(_node_to_response(node, classes=[t.id for t in types if t.id]))

    return {"nodes": responses, "total": len(responses)}


@router.post("/trash/empty", name="empty_trash")
async def empty_trash(
    user: User = Depends(get_current_user),
):
    """Permanently delete all soft-deleted nodes (empty trash).

    This is irreversible. All nodes in trash will be hard deleted from the database.
    """
    service = await _get_node_service(user)
    count = await service.empty_trash()

    return {"status": "success", "deleted_count": count}


@router.post("/trash/batch-delete", name="batch_permanent_delete")
async def batch_permanent_delete(
    request: BatchPermanentDeleteRequest,
    user: User = Depends(get_current_user),
):
    """Permanently delete multiple nodes from trash by ID.

    Accepts an array of node IDs and hard-deletes each independently.
    Only works on nodes that are already soft-deleted (in trash).
    A failure on one node does not prevent the others from being deleted.
    """
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    service = await _get_node_service(user)
    raw_results = await service.batch_permanent_delete(request.ids)

    results = []
    deleted = 0
    failed = 0
    for i, r in enumerate(raw_results):
        if r["success"]:
            deleted += 1
            results.append(
                BatchPermanentDeleteResultItem(
                    index=i,
                    id=request.ids[i],
                    success=True,
                )
            )
        else:
            failed += 1
            results.append(
                BatchPermanentDeleteResultItem(
                    index=i,
                    id=request.ids[i],
                    success=False,
                    error=r["error"],
                )
            )

    logger.info(f"[BATCH_PERMANENT_DELETE] {deleted} deleted, {failed} failed out of {len(request.ids)}")
    return BatchPermanentDeleteResponse(results=results, deleted=deleted, failed=failed)


@router.delete(
    "/{node_id}/permanent",
    name="permanently_delete_node",
    dependencies=[Depends(RateLimiter(limiter=_trash_limiter))],
)
async def permanently_delete_node(
    request: Request,
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Permanently delete a node from trash (hard delete from database).

    This is irreversible. Only works on nodes that are already soft-deleted.
    The node and all its relationships will be removed from the database.
    """
    service = await _get_node_service(user)

    success = await service.permanently_delete_node(node_id)
    if not success:
        raise HTTPException(404, "Node not found in trash")

    return {"status": "permanently_deleted"}
