"""Activity router - node activity tracking.

Handles logging and retrieving node activity (edits, link additions, etc.)
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import get_current_user, get_node_repository, require_read_or_write_scope, require_write_scope
from app.domain.stringify_ast import ParseMode, StringifyMode, StringifyOptions, parse_ast, stringify_ast
from app.features.activity.dependencies import get_activity_repository
from app.features.activity.port import ActivityRepository
from app.features.nodes.port import NodeRepository
from app.features.nodes.router.dependencies import resolve_node_uuid
from app.logging_config import get_logger
from app.models import User
from app.utils import utc_now

router = APIRouter(
    prefix="/activity",
    tags=["Activity"],
    dependencies=[Depends(get_current_user), Depends(require_read_or_write_scope)],
)
logger = get_logger(__name__)


# ============== Pydantic Models ==============


class NodeActivityResponse(BaseModel):
    """Node activity response."""

    id: int
    activity_uuid: str
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
    link_click_uuid: str
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


@router.get("/node/{node_uuid}", response_model=list[NodeActivityResponse])
async def get_node_activity(
    node_uuid: str,
    limit: int = 50,
    user: User = Depends(get_current_user),
    repo: ActivityRepository = Depends(get_activity_repository),
    node_repo: NodeRepository = Depends(get_node_repository),
):
    """Get activity log for a node."""
    node_id = await resolve_node_uuid(node_uuid, node_repo)
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
            activity_uuid=str(row["uuid"]),
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


@router.post("/node/{node_uuid}", response_model=NodeActivityResponse, dependencies=[Depends(require_write_scope)])
async def create_node_activity(
    node_uuid: str,
    data: NodeActivityCreate,
    user: User = Depends(get_current_user),
    repo: ActivityRepository = Depends(get_activity_repository),
    node_repo: NodeRepository = Depends(get_node_repository),
):
    """Create a new activity entry for a node.

    Only tracks activity for page nodes (is_page=1).
    """
    node_id = await resolve_node_uuid(node_uuid, node_repo)
    is_page = await repo.get_node_is_page(node_id)
    if is_page is None:
        raise HTTPException(404, "Node not found")
    if not is_page:
        raise HTTPException(400, "Activity tracking only available for page nodes")

    now = utc_now()
    activity_id, activity_uuid = await repo.create_node_activity(
        node_id, data.action, data.details, data.target_node_id, now
    )

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
                except (ValueError, TypeError):
                    target_name = raw_name

    return NodeActivityResponse(
        id=activity_id,
        activity_uuid=activity_uuid,
        node_id=node_id,
        action=data.action,
        details=data.details,
        target_node_id=data.target_node_id,
        target_node_name=target_name,
        target_node_uuid=target_uuid,
        create_date=now.isoformat(),
    )


@router.delete("/node/{node_uuid}/{activity_uuid}", dependencies=[Depends(require_write_scope)])
async def delete_node_activity(
    node_uuid: str,
    activity_uuid: str,
    user: User = Depends(get_current_user),
    repo: ActivityRepository = Depends(get_activity_repository),
    node_repo: NodeRepository = Depends(get_node_repository),
):
    """Delete a node activity entry."""
    node_id = await resolve_node_uuid(node_uuid, node_repo)
    if not await repo.verify_node_in_workspace(node_id):
        raise HTTPException(404, "Node not found")
    deleted = await repo.delete_node_activity_by_uuid(activity_uuid, node_id)
    if not deleted:
        raise HTTPException(404, "Activity not found")
    return {"success": True}


# ============== Link Click Tracking Endpoints ==============


@router.post("/link/click", response_model=LinkClickResponse, dependencies=[Depends(require_write_scope)])
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


@router.get("/link/clicks/{source_node_uuid}", response_model=list[LinkClickResponse])
async def get_link_clicks(
    source_node_uuid: str,
    user: User = Depends(get_current_user),
    repo: ActivityRepository = Depends(get_activity_repository),
    node_repo: NodeRepository = Depends(get_node_repository),
):
    """Get all link click counts from a source node (aggregated)."""
    source_node_id = await resolve_node_uuid(source_node_uuid, node_repo)
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


@router.get("/link/click/{source_node_uuid}/{target_node_uuid}", response_model=LinkClickResponse)
async def get_link_click(
    source_node_uuid: str,
    target_node_uuid: str,
    user: User = Depends(get_current_user),
    repo: ActivityRepository = Depends(get_activity_repository),
    node_repo: NodeRepository = Depends(get_node_repository),
):
    """Get click count for a specific link."""
    source_node_id = await resolve_node_uuid(source_node_uuid, node_repo)
    target_node_id = await resolve_node_uuid(target_node_uuid, node_repo)
    row = await repo.get_link_click(source_node_id, target_node_id)
    return LinkClickResponse(
        source_node_id=source_node_id,
        target_node_id=target_node_id,
        click_count=row["click_count"] if row else 0,
        last_click_date=row["last_click_date"].isoformat() if row and row["last_click_date"] else None,
    )


@router.get("/link/history/{source_node_uuid}/{target_node_uuid}", response_model=list[LinkClickHistoryResponse])
async def get_link_click_history(
    source_node_uuid: str,
    target_node_uuid: str,
    limit: int = 100,
    user: User = Depends(get_current_user),
    repo: ActivityRepository = Depends(get_activity_repository),
    node_repo: NodeRepository = Depends(get_node_repository),
):
    """Get click history for a specific link."""
    source_node_id = await resolve_node_uuid(source_node_uuid, node_repo)
    target_node_id = await resolve_node_uuid(target_node_uuid, node_repo)
    rows = await repo.get_link_click_history(source_node_id, target_node_id, limit)
    return [
        LinkClickHistoryResponse(
            id=row["id"],
            link_click_uuid=str(row["uuid"]) if row["uuid"] else None,
            source_node_id=row["source_node_id"],
            target_node_id=row["target_node_id"],
            node_link_uuid=str(row["node_link_uuid"]) if row["node_link_uuid"] else None,
            click_date=row["click_date"].isoformat() if row["click_date"] else "",
        )
        for row in rows
    ]


@router.post("/link/reset/{source_node_uuid}/{target_node_uuid}", dependencies=[Depends(require_write_scope)])
async def reset_link_click(
    source_node_uuid: str,
    target_node_uuid: str,
    user: User = Depends(get_current_user),
    repo: ActivityRepository = Depends(get_activity_repository),
    node_repo: NodeRepository = Depends(get_node_repository),
):
    """Reset click counter for a specific link (deletes all click records)."""
    source_node_id = await resolve_node_uuid(source_node_uuid, node_repo)
    target_node_id = await resolve_node_uuid(target_node_uuid, node_repo)
    await repo.reset_link_clicks(source_node_id, target_node_id)
    return {"success": True}
