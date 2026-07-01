"""Backlinks, linked references, tag links, alias, and property endpoints."""

from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import get_current_user, get_node_repository, get_property_repository, require_write_scope
from app.domain.entities import BacklinkInfo
from app.domain.errors import NodeNotFoundError, NodeValidationError
from app.features.nodes.link_service import LinkParsingService
from app.features.nodes.node_service import MAX_DESCENDANTS_LOAD
from app.features.nodes.port import NodeRepository
from app.features.properties.port import PropertyRepository
from app.logging_config import get_logger
from app.models import User

from .dependencies import (
    resolve_alias_uuid,
    resolve_mention_uuid,
    resolve_node_uuid,
    resolve_node_uuids,
    resolve_target_uuid,
)
from .helpers import (
    _build_children_response,
    _build_node_uuid_map,
    _enrich_node_responses_uuids,
    _get_node_service,
    _get_undo_service,
    _node_to_response,
    _resolve_display_names_for_responses,
    _resolve_property_uuids,
    extract_properties_dict,
)
from .models import (
    AliasRequest,
    BacklinkResponse,
    BatchTextLinksRequest,
    BreadcrumbSegment,
    InlineClassResponse,
    LinkedReferenceResponse,
    MentionResponse,
    NodeLinkResponse,
    PropertyBacklinkResponse,
    TagLinkRequest,
)

logger = get_logger(__name__)
router = APIRouter()


