"""CRUD operations for nodes."""

from datetime import UTC

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from fastapi_limiter.depends import RateLimiter
from pyrate_limiter import Duration, Limiter, Rate

from ...db.connection import acquire_connection, get_pool, get_workspace_assets_dir, get_workspace_uuid
from ...domain.entities import NodeCreateData, NodeUpdateData
from ...domain.errors import DatePageDeletionError, DuplicateNodeError, SystemClassConstraintError
from ...logging_config import get_logger
from ...models import User
from ...node_export import write_share_html
from ..auth import get_current_user
from .helpers import (
    _get_alias_ids,
    _get_class_ids,
    _get_class_ids_batch,
    _get_node_service,
    _get_related_ids_batch,
    _get_tag_ids,
    _get_undo_service,
    _name_text,
    _node_snapshot,
    _node_to_response,
    _resolve_referenced_display_names,
    extract_properties_dict,
)
from .models import (
    BacklinkResponse,
    BreadcrumbItem,
    BreadcrumbSegment,
    BreadcrumbsResponse,
    LinkedReferenceResponse,
    MoveNodeRequest,
    NodeCreateRequest,
    NodeResponse,
    NodeUpdateRequest,
    TemplateInstantiateRequest,
    TemplateInstantiateResponse,
)

logger = get_logger(__name__)

_crud_limiter = Limiter(Rate(120, Duration.MINUTE))
router = APIRouter()


@router.post(
    "/",
    name="create_node",
    dependencies=[Depends(RateLimiter(limiter=_crud_limiter))],
)
async def create_node(
    request: Request,
    body: NodeCreateRequest,
    user: User = Depends(get_current_user),
):
    """Create a new node."""
    service = await _get_node_service(user)

    # Create node with provided classes
    # The repository will compute is_page, is_class, etc. from the classes
    data = NodeCreateData(
        name=body.name,
        icon=body.icon,
        color=body.color,
        parent_id=body.parent_id,
        sequence=body.sequence,
        classes=list(body.classes),
        property_values=body.properties,
        uuid=body.uuid,
    )

    try:
        node = await service.create_node(data, user_id=int(user.id))
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

    # Record for undo
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
    except Exception:
        pass  # Never fail the mutation because of undo logging

    return _node_to_response(node, classes=list(body.classes))


@router.post("/page")
async def create_page(
    name: str,
    icon: str | None = None,
    color: str | None = None,
    additional_types: list[int] = None,
    user: User = Depends(get_current_user),
):
    """Create a new page (convenience endpoint)."""
    if additional_types is None:
        additional_types = []
    service = await _get_node_service(user)
    node = await service.create_page(name, icon, color, additional_types)
    return _node_to_response(node)


@router.get("/recents")
async def get_recent_pages(
    limit: int = 10,
    user: User = Depends(get_current_user),
):
    """Get recently opened pages, ordered by open_date DESC.

    Returns pages that have been opened (have a non-null open_date).
    """
    service = await _get_node_service(user)

    async with acquire_connection(service.pool) as conn:
        rows = await conn.fetch(
            """
            SELECT id, uuid, name, icon, color, parent_id, page_id,
                   is_page, is_class, is_day, is_month, is_year,
                   create_date, write_date, open_date, class_ids, aliased_id
            FROM node
            WHERE is_page = true AND active = true AND (is_deleted = false OR is_deleted IS NULL)
                  AND open_date IS NOT NULL AND workspace_id = $1
            ORDER BY open_date DESC
            LIMIT $2
        """,
            service.workspace_id,
            limit,
        )

    node_ids = [row["id"] for row in rows]
    alias_ids_map = await _get_related_ids_batch(service.pool, service.workspace_id or 0, node_ids, "aliases")

    nodes = []
    for row in rows:
        nodes.append(
            {
                "id": row["id"],
                "uuid": str(row["uuid"]),
                "name": row["name"],
                "icon": row["icon"],
                "color": row["color"],
                "parent_id": row["parent_id"],
                "page_id": row["page_id"],
                "is_page": row["is_page"],
                "is_class": row["is_class"],
                "is_daily": row["is_day"],
                "is_monthly": row["is_month"],
                "is_yearly": row["is_year"],
                "create_date": row["create_date"].isoformat() if row["create_date"] else None,
                "write_date": row["write_date"].isoformat() if row["write_date"] else None,
                "open_date": row["open_date"].isoformat() if row["open_date"] else None,
                "classes": list(row["class_ids"] or []),
                "aliased_id": row["aliased_id"],
                "aliases": alias_ids_map.get(row["id"], []),
            }
        )

    return {"nodes": nodes}


@router.get("/random")
async def get_random_pages(
    limit: int = 5,
    user: User = Depends(get_current_user),
):
    """Get random pages from the workspace.

    Returns random non-deleted, non-system pages.
    """
    service = await _get_node_service(user)

    async with acquire_connection(service.pool) as conn:
        rows = await conn.fetch(
            """
            SELECT id, uuid, name, icon, color, parent_id, page_id,
                   is_page, is_class, is_day, is_month, is_year,
                   create_date, write_date, class_ids, aliased_id
            FROM node
            WHERE is_page = true AND active = true AND (is_deleted = false OR is_deleted IS NULL)
                  AND is_class = false AND is_day = false AND is_month = false AND is_year = false
                  AND workspace_id = $1
            ORDER BY RANDOM()
            LIMIT $2
        """,
            service.workspace_id,
            limit,
        )

    node_ids = [row["id"] for row in rows]
    alias_ids_map = await _get_related_ids_batch(service.pool, service.workspace_id or 0, node_ids, "aliases")

    nodes = []
    for row in rows:
        nodes.append(
            {
                "id": row["id"],
                "uuid": str(row["uuid"]),
                "name": row["name"],
                "icon": row["icon"],
                "color": row["color"],
                "parent_id": row["parent_id"],
                "page_id": row["page_id"],
                "is_page": row["is_page"],
                "is_class": row["is_class"],
                "is_daily": row["is_day"],
                "is_monthly": row["is_month"],
                "is_yearly": row["is_year"],
                "create_date": row["create_date"].isoformat() if row["create_date"] else None,
                "write_date": row["write_date"].isoformat() if row["write_date"] else None,
                "classes": list(row["class_ids"] or []),
                "aliased_id": row["aliased_id"],
                "aliases": alias_ids_map.get(row["id"], []),
            }
        )

    return {"nodes": nodes}


