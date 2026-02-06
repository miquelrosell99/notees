"""Backlinks, linked references, tag links, and property endpoints."""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends

from ...db.schema import parse_date_uuid
from ..auth import get_current_user
from ...models import User
from .models import (
    NodeLinkResponse,
    TagLinkRequest,
    UpdateLinkNameRequest,
    PropertyRequest,
    BacklinkResponse,
    LinkedReferenceResponse,
    BreadcrumbSegment,
    InlineClassResponse,
    PropertyBacklinkResponse,
)
from .helpers import (
    _get_node_service,
    _node_to_response,
    _get_descendants,
    _build_children_response,
    _get_class_ids_batch,
    extract_properties_dict,
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
    async with service._pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT id, uuid, source_id, target_id, is_tag, position, name
            FROM node_link
            WHERE source_id = $1 AND property_id IS NULL
            ORDER BY position
        """, node_id)
    
    return {
        "links": [
            NodeLinkResponse(
                id=row['id'],
                uuid=str(row['uuid']),
                source_node_id=row['source_id'],
                target_node_id=row['target_id'],
                is_tag=row['is_tag'],
                position=row['position'],
                name=row['name'],
            )
            for row in rows
        ]
    }


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
    async with service._pool.acquire() as conn:
        # Verify source node exists
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE id = $1 AND graph_id = $2",
            node_id, service._graph_id
        )
        if not row:
            raise HTTPException(404, "Source node not found")
        
        # Verify target node exists and is a page
        target_row = await conn.fetchrow(
            "SELECT id, is_page, parent_id FROM node WHERE id = $1 AND graph_id = $2",
            request.target_node_id, service._graph_id
        )
        if not target_row:
            raise HTTPException(404, "Target node not found")
        if not target_row['is_page'] and target_row['parent_id'] is not None:
            raise HTTPException(400, "Tags can only point to pages")
        
        # Check if link already exists
        row = await conn.fetchrow("""
            SELECT id, uuid FROM node_link 
            WHERE source_id = $1 AND target_id = $2 AND property_id IS NULL AND graph_id = $3
        """, node_id, request.target_node_id, service._graph_id)
        
        now = datetime.now(timezone.utc)
        
        if row:
            # Update existing link to be a tag
            await conn.execute(
                "UPDATE node_link SET is_tag = TRUE WHERE id = $1",
                row['id']
            )
            return NodeLinkResponse(
                id=row['id'],
                uuid=str(row['uuid']),
                source_node_id=node_id,
                target_node_id=request.target_node_id,
                is_tag=True,
                position=0,
            )
        else:
            # Create new tag link
            new_row = await conn.fetchrow("""
                INSERT INTO node_link (source_id, target_id, position, property_id, is_tag, create_date, graph_id)
                VALUES ($1, $2, 0, NULL, TRUE, $3, $4)
                RETURNING id, uuid
            """, node_id, request.target_node_id, now, service._graph_id)
            return NodeLinkResponse(
                id=new_row['id'],
                uuid=str(new_row['uuid']),
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
    async with service._pool.acquire() as conn:
        result = await conn.execute("""
            UPDATE node_link SET is_tag = FALSE 
            WHERE source_id = $1 AND target_id = $2 AND property_id IS NULL AND is_tag = TRUE AND graph_id = $3
        """, node_id, target_id, service._graph_id)
    
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
    prop = await service._property_repo.get_by_id(request.property_id)
    if not prop:
        raise HTTPException(404, "Property not found")
    
    # Set value based on property type
    from ...domain.entities import SCALAR_TYPES, RELATION_TYPES, PropertyType
    if prop.type in SCALAR_TYPES:
        await service._property_repo.set_scalar_value(
            node_id, request.property_id, request.value
        )
    elif prop.type in RELATION_TYPES:
        # For relation types, value should be a target_node_id
        await service._property_repo.set_relation_value(
            node_id, request.property_id, request.value
        )
    elif prop.type == PropertyType.SELECTION:
        # For selection types, value should be a selection_line_id
        await service._property_repo.set_selection_value(
            node_id, request.property_id, request.value
        )
    
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
    
    await service._property_repo.remove_property_from_node(node_id, property_id)
    
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
    backlinks = await service._link_service.get_backlinks(node_id)
    
    result = []
    for link in backlinks:
        source = await service._node_repo.get_by_id(link.source_node_id)
        source_page = None
        if source and source.page_id:
            source_page = await service._node_repo.get_by_id(source.page_id)
        
        result.append(BacklinkResponse(
            source_node_id=link.source_node_id,
            source_node_uuid=str(source.uuid) if source and source.uuid else "",
            source_node_name=source.name if source else "",
            source_page_id=source.page_id if source else None,
            source_page_name=source_page.name if source_page else None,
            link_type="property" if link.property_id else "text",
            position=link.link.position if link.link else 0,
        ))
    
    return {"backlinks": result}


@router.get("/{node_id}/linked-references")
async def get_linked_references(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Get linked references to a node with context, including children hierarchy."""
    service = await _get_node_service(user)
    
    backlinks = await service._link_service.get_backlinks(node_id)
    
    # Collect all source node IDs for batch type fetching
    source_node_ids = []
    sources_data = []  # Store (source, children, source_page, link) tuples
    
    for link in backlinks:
        source = await service._node_repo.get_by_id(link.source_node_id)
        if not source:
            continue
        
        # Get all descendants of the source node recursively
        children = await _get_descendants(service._node_repo, source.id) if source.id else []
        
        source_page = None
        if source.page_id:
            source_page = await service._node_repo.get_by_id(source.page_id)
        
        if source.id:
            source_node_ids.append(source.id)
        sources_data.append((source, children, source_page, link))
    
    # Batch fetch class_ids for all source nodes
    class_ids_map = await _get_class_ids_batch(service._pool, service._graph_id or 0, source_node_ids)
    
    # Batch fetch properties for all source nodes
    node_properties_map = {}
    if source_node_ids:
        for nid in source_node_ids:
            all_prop_values = await service._property_repo.get_all_property_values(nid)
            node_properties_map[nid] = extract_properties_dict(all_prop_values)
    
    result = []
    for source, children, source_page, link in sources_data:
        # Extract context around the link
        context = source.name or ""
        # Use position from the inner NodeLink object
        position = link.link.position if link.link else 0
        if position > 0 and len(context) > 100:
            start = max(0, position - 50)
            end = min(len(context), position + 50)
            context = "..." + context[start:end] + "..."
        
        # Convert breadcrumb path from link service
        breadcrumb_segments = [
            BreadcrumbSegment(
                node_id=seg[0],
                name=seg[1],
                is_property=seg[2] if len(seg) > 2 else False
            )
            for seg in link.breadcrumb_path
        ] if hasattr(link, 'breadcrumb_path') and link.breadcrumb_path else []
        
        # Convert source node to response with children and classes
        source_classes = class_ids_map.get(source.id, []) if source.id else []
        source_response = _node_to_response(source, classes=source_classes)
        source_response.children = _build_children_response(children) if children else []
        
        # Add properties if they were loaded
        if source.id and source.id in node_properties_map:
            source_response.properties = node_properties_map[source.id]
        
        result.append(LinkedReferenceResponse(
            source_node=source_response,
            source_page=_node_to_response(source_page) if source_page else None,
            link_type="property" if link.property_id else "text",
            context=context,
            breadcrumb_path=breadcrumb_segments,
            property_id=link.property_id,
            property_name=link.property_name,
        ))
    
    return {"linked_references": result}


@router.get("/{node_id}/inline-classes")
async def get_inline_classes(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Get inline class references for a node.
    
    Returns all {{classId}} references in the node's content.
    """
    service = await _get_node_service(user)
    
    inline_classes = await service._link_service.get_inline_classes_for_node(node_id)
    
    result = []
    for inline_class in inline_classes:
        class_node = await service._node_repo.get_by_id(inline_class.class_node_id)
        if not class_node:
            continue
        
        result.append(InlineClassResponse(
            class_node_id=inline_class.class_node_id,
            class_node_name=class_node.name or "",
            class_node_icon=class_node.icon,
            position=inline_class.position,
            # Backwards compatibility fields
            type_node_id=inline_class.class_node_id,
            type_node_name=class_node.name or "",
            type_node_icon=class_node.icon,
        ))
    
    return {"inline_classes": result}


# Backwards compatibility alias
@router.get("/{node_id}/inline-types")
async def get_inline_types(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Get inline type references for a node (backwards compatibility).
    
    Returns all {{classId}} references in the node's content.
    """
    response = await get_inline_classes(node_id, user)
    # Return in old format
    return {"inline_types": response["inline_classes"]}


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
    target = await service._node_repo.get_by_id(node_id)
    if not target:
        raise HTTPException(status_code=404, detail="Node not found")
    
    result = []
    page_ids = []  # Collect all page IDs for batch property fetching
    pages_data = []  # Store (page, property_id, property_name) tuples
    
    # Check if target is a day node (UUID format YYYYMMDD with non-zero day)
    date_info = parse_date_uuid(target.uuid)
    if date_info and date_info.get("type") == "day":
        # Get date string in YYYY-MM-DD format
        year = date_info["year"]
        month = date_info["month"]
        day = date_info["day"]
        date_str = f"{year:04d}-{month:02d}-{day:02d}"
        
        # Find all property values with this date
        pool = service._node_repo.get_connection()
        rows = await pool.fetch("""
            SELECT DISTINCT pvs.node_id, pvs.property_id, p.name as property_name
            FROM property_value_scalar pvs
            JOIN property p ON pvs.property_id = p.id
            WHERE pvs.value_text = $1 AND p.type = 'date'
        """, date_str)
        
        for row in rows:
            # Get the page for this node
            node = await service._node_repo.get_by_id(row['node_id'])
            if not node:
                continue
            
            # Get the page this node belongs to (or itself if it's a page)
            page = node
            if node.page_id:
                page = await service._node_repo.get_by_id(node.page_id)
                if not page:
                    page = node
            
            if page.id:
                page_ids.append(page.id)
                pages_data.append((page, row['property_id'], row['property_name']))
    
    # Also check for node-class properties pointing to this node
    # Classes are now in class_ids column, not a property
    pool = service._node_repo.get_connection()
    rows = await pool.fetch("""
        SELECT DISTINCT pvr.node_id, pvr.property_id, p.name as property_name
        FROM property_value_relation pvr
        JOIN property p ON pvr.property_id = p.id
        WHERE pvr.target_id = $1 AND p.type = 'node'
    """, node_id)
    
    for row in rows:
        node = await service._node_repo.get_by_id(row['node_id'])
        if not node:
            continue
        
        page = node
        if node.page_id:
            page = await service._node_repo.get_by_id(node.page_id)
            if not page:
                page = node
        
        if page.id:
            page_ids.append(page.id)
            pages_data.append((page, row['property_id'], row['property_name']))
    
    # Batch fetch properties for all pages
    node_properties_map = {}
    if page_ids:
        for page_id in page_ids:
            all_prop_values = await service._property_repo.get_all_property_values(page_id)
            node_properties_map[page_id] = extract_properties_dict(all_prop_values)
    
    # Build result with properties attached
    for page, property_id, property_name in pages_data:
        page_response = _node_to_response(page)
        
        # Add properties if they were loaded
        if page.id and page.id in node_properties_map:
            page_response.properties = node_properties_map[page.id]
        
        result.append(PropertyBacklinkResponse(
            source_page=page_response,
            property_id=property_id,
            property_name=property_name,
        ))
    
    return {"property_backlinks": result}


@router.patch("/link/name")
async def update_link_name(
    request: UpdateLinkNameRequest,
    user: User = Depends(get_current_user),
):
    """Update the custom display name for a link.
    
    Args:
        request: Contains link_uuid and name (None or empty to clear)
    
    Returns:
        Updated link response
    """
    service = await _get_node_service(user)
    async with service._pool.acquire() as conn:
        # Normalize empty string to None
        name_value = request.name if request.name and request.name.strip() else None
        
        # Update the link name
        row = await conn.fetchrow("""
            UPDATE node_link 
            SET name = $1
            WHERE uuid::text = $2 AND graph_id = $3
            RETURNING id, uuid, source_id, target_id, is_tag, position, name
        """, name_value, request.link_uuid, service._graph_id)
        
        if not row:
            raise HTTPException(404, "Link not found")
        
        return NodeLinkResponse(
            id=row['id'],
            uuid=str(row['uuid']),
            source_node_id=row['source_id'],
            target_node_id=row['target_id'],
            is_tag=row['is_tag'],
            position=row['position'],
            name=row['name'],
        )
