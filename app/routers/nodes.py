"""Nodes router - using domain layer.

Handles all node (page, block, tag) CRUD operations.
"""
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime, date

from ..domain.entities import Node, NodeCreateData, NodeUpdateData
from ..domain.services import NodeService, LinkParsingService
from ..domain.repositories import (
    SQLiteNodeRepository, 
    SQLitePropertyRepository, 
    SQLiteLinkRepository,
)
from ..db.schema import (
    generate_day_uuid, 
    generate_month_uuid, 
    generate_year_uuid,
    parse_date_uuid,
    SYSTEM_TYPE_UUIDS,
)
from .auth import get_current_user
from ..models import User
from ..logging_config import get_logger


router = APIRouter(prefix="/api/nodes", tags=["Nodes"])
logger = get_logger(__name__)


# ============== Pydantic Models for API ==============

class NodeResponse(BaseModel):
    """Node response model."""
    id: int
    uuid: str
    name: str
    icon: Optional[str] = None
    color: Optional[str] = None
    parent_id: Optional[int] = None
    page_id: Optional[int] = None
    sequence: int = 0
    collapsed: bool = False
    active: bool = True
    is_page: bool = False  # Whether this node is a page
    is_type: bool = False  # Whether this node defines a type
    is_daily: bool = False  # Daily journal page
    is_monthly: bool = False  # Monthly journal page
    is_yearly: bool = False  # Yearly journal page
    usable_in: str = "both"  # Where this type can be applied (only meaningful when is_type=True)
    create_date: str
    write_date: str
    # Computed fields
    display_name: Optional[str] = None
    tags: List[int] = []  # Tag node IDs (descriptive linking with #)
    types: List[int] = []  # Type node IDs (categorization with @)
    properties: Dict[str, Any] = {}
    # Linked references - types_path (inherited types from ancestors)
    types_path: List[int] = []  # Inherited type node IDs from ancestors' types properties
    # For tree responses
    children: Optional[List["NodeResponse"]] = None
    # Backlinks
    backlinks: Optional[List["BacklinkResponse"]] = None
    linked_references: Optional[List["LinkedReferenceResponse"]] = None
    # Comments
    comment_count: int = 0
    
    class Config:
        from_attributes = True


class BreadcrumbSegment(BaseModel):
    """A segment in the breadcrumb path."""
    node_id: Optional[int] = None  # None for property segments
    name: str
    is_property: bool = False  # True if this is a property name segment


class BacklinkResponse(BaseModel):
    """Backlink info with full provenance.
    
    For text links: source is the block T containing [[id]]
    For property links: source is the property owner B
    """
    source_node_id: int
    source_node_uuid: str
    source_node_name: str
    source_is_page: bool = False
    source_page_id: Optional[int] = None
    source_page_name: Optional[str] = None
    source_page_uuid: Optional[str] = None
    # Property info (for node-type property links)
    property_id: Optional[int] = None
    property_name: Optional[str] = None
    # Breadcrumb path with property provenance
    breadcrumb_path: List[BreadcrumbSegment] = []
    link_type: str  # "text" or "property"
    position: int


class LinkedReferenceResponse(BaseModel):
    """Linked reference with context."""
    source_node: NodeResponse
    source_page: Optional[NodeResponse] = None
    link_type: str
    context: str  # Text around the link
    breadcrumb_path: List[BreadcrumbSegment] = []  # Path from source to page


class PropertyValueResponse(BaseModel):
    """Property value for a node."""
    property_id: int
    property_name: str
    property_type: str
    value: Any
    display_value: str


class NodeCreateRequest(BaseModel):
    """Request to create a node."""
    name: str = ""
    icon: Optional[str] = None
    color: Optional[str] = None
    parent_id: Optional[int] = None
    sequence: int = 0
    types: List[int] = []  # Type node IDs
    properties: Dict[int, Any] = {}  # property_id -> value
    # For date nodes
    is_daily: bool = False
    daily_date: Optional[str] = None  # YYYY-MM-DD
    is_monthly: bool = False
    monthly_date: Optional[str] = None  # YYYY-MM
    is_yearly: bool = False
    yearly_date: Optional[str] = None  # YYYY


class NodeUpdateRequest(BaseModel):
    """Request to update a node."""
    name: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    parent_id: Optional[int] = None
    sequence: Optional[int] = None
    collapsed: Optional[bool] = None


class TypeRequest(BaseModel):
    """Request to add/remove a type."""
    type_node_id: int


class PropertyRequest(BaseModel):
    """Request to set a property value."""
    property_id: int
    value: Any


class MoveNodeRequest(BaseModel):
    """Request to move a node to a new parent and/or position."""
    parent_id: Optional[int] = None
    position: Optional[int] = None


# ============== Helper Functions ==============