@router.get("/recently-created")
async def get_recently_created_pages(
    limit: int = 5,
    user: User = Depends(get_current_user),
):
    """Get recently created pages, ordered by create_date DESC."""
    service = await _get_node_service(user)

    async with acquire_connection(service.pool) as conn:
        rows = await conn.fetch(
            """
            SELECT id, uuid, name, icon, color, parent_id, page_id,
                   is_page, is_class, is_day, is_month, is_year,
                   create_date, write_date, class_ids, aliased_id
            FROM node
            WHERE is_page = true AND active = true AND (is_deleted = false OR is_deleted IS NULL)
                  AND workspace_id = $1
            ORDER BY create_date DESC
            LIMIT $2
        """,
            service.workspace_id,
            limit,
        )

    node_ids = [row["id"] for row in rows]
    alias_ids_map = await _get_related_ids_batch(service.pool, service.workspace_id or 0, node_ids, "aliases")

    nodes = []
    for row in rows:
        nodes.append(
            {
                "id": row["id"],
                "uuid": str(row["uuid"]),
                "name": row["name"],
                "icon": row["icon"],
                "color": row["color"],
                "parent_id": row["parent_id"],
                "page_id": row["page_id"],
                "is_page": row["is_page"],
                "is_class": row["is_class"],
                "is_daily": row["is_day"],
                "is_monthly": row["is_month"],
                "is_yearly": row["is_year"],
                "create_date": row["create_date"].isoformat() if row["create_date"] else None,
                "write_date": row["write_date"].isoformat() if row["write_date"] else None,
                "classes": list(row["class_ids"] or []),
                "aliased_id": row["aliased_id"],
                "aliases": alias_ids_map.get(row["id"], []),
            }
        )

    return {"nodes": nodes}


@router.get("/suggestions")
async def get_node_suggestions(
    limit: int = 20,
    class_filters: str | None = None,
    user: User = Depends(get_current_user),
):
    """Get suggested pages for node pickers (empty-query state).

    Returns pages in two priority tiers:
    1. Pages created in the last 15 minutes (by create_date DESC)
    2. Pages by most recently linked (by latest node_link.create_date DESC)

    Optionally filtered by class IDs (comma-separated).
    """
    service = await _get_node_service(user)

    # Parse class filters
    class_filter_ids = []
    if class_filters:
        class_filter_ids = [int(c.strip()) for c in class_filters.split(",") if c.strip().isdigit()]

    class_filter_clause = ""
    if class_filter_ids:
        class_filter_clause = " AND n.class_ids && $3::int[]"

    async with acquire_connection(service.pool) as conn:
        # Tier 1: Recently created pages (last 15 minutes)
        params_recent: list = [service.workspace_id, limit]
        if class_filter_ids:
            params_recent.append(class_filter_ids)

        recent_rows = await conn.fetch(
            f"""
            SELECT n.id, n.uuid, n.name, n.icon, n.color, n.parent_id, n.page_id,
                   n.is_page, n.is_class, n.is_day, n.is_month, n.is_year,
                   n.create_date, n.write_date, n.class_ids, n.aliased_id,
                   1 AS tier
            FROM node n
            WHERE n.is_page = true AND n.active = true
                  AND (n.is_deleted = false OR n.is_deleted IS NULL)
                  AND n.workspace_id = $1
                  AND n.create_date > NOW() - INTERVAL '15 minutes'
                  {class_filter_clause}
            ORDER BY n.create_date DESC
            LIMIT $2
        """,
            *params_recent,
        )

        recent_ids = {row["id"] for row in recent_rows}

        # Tier 2: Pages by most recently linked (target of a link)
        remaining = limit - len(recent_rows)
        linked_rows = []
        if remaining > 0:
            # Build exclusion clause for already-included IDs
            exclude_clause = ""
            params_linked: list = [service.workspace_id, remaining]
            param_idx = 3

            if recent_ids:
                exclude_clause = f" AND n.id != ALL(${param_idx}::int[])"
                params_linked.append(list(recent_ids))
                param_idx += 1

            if class_filter_ids:
                class_filter_clause_linked = f" AND n.class_ids && ${param_idx}::int[]"
                params_linked.append(class_filter_ids)
            else:
                class_filter_clause_linked = ""

            linked_rows = await conn.fetch(
                f"""
                SELECT n.id, n.uuid, n.name, n.icon, n.color, n.parent_id, n.page_id,
                       n.is_page, n.is_class, n.is_day, n.is_month, n.is_year,
                       n.create_date, n.write_date, n.class_ids, n.aliased_id,
                       2 AS tier
                FROM node n
                INNER JOIN (
                    SELECT target_id, MAX(create_date) AS last_linked
                    FROM node_link
                    WHERE workspace_id = $1
                    GROUP BY target_id
                ) nl ON nl.target_id = n.id
                WHERE n.is_page = true AND n.active = true
                      AND (n.is_deleted = false OR n.is_deleted IS NULL)
                      AND n.workspace_id = $1
                      {exclude_clause}
                      {class_filter_clause_linked}
                ORDER BY nl.last_linked DESC
                LIMIT $2
            """,
                *params_linked,
            )

        all_rows = list(recent_rows) + list(linked_rows)

    node_ids = [row["id"] for row in all_rows]
    alias_ids_map = await _get_related_ids_batch(service.pool, service.workspace_id or 0, node_ids, "aliases")

    nodes = []
    for row in all_rows:
        nodes.append(
            {
                "id": row["id"],
                "uuid": str(row["uuid"]),
                "name": row["name"],
                "icon": row["icon"],
                "color": row["color"],
                "parent_id": row["parent_id"],
                "page_id": row["page_id"],
                "is_page": row["is_page"],
                "is_class": row["is_class"],
                "is_daily": row["is_day"],
                "is_monthly": row["is_month"],
                "is_yearly": row["is_year"],
                "create_date": row["create_date"].isoformat() if row["create_date"] else None,
                "write_date": row["write_date"].isoformat() if row["write_date"] else None,
                "classes": list(row["class_ids"] or []),
                "aliased_id": row["aliased_id"],
                "aliases": alias_ids_map.get(row["id"], []),
            }
        )

    return {"nodes": nodes}


