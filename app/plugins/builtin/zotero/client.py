"""Minimal Zotero local API client.

Falls back to plain HTTP requests so the plugin degrades gracefully when
pyzotero is not installed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx


@dataclass
class ZoteroItem:
    """Simplified Zotero item."""

    key: str
    title: str
    item_type: str
    creators: list[dict[str, str]]
    date: str | None
    url: str | None
    doi: str | None
    abstract: str | None
    tags: list[str]
    citekey: str | None = None
    isbn: str | None = None
    publisher: str | None = None
    parent_key: str | None = None
    attachment_path: str | None = None


class ZoteroClient:
    """Client for the Zotero local HTTP API."""

    def __init__(self, base_url: str, library_type: str, library_id: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.library_type = library_type
        self.library_id = library_id

    def _url(self, path: str) -> str:
        return f"{self.base_url}/{self.library_type}/{self.library_id}/{path}"

    async def fetch_items(self, limit: int = 100) -> list[ZoteroItem]:
        """Fetch top-level items from the Zotero library."""
        url = self._url("items/top")
        params = {"limit": limit, "format": "json", "include": "data"}

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            payload = resp.json()

        results: list[ZoteroItem] = []
        for entry in payload if isinstance(payload, list) else []:
            data = entry.get("data", entry) if isinstance(entry, dict) else entry
            if not isinstance(data, dict):
                continue
            item_type = data.get("itemType", "")
            if item_type in ("attachment", "note"):
                continue
            results.append(_parse_item(data))
        return results

    async def search(self, query: str, limit: int = 20) -> list[ZoteroItem]:
        """Search the Zotero library by title/creator."""
        url = self._url("items")
        params = {"q": query, "limit": limit, "format": "json", "include": "data"}

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            payload = resp.json()

        results: list[ZoteroItem] = []
        for entry in payload if isinstance(payload, list) else []:
            data = entry.get("data", entry) if isinstance(entry, dict) else entry
            if not isinstance(data, dict):
                continue
            results.append(_parse_item(data))
        return results


def _parse_item(data: dict[str, Any]) -> ZoteroItem:
    creators = data.get("creators") or []
    if not isinstance(creators, list):
        creators = []

    citekey = data.get("citationKey")
    if not citekey:
        citekey = data.get("callNumber")
    if not citekey:
        citekey = None

    return ZoteroItem(
        key=str(data.get("key", "")),
        title=str(data.get("title", "")),
        item_type=str(data.get("itemType", "")),
        creators=[
            {
                # Two-field creators carry firstName/lastName; single-field
                # creators (typically organizations) carry only ``name``.
                "firstName": str(c.get("firstName", "")),
                "lastName": str(c.get("lastName", "")),
                "name": str(c.get("name", "")),
                "creatorType": str(c.get("creatorType", "author")),
            }
            for c in creators
            if isinstance(c, dict)
        ],
        date=str(data.get("date")) if data.get("date") else None,
        url=str(data.get("url")) if data.get("url") else None,
        doi=str(data.get("DOI")) if data.get("DOI") else None,
        isbn=str(data.get("ISBN")) if data.get("ISBN") else None,
        publisher=(
            str(data.get("publisher"))
            if data.get("publisher")
            else (str(data.get("publication")) if data.get("publication") else None)
        ),
        abstract=str(data.get("abstractNote")) if data.get("abstractNote") else None,
        citekey=str(citekey) if citekey else None,
        tags=[str(t.get("tag")) for t in data.get("tags", []) if isinstance(t, dict)],
    )