def _node_to_response(
    node: Node, 
    tags: Optional[List[int]] = None,
    types: Optional[List[int]] = None,
    comment_count: int = 0,
) -> NodeResponse:
    """Convert domain Node to API response."""
    return NodeResponse(
        id=node.id or 0,
        uuid=node.uuid,
        name=node.name,
        icon=node.icon,
        color=node.color,
        parent_id=node.parent_id,
        page_id=node.page_id,
        sequence=node.sequence,
        collapsed=node.collapsed,
        active=node.active,
        is_page=node.is_page,
        is_type=node.is_type,
        is_daily=node.is_day,
        is_monthly=node.is_month,
        is_yearly=node.is_year,
        usable_in=node.usable_in,
        create_date=node.create_date,
        write_date=node.write_date,
        display_name=node.display_name,
        tags=tags or [],
        types=types or [],
        comment_count=comment_count,
        types_path=node.types_path or [],
    )


async def _get_type_ids(service: NodeService, node_id: int) -> List[int]:
    """Helper to get type IDs for a node."""
    types = await service.get_node_types(node_id)
    return [t.id for t in types if t.id]


async def _get_node_service(user: User) -> NodeService:
    """Get NodeService instance for user's database.
    
    TODO: This should come from a proper dependency injection system.
    For now, we create it on demand.
    """
    from ..db.connection import get_db
    from ..db.schema import get_database
    from pathlib import Path
    
    # Get user's database connection
    db = await get_db(user.id)
    
    # Get system IDs (cached in real implementation)
    cursor = await db.execute(
        "SELECT id FROM node WHERE name = 'page' AND is_type = 1 LIMIT 1"
    )
    row = await cursor.fetchone()
    page_type_id = row['id'] if row else 1
    
    cursor = await db.execute(
        "SELECT id FROM property WHERE name = 'types' LIMIT 1"
    )
    row = await cursor.fetchone()
    types_property_id = row['id'] if row else 1
    
    # Create repositories
    node_repo = SQLiteNodeRepository(db, page_type_id, types_property_id)
    property_repo = SQLitePropertyRepository(db)
    link_repo = SQLiteLinkRepository(db)
    
    # Create services
    link_service = LinkParsingService(node_repo, link_repo)
    node_service = NodeService(
        node_repo, property_repo, link_service,
        page_type_id, types_property_id
    )
    
    return node_service


# ============== Endpoints ==============

@router.get("/graph")
async def get_graph_data_endpoint(
    user: User = Depends(get_current_user),
):
    """Get graph data for visualization with nodes and links."""
    from ..db.graph import get_graph_data
    return await get_graph_data(user.id)


@router.get("/search")
async def search_nodes(
    q: str,
    limit: int = 50,
    user: User = Depends(get_current_user),
):
    """Search nodes by name."""
    service = await _get_node_service(user)
    nodes = await service.search(q, limit)
    return {"nodes": [_node_to_response(n) for n in nodes]}


@router.get("/types")
async def list_types(
    user: User = Depends(get_current_user),
):
    """List all types (nodes that can categorize other nodes).
    
    Types are nodes that have is_type=1. They can be used to categorize other nodes.
    Also includes the 'type' type itself for completeness.
    """
    service = await _get_node_service(user)
    
    # Get nodes that are types (have the 'type' type themselves)
    type_type = await service._node_repo.get_by_uuid(SYSTEM_TYPE_UUIDS["type"])
    if not type_type:
        return {"nodes": []}
    
    type_type_node = type_type
    type_type_id = type_type_node.id
    if type_type_id is None:
        return {"nodes": []}
    
    nodes = await service._node_repo.get_typed_with(type_type_id)
    
    # Include the 'type' type itself if it's not already in the list
    if not any(n.id == type_type_id for n in nodes):
        nodes.insert(0, type_type_node)
    
    return {"nodes": [_node_to_response(n) for n in nodes]}


@router.get("/types/search")
async def search_types(
    q: str,
    limit: int = 20,
    user: User = Depends(get_current_user),
):
    """Search for types by name."""
    service = await _get_node_service(user)
    # Search pages only (types are pages)
    nodes = await service.search(q, limit)
    # Filter to pages only (no parent_id)
    pages = [n for n in nodes if n.parent_id is None]
    return {"nodes": [_node_to_response(n) for n in pages]}


@router.get("/types/{type_id}/nodes")
async def get_nodes_with_type(
    type_id: int,
    user: User = Depends(get_current_user),
):
    """Get all nodes that have a specific type.
    
    Returns nodes that have been categorized with the given type node.
    """
    service = await _get_node_service(user)
    
    # Get the 'types' property ID
    conn = service._node_repo.get_connection()
    cursor = await conn.execute(
        "SELECT id FROM property WHERE name = 'types' LIMIT 1"
    )
    row = await cursor.fetchone()
    
    if not row:
        return {"nodes": []}
    
    types_property_id = row['id']
    
    # Find all nodes that have this type
    cursor = await conn.execute("""
        SELECT DISTINCT n.* FROM node n
        JOIN property_value_relation pvr ON n.id = pvr.node_id
        WHERE pvr.property_id = ? AND pvr.target_node_id = ?
        ORDER BY n.write_date DESC
    """, (types_property_id, type_id))
    rows = await cursor.fetchall()
    
    result = []
    for row in rows:
        node = service._node_repo.row_to_node(row)
        types = await service.get_node_types(node.id) if node.id else []
        
        result.append(_node_to_response(node, types=[t.id for t in types if t.id]))
    
    return {"nodes": result}


