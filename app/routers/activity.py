"""Activity router - node activity tracking.

Handles logging and retrieving node activity (edits, link additions, etc.)
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..dependencies import get_activity_repository
from ..domain.repositories import ActivityRepository
from ..domain.stringify_ast import ParseMode, StringifyMode, StringifyOptions, parse_ast, stringify_ast
from ..logging_config import get_logger
from ..models import User
from ..utils import utc_now
from .auth import get_current_user

router = APIRouter(prefix="/api/activity", tags=["Activity"])
logger = get_logger(__name__)


# ============== Pydantic Models ==============


class NodeActivityResponse(BaseModel):
    """Node activity response."""

    id: int
    node_id: int
    action: str  # created, edited, link_added, link_removed, link_inserted, archived, unarchived, type_added, type_removed, property_changed, moved
    details: str | None = None
    target_node_id: int | None = None
    target_node_name: str | None = None
    target_node_uuid: str | None = None
    create_date: str


class NodeActivityCreate(BaseModel):
    """Request to create a node activity entry."""

    node_id: int
    action: str
    details: str | None = None
    target_node_id: int | None = None


class LinkClickResponse(BaseModel):
    """Link click tracking response."""

    source_node_id: int
    target_node_id: int
    node_link_uuid: str | None = None  # UUID of the specific link instance
    click_count: int
    last_click_date: str | None = None


class LinkClickHistoryResponse(BaseModel):
    """Individual link click record."""

    id: int
    source_node_id: int
    target_node_id: int
    node_link_uuid: str | None = None
    click_date: str


class LinkClickRequest(BaseModel):
    """Request to track a link click."""

    source_node_id: int
    target_node_id: int
    node_link_uuid: str | None = None  # UUID of the specific link instance clicked


# ============== Activity Endpoints ==============


@router.get("/node/{node_id}", response_model=list[NodeActivityResponse])
async def get_node_activity(
    node_id: int,
    limit: int = 50,
    user: User = Depends(get_current_user),
    repo: ActivityRepository = Depends(get_activity_repository),
):
    """Get activity log for a node."""
    if not await repo.verify_node_in_workspace(node_id):
        raise HTTPException(404, "Node not found")

    rows = await repo.get_node_activity(node_id, limit)

    def _ast_to_text(raw_name: str | None) -> str | None:
        if not raw_name:
            return None
        try:
            ast = parse_ast(raw_name, ParseMode.JSON)
            text = stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY))
            return text.strip() or None
        except (ValueError, TypeError, KeyError):
            return raw_name

    return [
        NodeActivityResponse(
            id=row["id"],
            node_id=row["node_id"],
            action=row["action"],
            details=row["details"],
            target_node_id=row["target_node_id"],
            target_node_name=_ast_to_text(row["target_node_name"]),
            target_node_uuid=str(row["target_node_uuid"]) if row["target_node_uuid"] else None,
            create_date=row["create_date"].isoformat() if row["create_date"] else "",
        )
        for row in rows
    ]


@router.post("/node/{node_id}", response_model=NodeActivityResponse)
async def create_node_activity(
    node_id: int,
    data: NodeActivityCreate,
    user: User = Depends(get_current_user),
    repo: ActivityRepository = Depends(get_activity_repository),
):
    """Create a new activity entry for a node.

    Only tracks activity for page nodes (is_page=1).
    """
    is_page = await repo.get_node_is_page(node_id)
    if is_page is None:
        raise HTTPException(404, "Node not found")
    if not is_page:
        raise HTTPException(400, "Activity tracking only available for page nodes")

    now = utc_now()
    activity_id = await repo.create_node_activity(node_id, data.action, data.details, data.target_node_id, now)

    target_name = None
    target_uuid = None
    if data.target_node_id:
        result = await repo.get_target_node(data.target_node_id)
        if result:
            raw_name, target_uuid = result
            if raw_name:
                try:
                    ast = parse_ast(raw_name, ParseMode.JSON)
                    target_name = stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY)).strip() or None
                except Exception:
                    target_name = raw_name

    return NodeActivityResponse(
        id=activity_id,
        node_id=node_id,
        action=data.action,
        details=data.details,
        target_node_id=data.target_node_id,
        target_node_name=target_name,
        target_node_uuid=target_uuid,
        create_date=now.isoformat(),
    )


@router.delete("/node/{node_id}/{activity_id}")
async def delete_node_activity(
    node_id: int,
    activity_id: int,
    user: User = Depends(get_current_user),
    repo: ActivityRepository = Depends(get_activity_repository),
):
    """Delete a node activity entry."""
    if not await repo.verify_node_in_workspace(node_id):
        raise HTTPException(404, "Node not found")
    await repo.delete_node_activity(activity_id, node_id)
    return {"success": True}


# ============== Link Click Tracking Endpoints ==============


@router.post("/link/click", response_model=LinkClickResponse)
async def track_link_click(
    data: LinkClickRequest,
    user: User = Depends(get_current_user),
    repo: ActivityRepository = Depends(get_activity_repository),
):
    """Track a link click by inserting a new record.

    Optionally accepts node_link_uuid to track clicks on specific link instances.
    """
    now = utc_now()
    click_count = await repo.track_link_click(
        data.source_node_id, data.target_node_id, data.node_link_uuid, now, int(user.id)
    )
    return LinkClickResponse(
        source_node_id=data.source_node_id,
        target_node_id=data.target_node_id,
        node_link_uuid=data.node_link_uuid,
        click_count=click_count,
        last_click_date=now.isoformat(),
    )


@router.get("/link/clicks/{source_node_id}", response_model=list[LinkClickResponse])
async def get_link_clicks(
    source_node_id: int,
    user: User = Depends(get_current_user),
    repo: ActivityRepository = Depends(get_activity_repository),
):
    """Get all link click counts from a source node (aggregated)."""
    rows = await repo.get_link_clicks_aggregated(source_node_id)
    return [
        LinkClickResponse(
            source_node_id=row["source_node_id"],
            target_node_id=row["target_node_id"],
            click_count=row["click_count"],
            last_click_date=row["last_click_date"].isoformat() if row["last_click_date"] else None,
        )
        for row in rows
    ]


@router.get("/link/click/{source_node_id}/{target_node_id}", response_model=LinkClickResponse)
async def get_link_click(
    source_node_id: int,
    target_node_id: int,
    user: User = Depends(get_current_user),
    repo: ActivityRepository = Depends(get_activity_repository),
):
    """Get click count for a specific link."""
    row = await repo.get_link_click(source_node_id, target_node_id)
    return LinkClickResponse(
        source_node_id=source_node_id,
        target_node_id=target_node_id,
        click_count=row["click_count"] if row else 0,
        last_click_date=row["last_click_date"].isoformat() if row and row["last_click_date"] else None,
    )


@router.get("/link/history/{source_node_id}/{target_node_id}", response_model=list[LinkClickHistoryResponse])
async def get_link_click_history(
    source_node_id: int,
    target_node_id: int,
    limit: int = 100,
    user: User = Depends(get_current_user),
    repo: ActivityRepository = Depends(get_activity_repository),
):
    """Get click history for a specific link."""
    rows = await repo.get_link_click_history(source_node_id, target_node_id, limit)
    return [
        LinkClickHistoryResponse(
            id=row["id"],
            source_node_id=row["source_node_id"],
            target_node_id=row["target_node_id"],
            click_date=row["click_date"].isoformat() if row["click_date"] else "",
        )
        for row in rows
    ]


@router.post("/link/reset/{source_node_id}/{target_node_id}")
async def reset_link_click(
    source_node_id: int,
    target_node_id: int,
    user: User = Depends(get_current_user),
    repo: ActivityRepository = Depends(get_activity_repository),
):
    """Reset click counter for a specific link (deletes all click records)."""
    await repo.reset_link_clicks(source_node_id, target_node_id)
    return {"success": True}
