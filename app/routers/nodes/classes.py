"""Class-related endpoints for nodes."""
from fastapi import APIRouter, HTTPException, Depends

from ..auth import get_current_user
from ...models import User
from .models import ClassRequest
from .helpers import (
    _get_node_service,
    _node_to_response,
    _get_class_ids_batch,
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
    async with service._pool.acquire() as conn:
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
    """
    service = await _get_node_service(user)
    # Search pages only (classes are pages)
    nodes = await service.search(q, limit)
    # Filter to pages only (no parent_id)
    pages = [n for n in nodes if n.parent_id is None]
    
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
    Uses batch fetching for class_ids to avoid N+1 queries.
    """
    service = await _get_node_service(user)
    
    # Get the 'classes' property ID
    async with service._pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM property WHERE name = 'classes' AND (graph_id = $1 OR graph_id IS NULL) LIMIT 1",
            service._graph_id
        )
        
        if not row:
            return {"nodes": []}
        
        classes_property_id = row['id']
        
        # Find all nodes that have this class (only active nodes)
        rows = await conn.fetch("""
            SELECT DISTINCT n.* FROM node n
            JOIN property_value_relation pvr ON n.id = pvr.node_id
            WHERE pvr.property_id = $1 AND pvr.target_id = $2 AND n.graph_id = $3 AND n.active = TRUE
            ORDER BY n.write_date DESC
        """, classes_property_id, class_id, service._graph_id)
    
    nodes = [service._node_repo.row_to_node(row) for row in rows]
    
    # Batch fetch class_ids for all nodes
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
    
    service = await _get_node_service(user)
    
    try:
        success = await service.add_class(node_id, request.class_node_id)
        if not success:
            raise HTTPException(400, "Class already present or node not found")
    except SystemClassConstraintError as e:
        raise HTTPException(400, e.message)
    
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
    
    service = await _get_node_service(user)
    
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
