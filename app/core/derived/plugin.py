"""Plugin-operation derived-state applier.

Unknown plugin operations are preserved in a log table so future plugin hosts
(or a client-side plugin runtime) can apply them.
"""

from __future__ import annotations

import json
import sqlite3

from app.core.operation import Operation


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

    conn.execute(
        """
        INSERT OR IGNORE INTO plugin_op_log (id, plugin_id, op_type, node_id, data_json)
        VALUES (?, ?, ?, ?, ?)
        """,
        (op.envelope.id, plugin_id, op_type, node_id, json.dumps(data)),
    )