@router.get("/archived")
async def get_archived_pages(
    user: User = Depends(get_current_user),
):
    """Get all archived pages."""
    service = await _get_node_service(user)

    pages = await service.get_archived_pages()

    result = []
    for page in pages:
        if page.id is None:
            continue
        types = await service.get_node_classes(page.id)
        result.append(_node_to_response(page, classes=[t.id for t in types if t.id]))

    return {"pages": result}


@router.get("/templates", name="list_templates")
async def list_templates(
    user: User = Depends(get_current_user),
):
    """List all template nodes in the current workspace."""
    service = await _get_node_service(user)
    templates = await service.list_templates()

    pool = service.pool
    workspace_id = service.workspace_id or 0

    result = []
    for t in templates:
        if t.id is None:
            continue
        class_ids = await _get_class_ids(service, t.id)
        tag_ids = await _get_tag_ids(pool, workspace_id, t.id)
        result.append(_node_to_response(t, classes=class_ids, tags=tag_ids))

    return {"templates": result, "total": len(result)}




@router.get("/tasks")
async def list_tasks(
    include_complete: bool = False,
    user: User = Depends(get_current_user),
):
    """List all task nodes in the current workspace.

    Tasks are nodes that have the 'task' system class assigned.
    By default, excludes tasks with status 'Done' or 'Cancelled'.
    """
    from ...db.schema.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS

    service = await _get_node_service(user)
    pool = service.pool
    workspace_id = service.workspace_id or 0

    # Find the task class node ID
    task_class_node = await service.get_node_by_uuid(SYSTEM_CLASS_UUIDS["task"])
    if not task_class_node or task_class_node.id is None:
        return {"nodes": []}

    # Get all nodes with the task class
    nodes = await service.get_nodes_typed_with(task_class_node.id)

    # Batch load class_ids and tags
    node_ids = [n.id for n in nodes if n.id is not None]
    class_ids_map = await _get_class_ids_batch(pool, workspace_id, node_ids)
    tag_ids_map = await _get_related_ids_batch(pool, workspace_id, node_ids, "tags")

    # If filtering out completed tasks, batch-load task_status property
    if not include_complete and node_ids:
        status_prop = await service.property_repo.get_by_uuid(SYSTEM_PROPERTY_UUIDS["task_status"])
        if status_prop and status_prop.id is not None:
            batch_props = await service.get_nodes_properties_batch(node_ids)
            lines = await service.property_repo.get_selection_lines(status_prop.id)
            closed_line_ids = {line.id for line in lines if line.name in {"Done", "Cancelled"}}

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

    # Build response
    result = []
    for n in nodes:
        if n.id is None:
            continue
        result.append(_node_to_response(
            n,
            classes=class_ids_map.get(n.id, []),
            tags=tag_ids_map.get(n.id, []),
        ))

    return {"nodes": result}

@router.post("/scratchpad/clear")
async def clear_scratchpad(
    request: Request,
    user: User = Depends(get_current_user),
):
    """Delete all children (blocks) of the Scratchpad system page.

    Called on app startup to ensure the scratchpad starts empty.
    Hard-deletes all child blocks since scratchpad content is ephemeral.
    """
    from ...db.schema.constants import SYSTEM_PAGE_UUIDS

    service = await _get_node_service(user)
    pool = service.pool

    scratchpad_uuid = SYSTEM_PAGE_UUIDS["scratchpad"]

    # Find the scratchpad page
    scratchpad = await pool.fetchrow(
        "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2", scratchpad_uuid, service.workspace_id
    )

    if not scratchpad:
        # Auto-create the scratchpad page if it doesn't exist (for existing workspaces)
        from datetime import datetime

        from ...domain.stringify_ast import ParseMode, parse_ast, serialize_ast

        now = datetime.now(UTC)
        await pool.fetchrow(
            """
            INSERT INTO node (uuid, workspace_id, name, is_page, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, $3, TRUE, $4, $4, $5, $5)
            ON CONFLICT (workspace_id, uuid) DO NOTHING
            RETURNING id
        """,
            scratchpad_uuid,
            service.workspace_id,
            serialize_ast(parse_ast("Scratchpad", ParseMode.PLAIN)),
            now,
            int(user.id),
        )

        return {"status": "ok", "deleted_count": 0}

    scratchpad_id = scratchpad["id"]

    # Get all descendant block IDs (children and their children recursively)
    child_rows = await pool.fetch(
        """
        WITH RECURSIVE descendants AS (
            SELECT id, 0 AS depth
            FROM node
            WHERE id = $1
            UNION ALL
            SELECT n.id, d.depth + 1
            FROM node n
            INNER JOIN descendants d ON n.parent_id = d.id
        )
        SELECT id FROM descendants WHERE depth > 0
    """,
        scratchpad_id,
    )

    if not child_rows:
        return {"status": "ok", "deleted_count": 0}

    child_ids = [r["id"] for r in child_rows]

    # Hard-delete all children (scratchpad content is ephemeral)
    deleted = await pool.execute(
        """
        DELETE FROM node WHERE id = ANY($1) AND workspace_id = $2
    """,
        child_ids,
        service.workspace_id,
    )

    deleted_count = int(deleted.split()[-1]) if deleted else 0

    return {"status": "ok", "deleted_count": deleted_count}


