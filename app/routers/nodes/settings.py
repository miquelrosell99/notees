"""Settings endpoints for nodes (date format, etc.)."""
from fastapi import APIRouter, Depends

from ...domain.entities import NodeUpdateData
from ..auth import get_current_user
from ...models import User
from .models import DateFormatUpdateRequest
from .helpers import (
    _get_node_service,
    _format_date_with_pattern,
    _format_month_with_pattern,
)
from ...db.schema import parse_date_uuid
from ...db.connection import acquire_connection


router = APIRouter()


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
    async with acquire_connection(service.pool) as conn:
        await conn.execute("""
            INSERT INTO setting_user (user_id, key, value) 
            VALUES ($1, 'date_format', $2)
            ON CONFLICT (user_id, key) DO UPDATE SET value = $2
        """, int(user.id), pattern)
    
    updated_count = 0
    errors = []
    
    # Get all nodes
    all_nodes = await service.get_all_pages()
    
    for node in all_nodes:
        if not node.id or not node.uuid:
            continue
            
        uuid = node.uuid
        
        try:
            # Parse the date UUID using the proper parser
            date_info = parse_date_uuid(uuid)
            if not date_info:
                continue
            
            date_type = date_info.get("type")
            year = date_info.get("year")
            month = date_info.get("month")
            day = date_info.get("day")
            
            if date_type == "month" and year and month:
                new_name = _format_month_with_pattern(year, month, pattern)
                if new_name != node.name:
                    update_data = NodeUpdateData(name=new_name)
                    await service.update_node(node.id, update_data)
                    updated_count += 1
            elif date_type == "day" and year and month and day:
                new_name = _format_date_with_pattern(year, month, day, pattern)
                if new_name != node.name:
                    update_data = NodeUpdateData(name=new_name)
                    await service.update_node(node.id, update_data)
                    updated_count += 1
            # Year nodes don't change with date format
                        
        except Exception as e:
            errors.append(f"Error updating node {uuid}: {str(e)}")
            
    return {
        "status": "success",
        "updated_count": updated_count,
        "errors": errors if errors else []
    }
