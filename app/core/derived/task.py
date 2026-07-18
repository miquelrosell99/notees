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
        - scheduledDate: ISO-8601 date string (optional).
        - deadlineDate: ISO-8601 date string (optional).
        - status: "done", "cancelled", or "skipped" (optional; defaults to "done").
        - completedBy: actor UUID (optional; defaults to envelope actor_id).
    """
    payload = op.payload
    completion_id = payload.get("completionId") or op.envelope.id
    node_id = payload["nodeId"]
    completed_at = payload.get("completedAt")
    if completed_at is None and op.envelope.timestamp is not None:
        completed_at = op.envelope.timestamp.isoformat()
    if completed_at is None:
        completed_at = ""

    scheduled_date = payload.get("scheduledDate")
    deadline_date = payload.get("deadlineDate")
    status = payload.get("status", "done")
    completed_by = payload.get("completedBy") or op.envelope.actor_id

    conn.execute(
        """
        INSERT OR IGNORE INTO task_completion (
            id, node_id, completed_at, actor_id, scheduled_date, deadline_date, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            completion_id,
            node_id,
            completed_at,
            completed_by,
            scheduled_date,
            deadline_date,
            status,
        ),
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
        - recurrenceId: public UUID for the rule (optional; generated if absent).
        - nodeId: task node UUIDv7.
        - rule: JSON-serialisable recurrence rule.
    """
    payload = op.payload
    recurrence_id = payload.get("recurrenceId") or op.envelope.id
    node_id = payload["nodeId"]
    rule = payload.get("rule", {})
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else ""

    conn.execute(
        """
        INSERT INTO task_recurrence (id, node_id, rule_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
            id = excluded.id,
            rule_json = excluded.rule_json,
            updated_at = excluded.updated_at
        """,
        (recurrence_id, node_id, json.dumps(rule), ts, ts),
    )


def apply_task_delete_recurrence(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``task.deleteRecurrence`` operation."""
    node_id = op.payload["nodeId"]
    conn.execute("DELETE FROM task_recurrence WHERE node_id = ?", (node_id,))
