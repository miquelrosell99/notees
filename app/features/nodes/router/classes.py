"""Class-related endpoints for nodes."""

from fastapi import APIRouter, Depends, HTTPException, Query

from app.dependencies import (
    _get_class_management_service as _get_class_service,
)
from app.dependencies import (
    get_current_user,
)
from app.models import PaginatedResponse, User

from .helpers import (
    _get_class_ids_batch,
    _get_extends_batch,
    _get_node_service,
    _get_undo_service,
    _node_to_response,
)
from .models import ClassRequest, NodeResponse

router = APIRouter()


@router.get("/classes")
async def list_classes(
    user: User = Depends(get_current_user),
):
    """List all classes (nodes that can categorize other nodes).

    Classes are nodes that have is_class=1. This includes system classes like
    day, month, year, as well as user-defined classes.

    Returns nodes with class_ids populated (classes can themselves be classed).
    """
    class_service = await _get_class_service(user)
    node_service = await _get_node_service(user)
    nodes = await class_service.list_classes()

    node_ids = [n.id for n in nodes if n.id is not None]
    class_ids_map = await _get_class_ids_batch(node_service, node_ids)
    extends_map = await _get_extends_batch(node_service, node_ids)

    return {
        "nodes": [
            _node_to_response(
                n,
                classes=class_ids_map.get(n.id, []) if n.id else [],
                extends=extends_map.get(n.id, []) if n.id else [],
            )
            for n in nodes
        ]
    }


@router.get("/classes/search")
async def search_classes(
    q: str,
    limit: int = 20,
    user: User = Depends(get_current_user),
):
    """Search for classes by name.

    Returns nodes with class_ids populated.
    Only returns nodes where is_class=TRUE.
    """
    class_service = await _get_class_service(user)
    node_service = await _get_node_service(user)
    nodes = await class_service.search_classes(q, limit)

    node_ids = [n.id for n in nodes if n.id is not None]
    class_ids_map = await _get_class_ids_batch(node_service, node_ids)
    extends_map = await _get_extends_batch(node_service, node_ids)

    return {
        "nodes": [
            _node_to_response(
                n,
                classes=class_ids_map.get(n.id, []) if n.id else [],
                extends=extends_map.get(n.id, []) if n.id else [],
            )
            for n in nodes
        ]
    }


@router.get("/classes/{class_id}/nodes")
async def get_nodes_with_class(
    class_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    user: User = Depends(get_current_user),
):
    """Get all nodes that have a specific class.

    Returns nodes that have been categorized with the given class node.
    Includes nodes that are classed with subclasses of this class (inheritance).
    Uses direct array queries with class_ids column for performance.
    """
    class_service = await _get_class_service(user)
    node_service = await _get_node_service(user)
    offset = (page - 1) * page_size
    nodes = await class_service.get_nodes_with_class(class_id, limit=page_size, offset=offset)
    total = await class_service.count_nodes_with_class(class_id)

    node_ids = [n.id for n in nodes if n.id is not None]
    class_ids_map = await _get_class_ids_batch(node_service, node_ids)

    items = [_node_to_response(n, classes=class_ids_map.get(n.id, []) if n.id else []) for n in nodes]

    return PaginatedResponse[NodeResponse](
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        has_next=(page * page_size) < total,
        has_prev=page > 1,
    )


@router.post("/{node_id}/classes")
async def add_node_class(
    node_id: int,
    request: ClassRequest,
    user: User = Depends(get_current_user),
):
    """Add a class to a node."""
    from app.domain.errors import SystemClassConstraintError

    service = await _get_node_service(user)

    # Snapshot full node state before add
    before_node = await service.get_node(node_id)
    if not before_node:
        raise HTTPException(404, "Node not found")
    before_state = {
        "class_ids": list(before_node.class_ids),
        "tag_ids": list(before_node.tag_ids),
        "classes_path": list(before_node.classes_path),
    }

    if request.class_node_id in before_state["class_ids"]:
        raise HTTPException(400, "Class already present")

    try:
        node = await service.add_class_with_side_effects(node_id, request.class_node_id)
    except SystemClassConstraintError as e:
        raise HTTPException(400, e.message) from e

    # Record for undo
    try:
        after_state = {
            "class_ids": list(node.class_ids),
            "tag_ids": list(node.tag_ids),
            "classes_path": list(node.classes_path),
        }
        undo = await _get_undo_service(user)
        await undo.record(
            "add_class",
            "node",
            node_id,
            before_state=before_state,
            after_state=after_state,
            description=f"Added class to node {node_id}",
        )
    except (ValueError, TypeError, LookupError):
        pass

    classes = await service.get_node_classes(node_id)
    return _node_to_response(node, classes=[c.id for c in classes if c.id])


@router.delete("/{node_id}/classes/{class_id}")
async def remove_node_class_endpoint(
    node_id: int,
    class_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a class from a node."""
    from app.domain.errors import SystemClassConstraintError

    service = await _get_node_service(user)

    # Snapshot full node state before removal
    before_node = await service.get_node(node_id)
    if not before_node:
        raise HTTPException(404, "Node not found")
    before_state = {
        "class_ids": list(before_node.class_ids),
        "tag_ids": list(before_node.tag_ids),
        "classes_path": list(before_node.classes_path),
    }

    try:
        node = await service.remove_class_with_side_effects(node_id, class_id)
    except SystemClassConstraintError as e:
        raise HTTPException(400, e.message) from e

    # Record for undo
    try:
        after_state = {
            "class_ids": list(node.class_ids),
            "tag_ids": list(node.tag_ids),
            "classes_path": list(node.classes_path),
        }
        undo = await _get_undo_service(user)
        await undo.record(
            "remove_class",
            "node",
            node_id,
            before_state=before_state,
            after_state=after_state,
            description=f"Removed class from node {node_id}",
        )
    except (ValueError, TypeError, LookupError):
        pass

    classes = await service.get_node_classes(node_id)
    return _node_to_response(node, classes=[c.id for c in classes if c.id])
