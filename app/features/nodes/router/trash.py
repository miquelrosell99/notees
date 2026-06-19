"""Trash operations for nodes."""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi_limiter.depends import RateLimiter
from pyrate_limiter import Duration, Limiter, Rate

from app.dependencies import get_current_user, get_node_repository
from app.features.nodes.port import NodeRepository
from app.logging_config import get_logger
from app.models import PaginatedResponse, User

from .helpers import (
    _get_class_ids_batch,
    _get_node_service,
    _node_to_response,
    _resolve_display_names_for_responses,
)
from .models import (
    BatchPermanentDeleteRequest,
    BatchPermanentDeleteResponse,
    BatchPermanentDeleteResultItem,
    NodeResponse,
)

logger = get_logger(__name__)

_trash_limiter = Limiter(Rate(120, Duration.MINUTE))
router = APIRouter()


@router.get("/trash", name="get_trash")
async def get_trash(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Get all soft-deleted nodes (trash) for the current workspace.

    Returns nodes that have been soft-deleted (is_deleted=true) but not
    permanently removed from the database.
    """
    service = await _get_node_service(user)
    total, rows = await repo.get_trash_paginated(page, page_size)

    node_ids = [service.row_to_node(row).id for row in rows]
    node_ids = [node_id for node_id in node_ids if node_id is not None]
    class_ids_map = await _get_class_ids_batch(service, node_ids)

    nodes = []
    responses = []
    for row in rows:
        node = service.row_to_node(row)
        nodes.append(node)
        responses.append(_node_to_response(node, classes=class_ids_map.get(node.id or 0, [])))

    await _resolve_display_names_for_responses(service, nodes, responses)

    return PaginatedResponse[NodeResponse](
        items=responses,
        total=total,
        page=page,
        page_size=page_size,
        has_next=(page * page_size) < total,
        has_prev=page > 1,
    )


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
    from app.logging_config import get_logger

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
