"""Class-hierarchy (transitive extends closure) applier."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable

from app.core.operation import Operation


def _compute_ancestors(
    conn: sqlite3.Connection,
    class_id: str,
    extends: Iterable[str],
) -> list[str]:
    """Return the sorted set of ancestors reachable through ``extends``.

    Walks the materialized closure rows of each parent with a visited set, so
    replaying a hypothetical historical cycle terminates instead of looping
    and never adds ``class_id`` as its own ancestor.
    """
    ancestors: set[str] = set()
    visited = {class_id}
    stack = list(extends)
    while stack:
        current = stack.pop()
        if current in visited:
            continue
        visited.add(current)
        ancestors.add(current)
        for row in conn.execute(
            "SELECT ancestor_id FROM class_hierarchy WHERE class_id = ?",
            (current,),
        ).fetchall():
            stack.append(row["ancestor_id"])
    return sorted(ancestors)


def _stored_extends(row: sqlite3.Row) -> list[str]:
    """Parse a ``class.extends_class_ids`` JSON column into a list."""
    raw = row["extends_class_ids"]
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return []
    return value if isinstance(value, list) else []


def apply_class_hierarchy(
    conn: sqlite3.Connection,
    class_id: str,
    extends: list[str] | None,
    _seen: set[str] | None = None,
) -> None:
    """Maintain the transitive class_hierarchy closure for ``class_id``.

    Replaces any existing rows for the class with ``(class_id, class_id)`` and
    one row for every ancestor reachable through the ``extends`` chain, then
    recursively rebuilds the closure of every class that extends ``class_id``
    so descendant closures track ancestor changes. Cycle-safe: a historical
    cycle in the extends graph terminates instead of recursing forever.
    """
    seen = _seen if _seen is not None else set()
    if class_id in seen:
        return
    seen.add(class_id)

    conn.execute("DELETE FROM class_hierarchy WHERE class_id = ?", (class_id,))
    conn.execute(
        "INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)",
        (class_id, class_id),
    )
    for ancestor_id in _compute_ancestors(conn, class_id, extends or []):
        conn.execute(
            "INSERT OR IGNORE INTO class_hierarchy (class_id, ancestor_id) VALUES (?, ?)",
            (class_id, ancestor_id),
        )

    for row in conn.execute(
        "SELECT id, extends_class_ids FROM class WHERE id != ?",
        (class_id,),
    ).fetchall():
        child_extends = _stored_extends(row)
        if class_id in child_extends:
            apply_class_hierarchy(conn, row["id"], child_extends, seen)


def class_extends_would_cycle(
    conn: sqlite3.Connection,
    class_id: str,
    extends_class_ids: Iterable[str],
) -> str | None:
    """Return the offending parent id if ``extends_class_ids`` would cycle.

    A cycle forms when ``class_id`` is already an ancestor of one of its new
    parents. The closure includes self-rows, so a direct self-loop is covered
    as well. Used for emit-time validation only; replay never calls this.
    """
    for parent_id in extends_class_ids:
        if parent_id == class_id:
            return parent_id
        row = conn.execute(
            "SELECT 1 FROM class_hierarchy WHERE class_id = ? AND ancestor_id = ? LIMIT 1",
            (parent_id, class_id),
        ).fetchone()
        if row is not None:
            return parent_id
    return None


def apply_class_create(conn: sqlite3.Connection, op: Operation) -> None:
    """Maintain the class hierarchy for a newly created class."""
    payload = op.payload
    class_id = payload["classId"]
    apply_class_hierarchy(conn, class_id, payload.get("extends"))


def apply_class_update(conn: sqlite3.Connection, op: Operation) -> None:
    """Recompute the class hierarchy when the ``extends`` list changes."""
    payload = op.payload
    if "extends" not in payload:
        return
    extends = payload.get("extends")
    apply_class_hierarchy(conn, payload["classId"], extends if isinstance(extends, list) else [])


def delete_class_hierarchy_for_node(conn: sqlite3.Connection, node_id: str) -> None:
    """Remove hierarchy rows that reference ``node_id`` as class or ancestor."""
    conn.execute(
        "DELETE FROM class_hierarchy WHERE class_id = ? OR ancestor_id = ?",
        (node_id, node_id),
    )
