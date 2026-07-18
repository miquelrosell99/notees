"""Class-hierarchy (transitive extends closure) applier."""

from __future__ import annotations

import sqlite3

from app.core.operation import Operation


def apply_class_hierarchy(
    conn: sqlite3.Connection,
    class_id: str,
    extends: list[str] | None,
) -> None:
    """Maintain the transitive class_hierarchy closure for ``class_id``.

    Replaces any existing rows for the class with ``(class_id, class_id)`` and
    one row for every ancestor reachable through the ``extends`` chain.
    """
    conn.execute("DELETE FROM class_hierarchy WHERE class_id = ?", (class_id,))
    conn.execute(
        "INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)",
        (class_id, class_id),
    )
    for ancestor_uuid in extends or []:
        conn.execute(
            "INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)",
            (class_id, ancestor_uuid),
        )
        for row in conn.execute(
            "SELECT ancestor_id FROM class_hierarchy WHERE class_id = ?",
            (ancestor_uuid,),
        ).fetchall():
            conn.execute(
                "INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)",
                (class_id, row["ancestor_id"]),
            )


def apply_class_create(conn: sqlite3.Connection, op: Operation) -> None:
    """``class.create`` is equivalent to creating a node of kind ``class``."""
    payload = op.payload
    node_id = payload["classId"]
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None
    conn.execute(
        """
        INSERT OR IGNORE INTO node (
            id, workspace_id, kind, class_ids, parent_id, content,
            created_at, updated_at, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            node_id,
            op.envelope.workspace_id,
            "class",
            "[]",
            None,
            "[]",
            ts,
            ts,
            op.envelope.actor_id,
            op.envelope.actor_id,
        ),
    )
    apply_class_hierarchy(conn, node_id, payload.get("extends"))


def apply_class_update(conn: sqlite3.Connection, op: Operation) -> None:
    """Recompute the class hierarchy when the ``extends`` list changes."""
    payload = op.payload
    node_id = payload["classId"]
    apply_class_hierarchy(conn, node_id, payload.get("extends"))


def delete_class_hierarchy_for_node(conn: sqlite3.Connection, node_id: str) -> None:
    """Remove hierarchy rows that reference ``node_id`` as class or ancestor."""
    conn.execute(
        "DELETE FROM class_hierarchy WHERE class_id = ? OR ancestor_id = ?",
        (node_id, node_id),
    )
