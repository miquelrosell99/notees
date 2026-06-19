"""Search, list, and workspace endpoints for nodes."""

import contextlib

from fastapi import APIRouter, Depends, HTTPException, Query

from app.dependencies import get_current_user
from app.models import PaginatedResponse, User

from .helpers import (
    _build_children_tree,
    _get_node_service,
    _node_to_response,
    _resolve_display_names_for_responses,
)
from .models import (
    LinksRequest,
    LinksResponse,
    NodeResponse,
    SearchResponse,
    WorkspaceDataResponse,
    WorkspaceLinkResponse,
    WorkspaceNodeResponse,
)

router = APIRouter()


@router.get("/workspace", response_model=WorkspaceDataResponse)
async def get_workspace_data_endpoint(
    page: int = Query(1, ge=1),
    page_size: int = Query(500, ge=1, le=5000),
    user: User = Depends(get_current_user),
):
    """Get workspace data for visualization with nodes and links.

    Returns all pages as nodes and links between them based on node_link table.
    """
    service = await _get_node_service(user)
    total, node_dicts, link_dicts = await service.get_workspace_data(page, page_size)

    nodes = [
        WorkspaceNodeResponse(
            id=n["id"],
            uuid=n["uuid"],
            name=n["name"],
            icon=n["icon"],
            is_class=n["is_class"],
            is_daily=n["is_daily"],
            is_monthly=n["is_monthly"],
            is_yearly=n["is_yearly"],
            class_ids=n["class_ids"],
            block_count=n["block_count"],
            aliased_id=n["aliased_id"],
        )
        for n in node_dicts
    ]
    links = [
        WorkspaceLinkResponse(source=link["source"], target=link["target"], type=link["type"])
        for link in link_dicts
    ]

    return WorkspaceDataResponse(
        nodes=nodes,
        links=links,
        total=total,
        page=page,
        page_size=page_size,
        has_next=(page * page_size) < total,
        has_prev=page > 1,
    )


@router.get("/workspace/nodes")
async def get_workspace_nodes_endpoint(
    page: int = Query(1, ge=1),
    page_size: int | None = Query(None, ge=1, le=1000),
    user: User = Depends(get_current_user),
):
    """Get workspace nodes for visualization (without links).

    Returns the same nodes as /workspace but omits the links payload,
    making it significantly lighter for cases where the caller fetches
    links separately via POST /links.

    Pagination is capped at 1000 items per page. If page_size is omitted, a
    default of 100 is used.
    """
    if page_size is None:
        page_size = 100
    service = await _get_node_service(user)

    total, node_dicts = await service.get_workspace_nodes(page, page_size)

    nodes = [
        WorkspaceNodeResponse(
            id=n["id"],
            uuid=n["uuid"],
            name=n["name"],
            icon=n["icon"],
            is_class=n["is_class"],
            is_daily=n["is_daily"],
            is_monthly=n["is_monthly"],
            is_yearly=n["is_yearly"],
            class_ids=n["class_ids"],
            block_count=n["block_count"],
        )
        for n in node_dicts
    ]

    return PaginatedResponse[WorkspaceNodeResponse](
        items=nodes,
        total=total,
        page=page,
        page_size=page_size,
        has_next=(page * page_size) < total,
        has_prev=page > 1,
    )


@router.post("/links", response_model=LinksResponse)
async def get_links_for_nodes(
    body: LinksRequest,
    user: User = Depends(get_current_user),
):
    """Get links for a specific set of node IDs.

    Accepts {"node_ids": [1, 2, 3, ...], "scope": "between" | "touching",
             "cooccurrence": true | false, "context_node_id": id | null}
    and returns links (reference, parent, class, extends, property-reference, cooccurrence).

    Scopes:
      - "between" (default): only links where BOTH source and target are in the set.
        Use for rendering a graph of known nodes.
      - "touching": links where AT LEAST ONE end is in the set.
        Use for discovering connections from a starting set of nodes.

    Co-occurrence:
      - Without context_node_id: global flat co-occurrence across all blocks mentioning the node set.
      - With context_node_id: parent-inclusive co-occurrence within the context page.
    """
    node_ids = body.node_ids
    scope = body.scope
    cooccurrence = body.cooccurrence
    if not node_ids or not isinstance(node_ids, list):
        return LinksResponse(links=[])
    if scope not in ("between", "touching"):
        raise HTTPException(status_code=400, detail="scope must be 'between' or 'touching'")

    service = await _get_node_service(user)
    links = await service.get_links_for_nodes(
        node_ids, scope, cooccurrence, body.context_node_id
    )

    return LinksResponse(links=links)


