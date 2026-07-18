"""Task completion and recurrence derived-state applier."""

from __future__ import annotations

import json
import sqlite3

from app.core.operation import Operation


def apply_task_record_completion(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``task.recordCompletion`` operation idempotently.

    Payload fields:
        - completionId: UUIDv7 of the completion record (optional; generated if absent).
        - nodeId: task node UUIDv7.
        - completedAt: ISO-8601 timestamp (optional; defaults to envelope timestamp).
    """
    payload = op.payload
    completion_id = payload.get("completionId") or op.envelope.id
    node_id = payload["nodeId"]
    completed_at = payload.get("completedAt")
    if completed_at is None and op.envelope.timestamp is not None:
        completed_at = op.envelope.timestamp.isoformat()
    if completed_at is None:
        completed_at = ""

    conn.execute(
        """
        INSERT OR IGNORE INTO task_completion (id, node_id, completed_at, actor_id)
        VALUES (?, ?, ?, ?)
        """,
        (completion_id, node_id, completed_at, op.envelope.actor_id),
    )


def apply_task_delete_completion(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``task.deleteCompletion`` operation.

    Payload fields:
        - completionId: UUIDv7 of the completion record to delete.
    """
    completion_id = op.payload["completionId"]
    conn.execute("DELETE FROM task_completion WHERE id = ?", (completion_id,))


def apply_task_set_recurrence(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``task.setRecurrence`` operation.

    Payload fields:
        - nodeId: task node UUIDv7.
        - rule: JSON-serialisable recurrence rule.
    """
    payload = op.payload
    node_id = payload["nodeId"]
    rule = payload.get("rule", {})
    conn.execute(
        """
        INSERT INTO task_recurrence (node_id, rule_json)
        VALUES (?, ?)
        ON CONFLICT(node_id) DO UPDATE SET rule_json = excluded.rule_json
        """,
        (node_id, json.dumps(rule)),
    )


def apply_task_delete_recurrence(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``task.deleteRecurrence`` operation."""
    node_id = op.payload["nodeId"]
    conn.execute("DELETE FROM task_recurrence WHERE node_id = ?", (node_id,))
