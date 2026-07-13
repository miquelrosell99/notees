"""Node Views API router.

Provides endpoints for managing NodeViews - dynamic query tabs for nodes.
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.dependencies import (
    _get_node_view_repo,
    get_current_user,
    get_node_repository,
    get_node_view_repository,
    get_property_repository,
    get_query_executor,
    require_write_scope,
)
from app.domain.entities.query_ast import QueryAST
from app.domain.errors import DomainError
from app.domain.repositories.interfaces import QueryRepository
from app.domain.services.query_ast_validation import validate_query_ast
from app.domain.services.query_language import QueryLanguageError, parse_query_language
from app.features.nodes.node_view_service import NodeViewService
from app.features.nodes.port import NodeRepository, NodeViewRepository
from app.features.properties.port import PropertyRepository
from app.logging_config import get_logger
from app.models import User

from .dependencies import resolve_node_uuid, resolve_view_uuid, resolve_view_uuids
from .helpers import (
    _build_node_uuid_map,
    _get_node_service,
    _resolve_referenced_display_names,
    extract_properties_dict,
)

logger = get_logger(__name__)
router = APIRouter(tags=["NodeViews"])


# ==================== Pydantic Models ====================


class NodeViewResponse(BaseModel):
    """NodeView response model."""

    id: int
    uuid: str
    node_uuid: str
    name: str
    view_type: str
    order_index: int
    is_default: bool
    active: bool
    shown_properties: list[dict[str, Any]] = []
    group_by: str | list[str] | None = None
    view_mode: str | None = None
    sort_entries: list[dict[str, Any]] = []
    settings: dict[str, Any] = {}
    create_date: str
    write_date: str
    # The query AST JSON
    query_ast: dict[str, Any] | None = None


class NodeViewCreateRequest(BaseModel):
    """Request to create a NodeView."""

    node_uuid: str
    name: str
    view_type: str
    order_index: int = 0
    is_default: bool = False
    query_ast: dict[str, Any] | None = None


class NodeViewUpdateRequest(BaseModel):
    """Request to update a NodeView.

    Fields left as None are not touched. Note this means view_mode/group_by
    cannot be reset to NULL through this endpoint — clients send explicit
    values (e.g. 'list' / 'none') instead.
    """

    name: str | None = None
    order_index: int | None = None
    is_default: bool | None = None
    shown_properties: list[dict[str, Any]] | None = None
    group_by: str | list[str] | None = None
    view_mode: str | None = None
    sort_entries: list[dict[str, Any]] | None = None
    settings: dict[str, Any] | None = None


class QueryExecuteRequest(BaseModel):
    """Request to execute a query."""

    query_ast: dict[str, Any] | None = None
    runtime_params: dict[str, Any] | None = None
    limit: int | None = Field(None, ge=1, le=1000)
    offset: int | None = Field(None, ge=0)
    order_by: str | None = None
    include_children: bool | None = False
    include_all_children: bool | None = False
    pages_only: bool | None = False
    include_properties: bool | None = False
    # Enrichment control — only fetch what the view actually needs
    enrich: dict[str, bool] | None = None
    # Backend aggregation (count + group_by)
    aggregation: dict[str, Any] | None = None
    # Compact text query language alternative to query_ast
    query_language: str | None = None


class QueryParseRequest(BaseModel):
    """Request to parse a text query into QueryAST."""

    query_language: str


class QueryASTUpdateRequest(BaseModel):
    """Request to update query AST."""

    query_ast: dict[str, Any]


class NodeViewReorderRequest(BaseModel):
    """Request to reorder NodeViews."""

    view_uuids: list[str]


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

    resolved_map = await _resolve_referenced_display_names(service, nodes_with_links)

    # Set display_name on matching nodes
    for node in nodes_with_links:
        node_uuid = str(node.get("uuid", ""))
        if node_uuid in resolved_map:
            node["display_name"] = resolved_map[node_uuid]

    return results


async def _include_classes_for_results(user: User, results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fetch and attach classes for each node in results.

    This adds 'classes' (numeric IDs) and 'classes_uuid' (public UUIDs) to each
    node dict. Recursively processes children as well.
    """
    if not results:
        return results

    service = await _get_node_service(user)

    def _collect_node_ids(nodes: list[dict[str, Any]], target: set[int]):
        for node in nodes:
            node_id = node.get("id")
            if node_id:
                target.add(node_id)
            children = node.get("children")
            if children:
                _collect_node_ids(children, target)

    result_node_ids: set[int] = set()
    _collect_node_ids(results, result_node_ids)
    if not result_node_ids:
        return results

    classes_map = await service.get_class_ids_batch(list(result_node_ids))

    # Collect all class IDs so we can resolve them to UUIDs in one batch.
    all_class_ids: set[int] = set()
    for class_ids in classes_map.values():
        all_class_ids.update(class_ids)

    class_uuid_map: dict[int, str] = {}
    if all_class_ids:
        class_nodes = await service.get_nodes_by_ids(list(all_class_ids))
        class_uuid_map = {node.id: node.uuid for node in class_nodes if node.id is not None}

    async def _add_classes_recursive(nodes: list[dict[str, Any]]):
        """Recursively add classes to nodes and their children."""
        for node in nodes:
            node_id = node.get("id")
            if node_id and node_id in classes_map:
                class_ids = classes_map[node_id]
                node["classes"] = class_ids
                node["classes_uuid"] = [
                    class_uuid_map[class_id] for class_id in class_ids if class_id in class_uuid_map
                ]

            # Recursively process children
            children = node.get("children")
            if children:
                await _add_classes_recursive(children)

    # Process all results and their children recursively
    await _add_classes_recursive(results)

    return results


