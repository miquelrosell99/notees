"""Node Views API router.

Provides endpoints for managing NodeViews - dynamic query tabs for nodes.
"""

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ...domain.entities.query_ast import QueryAST, create_default_query_ast
from ...domain.repositories import PostgresNodeViewRepository
from ...domain.services.query_ast_validation import can_save_query, validate_query_ast
from ...domain.services.query_service import QueryExecutor
from ...logging_config import get_logger
from ...models import User
from ..auth import get_current_user
from .helpers import _get_node_service, _resolve_referenced_display_names, extract_properties_dict

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
    shown_properties: list[dict[str, Any]] = []
    group_by: str | None = None
    create_date: str
    write_date: str
    # The query AST JSON
    query_ast: dict[str, Any] | None = None


class NodeViewCreateRequest(BaseModel):
    """Request to create a NodeView."""

    node_id: int
    name: str
    view_type: str
    order_index: int = 0
    is_default: bool = False
    query_ast: dict[str, Any] | None = None


class NodeViewUpdateRequest(BaseModel):
    """Request to update a NodeView."""

    name: str | None = None
    order_index: int | None = None
    is_default: bool | None = None
    shown_properties: list[dict[str, Any]] | None = None
    group_by: str | None = None


class QueryExecuteRequest(BaseModel):
    """Request to execute a query."""

    query_ast: dict[str, Any] | None = None
    runtime_params: dict[str, Any] | None = None
    limit: int | None = None
    offset: int | None = None
    order_by: str | None = None
    include_children: bool | None = False
    include_all_children: bool | None = False
    include_properties: bool | None = False
    # Enrichment control — only fetch what the view actually needs
    enrich: dict[str, bool] | None = None


class QueryASTUpdateRequest(BaseModel):
    """Request to update query AST."""

    query_ast: dict[str, Any]


class NodeViewReorderRequest(BaseModel):
    """Request to reorder NodeViews."""

    view_ids: list[int]


# ==================== Helper Functions ====================


