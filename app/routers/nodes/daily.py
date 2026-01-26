"""Daily, monthly, and yearly date page endpoints."""
from datetime import datetime

from fastapi import APIRouter, HTTPException, Depends, Query

from ...domain.entities import NodeCreateData, NodeUpdateData
from ...db.schema import (
    generate_day_uuid, 
    generate_month_uuid, 
    generate_year_uuid,
    SYSTEM_CLASS_UUIDS,
)
from ..auth import get_current_user
from ...models import User
from .helpers import (
    _get_node_service,
    _node_to_response,
    _get_class_ids,
    _get_class_ids_batch,
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
    # Exclude class pages (is_class=1) to filter out the "day" class page itself
    async with service._pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT * FROM node 
            WHERE is_day = TRUE AND active = TRUE AND is_class = FALSE AND graph_id = $1
            ORDER BY uuid DESC
        """, service._graph_id)
    
    # Get node IDs for batch type lookup
    nodes = [service._node_repo.row_to_node(row) for row in rows]
    node_ids = [n.id for n in nodes if n.id is not None]
    
    # Batch fetch types for all nodes
    class_ids_map = await _get_class_ids_batch(service._pool, service._graph_id or 0, node_ids)
    
    result = []
    for node in nodes:
        class_ids = class_ids_map.get(node.id, []) if node.id else []
        result.append(_node_to_response(node, classes=class_ids))
    
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
    import traceback
    import logging
    logger = logging.getLogger(__name__)
    
    try:
        service = await _get_node_service(user)
    except Exception as e:
        logger.error(f"DAILY ERROR getting node service: {e}")
        logger.error(traceback.format_exc())
        raise
    
    # Parse date
    try:
        d = datetime.strptime(date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(400, "Invalid date format. Use YYYY-MM-DD")
    
    try:
        # Generate date UUID
        uuid = generate_day_uuid(d)
        
        # Get type IDs by UUID (needed for both existing and new pages)
        day_type = await service._node_repo.get_by_uuid(SYSTEM_CLASS_UUIDS["day"])
        if not day_type:
            raise HTTPException(500, "Day type not found")
        day_type_id = day_type.id
        if day_type_id is None:
            raise HTTPException(500, "Day type has no ID")
        
        page_type_id = service._page_class_id
        if page_type_id is None:
            raise HTTPException(500, "Page type not configured")
        
        month_type = await service._node_repo.get_by_uuid(SYSTEM_CLASS_UUIDS["month"])
        if not month_type:
            raise HTTPException(500, "Month type not found")
        month_type_id = month_type.id
        if month_type_id is None:
            raise HTTPException(500, "Month type has no ID")
        
        year_type = await service._node_repo.get_by_uuid(SYSTEM_CLASS_UUIDS["year"])
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
        
        # 1. Ensure year page exists (always, even for existing day pages)
        year_uuid = generate_year_uuid(d.year)
        year_node = await service._node_repo.get_by_uuid(year_uuid)
        if not year_node:
            year_data = NodeCreateData(
                name=str(d.year),
                classes=[page_type_id, year_type_id],
                is_page=True,
                is_year=True,
            )
            try:
                year_node = await service._node_repo.create_with_uuid(year_uuid, year_data)
            except Exception as e:
                # Handle race condition - another request may have created it
                if "duplicate key" in str(e).lower() or "unique" in str(e).lower():
                    year_node = await service._node_repo.get_by_uuid(year_uuid)
                    if not year_node:
                        raise
                else:
                    raise
        
        # 2. Ensure month page exists (always, even for existing day pages)
        month_uuid = generate_month_uuid(d.year, d.month)
        month_node = await service._node_repo.get_by_uuid(month_uuid)
        if not month_node:
            month_name_str = _format_month_with_pattern(d.year, d.month, date_format)
            month_data = NodeCreateData(
                name=month_name_str,
                classes=[page_type_id, month_type_id],
                parent_id=year_node.id,
                is_page=True,
                is_month=True,
            )
            try:
                month_node = await service._node_repo.create_with_uuid(month_uuid, month_data)
            except Exception as e:
                # Handle race condition - another request may have created it
                if "duplicate key" in str(e).lower() or "unique" in str(e).lower():
                    month_node = await service._node_repo.get_by_uuid(month_uuid)
                    if not month_node:
                        raise
                else:
                    raise
        elif month_node.parent_id != year_node.id and month_node.id is not None:
            # Update parent_id if not set correctly
            await service.update_node(month_node.id, NodeUpdateData(parent_id=year_node.id))
            month_node = await service._node_repo.get_by_uuid(month_uuid)
        
        # Check if day page exists
        existing = await service._node_repo.get_by_uuid(uuid)
        if existing:
            # Ensure day type is assigned (for legacy pages created before types were added)
            class_ids = await _get_class_ids(service, existing.id) if existing.id else []
            if day_type_id not in class_ids and existing.id is not None:
                await service.add_type(existing.id, day_type_id, _system_call=True)
                class_ids.append(day_type_id)
            # Ensure parent_id is set to month (for legacy pages)
            if existing.parent_id != month_node.id and existing.id is not None and month_node:
                await service.update_node(existing.id, NodeUpdateData(parent_id=month_node.id))
                existing = await service._node_repo.get_by_uuid(uuid)
            return _node_to_response(existing, classes=class_ids)
        
        # 3. Create day page with month as parent
        name = _format_date_with_pattern(d.year, d.month, d.day, date_format)
        day_data = NodeCreateData(
            name=name,
            classes=[page_type_id, day_type_id],
            parent_id=month_node.id if month_node else None,
            is_page=True,
            is_day=True,
        )
        node = await service._node_repo.create_with_uuid(uuid, day_data)
        # Return with types (page and day)
        return _node_to_response(node, classes=[page_type_id, day_type_id])
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"DAILY ERROR creating daily page: {e}")
        logger.error(traceback.format_exc())
        raise


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
    month_type = await service._node_repo.get_by_uuid(SYSTEM_CLASS_UUIDS["month"])
    if not month_type:
        raise HTTPException(500, "Month type not found")
    month_type_id = month_type.id
    if month_type_id is None:
        raise HTTPException(500, "Month type has no ID")
    
    page_type_id = service._page_class_id
    if page_type_id is None:
        raise HTTPException(500, "Page type not configured")
    
    year_type = await service._node_repo.get_by_uuid(SYSTEM_CLASS_UUIDS["year"])
    if not year_type:
        raise HTTPException(500, "Year type not found")
    year_type_id = year_type.id
    if year_type_id is None:
        raise HTTPException(500, "Year type has no ID")
    
    # 1. Ensure year page exists (always, even for existing month pages)
    year_uuid = generate_year_uuid(year)
    year_node = await service._node_repo.get_by_uuid(year_uuid)
    if not year_node:
        year_data = NodeCreateData(
            name=str(year),
            classes=[page_type_id, year_type_id],
            is_page=True,
            is_year=True,
        )
        year_node = await service._node_repo.create_with_uuid(year_uuid, year_data)
    
    # Check if month page exists
    existing = await service._node_repo.get_by_uuid(uuid)
    if existing:
        # Ensure month type is assigned (for legacy pages created before types were added)
        class_ids = await _get_class_ids(service, existing.id) if existing.id else []
        if month_type_id not in class_ids and existing.id is not None:
            await service.add_type(existing.id, month_type_id, _system_call=True)
            class_ids.append(month_type_id)
        # Ensure parent_id is set to year (for legacy pages)
        if existing.parent_id != year_node.id and existing.id is not None and year_node:
            await service.update_node(existing.id, NodeUpdateData(parent_id=year_node.id))
            existing = await service._node_repo.get_by_uuid(uuid)
        return _node_to_response(existing, classes=class_ids)
    
    # 2. Create month page with year as parent
    async with service._pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT value FROM setting_user WHERE key = $1 AND user_id = $2",
            "date_format", int(user.id)
        )
    date_format = row["value"] if row else "YYYY/MM/DD"
    name = _format_month_with_pattern(year, month, date_format)
    
    data = NodeCreateData(
        name=name,
        classes=[page_type_id, month_type_id],
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
    year_type = await service._node_repo.get_by_uuid(SYSTEM_CLASS_UUIDS["year"])
    if not year_type:
        raise HTTPException(500, "Year type not found")
    
    year_type_id = year_type.id
    if year_type_id is None:
        raise HTTPException(500, "Year type has no ID")
    
    page_type_id = service._page_class_id
    if page_type_id is None:
        raise HTTPException(500, "Page type not configured")
    
    existing = await service._node_repo.get_by_uuid(uuid)
    if existing:
        # Ensure year type is assigned (for legacy pages created before types were added)
        class_ids = await _get_class_ids(service, existing.id) if existing.id else []
        if year_type_id not in class_ids and existing.id is not None:
            await service.add_type(existing.id, year_type_id, _system_call=True)
            class_ids.append(year_type_id)
        return _node_to_response(existing, classes=class_ids)
    
    name = str(year)
    
    data = NodeCreateData(
        name=name,
        classes=[page_type_id, year_type_id],
        is_page=True,
        is_year=True,
    )
    node = await service._node_repo.create_with_uuid(uuid, data)
    return _node_to_response(node)