async def _include_children_for_results(
    user: User, results: list[dict[str, Any]], blocks_only: bool = False, pages_only: bool = False
) -> list[dict[str, Any]]:
    """Recursively fetch children for each node in results.

    This adds 'children' to each node dict, populated with their child nodes.

    When blocks_only is True (e.g. card view): only fetches direct child blocks (not pages), no recursion.
    When pages_only is True (e.g. all_pages view): only fetches child pages recursively, skipping blocks.
    Otherwise: fetches all descendants (pages and blocks) recursively.
    """
    if not results:
        return results

    logger.info("[_include_children_for_results] Starting with %s results", len(results))

    service = await _get_node_service(user)

    # Get node IDs from results
    node_ids = [r.get("id") for r in results if r.get("id")]

    logger.info("[_include_children_for_results] Fetching children for node_ids: %s", node_ids)

    if not node_ids:
        return results

    # Honour explicit pages_only flag unless we are in blocks_only mode
    pages_only = pages_only and not blocks_only

    # Fetch all children for each node recursively
    # We'll use the repository's get_children method which returns direct children
    children_by_parent: dict[int, list[dict[str, Any]]] = {}

    async def fetch_children_recursive(parent_id: int, depth: int = 0):
        """Recursively fetch children and convert to dict format."""
        children = await service.get_node_children(parent_id)
        logger.info(
            "[_include_children_for_results] Parent %s (depth %s) has %s direct children",
            parent_id,
            depth,
            len(children),
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
                }
            )
            # Recursively fetch this child's children (skip recursion in blocks_only mode)
            if not blocks_only:
                await fetch_children_recursive(child.id, depth + 1)
            child_dict["children"] = children_by_parent.get(child.id, [])
            child_dicts.append(child_dict)

        # Defensive deduplication: protect against data bugs that place the same
        # child UUID twice under one parent, which breaks React key uniqueness.
        seen_uuids: set[str] = set()
        deduped_child_dicts: list[dict[str, Any]] = []
        duplicate_uuids: set[str] = set()
        for child_dict in child_dicts:
            child_uuid = child_dict.get("uuid")
            if child_uuid is None:
                deduped_child_dicts.append(child_dict)
                continue
            uuid_str = str(child_uuid)
            if uuid_str in seen_uuids:
                duplicate_uuids.add(uuid_str)
                continue
            seen_uuids.add(uuid_str)
            deduped_child_dicts.append(child_dict)
        if duplicate_uuids:
            logger.warning(
                "[_include_children_for_results] Parent %s has duplicate child UUID(s): %s",
                parent_id,
                sorted(duplicate_uuids),
            )

        children_by_parent[parent_id] = deduped_child_dicts
        logger.info("[_include_children_for_results] Parent %s has %s filtered children", parent_id, len(deduped_child_dicts))

    # Fetch children for each result node
    for node_id in node_ids:
        await fetch_children_recursive(node_id)

    # Assign children to each result
    for result in results:
        node_id = result.get("id")
        children = children_by_parent.get(node_id, [])
        result["children"] = children
        if children:
            result["has_children"] = True

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


