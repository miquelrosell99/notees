"""Child-order (tree position) helpers for the derived node table."""

from __future__ import annotations

import sqlite3


def insert_child_order(
    conn: sqlite3.Connection,
    parent_id: str,
    child_id: str,
    position: str,
) -> None:
    """Insert or replace a child-order entry."""
    conn.execute(
        """
        INSERT OR REPLACE INTO node_child_order (parent_id, child_id, position)
        VALUES (?, ?, ?)
        """,
        (parent_id, child_id, position),
    )


def remove_child_order_for_child(conn: sqlite3.Connection, child_id: str) -> None:
    """Remove the child-order row for ``child_id`` wherever it appears as a child."""
    conn.execute("DELETE FROM node_child_order WHERE child_id = ?", (child_id,))


def delete_child_order_by_node(conn: sqlite3.Connection, node_id: str) -> None:
    """Remove all child-order rows where ``node_id`` is the parent or the child."""
    conn.execute(
        "DELETE FROM node_child_order WHERE parent_id = ? OR child_id = ?",
        (node_id, node_id),
    )
