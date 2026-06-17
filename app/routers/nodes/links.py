"""Backlinks, linked references, tag links, alias, and property endpoints."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ...db.connection import get_transaction
from ...dependencies import get_current_user, get_property_repository
from ...domain.entities import BacklinkInfo
from ...domain.errors import NodeNotFoundError, NodeValidationError
from ...domain.repositories.interfaces import PropertyRepository
from ...domain.services.link_service import LinkParsingService
from ...models import User
from .helpers import (
    _build_children_response,
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
    MentionResponse,
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
    """Get all text links from a node.

    Returns list of links parsed from [[id]] or [[id:uuid]] patterns in the node's content.
    """
    service = await _get_node_service(user)
    links = await service.get_text_links(node_id)

    return {
        "links": [
            NodeLinkResponse(
                id=link.id,
                uuid=str(link.uuid) if link.uuid else "",
                source_node_id=link.source_id,
                target_node_id=link.target_id,
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
    grouped = await service.get_text_links_batch(node_ids)

    links_by_node: dict[str, list[NodeLinkResponse]] = {}
    for source_id, links in grouped.items():
        links_by_node[str(source_id)] = [
            NodeLinkResponse(
                id=link.id,
                uuid=str(link.uuid) if link.uuid else "",
                source_node_id=link.source_id,
                target_node_id=link.target_id,
                position=link.position or 0,
                name=link.name,
            )
            for link in links
        ]

    return {"links_by_node": links_by_node}


@router.post("/{node_id}/tag-links")
async def add_tag_link(
    node_id: int,
    request: TagLinkRequest,
    user: User = Depends(get_current_user),
):
    """Add a tag to a node.

    Stores the target page ID in the node's tag_ids array.
    """
    service = await _get_node_service(user)

    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    before_tag_ids = list(node.tag_ids)

    try:
        async with get_transaction():
            await service.add_tag_link(node_id, request.target_node_id)

            # Record for undo
            try:
                undo = await _get_undo_service(user)
                await undo.record(
                    "add_tag_link",
                    "node",
                    node_id,
                    before_state={"tag_ids": before_tag_ids},
                    after_state={"tag_ids": [*before_tag_ids, request.target_node_id]},
                    description=f"Added tag link to node {node_id}",
                )
            except (ValueError, TypeError, LookupError):
                pass
    except NodeNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except NodeValidationError as e:
        raise HTTPException(400, str(e)) from e

    return {"success": True}


@router.delete("/{node_id}/tag-links/{target_id}")
async def remove_tag_link(
    node_id: int,
    target_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a tag from a node."""
    service = await _get_node_service(user)

    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    before_tag_ids = list(node.tag_ids)

    async with get_transaction():
        removed = await service.remove_tag_link(node_id, target_id)
        if not removed:
            raise HTTPException(404, "Tag link not found")

        # Record for undo
        try:
            undo = await _get_undo_service(user)
            await undo.record(
                "remove_tag_link",
                "node",
                node_id,
                before_state={"tag_ids": before_tag_ids},
                after_state={"tag_ids": [tid for tid in before_tag_ids if tid != target_id]},
                description=f"Removed tag link from node {node_id}",
            )
        except (ValueError, TypeError, LookupError):
            pass

    return {"removed": True}


