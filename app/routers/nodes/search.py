"""Search, list, and graph endpoints for nodes."""
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Depends

from ..auth import get_current_user
from ...models import User
from .helpers import (
    _get_node_service,
    _node_to_response,
    _get_class_ids_batch,
)


router = APIRouter()


@router.get("/graph")
async def get_graph_data_endpoint(
    user: User = Depends(get_current_user),
):
    """Get graph data for visualization with nodes and links.
    
    Returns all pages as nodes and links between them based on node_link table.
    """
    service = await _get_node_service(user)
    
    async with service._pool.acquire() as conn:
        # Get all active pages as nodes
        page_rows = await conn.fetch(
            """
            SELECT id, uuid, name, icon, is_type, is_day, is_month, is_year
            FROM node 
            WHERE graph_id = $1 AND is_page = TRUE AND active = TRUE
            ORDER BY name
            """,
            service._graph_id
        )
        
        # Get types for each page
        page_ids = [row['id'] for row in page_rows]
        class_ids_map = await _get_class_ids_batch(service._pool, service._graph_id or 0, page_ids) if page_ids else {}
        
        # Build nodes
        nodes = []
        for row in page_rows:
            node_class_ids = class_ids_map.get(row['id'], [])
            nodes.append({
                "id": row['id'],
                "uuid": str(row['uuid']),
                "name": row['name'],
                "icon": row['icon'],
                "is_type": row['is_type'],
                "is_daily": row['is_day'],
                "is_monthly": row['is_month'],
                "is_yearly": row['is_year'],
                "types": node_class_ids,
            })
        
        # Get reference links between pages (only page-to-page links)
        link_rows = await conn.fetch(
            """
            SELECT DISTINCT nl.source_id, nl.target_id
            FROM node_link nl
            JOIN node source ON nl.source_id = source.id
            JOIN node target ON nl.target_id = target.id
            WHERE source.graph_id = $1 
              AND target.graph_id = $1
              AND target.is_page = TRUE
              AND source.active = TRUE
              AND target.active = TRUE
            """,
            service._graph_id
        )
        
        # Build reference links - source is the page containing the block that links
        links = []
        page_id_set = {row['id'] for row in page_rows}
        
        for row in link_rows:
            source_id = row['source_id']
            target_id = row['target_id']
            
            # Get the source page (may be the block's page_id)
            source_page_id = source_id
            if source_id not in page_id_set:
                # Source is a block, get its page
                source_node_row = await conn.fetchrow(
                    "SELECT page_id FROM node WHERE id = $1",
                    source_id
                )
                if source_node_row and source_node_row['page_id']:
                    source_page_id = source_node_row['page_id']
            
            if source_page_id in page_id_set and target_id in page_id_set:
                links.append({
                    "source": source_page_id,
                    "target": target_id,
                    "type": "reference",
                })
        
        # Get parent relationships between pages
        parent_rows = await conn.fetch(
            """
            SELECT child.id as child_id, parent.id as parent_id
            FROM node child
            JOIN node parent ON child.parent_id = parent.id
            WHERE child.graph_id = $1 
              AND child.is_page = TRUE 
              AND parent.is_page = TRUE
              AND child.active = TRUE
              AND parent.active = TRUE
            """,
            service._graph_id
        )
        
        for row in parent_rows:
            child_id = row['child_id']
            parent_id = row['parent_id']
            if child_id in page_id_set and parent_id in page_id_set:
                links.append({
                    "source": parent_id,
                    "target": child_id,
                    "type": "parent",
                })
        
        # Remove duplicate links (keeping first occurrence)
        seen = set()
        unique_links = []
        for link in links:
            key = (link['source'], link['target'], link['type'])
            if key not in seen:
                seen.add(key)
                unique_links.append(link)
        
        return {"nodes": nodes, "links": unique_links}


@router.get("/search")
async def search_nodes(
    q: str,
    limit: int = 50,
    type_filters: Optional[str] = None,  # Comma-separated type IDs to filter by
    user: User = Depends(get_current_user),
):
    """Search nodes by name.
    
    Args:
        q: Search query
        limit: Maximum number of results
        type_filters: Optional comma-separated list of type IDs to filter results
    
    Returns nodes with type_ids populated for reliable filtering.
    """
    service = await _get_node_service(user)
    nodes = await service.search(q, limit)
    
    # Parse type filters if provided
    filter_type_ids: Optional[set] = None
    if type_filters:
        try:
            filter_type_ids = {int(tid.strip()) for tid in type_filters.split(',') if tid.strip()}
        except ValueError:
            pass
    
    # Get node IDs for batch type lookup
    node_ids = [n.id for n in nodes if n.id is not None]
    
    # Batch fetch type_ids for all nodes using PostgreSQL
    class_ids_map = await _get_class_ids_batch(service._pool, service._graph_id or 0, node_ids)
    
    # Build response, optionally filtering by types
    result = []
    for n in nodes:
        if n.id is None:
            continue
        node_class_ids = class_ids_map.get(n.id, [])
        
        # Apply type filter if specified
        if filter_type_ids:
            if not filter_type_ids.intersection(node_class_ids):
                continue
        
        result.append(_node_to_response(n, classes=node_class_ids))
    
    return {"nodes": result}


@router.get("/", name="list_nodes")
async def list_nodes(
    pages_only: bool = False,
    parent_id: Optional[int] = None,
    type_id: Optional[int] = None,
    type_filters: Optional[str] = None,  # Comma-separated type IDs to filter by
    user: User = Depends(get_current_user),
):
    """List nodes with optional filters.
    
    Args:
        pages_only: Only return pages (no blocks)
        parent_id: Only return children of this node
        type_id: Only return nodes with this type
        type_filters: Additional comma-separated type IDs to filter by
    
    Returns nodes with type_ids populated for reliable filtering.
    """
    service = await _get_node_service(user)
    
    if parent_id:
        nodes = await service._node_repo.get_children(parent_id)
    elif type_id:
        nodes = await service._node_repo.get_typed_with(type_id)
    elif pages_only:
        nodes = await service.get_all_pages()
    else:
        nodes = await service.search("", limit=1000)
    
    # Parse type filters if provided
    filter_type_ids: Optional[set] = None
    if type_filters:
        try:
            filter_type_ids = {int(tid.strip()) for tid in type_filters.split(',') if tid.strip()}
        except ValueError:
            pass
    
    # Batch fetch type_ids for all nodes
    node_ids = [n.id for n in nodes if n.id is not None]
    class_ids_map = await _get_class_ids_batch(service._pool, service._graph_id or 0, node_ids)
    
    # Build response, optionally filtering by types
    result = []
    for n in nodes:
        if n.id is None:
            continue
        node_class_ids = class_ids_map.get(n.id, [])
        
        # Apply type filter if specified
        if filter_type_ids:
            if not filter_type_ids.intersection(node_class_ids):
                continue
        
        result.append(_node_to_response(n, classes=node_class_ids))
    
    return {"nodes": result}
