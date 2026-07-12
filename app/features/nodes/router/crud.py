"""CRUD operations for nodes."""

from contextlib import suppress
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi_limiter.depends import RateLimiter
from pyrate_limiter import Duration

from app.dependencies import get_current_user, get_node_repository, get_property_repository, require_write_scope
from app.domain.entities import NodeCreateData, NodeUpdateData
from app.domain.errors import (
    DatePageDeletionError,
    DuplicateNodeError,
    NodeNotFoundError,
    NodeValidationError,
    OptimisticLockError,
    SystemClassConstraintError,
)
from app.domain.stringify_ast import extract_node_links, parse_ast
from app.features.nodes.port import NodeRepository
from app.features.notifications.dependencies import get_notification_repository
from app.features.notifications.port import NotificationRepository
from app.features.properties.port import PropertyRepository
from app.features.shares.dependencies import _get_share_service
from app.logging_config import get_logger
from app.models import PaginatedResponse, User
from app.rate_limit import per_ip_limiter, per_user_limiter, user_identifier

from .dependencies import resolve_class_uuids, resolve_node_uuid, resolve_node_uuids
from .helpers import (
    _build_node_detail_response,
    _build_node_uuid_map,
    _enrich_node_responses_uuids,
    _get_alias_ids,
    _get_class_ids,
    _get_class_ids_batch,
    _get_node_service,
    _get_related_ids_batch,
    _get_tag_ids,
    _get_tag_ids_batch,
    _get_undo_service,
    _name_text,
    _node_snapshot,
    _node_to_response,
    _node_to_response_with_permissions,
    _resolve_display_names_for_responses,
    _resolve_property_uuids,
    extract_properties_dict,
)
from .models import (
    BacklinkResponse,
    BreadcrumbItem,
    BreadcrumbSegment,
    BreadcrumbsResponse,
    ConvertToBlockRequest,
    ConvertToPageRequest,
    LinkedReferenceResponse,
    MoveNodeRequest,
    NodeCreateRequest,
    NodeResponse,
    NodeUpdateRequest,
    TemplateInstantiateRequest,
    TemplateInstantiateResponse,
)

logger = get_logger(__name__)

_crud_limiter = per_ip_limiter(120, Duration.MINUTE)
_write_limiter = per_user_limiter(120, Duration.MINUTE)
_delete_limiter = per_user_limiter(60, Duration.MINUTE)
router = APIRouter()


async def _notify_mentions(service, node, actor_user_id: int, repo: NotificationRepository) -> None:
    """Scan node name AST for node links to user pages and create notifications."""
    if not node or not node.name:
        return
    try:
        ast = parse_ast(node.name, mode="JSON")
        links = extract_node_links(ast)
        if not links:
            return

        # Collect all target node UUIDs first
        node_uuids: list[str] = []
        link_index_by_uuid: dict[str, list[dict[str, Any]]] = {}
        for link in links:
            link_id = link.get("link_id", "")
            if not link_id:
                continue
            # link_id may be "nodeUuid:linkUuid" or just "nodeUuid"
            colon = link_id.find(":")
            node_uuid = link_id[:colon] if colon > 0 else link_id
            node_uuids.append(node_uuid)
            link_index_by_uuid.setdefault(node_uuid, []).append(link)

        if not node_uuids:
            return

        # Batch-resolve user IDs for all referenced page-node UUIDs
        user_id_map = await service.find_user_ids_by_page_node_uuids(node_uuids)

        notifications: list[dict[str, Any]] = []
        for node_uuid, user_id in user_id_map.items():
            if user_id is None or user_id == actor_user_id:
                continue
            for link in link_index_by_uuid.get(node_uuid, []):
                label = link.get("label") or "someone"
                notifications.append(
                    {
                        "user_id": user_id,
                        "type": "mention",
                        "actor_user_id": actor_user_id,
                        "node_id": node.id,
                        "message": f"mentioned you in '{label}'",
                    }
                )

        if notifications:
            await repo.create_many(notifications)
    except (LookupError, ValueError):
        logger.exception("Failed to process mentions for node")


@router.post(
    "/",
    name="create_node",
    response_model=NodeResponse,
    dependencies=[
        Depends(RateLimiter(limiter=_crud_limiter)),
        Depends(require_write_scope),
        Depends(RateLimiter(limiter=_write_limiter, identifier=user_identifier)),
    ],
)
async def create_node(
    request: Request,
    body: NodeCreateRequest,
    user: User = Depends(get_current_user),
    notification_repo: NotificationRepository = Depends(get_notification_repository),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
):
    """Create a new node."""
    service = await _get_node_service(user)

    # Resolve optional parent UUID to numeric ID.
    parent_id: int | None = None
    if body.parent_uuid is not None:
        parent = await repo.get_by_uuid(body.parent_uuid)
        if parent is None or parent.id is None:
            raise HTTPException(404, "Parent node not found")
        parent_id = parent.id

    class_ids: list[int] = []
    if body.class_uuids:
        class_ids = await resolve_class_uuids(body.class_uuids, repo)

    tag_ids: list[int] = []
    if body.tag_uuids:
        tag_ids = await resolve_node_uuids(body.tag_uuids, repo)

    property_values: dict[int, Any] = {}
    if body.property_uuids:
        prop_uuids = list(body.property_uuids.keys())
        prop_map = {prop.uuid: prop.id for prop in await property_repo.get_by_uuids(prop_uuids) if prop.id is not None}
        missing_props = [u for u in prop_uuids if u not in prop_map]
        if missing_props:
            raise HTTPException(404, f"Properties not found: {missing_props}")
        for prop_uuid, value in body.property_uuids.items():
            property_values[prop_map[prop_uuid]] = value

    # Create node with provided classes
    # The repository will compute is_page, is_class, etc. from the classes
    data = NodeCreateData(
        name=body.name,
        icon=body.icon,
        color=body.color,
        parent_id=parent_id,
        sequence=body.sequence,
        classes=class_ids,
        tags=tag_ids,
        property_values=property_values,
        uuid=body.uuid,
    )

    try:
        node = await service.create_node(data, user_id=int(user.id))

        # Record for undo (best-effort, outside the node creation transaction)
        try:
            undo = await _get_undo_service(user)
            await undo.record(
                "create_node",
                "node",
                node.id,
                before_state=None,
                after_state=_node_snapshot(node),
                description=f"Created '{_name_text(node.name)}'",
            )
        except (ValueError, TypeError, LookupError):
            pass  # Never fail the mutation because of undo logging
    except DuplicateNodeError as e:
        raise HTTPException(
            status_code=409,
            detail={
                "message": str(e),
                "code": "DUPLICATE_NODE",
                "name": e.name,
                "conflicting_classes": e.conflicting_classes,
            },
        ) from e

    # Notify mentions
    await _notify_mentions(service, node, int(user.id), notification_repo)

    response = _node_to_response(node, tags=list(node.tag_ids), classes=list(node.class_ids))
    await _enrich_node_responses_uuids(response, repo, property_repo)
    return response