@router.get("")
async def list_nodes(
    pages_only: bool = False,
    parent_id: Optional[int] = None,
    type_id: Optional[int] = None,
    user: User = Depends(get_current_user),
):
    """List nodes with optional filters."""
    service = await _get_node_service(user)
    
    if parent_id:
        nodes = await service._node_repo.get_children(parent_id)
    elif type_id:
        nodes = await service._node_repo.get_typed_with(type_id)
    elif pages_only:
        nodes = await service.get_all_pages()
    else:
        nodes = await service.search("", limit=1000)
    
    return {"nodes": [_node_to_response(n) for n in nodes]}


@router.post("")
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


@router.get("/daily/list")
async def list_daily_pages(
    user: User = Depends(get_current_user),
):
    """List all existing daily pages ordered by date descending."""
    service = await _get_node_service(user)
    
    # Query nodes with is_day=1, ordered by uuid (which is YYYYMMDD format)
    # Exclude type pages (is_type=1) to filter out the "day" type page itself
    conn = service._node_repo.get_connection()
    cursor = await conn.execute("""
        SELECT * FROM node 
        WHERE is_day = 1 AND active = 1 AND is_type = 0
        ORDER BY uuid DESC
    """)
    rows = await cursor.fetchall()
    
    # Get node IDs for batch type lookup
    nodes = [service._node_repo.row_to_node(row) for row in rows]
    node_ids = [n.id for n in nodes if n.id is not None]
    
    # Batch fetch types for all nodes
    node_type_map: Dict[int, List[int]] = {nid: [] for nid in node_ids}
    if node_ids:
        placeholders = ','.join(['?' for _ in node_ids])
        cursor = await conn.execute(f"""
            SELECT pvr.node_id, pvr.target_node_id
            FROM property_value_relation pvr
            JOIN property p ON pvr.property_id = p.id
            WHERE p.name = 'types' AND pvr.node_id IN ({placeholders})
            ORDER BY pvr.node_id, pvr."order"
        """, node_ids)
        type_rows = await cursor.fetchall()
        for row in type_rows:
            node_id = row['node_id']
            type_id = row['target_node_id']
            if node_id in node_type_map and type_id:
                node_type_map[node_id].append(type_id)
    
    result = []
    for node in nodes:
        type_ids = node_type_map.get(node.id, []) if node.id else []
        result.append(_node_to_response(node, types=type_ids))
    
    return {"nodes": result}


