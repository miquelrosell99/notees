"""Node Views API router.

Provides endpoints for managing NodeViews - dynamic query tabs for nodes.
"""
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from ...domain.repositories import PostgresNodeViewRepository
from ...domain.services.query_service import QueryExecutor
from ...db.schema.constants import DEFAULT_QUERY_BLOCK_TREE
from ..auth import get_current_user
from ...models import User
from ...logging_config import get_logger
from .helpers import _get_node_service


logger = get_logger(__name__)
router = APIRouter()


# ==================== Pydantic Models ====================

class NodeViewResponse(BaseModel):
    """NodeView response model."""
    id: int
    uuid: str
    node_id: int
    name: str
    view_type: str
    order_index: int
    is_default: bool
    active: bool
    create_date: str
    write_date: str
    # The query block tree JSON is always available
    query_block_tree: Optional[Dict[str, Any]] = None


class NodeViewCreateRequest(BaseModel):
    """Request to create a NodeView."""
    node_id: int
    name: str
    view_type: str
    order_index: int = 0
    is_default: bool = False
    query_block_tree: Optional[Dict[str, Any]] = None


class NodeViewUpdateRequest(BaseModel):
    """Request to update a NodeView."""
    name: Optional[str] = None
    order_index: Optional[int] = None
    is_default: Optional[bool] = None


class QueryExecuteRequest(BaseModel):
    """Request to execute a query."""
    block_tree: Optional[Dict[str, Any]] = None
    runtime_params: Optional[Dict[str, Any]] = None
    limit: Optional[int] = 100
    offset: Optional[int] = None
    order_by: Optional[str] = None


class NodeViewReorderRequest(BaseModel):
    """Request to reorder NodeViews."""
    view_ids: List[int]


# ==================== Helper Functions ====================

async def _get_node_view_repo(user: User) -> PostgresNodeViewRepository:
    """Get NodeView repository for the current user."""
    service = await _get_node_service(user)
    if service._graph_id is None:
        raise HTTPException(status_code=500, detail="Graph ID not set")
    return PostgresNodeViewRepository(
        pool=service._pool,
        graph_id=service._graph_id,
        user_id=user.id,
    )


async def _get_query_executor(user: User) -> QueryExecutor:
    """Get query executor for the current user."""
    service = await _get_node_service(user)
    if service._graph_id is None:
        raise HTTPException(status_code=500, detail="Graph ID not set")
    return QueryExecutor(
        pool=service._pool,
        graph_id=service._graph_id,
        user_id=user.id,
    )


async def _node_view_to_response(
    view,
    include_query_block_tree: bool = False,
    user: Optional[User] = None,
) -> NodeViewResponse:
    """Convert NodeView entity to response model."""
    response = NodeViewResponse(
        id=view.id,
        uuid=view.uuid,
        node_id=view.node_id,
        name=view.name,
        view_type=view.view_type,
        order_index=view.order_index,
        is_default=view.is_default,
        active=view.active,
        create_date=view.create_date,
        write_date=view.write_date,
    )
    
    # query_json is stored directly on the view now
    if include_query_block_tree:
        response.query_block_tree = view.query_json
    
    return response


# ==================== Endpoints ====================

@router.get("/")
async def list_node_views(
    node_id: int,
    view_type: Optional[str] = None,
    include_query_block_tree: bool = False,
    user: User = Depends(get_current_user),
) -> Dict[str, List[NodeViewResponse]]:
    """List NodeViews for a node.
    
    Args:
        node_id: The node ID
        view_type: Optional filter by view_type
        include_query_block_tree: Whether to include query block trees
        
    Returns:
        Dict with 'views' list
    """
    repo = await _get_node_view_repo(user)
    views = await repo.list_by_node(node_id, view_type=view_type)
    
    responses = []
    for view in views:
        resp = await _node_view_to_response(
            view, 
            include_query_block_tree=include_query_block_tree,
            user=user if include_query_block_tree else None,
        )
        responses.append(resp)
    
    return {"views": responses}