@router.get("/{node_uuid}/text-links")
async def get_text_links(
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Get all text links from a node.

    Returns list of links parsed from [[id]] or [[id:uuid]] patterns in the node's content.
    """
    service = await _get_node_service(user)
    links = await service.get_text_links(node_id)

    link_node_ids = [node_id for link in links for node_id in (link.source_id, link.target_id)]
    uuid_map = await _build_node_uuid_map(repo, link_node_ids)

    return {
        "links": [
            NodeLinkResponse(
                id=link.id,
                uuid=str(link.uuid) if link.uuid else "",
                source_node_id=link.source_id,
                source_node_uuid=uuid_map.get(link.source_id),
                target_node_id=link.target_id,
                target_node_uuid=uuid_map.get(link.target_id),
                position=link.position or 0,
                name=link.name,
            )
            for link in links
        ]
    }


@router.post("/batch-text-links")
async def get_batch_text_links(
    body: BatchTextLinksRequest,
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Get text links for multiple nodes in a single request.

    Request body: { "node_uuids": ["uuid-1", "uuid-2", ...] }
    Returns: { "links_by_node": { "uuid-1": [...], "uuid-2": [...], ... } }

    Used for efficiently resolving node names in table views.
    """
    if not body.node_uuids:
        return {"links_by_node": {}}

    # Limit to prevent abuse
    if len(body.node_uuids) > 5000:
        raise HTTPException(status_code=400, detail="Too many node UUIDs (max 5000)")

    node_ids = await resolve_node_uuids(body.node_uuids, repo=repo)
    service = await _get_node_service(user)
    grouped = await service.get_text_links_batch(node_ids)

    link_node_ids = [node_id for links in grouped.values() for link in links for node_id in (link.source_id, link.target_id)]
    uuid_map = await _build_node_uuid_map(repo, link_node_ids)

    links_by_node: dict[str, list[NodeLinkResponse]] = {}
    for source_id, links in grouped.items():
        source_uuid = uuid_map.get(source_id)
        if source_uuid is None:
            continue
        links_by_node[source_uuid] = [
            NodeLinkResponse(
                id=link.id,
                uuid=str(link.uuid) if link.uuid else "",
                source_node_id=link.source_id,
                source_node_uuid=uuid_map.get(link.source_id),
                target_node_id=link.target_id,
                target_node_uuid=uuid_map.get(link.target_id),
                position=link.position or 0,
                name=link.name,
            )
            for link in links
        ]

    return {"links_by_node": links_by_node}


@router.post("/{node_uuid}/tag-links", dependencies=[Depends(require_write_scope)])
async def add_tag_link(
    request: TagLinkRequest,
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Add a tag to a node.

    Stores the target page ID in the node's tag_ids array.
    """
    service = await _get_node_service(user)

    target_node = await repo.get_by_uuid(request.target_node_uuid)
    if target_node is None or target_node.id is None:
        raise HTTPException(status_code=404, detail="Target node not found")
    target_node_id = target_node.id

    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    before_tag_ids = list(node.tag_ids)

    try:
        node = await service.add_tag_link_atomic(node_id, target_node_id)
    except NodeNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except NodeValidationError as e:
        raise HTTPException(400, str(e)) from e

    # Record for undo
    try:
        undo = await _get_undo_service(user)
        await undo.record(
            "add_tag_link",
            "node",
            node_id,
            before_state={"tag_ids": before_tag_ids},
            after_state={"tag_ids": list(node.tag_ids)},
            description=f"Added tag link to node {node_id}",
        )
    except (ValueError, TypeError, LookupError):
        pass

    return {"success": True}


@router.delete("/{node_uuid}/tag-links/{target_uuid}", dependencies=[Depends(require_write_scope)])
async def remove_tag_link(
    node_id: int = Depends(resolve_node_uuid),
    target_id: int = Depends(resolve_target_uuid),
    user: User = Depends(get_current_user),
):
    """Remove a tag from a node."""
    service = await _get_node_service(user)

    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    before_tag_ids = list(node.tag_ids)

    try:
        node = await service.remove_tag_link_atomic(node_id, target_id)
    except NodeNotFoundError as e:
        raise HTTPException(404, str(e)) from e

    # Record for undo
    try:
        undo = await _get_undo_service(user)
        await undo.record(
            "remove_tag_link",
            "node",
            node_id,
            before_state={"tag_ids": before_tag_ids},
            after_state={"tag_ids": list(node.tag_ids)},
            description=f"Removed tag link from node {node_id}",
        )
    except (ValueError, TypeError, LookupError):
        pass

    return {"removed": True}


@router.get("/{node_uuid}/backlinks")
async def get_backlinks(
    node_id: int = Depends(resolve_node_uuid),
    include_inherited: bool = True,
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
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

    # Resolve inline node links so backlink surfaces show target names.
    source_display_names = await service.resolve_node_display_names(list(source_nodes.values()))
    page_display_names = await service.resolve_node_display_names(list(page_nodes.values()))

    # Batch-resolve property UUIDs for property-type backlinks.
    property_ids = {link.property_id for link in backlinks if link.property_id}
    property_uuid_map = await _resolve_property_uuids(property_repo, property_ids)

    result = []
    for link in backlinks:
        source = source_nodes.get(link.source_node_id)
        source_page = page_nodes.get(source.page_id) if source and source.page_id else None

        link_type = "property" if link.property_id else ("embed" if link.link and link.link.is_embed else "text")

        source_node_name = source.name if source else ""
        if source and source.id is not None:
            source_node_name = source_display_names.get(source.id, source_node_name)

        source_page_name = source_page.name if source_page else None
        if source_page and source_page.id is not None:
            source_page_name = page_display_names.get(source_page.id, source_page_name)

        result.append(
            BacklinkResponse(
                source_node_id=link.source_node_id,
                source_node_uuid=str(source.uuid) if source and source.uuid else "",
                source_node_name=source_node_name,
                source_is_page=source.is_page if source else False,
                source_page_id=source.page_id if source else None,
                source_page_name=source_page_name,
                source_page_uuid=str(source_page.uuid) if source_page and source_page.uuid else None,
                property_id=link.property_id,
                property_uuid=property_uuid_map.get(link.property_id) if link.property_id else None,
                property_name=link.property_name,
                link_type=link_type,
                position=link.link.position if link.link else 0,
            )
        )

    return {"backlinks": result}


@router.get("/{node_uuid}/linked-references")
async def get_linked_references(
    node_id: int = Depends(resolve_node_uuid),
    limit: int = 50,
    offset: int = 0,
    count: bool = False,
    user: User = Depends(get_current_user),
    property_repo: PropertyRepository = Depends(get_property_repository),
    repo: NodeRepository = Depends(get_node_repository),
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
        ancestors_map = await service.get_ancestors_batch(source_ids, include_self=False)
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

    # Batch resolve source nodes, descendant IDs, and page nodes before looping.
    source_node_ids = [link.source_node_id for link in paginated]
    source_nodes = {n.id: n for n in await service.get_nodes_by_ids(source_node_ids) if n.id}

    resolved_source_ids = list(source_nodes.keys())
    descendant_ids_map = await service.get_node_descendants_batch(resolved_source_ids)
    all_descendant_ids: list[int] = []
    for source_id, desc_ids in descendant_ids_map.items():
        if len(desc_ids) > MAX_DESCENDANTS_LOAD:
            logger.warning(
                "Linked-references source %s has %s descendants; clamping load to %s",
                source_id,
                len(desc_ids),
                MAX_DESCENDANTS_LOAD,
            )
            desc_ids = desc_ids[:MAX_DESCENDANTS_LOAD]
            descendant_ids_map[source_id] = desc_ids
        all_descendant_ids.extend(desc_ids)
    descendant_nodes = {n.id: n for n in await service.get_nodes_by_ids(all_descendant_ids) if n.id}

    page_ids = list({n.page_id for n in source_nodes.values() if n.page_id})
    page_nodes = {n.id: n for n in await service.get_nodes_by_ids(page_ids)} if page_ids else {}

    sources_data = []  # Store (source, children, source_page, link) tuples
    source_node_ids = []
    for link in paginated:
        source = source_nodes.get(link.source_node_id)
        if not source or not source.id:
            continue

        desc_ids = descendant_ids_map.get(source.id, [])
        children = [descendant_nodes[did] for did in desc_ids if did in descendant_nodes]
        source_page = page_nodes.get(source.page_id) if source.page_id else None

        source_node_ids.append(source.id)
        sources_data.append((source, children, source_page, link))

    # Batch fetch class_ids for all source nodes
    class_ids_map = await service.get_class_ids_batch(source_node_ids)

    # Batch fetch properties for all source nodes
    node_properties_map = {}
    if source_node_ids:
        batch_result = await property_repo.get_all_property_values_batch(source_node_ids)
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

        source_page_response = _node_to_response(source_page) if source_page else None

        link_type = "property" if link.property_id else ("embed" if link.link and link.link.is_embed else "text")
        result.append(
            LinkedReferenceResponse(
                source_node=source_response,
                source_page=source_page_response,
                link_type=link_type,
                context=context,
                breadcrumb_path=breadcrumb_segments,
                property_id=link.property_id,
                property_name=link.property_name,
                text_property_root_block_id=getattr(link, "text_property_root_block_id", None),
            )
        )

    # Resolve inline node links for source nodes and their containing pages.
    source_page_nodes = [source_page for _, _, source_page, _ in sources_data if source_page]
    result_source_nodes = [source for source, _, _, _ in sources_data]
    await _resolve_display_names_for_responses(service, result_source_nodes, [r.source_node for r in result])
    await _resolve_display_names_for_responses(
        service,
        source_page_nodes,
        [r.source_page for r in result if r.source_page is not None],
    )

    # Enrich UUID fields on source/page nodes, property IDs, and breadcrumb segments.
    all_node_responses = [r.source_node for r in result] + [
        r.source_page for r in result if r.source_page is not None
    ]
    await _enrich_node_responses_uuids(all_node_responses, repo, property_repo)

    property_ids = {r.property_id for r in result if r.property_id}
    property_uuid_map = await _resolve_property_uuids(property_repo, property_ids)

    extra_node_ids: set[int] = set()
    for r in result:
        for seg in r.breadcrumb_path:
            if seg.node_id:
                extra_node_ids.add(seg.node_id)
        if r.text_property_root_block_id:
            extra_node_ids.add(r.text_property_root_block_id)
    extra_uuid_map = await _build_node_uuid_map(repo, list(extra_node_ids))

    for r in result:
        r.property_uuid = property_uuid_map.get(r.property_id) if r.property_id else None
        r.text_property_root_block_uuid = (
            extra_uuid_map.get(r.text_property_root_block_id) if r.text_property_root_block_id else None
        )
        for seg in r.breadcrumb_path:
            seg.node_uuid = extra_uuid_map.get(seg.node_id) if seg.node_id else None

    return {"linked_references": result, "total_count": total_count}


@router.get("/{node_uuid}/inline-classes")
async def get_inline_classes(
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Get inline class references for a node.

    Returns all inline class links (is_inline_class=True) from the node's content.
    """
    service = await _get_node_service(user)

    inline_classes = await service.get_inline_classes_for_node(node_id)

    target_ids = [inline_link.target_id for inline_link in inline_classes]
    uuid_map = await _build_node_uuid_map(repo, target_ids)

    result = []
    for inline_link in inline_classes:
        class_node = await service.get_node(inline_link.target_id)
        if not class_node:
            continue

        result.append(
            InlineClassResponse(
                class_node_id=inline_link.target_id,
                class_node_uuid=uuid_map.get(inline_link.target_id),
                class_node_name=class_node.name or "",
                class_node_icon=class_node.icon,
                position=inline_link.position,
            )
        )

    return {"inline_classes": result}


@router.get("/{node_uuid}/property-backlinks")
async def get_property_backlinks(
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    property_repo: PropertyRepository = Depends(get_property_repository),
    repo: NodeRepository = Depends(get_node_repository),
):
    """Get pages that reference this node via date or node properties.

    For day pages: returns pages that have a date property matching the day.
    For other nodes: returns pages that have a node property pointing to this node.
    """
    service = await _get_node_service(user)

    try:
        pages_data = await service.get_property_backlinks(node_id)
    except NodeNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    page_ids = [page.id for page, _property_id, _property_name in pages_data if page.id]

    # Batch fetch properties for all pages
    node_properties_map = {}
    if page_ids:
        batch_result = await property_repo.get_all_property_values_batch(page_ids)
        for page_id, prop_data in batch_result.items():
            node_properties_map[page_id] = extract_properties_dict(prop_data)

    # Build result with properties attached
    result = []
    page_nodes = []
    for page, property_id, property_name in pages_data:
        page_response = _node_to_response(page)

        # Add properties if they were loaded
        if page.id and page.id in node_properties_map:
            page_response.properties = node_properties_map[page.id]

        page_nodes.append(page)
        result.append(
            PropertyBacklinkResponse(
                source_page=page_response,
                property_id=property_id,
                property_name=property_name,
            )
        )

    await _resolve_display_names_for_responses(service, page_nodes, [r.source_page for r in result])

    await _enrich_node_responses_uuids([r.source_page for r in result], repo, property_repo)

    property_ids = {r.property_id for r in result if r.property_id}
    property_uuid_map = await _resolve_property_uuids(property_repo, property_ids)
    for r in result:
        r.property_uuid = property_uuid_map.get(r.property_id) if r.property_id else None

    return {"property_backlinks": result}


# ==================== ALIAS ENDPOINTS ==


@router.get("/{node_uuid}/aliases")
async def get_aliases(
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
):
    """Get all aliases for a node (pages that are aliases of this node)."""
    service = await _get_node_service(user)

    alias_ids = await service.get_alias_ids(node_id)

    # Fetch full node data for each alias (raw alias records, not resolved targets)
    aliases = []
    alias_nodes = []
    for alias_id in alias_ids:
        alias_node = await service.get_node_by_id(alias_id)
        if alias_node:
            alias_nodes.append(alias_node)
            aliases.append(_node_to_response(alias_node))

    await _resolve_display_names_for_responses(service, alias_nodes, aliases)
    await _enrich_node_responses_uuids(aliases, repo, property_repo)

    return {"aliases": aliases}


@router.post("/{node_uuid}/aliases", dependencies=[Depends(require_write_scope)])
async def add_alias(
    request: AliasRequest,
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    repo: NodeRepository = Depends(get_node_repository),
    property_repo: PropertyRepository = Depends(get_property_repository),
):
    """Add a page as an alias of this node.

    The alias node must be:
    - A page (is_page=true)
    - Not already an alias of another node
    - Not the same as the target node
    - Not a node that has aliases itself (avoid chaining)
    """
    service = await _get_node_service(user)

    alias_node = await repo.get_by_uuid(request.alias_node_uuid)
    if alias_node is None or alias_node.id is None:
        raise HTTPException(404, "Alias node not found")
    alias_node_id = alias_node.id

    before_aliased_id = alias_node.aliased_id

    try:
        node = await service.add_alias_atomic(node_id, alias_node_id)
    except NodeNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except NodeValidationError as e:
        raise HTTPException(400, str(e)) from e

    # Record for undo
    try:
        undo = await _get_undo_service(user)
        await undo.record(
            "add_alias",
            "node",
            node_id,
            before_state={"alias_node_id": alias_node_id, "aliased_id": before_aliased_id},
            after_state={"alias_node_id": alias_node_id, "aliased_id": node_id},
            description=f"Added alias {alias_node_id} to node {node_id}",
        )
    except (ValueError, TypeError, LookupError):
        pass

    # Return updated target node with aliases
    alias_ids = await service.get_alias_ids(node_id)
    response = _node_to_response(node, aliases=alias_ids)
    await _enrich_node_responses_uuids(response, repo, property_repo)
    return response


@router.delete("/{node_uuid}/aliases/{alias_uuid}", dependencies=[Depends(require_write_scope)])
async def remove_alias(
    node_id: int = Depends(resolve_node_uuid),
    alias_id: int = Depends(resolve_alias_uuid),
    user: User = Depends(get_current_user),
):
    """Remove an alias from a node (clears aliased_id on the alias node)."""
    service = await _get_node_service(user)

    alias_node = await service.get_node_by_id(alias_id)
    if not alias_node:
        raise HTTPException(404, "Alias node not found")
    before_aliased_id = alias_node.aliased_id

    try:
        await service.remove_alias_atomic(node_id, alias_id)
    except NodeNotFoundError as e:
        raise HTTPException(404, str(e)) from e

    # Record for undo
    try:
        undo = await _get_undo_service(user)
        await undo.record(
            "remove_alias",
            "node",
            node_id,
            before_state={"alias_node_id": alias_id, "aliased_id": before_aliased_id},
            after_state={"alias_node_id": alias_id, "aliased_id": None},
            description=f"Removed alias from node {node_id}",
        )
    except (ValueError, TypeError, LookupError):
        pass

    return {"removed": True}


@router.post("/rebuild-links", dependencies=[Depends(require_write_scope)])
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
    service = await _get_node_service(user)

    try:
        return await service.rebuild_all_links()
    except Exception as e:
        from app.logging_config import get_logger

        logger = get_logger(__name__)
        logger.error(f"[REBUILD_LINKS] Fatal error: {e}", exc_info=True)
        raise HTTPException(500, f"Failed to rebuild links: {str(e)}") from e


@router.post("/fix-raw-uuid-links", dependencies=[Depends(require_write_scope)])
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
    service = await _get_node_service(user)

    try:
        return await service.fix_raw_uuid_links()
    except Exception as e:
        from app.logging_config import get_logger

        logger = get_logger(__name__)
        logger.error(f"[FIX_RAW_UUID_LINKS] Fatal error: {e}", exc_info=True)
        raise HTTPException(500, f"Failed to fix raw UUID links: {str(e)}") from e


@router.post("/fix-links-for-uuid/{target_uuid}", dependencies=[Depends(require_write_scope)])
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
    service = await _get_node_service(user)

    try:
        return await service.fix_links_for_uuid(target_uuid)
    except NodeValidationError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        from app.logging_config import get_logger

        logger = get_logger(__name__)
        logger.error(f"[FIX_LINKS_FOR_UUID] Fatal error: {e}", exc_info=True)
        raise HTTPException(500, f"Failed to fix links for UUID: {str(e)}") from e


# ==================== UNLINKED MENTIONS ENDPOINTS ====================


@router.get("/{node_uuid}/mentions")
async def get_unlinked_mentions(
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
):
    """Get unlinked mention candidates for a node."""
    service = await _get_node_service(user)
    rows = await service.list_unlinked_mentions(node_id)
    return {
        "mentions": [
            MentionResponse(
                id=row["id"],
                uuid=str(row["uuid"]),
                source_node_id=row["source_id"],
                source_node_uuid=str(row["source_uuid"]),
                source_node_name=LinkParsingService._node_name_to_text(row["source_name"]),
                source_is_page=bool(row["source_is_page"]),
                target_id=row["target_id"],
                match_text=row["match_text"],
                position=row["position"] or 0,
                is_ignored=bool(row["is_ignored"]),
            )
            for row in rows
        ]
    }


@router.post("/{node_uuid}/mentions/{mention_uuid}/promote", dependencies=[Depends(require_write_scope)])
async def promote_mention(
    node_id: int = Depends(resolve_node_uuid),
    mention_id: int = Depends(resolve_mention_uuid),
    user: User = Depends(get_current_user),
):
    """Promote an unlinked mention to a real [[node link]]."""
    service = await _get_node_service(user)
    try:
        updated = await service.promote_mention(mention_id)
    except NodeNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except NodeValidationError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    if not updated:
        raise HTTPException(status_code=404, detail="Mention not found")

    return {"success": True, "source_node_id": updated.id}


@router.post("/{node_uuid}/mentions/{mention_uuid}/ignore", dependencies=[Depends(require_write_scope)])
async def ignore_mention(
    node_id: int = Depends(resolve_node_uuid),
    mention_id: int = Depends(resolve_mention_uuid),
    user: User = Depends(get_current_user),
):
    """Ignore an unlinked mention candidate."""
    service = await _get_node_service(user)
    result = await service.ignore_mention(mention_id)
    if not result:
        raise HTTPException(status_code=404, detail="Mention not found")
    return {"success": True, "is_ignored": True}


@router.post("/{node_uuid}/mentions/{mention_uuid}/unignore", dependencies=[Depends(require_write_scope)])
async def unignore_mention(
    node_id: int = Depends(resolve_node_uuid),
    mention_id: int = Depends(resolve_mention_uuid),
    user: User = Depends(get_current_user),
):
    """Restore a previously ignored mention candidate."""
    service = await _get_node_service(user)
    result = await service.unignore_mention(mention_id)
    if not result:
        raise HTTPException(status_code=404, detail="Mention not found")
    return {"success": True, "is_ignored": False}
