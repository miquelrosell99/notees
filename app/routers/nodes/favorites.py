"""Favorites management endpoints."""

import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ...db.connection import acquire_connection
from ...models import PaginatedResponse, User
from ..auth import get_current_user
from .helpers import _get_class_ids_batch, _get_node_service, _node_to_response
from .models import NodeResponse

router = APIRouter()


@router.get("/favorites")
async def get_favorites(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    user: User = Depends(get_current_user),
):
    """Get the list of favorite pages.

    Favorites are stored as a JSON array of node IDs in the settings table.
    Only returns pages that are active (not deleted, not archived).
    """
    service = await _get_node_service(user)
    offset = (page - 1) * page_size

    async with acquire_connection(service.pool) as conn:
        row = await conn.fetchrow(
            "SELECT value FROM setting_user WHERE key = 'favorites' AND user_id = $1", int(user.id)
        )

    if not row or not row["value"]:
        return PaginatedResponse[NodeResponse](
            items=[], total=0, page=page, page_size=page_size, has_next=False, has_prev=False
        )

    try:
        favorites = json.loads(row["value"])
        if not isinstance(favorites, list):
            return PaginatedResponse[NodeResponse](
                items=[], total=0, page=page, page_size=page_size, has_next=False, has_prev=False
            )

        # Filter out deleted or archived nodes using a single batch query
        async with acquire_connection(service.pool) as conn:
            if favorites:
                rows = await conn.fetch(
                    """
                    SELECT id FROM node
                    WHERE id = ANY($1::int[]) AND workspace_id = $2
                          AND active = true
                          AND (is_deleted = false OR is_deleted IS NULL)
                    """,
                    favorites,
                    service.workspace_id,
                )
                valid_ids = {row["id"] for row in rows}
                valid_favorites = [fid for fid in favorites if fid in valid_ids]
            else:
                valid_favorites = []

        total = len(valid_favorites)
        paginated_ids = valid_favorites[offset : offset + page_size]

        # Fetch node details for paginated IDs
        nodes = []
        if paginated_ids:
            async with acquire_connection(service.pool) as conn:
                node_rows = await conn.fetch(
                    """
                    SELECT * FROM node
                    WHERE id = ANY($1::int[]) AND workspace_id = $2
                    """,
                    paginated_ids,
                    service.workspace_id,
                )
                node_map = {row["id"]: service.row_to_node(row) for row in node_rows}
                nodes = [node_map[fid] for fid in paginated_ids if fid in node_map]

        node_ids = [n.id for n in nodes if n.id is not None]
        class_ids_map = await _get_class_ids_batch(service.pool, service.workspace_id or 0, node_ids)

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
    except json.JSONDecodeError:
        return PaginatedResponse[NodeResponse](
            items=[], total=0, page=page, page_size=page_size, has_next=False, has_prev=False
        )


@router.put("/favorites")
async def set_favorites(
    request: Request,
    user: User = Depends(get_current_user),
):
    """Set the list of favorite page IDs.

    Expects JSON body: { "favorites": [nodeId1, nodeId2, ...] }
    """
    data = await request.json()
    favorites = data.get("favorites", [])

    if not isinstance(favorites, list):
        raise HTTPException(status_code=400, detail="favorites must be a list")

    # Validate all items are integers
    if not all(isinstance(f, int) for f in favorites):
        raise HTTPException(status_code=400, detail="favorites must be a list of integers")

    service = await _get_node_service(user)
    async with acquire_connection(service.pool) as conn:
        favorites_json = json.dumps(favorites)
        await conn.execute(
            """
            INSERT INTO setting_user (user_id, key, value)
            VALUES ($1, 'favorites', $2)
            ON CONFLICT (user_id, key) DO UPDATE SET value = $2
        """,
            int(user.id),
            favorites_json,
        )

    return {"status": "ok", "favorites": favorites}


