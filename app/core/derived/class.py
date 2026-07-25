# noqa: N999  # ``class`` is a reserved keyword but matches the task-specified module path.
"""Derived-state applier that materialises class-node metadata.

The ``class`` table mirrors metadata for nodes whose ``kind`` is ``class`` so
that schema queries do not have to inspect the polymorphic ``node`` table.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from app.core.operation import Operation

from .class_hierarchy import apply_class_hierarchy


def _derive_name_from_content(content: list[dict] | list) -> str:
    """Return the trimmed text of the first text-like AST child, if any."""
    for item in content:
        if isinstance(item, dict) and "text" in item:
            text = item.get("text")
            if isinstance(text, str) and text.strip():
                return text.strip()
    return "Untitled class"


def _get_node_kind(conn: sqlite3.Connection, node_id: str) -> str | None:
    row = conn.execute("SELECT kind FROM node WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        return None
    kind: str = row["kind"]
    return kind


def _get_node_content(conn: sqlite3.Connection, node_id: str) -> list:
    row = conn.execute("SELECT content FROM node WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        return []
    try:
        content = json.loads(row["content"])
    except (TypeError, ValueError):
        return []
    if isinstance(content, list):
        return content
    if isinstance(content, dict):
        return [content]
    return []


def _timestamp_from_op(op: Operation) -> str | None:
    return op.envelope.timestamp.isoformat() if op.envelope.timestamp else None


def apply_class_operation(conn: sqlite3.Connection, op: Operation) -> None:
    """Maintain the ``class`` table from node and class operations."""
    op_type = op.envelope.op_type
    payload = op.payload
    ts = _timestamp_from_op(op)

    if op_type in {"node.create", "node.convert"}:
        if payload.get("kind") != "class":
            return

        node_id = payload["nodeId"]
        content: list = []
        initial_content = payload.get("initialContent")
        if isinstance(initial_content, list):
            content = initial_content
        elif op_type == "node.convert":
            content = _get_node_content(conn, node_id)
        name = _derive_name_from_content(content)

        conn.execute(
            """
            INSERT OR REPLACE INTO class (
                id, workspace_id, name, description, active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (node_id, op.envelope.workspace_id, name, None, 1, ts, ts),
        )

    elif op_type == "node.updateContent":
        node_id = payload["nodeId"]
        if _get_node_kind(conn, node_id) != "class":
            return

        content = _get_node_content(conn, node_id)
        name = _derive_name_from_content(content)

        conn.execute(
            "UPDATE class SET name = ?, description = ?, updated_at = ? WHERE id = ?",
            (name, None, ts, node_id),
        )

    elif op_type == "node.delete":
        node_id = payload["nodeId"]
        if _get_node_kind(conn, node_id) != "class":
            return

        conn.execute(
            "UPDATE class SET active = 0, updated_at = ? WHERE id = ?",
            (ts, node_id),
        )

    elif op_type == "class.create":
        class_id = payload["classId"]
        name = payload.get("name", "Untitled class")
        icon = payload.get("icon")
        color = payload.get("color")

        conn.execute(
            """
            INSERT OR REPLACE INTO class (
                id, workspace_id, name, icon, color, description,
                extends_class_ids, active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                class_id,
                op.envelope.workspace_id,
                name,
                icon,
                color,
                None,
                "[]",
                1,
                ts,
                ts,
            ),
        )

    elif op_type == "class.update":
        class_id = payload["classId"]
        sets: list[str] = []
        values: list[Any] = []

        if "name" in payload:
            sets.append("name = ?")
            values.append(payload["name"])
        if "icon" in payload:
            sets.append("icon = ?")
            values.append(payload["icon"])
        if "color" in payload:
            sets.append("color = ?")
            values.append(payload["color"])
        if "description" in payload:
            sets.append("description = ?")
            values.append(payload["description"])

        if not sets:
            return

        sets.append("updated_at = ?")
        values.append(ts)
        values.append(class_id)

        conn.execute(
            f"UPDATE class SET {', '.join(sets)} WHERE id = ?",
            values,
        )

    elif op_type == "class.delete":
        class_id = payload["classId"]
        conn.execute(
            "UPDATE class SET active = 0, updated_at = ? WHERE id = ?",
            (ts, class_id),
        )

    elif op_type == "class.setExtends":
        class_id = payload["classId"]
        extends = payload.get("extendsClassIds", [])
        extends_list = extends if isinstance(extends, list) else []

        conn.execute(
            "UPDATE class SET extends_class_ids = ?, updated_at = ? WHERE id = ?",
            (json.dumps(extends_list), ts, class_id),
        )
        apply_class_hierarchy(conn, class_id, extends_list)
