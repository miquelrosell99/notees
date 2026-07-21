"""User favorite derived-state appliers."""

from __future__ import annotations

import sqlite3

from app.core.operation import Operation


def apply_favorite_add(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``user.favorite.add`` operation.

    Payload fields:
        - nodeId: UUIDv7 of the node to favorite.
    """
    payload = op.payload
    actor_id = op.envelope.actor_id
    workspace_id = op.envelope.workspace_id
    node_id = payload["nodeId"]

    row = conn.execute(
        """
        SELECT COALESCE(MAX(position), -1) AS pos
        FROM user_favorite
        WHERE actor_id = ? AND workspace_id = ?
        """,
        (actor_id, workspace_id),
    ).fetchone()
    next_position = (row["pos"] if row and row["pos"] is not None else -1) + 1

    conn.execute(
        """
        INSERT OR IGNORE INTO user_favorite (actor_id, node_id, workspace_id, position)
        VALUES (?, ?, ?, ?)
        """,
        (actor_id, node_id, workspace_id, next_position),
    )


def apply_favorite_remove(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``user.favorite.remove`` operation.

    Payload fields:
        - nodeId: UUIDv7 of the node to unfavorite.
    """
    payload = op.payload
    actor_id = op.envelope.actor_id
    workspace_id = op.envelope.workspace_id
    node_id = payload["nodeId"]

    conn.execute(
        """
        DELETE FROM user_favorite
        WHERE actor_id = ? AND node_id = ? AND workspace_id = ?
        """,
        (actor_id, node_id, workspace_id),
    )


def apply_favorite_reorder(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``user.favorite.reorder`` operation.

    Payload fields:
        - nodeIds: ordered list of UUIDv7 node ids representing the new order.
    """
    payload = op.payload
    actor_id = op.envelope.actor_id
    workspace_id = op.envelope.workspace_id
    node_ids = list(payload.get("nodeIds", []))

    if node_ids:
        placeholders = ", ".join("?" for _ in node_ids)
        conn.execute(
            f"""
            DELETE FROM user_favorite
            WHERE actor_id = ? AND workspace_id = ? AND node_id NOT IN ({placeholders})
            """,
            (actor_id, workspace_id, *node_ids),
        )
    else:
        conn.execute(
            """
            DELETE FROM user_favorite
            WHERE actor_id = ? AND workspace_id = ?
            """,
            (actor_id, workspace_id),
        )

    for index, node_id in enumerate(node_ids):
        conn.execute(
            """
            INSERT OR REPLACE INTO user_favorite (actor_id, node_id, workspace_id, position)
            VALUES (?, ?, ?, ?)
            """,
            (actor_id, node_id, workspace_id, index),
        )
