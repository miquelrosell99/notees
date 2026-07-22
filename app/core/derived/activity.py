"""Activity-log derived-state applier."""

from __future__ import annotations

import json
import sqlite3

from app.core.operation import Operation


def apply_activity_record(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply an ``activity.record`` operation.

    Payload fields:
        - activityId: UUIDv7 of the activity record (optional; defaults to op id).
        - nodeId: subject node UUIDv7.
        - action: action name (e.g. ``property_changed``).
        - targetNodeId: optional related node UUIDv7.
        - details: optional JSON-serialisable details dict.
    """
    payload = op.payload
    activity_id = payload.get("activityId") or op.envelope.id
    node_id = payload["nodeId"]
    action = payload["action"]
    target_node_id = payload.get("targetNodeId")
    details = payload.get("details", {})
    timestamp = op.envelope.timestamp.isoformat() if op.envelope.timestamp else ""

    conn.execute(
        """
        INSERT OR IGNORE INTO activity_log (
            id, workspace_id, actor_id, op_id, node_id, op_type, metadata, recorded_at,
            action, target_node_id, details, hlc_physical, hlc_logical, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            activity_id,
            op.envelope.workspace_id,
            op.envelope.actor_id,
            op.envelope.id,
            node_id,
            action,
            json.dumps(details),
            timestamp,
            action,
            target_node_id,
            json.dumps(details),
            op.envelope.hlc.physical,
            op.envelope.hlc.logical,
            timestamp,
        ),
    )
