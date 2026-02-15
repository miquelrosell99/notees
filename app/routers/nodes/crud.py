"""CRUD operations for nodes."""
from typing import Optional, List, Dict

from fastapi import APIRouter, HTTPException, Depends, Path

from ...domain.entities import NodeCreateData, NodeUpdateData
from ...domain.errors import DatePageDeletionError, OptimisticLockError, DuplicateNodeError
from ...db.connection import acquire_connection, get_workspace_assets_dir, get_workspace_uuid
from ..auth import get_current_user
from ...models import User
from .models import (
    NodeResponse,
    NodeCreateRequest,
    NodeUpdateRequest,
    MoveNodeRequest,
    BreadcrumbSegment,
    BacklinkResponse,
    LinkedReferenceResponse,
    BatchNodeCreateRequest,
    BatchNodeCreateResponse,
    BatchNodeCreateResultItem,
    BatchNodeUpdateRequest,
    BatchNodeUpdateResponse,
    BatchNodeUpdateResultItem,
    BatchNodeDeleteRequest,
    BatchNodeDeleteResponse,
    BatchNodeDeleteResultItem,
    BatchPermanentDeleteRequest,
    BatchPermanentDeleteResponse,
    BatchPermanentDeleteResultItem,
)
from .helpers import (
    _get_node_service,
    _node_to_response,
    _get_class_ids,
    _get_tag_ids,
    _get_tag_ids_batch,
    _get_class_ids_batch,
    _get_alias_ids,
    extract_properties_dict,
)


router = APIRouter()


@router.post("/", name="create_node")
async def create_node(
    request: NodeCreateRequest,
    user: User = Depends(get_current_user),
):
    """Create a new node."""
    service = await _get_node_service(user)
    
    # Create node with provided classes
    # The repository will compute is_page, is_class, etc. from the classes
    data = NodeCreateData(
        name=request.name,
        icon=request.icon,
        color=request.color,
        parent_id=request.parent_id,
        sequence=request.sequence,
        classes=list(request.classes),
        property_values=request.properties,
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
        )
    return _node_to_response(node, classes=list(request.classes))


@router.post("/batch", name="batch_create_nodes")
async def batch_create_nodes(
    request: BatchNodeCreateRequest,
    user: User = Depends(get_current_user),
):
    """Create multiple nodes in a single batch.
    
    Accepts an array of node definitions and creates them sequentially.
    Each node is processed independently — a failure on one node does not
    prevent the others from being created.  Useful for Logseq / bulk imports.
    """
    from ...logging_config import get_logger
    logger = get_logger(__name__)
    
    service = await _get_node_service(user)
    
    # Build NodeCreateData list
    create_items = []
    for item in request.nodes:
        create_items.append(NodeCreateData(
            name=item.name,
            icon=item.icon,
            color=item.color,
            parent_id=item.parent_id,
            sequence=item.sequence,
            classes=list(item.classes),
            property_values=item.properties,
            uuid=item.uuid,
        ))
    
    raw_results = await service.batch_create_nodes(create_items, user_id=int(user.id))
    
    results = []
    created = 0
    failed = 0
    for i, r in enumerate(raw_results):
        if r["success"]:
            created += 1
            classes = list(request.nodes[i].classes)
            results.append(BatchNodeCreateResultItem(
                index=i,
                success=True,
                node=_node_to_response(r["node"], classes=classes),
            ))
        else:
            failed += 1
            results.append(BatchNodeCreateResultItem(
                index=i,
                success=False,
                error=r["error"],
            ))
    
    logger.info(f"[BATCH_CREATE] {created} created, {failed} failed out of {len(request.nodes)}")
    return BatchNodeCreateResponse(results=results, created=created, failed=failed)


