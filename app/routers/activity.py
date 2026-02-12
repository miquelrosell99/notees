"""Activity router - node activity tracking.

Handles logging and retrieving node activity (edits, link additions, etc.)
"""
from typing import cast, Optional, List

import asyncpg
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel

from .auth import get_current_user
from ..models import User
from ..db.connection import acquire_connection, get_pool
from ..db.schema import get_or_create_user_workspace
from ..logging_config import get_logger
from ..utils import utc_now


router = APIRouter(prefix="/api/activity", tags=["Activity"])
logger = get_logger(__name__)


# ============== Pydantic Models ==============

class NodeActivityResponse(BaseModel):
    """Node activity response."""
    id: int
    node_id: int
    action: str  # created, edited, link_added, link_removed, link_inserted, archived, unarchived, type_added, type_removed, property_changed, moved
    details: Optional[str] = None
    target_node_id: Optional[int] = None
    target_node_name: Optional[str] = None
    create_date: str


class NodeActivityCreate(BaseModel):
    """Request to create a node activity entry."""
    node_id: int
    action: str
    details: Optional[str] = None
    target_node_id: Optional[int] = None


class LinkClickResponse(BaseModel):
    """Link click tracking response."""
    source_node_id: int
    target_node_id: int
    node_link_uuid: Optional[str] = None  # UUID of the specific link instance
    click_count: int
    last_click_date: Optional[str] = None


class LinkClickHistoryResponse(BaseModel):
    """Individual link click record."""
    id: int
    source_node_id: int
    target_node_id: int
    node_link_uuid: Optional[str] = None
    click_date: str


class LinkClickRequest(BaseModel):
    """Request to track a link click."""
    source_node_id: int
    target_node_id: int
    node_link_uuid: Optional[str] = None  # UUID of the specific link instance clicked


# ============== Activity Endpoints ==============

@router.get("/node/{node_id}", response_model=List[NodeActivityResponse])
async def get_node_activity(
    node_id: int,
    limit: int = 50,
    user: User = Depends(get_current_user),
):
    """Get activity log for a node."""
    pool = await get_pool()
    
    async with acquire_connection(pool) as conn:
        workspace_id = await get_or_create_user_workspace(cast(asyncpg.Connection, conn), int(user.id))
        # First verify the node belongs to this workspace
        node_check = await conn.fetchrow(
            "SELECT id FROM node WHERE id = $1 AND workspace_id = $2",
            node_id, workspace_id
        )
        if not node_check:
            raise HTTPException(404, "Node not found")
        
        rows = await conn.fetch(
            """
            SELECT 
                a.id,
                a.node_id,
                a.action,
                a.details,
                a.target_node_id,
                t.name as target_node_name,
                a.create_date
            FROM node_activity a
            LEFT JOIN node t ON a.target_node_id = t.id AND t.workspace_id = $2
            WHERE a.node_id = $1
            ORDER BY a.create_date DESC
            LIMIT $3
            """,
            node_id, workspace_id, limit
        )
    
    return [
        NodeActivityResponse(
            id=row['id'],
            node_id=row['node_id'],
            action=row['action'],
            details=row['details'],
            target_node_id=row['target_node_id'],
            target_node_name=row['target_node_name'],
            create_date=row['create_date'].isoformat() if row['create_date'] else "",
        )
        for row in rows
    ]


@router.post("/node/{node_id}", response_model=NodeActivityResponse)
async def create_node_activity(
    node_id: int,
    data: NodeActivityCreate,
    user: User = Depends(get_current_user),
):
    """Create a new activity entry for a node.
    
    Only tracks activity for page nodes (is_page=1).
    """
    pool = await get_pool()
    
    async with acquire_connection(pool) as conn:
        workspace_id = await get_or_create_user_workspace(cast(asyncpg.Connection, conn), int(user.id))
        # Check if the node is a page
        row = await conn.fetchrow(
            "SELECT is_page FROM node WHERE id = $1 AND workspace_id = $2",
            node_id, workspace_id
        )
        if not row:
            raise HTTPException(404, "Node not found")
        if not row['is_page']:
            raise HTTPException(400, "Activity tracking only available for page nodes")
        
        now = utc_now()
        
        activity_id = await conn.fetchval(
            """
            INSERT INTO node_activity (node_id, action, details, target_node_id, create_date)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
            """,
            node_id, data.action, data.details, data.target_node_id, now
        )
        
        # Get target node name if exists
        target_name = None
        if data.target_node_id:
            row = await conn.fetchrow(
                "SELECT name FROM node WHERE id = $1 AND workspace_id = $2",
                data.target_node_id, workspace_id
            )
            if row:
                target_name = row['name']
    
    return NodeActivityResponse(
        id=activity_id,
        node_id=node_id,
        action=data.action,
        details=data.details,
        target_node_id=data.target_node_id,
        target_node_name=target_name,
        create_date=now.isoformat(),
    )


