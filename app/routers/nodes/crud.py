"""CRUD operations for nodes."""
from typing import Optional, List, Dict

from fastapi import APIRouter, HTTPException, Depends

from ...domain.entities import NodeCreateData, NodeUpdateData
from ...db.schema import SYSTEM_TYPE_UUIDS
from ...db.connection import get_workspace_assets_dir
from ..auth import get_current_user
from ...models import User
from ...logging_config import get_logger
from .models import (
    NodeResponse,
    NodeCreateRequest,
    NodeUpdateRequest,
    MoveNodeRequest,
    BreadcrumbSegment,
    BacklinkResponse,
    LinkedReferenceResponse,
)
from .helpers import (
    _get_node_service,
    _node_to_response,
    _get_type_ids,
    _get_tag_ids,
    _get_tag_ids_batch,
    _get_type_ids_batch,
    logger,
)


router = APIRouter()


@router.post("/", name="create_node")
async def create_node(
    request: NodeCreateRequest,
    user: User = Depends(get_current_user),
):
    """Create a new node."""
    service = await _get_node_service(user)
    
    # Handle date nodes with special UUIDs
    # The repository will use generate_uuid() by default,
    # but for date nodes we override
    types = list(request.types)
    
    # TODO: Look up date type IDs and add them
    # For now, dates are handled by types parameter from client
    
    data = NodeCreateData(
        name=request.name,
        icon=request.icon,
        color=request.color,
        parent_id=request.parent_id,
        sequence=request.sequence,
        types=types,
        property_values=request.properties,
        is_page=request.is_page,
        is_type=request.is_type,
    )
    
    node = await service.create_node(data, user_id=None)  # TODO: user_id from JWT
    return _node_to_response(node, types=types)