@router.put("/batch", name="batch_update_nodes")
async def batch_update_nodes(
    request: BatchNodeUpdateRequest,
    user: User = Depends(get_current_user),
):
    """Update multiple nodes in a single batch.
    
    Each item identifies the node by `id` or `uuid` (at least one required).
    Failures on one node do not prevent others from being updated.
    Useful for Logseq / bulk imports where many blocks need content updates.
    """
    from ...logging_config import get_logger
    logger = get_logger(__name__)
    
    service = await _get_node_service(user)
    
    # Resolve node IDs and build update items
    update_items = []
    resolve_errors = []  # Track items that can't even be resolved
    
    for i, item in enumerate(request.nodes):
        node_id = item.id
        
        # If no id provided, try to resolve from uuid
        if node_id is None and item.uuid:
            resolved = await service._node_repo.get_by_uuid(item.uuid)
            if resolved:
                node_id = resolved.id
            else:
                resolve_errors.append((i, f"Node with uuid '{item.uuid}' not found"))
                continue
        elif node_id is None:
            resolve_errors.append((i, "Either 'id' or 'uuid' must be provided"))
            continue
        
        data = NodeUpdateData(
            name=item.name,
            icon=item.icon,
            color=item.color,
            # In batch mode, we don't clear icon/color unless they were explicitly set.
            # Pydantic defaults them to None which means "unchanged", not "clear".
            clear_icon=False,
            clear_color=False,
            parent_id=item.parent_id,
            sequence=item.sequence,
            collapsed=item.collapsed,
        )
        
        update_items.append({
            "node_id": node_id,
            "data": data,
            "expected_version": item.expected_version,
            "original_index": i,
        })
    
    # Execute batch update via service
    raw_results = await service.batch_update_nodes(update_items, user_id=int(user.id))
    
    # Build response, interleaving resolve errors and update results
    results = []
    updated = 0
    failed = 0
    
    # First add resolve errors
    for idx, error in resolve_errors:
        failed += 1
        results.append(BatchNodeUpdateResultItem(
            index=idx,
            success=False,
            error=error,
        ))
    
    # Then add update results
    for j, r in enumerate(raw_results):
        original_index = update_items[j]["original_index"]
        if r["success"]:
            updated += 1
            results.append(BatchNodeUpdateResultItem(
                index=original_index,
                success=True,
                node=_node_to_response(r["node"]),
            ))
        else:
            failed += 1
            results.append(BatchNodeUpdateResultItem(
                index=original_index,
                success=False,
                error=r["error"],
            ))
    
    # Sort by original index for consistent ordering
    results.sort(key=lambda r: r.index)
    
    logger.info(f"[BATCH_UPDATE] {updated} updated, {failed} failed out of {len(request.nodes)}")
    return BatchNodeUpdateResponse(results=results, updated=updated, failed=failed)


@router.delete("/batch", name="batch_delete_nodes")
async def batch_delete_nodes(
    request: BatchNodeDeleteRequest,
    user: User = Depends(get_current_user),
):
    """Delete multiple nodes by UUID in a single batch.
    
    Accepts an array of UUIDs and soft-deletes each node independently.
    A failure on one node does not prevent the others from being deleted.
    """
    from ...logging_config import get_logger
    logger = get_logger(__name__)
    
    service = await _get_node_service(user)
    raw_results = await service.batch_delete_nodes(request.uuids)
    
    results = []
    deleted = 0
    failed = 0
    for i, r in enumerate(raw_results):
        if r["success"]:
            deleted += 1
            results.append(BatchNodeDeleteResultItem(
                index=i,
                uuid=request.uuids[i],
                success=True,
            ))
        else:
            failed += 1
            results.append(BatchNodeDeleteResultItem(
                index=i,
                uuid=request.uuids[i],
                success=False,
                error=r["error"],
            ))
    
    logger.info(f"[BATCH_DELETE] {deleted} deleted, {failed} failed out of {len(request.uuids)}")
    return BatchNodeDeleteResponse(results=results, deleted=deleted, failed=failed)


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
    
    async with acquire_connection(service._pool) as conn:
        rows = await conn.fetch("""
            SELECT id, uuid, name, icon, color, parent_id, page_id, 
                   is_page, is_class, is_day, is_month, is_year,
                   create_date, write_date, open_date
            FROM node 
            WHERE is_page = true AND active = true AND (is_deleted = false OR is_deleted IS NULL) 
                  AND open_date IS NOT NULL AND workspace_id = $1
            ORDER BY open_date DESC
            LIMIT $2
        """, service._workspace_id, limit)
    
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
            "is_class": row['is_class'],
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
        types = await service.get_node_classes(page.id)
        result.append(_node_to_response(page, classes=[t.id for t in types if t.id]))
    
    return {"pages": result}


