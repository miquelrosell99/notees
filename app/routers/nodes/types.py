"""Type-related endpoints for nodes."""
from fastapi import APIRouter, HTTPException, Depends

from ..auth import get_current_user
from ...models import User
from .models import TypeRequest
from .helpers import (
    _get_node_service,
    _node_to_response,
    _get_type_ids_batch,
)


router = APIRouter()


@router.get("/types")
async def list_types(
    user: User = Depends(get_current_user),
):
    """List all types (nodes that can categorize other nodes).
    
    Types are nodes that have is_type=1. This includes system types like
    day, month, year, as well as user-defined types.
    
    Returns nodes with type_ids populated (types can themselves be typed).
    """
    service = await _get_node_service(user)
    
    # Get all nodes where is_type=1 using PostgreSQL
    async with service._pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT * FROM node WHERE is_type = TRUE AND active = TRUE AND graph_id = $1 ORDER BY name""",
            service._graph_id
        )
    
    nodes = [service._node_repo.row_to_node(row) for row in rows]
    
    # Batch fetch type_ids for all type nodes
    node_ids = [n.id for n in nodes if n.id is not None]
    type_ids_map = await _get_type_ids_batch(service._pool, service._graph_id or 0, node_ids)
    
    return {"nodes": [
        _node_to_response(n, types=type_ids_map.get(n.id, []) if n.id else []) 
        for n in nodes
    ]}


@router.get("/types/search")
async def search_types(
    q: str,
    limit: int = 20,
    user: User = Depends(get_current_user),
):
    """Search for types by name.
    
    Returns nodes with type_ids populated.
    """
    service = await _get_node_service(user)
    # Search pages only (types are pages)
    nodes = await service.search(q, limit)
    # Filter to pages only (no parent_id)
    pages = [n for n in nodes if n.parent_id is None]
    
    # Batch fetch type_ids
    node_ids = [n.id for n in pages if n.id is not None]
    type_ids_map = await _get_type_ids_batch(service._pool, service._graph_id or 0, node_ids)
    
    return {"nodes": [
        _node_to_response(n, types=type_ids_map.get(n.id, []) if n.id else [])
        for n in pages
    ]}


@router.get("/types/{type_id}/nodes")
async def get_nodes_with_type(
    type_id: int,
    user: User = Depends(get_current_user),
):
    """Get all nodes that have a specific type.
    
    Returns nodes that have been categorized with the given type node.
    Uses batch fetching for type_ids to avoid N+1 queries.
    """
    service = await _get_node_service(user)
    
    # Get the 'types' property ID
    async with service._pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM property WHERE name = 'types' AND (graph_id = $1 OR graph_id IS NULL) LIMIT 1",
            service._graph_id
        )
        
        if not row:
            return {"nodes": []}
        
        types_property_id = row['id']
        
        # Find all nodes that have this type (only active nodes)
        rows = await conn.fetch("""
            SELECT DISTINCT n.* FROM node n
            JOIN property_value_relation pvr ON n.id = pvr.node_id
            WHERE pvr.property_id = $1 AND pvr.target_id = $2 AND n.graph_id = $3 AND n.active = TRUE
            ORDER BY n.write_date DESC
        """, types_property_id, type_id, service._graph_id)
    
    nodes = [service._node_repo.row_to_node(row) for row in rows]
    
    # Batch fetch type_ids for all nodes
    node_ids = [n.id for n in nodes if n.id is not None]
    type_ids_map = await _get_type_ids_batch(service._pool, service._graph_id or 0, node_ids)
    
    return {"nodes": [
        _node_to_response(n, types=type_ids_map.get(n.id, []) if n.id else [])
        for n in nodes
    ]}


@router.post("/{node_id}/types")
async def add_node_type(
    node_id: int,
    request: TypeRequest,
    user: User = Depends(get_current_user),
):
    """Add a type to a node."""
    from ...domain.errors import SystemTypeConstraintError
    
    service = await _get_node_service(user)
    
    try:
        success = await service.add_type(node_id, request.type_node_id)
        if not success:
            raise HTTPException(400, "Type already present or node not found")
    except SystemTypeConstraintError as e:
        raise HTTPException(400, e.message)
    
    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    types = await service.get_node_types(node_id)
    return _node_to_response(node, types=[t.id for t in types if t.id])


@router.delete("/{node_id}/types/{type_id}")
async def remove_node_type_endpoint(
    node_id: int,
    type_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a type from a node."""
    from ...domain.errors import SystemTypeConstraintError
    
    service = await _get_node_service(user)
    
    try:
        success = await service.remove_type(node_id, type_id)
    except SystemTypeConstraintError as e:
        raise HTTPException(400, e.message)
    
    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    types = await service.get_node_types(node_id)
    return _node_to_response(node, types=[t.id for t in types if t.id])