@router.delete("/node/{node_id}/{activity_id}")
async def delete_node_activity(
    node_id: int,
    activity_id: int,
    user: User = Depends(get_current_user),
):
    """Delete a node activity entry."""
    pool = await get_pool()
    
    async with acquire_connection(pool) as conn:
        workspace_id = await get_or_create_user_workspace(cast(asyncpg.Connection, conn), int(user.id))
        # Verify node belongs to workspace before deleting activity
        node_check = await conn.fetchrow(
            "SELECT id FROM node WHERE id = $1 AND workspace_id = $2",
            node_id, workspace_id
        )
        if not node_check:
            raise HTTPException(404, "Node not found")
        
        await conn.execute(
            "DELETE FROM node_activity WHERE id = $1 AND node_id = $2",
            activity_id, node_id
        )
    
    return {"success": True}


# ============== Link Click Tracking Endpoints ==============

@router.post("/link/click", response_model=LinkClickResponse)
async def track_link_click(
    data: LinkClickRequest,
    user: User = Depends(get_current_user),
):
    """Track a link click by inserting a new record.
    
    Optionally accepts node_link_uuid to track clicks on specific link instances.
    """
    pool = await get_pool()
    now = utc_now()
    
    async with acquire_connection(pool) as conn:
        # Insert new click record with optional node_link_uuid
        await conn.execute(
            """
            INSERT INTO link_click (source_node_id, target_node_id, node_link_uuid, click_date, user_id)
            VALUES ($1, $2, $3, $4, $5)
            """,
            data.source_node_id, data.target_node_id, data.node_link_uuid, now, int(user.id)
        )
        
        # Get total count (per link instance if uuid provided, else per source-target pair)
        if data.node_link_uuid:
            row = await conn.fetchrow(
                """
                SELECT COUNT(*) as count FROM link_click
                WHERE node_link_uuid = $1
                """,
                data.node_link_uuid
            )
        else:
            row = await conn.fetchrow(
                """
                SELECT COUNT(*) as count FROM link_click
                WHERE source_node_id = $1 AND target_node_id = $2
                """,
                data.source_node_id, data.target_node_id
            )
        click_count = row['count'] if row else 1
    
    return LinkClickResponse(
        source_node_id=data.source_node_id,
        target_node_id=data.target_node_id,
        node_link_uuid=data.node_link_uuid,
        click_count=click_count,
        last_click_date=now.isoformat(),
    )


@router.get("/link/clicks/{source_node_id}", response_model=List[LinkClickResponse])
async def get_link_clicks(
    source_node_id: int,
    user: User = Depends(get_current_user),
):
    """Get all link click counts from a source node (aggregated)."""
    pool = await get_pool()
    
    async with acquire_connection(pool) as conn:
        rows = await conn.fetch(
            """
            SELECT 
                source_node_id, 
                target_node_id, 
                COUNT(*) as click_count,
                MAX(click_date) as last_click_date
            FROM link_click
            WHERE source_node_id = $1
            GROUP BY source_node_id, target_node_id
            """,
            source_node_id
        )
    
    return [
        LinkClickResponse(
            source_node_id=row['source_node_id'],
            target_node_id=row['target_node_id'],
            click_count=row['click_count'],
            last_click_date=row['last_click_date'].isoformat() if row['last_click_date'] else None,
        )
        for row in rows
    ]


@router.get("/link/click/{source_node_id}/{target_node_id}", response_model=LinkClickResponse)
async def get_link_click(
    source_node_id: int,
    target_node_id: int,
    user: User = Depends(get_current_user),
):
    """Get click count for a specific link."""
    pool = await get_pool()
    
    async with acquire_connection(pool) as conn:
        row = await conn.fetchrow(
            """
            SELECT 
                COUNT(*) as click_count,
                MAX(click_date) as last_click_date
            FROM link_click
            WHERE source_node_id = $1 AND target_node_id = $2
            """,
            source_node_id, target_node_id
        )
    
    return LinkClickResponse(
        source_node_id=source_node_id,
        target_node_id=target_node_id,
        click_count=row['click_count'] if row else 0,
        last_click_date=row['last_click_date'].isoformat() if row and row['last_click_date'] else None,
    )


@router.get("/link/history/{source_node_id}/{target_node_id}", response_model=List[LinkClickHistoryResponse])
async def get_link_click_history(
    source_node_id: int,
    target_node_id: int,
    limit: int = 100,
    user: User = Depends(get_current_user),
):
    """Get click history for a specific link."""
    pool = await get_pool()
    
    async with acquire_connection(pool) as conn:
        rows = await conn.fetch(
            """
            SELECT id, source_node_id, target_node_id, click_date
            FROM link_click
            WHERE source_node_id = $1 AND target_node_id = $2
            ORDER BY click_date DESC
            LIMIT $3
            """,
            source_node_id, target_node_id, limit
        )
    
    return [
        LinkClickHistoryResponse(
            id=row['id'],
            source_node_id=row['source_node_id'],
            target_node_id=row['target_node_id'],
            click_date=row['click_date'].isoformat() if row['click_date'] else "",
        )
        for row in rows
    ]


@router.post("/link/reset/{source_node_id}/{target_node_id}")
async def reset_link_click(
    source_node_id: int,
    target_node_id: int,
    user: User = Depends(get_current_user),
):
    """Reset click counter for a specific link (deletes all click records)."""
    pool = await get_pool()
    
    async with acquire_connection(pool) as conn:
        await conn.execute(
            "DELETE FROM link_click WHERE source_node_id = $1 AND target_node_id = $2",
            source_node_id, target_node_id
        )
    
    return {"success": True}
