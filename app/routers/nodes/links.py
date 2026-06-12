"""Backlinks, linked references, tag links, alias, and property endpoints."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException

from ...db.connection import acquire_connection
from ...db.schema import parse_date_uuid
from ...domain.entities import BacklinkInfo
from ...models import User
from ..auth import get_current_user
from .helpers import (
    _build_children_response,
    _get_alias_ids,
    _get_class_ids_batch,
    _get_node_service,
    _get_undo_service,
    _node_to_response,
    extract_properties_dict,
)
from .models import (
    AliasRequest,
    BacklinkResponse,
    BatchTextLinksRequest,
    BreadcrumbSegment,
    InlineClassResponse,
    LinkedReferenceResponse,
    NodeLinkResponse,
    PropertyBacklinkResponse,
    PropertyRequest,
    TagLinkRequest,
)

router = APIRouter()


@router.get("/{node_id}/text-links")
async def get_text_links(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Get all text links from a node with is_tag info.

    Returns list of links parsed from [[id]] or [[id:uuid]] patterns in the node's content,
    including whether each link is a tag (displayed with #) or a regular link.
    """
    service = await _get_node_service(user)
    async with acquire_connection(service.pool) as conn:
        rows = await conn.fetch(
            """
            SELECT id, uuid, source_id, target_id, is_tag, position, name
            FROM node_link
            WHERE source_id = $1 AND property_id IS NULL
            ORDER BY position
        """,
            node_id,
        )

    return {
        "links": [
            NodeLinkResponse(
                id=row["id"],
                uuid=str(row["uuid"]),
                source_node_id=row["source_id"],
                target_node_id=row["target_id"],
                is_tag=row["is_tag"],
                position=row["position"],
                name=row["name"],
            )
            for row in rows
        ]
    }


@router.post("/batch-text-links")
async def get_batch_text_links(
    body: BatchTextLinksRequest,
    user: User = Depends(get_current_user),
):
    """Get text links for multiple nodes in a single request.

    Request body: { "node_ids": [1, 2, 3, ...] }
    Returns: { "links_by_node": { "1": [...], "2": [...], ... } }

    Used for efficiently resolving node names in table views.
    """
    node_ids = body.node_ids
    if not node_ids:
        return {"links_by_node": {}}

    # Limit to prevent abuse
    if len(node_ids) > 5000:
        raise HTTPException(status_code=400, detail="Too many node IDs (max 5000)")

    service = await _get_node_service(user)
    async with acquire_connection(service.pool) as conn:
        rows = await conn.fetch(
            """
            SELECT id, uuid, source_id, target_id, is_tag, position, name
            FROM node_link
            WHERE source_id = ANY($1) AND property_id IS NULL
            ORDER BY source_id, position
        """,
            node_ids,
        )

    # Group links by source node ID
    links_by_node = {}
    for row in rows:
        source_id = str(row["source_id"])
        if source_id not in links_by_node:
            links_by_node[source_id] = []
        links_by_node[source_id].append(
            NodeLinkResponse(
                id=row["id"],
                uuid=str(row["uuid"]),
                source_node_id=row["source_id"],
                target_node_id=row["target_id"],
                is_tag=row["is_tag"],
                position=row["position"],
                name=row["name"],
            )
        )

    return {"links_by_node": links_by_node}


@router.post("/{node_id}/tag-links")
async def add_tag_link(
    node_id: int,
    request: TagLinkRequest,
    user: User = Depends(get_current_user),
):
    """Add a tag link from a node to a target page.

    This marks a [[id]] link in the content as a tag, which will be
    displayed with a # instead of a page/block icon.
    """
    service = await _get_node_service(user)
    async with acquire_connection(service.pool) as conn:
        # Verify source node exists
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE id = $1 AND workspace_id = $2", node_id, service.workspace_id
        )
        if not row:
            raise HTTPException(404, "Source node not found")

        # Verify target node exists and is a page
        target_row = await conn.fetchrow(
            "SELECT id, is_page, parent_id FROM node WHERE id = $1 AND workspace_id = $2",
            request.target_node_id,
            service.workspace_id,
        )
        if not target_row:
            raise HTTPException(404, "Target node not found")
        if not target_row["is_page"] and target_row["parent_id"] is not None:
            raise HTTPException(400, "Tags can only point to pages")

        # Check if link already exists
        row = await conn.fetchrow(
            """
            SELECT id, uuid FROM node_link
            WHERE source_id = $1 AND target_id = $2 AND property_id IS NULL AND workspace_id = $3
        """,
            node_id,
            request.target_node_id,
            service.workspace_id,
        )

        now = datetime.now(UTC)

        if row:
            # Update existing link to be a tag
            await conn.execute("UPDATE node_link SET is_tag = TRUE WHERE id = $1", row["id"])
            return NodeLinkResponse(
                id=row["id"],
                uuid=str(row["uuid"]),
                source_node_id=node_id,
                target_node_id=request.target_node_id,
                is_tag=True,
                position=0,
            )
        else:
            # Create new tag link
            new_row = await conn.fetchrow(
                """
                INSERT INTO node_link (source_id, target_id, position, property_id, is_tag, create_date, workspace_id)
                VALUES ($1, $2, 0, NULL, TRUE, $3, $4)
                RETURNING id, uuid
            """,
                node_id,
                request.target_node_id,
                now,
                service.workspace_id,
            )
            return NodeLinkResponse(
                id=new_row["id"],
                uuid=str(new_row["uuid"]),
                source_node_id=node_id,
                target_node_id=request.target_node_id,
                is_tag=True,
                position=0,
            )


