"""Node Views API router.

Provides endpoints for managing NodeViews - dynamic query tabs for nodes.
"""
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from ...domain.repositories import PostgresNodeViewRepository
from ...domain.services.query_service import QueryExecutor
from ...domain.entities.query_ast import QueryAST, create_default_query_ast
from ...domain.services.query_ast_validation import validate_query_ast, can_save_query
from ...domain.services.query_ast_sql import generate_sql_from_ast
from ..auth import get_current_user
from ...models import User
from ...logging_config import get_logger
from .helpers import _get_node_service


logger = get_logger(__name__)
router = APIRouter(tags=["NodeViews"])


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
    shown_properties: List[Dict[str, Any]] = []
    group_by: Optional[str] = None
    create_date: str
    write_date: str
    # The query AST JSON
    query_ast: Optional[Dict[str, Any]] = None


class NodeViewCreateRequest(BaseModel):
    """Request to create a NodeView."""
    node_id: int
    name: str
    view_type: str
    order_index: int = 0
    is_default: bool = False
    query_ast: Optional[Dict[str, Any]] = None


class NodeViewUpdateRequest(BaseModel):
    """Request to update a NodeView."""
    name: Optional[str] = None
    order_index: Optional[int] = None
    is_default: Optional[bool] = None
    shown_properties: Optional[List[Dict[str, Any]]] = None
    group_by: Optional[str] = None


class QueryExecuteRequest(BaseModel):
    """Request to execute a query."""
    query_ast: Optional[Dict[str, Any]] = None
    runtime_params: Optional[Dict[str, Any]] = None
    limit: Optional[int] = 100
    offset: Optional[int] = None
    order_by: Optional[str] = None
    include_children: Optional[bool] = False
    include_properties: Optional[bool] = False


class QueryASTUpdateRequest(BaseModel):
    """Request to update query AST."""
    query_ast: Dict[str, Any]


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


async def _get_property_repo(user: User):
    """Get property repository for the current user."""
    service = await _get_node_service(user)
    return service._property_repo