@router.post("/page")
async def create_page(
    name: str,
    icon: Optional[str] = None,
    color: Optional[str] = None,
    additional_types: List[int] = [],
    user: User = Depends(get_current_user),
):
    """Create a new page (convenience endpoint)."""
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
    
    async with service._pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT id, uuid, name, icon, color, parent_id, page_id, 
                   is_page, is_type, is_day, is_month, is_year,
                   create_date, write_date, open_date
            FROM node 
            WHERE is_page = TRUE AND active = TRUE AND open_date IS NOT NULL AND graph_id = $1
            ORDER BY open_date DESC
            LIMIT $2
        """, service._graph_id, limit)
    
    nodes = []
    for row in rows:
        nodes.append({
            "id": row['id'],
            "uuid": str(row['uuid']),
            "name": row['name'],
            "icon": row['icon'],
            "color": row['color'],
            "parent_id": row['parent_id'],
            "page_id": row['page_id'],
            "is_page": row['is_page'],
            "is_type": row['is_type'],
            "is_daily": row['is_day'],
            "is_monthly": row['is_month'],
            "is_yearly": row['is_year'],
            "create_date": row['create_date'].isoformat() if row['create_date'] else None,
            "write_date": row['write_date'].isoformat() if row['write_date'] else None,
            "open_date": row['open_date'].isoformat() if row['open_date'] else None,
        })
    
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
        types = await service.get_node_types(page.id)
        result.append(_node_to_response(page, types=[t.id for t in types if t.id]))
    
    return {"pages": result}


@router.get("/{node_id}")
async def get_node(
    node_id: int,
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
    type_ids = await _get_type_ids(service, node_id)
    
    # Get tags for the node (from node_link with is_tag=1)
    tag_ids = await _get_tag_ids(service._pool, service._graph_id or 0, node_id)
    
    # Auto-fix legacy date nodes that don't have their date type assigned
    if node.is_day or node.is_month or node.is_year:
        page_type_id = service._page_type_id
        
        # Ensure page type is assigned
        if page_type_id and page_type_id not in type_ids:
            await service.add_type(node_id, page_type_id, _system_call=True)
            type_ids.append(page_type_id)
        
        # Ensure date-specific type is assigned
        if node.is_day:
            day_type = await service._node_repo.get_by_uuid(SYSTEM_TYPE_UUIDS["day"])
            if day_type and day_type.id and day_type.id not in type_ids:
                await service.add_type(node_id, day_type.id, _system_call=True)
                type_ids.append(day_type.id)
        elif node.is_month:
            month_type = await service._node_repo.get_by_uuid(SYSTEM_TYPE_UUIDS["month"])
            if month_type and month_type.id and month_type.id not in type_ids:
                await service.add_type(node_id, month_type.id, _system_call=True)
                type_ids.append(month_type.id)
        elif node.is_year:
            year_type = await service._node_repo.get_by_uuid(SYSTEM_TYPE_UUIDS["year"])
            if year_type and year_type.id and year_type.id not in type_ids:
                await service.add_type(node_id, year_type.id, _system_call=True)
                type_ids.append(year_type.id)
    
    response = _node_to_response(node, tags=tag_ids, types=type_ids)
    
    if include_children:
        pool = service._node_repo.get_connection()
        
        # Get ALL descendants recursively using a CTE based on parent_id
        rows = await pool.fetch("""
            WITH RECURSIVE descendants AS (
                -- Base case: direct children of the target node
                SELECT * FROM node WHERE parent_id = $1
                UNION ALL
                -- Recursive case: children of descendants
                SELECT n.* FROM node n
                INNER JOIN descendants d ON n.parent_id = d.id
            )
            SELECT * FROM descendants ORDER BY sequence
        """, node_id)
        all_descendants = [service._node_repo.row_to_node(row) for row in rows]
        
        # Get all descendant IDs
        descendant_ids = [d.id for d in all_descendants if d.id is not None]
        
        # Get comment counts for all descendants in one query
        comment_counts: Dict[int, int] = {}
        if descendant_ids:
            rows = await pool.fetch("""
                SELECT node_id, COUNT(*) as count 
                FROM node_comment 
                WHERE node_id = ANY($1)
                GROUP BY node_id
            """, descendant_ids)
            for row in rows:
                comment_counts[row['node_id']] = row['count']
        
        # Get backlink counts for all descendants in one query
        backlink_counts: Dict[int, int] = {}
        if descendant_ids:
            rows = await pool.fetch("""
                SELECT target_id, COUNT(*) as count 
                FROM node_link 
                WHERE target_id = ANY($1)
                GROUP BY target_id
            """, descendant_ids)
            for row in rows:
                backlink_counts[row['target_id']] = row['count']
        
        # Get types for all descendants in one batch (avoid N+1 queries)
        node_type_map: Dict[int, List[int]] = {nid: [] for nid in descendant_ids}
        
        if descendant_ids:
            rows = await pool.fetch("""
                SELECT pvr.node_id, pvr.target_id
                FROM property_value_relation pvr
                JOIN property p ON pvr.property_id = p.id
                WHERE p.name = 'types' AND pvr.node_id = ANY($1)
                ORDER BY pvr.node_id, pvr."order"
            """, descendant_ids)
            for row in rows:
                nid = row['node_id']
                tid = row['target_id']
                if nid in node_type_map and tid:
                    node_type_map[nid].append(tid)
        
        # Build tree structure from flat list using parent_id
        node_map: Dict[int, NodeResponse] = {}
        for d in all_descendants:
            if d.id is not None:
                count = comment_counts.get(d.id, 0)
                bcount = backlink_counts.get(d.id, 0)
                d_type_ids = node_type_map.get(d.id, [])
                node_map[d.id] = _node_to_response(d, types=d_type_ids, comment_count=count, backlink_count=bcount)
        
        root_children = []
        
        for d in all_descendants:
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

    if include_backlinks:
        backlink_infos = await service._link_service.get_backlinks(node_id)
        response.backlinks = []
        for info in backlink_infos:
            # Convert breadcrumb tuples to BreadcrumbSegment objects
            breadcrumb_segments = [
                BreadcrumbSegment(
                    node_id=seg[0],
                    name=seg[1],
                    is_property=seg[2] if len(seg) > 2 else False
                )
                for seg in info.breadcrumb_path
            ]
            
            response.backlinks.append(BacklinkResponse(
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
            ))
    
    if include_properties:
        response.properties = {}
        all_prop_values = await service._property_repo.get_all_property_values(node_id)
        for prop_id, prop_data in all_prop_values.items():
            prop = prop_data['property']
            values = prop_data['values']
            if values:
                # Extract the actual value based on property type
                val = values[0]  # Get first value
                if hasattr(val, 'target_node_id'):
                    # Relation type
                    response.properties[prop.name] = val.target_node_id
                elif hasattr(val, 'value_integer'):
                    # Scalar type
                    response.properties[prop.name] = (
                        val.value_integer or val.value_float or 
                        val.value_text or val.value_boolean
                    )
                elif hasattr(val, 'selection_line_id'):
                    # Selection type
                    response.properties[prop.name] = val.selection_line_id
    
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
        children = await service._node_repo.get_children(node.id)
        response.children = [_node_to_response(c) for c in children]
    
    if include_backlinks and node.id:
        backlink_infos = await service._link_service.get_backlinks(node.id)
        response.backlinks = []
        for info in backlink_infos:
            breadcrumb_segments = [
                BreadcrumbSegment(
                    node_id=seg[0],
                    name=seg[1],
                    is_property=seg[2] if len(seg) > 2 else False
                )
                for seg in info.breadcrumb_path
            ]
            
            response.backlinks.append(BacklinkResponse(
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
            ))
    
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
    properties = content["properties"]
    backlinks = content["backlinks"]
    
    # Get connection early to avoid unbound variable
    pool = service._node_repo.get_connection()
    
    # Get comment counts for all blocks
    block_ids = [b.id for b in blocks if b.id is not None]
    comment_counts = {}
    if block_ids:
        # Query comment counts for all blocks in one go
        rows = await pool.fetch("""
            SELECT node_id, COUNT(*) as count 
            FROM node_comment 
            WHERE node_id = ANY($1)
            GROUP BY node_id
        """, block_ids)
        for row in rows:
            comment_counts[row['node_id']] = row['count']
    
    # Get backlink counts for all blocks
    backlink_counts: Dict[int, int] = {}
    if block_ids:
        rows = await pool.fetch("""
            SELECT target_id, COUNT(*) as count 
            FROM node_link 
            WHERE target_id = ANY($1)
            GROUP BY target_id
        """, block_ids)
        for row in rows:
            backlink_counts[row['target_id']] = row['count']
    
    # Get types for all blocks in one batch (avoid N+1 queries)
    all_node_ids = [page_id] + block_ids
    node_type_map: Dict[int, List[int]] = {nid: [] for nid in all_node_ids}
    
    if all_node_ids:
        rows = await pool.fetch("""
            SELECT pvr.node_id, pvr.target_id
            FROM property_value_relation pvr
            JOIN property p ON pvr.property_id = p.id
            WHERE p.name = 'types' AND pvr.node_id = ANY($1)
            ORDER BY pvr.node_id, pvr."order"
        """, all_node_ids)
        for row in rows:
            node_id = row['node_id']
            type_id = row['target_id']
            if node_id in node_type_map and type_id:
                node_type_map[node_id].append(type_id)
    
    # Get tags for all nodes in one batch (from node_link with is_tag=1)
    node_tag_map = await _get_tag_ids_batch(pool, service._graph_id or 0, all_node_ids)
    
    # Build tree structure from flat list
    block_map = {}
    for b in blocks:
        if b.id != page_id and b.id is not None:
            count = comment_counts.get(b.id, 0)
            bcount = backlink_counts.get(b.id, 0)
            type_ids = node_type_map.get(b.id, [])
            tag_ids = node_tag_map.get(b.id, [])
            block_map[b.id] = _node_to_response(b, tags=tag_ids, types=type_ids, comment_count=count, backlink_count=bcount)
    
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
    
    page_comment_count = comment_counts.get(page_id, 0)
    page_type_ids = node_type_map.get(page_id, [])
    page_tag_ids = node_tag_map.get(page_id, [])
    page_response = _node_to_response(page, tags=page_tag_ids, types=page_type_ids, comment_count=page_comment_count)
    page_response.children = root_children
    
    # Add properties - get the full property values
    page_response.properties = {}
    all_prop_values = await service._property_repo.get_all_property_values(page_id)
    logger.info(f"Page {page_id} properties: {list(all_prop_values.keys())}")
    for prop_id, prop_data in all_prop_values.items():
        prop = prop_data['property']
        values = prop_data['values']
        logger.info(f"  Property {prop.name} (id={prop_id}): {len(values)} values")
        if values:
            # Extract the actual value based on property type
            val = values[0]  # Get first value
            if hasattr(val, 'target_node_id'):
                # Relation type
                logger.info(f"    -> target_node_id={val.target_node_id}")
                page_response.properties[prop.name] = val.target_node_id
            elif hasattr(val, 'value_integer'):
                # Scalar type
                page_response.properties[prop.name] = (
                    val.value_integer or val.value_float or 
                    val.value_text or val.value_boolean
                )
            elif hasattr(val, 'selection_line_id'):
                # Selection type
                page_response.properties[prop.name] = val.selection_line_id
    
    # Add backlinks with context
    page_response.linked_references = []
    for link in backlinks:
        source = await service._node_repo.get_by_id(link.source_node_id)
        if not source:
            continue
        
        source_page = None
        if source.page_id:
            source_page = await service._node_repo.get_by_id(source.page_id)
        
        # Extract context around the link
        context = source.name
        if link.position > 0 and len(context) > 100:
            start = max(0, link.position - 50)
            end = min(len(context), link.position + 50)
            context = "..." + context[start:end] + "..."
        
        page_response.linked_references.append(LinkedReferenceResponse(
            source_node=_node_to_response(source),
            source_page=_node_to_response(source_page) if source_page else None,
            link_type="property" if link.property_id else "text",
            context=context,
        ))
    
    return page_response


@router.put("/{node_id}")
async def update_node(
    node_id: int,
    request: NodeUpdateRequest,
    user: User = Depends(get_current_user),
):
    """Update a node."""
    service = await _get_node_service(user)
    
    data = NodeUpdateData(
        name=request.name,
        icon=request.icon,
        color=request.color,
        # Set clear flags when field was explicitly provided as None
        clear_icon='icon' in request.model_fields_set and request.icon is None,
        clear_color='color' in request.model_fields_set and request.color is None,
        parent_id=request.parent_id,
        sequence=request.sequence,
        collapsed=request.collapsed,
    )
    
    node = await service.update_node(node_id, data)
    if not node:
        raise HTTPException(404, "Node not found")
    
    return _node_to_response(node)


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
    
    node = await service.move_node(node_id, request.parent_id, position)
    if not node:
        raise HTTPException(404, "Node not found")
    
    return _node_to_response(node)


@router.delete("/{node_id}")
async def delete_node(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Delete a node and all its children.
    
    Also deletes any associated asset files (files named with the node's UUID).
    """
    service = await _get_node_service(user)
    
    # Get the node first to get its UUID for asset cleanup
    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    
    # Try to delete any associated asset file
    if node.uuid and service._graph_id is not None:
        assets_dir = get_workspace_assets_dir(service._graph_id)
        # Check for asset files with any extension
        for asset_file in assets_dir.glob(f"{node.uuid}.*"):
            try:
                asset_file.unlink()
                logger.info(f"Deleted asset file {asset_file} for node {node_id}")
            except Exception as e:
                logger.warning(f"Failed to delete asset file {asset_file}: {e}")
    
    success = await service.delete_node(node_id)
    if not success:
        raise HTTPException(404, "Node not found")
    
    return {"status": "ok"}