@router.get("/{view_id}")
async def get_node_view(
    view_id: int,
    include_query_block_tree: bool = True,
    user: User = Depends(get_current_user),
) -> NodeViewResponse:
    """Get a NodeView by ID."""
    repo = await _get_node_view_repo(user)
    view = await repo.get_by_id(view_id)
    
    if not view:
        raise HTTPException(status_code=404, detail="NodeView not found")
    
    return await _node_view_to_response(
        view,
        include_query_block_tree=include_query_block_tree,
        user=user if include_query_block_tree else None,
    )


@router.get("/default/{node_id}/{view_type}")
async def get_default_view(
    node_id: int,
    view_type: str,
    include_query_block_tree: bool = True,
    user: User = Depends(get_current_user),
) -> Optional[NodeViewResponse]:
    """Get the default NodeView for a view_type."""
    repo = await _get_node_view_repo(user)
    view = await repo.get_default_view(node_id, view_type)
    
    if not view:
        return None
    
    return await _node_view_to_response(
        view,
        include_query_block_tree=include_query_block_tree,
        user=user if include_query_block_tree else None,
    )


@router.post("/")
async def create_node_view(
    request: NodeViewCreateRequest,
    user: User = Depends(get_current_user),
) -> NodeViewResponse:
    """Create a new NodeView.
    
    Creates a NodeView with the provided query block tree stored directly.
    """
    repo = await _get_node_view_repo(user)
    
    # Create the NodeView with query_json
    view = await repo.create(
        node_id=request.node_id,
        name=request.name,
        view_type=request.view_type,
        query_json=request.query_block_tree,
        order_index=request.order_index,
        is_default=request.is_default,
    )
    
    return await _node_view_to_response(view, include_query_block_tree=True, user=user)


@router.put("/{view_id}")
async def update_node_view(
    view_id: int,
    request: NodeViewUpdateRequest,
    user: User = Depends(get_current_user),
) -> NodeViewResponse:
    """Update a NodeView."""
    repo = await _get_node_view_repo(user)
    
    view = await repo.update(
        view_id=view_id,
        name=request.name,
        order_index=request.order_index,
        is_default=request.is_default,
    )
    
    if not view:
        raise HTTPException(status_code=404, detail="NodeView not found")
    
    return await _node_view_to_response(view, include_query_block_tree=True, user=user)


@router.put("/{view_id}/query")
async def update_query_block_tree(
    view_id: int,
    block_tree: Dict[str, Any],
    user: User = Depends(get_current_user),
) -> NodeViewResponse:
    """Update the query block tree for a NodeView."""
    repo = await _get_node_view_repo(user)
    
    view = await repo.get_by_id(view_id)
    if not view:
        raise HTTPException(status_code=404, detail="NodeView not found")
    
    # Update query_json directly on the view
    updated_view = await repo.update_query_json(view_id, block_tree)
    
    if not updated_view:
        raise HTTPException(status_code=500, detail="Failed to update query")
    
    return await _node_view_to_response(updated_view, include_query_block_tree=True, user=user)


@router.delete("/{view_id}")
async def delete_node_view(
    view_id: int,
    user: User = Depends(get_current_user),
) -> Dict[str, bool]:
    """Delete a NodeView."""
    repo = await _get_node_view_repo(user)
    
    deleted = await repo.delete(view_id)
    
    if not deleted:
        raise HTTPException(status_code=404, detail="NodeView not found")
    
    return {"deleted": True}


@router.post("/reorder/{node_id}/{view_type}")
async def reorder_node_views(
    node_id: int,
    view_type: str,
    request: NodeViewReorderRequest,
    user: User = Depends(get_current_user),
) -> Dict[str, List[NodeViewResponse]]:
    """Reorder NodeViews within a view_type."""
    repo = await _get_node_view_repo(user)
    
    views = await repo.reorder(node_id, view_type, request.view_ids)
    
    responses = [await _node_view_to_response(v) for v in views]
    return {"views": responses}


