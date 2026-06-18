"""Favorites management endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Query

from app.dependencies import get_current_user, get_node_repository, get_settings_repository
from app.domain.repositories.interfaces import SettingsRepository
from app.features.nodes.port import NodeRepository
from app.models import PaginatedResponse, User

from .helpers import _get_class_ids_batch, _get_node_service, _node_to_response
from .models import NodeResponse, ReorderFavoritesRequest, SetFavoritesRequest

router = APIRouter()


@router.get("/favorites")
async def get_favorites(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    user: User = Depends(get_current_user),
    settings_repo: SettingsRepository = Depends(get_settings_repository),
    node_repo: NodeRepository = Depends(get_node_repository),
):
    """Get the list of favorite pages.

    Favorites are stored as a JSON array of node IDs in the settings table.
    Only returns pages that are active (not deleted, not archived).
    """
    service = await _get_node_service(user)
    offset = (page - 1) * page_size
    user_id = int(user.id)

    favorites = await settings_repo.get_user_favorites(user_id)
    if not favorites:
        return PaginatedResponse[NodeResponse](
            items=[], total=0, page=page, page_size=page_size, has_next=False, has_prev=False
        )

    # Filter out deleted or archived nodes using a single batch query
    valid_ids = await node_repo.filter_existing_active_node_ids(favorites)
    valid_favorites = [fid for fid in favorites if fid in valid_ids]

    total = len(valid_favorites)
    paginated_ids = valid_favorites[offset : offset + page_size]

    # Fetch node details for paginated IDs
    nodes = []
    if paginated_ids:
        node_rows = await node_repo.get_by_ids(paginated_ids)
        node_map = {n.id: n for n in node_rows if n.id is not None}
        nodes = [node_map[fid] for fid in paginated_ids if fid in node_map]

    node_ids = [n.id for n in nodes if n.id is not None]
    class_ids_map = await _get_class_ids_batch(service, node_ids)

    result = []
    for n in nodes:
        if n.id is None:
            continue
        result.append(_node_to_response(n, classes=class_ids_map.get(n.id, [])))

    return PaginatedResponse[NodeResponse](
        items=result,
        total=total,
        page=page,
        page_size=page_size,
        has_next=(page * page_size) < total,
        has_prev=page > 1,
    )


@router.put("/favorites")
async def set_favorites(
    body: SetFavoritesRequest,
    user: User = Depends(get_current_user),
    settings_repo: SettingsRepository = Depends(get_settings_repository),
):
    """Set the list of favorite page IDs.

    Expects JSON body: { "favorites": [nodeId1, nodeId2, ...] }
    """
    await settings_repo.set_user_favorites(int(user.id), body.favorites)

    return {"status": "ok", "favorites": body.favorites}


@router.put("/favorites/reorder")
async def reorder_favorites(
    body: ReorderFavoritesRequest,
    user: User = Depends(get_current_user),
    settings_repo: SettingsRepository = Depends(get_settings_repository),
):
    """Reorder favorites by moving an item from one position to another.

    Expects JSON body: { "from_index": number, "to_index": number }
    """
    favorites = await settings_repo.get_user_favorites(int(user.id))

    # Validate indices
    if body.from_index >= len(favorites):
        raise HTTPException(status_code=400, detail="from_index out of bounds")
    if body.to_index >= len(favorites):
        raise HTTPException(status_code=400, detail="to_index out of bounds")

    # Reorder
    item = favorites.pop(body.from_index)
    favorites.insert(body.to_index, item)

    await settings_repo.set_user_favorites(int(user.id), favorites)

    return {"status": "ok", "favorites": favorites}


@router.post("/favorites/{node_id}")
async def add_favorite(
    node_id: int,
    user: User = Depends(get_current_user),
    settings_repo: SettingsRepository = Depends(get_settings_repository),
    node_repo: NodeRepository = Depends(get_node_repository),
):
    """Add a page to favorites."""
    # Verify the node exists and is a page
    row = await node_repo.get_page_node_check(node_id)

    if not row:
        raise HTTPException(status_code=404, detail="Node not found")
    if not row["is_page"]:
        raise HTTPException(status_code=400, detail="Only pages can be favorited")

    favorites = await settings_repo.get_user_favorites(int(user.id))

    # Add if not already present
    if node_id not in favorites:
        favorites.append(node_id)
        await settings_repo.set_user_favorites(int(user.id), favorites)

    return {"status": "ok", "favorites": favorites}


@router.delete("/favorites/{node_id}")
async def remove_favorite(
    node_id: int,
    user: User = Depends(get_current_user),
    settings_repo: SettingsRepository = Depends(get_settings_repository),
):
    """Remove a page from favorites."""
    favorites = await settings_repo.get_user_favorites(int(user.id))

    # Remove if present
    if node_id in favorites:
        favorites.remove(node_id)
        await settings_repo.set_user_favorites(int(user.id), favorites)

    return {"status": "ok", "favorites": favorites}
