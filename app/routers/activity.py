"""Activity router - node activity tracking.

Handles logging and retrieving node activity (edits, link additions, etc.)
"""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timezone

from .auth import get_current_user
from ..models import User
from ..db.connection import get_db
from ..logging_config import get_logger


router = APIRouter(prefix="/api/activity", tags=["Activity"])
logger = get_logger(__name__)


def utc_now_iso() -> str:
    """Get current UTC time as ISO string."""
    return datetime.now(timezone.utc).isoformat()


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
    click_count: int
    last_click_date: Optional[str] = None


class LinkClickHistoryResponse(BaseModel):
    """Individual link click record."""
    id: int
    source_node_id: int
    target_node_id: int
    click_date: str


class LinkClickRequest(BaseModel):
    """Request to track a link click."""
    source_node_id: int
    target_node_id: int


# ============== Activity Endpoints ==============

@router.get("/node/{node_id}", response_model=List[NodeActivityResponse])
async def get_node_activity(
    node_id: int,
    limit: int = 50,
    user: User = Depends(get_current_user),
):
    """Get activity log for a node."""
    db = await get_db(user.id)
    
    cursor = await db.execute(
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
        LEFT JOIN node t ON a.target_node_id = t.id
        WHERE a.node_id = ?
        ORDER BY a.create_date DESC
        LIMIT ?
        """,
        (node_id, limit)
    )
    rows = await cursor.fetchall()
    
    return [
        NodeActivityResponse(
            id=row['id'],
            node_id=row['node_id'],
            action=row['action'],
            details=row['details'],
            target_node_id=row['target_node_id'],
            target_node_name=row['target_node_name'],
            create_date=row['create_date'],
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
    db = await get_db(user.id)
    
    # Check if the node is a page
    cursor = await db.execute(
        "SELECT is_page FROM node WHERE id = ?",
        (node_id,)
    )
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(404, "Node not found")
    if not row['is_page']:
        raise HTTPException(400, "Activity tracking only available for page nodes")
    
    now = utc_now_iso()
    
    cursor = await db.execute(
        """
        INSERT INTO node_activity (node_id, action, details, target_node_id, create_date)
        VALUES (?, ?, ?, ?, ?)
        """,
        (node_id, data.action, data.details, data.target_node_id, now)
    )
    activity_id = cursor.lastrowid
    await db.commit()
    
    # Get target node name if exists
    target_name = None
    if data.target_node_id:
        cursor = await db.execute(
            "SELECT name FROM node WHERE id = ?",
            (data.target_node_id,)
        )
        row = await cursor.fetchone()
        if row:
            target_name = row['name']
    
    return NodeActivityResponse(
        id=activity_id,
        node_id=node_id,
        action=data.action,
        details=data.details,
        target_node_id=data.target_node_id,
        target_node_name=target_name,
        create_date=now,
    )


@router.delete("/node/{node_id}/{activity_id}")
async def delete_node_activity(
    node_id: int,
    activity_id: int,
    user: User = Depends(get_current_user),
):
    """Delete a node activity entry."""
    db = await get_db(user.id)
    
    await db.execute(
        "DELETE FROM node_activity WHERE id = ? AND node_id = ?",
        (activity_id, node_id)
    )
    await db.commit()
    
    return {"success": True}


# ============== Link Click Tracking Endpoints ==============

@router.post("/link/click", response_model=LinkClickResponse)
async def track_link_click(
    data: LinkClickRequest,
    user: User = Depends(get_current_user),
):
    """Track a link click by inserting a new record."""
    db = await get_db(user.id)
    now = utc_now_iso()
    
    # Insert new click record
    await db.execute(
        """
        INSERT INTO link_click (source_node_id, target_node_id, click_date, user_id)
        VALUES (?, ?, ?, ?)
        """,
        (data.source_node_id, data.target_node_id, now, None)  # user_id from session if needed
    )
    await db.commit()
    
    # Get total count
    cursor = await db.execute(
        """
        SELECT COUNT(*) as count FROM link_click
        WHERE source_node_id = ? AND target_node_id = ?
        """,
        (data.source_node_id, data.target_node_id)
    )
    row = await cursor.fetchone()
    click_count = row['count'] if row else 1
    
    return LinkClickResponse(
        source_node_id=data.source_node_id,
        target_node_id=data.target_node_id,
        click_count=click_count,
        last_click_date=now,
    )


@router.get("/link/clicks/{source_node_id}", response_model=List[LinkClickResponse])
async def get_link_clicks(
    source_node_id: int,
    user: User = Depends(get_current_user),
):
    """Get all link click counts from a source node (aggregated)."""
    db = await get_db(user.id)
    
    cursor = await db.execute(
        """
        SELECT 
            source_node_id, 
            target_node_id, 
            COUNT(*) as click_count,
            MAX(click_date) as last_click_date
        FROM link_click
        WHERE source_node_id = ?
        GROUP BY source_node_id, target_node_id
        """,
        (source_node_id,)
    )
    rows = await cursor.fetchall()
    
    return [
        LinkClickResponse(
            source_node_id=row['source_node_id'],
            target_node_id=row['target_node_id'],
            click_count=row['click_count'],
            last_click_date=row['last_click_date'],
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
    db = await get_db(user.id)
    
    cursor = await db.execute(
        """
        SELECT 
            COUNT(*) as click_count,
            MAX(click_date) as last_click_date
        FROM link_click
        WHERE source_node_id = ? AND target_node_id = ?
        """,
        (source_node_id, target_node_id)
    )
    row = await cursor.fetchone()
    
    return LinkClickResponse(
        source_node_id=source_node_id,
        target_node_id=target_node_id,
        click_count=row['click_count'] if row else 0,
        last_click_date=row['last_click_date'] if row else None,
    )


@router.get("/link/history/{source_node_id}/{target_node_id}", response_model=List[LinkClickHistoryResponse])
async def get_link_click_history(
    source_node_id: int,
    target_node_id: int,
    limit: int = 100,
    user: User = Depends(get_current_user),
):
    """Get click history for a specific link."""
    db = await get_db(user.id)
    
    cursor = await db.execute(
        """
        SELECT id, source_node_id, target_node_id, click_date
        FROM link_click
        WHERE source_node_id = ? AND target_node_id = ?
        ORDER BY click_date DESC
        LIMIT ?
        """,
        (source_node_id, target_node_id, limit)
    )
    rows = await cursor.fetchall()
    
    return [
        LinkClickHistoryResponse(
            id=row['id'],
            source_node_id=row['source_node_id'],
            target_node_id=row['target_node_id'],
            click_date=row['click_date'],
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
    db = await get_db(user.id)
    
    await db.execute(
        "DELETE FROM link_click WHERE source_node_id = ? AND target_node_id = ?",
        (source_node_id, target_node_id)
    )
    await db.commit()
    
    return {"success": True}
