"""Class-related endpoints for nodes."""

from fastapi import APIRouter, Depends, HTTPException, Query

from ...models import PaginatedResponse, User
from ..auth import get_current_user
from .helpers import (
    _get_class_ids_batch,
    _get_extends_batch,
    _get_node_service,
    _get_undo_service,
    _node_to_response,
)
from .models import ClassRequest, NodeResponse

router = APIRouter()


async def _get_class_service(user: User):
    """Return a :class:`ClassManagementService` wired to the user's workspace."""
    from ...db.connection import get_pool
    from ...dependencies import _get_workspace_context_cached
    from ...domain.repositories import PostgresNodeRepository, PostgresPropertyRepository
    from ...domain.services.class_management_service import ClassManagementService

    pool = await get_pool()
    user_id = int(user.id)
    workspace_id, page_class_id = await _get_workspace_context_cached(pool, user_id)

    node_repo = PostgresNodeRepository(pool, workspace_id, page_class_id, user_id)
    property_repo = PostgresPropertyRepository(pool, workspace_id, user_id)
    return ClassManagementService(pool, workspace_id, node_repo, property_repo)


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
    nodes = await class_service.list_classes()

    pool = class_service.pool
    workspace_id = class_service.workspace_id
    node_ids = [n.id for n in nodes if n.id is not None]
    class_ids_map = await _get_class_ids_batch(pool, workspace_id or 0, node_ids)
    extends_map = await _get_extends_batch(pool, workspace_id or 0, node_ids)

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
    nodes = await class_service.search_classes(q, limit)

    pool = class_service.pool
    workspace_id = class_service.workspace_id

    node_ids = [n.id for n in nodes if n.id is not None]
    class_ids_map = await _get_class_ids_batch(pool, workspace_id or 0, node_ids)
    extends_map = await _get_extends_batch(pool, workspace_id or 0, node_ids)

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
    offset = (page - 1) * page_size
    nodes = await class_service.get_nodes_with_class(class_id, limit=page_size, offset=offset)
    total = await class_service.count_nodes_with_class(class_id)

    node_ids = [n.id for n in nodes if n.id is not None]
    class_ids_map = await _get_class_ids_batch(class_service.pool, class_service.workspace_id or 0, node_ids)

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
    from ...db.schema.constants import SYSTEM_CLASS_UUIDS
    from ...domain.errors import SystemClassConstraintError
    from ...domain.repositories import PostgresNodeViewRepository

    service = await _get_node_service(user)

    # Snapshot class_ids before add
    pool = service.pool
    before_row = await pool.fetchrow(
        "SELECT class_ids FROM node WHERE id = $1 AND workspace_id = $2",
        node_id,
        service.workspace_id,
    )
    before_class_ids = list(before_row["class_ids"] or []) if before_row else []

    try:
        success = await service.add_class(node_id, request.class_node_id)
        if not success:
            raise HTTPException(400, "Class already present or node not found")
    except SystemClassConstraintError as e:
        raise HTTPException(400, e.message) from e

    # Record for undo
    try:
        after_row = await pool.fetchrow(
            "SELECT class_ids FROM node WHERE id = $1 AND workspace_id = $2",
            node_id,
            service.workspace_id,
        )
        after_class_ids = list(after_row["class_ids"] or []) if after_row else []
        undo = await _get_undo_service(user)
        await undo.record(
            "add_class",
            "node",
            node_id,
            before_state={"class_ids": before_class_ids},
            after_state={"class_ids": after_class_ids},
            description=f"Added class to node {node_id}",
        )
    except Exception:
        pass

    # Special handling for query class: create a main_content NodeView
    added_class_node = await service.get_node(request.class_node_id)
    if added_class_node and added_class_node.uuid == SYSTEM_CLASS_UUIDS["query"] and service.workspace_id:
        view_repo = PostgresNodeViewRepository(service.pool, service.workspace_id, str(user.id))
        # Check if main_content view already exists for this node
        existing_views = await view_repo.list_by_node(node_id, view_type="main_content")
        if not existing_views:
            # Create a non-system main_content view with empty query
            await view_repo.create(
                node_id=node_id,
                name="Query",
                view_type="main_content",
                query_json={"type": "AND_CONTAINER", "blocks": []},
                order_index=0,
                is_default=True,
            )

    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    classes = await service.get_node_classes(node_id)
    return _node_to_response(node, classes=[c.id for c in classes if c.id])


@router.delete("/{node_id}/classes/{class_id}")
async def remove_node_class_endpoint(
    node_id: int,
    class_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a class from a node."""
    from ...db.schema.constants import SYSTEM_CLASS_UUIDS
    from ...domain.errors import SystemClassConstraintError
    from ...domain.repositories import PostgresNodeViewRepository

    service = await _get_node_service(user)

    # Snapshot class_ids before removal
    pool = service.pool
    before_row = await pool.fetchrow(
        "SELECT class_ids FROM node WHERE id = $1 AND workspace_id = $2",
        node_id,
        service.workspace_id,
    )
    before_class_ids = list(before_row["class_ids"] or []) if before_row else []

    # Special handling for query class: delete the main_content NodeView before removing the class
    removed_class_node = await service.get_node(class_id)
    if removed_class_node and removed_class_node.uuid == SYSTEM_CLASS_UUIDS["query"] and service.workspace_id:
        view_repo = PostgresNodeViewRepository(service.pool, service.workspace_id, str(user.id))
        # Delete all main_content views for this node
        existing_views = await view_repo.list_by_node(node_id, view_type="main_content")
        for view in existing_views:
            await view_repo.delete(view.id)

    try:
        await service.remove_class(node_id, class_id)
    except SystemClassConstraintError as e:
        raise HTTPException(400, e.message) from e

    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")

    # Record for undo
    try:
        after_row = await pool.fetchrow(
            "SELECT class_ids FROM node WHERE id = $1 AND workspace_id = $2",
            node_id,
            service.workspace_id,
        )
        after_class_ids = list(after_row["class_ids"] or []) if after_row else []
        undo = await _get_undo_service(user)
        await undo.record(
            "remove_class",
            "node",
            node_id,
            before_state={"class_ids": before_class_ids},
            after_state={"class_ids": after_class_ids},
            description=f"Removed class from node {node_id}",
        )
    except Exception:
        pass

    classes = await service.get_node_classes(node_id)
    return _node_to_response(node, classes=[c.id for c in classes if c.id])