@router.post("/{node_id}/archive")
async def archive_node(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Archive a node (set active to false)."""
    service = await _get_node_service(user)
    
    node = await service.archive_node(node_id, None)  # user_id not used for now
    if not node:
        raise HTTPException(404, "Node not found")
    
    types = await service.get_node_types(node_id)
    return _node_to_response(node, types=[t.id for t in types if t.id])


@router.post("/{node_id}/unarchive")
async def unarchive_node(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Unarchive a node (set active to true)."""
    service = await _get_node_service(user)
    
    node = await service.unarchive_node(node_id, None)  # user_id not used for now
    if not node:
        raise HTTPException(404, "Node not found")
    
    types = await service.get_node_types(node_id)
    return _node_to_response(node, types=[t.id for t in types if t.id])


@router.patch("/{node_id}/open")
async def mark_page_opened(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Mark a page as opened/viewed (updates open_date).
    
    This should only be called for pages (is_page=1).
    The open_date is set to the current UTC time.
    """
    from datetime import datetime, timezone
    
    service = await _get_node_service(user)
    async with service._pool.acquire() as conn:
        # Verify it's a page and exists
        row = await conn.fetchrow(
            "SELECT id, is_page FROM node WHERE id = $1 AND active = TRUE AND graph_id = $2",
            node_id, service._graph_id
        )
        
        if not row:
            raise HTTPException(status_code=404, detail="Node not found")
        
        if not row['is_page']:
            raise HTTPException(status_code=400, detail="Only pages can have open_date updated")
        
        # Update open_date
        now = datetime.now(timezone.utc)
        await conn.execute(
            "UPDATE node SET open_date = $1 WHERE id = $2",
            now, node_id
        )
    
    return {"status": "ok", "open_date": now.isoformat()}