@router.get("/trash", name="get_trash")
async def get_trash(
    user: User = Depends(get_current_user),
):
    """Get all soft-deleted nodes (trash) for the current workspace.
    
    Returns nodes that have been soft-deleted (is_deleted=true) but not
    permanently removed from the database.
    """
    service = await _get_node_service(user)
    deleted_nodes = await service.get_deleted_nodes()
    
    # Convert to response format
    responses = []
    for node in deleted_nodes:
        types = await service.get_node_classes(node.id) if node.id else []
        responses.append(_node_to_response(node, classes=[t.id for t in types if t.id]))
    
    return {
        "nodes": responses,
        "total": len(responses)
    }


@router.post("/trash/empty", name="empty_trash")
async def empty_trash(
    user: User = Depends(get_current_user),
):
    """Permanently delete all soft-deleted nodes (empty trash).
    
    This is irreversible. All nodes in trash will be hard deleted from the database.
    """
    service = await _get_node_service(user)
    count = await service.empty_trash()
    
    return {
        "status": "success",
        "deleted_count": count
    }


@router.post("/trash/batch-delete", name="batch_permanent_delete")
async def batch_permanent_delete(
    request: BatchPermanentDeleteRequest,
    user: User = Depends(get_current_user),
):
    """Permanently delete multiple nodes from trash by ID.
    
    Accepts an array of node IDs and hard-deletes each independently.
    Only works on nodes that are already soft-deleted (in trash).
    A failure on one node does not prevent the others from being deleted.
    """
    from ...logging_config import get_logger
    logger = get_logger(__name__)
    
    service = await _get_node_service(user)
    raw_results = await service.batch_permanent_delete(request.ids)
    
    results = []
    deleted = 0
    failed = 0
    for i, r in enumerate(raw_results):
        if r["success"]:
            deleted += 1
            results.append(BatchPermanentDeleteResultItem(
                index=i,
                id=request.ids[i],
                success=True,
            ))
        else:
            failed += 1
            results.append(BatchPermanentDeleteResultItem(
                index=i,
                id=request.ids[i],
                success=False,
                error=r["error"],
            ))
    
    logger.info(f"[BATCH_PERMANENT_DELETE] {deleted} deleted, {failed} failed out of {len(request.ids)}")
    return BatchPermanentDeleteResponse(results=results, deleted=deleted, failed=failed)


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
    tag_ids = await _get_tag_ids(service._pool, service._workspace_id or 0, node_id)
    
    # Get aliases for the node (nodes that have aliased_id pointing to this node)
    alias_ids = await _get_alias_ids(service._pool, service._workspace_id or 0, node_id)
    
    response = _node_to_response(node, tags=tag_ids, classes=class_ids, aliases=alias_ids)
    
    if include_children:
        pool = service._node_repo.get_connection()
        
        # Get ALL descendants using closure table (node_path)
        rows = await pool.fetch("""
            SELECT n.* 
            FROM node_path np
            JOIN node n ON n.id = np.descendant_id
            WHERE np.ancestor_id = $1 
              AND np.depth > 0
              AND n.active = TRUE
              AND (n.is_deleted = FALSE OR n.is_deleted IS NULL)
            ORDER BY np.depth, n.sequence
        """, node_id)
        all_descendants = [service._node_repo.row_to_node(row) for row in rows]
        
        # Get all descendant IDs
        descendant_ids = [d.id for d in all_descendants if d.id is not None]
        
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
        
        # Get classes for all descendants in one batch using node.class_ids
        node_class_map = await _get_class_ids_batch(pool, service._workspace_id or 0, descendant_ids)
        
        # Get properties for all descendants if include_properties is requested
        node_properties_map: Dict[int, Dict[str, any]] = {}
        if include_properties and descendant_ids:
            for nid in descendant_ids:
                all_prop_values = await service._property_repo.get_all_property_values(nid)
                node_properties_map[nid] = extract_properties_dict(all_prop_values)
        
        # Build tree structure from flat list using parent_id
        node_map: Dict[int, NodeResponse] = {}
        for d in all_descendants:
            if d.id is not None:
                bcount = backlink_counts.get(d.id, 0)
                d_class_ids = node_class_map.get(d.id, [])
                node_resp = _node_to_response(d, classes=d_class_ids, backlink_count=bcount)
                # Add properties if they were loaded
                if include_properties and d.id in node_properties_map:
                    node_resp.properties = node_properties_map[d.id]
                node_map[d.id] = node_resp
        
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
        all_prop_values = await service._property_repo.get_all_property_values(node_id)
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
    
    # Get block IDs for batch queries
    block_ids = [b.id for b in blocks if b.id is not None]
    
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
    
    # Get classes for all nodes in one batch (from node.class_ids column)
    all_node_ids = [page_id] + block_ids
    node_class_map = await _get_class_ids_batch(pool, service._workspace_id or 0, all_node_ids)
    
    # Get tags for all nodes in one batch (from node_link with is_tag=1)
    node_tag_map = await _get_tag_ids_batch(pool, service._workspace_id or 0, all_node_ids)
    
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
    page_alias_ids = await _get_alias_ids(service._pool, service._workspace_id or 0, page_id)
    
    page_response = _node_to_response(page, tags=page_tag_ids, classes=page_class_ids, aliases=page_alias_ids)
    page_response.children = root_children
    
    # Add properties - get the full property values
    all_prop_values = await service._property_repo.get_all_property_values(page_id)
    logger.info(f"Page {page_id} properties: {list(all_prop_values.keys())}")
    page_response.properties = extract_properties_dict(all_prop_values)
    
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
    from ...logging_config import get_logger
    logger = get_logger(__name__)
    
    logger.info(f"[UPDATE_NODE] node_id={node_id}, request.color={request.color!r}, fields_set={request.model_fields_set}")
    
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
    
    logger.info(f"[UPDATE_NODE] NodeUpdateData color={data.color!r}, clear_color={data.clear_color}")
    
    try:
        node = await service.update_node(
            node_id, 
            data, 
            expected_version=request.expected_version
        )
        if not node:
            raise HTTPException(404, "Node not found")
        
        logger.info(f"[UPDATE_NODE] result node.color={node.color!r}")
        
        return _node_to_response(node)
    except OptimisticLockError as e:
        raise HTTPException(409, str(e))


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


