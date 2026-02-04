"""Helper functions for the Nodes API."""
from typing import cast, Optional, List, Dict, Any

import asyncpg

from ...domain.entities import Node, NodeCreateData, NodeUpdateData
from ...domain.services import NodeService, LinkParsingService
from ...domain.repositories import (
    PostgresNodeRepository, 
    PostgresPropertyRepository, 
    PostgresLinkRepository,
    PostgresInlineClassRepository,
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
    classes: Optional[List[int]] = None,
    comment_count: int = 0,
    backlink_count: int = 0,
) -> NodeResponse:
    """Convert domain Node to API response.
    
    The is_class, is_page, is_daily, etc. flags are stored on the node and
    automatically updated when classes change (via add_class/remove_class).
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
        is_class=node.is_class,
        is_daily=node.is_day,
        is_monthly=node.is_month,
        is_yearly=node.is_year,
        create_date=node.create_date,
        write_date=node.write_date,
        open_date=node.open_date,
        display_name=node.display_name,
        tags=tags or [],
        classes=classes or [],
        comment_count=comment_count,
        backlink_count=backlink_count,
        classes_path=node.classes_path or [],
    )


def _build_children_response(children: List[Node], class_ids_map: Optional[Dict[int, List[int]]] = None) -> List[NodeResponse]:
    """Build a nested NodeResponse list from a flat list of children.
    
    Assumes children are ordered by sequence and reconstructs the hierarchy
    based on parent_id relationships.
    
    Args:
        children: Flat list of child nodes
        class_ids_map: Optional mapping of node_id -> list of class_ids
    """
    if not children:
        return []
    
    class_ids_map = class_ids_map or {}
    
    # Build lookup maps
    node_map: dict[int, NodeResponse] = {}
    root_children: list[NodeResponse] = []
    
    # First pass: convert all nodes to responses
    for node in children:
        classes = class_ids_map.get(node.id, []) if node.id else []
        response = _node_to_response(node, classes=classes)
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
    """Get all descendants of a node using the closure table.
    
    Returns a flat list of all descendants, ordered by depth then sequence.
    Uses node_path for efficient O(1) lookup instead of recursive traversal.
    """
    # Use the repository's get_descendants method if available
    if hasattr(node_repo, 'get_descendants'):
        descendant_ids = await node_repo.get_descendants(parent_id, include_self=False)
        # Fetch full node data for each descendant
        descendants = []
        for desc_id in descendant_ids:
            node = await node_repo.get_by_id(desc_id)
            if node:
                descendants.append(node)
        return descendants
    
    # Fallback to manual traversal if method not available
    all_descendants: List[Node] = []
    to_process = [parent_id]
    
    while to_process:
        current_id = to_process.pop(0)
        children = await node_repo.get_children(current_id)
        all_descendants.extend(children)
        for child in children:
            if child.id:
                to_process.append(child.id)
    
    return all_descendants


async def _get_class_ids(service: NodeService, node_id: int) -> List[int]:
    """Helper to get class IDs for a node."""
    classes = await service.get_node_classes(node_id)
    return [c.id for c in classes if c.id]


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


async def _get_class_ids_batch(pool, graph_id: int, node_ids: List[int]) -> Dict[int, List[int]]:
    """Efficiently fetch class_ids directly from node table.
    
    Returns a dict mapping node_id -> list of class_ids.
    """
    if not node_ids:
        return {}
    
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT id, class_ids
            FROM node
            WHERE id = ANY($1) AND graph_id = $2
        """, node_ids, graph_id)
    
    # Return class_ids for each node
    return {row['id']: list(row['class_ids'] or []) for row in rows}


