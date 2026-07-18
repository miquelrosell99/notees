"""Search-index helpers for the derived node table."""

from __future__ import annotations

import json
import sqlite3
from typing import Any


def extract_plaintext(content: list[dict[str, Any]]) -> str:
    """Return a plain-text rendering of a content AST for search indexing."""
    parts: list[str] = []
    for child in content:
        if (
            isinstance(child, dict)
            and child.get("type") == "text"
            and isinstance(child.get("text"), str)
        ):
            parts.append(child["text"])
    return " ".join(parts)


def reindex_node(conn: sqlite3.Connection, node_id: str) -> None:
    """Rebuild the search-index row for ``node_id``."""
    row = conn.execute("SELECT content FROM node WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        return
    content = json.loads(row[0])
    plaintext = extract_plaintext(content)
    conn.execute("DELETE FROM search_index WHERE node_id = ?", (node_id,))
    if plaintext:
        conn.execute(
            "INSERT INTO search_index (node_id, content) VALUES (?, ?)",
            (node_id, plaintext),
        )
