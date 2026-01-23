"""Helper functions for the Nodes API."""
from typing import cast, Optional, List, Dict, Any

import asyncpg

from ...domain.entities import Node, NodeCreateData, NodeUpdateData
from ...domain.services import NodeService, LinkParsingService
from ...domain.repositories import (
    PostgresNodeRepository, 
    PostgresPropertyRepository, 
    PostgresLinkRepository,
    PostgresInlineTypeRepository,
)
from ...db.connection import get_pool
from ...db.schema import get_or_create_user_graph
from ...models import User
from ...logging_config import get_logger
from .models import NodeResponse, CommentResponse


logger = get_logger(__name__)


def _node_to_response(
    node: Node, 
    tags: Optional[List[int]] = None,
    types: Optional[List[int]] = None,
    comment_count: int = 0,
    backlink_count: int = 0,
) -> NodeResponse:
    """Convert domain Node to API response.
    
    The is_type, is_page, is_daily, etc. flags are stored on the node and
    automatically updated when types change (via add_type/remove_type).
    """
    return NodeResponse(
        id=node.id or 0,
        uuid=node.uuid,
        name=node.name,
        icon=node.icon,
        color=node.color,
        parent_id=node.parent_id,
        page_id=node.page_id,
        sequence=node.sequence,
        collapsed=node.collapsed,
        active=node.active,
        is_page=node.is_page,
        is_type=node.is_type,
        is_daily=node.is_day,
        is_monthly=node.is_month,
        is_yearly=node.is_year,
        usable_in=node.usable_in,
        create_date=node.create_date,
        write_date=node.write_date,
        open_date=node.open_date,
        display_name=node.display_name,
        tags=tags or [],
        types=types or [],
        comment_count=comment_count,
        backlink_count=backlink_count,
        types_path=node.types_path or [],
    )


def _build_children_response(children: List[Node]) -> List[NodeResponse]:
    """Build a nested NodeResponse list from a flat list of children.
    
    Assumes children are ordered by sequence and reconstructs the hierarchy
    based on parent_id relationships.
    """
    if not children:
        return []
    
    # Build lookup maps
    node_map: dict[int, NodeResponse] = {}
    root_children: list[NodeResponse] = []
    
    # First pass: convert all nodes to responses
    for node in children:
        response = _node_to_response(node)
        response.children = []
        if node.id:
            node_map[node.id] = response
    
    # Second pass: build hierarchy
    for node in children:
        if not node.id:
            continue
        response = node_map[node.id]
        if node.parent_id and node.parent_id in node_map:
            parent = node_map[node.parent_id]
            if parent.children is not None:
                parent.children.append(response)
        else:
            root_children.append(response)
    
    return root_children


async def _get_descendants(node_repo, parent_id: int) -> List[Node]:
    """Get all descendants of a node recursively.
    
    Returns a flat list of all descendants, ordered by sequence at each level.
    """
    all_descendants: List[Node] = []
    to_process = [parent_id]
    
    while to_process:
        current_id = to_process.pop(0)
        children = await node_repo.get_children(current_id)
        all_descendants.extend(children)
        # Add children to process queue for next level
        for child in children:
            if child.id:
                to_process.append(child.id)
    
    return all_descendants


async def _get_type_ids(service: NodeService, node_id: int) -> List[int]:
    """Helper to get type IDs for a node."""
    types = await service.get_node_types(node_id)
    return [t.id for t in types if t.id]


async def _get_tag_ids(pool, graph_id: int, node_id: int) -> List[int]:
    """Helper to get tag IDs for a node (from node_link with is_tag=1)."""
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT target_id FROM node_link 
            WHERE source_id = $1 AND is_tag = TRUE AND property_id IS NULL
            ORDER BY position
        """, node_id)
        return [row['target_id'] for row in rows]


async def _get_tag_ids_batch(pool, graph_id: int, node_ids: List[int]) -> Dict[int, List[int]]:
    """Efficiently fetch tag_ids for multiple nodes in a single query.
    
    Returns a dict mapping node_id -> list of tag_ids.
    """
    if not node_ids:
        return {}
    
    # Initialize result with empty lists for all requested nodes
    result: Dict[int, List[int]] = {nid: [] for nid in node_ids}
    
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT source_id, target_id
            FROM node_link 
            WHERE source_id = ANY($1) AND is_tag = TRUE AND property_id IS NULL
            ORDER BY source_id, position
        """, node_ids)
    
        for row in rows:
            source_id = row['source_id']
            target_id = row['target_id']
            if source_id in result and target_id:
                result[source_id].append(target_id)
    
    return result