@router.put("/favorites/reorder")
async def reorder_favorites(
    request: Request,
    user: User = Depends(get_current_user),
):
    """Reorder favorites by moving an item from one position to another.

    Expects JSON body: { "from_index": number, "to_index": number }
    """
    data = await request.json()
    from_index = data.get("from_index")
    to_index = data.get("to_index")

    if from_index is None or to_index is None:
        raise HTTPException(status_code=400, detail="from_index and to_index are required")

    service = await _get_node_service(user)
    async with acquire_connection(service.pool) as conn:
        # Get current favorites
        row = await conn.fetchrow(
            "SELECT value FROM setting_user WHERE key = 'favorites' AND user_id = $1", int(user.id)
        )

        favorites = []
        if row and row["value"]:
            try:
                favorites = json.loads(row["value"])
                if not isinstance(favorites, list):
                    favorites = []
            except json.JSONDecodeError:
                favorites = []

        # Validate indices
        if from_index < 0 or from_index >= len(favorites):
            raise HTTPException(status_code=400, detail="from_index out of bounds")
        if to_index < 0 or to_index >= len(favorites):
            raise HTTPException(status_code=400, detail="to_index out of bounds")

        # Reorder
        item = favorites.pop(from_index)
        favorites.insert(to_index, item)

        await conn.execute(
            """
            INSERT INTO setting_user (user_id, key, value)
            VALUES ($1, 'favorites', $2)
            ON CONFLICT (user_id, key) DO UPDATE SET value = $2
        """,
            int(user.id),
            json.dumps(favorites),
        )

    return {"status": "ok", "favorites": favorites}


@router.post("/favorites/{node_id}")
async def add_favorite(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Add a page to favorites."""
    service = await _get_node_service(user)
    async with acquire_connection(service.pool) as conn:
        # Verify the node exists and is a page
        row = await conn.fetchrow(
            "SELECT id, is_page FROM node WHERE id = $1 AND active = TRUE AND workspace_id = $2",
            node_id,
            service.workspace_id,
        )

        if not row:
            raise HTTPException(status_code=404, detail="Node not found")
        if not row["is_page"]:
            raise HTTPException(status_code=400, detail="Only pages can be favorited")

        # Get current favorites
        fav_row = await conn.fetchrow(
            "SELECT value FROM setting_user WHERE key = 'favorites' AND user_id = $1", int(user.id)
        )

        favorites = []
        if fav_row and fav_row["value"]:
            try:
                favorites = json.loads(fav_row["value"])
                if not isinstance(favorites, list):
                    favorites = []
            except json.JSONDecodeError:
                favorites = []

        # Add if not already present
        if node_id not in favorites:
            favorites.append(node_id)
            await conn.execute(
                """
                INSERT INTO setting_user (user_id, key, value)
                VALUES ($1, 'favorites', $2)
                ON CONFLICT (user_id, key) DO UPDATE SET value = $2
            """,
                int(user.id),
                json.dumps(favorites),
            )

    return {"status": "ok", "favorites": favorites}


@router.delete("/favorites/{node_id}")
async def remove_favorite(
    node_id: int,
    user: User = Depends(get_current_user),
):
    """Remove a page from favorites."""
    service = await _get_node_service(user)
    async with acquire_connection(service.pool) as conn:
        # Get current favorites
        row = await conn.fetchrow(
            "SELECT value FROM setting_user WHERE key = 'favorites' AND user_id = $1", int(user.id)
        )

        favorites = []
        if row and row["value"]:
            try:
                favorites = json.loads(row["value"])
                if not isinstance(favorites, list):
                    favorites = []
            except json.JSONDecodeError:
                favorites = []

        # Remove if present
        if node_id in favorites:
            favorites.remove(node_id)
            await conn.execute(
                """
                INSERT INTO setting_user (user_id, key, value)
                VALUES ($1, 'favorites', $2)
                ON CONFLICT (user_id, key) DO UPDATE SET value = $2
            """,
                int(user.id),
                json.dumps(favorites),
            )

    return {"status": "ok", "favorites": favorites}