@router.get("/search", response_model=SearchResponse)
async def search_nodes(
    q: str = "",
    limit: int = Query(50, ge=1, le=5000),
    page: int = Query(1, ge=1),
    sort_by: str = Query("write_date", description="Field to sort by: name, write_date, create_date"),
    order: str = Query("desc", description="Sort order: asc or desc"),
    class_filters: str | None = None,  # Comma-separated class IDs to filter by
    uuid: str | None = None,  # Direct UUID lookup (prefix match)
    is_page: bool | None = None,  # Filter by is_page flag
    is_class: bool | None = None,  # Filter by is_class flag
    is_daily: bool | None = None,  # Filter by is_day flag
    is_user_page: bool | None = None,  # Filter to user pages only
    user: User = Depends(get_current_user),
):
    """Search nodes by name, UUID, or filtered by properties.

    Args:
        q: Search query (name search)
        limit: Maximum number of results per page (capped at 5000)
        page: Page number (1-indexed)
        sort_by: Field to sort by (name, write_date, create_date)
        order: Sort order (asc, desc)
        class_filters: Optional comma-separated list of class IDs to filter results
        uuid: Optional UUID prefix to search by (exact or prefix match)
        is_page: Optional boolean to filter pages vs blocks
        is_class: Optional boolean to filter class definitions
        is_daily: Optional boolean to filter daily notes
        is_user_page: Optional boolean to filter user pages (mentions)

    Returns nodes with class_ids populated for reliable filtering.
    """
    if sort_by not in ("name", "write_date", "create_date"):
        sort_by = "write_date"
    if order not in ("asc", "desc"):
        order = "desc"

    service = await _get_node_service(user)

    # UUID search: direct lookup by UUID (exact match first, then prefix)
    if uuid:
        uuid = uuid.strip()
        if uuid:
            # Try exact match first
            node = await service.get_node_by_uuid(uuid)
            if node and node.id is not None:
                node_class_ids = node.class_ids or []
                response = _node_to_response(node, classes=node_class_ids)
                await _resolve_display_names_for_responses(service, [node], [response])
                return SearchResponse(nodes=[response])

            # Fall back to prefix match (uuid starts with the search term)
            if len(uuid) >= 4:  # Require at least 4 chars for prefix search
                nodes = await service.search_by_uuid_prefix(uuid, min(limit, 20))
                result = []
                for node_obj in nodes:
                    node_class_ids = node_obj.class_ids or []
                    result.append(_node_to_response(node_obj, classes=node_class_ids))
                await _resolve_display_names_for_responses(service, nodes, result)
                return SearchResponse(nodes=result)

            return SearchResponse(nodes=[])

    # Parse class filters if provided
    filter_class_ids: list[int] | None = None
    if class_filters:
        with contextlib.suppress(ValueError):
            filter_class_ids = [int(cid.strip()) for cid in class_filters.split(",") if cid.strip()]

    offset = (page - 1) * limit
    nodes = await service.search(
        q,
        limit=limit,
        offset=offset,
        class_filters=filter_class_ids,
        is_page=is_page,
        is_class=is_class,
        is_daily=is_daily,
        is_user_page=is_user_page,
        sort_by=sort_by,
        order=order,
    )

    result = []
    for n in nodes:
        if n.id is None:
            continue
        node_class_ids = n.class_ids or []
        result.append(_node_to_response(n, classes=node_class_ids))

    # Resolve inline node links so search results, command palette items, and
    # similar surfaces show target names instead of "…" for link-only content.
    await _resolve_display_names_for_responses(service, nodes, result)

    return SearchResponse(nodes=result)


@router.get("/", name="list_nodes")
async def list_nodes(
    pages_only: bool = False,
    parent_id: int | None = None,
    type_id: int | None = None,
    class_filters: str | None = None,  # Comma-separated class IDs to filter by
    include_children: bool = False,
    root_only: bool = False,  # Only return nodes with no parent
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int | None = Query(None, ge=1, description="Items per page (omit to return all)"),
    sort_by: str = Query("sequence", description="Field to sort by: name, write_date, create_date, sequence"),
    order: str = Query("asc", description="Sort order: asc or desc"),
    user: User = Depends(get_current_user),
):
    """List nodes with optional filters, sorting, and pagination.

    Args:
        pages_only: Only return pages (no blocks)
        parent_id: Only return children of this node
        type_id: Only return nodes with this type
        class_filters: Additional comma-separated class IDs to filter by
        include_children: Include nested children for each node
        root_only: Only return root nodes (no parent_id)
        page: Page number (1-indexed)
        page_size: Number of items per page, or omit to disable pagination
        sort_by: Field to sort by (name, write_date, create_date, sequence)
        order: Sort order (asc, desc)

    Returns paginated nodes with class_ids populated for reliable filtering.
    When page_size is omitted, all matching nodes are returned.
    """
    if sort_by not in ("name", "write_date", "create_date", "sequence"):
        sort_by = "sequence"
    if order not in ("asc", "desc"):
        order = "asc"

    # Clamp page_size to the endpoint's maximum to prevent unbounded reads.
    effective_page_size = min(page_size or 1000, 5000)

    service = await _get_node_service(user)

    # Parse class filters if provided and expand them to include subclasses.
    expanded_class_ids: list[int] | None = None
    if class_filters:
        with contextlib.suppress(ValueError):
            parsed = {int(cid.strip()) for cid in class_filters.split(",") if cid.strip()}
            if parsed:
                expanded_class_ids = list(await service.expand_class_hierarchy(list(parsed)))

    nodes, total = await service.list_nodes(
        pages_only=pages_only,
        parent_id=parent_id,
        type_id=type_id,
        class_ids=expanded_class_ids,
        root_only=root_only,
        sort_by=sort_by,
        order=order,
        page=page,
        page_size=effective_page_size,
    )

    # Build the response; class_ids are already populated on the Node entities.
    class_ids_map = {n.id: list(n.class_ids) for n in nodes if n.id is not None}
    result = [
        _node_to_response(n, classes=class_ids_map.get(n.id, []))
        for n in nodes
        if n.id is not None
    ]

    # Resolve inline node links so table cells, cards, and list items show
    # target page names instead of "…" for link-only content.
    await _resolve_display_names_for_responses(service, nodes, result)

    # Include children if requested; descendant lookup is batched via
    # get_node_descendants_batch inside _build_children_tree.
    if include_children and result:
        result = await _build_children_tree(service, result, class_ids_map)

    has_next = (page * effective_page_size) < total
    has_prev = page > 1

    return PaginatedResponse[NodeResponse](
        items=result,
        total=total,
        page=page,
        page_size=effective_page_size,
        has_next=has_next,
        has_prev=has_prev,
    )