async def _include_properties_for_results(
    property_repo: PropertyRepository,
    results: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Fetch and attach properties for each node in results.

    This adds 'properties' to each node dict, populated with their property values.
    Recursively processes children as well.
    Uses batched fetching for efficiency — collects all node IDs first,
    then fetches all properties in bulk.
    """
    if not results:
        return results

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
    node_uuid_map: dict[int, str],
    include_query_ast: bool = False,
    user: User | None = None,
) -> NodeViewResponse:
    """Convert NodeView entity to response model."""
    response = NodeViewResponse(
        id=view.id,
        uuid=view.uuid,
        node_uuid=node_uuid_map.get(view.node_id, ""),
        name=view.name,
        view_type=view.view_type,
        order_index=view.order_index,
        is_default=view.is_default,
        active=view.active,
        shown_properties=view.shown_properties or [],
        group_by=view.group_by,
        view_mode=view.view_mode,
        sort_entries=view.sort_entries or [],
        settings=view.settings or {},
        create_date=view.create_date,
        write_date=view.write_date,
    )

    # query_json is stored directly on the view now
    if include_query_ast:
        response.query_ast = view.query_json

    return response


# ==================== Endpoints ====================


@router.get("", response_model=dict[str, list[NodeViewResponse]])
async def list_node_views(
    node_uuid: str,
    node_repo: NodeRepository = Depends(get_node_repository),
    view_type: str | None = None,
    include_query_ast: bool = False,
    user: User = Depends(get_current_user),
):
    """List NodeViews for a node.

    Args:
        node_uuid: The public node UUID
        view_type: Optional filter by view_type
        include_query_ast: Whether to include query block trees

    Returns:
        Dict with 'views' list
    """
    node = await node_repo.get_by_uuid(node_uuid)
    if node is None or node.id is None:
        raise HTTPException(status_code=404, detail="Node not found")
    node_id = node.id

    repo = await _get_node_view_repo(user)
    views = await repo.list_by_node(node_id, view_type=view_type)

    node_uuid_map = await _build_node_uuid_map(node_repo, [node_id])
    responses = []
    for view in views:
        resp = await _node_view_to_response(
            view,
            node_uuid_map=node_uuid_map,
            include_query_ast=include_query_ast,
            user=user if include_query_ast else None,
        )
        responses.append(resp)

    return {"views": responses}


@router.get("/{view_uuid}", response_model=NodeViewResponse)
async def get_node_view(
    view_id: int = Depends(resolve_view_uuid),
    node_repo: NodeRepository = Depends(get_node_repository),
    include_query_ast: bool = True,
    user: User = Depends(get_current_user),
):
    """Get a NodeView by UUID."""
    repo = await _get_node_view_repo(user)
    view = await repo.get_by_id(view_id)

    if not view:
        raise HTTPException(status_code=404, detail="NodeView not found")

    node_uuid_map = await _build_node_uuid_map(node_repo, [view.node_id])
    return await _node_view_to_response(
        view,
        node_uuid_map=node_uuid_map,
        include_query_ast=include_query_ast,
        user=user if include_query_ast else None,
    )


@router.get("/default/{node_uuid}/{view_type}", response_model=NodeViewResponse | None)
async def get_default_view(
    node_id: int = Depends(resolve_node_uuid),
    node_repo: NodeRepository = Depends(get_node_repository),
    view_type: str = ...,
    include_query_ast: bool = True,
    user: User = Depends(get_current_user),
):
    """Get the default NodeView for a view_type."""
    repo = await _get_node_view_repo(user)
    view = await repo.get_default_view(node_id, view_type)

    if not view:
        return None

    node_uuid_map = await _build_node_uuid_map(node_repo, [node_id])
    return await _node_view_to_response(
        view,
        node_uuid_map=node_uuid_map,
        include_query_ast=include_query_ast,
        user=user if include_query_ast else None,
    )


@router.post("", response_model=NodeViewResponse, dependencies=[Depends(require_write_scope)])
async def create_node_view(
    request: NodeViewCreateRequest,
    node_repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """Create a new NodeView.

    Accepts query_ast in QueryAST format.
    Stores as QueryAST format internally.
    """
    repo = await _get_node_view_repo(user)
    view_service = NodeViewService(repo)

    node = await node_repo.get_by_uuid(request.node_uuid)
    if node is None or node.id is None:
        raise HTTPException(status_code=404, detail="Node not found")
    node_id = node.id

    try:
        query_json = view_service.prepare_query_ast_for_create(request.query_ast)
    except DomainError as e:
        raise HTTPException(status_code=400, detail=e.message) from e

    # Create the NodeView with query_json
    view = await repo.create(
        node_id=node_id,
        name=request.name,
        view_type=request.view_type,
        query_json=query_json,
        order_index=request.order_index,
        is_default=request.is_default,
    )

    node_uuid_map = {node_id: request.node_uuid}
    return await _node_view_to_response(view, node_uuid_map=node_uuid_map, include_query_ast=True, user=user)


@router.put("/{view_uuid}", response_model=NodeViewResponse, dependencies=[Depends(require_write_scope)])
async def update_node_view(
    request: NodeViewUpdateRequest,
    view_id: int = Depends(resolve_view_uuid),
    node_repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """Update a NodeView."""
    repo = await _get_node_view_repo(user)

    view = await repo.update(
        view_id=view_id,
        name=request.name,
        order_index=request.order_index,
        is_default=request.is_default,
        shown_properties=request.shown_properties,
        group_by=request.group_by,
        view_mode=request.view_mode,
        sort_entries=request.sort_entries,
        settings=request.settings,
    )

    if not view:
        raise HTTPException(status_code=404, detail="NodeView not found")

    node_uuid_map = await _build_node_uuid_map(node_repo, [view.node_id])
    return await _node_view_to_response(view, node_uuid_map=node_uuid_map, include_query_ast=True, user=user)


@router.post(
    "/{view_uuid}/duplicate",
    response_model=NodeViewResponse,
    dependencies=[Depends(require_write_scope)],
)
async def duplicate_node_view(
    view_id: int = Depends(resolve_view_uuid),
    node_repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """Duplicate a NodeView, copying its query AST and full presentation config.

    The copy is appended at the end of the view_type's tab order and is never
    marked as default.
    """
    repo = await _get_node_view_repo(user)
    view_service = NodeViewService(repo)

    try:
        view = await view_service.duplicate_view(view_id)
    except DomainError as e:
        raise HTTPException(status_code=404, detail=e.message) from e

    node_uuid_map = await _build_node_uuid_map(node_repo, [view.node_id])
    return await _node_view_to_response(view, node_uuid_map=node_uuid_map, include_query_ast=True, user=user)


@router.put("/{view_uuid}/query-ast", response_model=NodeViewResponse, dependencies=[Depends(require_write_scope)])
async def update_query_ast(
    request: QueryASTUpdateRequest,
    view_id: int = Depends(resolve_view_uuid),
    node_repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """Update the query AST for a NodeView (preferred endpoint).

    Validates the AST before saving. For system views (linked references, child pages),
    allows user-added filters but preserves the system condition and is_system flag.
    """
    repo = await _get_node_view_repo(user)
    view_service = NodeViewService(repo)

    try:
        query_json = await view_service.prepare_query_ast_for_update(view_id, request.query_ast)
    except DomainError as e:
        raise HTTPException(status_code=400, detail=e.message) from e

    updated_view = await repo.update_query_json(view_id, query_json)
    if not updated_view:
        raise HTTPException(status_code=500, detail="Failed to update query")

    node_uuid_map = await _build_node_uuid_map(node_repo, [updated_view.node_id])
    return await _node_view_to_response(updated_view, node_uuid_map=node_uuid_map, include_query_ast=True, user=user)


@router.post("/validate-query-ast", response_model=dict[str, Any])
async def validate_query_ast_endpoint(
    request: QueryASTUpdateRequest,
    user: User = Depends(get_current_user),
):
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


@router.delete("/{view_uuid}", response_model=dict[str, bool], dependencies=[Depends(require_write_scope)])
async def delete_node_view(
    view_id: int = Depends(resolve_view_uuid),
    user: User = Depends(get_current_user),
):
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


@router.post("/reorder/{node_uuid}/{view_type}", response_model=dict[str, list[NodeViewResponse]], dependencies=[Depends(require_write_scope)])
async def reorder_node_views(
    node_id: int = Depends(resolve_node_uuid),
    view_type: str = ...,
    request: NodeViewReorderRequest = ...,
    node_repo: NodeRepository = Depends(get_node_repository),
    view_repo: NodeViewRepository = Depends(get_node_view_repository),
    user: User = Depends(get_current_user),
):
    """Reorder NodeViews within a view_type."""
    view_ids = await resolve_view_uuids(request.view_uuids, view_repo)

    repo = await _get_node_view_repo(user)
    views = await repo.reorder(node_id, view_type, view_ids)

    node_uuid_map = await _build_node_uuid_map(node_repo, [node_id])
    responses = [await _node_view_to_response(v, node_uuid_map=node_uuid_map) for v in views]
    return {"views": responses}


@router.post("/{view_uuid}/execute", response_model=dict[str, Any])
async def execute_node_view_query(
    view_id: int = Depends(resolve_view_uuid),
    request: QueryExecuteRequest | None = None,
    user: User = Depends(get_current_user),
    executor: QueryRepository = Depends(get_query_executor),
    property_repo: PropertyRepository = Depends(get_property_repository),
):
    """Execute a NodeView's query and return results.

    Args:
        view_uuid: The NodeView UUID
        request: Optional query execution parameters (runtime params, limit, offset, etc.)

    Returns:
        Dict with:
          - 'nodes': list of matching nodes
          - 'total_count': total matching rows (when paginating)
          - 'metrics': execution performance metrics
    """
    repo = await _get_node_view_repo(user)

    view = await repo.get_by_id(view_id)
    if not view:
        raise HTTPException(status_code=404, detail="NodeView not found")

    # Execute the query with optional overrides from request
    request = request or QueryExecuteRequest()

    logger.debug(
        "[execute_node_view_query] view_id=%s runtime_params keys=%s",
        view_id,
        list(request.runtime_params.keys()) if request.runtime_params else None,
    )

    # Use request query_ast if provided, otherwise use view's query_json
    effective_query = request.query_ast if request.query_ast else view.query_json
    if request.query_language:
        try:
            effective_query = parse_query_language(request.query_language).to_dict()
        except QueryLanguageError as e:
            raise HTTPException(status_code=400, detail=f"Query language error: {e}") from e
    if not effective_query:
        effective_query = {
            "type": "query",
            "version": "1.0",
            "scope": {"type": "scope", "scope_type": "entire_workspace"},
            "root_group": {"type": "group", "logic": "AND", "children": []},
        }

    if request.aggregation:
        effective_query["aggregation"] = request.aggregation

    logger.debug(
        "[execute_node_view_query] effective_query scope_type=%s root_group_children=%s",
        effective_query.get("scope", {}).get("scope_type"),
        len(effective_query.get("root_group", {}).get("children", [])),
    )

    # New execute_query returns a dict with nodes + metrics
    exec_result = await executor.execute_query(
        query=effective_query,
        runtime_params=request.runtime_params,
        limit=request.limit,
        offset=request.offset,
        order_by=request.order_by,
    )

    # Aggregation queries return groups, not nodes. Skip enrichment for them.
    if request.aggregation:
        response: dict[str, Any] = {
            "groups": exec_result.get("groups", []),
            "metrics": exec_result.get("metrics"),
        }
        return response

    results = exec_result["nodes"]

    logger.debug(
        "[execute_node_view_query] Query returned %s nodes (include_children=%s)",
        len(results),
        request.include_children,
    )

    # Determine enrichment — use explicit enrich dict if provided, else fallback to flags
    enrich = request.enrich or {}
    should_include_children = enrich.get("children", request.include_children or False)
    should_include_classes = enrich.get("classes", True)  # Always include by default
    should_include_properties = enrich.get("properties", request.include_properties or False)

    # Lazy enrichment: only fetch what's actually needed
    if should_include_children:
        logger.debug("[execute_node_view_query] Fetching children for %s nodes", len(results))
        results = await _include_children_for_results(user, results, blocks_only=request.include_all_children or False, pages_only=request.pages_only or False)

    if should_include_classes:
        results = await _include_classes_for_results(user, results)

    if should_include_properties:
        results = await _include_properties_for_results(property_repo, results)

    results = await _resolve_display_names_for_results(user, results)

    response: dict[str, Any] = {"nodes": results}

    # Include pagination metadata when available
    if "total_count" in exec_result:
        response["total_count"] = exec_result["total_count"]

    # Include execution metrics
    if "metrics" in exec_result:
        response["metrics"] = exec_result["metrics"]

    return response


@router.post("/execute", response_model=dict[str, Any])
async def execute_query(
    request: QueryExecuteRequest,
    user: User = Depends(get_current_user),
    executor: QueryRepository = Depends(get_query_executor),
    property_repo: PropertyRepository = Depends(get_property_repository),
):
    """Execute a query directly (without saving).

    Args:
        request: Query execution request with query_ast and optional params

    Returns:
        Dict with 'nodes'/'groups', optional 'total_count' and 'metrics'
    """
    effective_query = request.query_ast
    if request.query_language:
        try:
            effective_query = parse_query_language(request.query_language).to_dict()
        except QueryLanguageError as e:
            raise HTTPException(status_code=400, detail=f"Query language error: {e}") from e
    if not effective_query:
        effective_query = {
            "type": "query",
            "version": "1.0",
            "scope": {"type": "scope", "scope_type": "entire_workspace"},
            "root_group": {"type": "group", "logic": "AND", "children": []},
        }

    if request.aggregation:
        effective_query["aggregation"] = request.aggregation

    exec_result = await executor.execute_query(
        query=effective_query,
        runtime_params=request.runtime_params,
        limit=request.limit,
        offset=request.offset,
        order_by=request.order_by,
    )

    # Aggregation queries return groups, not nodes. Skip enrichment for them.
    if effective_query.get("aggregation"):
        return {
            "groups": exec_result.get("groups", []),
            "metrics": exec_result.get("metrics"),
        }

    results = exec_result.get("nodes", [])

    # Lazy enrichment
    enrich = request.enrich or {}
    should_include_children = enrich.get("children", request.include_children or False)
    should_include_classes = enrich.get("classes", True)
    should_include_properties = enrich.get("properties", request.include_properties or False)

    if should_include_children:
        results = await _include_children_for_results(user, results, blocks_only=request.include_all_children or False, pages_only=request.pages_only or False)

    if should_include_classes:
        results = await _include_classes_for_results(user, results)

    if should_include_properties:
        results = await _include_properties_for_results(property_repo, results)

    results = await _resolve_display_names_for_results(user, results)

    response: dict[str, Any] = {"nodes": results}
    if "total_count" in exec_result:
        response["total_count"] = exec_result["total_count"]
    if "metrics" in exec_result:
        response["metrics"] = exec_result["metrics"]

    return response


@router.post("/parse", response_model=dict[str, Any])
async def parse_query_language_endpoint(
    request: QueryParseRequest,
    user: User = Depends(get_current_user),
):
    """Parse a compact text query into a QueryAST without executing it."""
    try:
        ast = parse_query_language(request.query_language)
        return {"query_ast": ast.to_dict()}
    except QueryLanguageError as e:
        raise HTTPException(status_code=400, detail=f"Query language error: {e}") from e


@router.post("/count", response_model=dict[str, int])
async def count_query_results(
    request: QueryExecuteRequest,
    user: User = Depends(get_current_user),
    executor: QueryRepository = Depends(get_query_executor),
):
    """Count results for a query without fetching all data.

    Args:
        request: Query execution request with query_ast

    Returns:
        Dict with 'count' of matching nodes
    """
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


@router.post("/ensure-defaults/{node_uuid}", response_model=dict[str, list[NodeViewResponse]], dependencies=[Depends(require_write_scope)])
async def ensure_default_views(
    node_id: int = Depends(resolve_node_uuid),
    node_repo: NodeRepository = Depends(get_node_repository),
    view_types: list[str] | None = None,
    user: User = Depends(get_current_user),
):
    """Ensure default views exist for a node.

    This is a lazy initialization endpoint - it creates default views
    if they don't exist yet. Safe to call multiple times.

    Args:
        node_uuid: The public node UUID to create views for
        view_types: Optional list of view types to ensure (defaults to all)

    Returns:
        Dict with 'views' list of all views for the node
    """
    service = await _get_node_service(user)
    if service.workspace_id is None:
        raise HTTPException(status_code=500, detail="Workspace ID not set")

    repo = await _get_node_view_repo(user)

    # Get existing views
    existing_views = await repo.list_by_node(node_id)
    existing_view_types = {v.view_type for v in existing_views}

    # Determine which view types to create
    from app.db.schema.constants import DEFAULT_VIEW_CLASSES

    types_to_create = view_types if view_types else DEFAULT_VIEW_CLASSES
    types_needed = [vt for vt in types_to_create if vt not in existing_view_types]

    # Create missing views
    if types_needed:
        view_service = NodeViewService(repo)
        await view_service.create_default_views(node_id, types_needed)

    # Return all views
    all_views = await repo.list_by_node(node_id)
    node_uuid_map = await _build_node_uuid_map(node_repo, [node_id])
    responses = [await _node_view_to_response(v, node_uuid_map=node_uuid_map, include_query_ast=True, user=user) for v in all_views]

    return {"views": responses}


@router.post("/reset/{node_uuid}", response_model=dict[str, list[NodeViewResponse]], dependencies=[Depends(require_write_scope)])
async def reset_node_views(
    node_id: int = Depends(resolve_node_uuid),
    node_repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """Reset all views for a node to defaults.

    Deletes all existing views (both custom and default) and recreates
    a single default "all" view with default filters for each view type.

    Args:
        node_uuid: The public node UUID to reset views for

    Returns:
        Dict with 'views' list of newly created default views
    """
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

    logger.info("Deleted %s views (including non-default views) for node %s", len(existing_views), node_id)

    # Create new default views for all standard view types
    from app.db.schema.constants import DEFAULT_VIEW_CLASSES

    logger.debug("service.workspace_id=%s, user.id=%s", service.workspace_id, user.id)
    view_service = NodeViewService(repo)
    logger.debug("Creating default views for node %s, types: %s", node_id, DEFAULT_VIEW_CLASSES)
    created_views = await view_service.create_default_views(node_id, DEFAULT_VIEW_CLASSES)
    logger.debug("create_default_views returned %s views", len(created_views))

    # Convert the created views directly to responses (don't re-query)
    node_uuid_map = await _build_node_uuid_map(node_repo, [node_id])
    responses = [await _node_view_to_response(v, node_uuid_map=node_uuid_map, include_query_ast=True, user=user) for v in created_views]

    logger.info("Created %s default views for node %s", len(created_views), node_id)

    return {"views": responses}