@router.post("/{view_id}/execute")
async def execute_node_view_query(
    view_id: int,
    request: Optional[QueryExecuteRequest] = None,
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Execute a NodeView's query and return results.
    
    Args:
        view_id: The NodeView ID
        request: Optional query execution parameters (runtime params, limit, offset, etc.)
        
    Returns:
        Dict with 'nodes' list of matching nodes
    """
    repo = await _get_node_view_repo(user)
    executor = await _get_query_executor(user)
    
    view = await repo.get_by_id(view_id)
    if not view:
        raise HTTPException(status_code=404, detail="NodeView not found")
    
    # Execute the query with optional overrides from request
    request = request or QueryExecuteRequest()
    
    # Use request block_tree if provided, otherwise use view's query_json
    effective_block_tree = request.block_tree if request.block_tree else view.query_json
    if not effective_block_tree:
        effective_block_tree = DEFAULT_QUERY_BLOCK_TREE.copy()
    
    results = await executor.execute_query(
        block_tree=effective_block_tree,
        runtime_params=request.runtime_params,
        limit=request.limit,
        offset=request.offset,
        order_by=request.order_by,
    )
    
    return {"nodes": results}


@router.post("/execute")
async def execute_query(
    request: QueryExecuteRequest,
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Execute a query block tree directly (without saving).
    
    Args:
        request: Query execution request with block_tree and optional params
        
    Returns:
        Dict with 'nodes' list of matching nodes
    """
    executor = await _get_query_executor(user)
    
    if not request.block_tree:
        request.block_tree = DEFAULT_QUERY_BLOCK_TREE.copy()
    
    results = await executor.execute_query(
        block_tree=request.block_tree,
        runtime_params=request.runtime_params,
        limit=request.limit,
        offset=request.offset,
        order_by=request.order_by,
    )
    
    return {"nodes": results}


@router.post("/count")
async def count_query_results(
    request: QueryExecuteRequest,
    user: User = Depends(get_current_user),
) -> Dict[str, int]:
    """Count results for a query without fetching all data.
    
    Args:
        request: Query execution request with block_tree
        
    Returns:
        Dict with 'count' of matching nodes
    """
    executor = await _get_query_executor(user)
    
    if not request.block_tree:
        request.block_tree = DEFAULT_QUERY_BLOCK_TREE.copy()
    
    count = await executor.count_query_results(
        block_tree=request.block_tree,
        runtime_params=request.runtime_params,
    )
    
    return {"count": count}


@router.post("/ensure-defaults/{node_id}")
async def ensure_default_views(
    node_id: int,
    view_types: Optional[List[str]] = None,
    user: User = Depends(get_current_user),
) -> Dict[str, List[NodeViewResponse]]:
    """Ensure default views exist for a node.
    
    This is a lazy initialization endpoint - it creates default views
    if they don't exist yet. Safe to call multiple times.
    
    Args:
        node_id: The node ID to create views for
        view_types: Optional list of view types to ensure (defaults to all)
        
    Returns:
        Dict with 'views' list of all views for the node
    """
    from ...domain.services.node_view_service import NodeViewService
    
    service = await _get_node_service(user)
    if service._graph_id is None:
        raise HTTPException(status_code=500, detail="Graph ID not set")
    
    repo = await _get_node_view_repo(user)
    
    # Get existing views
    existing_views = await repo.list_by_node(node_id)
    existing_view_types = {v.view_type for v in existing_views}
    
    # Determine which view types to create
    from ...db.schema.constants import DEFAULT_VIEW_TYPES
    types_to_create = view_types if view_types else DEFAULT_VIEW_TYPES
    types_needed = [vt for vt in types_to_create if vt not in existing_view_types]
    
    # Create missing views
    if types_needed:
        view_service = NodeViewService(service._pool, service._graph_id, user.id)
        await view_service.create_default_views(node_id, types_needed)
    
    # Return all views
    all_views = await repo.list_by_node(node_id)
    responses = [
        await _node_view_to_response(v, include_query_block_tree=True, user=user)
        for v in all_views
    ]
    
    return {"views": responses}