@router.post("/daily")
async def get_or_create_daily(
    date_str: str,  # YYYY-MM-DD
    user: User = Depends(get_current_user),
):
    """Get or create a daily note.
    
    Uses UUID format YYYYMMDD for easy parsing.
    Automatically creates year and month pages with proper parent hierarchy:
    - Year page (parent: none)
    - Month page (parent: year)
    - Day page (parent: month)
    """
    service = await _get_node_service(user)
    
    # Parse date
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(400, "Invalid date format. Use YYYY-MM-DD")
    
    # Generate date UUID
    uuid = generate_day_uuid(d)
    
    # Get type IDs by UUID (needed for both existing and new pages)
    day_type = await service._node_repo.get_by_uuid(SYSTEM_TYPE_UUIDS["day"])
    if not day_type:
        raise HTTPException(500, "Day type not found")
    day_type_id = day_type.id
    if day_type_id is None:
        raise HTTPException(500, "Day type has no ID")
    
    page_type_id = service._page_type_id
    if page_type_id is None:
        raise HTTPException(500, "Page type not configured")
    
    # Check if exists
    existing = await service._node_repo.get_by_uuid(uuid)
    if existing:
        # Ensure day type is assigned (for legacy pages created before types were added)
        type_ids = await _get_type_ids(service, existing.id) if existing.id else []
        if day_type_id not in type_ids:
            await service.add_type(existing.id, day_type_id)
            type_ids.append(day_type_id)
        return _node_to_response(existing, types=type_ids)
    
    month_type = await service._node_repo.get_by_uuid(SYSTEM_TYPE_UUIDS["month"])
    if not month_type:
        raise HTTPException(500, "Month type not found")
    month_type_id = month_type.id
    if month_type_id is None:
        raise HTTPException(500, "Month type has no ID")
    
    year_type = await service._node_repo.get_by_uuid(SYSTEM_TYPE_UUIDS["year"])
    if not year_type:
        raise HTTPException(500, "Year type not found")
    year_type_id = year_type.id
    if year_type_id is None:
        raise HTTPException(500, "Year type has no ID")
    
    from ..domain.repositories import SQLiteNodeRepository
    if not isinstance(service._node_repo, SQLiteNodeRepository):
        raise HTTPException(500, "Repository does not support custom UUID")
    
    # Get user's date format preference using the SAME connection to avoid database lock
    cursor = await service._node_repo._conn.execute(
        "SELECT value FROM settings WHERE key = ?", ("date_format",)
    )
    row = await cursor.fetchone()
    date_format = row["value"] if row else "YYYY/MM/DD"
    
    # 1. Ensure year page exists
    year_uuid = generate_year_uuid(d.year)
    year_node = await service._node_repo.get_by_uuid(year_uuid)
    if not year_node:
        year_data = NodeCreateData(
            name=str(d.year),
            types=[page_type_id, year_type_id],
            is_page=True,
            is_year=True,
        )
        year_node = await service._node_repo.create_with_uuid(year_uuid, year_data)
    
    # 2. Ensure month page exists (with year as parent)
    month_uuid = generate_month_uuid(d.year, d.month)
    month_node = await service._node_repo.get_by_uuid(month_uuid)
    if not month_node:
        month_name_str = _format_month_with_pattern(d.year, d.month, date_format)
        month_data = NodeCreateData(
            name=month_name_str,
            types=[page_type_id, month_type_id],
            parent_id=year_node.id,
            is_page=True,
            is_month=True,
        )
        month_node = await service._node_repo.create_with_uuid(month_uuid, month_data)
    elif month_node.parent_id != year_node.id and month_node.id is not None:
        # Update parent_id if not set correctly
        await service.update_node(month_node.id, NodeUpdateData(parent_id=year_node.id))
        month_node = await service._node_repo.get_by_uuid(month_uuid)
    
    # 3. Create day page with month as parent
    name = _format_date_with_pattern(d.year, d.month, d.day, date_format)
    day_data = NodeCreateData(
        name=name,
        types=[page_type_id, day_type_id],
        parent_id=month_node.id if month_node else None,
        is_page=True,
        is_day=True,
    )
    node = await service._node_repo.create_with_uuid(uuid, day_data)
    # Return with types (page and day)
    return _node_to_response(node, types=[page_type_id, day_type_id])


@router.post("/monthly")
async def get_or_create_monthly(
    year: int,
    month: int,
    user: User = Depends(get_current_user),
):
    """Get or create a monthly note.
    
    Uses UUID format YYYYMM00 for easy parsing.
    Automatically creates year page as parent.
    """
    service = await _get_node_service(user)
    
    if not (1 <= month <= 12):
        raise HTTPException(400, "Month must be 1-12")
    
    uuid = generate_month_uuid(year, month)
    
    # Get type IDs by UUID (needed for both existing and new pages)
    month_type = await service._node_repo.get_by_uuid(SYSTEM_TYPE_UUIDS["month"])
    if not month_type:
        raise HTTPException(500, "Month type not found")
    month_type_id = month_type.id
    if month_type_id is None:
        raise HTTPException(500, "Month type has no ID")
    
    page_type_id = service._page_type_id
    if page_type_id is None:
        raise HTTPException(500, "Page type not configured")
    
    existing = await service._node_repo.get_by_uuid(uuid)
    if existing:
        # Ensure month type is assigned (for legacy pages created before types were added)
        type_ids = await _get_type_ids(service, existing.id) if existing.id else []
        if month_type_id not in type_ids:
            await service.add_type(existing.id, month_type_id)
            type_ids.append(month_type_id)
        return _node_to_response(existing, types=type_ids)
    
    year_type = await service._node_repo.get_by_uuid(SYSTEM_TYPE_UUIDS["year"])
    if not year_type:
        raise HTTPException(500, "Year type not found")
    year_type_id = year_type.id
    if year_type_id is None:
        raise HTTPException(500, "Year type has no ID")
    
    from ..domain.repositories import SQLiteNodeRepository
    if not isinstance(service._node_repo, SQLiteNodeRepository):
        raise HTTPException(500, "Repository does not support custom UUID")
    
    # Ensure year page exists first
    year_uuid = generate_year_uuid(year)
    year_node = await service._node_repo.get_by_uuid(year_uuid)
    if not year_node:
        year_data = NodeCreateData(
            name=str(year),
            types=[page_type_id, year_type_id],
            is_page=True,
            is_year=True,
        )
        year_node = await service._node_repo.create_with_uuid(year_uuid, year_data)
    
    # Get user's date format preference and create month with year as parent
    from ..db.utils import get_user_setting
    date_format = await get_user_setting(user.id, "date_format") or "YYYY/MM/DD"
    name = _format_month_with_pattern(year, month, date_format)
    
    data = NodeCreateData(
        name=name,
        types=[page_type_id, month_type_id],
        parent_id=year_node.id if year_node else None,
        is_page=True,
        is_month=True,
    )
    node = await service._node_repo.create_with_uuid(uuid, data)
    return _node_to_response(node)


