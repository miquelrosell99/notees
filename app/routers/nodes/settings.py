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
    async with service._pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO setting_user (user_id, key, value) 
            VALUES ($1, 'date_format', $2)
            ON CONFLICT (user_id, key) DO UPDATE SET value = $2
        """, int(user.id), pattern)
    
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