async def _resolve_display_names_for_results(user: User, results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Resolve display_name for nodes whose names contain inline node/class links.

    Nodes with [[nodeLink]] or {{classRef}} in their names will have their
    'display_name' field set to the resolved plain-text name.
    """
    if not results:
        return results

    service = await _get_node_service(user)

    # Collect all nodes recursively (including children)
    def _collect_all(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        all_nodes = []
        for node in nodes:
            all_nodes.append(node)
            if node.get("children"):
                all_nodes.extend(_collect_all(node["children"]))
        return all_nodes

    all_nodes = _collect_all(results)

    # Only process nodes whose names contain link_id tokens
    nodes_with_links = [n for n in all_nodes if n.get("name") and '"link_id"' in n["name"]]
    if not nodes_with_links:
        return results

    resolved_map = await _resolve_referenced_display_names(service.pool, service.workspace_id, nodes_with_links)

    # Set display_name on matching nodes
    for node in nodes_with_links:
        node_uuid = str(node.get("uuid", ""))
        if node_uuid in resolved_map:
            node["display_name"] = resolved_map[node_uuid]

    return results


async def _get_node_view_repo(user: User) -> PostgresNodeViewRepository:
    """Get NodeView repository for the current user."""
    service = await _get_node_service(user)
    if service.workspace_id is None:
        raise HTTPException(status_code=500, detail="Workspace ID not set")
    return PostgresNodeViewRepository(
        pool=service.pool,
        workspace_id=service.workspace_id,
        user_id=user.id,
    )


async def _get_query_executor(user: User) -> QueryExecutor:
    """Get query executor for the current user."""
    service = await _get_node_service(user)
    if service.workspace_id is None:
        raise HTTPException(status_code=500, detail="Workspace ID not set")
    return QueryExecutor(
        pool=service.pool,
        workspace_id=service.workspace_id,
        user_id=user.id,
    )


async def _get_property_repo(user: User):
    """Get property repository for the current user."""
    service = await _get_node_service(user)
    return service.property_repo


async def _include_classes_for_results(user: User, results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fetch and attach classes for each node in results.

    This adds 'classes' to each node dict with their class IDs.
    Recursively processes children as well.
    """
    if not results:
        return results

    service = await _get_node_service(user)

    async def _add_classes_recursive(nodes: list[dict[str, Any]]):
        """Recursively add classes to nodes and their children."""
        # Collect all node IDs
        node_ids = [n.get("id") for n in nodes if n.get("id")]
        if not node_ids:
            return

        # Fetch classes for all nodes in batch
        from app.routers.nodes.helpers import _get_class_ids_batch

        classes_map = await _get_class_ids_batch(service.pool, service.workspace_id, node_ids)

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


async def _include_children_for_results(
    user: User, results: list[dict[str, Any]], blocks_only: bool = False
) -> list[dict[str, Any]]:
    """Recursively fetch children for each node in results.

    This adds 'children' to each node dict, populated with their child nodes.

    When blocks_only is False (default): if results are pages, only fetches child pages recursively.
    When blocks_only is True (e.g. card view): only fetches direct child blocks (not pages), no recursion.
    """
    if not results:
        return results

    logger.info(f"[_include_children_for_results] Starting with {len(results)} results")

    service = await _get_node_service(user)

    # Get node IDs from results
    node_ids = [r.get("id") for r in results if r.get("id")]

    logger.info(f"[_include_children_for_results] Fetching children for node_ids: {node_ids}")

    if not node_ids:
        return results

    # Default mode: if all results are pages, filter to pages only
    pages_only = not blocks_only and all(r.get("is_page", False) for r in results if r.get("id"))

    # Fetch all children for each node recursively
    # We'll use the repository's get_children method which returns direct children
    children_by_parent: dict[int, list[dict[str, Any]]] = {}

    async def fetch_children_recursive(parent_id: int, depth: int = 0):
        """Recursively fetch children and convert to dict format."""
        children = await service.get_node_children(parent_id)
        logger.info(
            f"[_include_children_for_results] Parent {parent_id} (depth {depth}) has {len(children)} direct children"
        )
        child_dicts = []
        for child in children:
            # blocks_only mode: only include non-page children (blocks) at depth 0
            if blocks_only and child.is_page:
                continue
            # pages_only mode: skip non-page children
            if pages_only and not child.is_page:
                continue

            child_dict = (
                child.to_dict()
                if hasattr(child, "to_dict")
                else {
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
            )
            # Recursively fetch this child's children (skip recursion in blocks_only mode)
            if not blocks_only:
                await fetch_children_recursive(child.id, depth + 1)
            child_dict["children"] = children_by_parent.get(child.id, [])
            child_dicts.append(child_dict)
        children_by_parent[parent_id] = child_dicts
        logger.info(f"[_include_children_for_results] Parent {parent_id} has {len(child_dicts)} filtered children")

    # Fetch children for each result node
    for node_id in node_ids:
        await fetch_children_recursive(node_id)

    # Assign children to each result
    for result in results:
        node_id = result.get("id")
        result["children"] = children_by_parent.get(node_id, [])

    # Remove any top-level result that already appears as a child of another result.
    # This prevents duplicate display when a child node matches the query but is
    # also nested under another matching parent node.
    def _collect_child_ids(nodes: list[dict[str, Any]]) -> set[int]:
        ids: set[int] = set()
        for node in nodes:
            if node.get("children"):
                for child in node["children"]:
                    child_id = child.get("id")
                    if child_id is not None:
                        ids.add(child_id)
                ids.update(_collect_child_ids(node["children"]))
        return ids

    all_child_ids = _collect_child_ids(results)
    results = [r for r in results if r.get("id") not in all_child_ids]

    return results


async def _include_properties_for_results(user: User, results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fetch and attach properties for each node in results.

    This adds 'properties' to each node dict, populated with their property values.
    Recursively processes children as well.
    Uses batched fetching for efficiency — collects all node IDs first,
    then fetches all properties in bulk.
    """
    if not results:
        return results

    property_repo = await _get_property_repo(user)

    # Collect all node IDs (including nested children) for batch fetching
    def _collect_node_ids(nodes: list[dict[str, Any]], ids: list[int]):
        for node in nodes:
            node_id = node.get("id")
            if node_id:
                ids.append(node_id)
            if node.get("children"):
                _collect_node_ids(node["children"], ids)

    all_ids: list[int] = []
    _collect_node_ids(results, all_ids)

    if not all_ids:
        return results

    # Batch fetch: get all property values for all node IDs at once
    props_map: dict[int, dict] = {}
    batch_result = await property_repo.get_all_property_values_batch(all_ids)
    for node_id, prop_data in batch_result.items():
        props_dict = extract_properties_dict(prop_data)
        if props_dict:
            props_map[node_id] = props_dict

    # Assign properties from the map
    def _assign_properties(nodes: list[dict[str, Any]]):
        for node in nodes:
            node_id = node.get("id")
            if node_id and node_id in props_map:
                node["properties"] = props_map[node_id]
            if node.get("children"):
                _assign_properties(node["children"])

    _assign_properties(results)

    return results


async def _node_view_to_response(
    view,
    include_query_ast: bool = False,
    user: User | None = None,
) -> NodeViewResponse:
    """Convert NodeView entity to response model."""
    # Defensive: shown_properties may occasionally be a JSON string rather than a list
    shown_properties = view.shown_properties
    if isinstance(shown_properties, str):
        try:
            shown_properties = json.loads(shown_properties)
        except json.JSONDecodeError:
            shown_properties = []
    if shown_properties is None:
        shown_properties = []

    response = NodeViewResponse(
        id=view.id,
        uuid=view.uuid,
        node_id=view.node_id,
        name=view.name,
        view_type=view.view_type,
        order_index=view.order_index,
        is_default=view.is_default,
        active=view.active,
        shown_properties=shown_properties,
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
    view_type: str | None = None,
    include_query_ast: bool = False,
    user: User = Depends(get_current_user),
) -> dict[str, list[NodeViewResponse]]:
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
) -> NodeViewResponse | None:
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

    Accepts query_ast in QueryAST format.
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
                raise HTTPException(status_code=403, detail="Cannot create system queries through this endpoint")

            validation = validate_query_ast(ast, allow_system_modification=False)
            if not validation.valid:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid query AST: {validation.issues[0].message if validation.issues else 'Unknown error'}",
                )
            query_json = request.query_ast
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid query AST: {str(e)}") from e
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


@router.put("/{view_id}/query-ast")
async def update_query_ast(
    view_id: int,
    request: QueryASTUpdateRequest,
    user: User = Depends(get_current_user),
) -> NodeViewResponse:
    """Update the query AST for a NodeView (preferred endpoint).

    Validates the AST before saving. For system views (linked references, child pages),
    allows user-added filters but preserves the system condition and is_system flag.
    """
    repo = await _get_node_view_repo(user)

    view = await repo.get_by_id(view_id)
    if not view:
        raise HTTPException(status_code=404, detail="NodeView not found")

    # Check if existing view is a system query
    existing_query = view.query_json or {}
    is_system_view = existing_query.get("is_system", False)

    # Validate AST
    try:
        ast = QueryAST.from_dict(request.query_ast)

        # If this is a system view, preserve the is_system flag regardless of what client sends
        # This prevents users from accidentally removing the system flag
        if is_system_view:
            ast.is_system = True
        else:
            # For non-system views, prevent clients from marking queries as system
            if ast.is_system:
                raise HTTPException(status_code=403, detail="Cannot create system queries through this endpoint")

        # Validate with appropriate flags
        # For system views, we allow modification but validate that system conditions are preserved
        validate_query_ast(ast, allow_system_modification=is_system_view)

        can_save, reason = can_save_query(ast, allow_system_modification=is_system_view)
        if not can_save:
            raise HTTPException(status_code=400, detail=f"Cannot save query: {reason}")

        # Update with validated AST
        updated_view = await repo.update_query_json(view_id, ast.to_dict())

        if not updated_view:
            raise HTTPException(status_code=500, detail="Failed to update query")

        return await _node_view_to_response(updated_view, include_query_ast=True, user=user)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update query AST: {e}")
        raise HTTPException(status_code=400, detail=f"Invalid query AST: {str(e)}") from e


@router.post("/validate-query-ast")
async def validate_query_ast_endpoint(
    request: QueryASTUpdateRequest,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
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
            ],
        }
    except Exception as e:
        return {
            "valid": False,
            "can_save": False,
            "issues": [
                {
                    "severity": "error",
                    "message": f"Failed to parse AST: {str(e)}",
                    "path": "root",
                    "suggestion": None,
                }
            ],
        }


@router.delete("/{view_id}")
async def delete_node_view(
    view_id: int,
    user: User = Depends(get_current_user),
) -> dict[str, bool]:
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
            detail=f"Cannot delete the last view of type '{view.view_type}'. Each node must have at least one view per type.",
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
) -> dict[str, list[NodeViewResponse]]:
    """Reorder NodeViews within a view_type."""
    repo = await _get_node_view_repo(user)

    views = await repo.reorder(node_id, view_type, request.view_ids)

    responses = [await _node_view_to_response(v) for v in views]
    return {"views": responses}


@router.post("/{view_id}/execute")
async def execute_node_view_query(
    view_id: int,
    request: QueryExecuteRequest | None = None,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Execute a NodeView's query and return results.

    Args:
        view_id: The NodeView ID
        request: Optional query execution parameters (runtime params, limit, offset, etc.)

    Returns:
        Dict with:
          - 'nodes': list of matching nodes
          - 'total_count': total matching rows (when paginating)
          - 'metrics': execution performance metrics
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
        effective_query = {
            "type": "query",
            "version": "1.0",
            "scope": {"type": "scope", "scope_type": "entire_workspace"},
            "root_group": {"type": "group", "logic": "AND", "children": []},
        }

    logger.info(
        f"[execute_node_view_query] effective_query scope={effective_query.get('scope')}, root_group={effective_query.get('root_group')}"
    )

    # New execute_query returns a dict with nodes + metrics
    exec_result = await executor.execute_query(
        query=effective_query,
        runtime_params=request.runtime_params,
        limit=request.limit,
        offset=request.offset,
        order_by=request.order_by,
    )

    results = exec_result["nodes"]

    logger.info(
        f"[execute_node_view_query] Query returned {len(results)} nodes (include_children={request.include_children})"
    )

    # Determine enrichment — use explicit enrich dict if provided, else fallback to flags
    enrich = request.enrich or {}
    should_include_children = enrich.get("children", request.include_children or False)
    should_include_classes = enrich.get("classes", True)  # Always include by default
    should_include_properties = enrich.get("properties", request.include_properties or False)

    # Lazy enrichment: only fetch what's actually needed
    if should_include_children:
        logger.info(f"[execute_node_view_query] Fetching children for {len(results)} nodes")
        results = await _include_children_for_results(user, results, blocks_only=request.include_all_children or False)

    if should_include_classes:
        results = await _include_classes_for_results(user, results)

    if should_include_properties:
        results = await _include_properties_for_results(user, results)

    results = await _resolve_display_names_for_results(user, results)

    response: dict[str, Any] = {"nodes": results}

    # Include pagination metadata when available
    if "total_count" in exec_result:
        response["total_count"] = exec_result["total_count"]

    # Include execution metrics
    if "metrics" in exec_result:
        response["metrics"] = exec_result["metrics"]

    return response


@router.post("/execute")
async def execute_query(
    request: QueryExecuteRequest,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Execute a query directly (without saving).

    Args:
        request: Query execution request with query_ast and optional params

    Returns:
        Dict with 'nodes', optional 'total_count' and 'metrics'
    """
    executor = await _get_query_executor(user)

    effective_query = request.query_ast
    if not effective_query:
        effective_query = {
            "type": "query",
            "version": "1.0",
            "scope": {"type": "scope", "scope_type": "entire_workspace"},
            "root_group": {"type": "group", "logic": "AND", "children": []},
        }

    exec_result = await executor.execute_query(
        query=effective_query,
        runtime_params=request.runtime_params,
        limit=request.limit,
        offset=request.offset,
        order_by=request.order_by,
    )

    results = exec_result["nodes"]

    # Lazy enrichment
    enrich = request.enrich or {}
    should_include_children = enrich.get("children", request.include_children or False)
    should_include_classes = enrich.get("classes", True)
    should_include_properties = enrich.get("properties", request.include_properties or False)

    if should_include_children:
        results = await _include_children_for_results(user, results, blocks_only=request.include_all_children or False)

    if should_include_classes:
        results = await _include_classes_for_results(user, results)

    if should_include_properties:
        results = await _include_properties_for_results(user, results)

    results = await _resolve_display_names_for_results(user, results)

    response: dict[str, Any] = {"nodes": results}
    if "total_count" in exec_result:
        response["total_count"] = exec_result["total_count"]
    if "metrics" in exec_result:
        response["metrics"] = exec_result["metrics"]

    return response


@router.post("/count")
async def count_query_results(
    request: QueryExecuteRequest,
    user: User = Depends(get_current_user),
) -> dict[str, int]:
    """Count results for a query without fetching all data.

    Args:
        request: Query execution request with query_ast

    Returns:
        Dict with 'count' of matching nodes
    """
    executor = await _get_query_executor(user)

    effective_query = request.query_ast
    if not effective_query:
        effective_query = {
            "type": "query",
            "version": "1.0",
            "scope": {"type": "scope", "scope_type": "entire_workspace"},
            "root_group": {"type": "group", "logic": "AND", "children": []},
        }

    count = await executor.count_query_results(
        query=effective_query,
        runtime_params=request.runtime_params,
    )

    return {"count": count}


@router.post("/ensure-defaults/{node_id}")
async def ensure_default_views(
    node_id: int,
    view_types: list[str] | None = None,
    user: User = Depends(get_current_user),
) -> dict[str, list[NodeViewResponse]]:
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
    if service.workspace_id is None:
        raise HTTPException(status_code=500, detail="Workspace ID not set")

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
        view_service = NodeViewService(service.pool, service.workspace_id, user.id)
        await view_service.create_default_views(node_id, types_needed)

    # Return all views
    all_views = await repo.list_by_node(node_id)
    responses = [await _node_view_to_response(v, include_query_ast=True, user=user) for v in all_views]

    return {"views": responses}


@router.post("/reset/{node_id}")
async def reset_node_views(
    node_id: int,
    user: User = Depends(get_current_user),
) -> dict[str, list[NodeViewResponse]]:
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
    if service.workspace_id is None:
        raise HTTPException(status_code=500, detail="Workspace ID not set")

    repo = await _get_node_view_repo(user)

    # Get ALL existing views including inactive ones (soft-deleted)
    # We need include_inactive=True to also delete soft-deleted views,
    # otherwise they'll conflict with ON CONFLICT when creating new defaults
    existing_views = await repo.list_by_node(node_id, include_inactive=True)

    # Hard delete all existing views (both default and non-default)
    # This ensures we remove any duplicate views that might exist
    for view in existing_views:
        await repo.hard_delete(view.id)

    logger.info(f"Deleted {len(existing_views)} views (including non-default views) for node {node_id}")

    # Create new default views for all standard view types
    from ...db.schema.constants import DEFAULT_VIEW_CLASSES

    logger.info(f"service.workspace_id={service.workspace_id}, user.id={user.id}")
    view_service = NodeViewService(service.pool, service.workspace_id, user.id)
    logger.info(f"Creating default views for node {node_id}, types: {DEFAULT_VIEW_CLASSES}")
    created_views = await view_service.create_default_views(node_id, DEFAULT_VIEW_CLASSES)
    logger.info(f"create_default_views returned {len(created_views)} views")

    # Convert the created views directly to responses (don't re-query)
    responses = [await _node_view_to_response(v, include_query_ast=True, user=user) for v in created_views]

    logger.info(f"Created {len(created_views)} default views for node {node_id}, returning {len(responses)} responses")

    return {"views": responses}