@router.delete("/{node_id}/permanent", name="permanently_delete_node")
async def permanently_delete_node(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Permanently delete a node from trash (hard delete from database).
    
    This is irreversible. Only works on nodes that are already soft-deleted.
    The node and all its relationships will be removed from the database.
    """
    service = await _get_node_service(user)
    
    success = await service.permanently_delete_node(node_id)
    if not success:
        raise HTTPException(404, "Node not found in trash")
    
    return {"status": "permanently_deleted"}


@router.delete("/{node_id}")
async def delete_node(
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
    pool = service._node_repo.get_connection()
    
    # Get the node including archived ones (for UUID and asset cleanup)
    row = await pool.fetchrow(
        "SELECT uuid FROM node WHERE id = $1 AND workspace_id = $2",
        node_id, service._workspace_id
    )
    if not row:
        # Debug: check if node exists at all
        debug_row = await pool.fetchrow("SELECT id, workspace_id, active FROM node WHERE id = $1", node_id)
        if debug_row:
            raise HTTPException(404, f"Node {node_id} exists in workspace {debug_row['workspace_id']} (active={debug_row['active']}), but current user workspace is {service._workspace_id}")
        raise HTTPException(404, f"Node {node_id} not found in any workspace")
    
    node_uuid = row['uuid']
    
    # Try to delete any associated asset file
    if node_uuid and service._workspace_id is not None:
        # Get workspace UUID for asset storage
        workspace_uuid = await get_workspace_uuid(service._workspace_id)
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
        raise HTTPException(400, e.message)
    
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
    
    types = await service.get_node_classes(node_id)
    return _node_to_response(node, classes=[t.id for t in types if t.id])


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
    from datetime import datetime, timezone
    from ...domain.services.node_view_service import NodeViewService
    
    service = await _get_node_service(user)
    async with acquire_connection(service._pool) as conn:
        # Verify it's a page and exists
        row = await conn.fetchrow(
            "SELECT id, is_page FROM node WHERE id = $1 AND active = TRUE AND workspace_id = $2",
            node_id, service._workspace_id
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
    
    # Note: Default views are now lazily created by the frontend via ensure-defaults endpoint
    # This keeps all query structure logic in one place
    
    return {"status": "ok", "open_date": now.isoformat()}