async def _get_effective_class_ids_batch(pool, graph_id: int, node_ids: List[int], user_id: int) -> Dict[int, List[int]]:
    """Fetch class_ids for multiple nodes including inherited classes from extends.
    
    For each node:
    - Gets explicit classes from the class_ids column
    - For each explicit class, gets all classes it extends (inheritance chain)
    - Returns combined list (explicit + inherited), with explicit classes first
    
    Returns a dict mapping node_id -> list of class_ids (explicit + inherited).
    """
    from ...domain.services.class_extension_service import ClassExtensionService
    from ...domain.repositories import PostgresPropertyRepository
    
    # First get explicit classes
    explicit_classes = await _get_class_ids_batch(pool, graph_id, node_ids)
    
    if not explicit_classes:
        return {nid: [] for nid in node_ids}
    
    # For each unique class, get its inheritance chain
    all_explicit_class_ids = set()
    for class_list in explicit_classes.values():
        all_explicit_class_ids.update(class_list)
    
    if not all_explicit_class_ids:
        return explicit_classes
    
    property_repo = PostgresPropertyRepository(pool, graph_id, user_id)
    extension_service = ClassExtensionService(pool, graph_id, property_repo)
    
    # Cache for class -> extended classes
    extends_cache: Dict[int, List[int]] = {}
    
    for class_id in all_explicit_class_ids:
        try:
            # get_all_extended_classes returns [class_id, parent1, parent2, ...]
            extended = await extension_service.get_all_extended_classes(class_id)
            # Store only the parents (skip the first element which is class_id itself)
            extends_cache[class_id] = extended[1:] if len(extended) > 1 else []
        except Exception:
            # If there's an error (e.g., circular reference), just skip inheritance for this class
            extends_cache[class_id] = []
    
    # Build effective class lists
    result: Dict[int, List[int]] = {}
    for node_id in node_ids:
        explicit = explicit_classes.get(node_id, [])
        effective = list(explicit)  # Start with explicit classes
        
        # Add inherited classes
        for class_id in explicit:
            inherited = extends_cache.get(class_id, [])
            for inherited_class in inherited:
                if inherited_class not in effective:
                    effective.append(inherited_class)
        
        result[node_id] = effective
    
    return result


async def _build_children_tree(service, nodes: List[Any], class_ids_map: Dict[int, List[int]]) -> List[Any]:
    """Build a tree with children for each node.
    
    Fetches all descendants for each node and builds a nested structure.
    Used by list_nodes when include_children=True.
    """
    from .models import NodeResponse
    
    result = []
    for node_response in nodes:
        node_id = node_response.id if hasattr(node_response, 'id') else node_response.get('id')
        if not node_id:
            result.append(node_response)
            continue
        
        # Get all children (direct children only, they'll be nested by _build_children_response)
        children = await service._node_repo.get_children(node_id)
        
        # Filter to only pages if we're dealing with pages
        if hasattr(node_response, 'is_page') and node_response.is_page:
            children = [c for c in children if c.is_page]
        
        # Get all descendants for hierarchy building
        all_descendants = await _get_descendants(service._node_repo, node_id)
        
        # Filter to pages if needed
        if hasattr(node_response, 'is_page') and node_response.is_page:
            all_descendants = [d for d in all_descendants if d.is_page]
        
        # Build class_ids for descendants
        desc_ids = [d.id for d in all_descendants if d.id]
        if desc_ids:
            desc_class_ids = await _get_class_ids_batch(service._pool, service._graph_id or 0, desc_ids)
            class_ids_map.update(desc_class_ids)
        
        # Build children response with hierarchy (pass class_ids_map for classes)
        if all_descendants:
            children_response = _build_children_response(all_descendants, class_ids_map)
            if isinstance(node_response, dict):
                node_response['children'] = [c.model_dump() if hasattr(c, 'model_dump') else c for c in children_response]
            else:
                node_response.children = children_response
        else:
            if isinstance(node_response, dict):
                node_response['children'] = []
            else:
                node_response.children = []
        
        result.append(node_response)
    
    return result


async def _get_node_service(user: User) -> NodeService:
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
            "SELECT id FROM node WHERE name = 'page' AND is_class = TRUE AND graph_id = $1 LIMIT 1",
            graph_id
        )
        page_class_id = row['id'] if row else 1
        logger.info(f"page_class_id: {page_class_id}, row: {row}")
    
    # Create repositories with graph context
    node_repo = PostgresNodeRepository(pool, graph_id, page_class_id, user_id)
    property_repo = PostgresPropertyRepository(pool, graph_id, user_id)
    link_repo = PostgresLinkRepository(pool, graph_id, user_id)
    inline_class_repo = PostgresInlineClassRepository(pool, graph_id, user_id)
    
    # Create services
    link_service = LinkParsingService(node_repo, link_repo, inline_class_repository=inline_class_repo)
    node_service = NodeService(
        node_repo, property_repo, link_service,
        page_class_id,
        pool=pool,
        graph_id=graph_id
    )
    
    # Store user_id for use in helper functions
    node_service._user_id = user_id
    
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
