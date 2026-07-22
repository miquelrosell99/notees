"""Plugin-operation derived-state applier.

Known plugin operations are projected into feature-specific derived tables;
unknown operations are preserved in a log table so future plugin hosts (or a
client-side plugin runtime) can apply them.
"""

from __future__ import annotations

import json
import sqlite3

from app.core.operation import Operation

from .flashcard import (
    PLUGIN_ID as FLASHCARDS_PLUGIN_ID,
)
from .flashcard import (
    apply_flashcard_create,
    apply_flashcard_delete,
    apply_flashcard_review,
)


def apply_plugin_op(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``plugin.op`` operation.

    Payload fields:
        - pluginId: plugin identifier.
        - opType: plugin-specific operation type.
        - nodeId: optional affected node UUIDv7.
        - data: plugin-specific JSON-serialisable payload.
    """
    payload = op.payload
    plugin_id = payload["pluginId"]
    op_type = payload["opType"]
    node_id = payload.get("nodeId")
    data = payload.get("data", {})

    if plugin_id == FLASHCARDS_PLUGIN_ID:
        if op_type == "flashcard.create":
            apply_flashcard_create(conn, op)
            return
        if op_type == "flashcard.review":
            apply_flashcard_review(conn, op)
            return
        if op_type == "flashcard.delete":
            apply_flashcard_delete(conn, op)
            return

    recorded_at = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None
    conn.execute(
        """
        INSERT OR IGNORE INTO plugin_op_log (
            id, workspace_id, op_id, plugin_id, op_type, data, actor_id, recorded_at,
            node_id, data_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            op.envelope.id,
            op.envelope.workspace_id,
            op.envelope.id,
            plugin_id,
            op_type,
            json.dumps(data),
            op.envelope.actor_id,
            recorded_at,
            node_id,
            json.dumps(data),
        ),
    )