async def _get_type_ids_batch(pool, graph_id: int, node_ids: List[int]) -> Dict[int, List[int]]:
    """Efficiently fetch type_ids for multiple nodes in a single query.
    
    Returns a dict mapping node_id -> list of type_ids.
    """
    if not node_ids:
        return {}
    
    # Initialize result with empty lists for all requested nodes
    result: Dict[int, List[int]] = {nid: [] for nid in node_ids}
    
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT 
                pvr.node_id,
                array_agg(pvr.target_id) as type_ids
            FROM property_value_relation pvr
            JOIN property p ON pvr.property_id = p.id
            JOIN node n ON pvr.node_id = n.id
            WHERE p.name = 'types' 
              AND n.graph_id = $2
              AND pvr.node_id = ANY($1)
              AND pvr.target_id IS NOT NULL
            GROUP BY pvr.node_id
        """, node_ids, graph_id)
    
        for row in rows:
            node_id = row['node_id']
            type_ids = row['type_ids']
            if type_ids:
                result[node_id] = [tid for tid in type_ids if tid is not None]
    
    return result


async def _get_node_service(user: User) -> NodeService:
    """Get NodeService instance for user's graph.
    
    Uses PostgreSQL connection pool with graph context.
    """
    import logging
    logger = logging.getLogger(__name__)
    
    pool = await get_pool()
    user_id = int(user.id)
    
    async with pool.acquire() as conn:
        # Get user's graph
        logger.info(f"Getting or creating graph for user {user_id}")
        graph_id = await get_or_create_user_graph(cast(asyncpg.Connection, conn), user_id)
        logger.info(f"Got graph_id: {graph_id}")
        
        # Get system IDs (cached in real implementation)
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE name = 'page' AND is_type = TRUE AND graph_id = $1 LIMIT 1",
            graph_id
        )
        page_type_id = row['id'] if row else 1
        logger.info(f"page_type_id: {page_type_id}, row: {row}")
        
        row = await conn.fetchrow(
            "SELECT id FROM property WHERE name = 'types' AND (graph_id = $1 OR graph_id IS NULL) LIMIT 1",
            graph_id
        )
        types_property_id = row['id'] if row else 1
        logger.info(f"types_property_id: {types_property_id}, row: {row}")
    
    # Create repositories with graph context
    node_repo = PostgresNodeRepository(pool, graph_id, page_type_id, types_property_id, user_id)
    property_repo = PostgresPropertyRepository(pool, graph_id, user_id)
    link_repo = PostgresLinkRepository(pool, graph_id, user_id)
    inline_type_repo = PostgresInlineTypeRepository(pool, graph_id, user_id)
    
    # Create services
    link_service = LinkParsingService(node_repo, link_repo, inline_type_repository=inline_type_repo)
    node_service = NodeService(
        node_repo, property_repo, link_service,
        page_type_id, types_property_id
    )
    
    # Store graph context for use in helper functions
    node_service._pool = pool
    node_service._graph_id = graph_id
    
    return node_service


def _node_to_comment_response(node: Node, children: list[Node] | None = None) -> CommentResponse:
    """Convert a node to a comment response."""
    child_responses = None
    if children:
        child_responses = [_node_to_comment_response(c) for c in children]
    
    return CommentResponse(
        id=node.id or 0,
        uuid=node.uuid,
        name=node.name,
        icon=node.icon,
        parent_id=node.parent_id,
        sequence=node.sequence,
        collapsed=node.collapsed,
        create_date=node.create_date,
        write_date=node.write_date,
        children=child_responses,
    )


def _format_date_with_pattern(year: int, month: int, day: int, pattern: str) -> str:
    """Format a date according to the given pattern."""
    month_str = str(month).zfill(2)
    day_str = str(day).zfill(2)
    
    if pattern == "YYYY/MM/DD":
        return f"{year}/{month_str}/{day_str}"
    elif pattern == "YYYY-MM-DD":
        return f"{year}-{month_str}-{day_str}"
    elif pattern == "DD/MM/YYYY":
        return f"{day_str}/{month_str}/{year}"
    elif pattern == "DD-MM-YYYY":
        return f"{day_str}-{month_str}-{year}"
    elif pattern == "MM/DD/YYYY":
        return f"{month_str}/{day_str}/{year}"
    elif pattern == "MM-DD-YYYY":
        return f"{month_str}-{day_str}-{year}"
    else:
        return f"{year}/{month_str}/{day_str}"


def _format_month_with_pattern(year: int, month: int, pattern: str) -> str:
    """Format a month according to the given pattern."""
    month_str = str(month).zfill(2)
    separator = "/" if "/" in pattern else "-"
    
    if pattern.startswith("DD") or pattern.startswith("MM"):
        # European/US style
        return f"{month_str}{separator}{year}"
    else:
        # ISO style
        return f"{year}{separator}{month_str}"