@router.post("/{node_id}/restore", name="restore_node")
async def restore_node(
    node_id: int,
    user: User = Depends(get_current_user),
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
    return _node_to_response(node, classes=[t.id for t in types if t.id])


@router.get("/{node_id}/breadcrumbs", name="get_node_breadcrumbs")
async def get_node_breadcrumbs(
    node_id: int = Path(..., ge=1, description="Node ID"),
    user: User = Depends(get_current_user),
):
    """Get the ancestor breadcrumb chain for a node.

    Returns an ordered list of ancestors from root to the node's immediate parent.
    Uses the closure table for O(1) ancestor lookup — much faster than
    chaining individual GET requests.
    """
    from ...domain.stringify_ast import (
        NodeLinkResolution,
        StringifyMode,
        StringifyOptions,
        parse_ast,
        stringify_ast,
    )

    service = await _get_node_service(user)

    # If this node is an alias, return the aliased node's breadcrumbs instead
    breadcrumb_target_id = node_id
    node = await service.get_node(node_id)
    if node and node.aliased_id:
        breadcrumb_target_id = node.aliased_id

    # Use the repository's get_breadcrumbs which queries the closure table
    breadcrumb_nodes = await service.get_node_breadcrumbs(breadcrumb_target_id)

    # Collect all node link references from breadcrumb names to resolve them
    import re

    link_node_uuids: set[str] = set()
    for node in breadcrumb_nodes:
        if node.name:
            # Extract node UUIDs from link_id patterns ("nodeUuid:linkUuid" or bare UUID)
            for match in re.finditer(r'"link_id"\s*:\s*"([^"]+)"', node.name):
                link_id = match.group(1)
                colon = link_id.find(":")
                node_uuid = link_id[:colon] if colon > 0 else link_id
                link_node_uuids.add(node_uuid)

    # Resolve link targets in a single batch query
    link_target_map: dict[str, list] = {}
    if link_node_uuids:
        async with acquire_connection(service.pool) as conn:
            uuid_list = list(link_node_uuids)
            placeholders = ", ".join(f"${i + 2}" for i in range(len(uuid_list)))
            rows = await conn.fetch(
                f"SELECT uuid, name FROM node WHERE workspace_id = $1 AND uuid::text IN ({placeholders})",
                service.workspace_id,
                *uuid_list,
            )
            for row in rows:
                link_target_map[str(row["uuid"])] = parse_ast(row["name"])

    def _resolve_link(link_id: str):
        colon = link_id.find(":")
        node_uuid = link_id[:colon] if colon > 0 else link_id
        target_ast = link_target_map.get(node_uuid)
        if target_ast is None:
            return None
        return NodeLinkResolution(
            target_ast=target_ast,
            label=None,
            target_id=node_uuid,
        )

    opts = StringifyOptions(
        mode=StringifyMode.TEXT_ONLY,
        resolve_node_link=_resolve_link if link_target_map else None,
    )

    # The breadcrumbs include the target node itself at the end — exclude it
    items = []
    for node in breadcrumb_nodes:
        if node.id == breadcrumb_target_id:
            continue
        raw_name = node.name or ""
        display = stringify_ast(parse_ast(raw_name), opts)
        items.append(
            BreadcrumbItem(
                id=node.id or 0,
                name=raw_name,
                display_name=display or "Untitled",
                icon=node.icon,
                is_page=node.is_page,
                parent_locked=node.parent_locked,
            )
        )

    return BreadcrumbsResponse(breadcrumbs=items)


@router.post("/{node_id}/instantiate", name="instantiate_template")
async def instantiate_template(
    node_id: int = Path(..., ge=1, description="Node ID of the template"),
    body: TemplateInstantiateRequest = ...,
    user: User = Depends(get_current_user),
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

    result = await service.instantiate_template(
        template_id=node_id,
        user_id=int(user.id),
        parent_id=body.parent_id,
        name=body.name,
        variables=body.variables,
        as_blocks=body.as_blocks,
        after_id=body.after_id,
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
        return TemplateInstantiateResponse(node=None, blocks=blocks, as_blocks=True)
    else:
        root = result["node"]
        if not root:
            raise HTTPException(500, "Template instantiation failed: no root node returned")
        class_ids = await _get_class_ids(service, root.id)
        response_node = _node_to_response(root, classes=class_ids)
        return TemplateInstantiateResponse(node=response_node, blocks=[], as_blocks=False)


@router.get("/{node_id}")
async def get_node(
    node_id: int = Path(..., ge=1, description="Node ID (must be a positive integer)"),
    include_children: bool = False,
    include_backlinks: bool = False,
    include_properties: bool = False,
    user: User = Depends(get_current_user),
):
    """Get a node by ID."""
    service = await _get_node_service(user)

    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")

    # Get types for the node
    class_ids = await _get_class_ids(service, node_id)

    # Get tags for the node (from node_link with is_tag=1)
    tag_ids = await _get_tag_ids(service.pool, service.workspace_id or 0, node_id)

    # Get aliases for the node (nodes that have aliased_id pointing to this node)
    alias_ids = await _get_alias_ids(service.pool, service.workspace_id or 0, node_id)

    response = _node_to_response(node, tags=tag_ids, classes=class_ids, aliases=alias_ids)

    if include_children:
        pool = service.pool

        # Get ALL descendants using recursive CTE
        rows = await pool.fetch(
            """
            WITH RECURSIVE descendants AS (
                SELECT id, 0 AS depth
                FROM node
                WHERE id = $1 AND active = TRUE
                UNION ALL
                SELECT n.id, d.depth + 1
                FROM node n
                INNER JOIN descendants d ON n.parent_id = d.id
                WHERE n.active = TRUE
            )
            SELECT n.*
            FROM descendants d
            JOIN node n ON n.id = d.id
            WHERE d.depth > 0
              AND (n.is_deleted = FALSE OR n.is_deleted IS NULL)
            ORDER BY d.depth, n.sequence
        """,
            node_id,
        )
        all_descendants = [service.row_to_node(row) for row in rows]

        # ── Filter out text-property value blocks and their subtrees ──
        # Text properties store their value as a child block linked via
        # property_value_relation.  These blocks (and their descendants)
        # are rendered inside PropertiesSection, not in the main content.
        all_desc_ids = [d.id for d in all_descendants if d.id is not None]
        if all_desc_ids:
            tp_rows = await pool.fetch(
                """
                SELECT DISTINCT pvr.target_id
                FROM property_value_relation pvr
                JOIN property p ON p.id = pvr.property_id
                WHERE pvr.target_id = ANY($1)
                  AND p.type = 'text'
            """,
                all_desc_ids,
            )
            text_prop_ids = {r["target_id"] for r in tp_rows}
            if text_prop_ids:
                # Remove text-property blocks and their entire subtrees
                excluded: set = set()
                filtered = []
                for d in all_descendants:
                    if d.id in text_prop_ids or d.parent_id in excluded:
                        if d.id is not None:
                            excluded.add(d.id)
                        continue
                    filtered.append(d)
                all_descendants = filtered

        # ── Prune collapsed subtrees ──────────────────────────────
        # Build a set of IDs whose descendants should be excluded:
        # any node that is collapsed.  We keep the collapsed node itself
        # (so the frontend sees it with has_children=True) but drop its
        # descendants to avoid sending hundreds of invisible blocks.
        #
        # Because the closure-table query returns rows ORDER BY depth,
        # we process ancestors before descendants, so a collapsed node
        # at depth 1 will cause its depth-2+ children to be skipped.
        collapsed_ids: set = set()
        children_of: dict[int, list] = {}  # parent_id -> list of ids (for has_children)
        visible_descendants = []

        for d in all_descendants:
            if d.id is None:
                continue
            # Record parent-child relationship for has_children calculation
            pid = d.parent_id
            if pid is not None:
                children_of.setdefault(pid, []).append(d.id)

            # Skip if any ancestor is collapsed (check parent chain)
            if pid in collapsed_ids:
                # This node's parent is collapsed → skip it and propagate
                collapsed_ids.add(d.id)
                continue

            visible_descendants.append(d)

            # If this node is collapsed, mark it so its children are pruned
            if d.collapsed:
                collapsed_ids.add(d.id)

        # Get all visible descendant IDs
        descendant_ids = [d.id for d in visible_descendants if d.id is not None]

        # Get backlink counts for all descendants in one query
        backlink_counts: dict[int, int] = {}
        if descendant_ids:
            rows = await pool.fetch(
                """
                SELECT target_id, COUNT(*) as count
                FROM node_link
                WHERE target_id = ANY($1)
                GROUP BY target_id
            """,
                descendant_ids,
            )
            for row in rows:
                backlink_counts[row["target_id"]] = row["count"]

        # Get classes for all descendants in one batch using node.class_ids
        node_class_map = await _get_class_ids_batch(pool, service.workspace_id or 0, descendant_ids)

        # Get properties for all descendants if include_properties is requested
        node_properties_map: dict[int, dict[str, any]] = {}
        if include_properties and descendant_ids:
            # Use batch fetch (3 queries total) instead of N individual queries
            batch_result = await service.get_nodes_properties_batch(descendant_ids)
            for nid, prop_data in batch_result.items():
                node_properties_map[nid] = extract_properties_dict(prop_data)

        # Build tree structure from flat list using parent_id
        node_map: dict[int, NodeResponse] = {}
        for d in visible_descendants:
            if d.id is not None:
                bcount = backlink_counts.get(d.id, 0)
                d_class_ids = node_class_map.get(d.id, [])
                node_resp = _node_to_response(d, classes=d_class_ids, backlink_count=bcount)
                # Mark has_children based on full descendant list (not just visible)
                node_resp.has_children = d.id in children_of
                # Add properties if they were loaded
                if include_properties and d.id in node_properties_map:
                    node_resp.properties = node_properties_map[d.id]
                node_map[d.id] = node_resp

        root_children = []

        for d in visible_descendants:
            if d.id is None:
                continue
            node_response = node_map[d.id]
            if d.parent_id == node_id:
                # Direct child of the requested node
                root_children.append(node_response)
            elif d.parent_id in node_map:
                # Child of another descendant
                parent = node_map[d.parent_id]
                if parent.children is None:
                    parent.children = []
                parent.children.append(node_response)

        response.children = root_children

        # Build referenced_nodes map for inline pills — lightweight metadata
        # for all outgoing text link targets from this node and its descendants.
        all_source_ids = [node_id] + descendant_ids
        if all_source_ids:
            target_rows = await pool.fetch(
                """
                SELECT DISTINCT n.id, n.uuid, n.name, n.icon, n.color, n.is_page, n.is_class,
                       n.create_date, n.write_date, n.parent_id, n.page_id, n.sequence,
                       n.collapsed, n.active, n.class_ids
                FROM node_link nl
                JOIN node n ON n.id = nl.target_id
                WHERE nl.source_id = ANY($1)
                  AND nl.is_tag = FALSE
                  AND nl.is_inline_class = FALSE
                  AND nl.property_id IS NULL
                  AND n.active = TRUE
                  AND n.is_deleted = FALSE
            """,
                all_source_ids,
            )

            display_names = await _resolve_referenced_display_names(pool, service.workspace_id or 0, target_rows)
            referenced_nodes: dict[str, NodeResponse] = {}
            for row in target_rows:
                uuid_str = str(row["uuid"])
                referenced_nodes[uuid_str] = NodeResponse(
                    id=row["id"],
                    uuid=uuid_str,
                    name=row["name"] or "",
                    icon=row["icon"],
                    color=row["color"],
                    is_page=row["is_page"],
                    is_class=row.get("is_class", False),
                    create_date=str(row["create_date"]),
                    write_date=str(row["write_date"]),
                    parent_id=row["parent_id"],
                    page_id=row["page_id"],
                    sequence=row["sequence"],
                    collapsed=row["collapsed"],
                    active=row["active"],
                    display_name=display_names.get(uuid_str),
                    classes=list(row["class_ids"] or []),
                )
            response.referenced_nodes = referenced_nodes

    if include_backlinks:
        backlink_infos = await service.get_backlinks(node_id)
        response.backlinks = []
        for info in backlink_infos:
            # Convert breadcrumb tuples to BreadcrumbSegment objects
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

    if include_properties:
        all_prop_values = await service.get_node_properties(node_id)
        response.properties = extract_properties_dict(all_prop_values)

    return response


@router.get("/uuid/{uuid}")
async def get_node_by_uuid(
    uuid: str,
    include_children: bool = False,
    include_backlinks: bool = False,
    user: User = Depends(get_current_user),
):
    """Get a node by UUID."""
    service = await _get_node_service(user)

    node = await service.get_node_by_uuid(uuid)
    if not node:
        raise HTTPException(404, "Node not found")

    response = _node_to_response(node)

    if include_children and node.id:
        children = await service.get_node_children(node.id)
        response.children = [_node_to_response(c) for c in children]

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

    return response


@router.get("/page/{page_id}/content")
async def get_page_content(
    page_id: int,
    user: User = Depends(get_current_user),
):
    """Get a page with all its content (blocks, properties, backlinks)."""
    service = await _get_node_service(user)

    content = await service.get_page_content(page_id)
    if not content:
        raise HTTPException(404, "Page not found")

    page = content["page"]
    blocks = content["blocks"]
    backlinks = content["backlinks"]

    # Get connection early to avoid unbound variable
    pool = service.pool

    # Get block IDs for batch queries
    block_ids = [b.id for b in blocks if b.id is not None]

    # Get backlink counts for all blocks
    backlink_counts: dict[int, int] = {}
    if block_ids:
        rows = await pool.fetch(
            """
            SELECT target_id, COUNT(*) as count
            FROM node_link
            WHERE target_id = ANY($1)
            GROUP BY target_id
        """,
            block_ids,
        )
        for row in rows:
            backlink_counts[row["target_id"]] = row["count"]

    # Get classes for all nodes in one batch (from node.class_ids column)
    all_node_ids = [page_id] + block_ids
    node_class_map = await _get_class_ids_batch(pool, service.workspace_id or 0, all_node_ids)

    # Get tags for all nodes in one batch (from node_link with is_tag=1)
    node_tag_map = await _get_related_ids_batch(pool, service.workspace_id or 0, all_node_ids, "tags")

    # Build tree structure from flat list
    block_map = {}
    for b in blocks:
        if b.id != page_id and b.id is not None:
            bcount = backlink_counts.get(b.id, 0)
            class_ids = node_class_map.get(b.id, [])
            tag_ids = node_tag_map.get(b.id, [])
            block_map[b.id] = _node_to_response(b, tags=tag_ids, classes=class_ids, backlink_count=bcount)

    root_children = []

    for b in blocks:
        if b.id == page_id:
            continue
        if b.id is None:
            continue
        response = block_map[b.id]
        if b.parent_id == page_id:
            root_children.append(response)
        elif b.parent_id in block_map:
            parent = block_map[b.parent_id]
            if parent.children is None:
                parent.children = []
            parent.children.append(response)

    page_class_ids = node_class_map.get(page_id, [])
    page_tag_ids = node_tag_map.get(page_id, [])

    # Get aliases for the page
    page_alias_ids = await _get_alias_ids(service.pool, service.workspace_id or 0, page_id)

    page_response = _node_to_response(page, tags=page_tag_ids, classes=page_class_ids, aliases=page_alias_ids)
    page_response.children = root_children

    # Add properties - get the full property values
    all_prop_values = await service.get_node_properties(page_id)
    logger.info(f"Page {page_id} properties: {list(all_prop_values.keys())}")
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
            if link.position > 0 and len(context) > 100:
                start = max(0, link.position - 50)
                end = min(len(context), link.position + 50)
                context = "..." + context[start:end] + "..."

            page_response.linked_references.append(
                LinkedReferenceResponse(
                    source_node=_node_to_response(source),
                    source_page=_node_to_response(source_page) if source_page else None,
                    link_type="property" if link.property_id else "text",
                    context=context,
                )
            )

    # Build referenced_nodes map — lightweight metadata for all outgoing link targets.
    # This eliminates N+1 GET /api/nodes/uuid/{uuid} calls from inline pills.
    all_source_ids = [page_id] + block_ids
    if all_source_ids:
        target_id_rows = await pool.fetch(
            """
            SELECT DISTINCT target_id
            FROM node_link
            WHERE source_id = ANY($1)
              AND is_tag = FALSE
              AND is_inline_class = FALSE
              AND property_id IS NULL
        """,
            all_source_ids,
        )
        target_ids = [r["target_id"] for r in target_id_rows]
        target_rows = []
        if target_ids:
            target_rows = await pool.fetch(
                """
                SELECT id, uuid, name, icon, color, is_page, is_class,
                       create_date, write_date, parent_id, page_id, sequence,
                       collapsed, active, class_ids
                FROM node
                WHERE id = ANY($1)
                  AND active = TRUE
                  AND is_deleted = FALSE
            """,
                target_ids,
            )

        referenced_nodes: dict[str, NodeResponse] = {}
        for row in target_rows:
            uuid_str = str(row["uuid"])
            referenced_nodes[uuid_str] = NodeResponse(
                id=row["id"],
                uuid=uuid_str,
                name=row["name"] or "",
                icon=row["icon"],
                color=row["color"],
                is_page=row["is_page"],
                is_class=row.get("is_class", False),
                create_date=str(row["create_date"]),
                write_date=str(row["write_date"]),
                parent_id=row["parent_id"],
                page_id=row["page_id"],
                sequence=row["sequence"],
                collapsed=row["collapsed"],
                active=row["active"],
                display_name=None,
                classes=list(row["class_ids"] or []),
            )
        page_response.referenced_nodes = referenced_nodes

    return page_response


async def _apply_node_extras(service, node_id: int, classes, properties) -> None:
    """Reconcile classes and apply property values alongside a core node update.

    - ``classes``: when not None, the node's classes are set to exactly this list
      (adds missing, removes extras — Odoo-style).
    - ``properties``: dict of {property_id: value}; each pair is applied using
      the same dispatch logic as the ``POST /{node_id}/properties`` endpoint.
    """
    if classes is not None:
        async with acquire_connection(service.pool) as conn:
            row = await conn.fetchrow(
                "SELECT class_ids FROM node WHERE id = $1 AND workspace_id = $2",
                node_id,
                service.workspace_id,
            )
        current = set(row["class_ids"] or []) if row else set()
        want = set(classes)
        for cls_id in want - current:
            await service.add_class(node_id, cls_id)
        for cls_id in current - want:
            await service.remove_class(node_id, cls_id)

    if properties:
        from ...domain.entities.property import RELATION_TYPES, SCALAR_TYPES

        repo = service.property_repo
        for prop_id, value in properties.items():
            prop = await repo.get_by_id(prop_id)
            if not prop:
                continue
            if prop.type in SCALAR_TYPES:
                await repo.set_scalar_value(node_id, prop_id, value)
            elif prop.type in RELATION_TYPES:
                if value == "" or value is None:
                    await repo.assign_property_to_node(node_id, prop_id)
                elif isinstance(value, list):
                    unique_vals = list(dict.fromkeys(value))
                    await repo.clear_relation_values(node_id, prop_id)
                    for target_id in unique_vals:
                        await repo.set_relation_value(node_id, prop_id, int(target_id))
                else:
                    await repo.set_relation_value(node_id, prop_id, int(value))
            else:  # SELECTION
                if value == "" or value is None:
                    await repo.assign_property_to_node(node_id, prop_id)
                elif isinstance(value, list):
                    unique_vals = list(dict.fromkeys(value))
                    await repo.clear_selection_values(node_id, prop_id)
                    for sel_id in unique_vals:
                        await repo.set_selection_value(node_id, prop_id, int(sel_id))
                else:
                    await repo.set_selection_value(node_id, prop_id, int(value))


@router.put(
    "/{node_id}",
    dependencies=[Depends(RateLimiter(limiter=_crud_limiter))],
)
async def update_node(
    request: Request,
    node_id: int,
    body: NodeUpdateRequest,
    user: User = Depends(get_current_user),
):
    """Update a node."""
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    logger.info(f"[UPDATE_NODE] node_id={node_id}, body.color={body.color!r}, fields_set={body.model_fields_set}")

    service = await _get_node_service(user)

    data = NodeUpdateData(
        name=body.name,
        icon=body.icon,
        color=body.color,
        # Set clear flags when field was explicitly provided as None
        clear_icon="icon" in body.model_fields_set and body.icon is None,
        clear_color="color" in body.model_fields_set and body.color is None,
        clear_parent="parent_id" in body.model_fields_set and body.parent_id is None,
        parent_id=body.parent_id,
        sequence=body.sequence,
        collapsed=body.collapsed,
        visibility=body.visibility,
    )

    logger.info(f"[UPDATE_NODE] NodeUpdateData color={data.color!r}, clear_color={data.clear_color}")

    # Snapshot before state for undo
    old_node = await service.get_node(node_id)
    before = _node_snapshot(old_node) if old_node else None

    try:
        node = await service.update_node(node_id, data)
        if not node:
            raise HTTPException(404, "Node not found")

        logger.info(f"[UPDATE_NODE] result node.color={node.color!r}")

        # Apply class reconciliation and property values if provided
        if body.classes is not None or body.properties:
            await _apply_node_extras(service, node_id, body.classes, body.properties)

        # Invalidate static share HTML caches for this node
        try:
            pool = await get_pool()
            async with acquire_connection(pool) as conn:
                share_rows = await conn.fetch(
                    "SELECT uuid FROM node_public_share WHERE node_id = $1 AND active = TRUE",
                    node_id,
                )
                for share_row in share_rows:
                    try:
                        await write_share_html(str(share_row["uuid"]), node.workspace_id, node.uuid)
                    except Exception:
                        logger.exception(f"Failed to regenerate share HTML for {share_row['uuid']}")
        except Exception:
            logger.exception("Failed to invalidate share HTML caches")

        # Record for undo
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
            except Exception:
                pass

        return _node_to_response(node)
    except SystemClassConstraintError as e:
        raise HTTPException(422, str(e)) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.put("/{node_id}/move")
async def move_node(
    node_id: int,
    request: MoveNodeRequest,
    user: User = Depends(get_current_user),
):
    """Move a node to a new parent and/or position.

    Used for indent/outdent operations and drag-drop reordering.
    - parent_id: New parent ID (required for blocks - they must always have a parent)
    - position: New sequence position among siblings (0-indexed)

    Note: page_id is automatically computed from parent_id hierarchy.
    Sibling sequences are automatically adjusted to maintain ordering.
    """
    service = await _get_node_service(user)

    # Validate parent_id is provided
    if request.parent_id is None:
        raise HTTPException(400, "parent_id is required for move operation")

    # Default position to 0 if not specified
    position = request.position if request.position is not None else 0

    # Snapshot before state for undo
    old_node = await service.get_node(node_id)
    before = _node_snapshot(old_node) if old_node else None

    try:
        node = await service.move_node(node_id, request.parent_id, position)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    if not node:
        raise HTTPException(404, "Node not found")

    # Record for undo
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
        except Exception:
            pass

    return _node_to_response(node)


@router.delete(
    "/{node_id}",
    dependencies=[Depends(RateLimiter(limiter=_crud_limiter))],
)
async def delete_node(
    request: Request,
    node_id: int,
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
    pool = service.pool

    # Snapshot before state for undo (node name + descendants list)
    undo_before = None
    try:
        old_node = await service.get_node(node_id)
        if old_node:
            # Get descendant IDs for undo (needed to restore them too)
            desc_rows = await pool.fetch(
                """
                WITH RECURSIVE descendants AS (
                    SELECT id, 0 AS depth
                    FROM node
                    WHERE id = $1
                    UNION ALL
                    SELECT n.id, d.depth + 1
                    FROM node n
                    INNER JOIN descendants d ON n.parent_id = d.id
                )
                SELECT id FROM descendants WHERE depth > 0
                """,
                node_id,
            )
            desc_ids = [r["id"] for r in desc_rows]
            undo_before = {
                **_node_snapshot(old_node),
                "deleted_ids": [node_id] + desc_ids,
            }
    except Exception:
        pass

    # Get the node including archived ones (for UUID and asset cleanup)
    row = await pool.fetchrow(
        "SELECT uuid FROM node WHERE id = $1 AND workspace_id = $2", node_id, service.workspace_id
    )
    if not row:
        # Debug: check if node exists at all
        debug_row = await pool.fetchrow("SELECT id, workspace_id, active FROM node WHERE id = $1", node_id)
        if debug_row:
            raise HTTPException(
                404,
                f"Node {node_id} exists in workspace {debug_row['workspace_id']} (active={debug_row['active']}), but current user workspace is {service.workspace_id}",
            )
        raise HTTPException(404, f"Node {node_id} not found in any workspace")

    node_uuid = row["uuid"]

    # Try to delete any associated asset file
    if node_uuid and service.workspace_id is not None:
        # Get workspace UUID for asset storage
        workspace_uuid = await get_workspace_uuid(service.workspace_id)
        if workspace_uuid:
            assets_dir = get_workspace_assets_dir(workspace_uuid)
            # Check for asset files with any extension
            for asset_file in assets_dir.glob(f"{node_uuid}.*"):
                try:
                    asset_file.unlink()
                    logger.info(f"Deleted asset file {asset_file} for node {node_id}")
                except Exception as e:
                    logger.warning(f"Failed to delete asset file {asset_file}: {e}")

    try:
        success = await service.delete_node(node_id)
    except DatePageDeletionError as e:
        raise HTTPException(400, e.message) from e

    if not success:
        raise HTTPException(404, "Node not found")

    # Record for undo
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
        except Exception:
            pass

    return {"status": "ok"}


@router.post("/{node_id}/archive")
async def archive_node(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Archive a node (set active to false)."""
    service = await _get_node_service(user)

    node = await service.archive_node(node_id, None)
    if not node:
        raise HTTPException(404, "Node not found")

    # Record for undo
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
    except Exception:
        pass

    types = await service.get_node_classes(node_id)
    return _node_to_response(node, classes=[t.id for t in types if t.id])


@router.post("/{node_id}/merge-into/{target_id}", name="merge_pages")
async def merge_pages(
    node_id: int = Path(..., description="Source page ID (will be deleted)"),
    target_id: int = Path(..., description="Target page ID (merge destination)"),
    user: User = Depends(get_current_user),
):
    """Merge source page into target page.

    Moves all blocks from source to target, redirects all backlinks that point to
    source so they point to target instead, then soft-deletes the source page.
    """
    service = await _get_node_service(user)
    try:
        result = await service.merge_pages(node_id, target_id, user_id=int(user.id))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return result


@router.post("/{node_id}/unarchive")
async def unarchive_node(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Unarchive a node (set active to true)."""
    service = await _get_node_service(user)

    node = await service.unarchive_node(node_id, None)
    if not node:
        raise HTTPException(404, "Node not found")

    # Record for undo
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
    except Exception:
        pass

    types = await service.get_node_classes(node_id)
    return _node_to_response(node, classes=[t.id for t in types if t.id])


@router.patch("/{node_id}/open")
async def mark_page_opened(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Mark a page as opened/viewed (updates open_date).

    This should only be called for pages (is_page=1).
    The open_date is set to the current UTC time.

    Also ensures default NodeViews exist for the page (lazy initialization).
    """
    from datetime import datetime

    service = await _get_node_service(user)
    async with acquire_connection(service.pool) as conn:
        # Verify it's a page and exists
        row = await conn.fetchrow(
            "SELECT id, is_page FROM node WHERE id = $1 AND active = TRUE AND is_deleted = FALSE AND workspace_id = $2",
            node_id,
            service.workspace_id,
        )

        if not row:
            raise HTTPException(status_code=404, detail="Node not found")

        if not row["is_page"]:
            raise HTTPException(status_code=400, detail="Only pages can have open_date updated")

        # Update open_date
        now = datetime.now(UTC)
        await conn.execute("UPDATE node SET open_date = $1 WHERE id = $2", now, node_id)

    # Note: Default views are now lazily created by the frontend via ensure-defaults endpoint
    # This keeps all query structure logic in one place

    return {"status": "ok", "open_date": now.isoformat()}


@router.get("/{node_id}/versions", name="get_node_versions")
async def get_node_versions(
    node_id: int,
    limit: int = 50,
    user: User = Depends(get_current_user),
):
    """Get version history for a node, ordered by most recent first."""
    service = await _get_node_service(user)

    async with acquire_connection(service.pool) as conn:
        rows = await conn.fetch(
            """
            SELECT nv.id, nv.name, nv.created_at, nv.user_id,
                   u.username
            FROM node_version nv
            LEFT JOIN "user" u ON u.id = nv.user_id
            WHERE nv.node_id = $1 AND nv.workspace_id = $2
            ORDER BY nv.created_at DESC
            LIMIT $3
        """,
            node_id,
            service.workspace_id,
            limit,
        )

    versions = []
    for row in rows:
        versions.append(
            {
                "id": row["id"],
                "name": row["name"],
                "created_at": row["created_at"].isoformat() if row["created_at"] else None,
                "user": row["username"],
            }
        )

    return {"versions": versions}


@router.post("/{node_id}/versions/{version_id}/restore", name="restore_node_version")
async def restore_node_version(
    node_id: int,
    version_id: int,
    user: User = Depends(get_current_user),
):
    """Restore a node to a previous version's content."""
    service = await _get_node_service(user)

    async with acquire_connection(service.pool) as conn:
        # Get the version content
        row = await conn.fetchrow(
            """
            SELECT name FROM node_version
            WHERE id = $1 AND node_id = $2 AND workspace_id = $3
        """,
            version_id,
            node_id,
            service.workspace_id,
        )

        if not row:
            raise HTTPException(404, "Version not found")

    # Update the node with the old content
    data = NodeUpdateData(name=row["name"])
    updated = await service.update_node(node_id, data, user_id=int(user.id))

    if not updated:
        raise HTTPException(404, "Node not found")

    types = await service.get_node_classes(node_id)
    return _node_to_response(updated, classes=[t.id for t in types if t.id])