@router.post(
    "/page",
    response_model=NodeResponse,
    dependencies=[Depends(require_write_scope)],
)
async def create_page(
    name: str,
    icon: str | None = None,
    color: str | None = None,
    additional_type_uuids: list[str] = None,
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Create a new page (convenience endpoint)."""
    if additional_type_uuids is None:
        additional_type_uuids = []
    service = await _get_node_service(user)
    additional_types = []
    if additional_type_uuids:
        additional_types = await resolve_class_uuids(additional_type_uuids, repo)
    node = await service.create_page(name, icon, color, additional_types)
    response = _node_to_response(node)
    await _enrich_node_responses_uuids(response, repo)
    return response


@router.get("/recents", response_model=dict[str, list[NodeResponse]])
async def get_recent_pages(
    limit: int = 10,
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Get recently opened pages, ordered by open_date DESC.

    Returns pages that have been opened (have a non-null open_date).
    """
    service = await _get_node_service(user)
    nodes = await service.get_recent_pages(limit)
    node_ids = [node.id for node in nodes if node.id is not None]
    alias_ids_map = await _get_related_ids_batch(service, node_ids, "aliases")
    responses = [
        _node_to_response(node, aliases=alias_ids_map.get(node.id or 0, []))
        for node in nodes
    ]
    await _resolve_display_names_for_responses(service, nodes, responses)
    await _enrich_node_responses_uuids(responses, repo)
    return {"nodes": responses}


@router.get("/random", response_model=dict[str, list[NodeResponse]])
async def get_random_pages(
    limit: int = 5,
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Get random pages from the workspace.

    Returns random non-deleted, non-system pages.
    """
    service = await _get_node_service(user)
    nodes = await service.get_random_pages(limit)
    node_ids = [node.id for node in nodes if node.id is not None]
    alias_ids_map = await _get_related_ids_batch(service, node_ids, "aliases")
    responses = [
        _node_to_response(node, aliases=alias_ids_map.get(node.id or 0, []))
        for node in nodes
    ]
    await _resolve_display_names_for_responses(service, nodes, responses)
    await _enrich_node_responses_uuids(responses, repo)
    return {"nodes": responses}


@router.get("/recently-created", response_model=dict[str, list[NodeResponse]])
async def get_recently_created_pages(
    limit: int = 5,
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Get recently created pages, ordered by create_date DESC."""
    service = await _get_node_service(user)
    nodes = await service.get_recently_created_pages(limit)
    node_ids = [node.id for node in nodes if node.id is not None]
    alias_ids_map = await _get_related_ids_batch(service, node_ids, "aliases")
    responses = [
        _node_to_response(node, aliases=alias_ids_map.get(node.id or 0, []))
        for node in nodes
    ]
    await _resolve_display_names_for_responses(service, nodes, responses)
    await _enrich_node_responses_uuids(responses, repo)
    return {"nodes": responses}


@router.get("/suggestions", response_model=dict[str, list[dict[str, Any]]])
async def get_node_suggestions(
    limit: int = 20,
    class_filters: str | None = None,
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Get suggested pages for node pickers (empty-query state).

    Returns pages in two priority tiers:
    1. Pages created in the last 15 minutes (by create_date DESC)
    2. Pages by most recently linked (by latest node_link.create_date DESC)

    Optionally filtered by class IDs (comma-separated).
    """
    service = await _get_node_service(user)

    recent_nodes, linked_nodes = await service.get_node_suggestions(class_filters, limit)
    all_nodes = recent_nodes + linked_nodes

    node_ids = [node.id for node in all_nodes if node.id is not None]
    alias_ids_map = await _get_related_ids_batch(service, node_ids, "aliases")

    related_ids: set[int] = set()
    for node in all_nodes:
        if node.parent_id is not None:
            related_ids.add(node.parent_id)
        if node.page_id is not None:
            related_ids.add(node.page_id)
        if node.aliased_id is not None:
            related_ids.add(node.aliased_id)
        related_ids.update(node.class_ids or [])
        related_ids.update(alias_ids_map.get(node.id or 0, []))
    uuid_map = await _build_node_uuid_map(repo, list(related_ids))

    nodes = []
    for node in all_nodes:
        aliases = alias_ids_map.get(node.id or 0, [])
        nodes.append(
            {
                "id": node.id,
                "uuid": str(node.uuid),
                "name": node.name,
                "icon": node.icon,
                "color": node.color,
                "parent_id": node.parent_id,
                "parent_uuid": uuid_map.get(node.parent_id) if node.parent_id else None,
                "page_id": node.page_id,
                "page_uuid": uuid_map.get(node.page_id) if node.page_id else None,
                "is_page": node.is_page,
                "is_class": node.is_class,
                "is_daily": node.is_day,
                "is_monthly": node.is_month,
                "is_yearly": node.is_year,
                "create_date": node.create_date,
                "write_date": node.write_date,
                "classes": list(node.class_ids or []),
                "classes_uuid": [uuid_map[c] for c in node.class_ids or [] if c in uuid_map],
                "aliased_id": node.aliased_id,
                "aliased_uuid": uuid_map.get(node.aliased_id) if node.aliased_id else None,
                "aliases": aliases,
                "aliases_uuid": [uuid_map[a] for a in aliases if a in uuid_map],
            }
        )

    return {"nodes": nodes}


@router.get("/archived", response_model=PaginatedResponse[NodeResponse])
async def get_archived_pages(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Get all archived pages."""
    service = await _get_node_service(user)

    archived_nodes, total = await service.get_archived_pages_paginated(page, page_size)

    node_ids = [page_node.id for page_node in archived_nodes if page_node.id is not None]
    class_ids_map = await _get_class_ids_batch(service, node_ids)
    tag_ids_map = await _get_tag_ids_batch(service, node_ids)

    result = []
    for page_node in archived_nodes:
        if page_node.id is None:
            continue
        result.append(
            _node_to_response(
                page_node,
                classes=class_ids_map.get(page_node.id, []),
                tags=tag_ids_map.get(page_node.id, []),
            )
        )

    await _resolve_display_names_for_responses(
        service, [n for n in archived_nodes if n.id is not None], result
    )
    await _enrich_node_responses_uuids(result, repo)

    return PaginatedResponse[NodeResponse](
        items=result,
        total=total,
        page=page,
        page_size=page_size,
        has_next=(page * page_size) < total,
        has_prev=page > 1,
    )


@router.get("/templates", name="list_templates", response_model=PaginatedResponse[NodeResponse])
async def list_templates(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """List all template nodes in the current workspace."""
    service = await _get_node_service(user)

    template_nodes, total = await service.list_templates_paginated(page, page_size)

    node_ids = [t.id for t in template_nodes if t.id is not None]
    class_ids_map = await _get_class_ids_batch(service, node_ids)
    tag_ids_map = await _get_related_ids_batch(service, node_ids, "tags")

    result = []
    for t in template_nodes:
        if t.id is None:
            continue
        result.append(
            _node_to_response(
                t,
                classes=class_ids_map.get(t.id, []),
                tags=tag_ids_map.get(t.id, []),
            )
        )

    await _resolve_display_names_for_responses(
        service, [t for t in template_nodes if t.id is not None], result
    )
    await _enrich_node_responses_uuids(result, repo)

    return PaginatedResponse[NodeResponse](
        items=result,
        total=total,
        page=page,
        page_size=page_size,
        has_next=(page * page_size) < total,
        has_prev=page > 1,
    )




@router.get("/tasks", response_model=PaginatedResponse[NodeResponse])
async def list_tasks(
    include_complete: bool = False,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
):
    """List all task nodes in the current workspace.

    Tasks are nodes with is_task = TRUE (synchronized with the task class).
    By default, excludes tasks with status 'Done' or 'Cancelled'.
    """
    from app.domain.entities.constants import SYSTEM_PROPERTY_UUIDS, TASK_CLOSED_STATUSES

    service = await _get_node_service(user)

    # Get all active task nodes using the is_task index
    nodes = await service.get_task_nodes()

    # Batch load class_ids and tags
    node_ids = [n.id for n in nodes if n.id is not None]
    class_ids_map = await _get_class_ids_batch(service, node_ids)
    tag_ids_map = await _get_related_ids_batch(service, node_ids, "tags")

    # If filtering out completed tasks, batch-load task_status property
    if not include_complete and node_ids:
        status_prop = await property_repo.get_by_uuid(SYSTEM_PROPERTY_UUIDS["task_status"])
        if status_prop and status_prop.id is not None:
            batch_props = await service.get_nodes_properties_batch(node_ids)
            lines = await property_repo.get_selection_lines(status_prop.id)
            closed_line_ids = {line.id for line in lines if line.name in TASK_CLOSED_STATUSES}

            filtered_nodes = []
            for n in nodes:
                if n.id is None:
                    continue
                prop_data = batch_props.get(n.id, {})
                status_data = prop_data.get(status_prop.id)
                if status_data and status_data.get("values"):
                    val = status_data["values"][0]
                    sel_id = getattr(val, "selection_line_id", None)
                    if sel_id in closed_line_ids:
                        continue
                filtered_nodes.append(n)
            nodes = filtered_nodes

    total = len(nodes)
    offset = (page - 1) * page_size
    paginated_nodes = [n for n in nodes[offset : offset + page_size] if n.id is not None]

    # Build response
    result = []
    for n in paginated_nodes:
        result.append(_node_to_response(
            n,
            classes=class_ids_map.get(n.id, []),
            tags=tag_ids_map.get(n.id, []),
        ))

    await _resolve_display_names_for_responses(service, paginated_nodes, result)
    await _enrich_node_responses_uuids(result, repo, property_repo)

    return PaginatedResponse[NodeResponse](
        items=result,
        total=total,
        page=page,
        page_size=page_size,
        has_next=(page * page_size) < total,
        has_prev=page > 1,
    )

@router.post(
    "/scratchpad/clear",
    response_model=dict[str, Any],
    dependencies=[Depends(require_write_scope)],
)
async def clear_scratchpad(
    request: Request,
    user: User = Depends(get_current_user),
):
    """Delete all children (blocks) of the Scratchpad system page.

    Called on app startup to ensure the scratchpad starts empty.
    Hard-deletes all child blocks since scratchpad content is ephemeral.
    """
    service = await _get_node_service(user)
    return await service.clear_scratchpad(int(user.id))


@router.post(
    "/{node_uuid}/restore",
    name="restore_node",
    response_model=NodeResponse,
    dependencies=[Depends(require_write_scope)],
)
async def restore_node(
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Restore a soft-deleted node from trash.

    This undeletes the node by setting is_deleted=false and deleted_at=null.
    Only works on nodes that are currently in trash.
    """
    service = await _get_node_service(user)

    node = await service.restore_node(node_id, None)
    if not node:
        raise HTTPException(404, "Node not found in trash")

    types = await service.get_node_classes(node_id)
    response = _node_to_response(node, classes=[t.id for t in types if t.id])
    await _enrich_node_responses_uuids(response, repo)
    return response


@router.get("/{node_uuid}/breadcrumbs", name="get_node_breadcrumbs", response_model=BreadcrumbsResponse)
async def get_node_breadcrumbs(
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
):
    """Get the ancestor breadcrumb chain for a node.

    Returns an ordered list of ancestors from root to the node's immediate parent.
    Uses the closure table for O(1) ancestor lookup — much faster than
    chaining individual GET requests.
    """
    service = await _get_node_service(user)

    breadcrumb_items = await service.get_node_breadcrumbs_with_resolved_links(node_id)
    node_ids = [item["id"] for item in breadcrumb_items if item.get("id")]
    property_ids = {item["property_id"] for item in breadcrumb_items if item.get("property_id")}
    uuid_map = await _build_node_uuid_map(repo, node_ids)
    property_uuid_map = await _resolve_property_uuids(property_repo, property_ids)

    return BreadcrumbsResponse(
        breadcrumbs=[
            BreadcrumbItem(
                id=item["id"],
                uuid=uuid_map.get(item["id"], ""),
                name=item["name"],
                display_name=item["display_name"],
                icon=item["icon"],
                is_page=item["is_page"],
                parent_locked=item["parent_locked"],
                is_property=item.get("is_property", False),
                property_id=item.get("property_id"),
                property_uuid=property_uuid_map.get(item.get("property_id")) if item.get("property_id") else None,
            )
            for item in breadcrumb_items
        ]
    )


@router.post(
    "/{node_uuid}/instantiate",
    name="instantiate_template",
    response_model=TemplateInstantiateResponse,
    dependencies=[Depends(require_write_scope)],
)
async def instantiate_template(
    node_id: int = Depends(resolve_node_uuid),
    body: TemplateInstantiateRequest = ...,
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Instantiate a template, creating a deep copy with optional variable substitution.

    When as_blocks=True the template's children will be created directly under
    parent_id without creating a root page.
    """
    service = await _get_node_service(user)

    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    if not node.is_template:
        raise HTTPException(422, "Node is not a template")

    # Resolve public UUIDs to internal IDs.
    parent_id: int | None = None
    if body.parent_uuid is not None:
        parent = await repo.get_by_uuid(body.parent_uuid)
        if parent is None or parent.id is None:
            raise HTTPException(404, "Parent node not found")
        parent_id = parent.id

    after_id: int | None = None
    if body.after_uuid is not None:
        after = await repo.get_by_uuid(body.after_uuid)
        if after is None or after.id is None:
            raise HTTPException(404, "Anchor node not found")
        after_id = after.id

    result = await service.instantiate_template(
        template_id=node_id,
        user_id=int(user.id),
        parent_id=parent_id,
        name=body.name,
        variables=body.variables,
        dynamic_context=body.dynamic_context,
        as_blocks=body.as_blocks,
        after_id=after_id,
    )

    if result["as_blocks"]:
        # Compute has_children: a block has children if another block
        # in the result list references it as parent_id.
        parent_ids_with_children = {b.parent_id for b in result["blocks"] if b and b.parent_id}
        blocks = [
            _node_to_response(
                b,
                classes=list(b.class_ids or []),
                has_children=(b.id in parent_ids_with_children),
            )
            for b in result["blocks"]
            if b
        ]
        await _enrich_node_responses_uuids(blocks, repo)
        return TemplateInstantiateResponse(node=None, blocks=blocks, as_blocks=True)
    else:
        root = result["node"]
        if not root:
            raise HTTPException(500, "Template instantiation failed: no root node returned")
        class_ids = await _get_class_ids(service, root.id)
        response_node = _node_to_response(root, classes=class_ids)
        await _enrich_node_responses_uuids(response_node, repo)
        return TemplateInstantiateResponse(node=response_node, blocks=[], as_blocks=False)


@router.get("/{node_uuid}", response_model=NodeResponse)
async def get_node(
    node_id: int = Depends(resolve_node_uuid),
    include_children: bool = False,
    include_backlinks: bool = False,
    include_properties: bool = False,
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
):
    """Get a node by UUID."""
    service = await _get_node_service(user)

    response = await _build_node_detail_response(
        service,
        node_id,
        include_children=include_children,
        include_backlinks=include_backlinks,
        include_properties=include_properties,
        node_repo=repo,
        property_repo=property_repo,
    )
    if response is None:
        raise HTTPException(404, "Node not found")

    return response


@router.get("/uuid/{uuid}", response_model=NodeResponse)
async def get_node_by_uuid(
    uuid: str,
    include_children: bool = False,
    include_backlinks: bool = False,
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
):
    """Get a node by UUID."""
    service = await _get_node_service(user)

    node = await service.get_node_by_uuid(uuid)
    if not node:
        raise HTTPException(404, "Node not found")

    tag_ids = await _get_tag_ids(service, node.id) if node.id else []
    response = await _node_to_response_with_permissions(node, service.permissions, tags=tag_ids)
    await _resolve_display_names_for_responses(service, [node], [response])

    if include_children and node.id:
        children = await service.get_node_children(node.id)
        child_ids = [c.id for c in children if c.id is not None]
        child_tag_map = await _get_tag_ids_batch(service, child_ids)
        response.children = [
            _node_to_response(c, tags=child_tag_map.get(c.id or 0, [])) for c in children
        ]
        await _resolve_display_names_for_responses(service, children, response.children)

    if include_backlinks and node.id:
        backlink_infos = await service.get_backlinks(node.id)
        response.backlinks = []
        for info in backlink_infos:
            breadcrumb_segments = [
                BreadcrumbSegment(node_id=seg[0], name=seg[1], is_property=seg[2] if len(seg) > 2 else False)
                for seg in info.breadcrumb_path
            ]

            response.backlinks.append(
                BacklinkResponse(
                    source_node_id=info.source_node_id,
                    source_node_uuid=str(info.source_node_uuid) if info.source_node_uuid else "",
                    source_node_name=info.source_node_name or "",
                    source_is_page=info.source_is_page,
                    source_page_id=info.source_page_id,
                    source_page_name=info.source_page_name,
                    source_page_uuid=str(info.source_page_uuid) if info.source_page_uuid else None,
                    property_id=info.property_id,
                    property_name=info.property_name,
                    breadcrumb_path=breadcrumb_segments,
                    link_type="property" if info.property_id else "text",
                    position=info.link.position,
                )
            )

    await _enrich_node_responses_uuids(response, repo, property_repo)
    return response


@router.get("/page/{node_uuid}/content", response_model=NodeResponse)
async def get_page_content(
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
):
    """Get a page with all its content (blocks, properties, backlinks)."""
    service = await _get_node_service(user)

    content = await service.get_page_content(node_id)
    if not content:
        raise HTTPException(404, "Page not found")

    page = content["page"]
    blocks = content["blocks"]
    backlinks = content["backlinks"]

    # Get block IDs for batch queries
    block_ids = [b.id for b in blocks if b.id is not None]

    references = await service.load_page_references(node_id, block_ids)
    backlink_counts = references["backlink_counts"]

    # Get classes for all nodes in one batch (from node.class_ids column)
    all_node_ids = [node_id] + block_ids
    node_class_map = await _get_class_ids_batch(service, all_node_ids)

    # Get tags for all nodes in one batch (from node.tag_ids column)
    node_tag_map = await _get_related_ids_batch(service, all_node_ids, "tags")

    # Build tree structure from flat list
    block_map = {}
    for b in blocks:
        if b.id != node_id and b.id is not None:
            bcount = backlink_counts.get(b.id, 0)
            class_ids = node_class_map.get(b.id, [])
            tag_ids = node_tag_map.get(b.id, [])
            block_map[b.id] = _node_to_response(b, tags=tag_ids, classes=class_ids, backlink_count=bcount)

    root_children = []

    for b in blocks:
        if b.id == node_id:
            continue
        if b.id is None:
            continue
        response = block_map[b.id]
        if b.parent_id == node_id:
            root_children.append(response)
        elif b.parent_id in block_map:
            parent = block_map[b.parent_id]
            if parent.children is None:
                parent.children = []
            parent.children.append(response)

    page_class_ids = node_class_map.get(node_id, [])
    page_tag_ids = node_tag_map.get(node_id, [])

    # Get aliases for the page
    page_alias_ids = await _get_alias_ids(service, node_id)

    page_response = await _node_to_response_with_permissions(
        page, service.permissions, tags=page_tag_ids, classes=page_class_ids, aliases=page_alias_ids
    )
    page_response.children = root_children

    # Add properties - get the full property values
    all_prop_values = await service.get_node_properties(node_id)
    logger.info(f"Page {node_id} properties: {list(all_prop_values.keys())}")
    page_response.properties = extract_properties_dict(all_prop_values)

    # Add backlinks with context — batch fetch source nodes and pages
    page_response.linked_references = []
    if backlinks:
        unique_source_ids = list({link.source_node_id for link in backlinks})
        source_nodes = await service.get_nodes_batch(unique_source_ids)
        unique_page_ids = list({node.page_id for node in source_nodes.values() if node.page_id})
        source_pages = await service.get_nodes_batch(unique_page_ids) if unique_page_ids else {}

        for link in backlinks:
            source = source_nodes.get(link.source_node_id)
            if not source:
                continue

            source_page = source_pages.get(source.page_id) if source.page_id else None

            # Extract context around the link
            context = source.name
            position = link.link.position if link.link else 0
            if position > 0 and len(context) > 100:
                start = max(0, position - 50)
                end = min(len(context), position + 50)
                context = "..." + context[start:end] + "..."

            page_response.linked_references.append(
                LinkedReferenceResponse(
                    source_node=_node_to_response(source),
                    source_page=_node_to_response(source_page) if source_page else None,
                    link_type="property" if link.property_id else "text",
                    context=context,
                    property_id=link.property_id,
                    property_name=link.property_name,
                )
            )

    # Build referenced_nodes map — lightweight metadata for all outgoing link targets.
    # This eliminates N+1 GET /api/nodes/uuid/{uuid} calls from inline pills.
    referenced_targets = references["referenced_nodes"]
    if referenced_targets:
        referenced_nodes: dict[str, NodeResponse] = {}
        for target in referenced_targets:
            uuid_str = str(target.uuid)
            referenced_nodes[uuid_str] = NodeResponse(
                id=target.id,
                uuid=uuid_str,
                name=target.name or "",
                icon=target.icon,
                color=target.color,
                is_page=target.is_page,
                is_class=target.is_class,
                create_date=str(target.create_date),
                write_date=str(target.write_date),
                parent_id=target.parent_id,
                page_id=target.page_id,
                sequence=target.sequence,
                active=target.active,
                display_name=_name_text(target.name, max_len=None),
                classes=list(target.class_ids or []),
            )
        page_response.referenced_nodes = referenced_nodes

    await _enrich_node_responses_uuids(page_response, repo, property_repo)
    return page_response


@router.put(
    "/{node_uuid}",
    response_model=NodeResponse,
    dependencies=[
        Depends(RateLimiter(limiter=_crud_limiter)),
        Depends(require_write_scope),
        Depends(RateLimiter(limiter=_write_limiter, identifier=user_identifier)),
    ],
)
async def update_node(
    request: Request,
    node_id: int = Depends(resolve_node_uuid),
    body: NodeUpdateRequest = ...,  # required body, placed after dependency defaults
    user: User = Depends(get_current_user),
    notification_repo: NotificationRepository = Depends(get_notification_repository),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
):
    """Update a node."""
    from app.logging_config import get_logger

    logger = get_logger(__name__)

    service = await _get_node_service(user)

    logger.debug("[UPDATE_NODE] node_id=%s, fields_set=%s", node_id, body.model_fields_set)

    # Resolve public UUIDs to internal IDs.
    parent_id: int | None = None
    clear_parent = False
    if "parent_uuid" in body.model_fields_set:
        clear_parent = body.parent_uuid is None
        if body.parent_uuid is not None:
            parent = await repo.get_by_uuid(body.parent_uuid)
            if parent is None or parent.id is None:
                raise HTTPException(404, "Parent node not found")
            parent_id = parent.id

    class_ids: list[int] | None = None
    if body.class_uuids is not None:
        class_ids = await resolve_class_uuids(body.class_uuids, repo)

    property_values: dict[int, Any] | None = None
    if body.property_uuids is not None:
        prop_uuids = list(body.property_uuids.keys())
        prop_map = {prop.uuid: prop.id for prop in await property_repo.get_by_uuids(prop_uuids) if prop.id is not None}
        missing_props = [u for u in prop_uuids if u not in prop_map]
        if missing_props:
            raise HTTPException(404, f"Properties not found: {missing_props}")
        property_values = {}
        for prop_uuid, value in body.property_uuids.items():
            property_values[prop_map[prop_uuid]] = value

    data = NodeUpdateData(
        name=body.name,
        icon=body.icon,
        color=body.color,
        # Set clear flags when field was explicitly provided as None
        clear_icon="icon" in body.model_fields_set and body.icon is None,
        clear_color="color" in body.model_fields_set and body.color is None,
        clear_parent=clear_parent,
        parent_id=parent_id,
        sequence=body.sequence,
        is_private=body.is_private,
        expected_version=body.expected_version,
    )

    logger.debug("[UPDATE_NODE] NodeUpdateData color=%s, clear_color=%s", data.color, data.clear_color)

    # Snapshot before state for undo
    old_node = await service.get_node(node_id)
    before = _node_snapshot(old_node) if old_node else None

    try:
        node = await service.update_node(
            node_id,
            data,
            user_id=int(user.id),
            classes=class_ids,
            properties=property_values,
        )
    except OptimisticLockError as e:
        raise HTTPException(
            status_code=409,
            detail={"message": str(e), "code": "OPTIMISTIC_LOCK_CONFLICT"},
        ) from e
    except SystemClassConstraintError as e:
        raise HTTPException(422, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e

    if not node:
        raise HTTPException(404, "Node not found")

    logger.debug("[UPDATE_NODE] result node.color=%s", node.color)

    # Record for undo (best-effort, outside the node update transaction)
    if before:
        try:
            undo = await _get_undo_service(user)
            after = _node_snapshot(node)
            # Only record if something actually changed
            if before != after:
                old_name = _name_text(before.get("name", ""), 30)
                new_name = _name_text(after.get("name", ""), 30)
                if before.get("name") != after.get("name"):
                    desc = f"Renamed '{old_name}' → '{new_name}'"
                else:
                    desc = f"Updated '{old_name}'"
                await undo.record(
                    "update_node",
                    "node",
                    node_id,
                    before_state=before,
                    after_state=after,
                    description=desc,
                )
        except (ValueError, TypeError, LookupError):
            pass

    # Invalidate static share HTML caches for this node
    try:
        share_service = await _get_share_service(user)
        await share_service.regenerate_share_html_for_node(node)
    except (OSError, ValueError):
        logger.exception("Failed to invalidate share HTML caches")

    # Notify mentions
    await _notify_mentions(service, node, int(user.id), notification_repo)

    response = _node_to_response(node)
    await _enrich_node_responses_uuids(response, repo, property_repo)
    return response


async def _sequence_for_position(
    repo: NodeRepository,
    parent_id: int,
    position: int,
) -> float:
    """Compute a fractional sequence that places a node at ``position`` (0-indexed).

    Mirrors the client-side ordering logic: midpoint between siblings when
    inserting, prepend/append at the edges, and sequence shifting when the gap
    collapses. This keeps integer ``position`` values from colliding with
    fractional sequences created by the runtime.
    """
    children = await repo.get_children_ids(parent_id)
    if not children:
        return 0.0

    if position <= 0:
        first_seq = await repo.get_node_sequence(children[0])
        return (first_seq if first_seq is not None else 0.0) - 1024.0

    if position >= len(children):
        last_seq = await repo.get_node_sequence(children[-1])
        return (last_seq if last_seq is not None else 0.0) + 1024.0

    after_seq = await repo.get_node_sequence(children[position - 1])
    before_seq = await repo.get_node_sequence(children[position])
    after_seq = after_seq if after_seq is not None else 0.0
    before_seq = before_seq if before_seq is not None else after_seq + 1024.0

    gap = before_seq - after_seq
    if gap < 1e-9:
        await repo.shift_sequences(parent_id, after_seq, 1024.0)
        return after_seq + 512.0

    return after_seq + gap / 2.0


@router.put(
    "/{node_uuid}/move",
    response_model=NodeResponse,
    dependencies=[Depends(require_write_scope)],
)
async def move_node(
    request: MoveNodeRequest,
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Move a node to a new parent and/or position.

    Used for indent/outdent operations and drag-drop reordering.
    - parent_uuid: New parent UUID (required for blocks - they must always have a parent)
    - position: New 0-indexed position among siblings after the move

    Note: page_id is automatically computed from parent_id hierarchy.
    Sibling sequences are automatically adjusted to maintain ordering.
    """
    service = await _get_node_service(user)

    # Resolve parent from UUID
    if request.parent_uuid is None:
        raise HTTPException(400, "parent_uuid is required for move operation")
    parent = await repo.get_by_uuid(request.parent_uuid)
    if parent is None or parent.id is None:
        raise HTTPException(404, "Parent node not found")
    parent_id = parent.id

    # Default position to 0 if not specified
    position = int(request.position) if request.position is not None else 0
    new_sequence = await _sequence_for_position(repo, parent_id, position)

    # Snapshot before state for undo
    old_node = await service.get_node(node_id)
    before = _node_snapshot(old_node) if old_node else None

    try:
        node = await service.move_node(node_id, parent_id, new_sequence)
        if not node:
            raise HTTPException(404, "Node not found")

        # Record for undo (best-effort, outside the node move transaction)
        if before:
            try:
                undo = await _get_undo_service(user)
                after = _node_snapshot(node)
                name = _name_text(node.name, 30)
                await undo.record(
                    "move_node",
                    "node",
                    node_id,
                    before_state=before,
                    after_state=after,
                    description=f"Moved '{name}'",
                )
            except (ValueError, TypeError, LookupError):
                pass
    except ValueError as e:
        raise HTTPException(422, str(e)) from e

    response = _node_to_response(node)
    await _enrich_node_responses_uuids(response, repo)
    return response


@router.post(
    "/{node_uuid}/convert-to-page",
    response_model=NodeResponse,
    dependencies=[Depends(require_write_scope)],
)
async def convert_block_to_page(
    request: ConvertToPageRequest,
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Convert a block into a root page.

    Optionally renames the node. The page class is added automatically.
    """
    service = await _get_node_service(user)

    old_node = await service.get_node(node_id)
    before = _node_snapshot(old_node) if old_node else None

    try:
        node = await service.convert_block_to_page(
            node_id, name=request.name, user_id=int(user.id)
        )
    except NodeNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except SystemClassConstraintError as e:
        raise HTTPException(422, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    except DuplicateNodeError as e:
        raise HTTPException(
            status_code=409,
            detail={
                "message": str(e),
                "code": "DUPLICATE_NODE",
                "name": e.name,
                "conflicting_classes": e.conflicting_classes,
            },
        ) from e

    if before:
        try:
            undo = await _get_undo_service(user)
            await undo.record(
                "convert_block_to_page",
                "node",
                node_id,
                before_state=before,
                after_state=_node_snapshot(node),
                description=f"Converted block to page '{_name_text(node.name)}'",
            )
        except (ValueError, TypeError, LookupError):
            pass

    response = _node_to_response(node)
    await _enrich_node_responses_uuids(response, repo)
    return response


@router.post(
    "/{node_uuid}/convert-to-block",
    response_model=NodeResponse,
    dependencies=[Depends(require_write_scope)],
)
async def convert_page_to_block(
    request: ConvertToBlockRequest,
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Convert a page into a block under the given destination page.

    The page class is removed automatically.
    """
    service = await _get_node_service(user)

    # Resolve destination and anchor UUIDs to numeric IDs
    parent = await repo.get_by_uuid(request.parent_uuid)
    if parent is None or parent.id is None:
        raise HTTPException(404, "Parent node not found")
    parent_id = parent.id

    _after_id: int | None = None
    if request.after_uuid is not None:
        after = await repo.get_by_uuid(request.after_uuid)
        if after is None or after.id is None:
            raise HTTPException(404, "Anchor node not found")
        _after_id = after.id
    # TODO: pass _after_id to the service once convert_page_to_block supports ordering

    old_node = await service.get_node(node_id)
    before = _node_snapshot(old_node) if old_node else None

    try:
        node = await service.convert_page_to_block(
            node_id,
            parent_id=parent_id,
            position=request.position,
            user_id=int(user.id),
        )
    except NodeNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except SystemClassConstraintError as e:
        raise HTTPException(422, str(e)) from e
    except NodeValidationError as e:
        raise HTTPException(422, {"message": str(e), "field": e.field}) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e

    if before:
        try:
            undo = await _get_undo_service(user)
            await undo.record(
                "convert_page_to_block",
                "node",
                node_id,
                before_state=before,
                after_state=_node_snapshot(node),
                description=f"Converted page to block '{_name_text(node.name)}'",
            )
        except (ValueError, TypeError, LookupError):
            pass

    response = _node_to_response(node)
    await _enrich_node_responses_uuids(response, repo)
    return response


@router.delete(
    "/{node_uuid}",
    response_model=dict[str, str],
    dependencies=[
        Depends(RateLimiter(limiter=_crud_limiter)),
        Depends(require_write_scope),
        Depends(RateLimiter(limiter=_delete_limiter, identifier=user_identifier)),
    ],
)
async def delete_node(
    request: Request,
    node_id: int = Depends(resolve_node_uuid),
    repo: NodeRepository = Depends(get_node_repository),
    user: User = Depends(get_current_user),
):
    """Delete a node and all its children.

    Also deletes any associated asset files (files named with the node's UUID).
    Works for both active and archived nodes.

    Raises:
        HTTPException 400: If trying to delete a month/year page with active day children
        HTTPException 404: If node not found
    """
    service = await _get_node_service(user)

    # Snapshot before state for undo (node name + descendants list)
    undo_before = None
    with suppress(ValueError, TypeError, LookupError):
        undo_before = await service.get_delete_undo_state(node_id)

    # Get the node including archived ones (for UUID and asset cleanup)
    node = await service.get_node_including_archived(node_id)
    if node is None:
        raise HTTPException(404, f"Node {node_id} not found")

    # Try to delete any associated asset file
    if node.uuid and service.workspace_uuid is not None:
        await service.delete_node_assets(node.uuid, service.workspace_uuid)

    try:
        success = await service.delete_node(node_id)
        if not success:
            raise HTTPException(404, "Node not found")

        # Record for undo (best-effort, outside the node deletion transaction)
        if undo_before:
            try:
                undo = await _get_undo_service(user)
                name = _name_text(undo_before.get("name", ""), 30)
                await undo.record(
                    "delete_node",
                    "node",
                    node_id,
                    before_state=undo_before,
                    after_state=None,
                    description=f"Deleted '{name}'",
                )
            except (ValueError, TypeError, LookupError):
                pass
    except DatePageDeletionError as e:
        raise HTTPException(400, e.message) from e

    return {"status": "ok"}


@router.post(
    "/{node_uuid}/archive",
    response_model=NodeResponse,
    dependencies=[Depends(require_write_scope)],
)
async def archive_node(
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Archive a node (set active to false)."""
    service = await _get_node_service(user)

    node = await service.archive_node(node_id, None)
    if not node:
        raise HTTPException(404, "Node not found")

    # Record for undo (best-effort, outside the node archive transaction)
    try:
        undo = await _get_undo_service(user)
        name = _name_text(node.name, 30)
        await undo.record(
            "archive_node",
            "node",
            node_id,
            before_state={"active": True},
            after_state={"active": False},
            description=f"Archived '{name}'",
        )
    except (ValueError, TypeError, LookupError):
        pass

    types = await service.get_node_classes(node_id)
    response = _node_to_response(node, classes=[t.id for t in types if t.id])
    await _enrich_node_responses_uuids(response, repo)
    return response


@router.post(
    "/{node_uuid}/merge-into/{target_uuid}",
    name="merge_pages",
    response_model=dict[str, Any],
    dependencies=[Depends(require_write_scope)],
)
async def merge_pages(
    target_uuid: str,
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Merge source page into target page.

    Moves all blocks from source to target, redirects all backlinks that point to
    source so they point to target instead, then soft-deletes the source page.
    """
    service = await _get_node_service(user)

    target = await repo.get_by_uuid(target_uuid)
    if target is None or target.id is None:
        raise HTTPException(404, "Target node not found")
    target_id = target.id

    try:
        result = await service.merge_pages(node_id, target_id, user_id=int(user.id))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return result


@router.post(
    "/{node_uuid}/unarchive",
    response_model=NodeResponse,
    dependencies=[Depends(require_write_scope)],
)
async def unarchive_node(
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Unarchive a node (set active to true)."""
    service = await _get_node_service(user)

    node = await service.unarchive_node(node_id, None)
    if not node:
        raise HTTPException(404, "Node not found")

    # Record for undo (best-effort, outside the node unarchive transaction)
    try:
        undo = await _get_undo_service(user)
        name = _name_text(node.name, 30)
        await undo.record(
            "unarchive_node",
            "node",
            node_id,
            before_state={"active": False},
            after_state={"active": True},
            description=f"Unarchived '{name}'",
        )
    except (ValueError, TypeError, LookupError):
        pass

    types = await service.get_node_classes(node_id)
    response = _node_to_response(node, classes=[t.id for t in types if t.id])
    await _enrich_node_responses_uuids(response, repo)
    return response


@router.patch(
    "/{node_uuid}/open",
    response_model=dict[str, Any],
    dependencies=[Depends(require_write_scope)],
)
async def mark_page_opened(
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
):
    """Mark a page as opened/viewed (updates open_date).

    This should only be called for pages (is_page=1).
    The open_date is set to the current UTC time.

    Also ensures default NodeViews exist for the page (lazy initialization).
    """
    service = await _get_node_service(user)
    try:
        open_date = await service.mark_page_opened(node_id)
    except ValueError as e:
        status_code = 404 if "not found" in str(e).lower() else 400
        raise HTTPException(status_code=status_code, detail=str(e)) from e

    # Note: Default views are now lazily created by the frontend via ensure-defaults endpoint
    # This keeps all query structure logic in one place

    return {"status": "ok", "open_date": open_date}


@router.get("/{node_uuid}/versions", name="get_node_versions", response_model=dict[str, list[Any]])
async def get_node_versions(
    node_id: int = Depends(resolve_node_uuid),
    limit: int = 50,
    user: User = Depends(get_current_user),
):
    """Get version history for a node, ordered by most recent first."""
    service = await _get_node_service(user)
    versions = await service.get_node_versions(node_id, limit)
    return {"versions": versions}


@router.post(
    "/{node_uuid}/versions/{version_uuid}/restore",
    name="restore_node_version",
    response_model=NodeResponse,
    dependencies=[Depends(require_write_scope)],
)
async def restore_node_version(
    version_uuid: str,
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Restore a node to a previous version's content."""
    service = await _get_node_service(user)

    updated = await service.restore_node_version_by_uuid(
        node_id, version_uuid, user_id=int(user.id)
    )
    if not updated:
        raise HTTPException(404, "Version or node not found")

    types = await service.get_node_classes(node_id)
    response = _node_to_response(updated, classes=[t.id for t in types if t.id])
    await _enrich_node_responses_uuids(response, repo)
    return response



