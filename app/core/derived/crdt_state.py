"""CRDT state helpers for the derived node table."""

from __future__ import annotations

import sqlite3


def delete_crdt_state_for_node(conn: sqlite3.Connection, node_id: str) -> None:
    """Remove CRDT state for ``node_id`` (e.g. on node deletion)."""
    conn.execute("DELETE FROM crdt_state WHERE node_id = ?", (node_id,))