@router.post("/{node_id}/properties")
async def set_property(
    node_id: int,
    request: PropertyRequest,
    user: User = Depends(get_current_user),
    property_repo: PropertyRepository = Depends(get_property_repository),
):
    """Set a property value on a node."""
    service = await _get_node_service(user)

    # Get property to determine its type
    prop = await property_repo.get_by_id(request.property_id)
    if not prop:
        raise HTTPException(404, "Property not found")

    from ...domain.entities import RELATION_TYPES, SCALAR_TYPES, PropertyType

    # Snapshot existing assignment and values before setting
    old_values: list[Any] = []
    had_assignment = False
    try:
        np = await property_repo.get_node_property(node_id, request.property_id)
        had_assignment = np is not None
        if prop.type in SCALAR_TYPES:
            old_values = [v.value for v in await property_repo.get_scalar_values(node_id, request.property_id)]
        elif prop.type in RELATION_TYPES:
            old_values = [v.target_id for v in await property_repo.get_relation_values(node_id, request.property_id)]
        elif prop.type == PropertyType.SELECTION:
            old_values = [v.selection_line_id for v in await property_repo.get_selection_values(node_id, request.property_id)]
    except LookupError:
        pass

    prop_type_str = prop.type.value if hasattr(prop.type, "value") else str(prop.type)

    async with get_transaction():
        # Set value based on property type
        if prop.type in SCALAR_TYPES:
            await property_repo.set_scalar_value(node_id, request.property_id, request.value)
        elif prop.type in RELATION_TYPES:
            # For relation types, value should be a target_node_id
            await property_repo.set_relation_value(node_id, request.property_id, request.value)
        elif prop.type == PropertyType.SELECTION:
            # For selection types, value should be a selection_line_id
            await property_repo.set_selection_value(node_id, request.property_id, request.value)

        # Record for undo
        try:
            undo = await _get_undo_service(user)
            await undo.record(
                "set_property",
                "node",
                node_id,
                before_state={
                    "property_id": request.property_id,
                    "property_type": prop_type_str,
                    "is_multi": prop.is_multi,
                    "had_assignment": had_assignment,
                    "values": old_values,
                },
                after_state={
                    "property_id": request.property_id,
                    "property_type": prop_type_str,
                    "is_multi": prop.is_multi,
                    "had_assignment": True,
                    "values": [request.value] if request.value is not None else [],
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
    property_repo: PropertyRepository = Depends(get_property_repository),
):
    """Remove a property value from a node."""
    service = await _get_node_service(user)

    # Snapshot existing property value before removal
    from ...domain.entities import RELATION_TYPES, SCALAR_TYPES, PropertyType

    old_values: list[Any] = []
    prop = None
    try:
        prop = await property_repo.get_by_id(property_id)
        if prop:
            if prop.type in SCALAR_TYPES:
                old_values = [v.value for v in await property_repo.get_scalar_values(node_id, property_id)]
            elif prop.type in RELATION_TYPES:
                old_values = [v.target_id for v in await property_repo.get_relation_values(node_id, property_id)]
            elif prop.type == PropertyType.SELECTION:
                old_values = [v.selection_line_id for v in await property_repo.get_selection_values(node_id, property_id)]
    except LookupError:
        pass

    prop_type_str = (
        prop.type.value
        if prop and hasattr(prop.type, "value")
        else str(prop.type)
        if prop
        else ""
    )

    async with get_transaction():
        await property_repo.remove_property_from_node(node_id, property_id)

        # Record for undo
        try:
            undo = await _get_undo_service(user)
            await undo.record(
                "remove_property",
                "node",
                node_id,
                before_state={
                    "property_id": property_id,
                    "property_type": prop_type_str,
                    "is_multi": prop.is_multi if prop else False,
                    "had_assignment": True,
                    "values": old_values,
                },
                after_state={"property_id": property_id, "property_type": prop_type_str, "removed": True},
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

        link_type = "property" if link.property_id else ("embed" if link.link and link.link.is_embed else "text")
        result.append(
            BacklinkResponse(
                source_node_id=link.source_node_id,
                source_node_uuid=str(source.uuid) if source and source.uuid else "",
                source_node_name=source.name if source else "",
                source_page_id=source.page_id if source else None,
                source_page_name=source_page.name if source_page else None,
                link_type=link_type,
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
    property_repo: PropertyRepository = Depends(get_property_repository),
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

        link_type = "property" if link.property_id else ("embed" if link.link and link.link.is_embed else "text")
        result.append(
            LinkedReferenceResponse(
                source_node=source_response,
                source_page=_node_to_response(source_page) if source_page else None,
                link_type=link_type,
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
    property_repo: PropertyRepository = Depends(get_property_repository),
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

    alias_ids = await service.get_alias_ids(node_id)

    # Fetch full node data for each alias (raw alias records, not resolved targets)
    aliases = []
    for alias_id in alias_ids:
        alias_node = await service.get_node_by_id(alias_id)
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

    alias_node = await service.get_node_by_id(request.alias_node_id)
    if not alias_node:
        raise HTTPException(404, "Alias node not found")
    before_aliased_id = alias_node.aliased_id

    async with get_transaction():
        try:
            await service.add_alias(node_id, request.alias_node_id)
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
                before_state={"alias_node_id": request.alias_node_id, "aliased_id": before_aliased_id},
                after_state={"alias_node_id": request.alias_node_id, "aliased_id": node_id},
                description=f"Added alias {request.alias_node_id} to node {node_id}",
            )
        except (ValueError, TypeError, LookupError):
            pass

    # Return updated target node with aliases
    node = await service.get_node_by_id(node_id)
    alias_ids = await service.get_alias_ids(node_id)
    return _node_to_response(node, aliases=alias_ids)


@router.delete("/{node_id}/aliases/{alias_id}")
async def remove_alias(
    node_id: int,
    alias_id: int,
    user: User = Depends(get_current_user),
):
    """Remove an alias from a node (clears aliased_id on the alias node)."""
    service = await _get_node_service(user)

    alias_node = await service.get_node_by_id(alias_id)
    if not alias_node:
        raise HTTPException(404, "Alias node not found")
    before_aliased_id = alias_node.aliased_id

    async with get_transaction():
        removed = await service.remove_alias(node_id, alias_id)
        if not removed:
            raise HTTPException(404, "Alias relationship not found")

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
    service = await _get_node_service(user)

    try:
        return await service.rebuild_all_links()
    except Exception as e:
        from ...logging_config import get_logger

        logger = get_logger(__name__)
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
    service = await _get_node_service(user)

    try:
        return await service.fix_raw_uuid_links()
    except Exception as e:
        from ...logging_config import get_logger

        logger = get_logger(__name__)
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
    service = await _get_node_service(user)

    try:
        return await service.fix_links_for_uuid(target_uuid)
    except NodeValidationError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        from ...logging_config import get_logger

        logger = get_logger(__name__)
        logger.error(f"[FIX_LINKS_FOR_UUID] Fatal error: {e}", exc_info=True)
        raise HTTPException(500, f"Failed to fix links for UUID: {str(e)}") from e


# ==================== UNLINKED MENTIONS ENDPOINTS ====================


@router.get("/{node_id}/mentions")
async def get_unlinked_mentions(
    node_id: int,
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


@router.post("/{node_id}/mentions/{mention_id}/promote")
async def promote_mention(
    node_id: int,
    mention_id: int,
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


@router.post("/{node_id}/mentions/{mention_id}/ignore")
async def ignore_mention(
    node_id: int,
    mention_id: int,
    user: User = Depends(get_current_user),
):
    """Ignore an unlinked mention candidate."""
    service = await _get_node_service(user)
    result = await service.ignore_mention(mention_id)
    if not result:
        raise HTTPException(status_code=404, detail="Mention not found")
    return {"success": True, "is_ignored": True}


@router.post("/{node_id}/mentions/{mention_id}/unignore")
async def unignore_mention(
    node_id: int,
    mention_id: int,
    user: User = Depends(get_current_user),
):
    """Restore a previously ignored mention candidate."""
    service = await _get_node_service(user)
    result = await service.unignore_mention(mention_id)
    if not result:
        raise HTTPException(status_code=404, detail="Mention not found")
    return {"success": True, "is_ignored": False}
