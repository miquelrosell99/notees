"""Flashcard derived-state applier.

Flashcard scheduling is stored as ``plugin.op`` operations emitted by the
flashcards plugin. The applier below projects those operations into the
``flashcard`` derived table so the repository can query them with ordinary SQL.
"""

from __future__ import annotations

import sqlite3

from app.core.operation import Operation

PLUGIN_ID = "notees.flashcards"
OP_CREATE = "flashcard.create"
OP_REVIEW = "flashcard.review"
OP_DELETE = "flashcard.delete"


def _op_timestamp_iso(op: Operation) -> str:
    """Return the operation's envelope timestamp as ISO string.

    Derived state must be a deterministic function of the operation log —
    wall-clock stamps would make replays and rebuilds diverge.
    """
    return op.envelope.timestamp.isoformat()


def apply_flashcard_create(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``flashcard.create`` plugin operation.

    Payload fields (inside ``plugin.op``):
        - nodeId: card node UUID.
        - data.workspaceId: workspace UUID.
        - data.actorId: actor (user) UUID.
        - data.frontText: initial front text.
        - data.backText: initial back text.

    Upserts on ``node_id`` so re-assigning the ``card`` class reactivates the
    card and refreshes the stored front/back text.
    """
    payload = op.payload
    data = payload.get("data", {})
    node_id = payload.get("nodeId")
    workspace_id = data.get("workspaceId")
    actor_id = data.get("actorId")
    front_text = data.get("frontText", "")
    back_text = data.get("backText", "")
    now = _op_timestamp_iso(op)

    conn.execute(
        """
        INSERT INTO flashcard (
            uuid, node_id, workspace_id, actor_id,
            front_text, back_text, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
            front_text = excluded.front_text,
            back_text = excluded.back_text,
            active = 1,
            updated_at = excluded.updated_at
        """,
        (node_id, node_id, workspace_id, actor_id, front_text, back_text, now, now),
    )


def apply_flashcard_review(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``flashcard.review`` plugin operation.

    Payload fields:
        - nodeId: card node UUID.
        - data.easeFactor, intervalDays, repetitions, lapses.
        - data.dueDate: ISO datetime string.
        - data.lastReviewedAt: ISO datetime string.
    """
    payload = op.payload
    data = payload.get("data", {})
    node_id = payload.get("nodeId")
    now = _op_timestamp_iso(op)

    conn.execute(
        """
        UPDATE flashcard
        SET ease_factor = ?,
            interval_days = ?,
            repetitions = ?,
            lapses = ?,
            due_date = ?,
            last_reviewed_at = ?,
            updated_at = ?
        WHERE node_id = ?
        """,
        (
            data.get("easeFactor", 2.5),
            data.get("intervalDays", 0),
            data.get("repetitions", 0),
            data.get("lapses", 0),
            data.get("dueDate"),
            data.get("lastReviewedAt"),
            now,
            node_id,
        ),
    )


def apply_flashcard_delete(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``flashcard.delete`` plugin operation."""
    node_id = op.payload.get("nodeId")
    conn.execute("DELETE FROM flashcard WHERE node_id = ?", (node_id,))
