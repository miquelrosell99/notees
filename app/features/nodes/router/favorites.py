"""Favorites management endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Query

from app.dependencies import get_current_user, get_node_repository, get_settings_repository, require_write_scope
from app.domain.repositories.interfaces import SettingsRepository
from app.features.nodes.port import NodeRepository
from app.features.nodes.router.dependencies import resolve_node_uuid, resolve_node_uuids
from app.models import PaginatedResponse, User

from .helpers import (
    _build_node_uuid_map,
    _enrich_node_responses_uuids,
    _get_class_ids_batch,
    _get_node_service,
    _node_to_response,
    _resolve_display_names_for_responses,
)
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

    favorite_ids = await settings_repo.get_user_favorites(user_id)
    if not favorite_ids:
        return PaginatedResponse[NodeResponse](
            items=[], total=0, page=page, page_size=page_size, has_next=False, has_prev=False
        )

    # Filter out deleted or archived nodes using a single batch query
    valid_ids = await node_repo.filter_existing_active_node_ids(favorite_ids)
    valid_favorite_ids = [fid for fid in favorite_ids if fid in valid_ids]

    total = len(valid_favorite_ids)
    paginated_ids = valid_favorite_ids[offset : offset + page_size]

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

    await _resolve_display_names_for_responses(service, nodes, result)
    await _enrich_node_responses_uuids(result, node_repo)

    return PaginatedResponse[NodeResponse](
        items=result,
        total=total,
        page=page,
        page_size=page_size,
        has_next=(page * page_size) < total,
        has_prev=page > 1,
    )


@router.put("/favorites", dependencies=[Depends(require_write_scope)])
async def set_favorites(
    body: SetFavoritesRequest,
    user: User = Depends(get_current_user),
    settings_repo: SettingsRepository = Depends(get_settings_repository),
    node_repo: NodeRepository = Depends(get_node_repository),
):
    """Set the list of favorite page UUIDs.

    Expects JSON body: { "favorites": [nodeUuid1, nodeUuid2, ...] }
    """
    favorite_ids = await resolve_node_uuids(body.favorites, node_repo)
    await settings_repo.set_user_favorites(int(user.id), favorite_ids)

    return {"status": "ok", "favorites": body.favorites}


@router.put("/favorites/reorder", dependencies=[Depends(require_write_scope)])
async def reorder_favorites(
    body: ReorderFavoritesRequest,
    user: User = Depends(get_current_user),
    settings_repo: SettingsRepository = Depends(get_settings_repository),
    node_repo: NodeRepository = Depends(get_node_repository),
):
    """Reorder favorites by moving an item from one position to another.

    Expects JSON body: { "from_index": number, "to_index": number }
    Returns the reordered list as UUIDs.
    """
    favorite_ids = await settings_repo.get_user_favorites(int(user.id))

    # Validate indices
    if body.from_index >= len(favorite_ids):
        raise HTTPException(status_code=400, detail="from_index out of bounds")
    if body.to_index >= len(favorite_ids):
        raise HTTPException(status_code=400, detail="to_index out of bounds")

    # Reorder
    item = favorite_ids.pop(body.from_index)
    favorite_ids.insert(body.to_index, item)

    await settings_repo.set_user_favorites(int(user.id), favorite_ids)

    uuid_map = await _build_node_uuid_map(node_repo, favorite_ids)
    return {"status": "ok", "favorites": [uuid_map.get(fid) for fid in favorite_ids if uuid_map.get(fid)]}


@router.post("/favorites/{node_uuid}", dependencies=[Depends(require_write_scope)])
async def add_favorite(
    node_id: int = Depends(resolve_node_uuid),
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

    uuid_map = await _build_node_uuid_map(node_repo, favorites)
    return {"status": "ok", "favorites": [uuid_map.get(fid) for fid in favorites if uuid_map.get(fid)]}


@router.delete("/favorites/{node_uuid}", dependencies=[Depends(require_write_scope)])
async def remove_favorite(
    node_id: int = Depends(resolve_node_uuid),
    user: User = Depends(get_current_user),
    settings_repo: SettingsRepository = Depends(get_settings_repository),
    node_repo: NodeRepository = Depends(get_node_repository),
):
    """Remove a page from favorites."""
    favorites = await settings_repo.get_user_favorites(int(user.id))

    # Remove if present
    if node_id in favorites:
        favorites.remove(node_id)
        await settings_repo.set_user_favorites(int(user.id), favorites)

    uuid_map = await _build_node_uuid_map(node_repo, favorites)
    return {"status": "ok", "favorites": [uuid_map.get(fid) for fid in favorites if uuid_map.get(fid)]}