async def _include_classes_for_results(user: User, results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Fetch and attach classes for each node in results.
    
    This adds 'classes' to each node dict with their class IDs.
    Recursively processes children as well.
    """
    if not results:
        return results
    
    service = await _get_node_service(user)
    
    async def _add_classes_recursive(nodes: List[Dict[str, Any]]):
        """Recursively add classes to nodes and their children."""
        # Collect all node IDs
        node_ids = [n.get("id") for n in nodes if n.get("id")]
        if not node_ids:
            return
        
        # Fetch classes for all nodes in batch
        from app.routers.nodes.helpers import _get_class_ids_batch
        classes_map = await _get_class_ids_batch(
            service._pool,
            service._graph_id,
            node_ids
        )
        
        # Attach classes to each node
        for node in nodes:
            node_id = node.get("id")
            if node_id and node_id in classes_map:
                node["classes"] = classes_map[node_id]
            
            # Recursively process children
            if node.get("children"):
                await _add_classes_recursive(node["children"])
    
    # Process all results and their children recursively
    await _add_classes_recursive(results)
    
    return results


async def _include_children_for_results(user: User, results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Recursively fetch children for each node in results.
    
    This adds 'children' to each node dict, populated with their child nodes.
    """
    if not results:
        return results
    
    service = await _get_node_service(user)
    
    # Get node IDs from results
    node_ids = [r.get("id") for r in results if r.get("id")]
    
    if not node_ids:
        return results
    
    # Fetch all children for each node recursively
    # We'll use the repository's get_children method which returns direct children
    children_by_parent: Dict[int, List[Dict[str, Any]]] = {}
    
    async def fetch_children_recursive(parent_id: int):
        """Recursively fetch children and convert to dict format."""
        children = await service._node_repo.get_children(parent_id)
        child_dicts = []
        for child in children:
            child_dict = child.to_dict() if hasattr(child, 'to_dict') else {
                "id": child.id,
                "uuid": child.uuid,
                "name": child.name,
                "parent_id": child.parent_id,
                "page_id": child.page_id,
                "is_page": child.is_page,
                "is_day": child.is_day,
                "is_month": child.is_month,
                "is_year": child.is_year,
                "sequence": child.sequence,
                "collapsed": child.collapsed,
            }
            # Recursively fetch this child's children
            await fetch_children_recursive(child.id)
            child_dict["children"] = children_by_parent.get(child.id, [])
            child_dicts.append(child_dict)
        children_by_parent[parent_id] = child_dicts
    
    # Fetch children for each result node
    for node_id in node_ids:
        await fetch_children_recursive(node_id)
    
    # Assign children to each result
    for result in results:
        node_id = result.get("id")
        result["children"] = children_by_parent.get(node_id, [])
    
    return results


async def _include_properties_for_results(user: User, results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Fetch and attach properties for each node in results.
    
    This adds 'properties' to each node dict, populated with their property values.
    Recursively processes children as well.
    """
    if not results:
        return results
    
    property_repo = await _get_property_repo(user)
    
    async def _add_properties_recursive(nodes: List[Dict[str, Any]]):
        """Recursively add properties to nodes and their children."""
        for result in nodes:
            node_id = result.get("id")
            if not node_id:
                continue
                
            # Get all property values for this node
            all_prop_values = await property_repo.get_all_property_values(node_id)
            props_dict = {}
            
            for prop_id, prop_data in all_prop_values.items():
                prop = prop_data['property']
                values = prop_data['values']
                if values:
                    # Extract the actual value based on property type
                    val = values[0]  # Get first value
                    if hasattr(val, 'target_id'):
                        # Relation type
                        props_dict[prop.name] = val.target_id
                    elif hasattr(val, 'value_integer'):
                        # Scalar type
                        props_dict[prop.name] = (
                            val.value_integer or val.value_float or 
                            val.value_text or val.value_boolean
                        )
                    elif hasattr(val, 'selection_line_id'):
                        # Selection type
                        props_dict[prop.name] = val.selection_line_id
            
            if props_dict:
                result["properties"] = props_dict
            
            # Recursively process children
            if result.get("children"):
                await _add_properties_recursive(result["children"])
    
    # Process all results and their children recursively
    await _add_properties_recursive(results)
    
    return results


async def _node_view_to_response(
    view,
    include_query_ast: bool = False,
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
        shown_properties=view.shown_properties,
        group_by=view.group_by,
        create_date=view.create_date,
        write_date=view.write_date,
    )
    
    # query_json is stored directly on the view now
    if include_query_ast:
        response.query_ast = view.query_json
    
    return response


# ==================== Endpoints ====================

@router.get("")
async def list_node_views(
    node_id: int,
    view_type: Optional[str] = None,
    include_query_ast: bool = False,
    user: User = Depends(get_current_user),
) -> Dict[str, List[NodeViewResponse]]:
    """List NodeViews for a node.
    
    Args:
        node_id: The node ID
        view_type: Optional filter by view_type
        include_query_ast: Whether to include query block trees
        
    Returns:
        Dict with 'views' list
    """
    repo = await _get_node_view_repo(user)
    views = await repo.list_by_node(node_id, view_type=view_type)
    
    responses = []
    for view in views:
        resp = await _node_view_to_response(
            view, 
            include_query_ast=include_query_ast,
            user=user if include_query_ast else None,
        )
        responses.append(resp)
    
    return {"views": responses}


@router.get("/{view_id}")
async def get_node_view(
    view_id: int,
    include_query_ast: bool = True,
    user: User = Depends(get_current_user),
) -> NodeViewResponse:
    """Get a NodeView by ID."""
    repo = await _get_node_view_repo(user)
    view = await repo.get_by_id(view_id)
    
    if not view:
        raise HTTPException(status_code=404, detail="NodeView not found")
    
    return await _node_view_to_response(
        view,
        include_query_ast=include_query_ast,
        user=user if include_query_ast else None,
    )


@router.get("/default/{node_id}/{view_type}")
async def get_default_view(
    node_id: int,
    view_type: str,
    include_query_ast: bool = True,
    user: User = Depends(get_current_user),
) -> Optional[NodeViewResponse]:
    """Get the default NodeView for a view_type."""
    repo = await _get_node_view_repo(user)
    view = await repo.get_default_view(node_id, view_type)
    
    if not view:
        return None
    
    return await _node_view_to_response(
        view,
        include_query_ast=include_query_ast,
        user=user if include_query_ast else None,
    )


@router.post("")
async def create_node_view(
    request: NodeViewCreateRequest,
    user: User = Depends(get_current_user),
) -> NodeViewResponse:
    """Create a new NodeView.
    
    Accepts either query_ast (preferred) or query_ast (legacy).
    Stores as QueryAST format internally.
    """
    repo = await _get_node_view_repo(user)
    
    # Determine which format to use
    query_json = None
    if request.query_ast:
        # Validate AST
        try:
            ast = QueryAST.from_dict(request.query_ast)
            
            # Prevent creation of system queries through API
            if ast.is_system:
                raise HTTPException(
                    status_code=403,
                    detail="Cannot create system queries through this endpoint"
                )
            
            validation = validate_query_ast(ast, allow_system_modification=False)
            if not validation.valid:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid query AST: {validation.issues[0].message if validation.issues else 'Unknown error'}"
                )
            query_json = request.query_ast
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid query AST: {str(e)}")
    elif request.query_ast:
        # Legacy format - store as-is for now (could convert to AST)
        query_json = request.query_ast
    else:
        # Default empty query
        query_json = create_default_query_ast().to_dict()
    
    # Create the NodeView with query_json
    view = await repo.create(
        node_id=request.node_id,
        name=request.name,
        view_type=request.view_type,
        query_json=query_json,
        order_index=request.order_index,
        is_default=request.is_default,
    )
    
    return await _node_view_to_response(view, include_query_ast=True, user=user)


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
        shown_properties=request.shown_properties,
        group_by=request.group_by,
    )
    
    if not view:
        raise HTTPException(status_code=404, detail="NodeView not found")
    
    return await _node_view_to_response(view, include_query_ast=True, user=user)


@router.put("/{view_id}/query")
async def update_query_legacy(
    view_id: int,
    query_data: Dict[str, Any],
    user: User = Depends(get_current_user),
) -> NodeViewResponse:
    """Update the query for a NodeView (legacy endpoint)."""
    repo = await _get_node_view_repo(user)
    
    view = await repo.get_by_id(view_id)
    if not view:
        raise HTTPException(status_code=404, detail="NodeView not found")
    
    # Update query_json directly on the view
    updated_view = await repo.update_query_json(view_id, query_data)
    
    if not updated_view:
        raise HTTPException(status_code=500, detail="Failed to update query")
    
    return await _node_view_to_response(updated_view, include_query_ast=True, user=user)


@router.put("/{view_id}/query-ast")
async def update_query_ast(
    view_id: int,
    request: QueryASTUpdateRequest,
    user: User = Depends(get_current_user),
) -> NodeViewResponse:
    """Update the query AST for a NodeView (preferred endpoint).
    
    Validates the AST before saving. System queries cannot be modified.
    """
    repo = await _get_node_view_repo(user)
    
    view = await repo.get_by_id(view_id)
    if not view:
        raise HTTPException(status_code=404, detail="NodeView not found")
    
    # Check if existing query is a system query
    try:
        existing_query = view.get('query_json', {})
        if existing_query and existing_query.get('is_system'):
            raise HTTPException(
                status_code=403,
                detail="Cannot modify system query. System queries (linked references, child pages, etc.) are read-only."
            )
    except Exception:
        pass  # If we can't parse existing, continue with validation
    
    # Validate AST
    try:
        ast = QueryAST.from_dict(request.query_ast)
        
        # Prevent creation of system queries through API
        if ast.is_system:
            raise HTTPException(
                status_code=403,
                detail="Cannot create or modify system queries through this endpoint"
            )
        
        validation = validate_query_ast(ast, allow_system_modification=False)
        
        can_save, reason = can_save_query(ast, allow_system_modification=False)
        if not can_save:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot save query: {reason}"
            )
        
        # Update with validated AST
        updated_view = await repo.update_query_json(view_id, ast.to_dict())
        
        if not updated_view:
            raise HTTPException(status_code=500, detail="Failed to update query")
        
        return await _node_view_to_response(updated_view, include_query_ast=True, user=user)
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update query AST: {e}")
        raise HTTPException(status_code=400, detail=f"Invalid query AST: {str(e)}")


@router.post("/validate-query-ast")
async def validate_query_ast_endpoint(
    request: QueryASTUpdateRequest,
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Validate a query AST without saving it.
    
    Returns validation results with any issues found.
    """
    try:
        ast = QueryAST.from_dict(request.query_ast)
        validation = validate_query_ast(ast)
        
        return {
            "valid": validation.valid,
            "can_save": not validation.has_errors(),
            "issues": [
                {
                    "severity": issue.severity,
                    "message": issue.message,
                    "path": issue.path,
                    "suggestion": issue.suggestion,
                }
                for issue in validation.issues
            ]
        }
    except Exception as e:
        return {
            "valid": False,
            "can_save": False,
            "issues": [{
                "severity": "error",
                "message": f"Failed to parse AST: {str(e)}",
                "path": "root",
                "suggestion": None,
            }]
        }


@router.delete("/{view_id}")
async def delete_node_view(
    view_id: int,
    user: User = Depends(get_current_user),
) -> Dict[str, bool]:
    """Delete a NodeView.
    
    Cannot delete the last view of a given type for a node.
    """
    repo = await _get_node_view_repo(user)
    
    # Get the view first to know its node_id and view_type
    view = await repo.get_by_id(view_id)
    if not view:
        raise HTTPException(status_code=404, detail="NodeView not found")
    
    # Check if this is the last view of its type
    count = await repo.count_by_view_type(view.node_id, view.view_type)
    if count <= 1:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot delete the last view of type '{view.view_type}'. Each node must have at least one view per type."
        )
    
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
    
    logger.info(f"[execute_node_view_query] view_id={view_id}, runtime_params={request.runtime_params}")
    
    # Use request query_ast if provided, otherwise use view's query_json
    effective_query = request.query_ast if request.query_ast else view.query_json
    if not effective_query:
        effective_query = {"type": "query", "version": "1.0", "scope": {"type": "scope", "scope_type": "entire_graph"}, "root_group": {"type": "group", "logic": "AND", "children": []}}
    
    logger.info(f"[execute_node_view_query] effective_query scope={effective_query.get('scope')}, root_group={effective_query.get('root_group')}")
    
    results = await executor.execute_query(
        query=effective_query,
        runtime_params=request.runtime_params,
        limit=request.limit,
        offset=request.offset,
        order_by=request.order_by,
    )
    
    # If include_children is requested, fetch children for each node
    if request.include_children:
        results = await _include_children_for_results(user, results)
    
    # Always include classes (needed for card view and other displays)
    results = await _include_classes_for_results(user, results)
    
    # If include_properties is requested, fetch properties for each node
    if request.include_properties:
        results = await _include_properties_for_results(user, results)
    
    return {"nodes": results}


@router.post("/execute")
async def execute_query(
    request: QueryExecuteRequest,
    user: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Execute a query directly (without saving).
    
    Args:
        request: Query execution request with query_ast and optional params
        
    Returns:
        Dict with 'nodes' list of matching nodes
    """
    executor = await _get_query_executor(user)
    
    effective_query = request.query_ast
    if not effective_query:
        effective_query = {"type": "query", "version": "1.0", "scope": {"type": "scope", "scope_type": "entire_graph"}, "root_group": {"type": "group", "logic": "AND", "children": []}}
    
    results = await executor.execute_query(
        query=effective_query,
        runtime_params=request.runtime_params,
        limit=request.limit,
        offset=request.offset,
        order_by=request.order_by,
    )
    
    # If include_children is requested, fetch children for each node
    if request.include_children:
        results = await _include_children_for_results(user, results)
    
    # Always include classes (needed for card view and other displays)
    results = await _include_classes_for_results(user, results)
    
    # If include_properties is requested, fetch properties for each node
    if request.include_properties:
        results = await _include_properties_for_results(user, results)
    
    return {"nodes": results}


@router.post("/count")
async def count_query_results(
    request: QueryExecuteRequest,
    user: User = Depends(get_current_user),
) -> Dict[str, int]:
    """Count results for a query without fetching all data.
    
    Args:
        request: Query execution request with query_ast
        
    Returns:
        Dict with 'count' of matching nodes
    """
    executor = await _get_query_executor(user)
    
    effective_query = request.query_ast
    if not effective_query:
        effective_query = {"type": "query", "version": "1.0", "scope": {"type": "scope", "scope_type": "entire_graph"}, "root_group": {"type": "group", "logic": "AND", "children": []}}
    
    count = await executor.count_query_results(
        query=effective_query,
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
    from ...db.schema.constants import DEFAULT_VIEW_CLASSES
    types_to_create = view_types if view_types else DEFAULT_VIEW_CLASSES
    types_needed = [vt for vt in types_to_create if vt not in existing_view_types]
    
    # Create missing views
    if types_needed:
        view_service = NodeViewService(service._pool, service._graph_id, user.id)
        await view_service.create_default_views(node_id, types_needed)
    
    # Return all views
    all_views = await repo.list_by_node(node_id)
    responses = [
        await _node_view_to_response(v, include_query_ast=True, user=user)
        for v in all_views
    ]
    
    return {"views": responses}


@router.post("/reset/{node_id}")
async def reset_node_views(
    node_id: int,
    user: User = Depends(get_current_user),
) -> Dict[str, List[NodeViewResponse]]:
    """Reset all views for a node to defaults.
    
    Deletes all existing views (both custom and default) and recreates 
    a single default "all" view with default filters for each view type.
    
    Args:
        node_id: The node ID to reset views for
        
    Returns:
        Dict with 'views' list of newly created default views
    """
    from ...domain.services.node_view_service import NodeViewService
    
    service = await _get_node_service(user)
    if service._graph_id is None:
        raise HTTPException(status_code=500, detail="Graph ID not set")
    
    repo = await _get_node_view_repo(user)
    
    # Get ALL existing views including inactive ones (soft-deleted)
    # We need include_inactive=True to also delete soft-deleted views,
    # otherwise they'll conflict with ON CONFLICT when creating new defaults
    existing_views = await repo.list_by_node(node_id, include_inactive=True)
    
    # Hard delete all existing views (soft delete would conflict with ON CONFLICT constraint)
    for view in existing_views:
        await repo.hard_delete(view.id)
    
    logger.info(f"Deleted {len(existing_views)} views for node {node_id}")
    
    # Create new default views for all standard view types
    from ...db.schema.constants import DEFAULT_VIEW_CLASSES
    logger.info(f"service._graph_id={service._graph_id}, user.id={user.id}")
    view_service = NodeViewService(service._pool, service._graph_id, user.id)
    logger.info(f"Creating default views for node {node_id}, types: {DEFAULT_VIEW_CLASSES}")
    created_views = await view_service.create_default_views(node_id, DEFAULT_VIEW_CLASSES)
    logger.info(f"create_default_views returned {len(created_views)} views")
    
    # Convert the created views directly to responses (don't re-query)
    responses = [
        await _node_view_to_response(v, include_query_ast=True, user=user)
        for v in created_views
    ]
    
    logger.info(f"Created {len(created_views)} default views for node {node_id}, returning {len(responses)} responses")
    
    return {"views": responses}
