"""Link-click derived-state applier."""

from __future__ import annotations

import sqlite3

from app.core.operation import Operation
from app.core.uuid import uuidv7


def apply_link_click(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``link.click`` operation by upserting/incrementing the click count.

    Payload fields:
        - sourceNodeId: UUIDv7 of the node containing the link.
        - targetNodeId: UUIDv7 of the linked node.
        - clickedAt: optional ISO-8601 timestamp (defaults to envelope timestamp).
    """
    payload = op.payload
    source_node_id = payload["sourceNodeId"]
    target_node_id = payload["targetNodeId"]
    clicked_at = payload.get("clickedAt")
    if clicked_at is None and op.envelope.timestamp is not None:
        clicked_at = op.envelope.timestamp.isoformat()
    if clicked_at is None:
        clicked_at = ""

    existing = conn.execute(
        "SELECT id, count FROM link_click WHERE source_node_id = ? AND target_node_id = ?",
        (source_node_id, target_node_id),
    ).fetchone()

    if existing is None:
        conn.execute(
            """
            INSERT INTO link_click (id, source_node_id, target_node_id, count, last_clicked_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (uuidv7(), source_node_id, target_node_id, 1, clicked_at),
        )
    else:
        conn.execute(
            """
            UPDATE link_click
            SET count = count + 1, last_clicked_at = ?
            WHERE id = ?
            """,
            (clicked_at, existing["id"]),
        )
