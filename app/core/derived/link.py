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
        - linkUuid: optional UUID of the specific link instance.
        - clickedAt: optional ISO-8601 timestamp (defaults to envelope timestamp).

    When ``linkUuid`` is provided the metadata is updated on that specific
    ``node_link`` row. Otherwise the applier falls back to the first
    ``node_link`` row matching ``(source_id, target_id)`` for backwards
    compatibility with legacy ``link.click`` operations.
    """
    payload = op.payload
    source_node_id = payload.get("sourceNodeId") or payload.get("nodeId")
    target_node_id = payload.get("targetNodeId") or payload.get("targetId")
    link_uuid = payload.get("linkUuid")
    clicked_at = payload.get("clickedAt")
    if clicked_at is None and op.envelope.timestamp is not None:
        clicked_at = op.envelope.timestamp.isoformat()
    if clicked_at is None:
        clicked_at = ""

    if not source_node_id or not target_node_id:
        return

    if link_uuid:
        existing = conn.execute(
            "SELECT click_count FROM node_link WHERE id = ?",
            (link_uuid,),
        ).fetchone()
        if existing is not None:
            conn.execute(
                """
                UPDATE node_link
                SET click_count = click_count + 1,
                    last_navigated_at = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (clicked_at, clicked_at, link_uuid),
            )
            return

    # Fallback for legacy operations without a linkUuid: update or create a
    # node_link row keyed by (source_id, target_id).
    existing = conn.execute(
        "SELECT id, click_count FROM node_link WHERE source_id = ? AND target_id = ? ORDER BY created_at LIMIT 1",
        (source_node_id, target_node_id),
    ).fetchone()

    if existing is not None:
        conn.execute(
            """
            UPDATE node_link
            SET click_count = click_count + 1,
                last_navigated_at = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (clicked_at, clicked_at, existing["id"]),
        )
    else:
        conn.execute(
            """
            INSERT INTO node_link (
                id, workspace_id, source_id, target_id, type, label,
                click_count, last_navigated_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                link_uuid or uuidv7(),
                op.envelope.workspace_id,
                source_node_id,
                target_node_id,
                "node",
                None,
                1,
                clicked_at,
                clicked_at,
                clicked_at,
            ),
        )
