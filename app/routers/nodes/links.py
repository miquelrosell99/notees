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
    PropertyRequest,
    BacklinkResponse,
    LinkedReferenceResponse,
    BreadcrumbSegment,
    InlineTypeResponse,
    PropertyBacklinkResponse,
)
from .helpers import (
    _get_node_service,
    _node_to_response,
    _get_descendants,
    _build_children_response,
)


router = APIRouter()


@router.get("/{node_id}/text-links")
async def get_text_links(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Get all text links from a node with is_tag info.
    
    Returns list of links parsed from [[id]] patterns in the node's content,
    including whether each link is a tag (displayed with #) or a regular link.
    """
    service = await _get_node_service(user)
    async with service._pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT id, source_node_id, target_node_id, is_tag, position
            FROM node_link
            WHERE source_node_id = $1 AND property_id IS NULL
            ORDER BY position
        """, node_id)
    
    return {
        "links": [
            NodeLinkResponse(
                id=row['id'],
                source_node_id=row['source_node_id'],
                target_node_id=row['target_node_id'],
                is_tag=row['is_tag'],
                position=row['position'],
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
            "SELECT id FROM node WHERE id = $1 AND workspace_id = $2",
            node_id, service._workspace_id
        )
        if not row:
            raise HTTPException(404, "Source node not found")
        
        # Verify target node exists and is a page
        target_row = await conn.fetchrow(
            "SELECT id, is_page, parent_id FROM node WHERE id = $1 AND workspace_id = $2",
            request.target_node_id, service._workspace_id
        )
        if not target_row:
            raise HTTPException(404, "Target node not found")
        if not target_row['is_page'] and target_row['parent_id'] is not None:
            raise HTTPException(400, "Tags can only point to pages")
        
        # Check if link already exists
        row = await conn.fetchrow("""
            SELECT id FROM node_link 
            WHERE source_node_id = $1 AND target_node_id = $2 AND property_id IS NULL AND workspace_id = $3
        """, node_id, request.target_node_id, service._workspace_id)
        
        now = datetime.now(timezone.utc)
        
        if row:
            # Update existing link to be a tag
            await conn.execute(
                "UPDATE node_link SET is_tag = TRUE WHERE id = $1",
                row['id']
            )
            return NodeLinkResponse(
                id=row['id'],
                source_node_id=node_id,
                target_node_id=request.target_node_id,
                is_tag=True,
                position=0,
            )
        else:
            # Create new tag link
            new_row = await conn.fetchrow("""
                INSERT INTO node_link (source_node_id, target_node_id, position, property_id, is_tag, created_at)
                VALUES ($1, $2, 0, NULL, TRUE, $3)
                RETURNING id
            """, node_id, request.target_node_id, now)
            return NodeLinkResponse(
                id=new_row['id'],
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
            WHERE source_node_id = $1 AND target_node_id = $2 AND property_id IS NULL AND is_tag = TRUE AND workspace_id = $3
        """, node_id, target_id, service._workspace_id)
    
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
    
    result = []
    for link in backlinks:
        source = await service._node_repo.get_by_id(link.source_node_id)
        if not source:
            continue
        
        # Get all descendants of the source node recursively
        children = await _get_descendants(service._node_repo, source.id) if source.id else []
        
        source_page = None
        if source.page_id:
            source_page = await service._node_repo.get_by_id(source.page_id)
        
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
        
        # Convert source node to response with children
        source_response = _node_to_response(source)
        source_response.children = _build_children_response(children) if children else []
        
        result.append(LinkedReferenceResponse(
            source_node=source_response,
            source_page=_node_to_response(source_page) if source_page else None,
            link_type="property" if link.property_id else "text",
            context=context,
            breadcrumb_path=breadcrumb_segments,
        ))
    
    return {"linked_references": result}


@router.get("/{node_id}/inline-types")
async def get_inline_types(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Get inline type references for a node.
    
    Returns all {{typeId}} references in the node's content.
    """
    service = await _get_node_service(user)
    
    inline_types = await service._link_service.get_inline_types_for_node(node_id)
    
    result = []
    for inline_type in inline_types:
        type_node = await service._node_repo.get_by_id(inline_type.type_node_id)
        if not type_node:
            continue
        
        result.append(InlineTypeResponse(
            type_node_id=inline_type.type_node_id,
            type_node_name=type_node.name or "",
            type_node_icon=type_node.icon,
            position=inline_type.position,
        ))
    
    return {"inline_types": result}


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
            
            result.append(PropertyBacklinkResponse(
                source_page=_node_to_response(page),
                property_id=row['property_id'],
                property_name=row['property_name'],
            ))
    
    # Also check for node-type properties pointing to this node
    pool = service._node_repo.get_connection()
    rows = await pool.fetch("""
        SELECT DISTINCT pvr.node_id, pvr.property_id, p.name as property_name
        FROM property_value_relation pvr
        JOIN property p ON pvr.property_id = p.id
        WHERE pvr.target_node_id = $1 AND p.type = 'node'
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
        
        result.append(PropertyBacklinkResponse(
            source_page=_node_to_response(page),
            property_id=row['property_id'],
            property_name=row['property_name'],
        ))
    
    return {"property_backlinks": result}