@router.post("/yearly")
async def get_or_create_yearly(
    year: int,
    user: User = Depends(get_current_user),
):
    """Get or create a yearly note.
    
    Uses UUID format YYYY0000 for easy parsing.
    """
    service = await _get_node_service(user)
    
    uuid = generate_year_uuid(year)
    
    # Get year type by UUID (needed for both existing and new pages)
    year_type = await service._node_repo.get_by_uuid(SYSTEM_TYPE_UUIDS["year"])
    if not year_type:
        raise HTTPException(500, "Year type not found")
    
    year_type_id = year_type.id
    if year_type_id is None:
        raise HTTPException(500, "Year type has no ID")
    
    page_type_id = service._page_type_id
    if page_type_id is None:
        raise HTTPException(500, "Page type not configured")
    
    existing = await service._node_repo.get_by_uuid(uuid)
    if existing:
        # Ensure year type is assigned (for legacy pages created before types were added)
        type_ids = await _get_type_ids(service, existing.id) if existing.id else []
        if year_type_id not in type_ids:
            await service.add_type(existing.id, year_type_id)
            type_ids.append(year_type_id)
        return _node_to_response(existing, types=type_ids)
    
    name = str(year)
    
    from ..domain.repositories import SQLiteNodeRepository
    if isinstance(service._node_repo, SQLiteNodeRepository):
        data = NodeCreateData(
            name=name,
            types=[page_type_id, year_type_id],
            is_page=True,
            is_year=True,
        )
        node = await service._node_repo.create_with_uuid(uuid, data)
        return _node_to_response(node)
    else:
        raise HTTPException(500, "Repository does not support custom UUID")


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
    response = _node_to_response(node, types=type_ids)
    
    if include_children:
        conn = service._node_repo.get_connection()
        
        # Get ALL descendants recursively using a CTE based on parent_id
        cursor = await conn.execute("""
            WITH RECURSIVE descendants AS (
                -- Base case: direct children of the target node
                SELECT * FROM node WHERE parent_id = ?
                UNION ALL
                -- Recursive case: children of descendants
                SELECT n.* FROM node n
                INNER JOIN descendants d ON n.parent_id = d.id
            )
            SELECT * FROM descendants ORDER BY sequence
        """, (node_id,))
        rows = await cursor.fetchall()
        all_descendants = [service._node_repo.row_to_node(row) for row in rows]
        
        # Get all descendant IDs
        descendant_ids = [d.id for d in all_descendants if d.id is not None]
        
        # Get comment counts for all descendants in one query
        comment_counts: Dict[int, int] = {}
        if descendant_ids:
            placeholders = ','.join(['?' for _ in descendant_ids])
            cursor = await conn.execute(f"""
                SELECT node_id, COUNT(*) as count 
                FROM node_comment 
                WHERE node_id IN ({placeholders})
                GROUP BY node_id
            """, descendant_ids)
            rows = await cursor.fetchall()
            for row in rows:
                comment_counts[row['node_id']] = row['count']
        
        # Get types for all descendants in one batch (avoid N+1 queries)
        node_type_map: Dict[int, List[int]] = {nid: [] for nid in descendant_ids}
        
        if descendant_ids:
            placeholders = ','.join(['?' for _ in descendant_ids])
            cursor = await conn.execute(f"""
                SELECT pvr.node_id, pvr.target_node_id
                FROM property_value_relation pvr
                JOIN property p ON pvr.property_id = p.id
                WHERE p.name = 'types' AND pvr.node_id IN ({placeholders})
                ORDER BY pvr.node_id, pvr."order"
            """, descendant_ids)
            rows = await cursor.fetchall()
            for row in rows:
                nid = row['node_id']
                tid = row['target_node_id']
                if nid in node_type_map and tid:
                    node_type_map[nid].append(tid)
        
        # Build tree structure from flat list using parent_id
        node_map: Dict[int, NodeResponse] = {}
        for d in all_descendants:
            if d.id is not None:
                count = comment_counts.get(d.id, 0)
                d_type_ids = node_type_map.get(d.id, [])
                node_map[d.id] = _node_to_response(d, types=d_type_ids, comment_count=count)
        
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
                source_node_uuid=info.source_node_uuid or "",
                source_node_name=info.source_node_name or "",
                source_is_page=info.source_is_page,
                source_page_id=info.source_page_id,
                source_page_name=info.source_page_name,
                source_page_uuid=info.source_page_uuid,
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
                source_node_uuid=info.source_node_uuid or "",
                source_node_name=info.source_node_name or "",
                source_is_page=info.source_is_page,
                source_page_id=info.source_page_id,
                source_page_name=info.source_page_name,
                source_page_uuid=info.source_page_uuid,
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
    conn = service._node_repo.get_connection()
    
    # Get comment counts for all blocks
    block_ids = [b.id for b in blocks if b.id is not None]
    comment_counts = {}
    if block_ids:
        # Query comment counts for all blocks in one go
        placeholders = ','.join(['?' for _ in block_ids])
        cursor = await conn.execute(f"""
            SELECT node_id, COUNT(*) as count 
            FROM node_comment 
            WHERE node_id IN ({placeholders})
            GROUP BY node_id
        """, block_ids)
        rows = await cursor.fetchall()
        for row in rows:
            comment_counts[row['node_id']] = row['count']
    
    # Get types for all blocks in one batch (avoid N+1 queries)
    all_node_ids = [page_id] + block_ids
    node_type_map: Dict[int, List[int]] = {nid: [] for nid in all_node_ids}
    
    if all_node_ids:
        placeholders = ','.join(['?' for _ in all_node_ids])
        cursor = await conn.execute(f"""
            SELECT pvr.node_id, pvr.target_node_id
            FROM property_value_relation pvr
            JOIN property p ON pvr.property_id = p.id
            WHERE p.name = 'types' AND pvr.node_id IN ({placeholders})
            ORDER BY pvr.node_id, pvr."order"
        """, all_node_ids)
        rows = await cursor.fetchall()
        for row in rows:
            node_id = row['node_id']
            type_id = row['target_node_id']
            if node_id in node_type_map and type_id:
                node_type_map[node_id].append(type_id)
    
    # Build tree structure from flat list
    block_map = {}
    for b in blocks:
        if b.id != page_id and b.id is not None:
            count = comment_counts.get(b.id, 0)
            type_ids = node_type_map.get(b.id, [])
            block_map[b.id] = _node_to_response(b, types=type_ids, comment_count=count)
    
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
    page_response = _node_to_response(page, types=page_type_ids, comment_count=page_comment_count)
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
    - position: New sequence position among siblings
    
    Note: page_id is automatically computed from parent_id hierarchy.
    """
    service = await _get_node_service(user)
    
    data = NodeUpdateData(
        parent_id=request.parent_id,
        sequence=request.position,
    )
    
    node = await service.update_node(node_id, data)
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
    if node.uuid:
        from ..db.connection import get_assets_dir
        assets_dir = get_assets_dir(user.id)
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


@router.post("/{node_id}/types")
async def add_node_type(
    node_id: int,
    request: TypeRequest,
    user: User = Depends(get_current_user),
):
    """Add a type to a node."""
    service = await _get_node_service(user)
    
    success = await service.add_type(node_id, request.type_node_id)
    if not success:
        raise HTTPException(400, "Type already present or node not found")
    
    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    types = await service.get_node_types(node_id)
    return _node_to_response(node, types=[t.id for t in types if t.id])


@router.delete("/{node_id}/types/{type_id}")
async def remove_node_type_endpoint(
    node_id: int,
    type_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a type from a node."""
    service = await _get_node_service(user)
    
    success = await service.remove_type(node_id, type_id)
    
    node = await service.get_node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    types = await service.get_node_types(node_id)
    return _node_to_response(node, types=[t.id for t in types if t.id])


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
    from ..domain.entities import SCALAR_TYPES, RELATION_TYPES, PropertyType
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
    
    backlinks = await service._link_service.get_backlinks(node_id, include_inherited)
    
    result = []
    for link in backlinks:
        source = await service._node_repo.get_by_id(link.source_node_id)
        source_page = None
        if source and source.page_id:
            source_page = await service._node_repo.get_by_id(source.page_id)
        
        result.append(BacklinkResponse(
            source_node_id=link.source_node_id,
            source_node_uuid=source.uuid if source else "",
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
    """Get linked references to a node with context."""
    service = await _get_node_service(user)
    
    backlinks = await service._link_service.get_backlinks(node_id)
    
    result = []
    for link in backlinks:
        source = await service._node_repo.get_by_id(link.source_node_id)
        if not source:
            continue
        
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
        
        result.append(LinkedReferenceResponse(
            source_node=_node_to_response(source),
            source_page=_node_to_response(source_page) if source_page else None,
            link_type="property" if link.property_id else "text",
            context=context,
            breadcrumb_path=breadcrumb_segments,
        ))
    
    return {"linked_references": result}


class PropertyBacklinkResponse(BaseModel):
    """A page that references a target node via property."""
    source_page: NodeResponse
    property_id: int
    property_name: str


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
        conn = service._node_repo.get_connection()
        cursor = await conn.execute("""
            SELECT DISTINCT pvs.node_id, pvs.property_id, p.name as property_name
            FROM property_value_scalar pvs
            JOIN property p ON pvs.property_id = p.id
            WHERE pvs.value_text = ? AND p.type = 'date'
        """, (date_str,))
        rows = await cursor.fetchall()
        
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
    conn = service._node_repo.get_connection()
    cursor = await conn.execute("""
        SELECT DISTINCT pvr.node_id, pvr.property_id, p.name as property_name
        FROM property_value_relation pvr
        JOIN property p ON pvr.property_id = p.id
        WHERE pvr.target_node_id = ? AND p.type = 'node'
    """, (node_id,))
    rows = await cursor.fetchall()
    
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


# ============== Comments Endpoints ==============

class CommentCreateRequest(BaseModel):
    """Request to create a comment on a node."""
    name: str = ""  # Initial comment content


class CommentResponse(BaseModel):
    """Response with comment node data."""
    id: int
    uuid: str
    name: str
    icon: str | None = None
    parent_id: int | None = None
    sequence: int = 0
    collapsed: bool = False
    create_date: str
    write_date: str
    children: list["CommentResponse"] | None = None
    
    class Config:
        from_attributes = True


class CommentsResponse(BaseModel):
    """Response with list of comments."""
    comments: list[CommentResponse]
    comment_count: int


def _node_to_comment_response(node: Node, children: list[Node] | None = None) -> CommentResponse:
    """Convert a node to a comment response."""
    child_responses = None
    if children:
        child_responses = [_node_to_comment_response(c) for c in children]
    
    return CommentResponse(
        id=node.id or 0,
        uuid=node.uuid,
        name=node.name,
        icon=node.icon,
        parent_id=node.parent_id,
        sequence=node.sequence,
        collapsed=node.collapsed,
        create_date=node.create_date,
        write_date=node.write_date,
        children=child_responses,
    )


@router.get("/{node_id}/comments")
async def get_comments(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Get all comments for a node.
    
    Comments are stored as nodes tagged with 'comment' and linked via node_comment table.
    Each comment can have children (nested bullet points).
    """
    service = await _get_node_service(user)
    
    # Verify node exists
    node = await service._node_repo.get_by_id(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    
    # Get comment nodes for this node
    conn = service._node_repo.get_connection()
    cursor = await conn.execute("""
        SELECT nc.comment_node_id, nc.sequence
        FROM node_comment nc
        WHERE nc.node_id = ?
        ORDER BY nc.sequence, nc.create_date
    """, (node_id,))
    rows = await cursor.fetchall()
    
    comments = []
    for row in rows:
        comment_node = await service._node_repo.get_by_id(row['comment_node_id'])
        if comment_node and comment_node.id is not None:
            # Get children of comment node
            children = await service._node_repo.get_children(comment_node.id)
            comments.append(_node_to_comment_response(comment_node, children))
    
    return CommentsResponse(comments=comments, comment_count=len(comments))


@router.post("/{node_id}/comments")
async def create_comment(
    node_id: int,
    request: CommentCreateRequest,
    user: User = Depends(get_current_user),
):
    """Create a new comment on a node.
    
    Creates a new node typed as 'comment' and links it to the target node.
    Links in the comment content are parsed and tracked globally.
    """
    service = await _get_node_service(user)
    
    # Verify target node exists
    target_node = await service._node_repo.get_by_id(node_id)
    if not target_node:
        raise HTTPException(404, "Node not found")
    
    # Get the 'comment' type ID
    conn = service._node_repo.get_connection()
    cursor = await conn.execute(
        "SELECT id FROM node WHERE name = 'comment' AND is_type = 1 LIMIT 1"
    )
    row = await cursor.fetchone()
    
    if not row:
        raise HTTPException(500, "Comment type not found - database may need reinitialization")
    
    comment_type_id = row['id']
    
    # Get the page type ID (not used for comments but kept for reference)
    page_type_id = service._page_type_id
    
    # Create the comment node (typed as 'comment')
    # Comments are not pages - they are attached to other nodes
    data = NodeCreateData(
        name=request.name,
        types=[comment_type_id],
        is_comment=True,
    )
    
    comment_node = await service.create_node(data, user_id=None)
    
    if not comment_node.id:
        raise HTTPException(500, "Failed to create comment node")
    
    # Get the next sequence number
    cursor = await conn.execute("""
        SELECT COALESCE(MAX(sequence), -1) + 1 as next_seq
        FROM node_comment WHERE node_id = ?
    """, (node_id,))
    seq_row = await cursor.fetchone()
    next_seq = seq_row['next_seq'] if seq_row else 0
    
    # Link the comment to the target node
    from ..db.schema import utc_now_iso
    await conn.execute("""
        INSERT INTO node_comment (node_id, comment_node_id, sequence, create_date)
        VALUES (?, ?, ?, ?)
    """, (node_id, comment_node.id, next_seq, utc_now_iso()))
    await conn.commit()
    
    return _node_to_comment_response(comment_node)


@router.delete("/{node_id}/comments/{comment_id}")
async def delete_comment(
    node_id: int,
    comment_id: int,
    user: User = Depends(get_current_user),
):
    """Delete a comment from a node.
    
    This removes the comment link and deletes the comment node and all its children.
    """
    service = await _get_node_service(user)
    
    # Verify the comment link exists
    conn = service._node_repo.get_connection()
    cursor = await conn.execute("""
        SELECT id FROM node_comment 
        WHERE node_id = ? AND comment_node_id = ?
    """, (node_id, comment_id))
    row = await cursor.fetchone()
    
    if not row:
        raise HTTPException(404, "Comment not found for this node")
    
    # Remove the comment link
    await conn.execute("""
        DELETE FROM node_comment WHERE node_id = ? AND comment_node_id = ?
    """, (node_id, comment_id))
    
    # Delete the comment node (and children via cascade)
    await service.delete_node(comment_id)
    
    await conn.commit()
    
    return {"status": "ok"}


@router.get("/{node_id}/comment-count")
async def get_comment_count(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Get the count of comments for a node.
    
    Useful for showing comment indicators without loading all comments.
    """
    service = await _get_node_service(user)
    
    conn = service._node_repo.get_connection()
    cursor = await conn.execute("""
        SELECT COUNT(*) as count FROM node_comment WHERE node_id = ?
    """, (node_id,))
    row = await cursor.fetchone()
    
    return {"count": row['count'] if row else 0}


class DateFormatUpdateRequest(BaseModel):
    """Request to update date format for all date nodes."""
    new_format: str  # e.g., "YYYY/MM/DD", "DD-MM-YYYY", etc.


def _format_date_with_pattern(year: int, month: int, day: int, pattern: str) -> str:
    """Format a date according to the given pattern."""
    month_str = str(month).zfill(2)
    day_str = str(day).zfill(2)
    
    if pattern == "YYYY/MM/DD":
        return f"{year}/{month_str}/{day_str}"
    elif pattern == "YYYY-MM-DD":
        return f"{year}-{month_str}-{day_str}"
    elif pattern == "DD/MM/YYYY":
        return f"{day_str}/{month_str}/{year}"
    elif pattern == "DD-MM-YYYY":
        return f"{day_str}-{month_str}-{year}"
    elif pattern == "MM/DD/YYYY":
        return f"{month_str}/{day_str}/{year}"
    elif pattern == "MM-DD-YYYY":
        return f"{month_str}-{day_str}-{year}"
    else:
        return f"{year}/{month_str}/{day_str}"


def _format_month_with_pattern(year: int, month: int, pattern: str) -> str:
    """Format a month according to the given pattern."""
    month_str = str(month).zfill(2)
    separator = "/" if "/" in pattern else "-"
    
    if pattern.startswith("DD") or pattern.startswith("MM"):
        # European/US style
        return f"{month_str}{separator}{year}"
    else:
        # ISO style
        return f"{year}{separator}{month_str}"


@router.post("/settings/update-date-format")
async def update_date_format(
    request: DateFormatUpdateRequest,
    user: User = Depends(get_current_user),
):
    """
    Update the name format of all date and month nodes.
    
    This renames:
    - Daily notes (day tag) to the new format
    - Monthly notes (month tag) to the new format
    - Yearly notes remain as YYYY
    """
    service = await _get_node_service(user)
    pattern = request.new_format
    
    # Also save the user's date format preference
    from ..db.utils import set_user_setting
    await set_user_setting(user.id, "date_format", pattern)
    
    updated_count = 0
    errors = []
    
    # Get all nodes
    all_nodes = await service._node_repo.get_all_pages()
    
    for node in all_nodes:
        if not node.id or not node.uuid:
            continue
            
        uuid = node.uuid
        
        try:
            # Check if it's a day node (YYYYMMDD format, day != 0)
            if len(uuid) == 8 and uuid.isdigit():
                year = int(uuid[:4])
                month = int(uuid[4:6])
                day = int(uuid[6:8])
                
                # Skip year nodes (month and day are 0)
                if month == 0:
                    continue
                
                # Month node (day is 0)
                if day == 0:
                    if 1 <= month <= 12:
                        new_name = _format_month_with_pattern(year, month, pattern)
                        if new_name != node.name:
                            update_data = NodeUpdateData(name=new_name)
                            await service.update_node(node.id, update_data)
                            updated_count += 1
                else:
                    # Day node
                    if 1 <= month <= 12 and 1 <= day <= 31:
                        new_name = _format_date_with_pattern(year, month, day, pattern)
                        if new_name != node.name:
                            update_data = NodeUpdateData(name=new_name)
                            await service.update_node(node.id, update_data)
                            updated_count += 1
                        
        except Exception as e:
            errors.append(f"Error updating node {uuid}: {str(e)}")
            
    return {
        "status": "success",
        "updated_count": updated_count,
        "errors": errors if errors else []
    }
