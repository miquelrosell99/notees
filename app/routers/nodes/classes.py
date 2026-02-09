"""Class-related endpoints for nodes."""
from fastapi import APIRouter, HTTPException, Depends

from ..auth import get_current_user
from ...models import User
from ...db.connection import acquire_connection
from .models import ClassRequest
from .helpers import (
    _get_node_service,
    _node_to_response,
    _get_class_ids_batch,
    _get_effective_class_ids_batch,
)


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
    service = await _get_node_service(user)
    
    # Get all nodes where is_class=1 using PostgreSQL
    async with acquire_connection(service._pool) as conn:
        rows = await conn.fetch(
            """SELECT * FROM node WHERE is_class = TRUE AND active = TRUE AND graph_id = $1 ORDER BY name""",
            service._graph_id
        )
    
    nodes = [service._node_repo.row_to_node(row) for row in rows]
    
    # Batch fetch class_ids for all class nodes
    node_ids = [n.id for n in nodes if n.id is not None]
    class_ids_map = await _get_class_ids_batch(service._pool, service._graph_id or 0, node_ids)
    
    return {"nodes": [
        _node_to_response(n, classes=class_ids_map.get(n.id, []) if n.id else []) 
        for n in nodes
    ]}


# Keep backwards compatible endpoints
@router.get("/types")
async def list_types(
    user: User = Depends(get_current_user),
):
    """List all classes (alias for /classes for backwards compatibility)."""
    return await list_classes(user)


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
    service = await _get_node_service(user)
    # Search pages only (classes are pages)
    nodes = await service.search(q, limit)
    # Filter to classes only (is_class=True and no parent_id)
    pages = [n for n in nodes if n.parent_id is None and n.is_class]
    
    # Batch fetch class_ids
    node_ids = [n.id for n in pages if n.id is not None]
    class_ids_map = await _get_class_ids_batch(service._pool, service._graph_id or 0, node_ids)
    
    return {"nodes": [
        _node_to_response(n, classes=class_ids_map.get(n.id, []) if n.id else [])
        for n in pages
    ]}


# Backwards compatible alias
@router.get("/types/search")
async def search_types(
    q: str,
    limit: int = 20,
    user: User = Depends(get_current_user),
):
    """Search for classes (alias for /classes/search for backwards compatibility)."""
    return await search_classes(q, limit, user)


@router.get("/classes/{class_id}/nodes")
async def get_nodes_with_class(
    class_id: int,
    user: User = Depends(get_current_user),
):
    """Get all nodes that have a specific class.
    
    Returns nodes that have been categorized with the given class node.
    Includes nodes that are classed with subclasses of this class (inheritance).
    Uses direct array queries with class_ids column for performance.
    """
    from ...domain.services.class_extension_service import ClassExtensionService
    from ...domain.repositories import PostgresPropertyRepository
    
    service = await _get_node_service(user)
    
    async with acquire_connection(service._pool) as conn:
        # Get all subclasses (classes that extend this class)
        property_repo = PostgresPropertyRepository(service._pool, service._graph_id or 0, int(user.id))
        extension_service = ClassExtensionService(service._pool, service._graph_id or 0, property_repo)
        
        subclass_ids = await extension_service.get_all_subclasses(class_id)
        all_class_ids = [class_id] + subclass_ids
        
        # Find all nodes that have this class or any of its subclasses using array overlap
        rows = await conn.fetch("""
            SELECT * FROM node
            WHERE class_ids && $1::integer[]
              AND graph_id = $2
              AND active = TRUE
            ORDER BY write_date DESC
        """, all_class_ids, service._graph_id)
    
    nodes = [service._node_repo.row_to_node(row) for row in rows]
    
    # Batch fetch class_ids for all nodes (already included in row_to_node, but fetch for consistency)
    node_ids = [n.id for n in nodes if n.id is not None]
    class_ids_map = await _get_class_ids_batch(service._pool, service._graph_id or 0, node_ids)
    
    return {"nodes": [
        _node_to_response(n, classes=class_ids_map.get(n.id, []) if n.id else [])
        for n in nodes
    ]}


# Backwards compatible alias
@router.get("/types/{type_id}/nodes")
async def get_nodes_with_type(
    type_id: int,
    user: User = Depends(get_current_user),
):
    """Get all nodes with class (alias for /classes/{class_id}/nodes)."""
    return await get_nodes_with_class(type_id, user)


@router.post("/{node_id}/classes")
async def add_node_class(
    node_id: int,
    request: ClassRequest,
    user: User = Depends(get_current_user),
):
    """Add a class to a node."""
    from ...domain.errors import SystemClassConstraintError
    from ...db.schema.constants import SYSTEM_CLASS_UUIDS
    from ...domain.services.node_view_service import NodeViewService
    from ...domain.repositories import PostgresNodeViewRepository
    
    service = await _get_node_service(user)
    
    try:
        success = await service.add_class(node_id, request.class_node_id)
        if not success:
            raise HTTPException(400, "Class already present or node not found")
    except SystemClassConstraintError as e:
        raise HTTPException(400, e.message)
    
    # Special handling for query class: create a main_content NodeView
    added_class_node = await service.get_node(request.class_node_id)
    if added_class_node and added_class_node.uuid == SYSTEM_CLASS_UUIDS["query"]:
        if service._graph_id:
            view_repo = PostgresNodeViewRepository(
                service._pool, service._graph_id, str(user.id)
            )
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


# Backwards compatible alias
@router.post("/{node_id}/types")
async def add_node_type(
    node_id: int,
    request: ClassRequest,
    user: User = Depends(get_current_user),
):
    """Add a class to a node (alias for /{node_id}/classes)."""
    return await add_node_class(node_id, request, user)


@router.delete("/{node_id}/classes/{class_id}")
async def remove_node_class_endpoint(
    node_id: int,
    class_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a class from a node."""
    from ...domain.errors import SystemClassConstraintError
    from ...db.schema.constants import SYSTEM_CLASS_UUIDS
    from ...domain.repositories import PostgresNodeViewRepository
    
    service = await _get_node_service(user)
    
    # Special handling for query class: delete the main_content NodeView before removing the class
    removed_class_node = await service.get_node(class_id)
    if removed_class_node and removed_class_node.uuid == SYSTEM_CLASS_UUIDS["query"]:
        if service._graph_id:
            view_repo = PostgresNodeViewRepository(
                service._pool, service._graph_id, str(user.id)
            )
            # Delete all main_content views for this node
            existing_views = await view_repo.list_by_node(node_id, view_type="main_content")
            for view in existing_views:
                await view_repo.delete(view.id)
    
    try:
        success = await service.remove_class(node_id, class_id)
    except SystemClassConstraintError as e:
        raise HTTPException(400, e.message)
    
    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    classes = await service.get_node_classes(node_id)
    return _node_to_response(node, classes=[c.id for c in classes if c.id])


# Backwards compatible alias
@router.delete("/{node_id}/types/{type_id}")
async def remove_node_type_endpoint(
    node_id: int,
    type_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a class from a node (alias for /{node_id}/classes/{class_id})."""
    return await remove_node_class_endpoint(node_id, type_id, user)
