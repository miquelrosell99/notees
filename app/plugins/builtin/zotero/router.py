"""Zotero plugin REST API."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .client import ZoteroClient

router = APIRouter()


@router.get("/search")
async def search_zotero(q: str, limit: int = 20):
    """Search the configured Zotero library."""
    # TODO: read from workspace settings once plugin settings storage exists.
    client = ZoteroClient(
        base_url="http://127.0.0.1:23119/",
        library_type="users",
        library_id="",
    )
    try:
        items = await client.search(q, limit=limit)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "items": [
            {
                "key": item.key,
                "title": item.title,
                "itemType": item.item_type,
                "creators": item.creators,
                "date": item.date,
                "url": item.url,
                "doi": item.doi,
            }
            for item in items
        ]
    }