@router.delete("/{node_id}/tag-links/{target_id}")
async def remove_tag_link(
    node_id: int,
    target_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a tag from a link (converts back to regular link)."""
    service = await _get_node_service(user)
    async with acquire_connection(service.pool) as conn:
        result = await conn.execute(
            """
            UPDATE node_link SET is_tag = FALSE
            WHERE source_id = $1 AND target_id = $2 AND property_id IS NULL AND is_tag = TRUE AND workspace_id = $3
        """,
            node_id,
            target_id,
            service.workspace_id,
        )

    return {"removed": result == "UPDATE 1"}


@router.post("/{node_id}/properties")
async def set_property(
    node_id: int,
    request: PropertyRequest,
    user: User = Depends(get_current_user),
):
    """Set a property value on a node."""
    service = await _get_node_service(user)

    # Get property to determine its type
    prop = await service.property_repo.get_by_id(request.property_id)
    if not prop:
        raise HTTPException(404, "Property not found")

    # Snapshot existing property value before setting
    from ...domain.entities import RELATION_TYPES, SCALAR_TYPES, PropertyType

    old_value = None
    try:
        if prop.type in SCALAR_TYPES:
            vals = await service.property_repo.get_scalar_values(node_id, request.property_id)
            old_value = vals[0].value if vals else None
        elif prop.type in RELATION_TYPES:
            vals = await service.property_repo.get_relation_values(node_id, request.property_id)
            old_value = vals[0].target_node_id if vals else None
        elif prop.type == PropertyType.SELECTION:
            vals = await service.property_repo.get_scalar_values(node_id, request.property_id)
            old_value = vals[0].value if vals else None
    except LookupError:
        pass

    # Set value based on property type
    if prop.type in SCALAR_TYPES:
        await service.property_repo.set_scalar_value(node_id, request.property_id, request.value)
    elif prop.type in RELATION_TYPES:
        # For relation types, value should be a target_node_id
        await service.property_repo.set_relation_value(node_id, request.property_id, request.value)
    elif prop.type == PropertyType.SELECTION:
        # For selection types, value should be a selection_line_id
        await service.property_repo.set_selection_value(node_id, request.property_id, request.value)

    # Record for undo
    try:
        undo = await _get_undo_service(user)
        await undo.record(
            "set_property",
            "node",
            node_id,
            before_state={
                "property_id": request.property_id,
                "property_type": prop.type.value if hasattr(prop.type, "value") else str(prop.type),
                "had_value": old_value is not None,
                "value": old_value,
            },
            after_state={
                "property_id": request.property_id,
                "property_type": prop.type.value if hasattr(prop.type, "value") else str(prop.type),
                "value": request.value,
            },
            description=f"Set property {prop.name} on node {node_id}",
        )
    except (ValueError, TypeError, LookupError):
        pass

    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    return _node_to_response(node)


@router.delete("/{node_id}/properties/{property_id}")
async def remove_property(
    node_id: int,
    property_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a property value from a node."""
    service = await _get_node_service(user)

    # Snapshot existing property value before removal
    from ...domain.entities import RELATION_TYPES, SCALAR_TYPES, PropertyType

    old_value = None
    prop = None
    try:
        prop = await service.property_repo.get_by_id(property_id)
        if prop:
            if prop.type in SCALAR_TYPES:
                vals = await service.property_repo.get_scalar_values(node_id, property_id)
                old_value = vals[0].value if vals else None
            elif prop.type in RELATION_TYPES:
                vals = await service.property_repo.get_relation_values(node_id, property_id)
                old_value = vals[0].target_node_id if vals else None
            elif prop.type == PropertyType.SELECTION:
                vals = await service.property_repo.get_scalar_values(node_id, property_id)
                old_value = vals[0].value if vals else None
    except LookupError:
        pass

    await service.property_repo.remove_property_from_node(node_id, property_id)

    # Record for undo
    try:
        undo = await _get_undo_service(user)
        await undo.record(
            "remove_property",
            "node",
            node_id,
            before_state={
                "property_id": property_id,
                "property_type": prop.type.value
                if prop and hasattr(prop.type, "value")
                else str(prop.type)
                if prop
                else None,
                "had_value": old_value is not None,
                "value": old_value,
            },
            after_state={"property_id": property_id, "removed": True},
            description=f"Removed property {prop.name if prop else property_id} from node {node_id}",
        )
    except (ValueError, TypeError, LookupError):
        pass

    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    return _node_to_response(node)


@router.get("/{node_id}/backlinks")
async def get_backlinks(
    node_id: int,
    include_inherited: bool = True,
    user: User = Depends(get_current_user),
):
    """Get backlinks to a node."""
    service = await _get_node_service(user)

    # Note: include_inherited parameter is not yet implemented in the service
    backlinks = await service.get_backlinks(node_id)

    # Batch-fetch all source nodes in one query
    source_ids = [link.source_node_id for link in backlinks]
    source_nodes = {n.id: n for n in await service.get_nodes_by_ids(source_ids)} if source_ids else {}

    # Batch-fetch all page nodes in one query
    page_ids = list({n.page_id for n in source_nodes.values() if n.page_id})
    page_nodes = {n.id: n for n in await service.get_nodes_by_ids(page_ids)} if page_ids else {}

    result = []
    for link in backlinks:
        source = source_nodes.get(link.source_node_id)
        source_page = page_nodes.get(source.page_id) if source and source.page_id else None

        result.append(
            BacklinkResponse(
                source_node_id=link.source_node_id,
                source_node_uuid=str(source.uuid) if source and source.uuid else "",
                source_node_name=source.name if source else "",
                source_page_id=source.page_id if source else None,
                source_page_name=source_page.name if source_page else None,
                link_type="property" if link.property_id else "text",
                position=link.link.position if link.link else 0,
            )
        )

    return {"backlinks": result}


@router.get("/{node_id}/linked-references")
async def get_linked_references(
    node_id: int,
    limit: int = 50,
    offset: int = 0,
    count: bool = False,
    user: User = Depends(get_current_user),
):
    """Get linked references to a node with context, including children hierarchy.

    Supports pagination via `limit` and `offset`. Use `?count=true` for a fast
    count-only response.
    """
    service = await _get_node_service(user)

    backlinks = await service.get_backlinks(node_id)

    # Deduplicate by source_node_id, preferring direct backlinks to the target node.
    seen_source_ids: dict[int, BacklinkInfo] = {}
    for link in backlinks:
        existing = seen_source_ids.get(link.source_node_id)
        if existing is None or link.link.target_id == node_id:
            seen_source_ids[link.source_node_id] = link
    backlinks = list(seen_source_ids.values())

    # Filter out sources that are descendants of another source in the list.
    # If Block A links to Target and Block B (child of A) also links to Target,
    # Block B should appear only as a child under Block A, not as a separate entry.
    source_ids = [link.source_node_id for link in backlinks]
    if source_ids:
        ancestors_map = await service._node_repo.get_ancestors_batch(source_ids, include_self=False)
        source_id_set = set(source_ids)
        filtered_backlinks = []
        for link in backlinks:
            ancestors = ancestors_map.get(link.source_node_id, [])
            if not any(ancestor_id in source_id_set for ancestor_id in ancestors):
                filtered_backlinks.append(link)
        backlinks = filtered_backlinks

    total_count = len(backlinks)

    if count:
        return {"linked_references": [], "total_count": total_count}

    # Clamp pagination
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    paginated = backlinks[offset:offset + limit]

    # Collect all source node IDs for batch type fetching
    source_node_ids = []
    sources_data = []  # Store (source, children, source_page, link) tuples

    for link in paginated:
        source = await service.get_node(link.source_node_id)
        if not source:
            continue

        # Get all descendants of the source node recursively
        children = await service.get_node_descendants(source.id) if source.id else []

        source_page = None
        if source.page_id:
            source_page = await service.get_node(source.page_id)

        if source.id:
            source_node_ids.append(source.id)
        sources_data.append((source, children, source_page, link))

    # Batch fetch class_ids for all source nodes
    class_ids_map = await _get_class_ids_batch(service.pool, service.workspace_id or 0, source_node_ids)

    # Batch fetch properties for all source nodes
    node_properties_map = {}
    if source_node_ids:
        batch_result = await service.property_repo.get_all_property_values_batch(source_node_ids)
        for nid, prop_data in batch_result.items():
            node_properties_map[nid] = extract_properties_dict(prop_data)

    result = []
    for source, children, source_page, link in sources_data:
        # Extract context around the link
        context = source.name or ""
        position = link.link.position if link.link else 0
        if position > 0 and len(context) > 100:
            start = max(0, position - 50)
            end = min(len(context), position + 50)
            context = "..." + context[start:end] + "..."

        breadcrumb_segments = (
            [
                BreadcrumbSegment(node_id=seg[0], name=seg[1], is_property=seg[2] if len(seg) > 2 else False)
                for seg in link.breadcrumb_path
            ]
            if hasattr(link, "breadcrumb_path") and link.breadcrumb_path
            else []
        )

        source_classes = class_ids_map.get(source.id, []) if source.id else []
        source_response = _node_to_response(source, classes=source_classes)
        source_response.children = _build_children_response(children) if children else []

        if source.id and source.id in node_properties_map:
            source_response.properties = node_properties_map[source.id]

        result.append(
            LinkedReferenceResponse(
                source_node=source_response,
                source_page=_node_to_response(source_page) if source_page else None,
                link_type="property" if link.property_id else "text",
                context=context,
                breadcrumb_path=breadcrumb_segments,
                property_id=link.property_id,
                property_name=link.property_name,
                text_property_root_block_id=getattr(link, "text_property_root_block_id", None),
            )
        )

    return {"linked_references": result, "total_count": total_count}


@router.get("/{node_id}/inline-classes")
async def get_inline_classes(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Get inline class references for a node.

    Returns all inline class links (is_inline_class=True) from the node's content.
    """
    service = await _get_node_service(user)

    inline_classes = await service.get_inline_classes_for_node(node_id)

    result = []
    for inline_link in inline_classes:
        class_node = await service.get_node(inline_link.target_id)
        if not class_node:
            continue

        result.append(
            InlineClassResponse(
                class_node_id=inline_link.target_id,
                class_node_name=class_node.name or "",
                class_node_icon=class_node.icon,
                position=inline_link.position,
            )
        )

    return {"inline_classes": result}


@router.get("/{node_id}/property-backlinks")
async def get_property_backlinks(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Get pages that reference this node via date or node properties.

    For day pages: returns pages that have a date property matching the day.
    For other nodes: returns pages that have a node property pointing to this node.
    """
    service = await _get_node_service(user)

    # Get the target node
    target = await service.get_node(node_id)
    if not target:
        raise HTTPException(status_code=404, detail="Node not found")

    result = []
    page_ids = []  # Collect all page IDs for batch property fetching
    pages_data = []  # Store (page, property_id, property_name) tuples

    # Check if target is a day node (UUID format YYYYMMDD with non-zero day)
    date_info = parse_date_uuid(target.uuid)
    if date_info and date_info.get("type") == "day":
        # Find all date property values that reference this day page
        # Date properties are stored in property_value_relation (not scalar)
        pool = service.pool
        rows = await pool.fetch(
            """
            SELECT DISTINCT pvr.node_id, pvr.property_id, p.name as property_name
            FROM property_value_relation pvr
            JOIN property p ON pvr.property_id = p.id
            WHERE pvr.target_id = $1 AND p.type = 'date'
        """,
            node_id,
        )

        for row in rows:
            # Get the page for this node
            node = await service.get_node(row["node_id"])
            if not node:
                continue

            # Get the page this node belongs to (or itself if it's a page)
            page = node
            if node.page_id:
                page = await service.get_node(node.page_id)
                if not page:
                    page = node

            if page.id:
                page_ids.append(page.id)
                pages_data.append((page, row["property_id"], row["property_name"]))

    # Also check for node-class properties pointing to this node
    # Classes are now in class_ids column, not a property
    pool = service.pool
    rows = await pool.fetch(
        """
        SELECT DISTINCT pvr.node_id, pvr.property_id, p.name as property_name
        FROM property_value_relation pvr
        JOIN property p ON pvr.property_id = p.id
        WHERE pvr.target_id = $1 AND p.type = 'node'
    """,
        node_id,
    )

    for row in rows:
        node = await service.get_node(row["node_id"])
        if not node:
            continue

        page = node
        if node.page_id:
            page = await service.get_node(node.page_id)
            if not page:
                page = node

        if page.id:
            page_ids.append(page.id)
            pages_data.append((page, row["property_id"], row["property_name"]))

    # Batch fetch properties for all pages
    node_properties_map = {}
    if page_ids:
        batch_result = await service.property_repo.get_all_property_values_batch(page_ids)
        for page_id, prop_data in batch_result.items():
            node_properties_map[page_id] = extract_properties_dict(prop_data)

    # Build result with properties attached
    for page, property_id, property_name in pages_data:
        page_response = _node_to_response(page)

        # Add properties if they were loaded
        if page.id and page.id in node_properties_map:
            page_response.properties = node_properties_map[page.id]

        result.append(
            PropertyBacklinkResponse(
                source_page=page_response,
                property_id=property_id,
                property_name=property_name,
            )
        )

    return {"property_backlinks": result}


# ==================== ALIAS ENDPOINTS ==


@router.get("/{node_id}/aliases")
async def get_aliases(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Get all aliases for a node (pages that are aliases of this node)."""
    service = await _get_node_service(user)

    alias_ids = await _get_alias_ids(service.pool, service.workspace_id or 0, node_id)

    # Fetch full node data for each alias
    aliases = []
    for alias_id in alias_ids:
        alias_node = await service.get_node(alias_id)
        if alias_node:
            aliases.append(_node_to_response(alias_node))

    return {"aliases": aliases}


@router.post("/{node_id}/aliases")
async def add_alias(
    node_id: int,
    request: AliasRequest,
    user: User = Depends(get_current_user),
):
    """Add a page as an alias of this node.

    The alias node must be:
    - A page (is_page=true)
    - Not already an alias of another node
    - Not the same as the target node
    - Not a node that has aliases itself (avoid chaining)
    """
    service = await _get_node_service(user)

    async with acquire_connection(service.pool) as conn:
        # Verify target node exists
        target = await conn.fetchrow(
            "SELECT id, is_page, aliased_id FROM node WHERE id = $1 AND workspace_id = $2 AND active = TRUE",
            node_id,
            service.workspace_id,
        )
        if not target:
            raise HTTPException(404, "Target node not found")
        if not target["is_page"]:
            raise HTTPException(400, "Aliases can only be added to page nodes")
        if target["aliased_id"] is not None:
            raise HTTPException(
                400, "Cannot add aliases to a node that is itself an alias. Add aliases to the main node instead."
            )

        # Verify alias node exists and is eligible
        alias_node = await conn.fetchrow(
            "SELECT id, is_page, aliased_id FROM node WHERE id = $1 AND workspace_id = $2 AND active = TRUE",
            request.alias_node_id,
            service.workspace_id,
        )
        if not alias_node:
            raise HTTPException(404, "Alias node not found")
        if not alias_node["is_page"]:
            raise HTTPException(400, "Only page nodes can be used as aliases")
        if alias_node["aliased_id"] is not None:
            raise HTTPException(400, "This node is already an alias of another node")
        if request.alias_node_id == node_id:
            raise HTTPException(400, "A node cannot be an alias of itself")

        # Check that the alias candidate doesn't have aliases itself (no chaining)
        existing_aliases = await conn.fetchval(
            "SELECT COUNT(*) FROM node WHERE aliased_id = $1 AND workspace_id = $2 AND active = TRUE",
            request.alias_node_id,
            service.workspace_id,
        )
        if existing_aliases > 0:
            raise HTTPException(400, "Cannot use a node that has aliases as an alias itself. Remove its aliases first.")

        # Set aliased_id on the alias node
        await conn.execute("UPDATE node SET aliased_id = $1 WHERE id = $2", node_id, request.alias_node_id)

    # Return updated target node with aliases
    node = await service.get_node(node_id)
    alias_ids = await _get_alias_ids(service.pool, service.workspace_id or 0, node_id)
    return _node_to_response(node, aliases=alias_ids)


@router.delete("/{node_id}/aliases/{alias_id}")
async def remove_alias(
    node_id: int,
    alias_id: int,
    user: User = Depends(get_current_user),
):
    """Remove an alias from a node (clears aliased_id on the alias node)."""
    service = await _get_node_service(user)

    async with acquire_connection(service.pool) as conn:
        # Verify the alias relationship exists
        result = await conn.execute(
            "UPDATE node SET aliased_id = NULL WHERE id = $1 AND aliased_id = $2 AND workspace_id = $3",
            alias_id,
            node_id,
            service.workspace_id,
        )

    if result == "UPDATE 0":
        raise HTTPException(404, "Alias relationship not found")

    return {"removed": True}


@router.post("/rebuild-links")
async def rebuild_all_links(
    user: User = Depends(get_current_user),
):
    """Rebuild all node_link records from AST content.

    This command:
    1. Deletes all existing text links and inline class links
    2. Re-parses all nodes' AST content to rebuild both types of links
    3. Returns statistics about the operation

    Use this when link data may have become inconsistent (e.g., after a migration).
    Tag links are preserved. Property links are managed separately.
    """
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    service = await _get_node_service(user)

    nodes_processed = 0
    links_created = 0
    inline_classes_created = 0
    errors = []

    try:
        # Step 1: Delete existing text links and inline classes (preserve tags)
        async with acquire_connection(service.pool) as conn:
            await conn.execute(
                """
                DELETE FROM node_link
                WHERE workspace_id = $1
                  AND property_id IS NULL
                  AND is_tag = FALSE
            """,
                service.workspace_id,
            )
            logger.info(
                f"[REBUILD_LINKS] Deleted existing text links and inline classes for workspace {service.workspace_id}"
            )

        # Step 2: Get all nodes in the workspace
        async with acquire_connection(service.pool) as conn:
            nodes = await conn.fetch(
                """
                SELECT id, name
                FROM node
                WHERE workspace_id = $1 AND active = TRUE
                ORDER BY id
            """,
                service.workspace_id,
            )

        logger.info(f"[REBUILD_LINKS] Processing {len(nodes)} nodes")

        # Step 3: Re-parse each node and rebuild links and inline classes
        for node_row in nodes:
            node_id = node_row["id"]
            content = node_row["name"]

            if not content:
                nodes_processed += 1
                continue

            try:
                # Rebuild text links
                created_links = await service.update_node_links(node_id, content)
                links_created += len(created_links)

                # Rebuild inline classes
                created_classes = await service.update_inline_classes(node_id, content)
                inline_classes_created += len(created_classes)

                nodes_processed += 1

                # Log progress every 100 nodes
                if nodes_processed % 100 == 0:
                    logger.info(f"[REBUILD_LINKS] Progress: {nodes_processed}/{len(nodes)} nodes")
            except Exception as e:
                error_msg = f"Node {node_id}: {str(e)}"
                errors.append(error_msg)
                logger.warning(f"[REBUILD_LINKS] Error processing node {node_id}: {e}")
                nodes_processed += 1
                continue

        logger.info(
            f"[REBUILD_LINKS] Completed: {nodes_processed} nodes, {links_created} links + {inline_classes_created} inline classes created, {len(errors)} errors"
        )

        return {
            "success": True,
            "nodes_processed": nodes_processed,
            "links_created": links_created,
            "inline_classes_created": inline_classes_created,
            "errors": errors[:100],  # Limit error list to first 100
            "total_errors": len(errors),
        }

    except Exception as e:
        logger.error(f"[REBUILD_LINKS] Fatal error: {e}", exc_info=True)
        raise HTTPException(500, f"Failed to rebuild links: {str(e)}") from e


@router.post("/fix-raw-uuid-links")
async def fix_raw_uuid_links(
    user: User = Depends(get_current_user),
):
    """Find raw [[uuid]] text in AST content and convert them to proper node_link AST nodes.

    This command:
    1. Scans all nodes' AST content for text nodes containing [[uuid]] patterns
    2. Resolves each UUID to an existing node
    3. Replaces the raw text with proper node_link AST objects
    4. Saves updated AST and rebuilds link records

    Use this when blocks contain raw UUID references instead of proper node links.
    """
    import json
    import re
    import uuid as uuid_module

    from ...logging_config import get_logger

    logger = get_logger(__name__)

    service = await _get_node_service(user)

    nodes_processed = 0
    nodes_fixed = 0
    links_converted = 0
    errors = []

    # UUID v4 pattern fragment (reused in both regex alternatives)
    uuid_re = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

    # Matches both:
    #   [Custom Label]([[uuid]])  — labeled markdown link format
    #   [[uuid]]                  — bare UUID reference
    # Named groups: label (optional), uuid_labeled / uuid_bare (exactly one set)
    uuid_pattern = re.compile(
        rf"(?:\[(?P<label>[^\]]+)\]\(\[\[(?P<uuid_labeled>{uuid_re})\]\]\)|\[\[(?P<uuid_bare>{uuid_re})\]\])",
        re.IGNORECASE,
    )

    def _extract_uuid_and_label(match) -> tuple:
        """Return (target_uuid_lower, label_or_None) from a combined-pattern match."""
        if match.group("uuid_labeled"):
            return match.group("uuid_labeled").lower(), match.group("label") or None
        return match.group("uuid_bare").lower(), None

    def transform_text_node(text_value: str, uuid_to_node: dict) -> list:
        """Split a text node containing [[uuid]] or [label]([[uuid]]) into text + node_link nodes."""
        parts = []
        last_end = 0

        for match in uuid_pattern.finditer(text_value):
            target_uuid, label = _extract_uuid_and_label(match)
            if target_uuid not in uuid_to_node:
                continue

            # Text before the match
            before = text_value[last_end : match.start()]
            if before:
                parts.append({"type": "text", "text": before})

            # Create proper node_link
            link_uuid = str(uuid_module.uuid4())
            link_id = f"{target_uuid}:{link_uuid}"
            node_link: dict = {
                "type": "node_link",
                "link_id": link_id,
                "ref_type": "node",
            }
            if label:
                node_link["label"] = label
            parts.append(node_link)

            last_end = match.end()

        # Remaining text after last match
        if last_end < len(text_value):
            remaining = text_value[last_end:]
            if remaining:
                parts.append({"type": "text", "text": remaining})

        return parts

    def walk_and_transform(nodes: list, uuid_to_node: dict) -> tuple:
        """Walk AST nodes, replacing text containing [[uuid]] with node_link nodes.
        Also converts broken_link AST nodes back to node_link when their target now exists.

        Returns (new_nodes, count_of_links_converted).
        """
        converted = 0
        new_nodes = []

        for node in nodes:
            if not isinstance(node, dict):
                new_nodes.append(node)
                continue

            node_type = node.get("type")
            if node_type == "broken_link":
                link_id = node.get("link_id", "")
                colon_idx = link_id.find(":")
                node_uuid = link_id[:colon_idx].lower() if colon_idx > 0 else link_id.lower()
                if node_uuid in uuid_to_node:
                    # Regenerate link_uuid to avoid unique constraint collisions
                    # when the same broken_link was duplicated across multiple nodes.
                    new_link_uuid = str(uuid_module.uuid4())
                    new_link_id = f"{node_uuid}:{new_link_uuid}"
                    new_node = {
                        **node,
                        "type": "node_link",
                        "ref_type": "node",
                        "link_id": new_link_id,
                    }
                    new_nodes.append(new_node)
                    converted += 1
                    continue
                new_nodes.append(node)
            elif node_type == "text":
                text_val = node.get("text", "")
                if "[[" in text_val and uuid_pattern.search(text_val):
                    replacement = transform_text_node(text_val, uuid_to_node)
                    if replacement and replacement != [node]:
                        # Count how many node_links were created
                        link_count = sum(1 for r in replacement if isinstance(r, dict) and r.get("type") == "node_link")
                        if link_count > 0:
                            new_nodes.extend(replacement)
                            converted += link_count
                            continue
                new_nodes.append(node)
            elif "children" in node:
                child_nodes, child_converted = walk_and_transform(node["children"], uuid_to_node)
                new_node = {**node, "children": child_nodes}
                new_nodes.append(new_node)
                converted += child_converted
            else:
                new_nodes.append(node)

        return new_nodes, converted

    try:
        # Step 1: Get all active nodes
        async with acquire_connection(service.pool) as conn:
            all_nodes = await conn.fetch(
                """
                SELECT id, name
                FROM node
                WHERE workspace_id = $1 AND active = TRUE
                ORDER BY id
            """,
                service.workspace_id,
            )

        logger.info(f"[FIX_RAW_UUID_LINKS] Processing {len(all_nodes)} nodes")

        # Step 2: First pass — collect all UUIDs referenced in raw [[uuid]] text and broken_link nodes
        all_referenced_uuids = set()
        for node_row in all_nodes:
            content = node_row["name"]
            if not content:
                continue
            # Quick check before parsing JSON — look for [[uuid]] or broken_link
            if "[[" not in content and "broken_link" not in content:
                continue
            try:
                ast = json.loads(content)
                if not isinstance(ast, list):
                    continue
            except (json.JSONDecodeError, TypeError):
                continue

            # Walk the AST to find text nodes with [[uuid]] or [label]([[uuid]]) and broken_link nodes
            def collect_uuids(nodes):
                for n in nodes:
                    if not isinstance(n, dict):
                        continue
                    if n.get("type") == "text":
                        text = n.get("text", "")
                        if "[[" in text:
                            for m in uuid_pattern.finditer(text):
                                uuid = (m.group("uuid_labeled") or m.group("uuid_bare")).lower()
                                all_referenced_uuids.add(uuid)
                    elif n.get("type") == "broken_link":
                        link_id = n.get("link_id", "")
                        colon_idx = link_id.find(":")
                        node_uuid = link_id[:colon_idx].lower() if colon_idx > 0 else link_id.lower()
                        if re.match(uuid_re, node_uuid, re.IGNORECASE):
                            all_referenced_uuids.add(node_uuid)
                    if "children" in n:
                        collect_uuids(n["children"])

            collect_uuids(ast)

        if not all_referenced_uuids:
            logger.info("[FIX_RAW_UUID_LINKS] No raw UUID links found")
            return {
                "success": True,
                "nodes_processed": len(all_nodes),
                "nodes_fixed": 0,
                "links_converted": 0,
                "errors": [],
                "total_errors": 0,
            }

        logger.info(f"[FIX_RAW_UUID_LINKS] Found {len(all_referenced_uuids)} unique referenced UUIDs")

        # Step 3: Resolve all referenced UUIDs to nodes (batch lookup)
        uuid_to_node = {}
        async with acquire_connection(service.pool) as conn:
            for ref_uuid in all_referenced_uuids:
                row = await conn.fetchrow(
                    "SELECT id, uuid FROM node WHERE uuid = $1 AND workspace_id = $2 AND active = TRUE",
                    ref_uuid,
                    service.workspace_id,
                )
                if row:
                    uuid_to_node[ref_uuid] = {"id": row["id"], "uuid": row["uuid"]}

        logger.info(
            f"[FIX_RAW_UUID_LINKS] Resolved {len(uuid_to_node)}/{len(all_referenced_uuids)} UUIDs to existing nodes"
        )

        # Step 4: Second pass — transform AST and save
        for node_row in all_nodes:
            node_id = node_row["id"]
            content = node_row["name"]
            nodes_processed += 1

            if not content or ("[[" not in content and "broken_link" not in content):
                continue

            try:
                ast = json.loads(content)
                if not isinstance(ast, list):
                    continue
                if ast and (not isinstance(ast[0], dict) or "type" not in ast[0]):
                    continue
            except (json.JSONDecodeError, TypeError):
                continue

            try:
                new_ast, converted = walk_and_transform(ast, uuid_to_node)

                if converted > 0:
                    # Save updated AST
                    new_content = json.dumps(new_ast, ensure_ascii=False)
                    async with acquire_connection(service.pool) as conn:
                        await conn.execute(
                            "UPDATE node SET name = $1, write_date = $2 WHERE id = $3 AND workspace_id = $4",
                            new_content,
                            datetime.now(UTC),
                            node_id,
                            service.workspace_id,
                        )

                    # Rebuild links for this node
                    await service.update_node_links(node_id, new_content)
                    await service.update_inline_classes(node_id, new_content)

                    nodes_fixed += 1
                    links_converted += converted

                    if nodes_fixed % 50 == 0:
                        logger.info(
                            f"[FIX_RAW_UUID_LINKS] Progress: {nodes_fixed} nodes fixed, {links_converted} links converted"
                        )

            except Exception as e:
                error_msg = f"Node {node_id}: {str(e)}"
                errors.append(error_msg)
                logger.warning(f"[FIX_RAW_UUID_LINKS] Error processing node {node_id}: {e}")
                continue

        logger.info(
            f"[FIX_RAW_UUID_LINKS] Completed: {nodes_processed} processed, {nodes_fixed} fixed, {links_converted} links converted, {len(errors)} errors"
        )

        return {
            "success": True,
            "nodes_processed": nodes_processed,
            "nodes_fixed": nodes_fixed,
            "links_converted": links_converted,
            "errors": errors[:100],
            "total_errors": len(errors),
        }

    except Exception as e:
        logger.error(f"[FIX_RAW_UUID_LINKS] Fatal error: {e}", exc_info=True)
        raise HTTPException(500, f"Failed to fix raw UUID links: {str(e)}") from e


@router.post("/fix-links-for-uuid/{target_uuid}")
async def fix_links_for_uuid(
    target_uuid: str,
    user: User = Depends(get_current_user),
):
    """Fix all broken_link and raw [[uuid]] references pointing to a specific UUID.

    After creating a node with a specific UUID, call this to convert:
    1. broken_link AST nodes with matching link_id → node_link AST nodes
    2. Raw [[uuid]] or [label]([[uuid]]) text → node_link AST nodes

    This is more efficient than fix-raw-uuid-links because it targets a single UUID.
    """
    import json
    import re
    import uuid as uuid_module

    from ...logging_config import get_logger

    logger = get_logger(__name__)

    service = await _get_node_service(user)

    # Validate UUID format
    uuid_re = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    if not re.match(uuid_re, target_uuid, re.IGNORECASE):
        raise HTTPException(400, f"Invalid UUID format: {target_uuid}")

    target_uuid_lower = target_uuid.lower()

    nodes_fixed = 0
    links_converted = 0
    errors = []

    # Regex for raw [[uuid]] and [label]([[uuid]]) in text
    uuid_re_fragment = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    uuid_pattern = re.compile(
        rf"(?:\[(?P<label>[^\]]+)\]\(\[\[(?P<uuid_labeled>{uuid_re_fragment})\]\]\)|\[\[(?P<uuid_bare>{uuid_re_fragment})\]\])",
        re.IGNORECASE,
    )

    def _extract_uuid_and_label(match) -> tuple:
        if match.group("uuid_labeled"):
            return match.group("uuid_labeled").lower(), match.group("label") or None
        return match.group("uuid_bare").lower(), None

    def transform_text_node(text_value: str) -> list:
        parts = []
        last_end = 0

        for match in uuid_pattern.finditer(text_value):
            ref_uuid, label = _extract_uuid_and_label(match)
            if ref_uuid != target_uuid_lower:
                continue

            before = text_value[last_end : match.start()]
            if before:
                parts.append({"type": "text", "text": before})

            link_uuid = str(uuid_module.uuid4())
            link_id = f"{target_uuid_lower}:{link_uuid}"
            node_link: dict = {
                "type": "node_link",
                "link_id": link_id,
                "ref_type": "node",
            }
            if label:
                node_link["label"] = label
            parts.append(node_link)

            last_end = match.end()

        if last_end < len(text_value):
            remaining = text_value[last_end:]
            if remaining:
                parts.append({"type": "text", "text": remaining})

        return parts

    def walk_and_transform(nodes: list) -> tuple:
        converted = 0
        new_nodes = []

        for node in nodes:
            if not isinstance(node, dict):
                new_nodes.append(node)
                continue

            node_type = node.get("type")
            if node_type == "broken_link":
                link_id = node.get("link_id", "")
                # Parse node UUID from link_id (format: nodeUuid:linkUuid)
                colon_idx = link_id.find(":")
                node_uuid = link_id[:colon_idx].lower() if colon_idx > 0 else link_id.lower()
                if node_uuid == target_uuid_lower:
                    # Regenerate link_uuid to avoid unique constraint collisions
                    # when the same broken_link was duplicated across multiple nodes.
                    new_link_uuid = str(uuid_module.uuid4())
                    new_link_id = f"{node_uuid}:{new_link_uuid}"
                    new_node = {
                        **node,
                        "type": "node_link",
                        "ref_type": "node",
                        "link_id": new_link_id,
                    }
                    new_nodes.append(new_node)
                    converted += 1
                    continue
                new_nodes.append(node)
            elif node_type == "text":
                text_val = node.get("text", "")
                if "[[" in text_val and uuid_pattern.search(text_val):
                    replacement = transform_text_node(text_val)
                    if replacement and replacement != [node]:
                        link_count = sum(1 for r in replacement if isinstance(r, dict) and r.get("type") == "node_link")
                        if link_count > 0:
                            new_nodes.extend(replacement)
                            converted += link_count
                            continue
                new_nodes.append(node)
            elif "children" in node:
                child_nodes, child_converted = walk_and_transform(node["children"])
                new_node = {**node, "children": child_nodes}
                new_nodes.append(new_node)
                converted += child_converted
            else:
                new_nodes.append(node)

        return new_nodes, converted

    try:
        # Find nodes that might contain references to this UUID
        # We search for the UUID in the raw name JSONB text
        async with acquire_connection(service.pool) as conn:
            candidate_rows = await conn.fetch(
                """
                SELECT id, name
                FROM node
                WHERE workspace_id = $1
                  AND active = TRUE
                  AND name LIKE $2
                ORDER BY id
            """,
                service.workspace_id,
                f'%"{target_uuid_lower}"%',
            )

        logger.info(f"[FIX_LINKS_FOR_UUID] Found {len(candidate_rows)} candidate nodes for UUID {target_uuid_lower}")

        # Also include nodes that might have raw [[uuid]] text (the UUID wouldn't be in quotes)
        async with acquire_connection(service.pool) as conn:
            raw_candidates = await conn.fetch(
                """
                SELECT id, name
                FROM node
                WHERE workspace_id = $1
                  AND active = TRUE
                  AND name LIKE $2
                  AND id NOT IN (SELECT id FROM node WHERE workspace_id = $1 AND active = TRUE AND name LIKE $3)
                ORDER BY id
            """,
                service.workspace_id,
                f"%[[{target_uuid_lower}]]%",
                f'%"{target_uuid_lower}"%',
            )

        candidate_ids = {r["id"] for r in candidate_rows} | {r["id"] for r in raw_candidates}
        all_candidates = []
        for row in candidate_rows:
            if row["id"] in candidate_ids:
                all_candidates.append(row)
                candidate_ids.discard(row["id"])
        for row in raw_candidates:
            if row["id"] in candidate_ids:
                all_candidates.append(row)

        logger.info(f"[FIX_LINKS_FOR_UUID] Total unique candidate nodes: {len(all_candidates)}")

        for node_row in all_candidates:
            node_id = node_row["id"]
            content = node_row["name"]

            if not content:
                continue

            try:
                ast = json.loads(content)
                if not isinstance(ast, list):
                    continue
                if ast and (not isinstance(ast[0], dict) or "type" not in ast[0]):
                    continue
            except (json.JSONDecodeError, TypeError):
                continue

            try:
                new_ast, converted = walk_and_transform(ast)

                if converted > 0:
                    new_content = json.dumps(new_ast, ensure_ascii=False)
                    async with acquire_connection(service.pool) as conn:
                        await conn.execute(
                            "UPDATE node SET name = $1, write_date = $2 WHERE id = $3 AND workspace_id = $4",
                            new_content,
                            datetime.now(UTC),
                            node_id,
                            service.workspace_id,
                        )

                    await service.update_node_links(node_id, new_content)
                    await service.update_inline_classes(node_id, new_content)

                    nodes_fixed += 1
                    links_converted += converted
            except Exception as e:
                error_msg = f"Node {node_id}: {str(e)}"
                errors.append(error_msg)
                logger.warning(f"[FIX_LINKS_FOR_UUID] Error processing node {node_id}: {e}")
                continue

        logger.info(
            f"[FIX_LINKS_FOR_UUID] Completed for {target_uuid_lower}: {nodes_fixed} nodes fixed, {links_converted} links converted, {len(errors)} errors"
        )

        return {
            "success": True,
            "target_uuid": target_uuid_lower,
            "nodes_fixed": nodes_fixed,
            "links_converted": links_converted,
            "errors": errors[:50],
            "total_errors": len(errors),
        }

    except Exception as e:
        logger.error(f"[FIX_LINKS_FOR_UUID] Fatal error: {e}", exc_info=True)
        raise HTTPException(500, f"Failed to fix links for UUID: {str(e)}") from e
