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


def remove_search_index_entry(conn: sqlite3.Connection, node_id: str) -> None:
    """Remove a node's FTS entry, addressing the row by docid.

    Filtering search_index by its notindexed node_id column is a full
    docstore scan (O(n) per statement); the map lookup + rowid delete is
    O(log n).
    """
    conn.execute(
        "DELETE FROM search_index "
        "WHERE docid = (SELECT docid FROM search_index_docid WHERE node_id = ?)",
        (node_id,),
    )
    conn.execute("DELETE FROM search_index_docid WHERE node_id = ?", (node_id,))


def reindex_node(conn: sqlite3.Connection, node_id: str) -> None:
    """Rebuild the search-index row for ``node_id``."""
    row = conn.execute("SELECT content FROM node WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        return
    content = json.loads(row[0])
    plaintext = extract_plaintext(content)
    if not plaintext:
        remove_search_index_entry(conn, node_id)
        return
    conn.execute(
        "DELETE FROM search_index "
        "WHERE docid = (SELECT docid FROM search_index_docid WHERE node_id = ?)",
        (node_id,),
    )
    conn.execute(
        "INSERT INTO search_index (node_id, content) VALUES (?, ?)",
        (node_id, plaintext),
    )
    # last_insert_rowid() is the docid of the row just inserted on this
    # connection; keep the map in sync for the next reindex/delete.
    conn.execute(
        "INSERT OR REPLACE INTO search_index_docid (node_id, docid) "
        "VALUES (?, last_insert_rowid())",
        (node_id,),
    )
