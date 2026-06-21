"""KOReader plugin REST API."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .client import KOReaderClient

router = APIRouter()


@router.get("/highlights")
async def get_highlights(limit: int = 100):
    """Fetch recent highlights from the configured KOReader server."""
    # TODO: read from workspace settings once plugin settings storage exists.
    client = KOReaderClient("http://127.0.0.1:8080/")
    try:
        highlights = await client.fetch_highlights(limit=limit)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"highlights": highlights}
