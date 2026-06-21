"""Minimal KOReader sync server client."""

from __future__ import annotations

from dataclasses import dataclass

import httpx


@dataclass
class KOReaderHighlight:
    """Simplified KOReader highlight."""

    book_title: str
    chapter: str | None
    page: str | None
    text: str
    note: str | None
    datetime: str | None


class KOReaderClient:
    """Client for a KOReader progress sync / KOHighlights-compatible server."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    async def fetch_highlights(self, limit: int = 100) -> list[KOReaderHighlight]:
        """Fetch recent highlights from the sync server.

        This assumes a KOHighlights-compatible JSON endpoint at
        /highlights?limit=N. Adapt to your actual sync server.
        """
        url = f"{self.base_url}/highlights"
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, params={"limit": limit})
            resp.raise_for_status()
            payload = resp.json()

        results: list[KOReaderHighlight] = []
        for entry in payload if isinstance(payload, list) else []:
            if not isinstance(entry, dict):
                continue
            results.append(
                KOReaderHighlight(
                    book_title=str(entry.get("book", "")),
                    chapter=str(entry.get("chapter")) if entry.get("chapter") else None,
                    page=str(entry.get("page")) if entry.get("page") else None,
                    text=str(entry.get("text", "")),
                    note=str(entry.get("note")) if entry.get("note") else None,
                    datetime=str(entry.get("datetime")) if entry.get("datetime") else None,
                )
            )
        return results
