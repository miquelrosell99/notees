"""Daily, monthly, and yearly date page endpoints."""
from datetime import datetime

from fastapi import APIRouter, HTTPException, Depends, Query

from ...domain.entities import NodeCreateData, NodeUpdateData
from ...db.schema import (
    generate_day_uuid, 
    generate_month_uuid, 
    generate_year_uuid,
    SYSTEM_TYPE_UUIDS,
)
from ..auth import get_current_user
from ...models import User
from .helpers import (
    _get_node_service,
    _node_to_response,
    _get_type_ids,
    _get_type_ids_batch,
    _format_date_with_pattern,
    _format_month_with_pattern,
)


router = APIRouter()


@router.get("/daily/list")
async def list_daily_pages(
    user: User = Depends(get_current_user),
):
    """List all existing daily pages ordered by date descending."""
    service = await _get_node_service(user)
    
    # Query nodes with is_day=1, ordered by uuid (which is YYYYMMDD format)
    # Exclude type pages (is_type=1) to filter out the "day" type page itself
    async with service._pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT * FROM node 
            WHERE is_day = TRUE AND active = TRUE AND is_type = FALSE AND graph_id = $1
            ORDER BY uuid DESC
        """, service._graph_id)
    
    # Get node IDs for batch type lookup
    nodes = [service._node_repo.row_to_node(row) for row in rows]
    node_ids = [n.id for n in nodes if n.id is not None]
    
    # Batch fetch types for all nodes
    type_ids_map = await _get_type_ids_batch(service._pool, service._graph_id or 0, node_ids)
    
    result = []
    for node in nodes:
        type_ids = type_ids_map.get(node.id, []) if node.id else []
        result.append(_node_to_response(node, types=type_ids))
    
    return {"nodes": result}


@router.post("/daily")
async def get_or_create_daily(
    date: str = Query(..., description="Date in YYYY-MM-DD format"),
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
        d = datetime.strptime(date, "%Y-%m-%d").date()
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
        if day_type_id not in type_ids and existing.id is not None:
            await service.add_type(existing.id, day_type_id, _system_call=True)
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
    
    # Get user's date format preference
    async with service._pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT value FROM setting_user WHERE key = $1 AND user_id = $2",
            "date_format", int(user.id)
        )
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
        if month_type_id not in type_ids and existing.id is not None:
            await service.add_type(existing.id, month_type_id, _system_call=True)
            type_ids.append(month_type_id)
        return _node_to_response(existing, types=type_ids)
    
    year_type = await service._node_repo.get_by_uuid(SYSTEM_TYPE_UUIDS["year"])
    if not year_type:
        raise HTTPException(500, "Year type not found")
    year_type_id = year_type.id
    if year_type_id is None:
        raise HTTPException(500, "Year type has no ID")
    
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
    async with service._pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT value FROM setting_user WHERE key = $1 AND user_id = $2",
            "date_format", int(user.id)
        )
    date_format = row["value"] if row else "YYYY/MM/DD"
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
        if year_type_id not in type_ids and existing.id is not None:
            await service.add_type(existing.id, year_type_id, _system_call=True)
            type_ids.append(year_type_id)
        return _node_to_response(existing, types=type_ids)
    
    name = str(year)
    
    data = NodeCreateData(
        name=name,
        types=[page_type_id, year_type_id],
        is_page=True,
        is_year=True,
    )
    node = await service._node_repo.create_with_uuid(uuid, data)
    return _node_to_response(node)
